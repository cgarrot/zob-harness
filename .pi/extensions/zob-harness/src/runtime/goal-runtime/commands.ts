import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseGoalState, validateGoalState } from "../../domains/goal/goal.js";
import { handleGoalTodoTextCommand } from "../../domains/goal/goal-todos.js";
import type { HarnessRuntimeState } from "../state.js";
import { sha256 } from "../../core/utils/hashing.js";
import type { RuntimeGoal, RuntimeGoalOracleVerdict } from "./state.js";
import { appendRuntimeGoalEntry, asGoalActivationMode, clearEntry, clearRuntimeGoalContinuationState, clearRuntimeGoalContinuationStateFor, createRuntimeGoal, formatGoalActivationMode, formatRuntimeGoalSummary, maybeStructuredGate, persistGoalActivationMode, queueRuntimeGoalContinuation, resumeRuntimeGoal, setEntry, unixSeconds } from "./state.js";
import { handoffGoalTodos, parseGoalTodoHandoffTextCommand } from "./tools.js";

export function handleGoalGateCommand(pi: ExtensionAPI, state: HarnessRuntimeState, text: string, ctx: ExtensionCommandContext, render: () => void): void {
  if (text === "--strict") {
    state.goalRequired = true;
    if (state.runtimeGoal) state.runtimeGoal.gateRequired = true;
    render();
    ctx.ui.notify("ZOB strict goal gate enabled", "info");
    return;
  }
  if (text === "--no-strict") {
    state.goalRequired = false;
    if (state.runtimeGoal) state.runtimeGoal.gateRequired = false;
    render();
    ctx.ui.notify("ZOB strict goal gate disabled", "info");
    return;
  }
  if (!text) {
    ctx.ui.setEditorText([
      "ORIGINAL_USER_ASK: [paste the user's exact ask]",
      "ACTIVE_GOAL: [one bounded goal for this session]",
      "EXPECTED_OUTPUT: [observable artifact/verdict/change]",
      "CONSTRAINTS: [must-do and must-not-do constraints]",
      "VALIDATION_EVIDENCE: [commands, files, sentinels, or oracle verdict required]",
    ].join("\n"));
    return;
  }
  const gate = parseGoalState(text);
  const errors = validateGoalState(gate);
  if (errors.length > 0) {
    ctx.ui.notify(`ZOB goal gate rejected:\n- ${errors.join("\n- ")}`, "warning");
    return;
  }
  state.activeGoal = gate;
  if (state.runtimeGoal) {
    state.runtimeGoal.gate = gate;
    state.runtimeGoal.gateValid = true;
    state.runtimeGoal.gateRequired = state.goalRequired;
    state.runtimeGoal.updatedAt = unixSeconds();
    appendRuntimeGoalEntry(pi, state, setEntry(state.runtimeGoal, "command"));
  }
  pi.appendEntry("zob-goal", gate);
  render();
  ctx.ui.notify(`ZOB goal gate set: ${gate.activeGoal.slice(0, 100)}`, "info");
}

export async function handleGoalCommand(pi: ExtensionAPI, state: HarnessRuntimeState, args: string, ctx: ExtensionCommandContext, render: () => void): Promise<void> {
  const text = args.trim();
  if (!text || text === "status") {
    ctx.ui.notify(formatRuntimeGoalSummary(state.runtimeGoal, state.goalActivationMode), state.runtimeGoal?.status === "blocked" || state.runtimeGoal?.status === "oracle_failed" ? "warning" : "info");
    return;
  }
  if (text === "mode") {
    ctx.ui.notify(`ZOB goal activation mode: ${formatGoalActivationMode(state.goalActivationMode)}`, "info");
    return;
  }
  if (text.startsWith("mode ")) {
    const requested = asGoalActivationMode(text.slice(5).trim());
    if (!requested) {
      ctx.ui.notify("Usage: /goal mode manual|validation|auto", "warning");
      return;
    }
    persistGoalActivationMode(pi, state, requested, "command");
    render();
    ctx.ui.notify(`ZOB goal activation mode set: ${formatGoalActivationMode(requested)}`, "info");
    return;
  }
  if (text === "gate" || text.startsWith("gate ")) {
    handleGoalGateCommand(pi, state, text === "gate" ? "" : text.slice(5).trim(), ctx, render);
    return;
  }
  if (text === "todo overlay" || text.startsWith("todo overlay ") || text === "todo view" || text.startsWith("todo view ")) {
    const parts = text.split(/\s+/);
    const initialTodoId = parts[2];
    const { showGoalTodoOverlay } = await import("../goal-todo-overlay.js");
    await showGoalTodoOverlay(ctx, state, initialTodoId);
    render();
    return;
  }
  if (text === "todo handoff" || text.startsWith("todo handoff ")) {
    const parsed = parseGoalTodoHandoffTextCommand(text === "todo handoff" ? "" : text.slice("todo handoff ".length));
    if (!parsed.input) {
      ctx.ui.notify(parsed.error ?? "Invalid TODO handoff command.", "warning");
      return;
    }
    try {
      const result = await handoffGoalTodos(pi, state, ctx.cwd, parsed.input, "command");
      render();
      ctx.ui.notify(`handoff delivered ${result.nodes.length} TODO(s) to ${result.targetType}; run=${result.runId}; instructionHash=${result.instructionHash.slice(0, 12)}; liveDeliveryAttempted=${result.delivery.liveDeliveryAttempted}; deliverySucceeded=${result.delivery.deliverySucceeded}`, "info");
    } catch (error) {
      ctx.ui.notify(`TODO handoff blocked: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    return;
  }
  if (text === "todo" || text.startsWith("todo ")) {
    const result = handleGoalTodoTextCommand(pi, state, state.runtimeGoal?.goalId, text === "todo" ? "" : text.slice(5).trim(), ctx.cwd);
    render();
    ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    return;
  }
  if (text === "pause") {
    if (!state.runtimeGoal || state.runtimeGoal.status !== "active") {
      ctx.ui.notify("Only an active runtime goal can be paused.", "warning");
      return;
    }
    state.runtimeGoal.status = "paused";
    state.runtimeGoal.loop.enabled = false;
    state.runtimeGoal.updatedAt = unixSeconds();
    appendRuntimeGoalEntry(pi, state, setEntry(state.runtimeGoal, "command"));
    render();
    ctx.ui.notify("ZOB runtime goal paused", "info");
    return;
  }
  if (text === "resume" || text.startsWith("resume ")) {
    if (!state.runtimeGoal || !["paused", "blocked", "oracle_failed"].includes(state.runtimeGoal.status)) {
      ctx.ui.notify("Only paused, blocked, or oracle_failed goals can be resumed.", "warning");
      return;
    }
    const extraTurnsRaw = text === "resume" ? undefined : Number.parseInt(text.slice("resume ".length).trim(), 10);
    const extraTurns = Number.isFinite(extraTurnsRaw) ? extraTurnsRaw : undefined;
    const resumed = resumeRuntimeGoal(state.runtimeGoal, extraTurns);
    clearRuntimeGoalContinuationStateFor(state, state.runtimeGoal.goalId);
    appendRuntimeGoalEntry(pi, state, setEntry(state.runtimeGoal, "command"));
    render();
    const extensionNote = resumed.additionalTurns ? ` · turn window extended +${resumed.additionalTurns} to ${state.runtimeGoal.loop.maxTurns}` : "";
    const blockerNote = resumed.previousBlocker ? ` (cleared blocker: ${resumed.previousBlocker})` : "";
    ctx.ui.notify(`ZOB runtime goal resumed${extensionNote}${blockerNote}`, "info");
    queueRuntimeGoalContinuation(pi, state, ctx, { userVisible: true });
    return;
  }
  if (text === "clear") {
    const clearedGoalId = state.runtimeGoal?.goalId ?? null;
    appendRuntimeGoalEntry(pi, state, clearEntry(clearedGoalId, "command"));
    clearRuntimeGoalContinuationState(state);
    render();
    ctx.ui.notify("ZOB runtime goal cleared", "info");
    return;
  }
  if (text.startsWith("oracle ")) {
    const [verdictRaw, ...rest] = text.slice("oracle ".length).trim().split(/\s+/);
    const verdict = verdictRaw?.toUpperCase();
    if (!state.runtimeGoal || (verdict !== "PASS" && verdict !== "WARN" && verdict !== "FAIL")) {
      ctx.ui.notify("Usage: /goal oracle PASS|WARN|FAIL <evidence summary>", "warning");
      return;
    }
    recordOracleVerdict(pi, state, verdict, verdict !== "PASS", rest.join(" ") || "manual oracle command");
    render();
    ctx.ui.notify(`ZOB goal oracle recorded: ${verdict}`, verdict === "PASS" ? "info" : "warning");
    return;
  }

  if (state.runtimeGoal && state.runtimeGoal.status !== "complete" && ctx.hasUI) {
    const replace = await ctx.ui.confirm("Replace ZOB runtime goal?", `Current goal:\n${state.runtimeGoal.objective}\n\nNew goal:\n${text}`);
    if (!replace) {
      ctx.ui.notify("ZOB runtime goal unchanged", "info");
      return;
    }
  }
  const gate = maybeStructuredGate(text);
  if (gate) state.activeGoal = gate;
  const goal = createRuntimeGoal(gate?.activeGoal ?? text, { gate, gateRequired: state.goalRequired });
  appendRuntimeGoalEntry(pi, state, setEntry(goal, "command"));
  if (gate) pi.appendEntry("zob-goal", gate);
  render();
  ctx.ui.notify(`ZOB runtime goal started: ${goal.objective.slice(0, 100)}`, "info");
  queueRuntimeGoalContinuation(pi, state, ctx);
}

export function recordOracleVerdict(pi: ExtensionAPI, state: HarnessRuntimeState, verdict: RuntimeGoalOracleVerdict, noShip: boolean, evidenceSummary: string, evidenceRefs: string[] = []): RuntimeGoal | undefined {
  const goal = state.runtimeGoal;
  if (!goal) return undefined;
  goal.oracle = {
    required: true,
    status: verdict === "PASS" && noShip === false ? "passed" : "failed",
    verdict,
    noShip,
    evidenceRefs,
    reviewHash: sha256(evidenceSummary),
    reviewedAt: new Date().toISOString(),
    blockerSummary: verdict === "PASS" && noShip === false ? undefined : evidenceSummary,
  };
  goal.status = verdict === "PASS" && noShip === false ? "ready_for_oracle" : "oracle_failed";
  goal.loop.enabled = false;
  goal.updatedAt = unixSeconds();
  appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
  return goal;
}
