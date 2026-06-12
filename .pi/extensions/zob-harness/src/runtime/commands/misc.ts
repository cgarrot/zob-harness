import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { discoverAgents, formatAgentList } from "../../domains/delegation/agents.js";
import { buildDaemonRuntimeState } from "../../domains/autonomy/daemon-runtime.js";
import { handleZcompactCommand } from "../auto-compaction.js";
import { clearZpeerNewCarryoverProfile } from "../../domains/coms/coms-v2/zpeer-profile.js";
import { markZpeerNewHardResetPending } from "../events.js";
import { pauseRuntimeGoalForStop } from "../goal-runtime.js";
import { formatRuleResolution, resolveRuleProfile } from "../../domains/governance/rules.js";
import { formatContractTemplate } from "../../domains/governance/safety.js";
import { showDelegationOverlay } from "../delegation-overlay.js";
import { finishDelegationRun } from "../delegation-monitor.js";
import { showGoalTodoOverlay } from "../goal-todo-overlay.js";
import type { HarnessRuntimeState } from "../state.js";
import { renderHarnessWidget } from "../widget.js";
import type { HarnessCommandContext } from "./types.js";
import { daemonInputFromState, daemonRuntimeLedgerEntry, stopDaemonLoop } from "./daemon.js";
import { findStopRestoreUserEntryId, markStopRestoreRestored, shouldRestoreStopPrompt, type StopRestoreDecision, type StopRestoreRewindResult } from "../stop-restore.js";

function abortForegroundWork(ctx: HarnessCommandContext): boolean {
  const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
  if (idle) return false;
  if (typeof ctx.abort !== "function") return false;
  ctx.abort();
  return true;
}

function abortBackgroundDelegations(state: HarnessRuntimeState): { abortedCount: number; runIds: string[] } {
  const runIds: string[] = [];
  for (const [runId, run] of state.backgroundDelegations.entries()) {
    if (run.result || run.error || run.abortController.signal.aborted) continue;
    run.abortController.abort();
    runIds.push(runId);
    finishDelegationRun(state.delegations, runId, {
      status: "aborted",
      endedAtMs: Date.now(),
      gatePassed: false,
      failureKind: "aborted",
      stopReason: "aborted",
      stopCondition: "slash_stop",
      errorMessage: "aborted by /stop",
    });
  }
  return { abortedCount: runIds.length, runIds };
}

function stopCommandLedgerEntry(input: {
  foregroundAbortRequested: boolean;
  idleBeforeStop: boolean;
  pendingMessagesBeforeStop: boolean;
  backgroundAbortedCount: number;
  backgroundRunIds: string[];
  daemonWasRunning: boolean;
  runtimeGoalPaused: boolean;
  runtimeGoalId?: string;
  stopRestoreDecision?: StopRestoreDecision;
  stopRestoreRewind?: StopRestoreRewindResult;
}): Record<string, unknown> {
  return {
    schema: "zob.stop-command.v1",
    foregroundAbortRequested: input.foregroundAbortRequested,
    idleBeforeStop: input.idleBeforeStop,
    pendingMessagesBeforeStop: input.pendingMessagesBeforeStop,
    backgroundAbortedCount: input.backgroundAbortedCount,
    backgroundRunIds: input.backgroundRunIds,
    daemonWasRunning: input.daemonWasRunning,
    runtimeGoalPaused: input.runtimeGoalPaused,
    runtimeGoalId: input.runtimeGoalId,
    editorPromptRestored: input.stopRestoreDecision?.restore === true,
    editorPromptRestoreReason: input.stopRestoreDecision?.reason,
    editorPromptHash: input.stopRestoreDecision?.promptHash,
    assistantOutputObservedBeforeStop: input.stopRestoreDecision?.assistantOutputObserved,
    editorPromptRewindAttempted: input.stopRestoreRewind?.attempted,
    editorPromptRewindSucceeded: input.stopRestoreRewind?.succeeded,
    editorPromptRewindReason: input.stopRestoreRewind?.reason,
    editorPromptRewindTargetId: input.stopRestoreRewind?.targetEntryId,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

async function restoreStopPromptAndRewind(ctx: HarnessCommandContext, state: HarnessRuntimeState, decision: StopRestoreDecision): Promise<StopRestoreRewindResult> {
  if (!decision.restore || !decision.promptText) {
    return { attempted: false, succeeded: false, reason: decision.reason };
  }
  try {
    if (typeof ctx.waitForIdle === "function") await ctx.waitForIdle();
  } catch {
    ctx.ui.setEditorText(decision.promptText);
    markStopRestoreRestored(state.stopRestoreCandidate);
    return { attempted: true, succeeded: false, reason: "wait_for_idle_failed" };
  }
  const targetEntryId = findStopRestoreUserEntryId(state.stopRestoreCandidate, ctx.sessionManager.getEntries());
  if (!targetEntryId) {
    ctx.ui.setEditorText(decision.promptText);
    markStopRestoreRestored(state.stopRestoreCandidate);
    return { attempted: true, succeeded: false, reason: "user_entry_not_found" };
  }
  try {
    const navigation = await ctx.navigateTree(targetEntryId, { summarize: false });
    ctx.ui.setEditorText(decision.promptText);
    markStopRestoreRestored(state.stopRestoreCandidate);
    if (navigation.cancelled) return { attempted: true, succeeded: false, reason: "navigate_cancelled", targetEntryId };
    return { attempted: true, succeeded: true, reason: "rewound_to_prompt_checkpoint", targetEntryId };
  } catch {
    ctx.ui.setEditorText(decision.promptText);
    markStopRestoreRestored(state.stopRestoreCandidate);
    return { attempted: true, succeeded: false, reason: "navigate_failed", targetEntryId };
  }
}

export function registerNewCommand(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  // Exact `/new` is handled by Pi before extension input/command hooks. Soft carryover
  // is therefore written from the `session_shutdown` reason="new" hook in events.ts.
  // Keep this registration only for `/new hard`, where users need an explicit clean reset.
  pi.registerCommand("new", {
    description: "Hard reset helper for ZPeer/ZAgent continuity. Exact /new soft carryover is handled on session_shutdown reason=new.",
    getArgumentCompletions: (prefix) => {
      const query = prefix.trim().toLowerCase();
      const items: AutocompleteItem[] = [
        { value: "hard", label: "hard", description: "clear ZPeer/ZAgent carryover before starting a clean new session" },
      ];
      const filtered = query ? items.filter((item) => item.value.startsWith(query) || item.label.includes(query)) : items;
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const hard = args.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() === "hard";
      if (hard) {
        markZpeerNewHardResetPending(ctx.cwd);
        clearZpeerNewCarryoverProfile(ctx.cwd);
      }
      pi.appendEntry("zob-znew", {
        schema: "zob.znew-command.v1",
        source: "registered_command",
        action: hard ? "new_hard" : "new_soft_deferred_to_session_shutdown",
        carryoverWritten: false,
        carryoverCleared: hard,
        carryoverDeferredToShutdown: !hard,
        localOnly: true,
        networkEnabled: false,
        bodyStored: false,
        generatedAt: new Date().toISOString(),
      });
      await ctx.newSession();
    },
  });
}

export function registerStopCommand(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerCommand("stop", {
    description: "Stop current foreground work, background delegate_task runs, daemon loop, and runtime-goal auto-continuation without shutting down Pi.",
    handler: async (_args, ctx) => {
      const idleBeforeStop = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
      const pendingMessagesBeforeStop = typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false;
      const daemonWasRunning = state.daemon.loop.status === "running";
      const runtimeGoalId = state.runtimeGoal?.goalId;
      const foregroundAbortRequested = abortForegroundWork(ctx);
      const stopRestoreDecision = shouldRestoreStopPrompt(state.stopRestoreCandidate, {
        foregroundAbortRequested,
        idleBeforeStop,
        pendingMessagesBeforeStop,
      });
      const background = abortBackgroundDelegations(state);
      stopDaemonLoop(state, "slash_stop");
      const pausedGoal = pauseRuntimeGoalForStop(pi, state, "stopped by /stop; use /goal resume to continue");
      const daemonState = buildDaemonRuntimeState(daemonInputFromState(state));
      state.daemon.lastStatus = daemonState;
      const stopRestoreRewind = await restoreStopPromptAndRewind(ctx, state, stopRestoreDecision);
      pi.appendEntry("zob-daemon-runtime", daemonRuntimeLedgerEntry(daemonState));
      pi.appendEntry("zob-stop", stopCommandLedgerEntry({
        foregroundAbortRequested,
        idleBeforeStop,
        pendingMessagesBeforeStop,
        backgroundAbortedCount: background.abortedCount,
        backgroundRunIds: background.runIds,
        daemonWasRunning,
        runtimeGoalPaused: Boolean(pausedGoal && pausedGoal.goalId === runtimeGoalId && pausedGoal.status === "paused"),
        runtimeGoalId,
        stopRestoreDecision,
        stopRestoreRewind,
      }));
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify(`ZOB stop: foreground=${foregroundAbortRequested ? "aborted" : "idle"} input=${stopRestoreDecision.restore ? "restored" : "unchanged"} rewind=${stopRestoreRewind.succeeded ? "yes" : "no"} background_aborted=${background.abortedCount} daemon=${daemonWasRunning ? "stopped" : "already_stopped"} goal=${pausedGoal?.status ?? "none"}`, "warning");
    },
  });
}

export function registerStatusCommands(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerCommand("zstatus", {
    description: "Refresh the ZOB harness widget from latest reports and sentinels. Use 'delegations' to open child-agent run details.",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const requested = (parts[0] ?? "").toLowerCase();
      if (["delegations", "delegation", "delegate", "agents"].includes(requested)) {
        await showDelegationOverlay(ctx, state, parts[1]);
        return;
      }
      if (["todos", "todo", "goal-todos", "goal_todos"].includes(requested)) {
        await showGoalTodoOverlay(ctx, state, parts[1]);
        return;
      }
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify("ZOB status refreshed from reports/", "info");
    },
  });

  pi.registerCommand("zcompact", {
    description: "Configure/session-run proactive ZOB compaction: /zcompact observe|on|off|status|threshold 60|target 25|fraction 25|trigger",
    getArgumentCompletions: (prefix) => {
      const query = prefix.trim().toLowerCase();
      const items = [
        { value: "status", label: "status", description: "show context usage and zcompact settings" },
        { value: "observe", label: "observe", description: "report threshold hits without compacting" },
        { value: "on", label: "on", description: "enable auto-compaction at threshold" },
        { value: "off", label: "off", description: "disable proactive compaction" },
        { value: "threshold 60", label: "threshold 60", description: "trigger at 60% context" },
        { value: "target 25", label: "target 25", description: "compact enough to return near 25% context" },
        { value: "fraction 25", label: "fraction 25", description: "minimum oldest batch if target needs less" },
        { value: "trigger", label: "trigger", description: "compact now using current strategy" },
        { value: "help", label: "help", description: "insert command help" },
      ];
      const filtered = query
        ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
        : items;
      return filtered.length > 0 ? filtered.slice(0, 20) : null;
    },
    handler: async (args, ctx) => {
      await handleZcompactCommand(pi, state, args, ctx, () => renderHarnessWidget(pi, state, ctx));
    },
  });
}

export function registerRulesStatusCommand(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerCommand("rules_status", {
    description: "Resolve active ZOB rule profile for optional paths and current mode",
    handler: async (args, ctx) => {
      const paths = args.trim().length > 0 ? args.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean) : undefined;
      const resolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode, paths });
      state.activeRuleResolution = resolution;
      pi.appendEntry("zob-rules-resolution", {
        profile: resolution.profile,
        rulePacks: resolution.rulePacks,
        allowedTools: resolution.allowedTools,
        requiredValidation: resolution.requiredValidation,
        oracleRequired: resolution.oracleRequired,
        noShipConditions: resolution.noShipConditions,
        enforcement: resolution.enforcement,
        errors: resolution.errors,
        promptBodiesStored: false,
        outputBodiesStored: false,
        timestamp: new Date().toISOString(),
      });
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify(formatRuleResolution(resolution), resolution.errors.length > 0 ? "warning" : "info");
    },
  });
}

export function registerContractCommand(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerCommand("contract", {
    description: "Insert the six-part delegation contract template",
    handler: async (args, ctx) => {
      ctx.ui.setEditorText(formatContractTemplate(args.trim() || "[atomic goal]"));
    },
  });
}

export function registerAgentsCommand(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerCommand("agents", {
    description: "List ZOB project/user specialist agents",
    handler: async (_args, ctx) => {
      const agents = discoverAgents(ctx.cwd, "both");
      ctx.ui.notify(formatAgentList(agents), "info");
    },
  });
}
