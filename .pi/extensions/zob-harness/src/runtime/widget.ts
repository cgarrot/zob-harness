import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { MODE_TOOLS } from "../constants.js";
import { buildDaemonRuntimeState, buildDaemonTickPlan } from "../daemon-runtime.js";
import { goalTodoCompletionDiagnostics, summarizeGoalTodos } from "../goal-todos.js";
import { isRecord } from "../utils/records.js";
import type { AssistantLikeMessage, ModeName } from "../types.js";
import { readHarnessReadinessWidgetData } from "../orchestration/widget-readers.js";
import { delegationCost, delegationDurationMs, formatDelegationCost, formatDuration, summarizeDelegations } from "./delegation-monitor.js";
import { disposeDelegationMouseSupport } from "./delegation-mouse.js";
import type { HarnessRuntimeState } from "./state.js";

const PRODUCT_HUD_IGNORED_READINESS_BLOCKERS = new Set(["global_autonomy_not_proven_for_arbitrary_factories"]);

function isProductHudReadinessBlocker(blocker: string): boolean {
  return !PRODUCT_HUD_IGNORED_READINESS_BLOCKERS.has(blocker.trim());
}

function formatHudTokenCount(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  if (safe < 1_000) return String(safe);
  if (safe < 1_000_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}k`;
  return `${(safe / 1_000_000).toFixed(1)}m`;
}

function formatAgentSeconds(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
  return formatDuration(Math.max(0, Math.trunc(seconds)) * 1000);
}

function goalEndTimeMs(runtimeGoal: { status?: string; updatedAt?: unknown } | undefined, nowMs: number): number {
  if (!runtimeGoal || runtimeGoal.status === "active") return nowMs;
  const updatedAt = runtimeGoal.updatedAt;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return nowMs;
  return updatedAt * 1000;
}

function formatGoalElapsed(goalCreatedAt: number | undefined, endMs: number): string {
  if (typeof goalCreatedAt !== "number" || !Number.isFinite(goalCreatedAt)) return "—";
  const startedAtMs = goalCreatedAt * 1000;
  return formatDuration(Math.max(0, endMs - startedAtMs));
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assistantCostFromMessage(message: AssistantLikeMessage): number | undefined {
  if (message.role !== "assistant" || !isRecord(message.usage)) return undefined;
  if (!isRecord(message.usage.cost)) return undefined;
  return numberFrom(message.usage.cost.total);
}

function collectAssistantMessagesFromEntry(entry: unknown): AssistantLikeMessage[] {
  const result: AssistantLikeMessage[] = [];
  if (!isRecord(entry)) return result;

  const addRecordMessage = (value: unknown): void => {
    if (isRecord(value) && value.role === "assistant") result.push(value as AssistantLikeMessage);
  };

  const addMessages = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) addRecordMessage(item);
  };

  addRecordMessage(entry);
  addRecordMessage(entry.message);
  addMessages(entry.messages);
  const data = entry.data;
  if (isRecord(data)) {
    addRecordMessage(data);
    addRecordMessage(data.message);
    addMessages(data.messages);
  }
  return result;
}

function readConversationCostFromBranch(ctx: ExtensionContext): number | undefined {
  if (!ctx.sessionManager || typeof ctx.sessionManager.getBranch !== "function") return undefined;
  let total = 0;
  let foundNumeric = false;
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      for (const message of collectAssistantMessagesFromEntry(entry)) {
        const messageCost = assistantCostFromMessage(message);
        if (messageCost === undefined) continue;
        total += Math.max(0, messageCost);
        foundNumeric = true;
      }
    }
  } catch {
    return undefined;
  }
  return foundNumeric ? total : undefined;
}

export function renderHarnessWidget(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: ExtensionContext): void {
  void pi;
  const scopeGateText = state.activeGoal ? state.activeGoal.activeGoal : "unset";
  const runtimeGoal = state.runtimeGoal;
  const runtimeObjectiveText = runtimeGoal ? runtimeGoal.objective : "unset";
  const runtimeTodoSummary = runtimeGoal ? summarizeGoalTodos(state.goalTodos, runtimeGoal.goalId) : undefined;
  const todoDiagnostics = runtimeGoal ? goalTodoCompletionDiagnostics(state.goalTodos, runtimeGoal.goalId) : undefined;
  const readiness = readHarnessReadinessWidgetData(ctx.cwd);
  const daemonStatus = buildDaemonRuntimeState({
    policy: state.daemon.policy,
    runtimeGoal: state.runtimeGoal,
    goalTodos: state.goalTodos,
    autonomy: {
      mode: state.autonomy.mode,
      enabled: state.autonomy.enabled,
      lastReadiness: state.autonomy.lastReadiness,
      lastLaunchAuthorization: state.autonomy.lastLaunchAuthorization,
    },
    loop: state.daemon.loop,
  });
  const daemonPlan = state.daemon.lastPlan ?? buildDaemonTickPlan(daemonStatus);
  if (typeof ctx.ui.setStatus === "function") ctx.ui.setStatus("zob-goal", undefined);

  ctx.ui.setWidget("zob-harness", (_tui, theme) => {
    const mouseOwner = Symbol("zob-harness-widget");

    const fit = (text: string, innerWidth: number): string => {
      const clipped = truncateToWidth(text, Math.max(1, innerWidth), "…");
      return clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    };

    const border = (kind: "top" | "bottom", width: number, label?: string): string => {
      if (width < 8) return truncateToWidth(label ?? "", width, "");
      if (kind === "bottom") return theme.fg("dim", `╰${"─".repeat(width - 2)}╯`);
      const title = label ? ` ${label} ` : "";
      const fillWidth = Math.max(0, width - visibleWidth("╭─") - visibleWidth(title) - visibleWidth("╮"));
      return theme.fg("dim", "╭─") + title + theme.fg("dim", `${"─".repeat(fillWidth)}╮`);
    };

    const row = (width: number, content: string): string => {
      if (width < 8) return truncateToWidth(content, width, "");
      const innerWidth = Math.max(1, width - 4);
      return theme.fg("dim", "│ ") + fit(content, innerWidth) + theme.fg("dim", " │");
    };

    const twoColumnRow = (leftWidth: number, rightWidth: number, left: string, right: string): string => {
      return `${theme.fg("dim", "│ ")}${fit(left, leftWidth)}${theme.fg("dim", " │ ")}${fit(right, rightWidth)}${theme.fg("dim", " │")}`;
    };

    const meter = (done: number, total: number, size: number): string => {
      const safeTotal = Math.max(1, total);
      const ratio = Math.min(1, Math.max(0, done / safeTotal));
      const filled = Math.min(size, Math.max(0, Math.round(ratio * size)));
      const color: "success" | "muted" = ratio >= 1 ? "success" : "muted";
      return `${theme.fg(color, "█".repeat(filled))}${theme.fg("dim", "░".repeat(Math.max(0, size - filled)))}`;
    };

    const humanTodo = (title: string | undefined, fallback: string): string => truncateToWidth(title?.trim() || fallback, 96, "…");

    return {
      dispose() { disposeDelegationMouseSupport(state, { owner: mouseOwner }); },
      invalidate() {},
      render(width: number): string[] {
        disposeDelegationMouseSupport(state, { owner: mouseOwner });
        const panelWidth = Math.max(1, width);
        const delegationSummary = summarizeDelegations(state.delegations);
        const nowMs = Date.now();
        const agentTokens = runtimeGoal?.usage.tokensUsed;
        const subTokenRuns = state.delegations.runs.filter((run) => run.usage);
        const subTokens = subTokenRuns.reduce((sum, run) => sum + Math.max(0, Math.trunc((run.usage?.input ?? 0) + (run.usage?.output ?? 0))), 0);
        const totalKnownTokens = (agentTokens ?? 0) + subTokens;
        const hasKnownTokens = runtimeGoal !== undefined || subTokenRuns.length > 0;
        const knownCostRuns = state.delegations.runs.filter((run) => run.usage);
        const knownSubCost = knownCostRuns.reduce((sum, run) => sum + delegationCost(run), 0);
        const conversationCost = readConversationCostFromBranch(ctx);
        const hasConversationCost = typeof conversationCost === "number";
        const totalKnownCost = hasConversationCost ? knownSubCost + conversationCost : undefined;
        const subDurationMs = state.delegations.runs.reduce((sum, run) => sum + delegationDurationMs(run, nowMs), 0);
        const statusCost = hasConversationCost
          ? `cost total ${formatDelegationCost(totalKnownCost)} · convo ${formatDelegationCost(conversationCost)} · sub ${formatDelegationCost(knownSubCost)}`
          : `cost total n/a · convo n/a · sub ${formatDelegationCost(knownSubCost)}`;
        const statusTokens = hasKnownTokens ? formatHudTokenCount(totalKnownTokens) : "—";
        const elapsedTime = runtimeGoal
          ? formatGoalElapsed(runtimeGoal.createdAt, goalEndTimeMs(runtimeGoal, nowMs))
          : "—";
        const statusTime = runtimeGoal || state.delegations.runs.length > 0
          ? `elapsed ${elapsedTime} · agent ${formatAgentSeconds(runtimeGoal?.usage.activeSeconds)} · sub ${state.delegations.runs.length > 0 ? formatDuration(subDurationMs) : "—"} cum`
          : "—";
        ctx.ui.setStatus("zob-usage", theme.fg("muted", `usage ${statusCost} · tok total ${statusTokens} · time ${statusTime}`));
        const closedTodos = runtimeTodoSummary ? runtimeTodoSummary.done + runtimeTodoSummary.skipped : 0;
        const totalTodos = runtimeTodoSummary?.total ?? 0;
        const progress = totalTodos > 0
          ? `${closedTodos}/${totalTodos} ${meter(closedTodos, totalTodos, 10)}`
          : runtimeGoal
            ? "not broken down yet"
            : "no active mission";
        const mission = runtimeGoal
          ? humanTodo(runtimeObjectiveText, "Mission in progress")
          : scopeGateText !== "unset"
            ? humanTodo(scopeGateText, "Mission scoped")
            : "Choose a mission with /goal";

        const productReadinessBlocker = readiness.blockers.find(isProductHudReadinessBlocker);
        const missionNoShip = Boolean(productReadinessBlocker) || runtimeGoal?.oracle.noShip === true || todoDiagnostics?.effectiveNoShip === true;
        const alerts: string[] = [];
        if (runtimeGoal?.status === "blocked" || runtimeTodoSummary?.blocked) alerts.push("Blocked");
        if (runtimeTodoSummary?.needsUser) alerts.push("Waiting for user");
        if (missionNoShip) alerts.push("Delivery blocked");
        if (runtimeTodoSummary?.claimReturned) alerts.push("Result to review");
        if (runtimeTodoSummary?.needsOracle || runtimeGoal?.status === "ready_for_oracle" || runtimeGoal?.oracle.status === "needed") alerts.push("Review required");
        const uniqueAlerts = [...new Set(alerts)];

        const assistantsWorking = delegationSummary.running > 0 || delegationSummary.queued > 0 || (runtimeTodoSummary?.delegated ?? 0) > 0;
        const mainState = uniqueAlerts[0]
          ?? (assistantsWorking ? "Assistants working" : runtimeGoal ? "In progress" : "Ready");
        const need = uniqueAlerts.length > 0 ? uniqueAlerts.join(" · ") : mainState;
        const blockerText = runtimeGoal?.oracle.blockerSummary ?? productReadinessBlocker;
        const needLine = blockerText && uniqueAlerts.length > 0
          ? `${need} — ${truncateToWidth(blockerText, 96, "…")}`
          : need;

        const nextTitle = runtimeTodoSummary?.nextUser?.title ?? runtimeTodoSummary?.nextAgent?.title;
        const daemonBlocker = daemonStatus.reasonCodes.find((code) => code.includes("blocked") || code.includes("missing") || code.includes("needs"));
        const loop = daemonStatus.loop;
        const loopText = loop ? ` loop=${loop.status} ${loop.tickCount}${loop.maxTicks ? `/${loop.maxTicks}` : ""}` : "";
        const daemonLine = `mode=${daemonStatus.policy.enabled ? "plan-only" : "off"} status=${daemonStatus.status}${loopText} last=${daemonPlan.action}${daemonBlocker ? ` blocker=${daemonBlocker}` : ""}`;
        const nextAction = runtimeTodoSummary?.blocked
          ? "Clear the blocker before continuing"
          : runtimeTodoSummary?.needsUser
            ? humanTodo(runtimeTodoSummary.nextUser?.title, "Wait for user input")
            : runtimeTodoSummary?.claimReturned
              ? "Review the returned result"
              : runtimeTodoSummary?.needsOracle
                ? "Request or wait for review"
                : nextTitle
                  ? humanTodo(nextTitle, "Continue the next step")
                  : runtimeGoal
                    ? "Continue the mission or propose delivery"
                    : "Set the mission";

        const reviewState = runtimeTodoSummary?.claimReturned
          ? "Result to review"
          : runtimeTodoSummary?.needsOracle || runtimeGoal?.status === "ready_for_oracle" || runtimeGoal?.oracle.status === "needed"
            ? "Review required"
            : "clear";
        const qualityState = missionNoShip
          ? "delivery blocked"
          : runtimeGoal?.status === "blocked" || runtimeTodoSummary?.blocked
            ? "blocked"
            : totalTodos > 0 || runtimeGoal
              ? "check OK"
              : "check needed";
        const activityState = assistantsWorking
          ? "assistants"
          : runtimeGoal
            ? "working"
            : "idle";
        const assistantsCount = delegationSummary.running + delegationSummary.queued + (runtimeTodoSummary?.delegated ?? 0);
        const assistantsState = assistantsCount > 0
          ? `${assistantsCount} active`
          : "none";

        const leftLines = [
          `${theme.fg("accent", "Mission")} ${theme.fg(runtimeGoal ? "muted" : "dim", mission)}`,
          `${theme.fg("accent", "Progress")} ${theme.fg(totalTodos > 0 ? "muted" : "dim", progress)}`,
          `${theme.fg("accent", "Next")} ${theme.fg(mainState === "Ready" ? "dim" : "muted", nextAction)}`,
          `${theme.fg(uniqueAlerts.length > 0 ? "warning" : "success", "Need")} ${theme.fg(uniqueAlerts.length > 0 ? "warning" : "muted", needLine)}`,
          `${theme.fg("dim", "Daemon")} ${theme.fg("muted", daemonLine)}`,
          `${theme.fg("dim", "Open")} ${theme.fg("muted", "/zstatus · /todos overlay · /delegates")}`,
        ];
        const rightLines = [
          `${theme.fg("accent", "Focus")} ${theme.fg("muted", state.activeMode)}`,
          `${theme.fg("accent", "Activity")} ${theme.fg(assistantsWorking ? "muted" : "dim", activityState)}`,
          `${theme.fg(reviewState === "clear" ? "success" : "warning", "Review")} ${theme.fg(reviewState === "clear" ? "muted" : "warning", reviewState)}`,
          `${theme.fg(qualityState === "check OK" ? "success" : "warning", "Quality")} ${theme.fg(qualityState === "check OK" ? "muted" : "warning", qualityState)}`,
          `${theme.fg("accent", "Assistants")} ${theme.fg(assistantsCount > 0 ? "muted" : "dim", assistantsState)}`,
        ];
        const wideRows = Math.max(leftLines.length, rightLines.length);

        if (panelWidth < 72) return leftLines.slice(0, 4).map((line) => truncateToWidth(line, panelWidth, "…"));
        if (panelWidth < 112) {
          const contextLine = `${theme.fg("dim", "Context")} ${theme.fg("muted", `Focus ${state.activeMode} · Activity ${activityState} · Review ${reviewState} · Quality ${qualityState}`)}`;
          return [
            border("top", panelWidth, `${theme.fg("accent", "◆ ZOB")} ${theme.fg("muted", "live")}`),
            ...leftLines.map((line) => row(panelWidth, line)),
            row(panelWidth, contextLine),
            border("bottom", panelWidth),
          ];
        }

        const gutter = 3;
        const innerWidth = Math.max(1, panelWidth - 4);
        const rightWidth = Math.min(38, Math.max(28, Math.floor(innerWidth * 0.34)));
        const leftWidth = Math.max(24, innerWidth - rightWidth - gutter);
        return [
          border("top", panelWidth, `${theme.fg("accent", "◆ ZOB")} ${theme.fg("muted", "live")}`),
          ...Array.from({ length: wideRows }, (_, index) => twoColumnRow(leftWidth, rightWidth, leftLines[index] ?? "", rightLines[index] ?? "")),
          border("bottom", panelWidth),
        ];
      },
    };
  });
}

export function applyMode(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: ExtensionContext, mode: ModeName, persist = true): void {
  state.activeMode = mode;
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  pi.setActiveTools(MODE_TOOLS[mode].filter((tool) => available.has(tool)));
  if (persist) pi.appendEntry("zob-mode-state", { mode, timestamp: new Date().toISOString() });
  ctx.ui.setStatus("zob-mode", ctx.ui.theme.fg("accent", `zob:${mode}`));
  renderHarnessWidget(pi, state, ctx);
  ctx.ui.notify(`ZOB mode: ${mode}`, "info");
}
