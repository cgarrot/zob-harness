import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restoreGoalTodosFromBranch } from "../../domains/goal/goal-todos.js";
import type { HarnessRuntimeState } from "../state.js";
import { isRecord } from "../../core/utils/records.js";
import { isGoalMutationToolName } from "./mutation-tools.js";
import { accountElapsed, accountRuntimeGoalTurn, canContinue, clearRuntimeGoalContinuationState, clearRuntimeGoalContinuationStateFor, continuationGoalIdFromPrompt, goalRuntimeMessageText, persistRuntimeGoal, queueRuntimeGoalContinuation, restoreRuntimeGoalFromBranch } from "./state.js";

const ROOT_LINEAGE_OWNING_TOOLS = new Set(["record_goal_oracle", "update_goal"]);

function isGuardedGoalMutationEvent(event: unknown): boolean {
  if (!isRecord(event) || typeof event.toolName !== "string" || !isGoalMutationToolName(event.toolName)) return false;
  const eventInput = isRecord(event.args) ? event.args : isRecord(event.input) ? event.input : undefined;
  if (eventInput && isRecord(eventInput.cas) && Object.keys(eventInput.cas).length > 0) return true;
  const result = isRecord(event.result) ? event.result : undefined;
  return Boolean(result && isRecord(result.details) && isRecord(result.details.cas));
}

export function registerGoalRuntimeEvents(pi: ExtensionAPI, state: HarnessRuntimeState, render: (ctx: ExtensionContext) => void): void {
  pi.on("input", async (event, ctx) => {
    const goalId = continuationGoalIdFromPrompt(event.text);
    if (!goalId) {
      if (event.source !== "extension") clearRuntimeGoalContinuationState(state);
      return undefined;
    }
    clearRuntimeGoalContinuationStateFor(state, goalId);
    state.runtimeGoalContinuationTurnFor = goalId;
    if (state.runtimeGoal?.goalId === goalId && canContinue(state.runtimeGoal)) return { action: "continue" as const };
    render(ctx);
    return { action: "handled" as const };
  });

  pi.on("message_start", async (event) => {
    const text = goalRuntimeMessageText(event.message);
    const goalId = continuationGoalIdFromPrompt(text);
    if (goalId) {
      clearRuntimeGoalContinuationStateFor(state, goalId);
      state.runtimeGoalContinuationTurnFor = goalId;
    } else if (isRecord(event.message) && event.message.role === "user") clearRuntimeGoalContinuationState(state);
  });

  pi.on("before_agent_start", async (event) => {
    const goalId = continuationGoalIdFromPrompt(event.prompt);
    if (goalId) {
      clearRuntimeGoalContinuationStateFor(state, goalId);
      state.runtimeGoalContinuationTurnFor = goalId;
    }
    return undefined;
  });

  pi.on("turn_start", async () => {
    if (state.runtimeGoal?.status === "active") state.runtimeGoalLastAccountedAtMs = Date.now();
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Exact oracle/completion tools own their root event (or zero-effect rejection/replay).
    // Generic accounting must never append a second root revision that invalidates oracle lineage.
    if (event.toolName === "get_goal" || event.toolName === "get_goal_todos" || ROOT_LINEAGE_OWNING_TOOLS.has(event.toolName) || isGuardedGoalMutationEvent(event)) {
      render(ctx);
      return;
    }
    accountElapsed(state);
    persistRuntimeGoal(pi, state, "runtime");
    render(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    accountRuntimeGoalTurn(pi, state, event.message);
    render(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (state.runtimeGoal?.status === "active") queueRuntimeGoalContinuation(pi, state, ctx);
    render(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    state.runtimeGoal = restoreRuntimeGoalFromBranch(branch);
    state.goalTodos = restoreGoalTodosFromBranch(branch);
    render(ctx);
    queueRuntimeGoalContinuation(pi, state, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    state.runtimeGoal = restoreRuntimeGoalFromBranch(branch);
    state.goalTodos = restoreGoalTodosFromBranch(branch);
    render(ctx);
    queueRuntimeGoalContinuation(pi, state, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    accountElapsed(state);
    persistRuntimeGoal(pi, state, "runtime");
    clearRuntimeGoalContinuationState(state);
    ctx.ui.setStatus("zob-goal", undefined);
  });
}
