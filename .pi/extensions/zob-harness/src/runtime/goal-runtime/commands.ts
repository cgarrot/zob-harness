import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseGoalState, validateGoalState } from "../../domains/goal/goal.js";
import { goalTodoCompletionDiagnostics, handleGoalTodoTextCommand } from "../../domains/goal/goal-todos.js";
import type { HarnessRuntimeState } from "../state.js";
import type { RuntimeGoal, RuntimeGoalCompletionProposalV2, RuntimeGoalOracleVerdict } from "./state.js";
import { appendRuntimeGoalEntry, asGoalActivationMode, assertRuntimeGoalMutable, buildRuntimeGoalOracleBinding, clearEntry, clearRuntimeGoalContinuationState, clearRuntimeGoalContinuationStateFor, cloneGoal, createRuntimeGoal, evaluateRuntimeGoalCompletionProposalFreshness, formatGoalActivationMode, formatRuntimeGoalSummary, isRuntimeGoalCompletionProposalV2, isRuntimeGoalOracleBindingV2, maybeStructuredGate, persistGoalActivationMode, queueRuntimeGoalContinuation, resumeRuntimeGoal, setEntry, unixSeconds } from "./state.js";
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
    const goal = state.runtimeGoal;
    const diagnostics = goalTodoCompletionDiagnostics(state.goalTodos, goal?.goalId);
    const freshness = evaluateRuntimeGoalCompletionProposalFreshness({
      goal,
      todoGraphRevision: goal ? state.goalTodos.graphRevisions?.[goal.goalId] ?? 0 : 0,
      todoRestoreBlocked: Boolean(goal && state.goalTodos.restoreBlocked?.[goal.goalId]),
      completionDiagnostics: diagnostics,
    });
    ctx.ui.notify(formatRuntimeGoalSummary(goal, state.goalActivationMode, undefined, freshness), goal?.status === "blocked" || goal?.status === "oracle_failed" ? "warning" : "info");
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
    const nextGoal = cloneGoal(state.runtimeGoal);
    const resumed = resumeRuntimeGoal(nextGoal, extraTurns);
    appendRuntimeGoalEntry(pi, state, setEntry(nextGoal, "command"));
    const persistedGoal = state.runtimeGoal!;
    clearRuntimeGoalContinuationStateFor(state, persistedGoal.goalId);
    render();
    const extensionNote = resumed.additionalTurns ? ` · turn window extended +${resumed.additionalTurns} to ${persistedGoal.loop.maxTurns}` : "";
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
  if (text === "oracle" || text.startsWith("oracle ")) {
    ctx.ui.notify("Legacy /goal oracle recording is disabled because it cannot provide exact proposal-hash and CAS lineage. Use get_goal, then record_goal_oracle with expected_proposal_hash and cas.expected_goal_revision.", "warning");
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
  const goal = createRuntimeGoal(gate?.activeGoal ?? text, { gate, gateRequired: state.goalRequired });
  appendRuntimeGoalEntry(pi, state, setEntry(goal, "command"));
  const persistedGoal = state.runtimeGoal!;
  if (persistedGoal.gate) {
    state.activeGoal = persistedGoal.gate;
    pi.appendEntry("zob-goal", persistedGoal.gate);
  }
  render();
  ctx.ui.notify(`ZOB runtime goal started: ${persistedGoal.objective.slice(0, 100)}`, "info");
  queueRuntimeGoalContinuation(pi, state, ctx);
}

export interface RecordGoalOracleInput {
  verdict: RuntimeGoalOracleVerdict;
  noShip: boolean;
  evidenceSummary: string;
  evidenceRefs?: string[];
  expectedProposalHash: string;
  expectedGoalRevision: number;
}

function oracleRecordError(code: string, field: string, safeNextActions: string, message: string): Error {
  return new Error(`record_goal_oracle blocked; code=${code} field=${field} retry_policy=refresh_goal safe_next_actions=${safeNextActions}; ${message}`);
}

export function assertGoalOracleRecordable(state: HarnessRuntimeState, input: Pick<RecordGoalOracleInput, "expectedProposalHash" | "expectedGoalRevision">): RuntimeGoalCompletionProposalV2 {
  const goal = state.runtimeGoal;
  if (!goal) throw oracleRecordError("GOAL_MISSING", "goal", "create_goal", "No ZOB runtime goal exists");
  assertRuntimeGoalMutable(goal);
  if (!/^[a-f0-9]{64}$/.test(input.expectedProposalHash)) throw oracleRecordError("PROPOSAL_HASH_INVALID", "expected_proposal_hash", "get_goal", "an exact full lowercase sha256 is required");
  if (!Number.isSafeInteger(input.expectedGoalRevision) || input.expectedGoalRevision < 0) throw oracleRecordError("GOAL_REVISION_INVALID", "cas.expected_goal_revision", "get_goal", "a canonical nonnegative revision is required");
  if (input.expectedGoalRevision !== goal.revision) throw oracleRecordError("GOAL_REVISION_STALE", "cas.expected_goal_revision", "get_goal", `expected=${input.expectedGoalRevision} current=${goal.revision}`);
  if (goal.status !== "ready_for_oracle") throw oracleRecordError("GOAL_NOT_READY_FOR_ORACLE", "goal.status", "resume_goal_then_propose_goal_completion", `current=${goal.status}`);
  const diagnostics = goalTodoCompletionDiagnostics(state.goalTodos, goal.goalId);
  const freshness = evaluateRuntimeGoalCompletionProposalFreshness({
    goal,
    todoGraphRevision: state.goalTodos.graphRevisions?.[goal.goalId] ?? 0,
    todoRestoreBlocked: Boolean(state.goalTodos.restoreBlocked?.[goal.goalId]),
    completionDiagnostics: diagnostics,
  });
  if (freshness.status !== "fresh") throw oracleRecordError("PROPOSAL_NOT_FRESH", "completionProposal", freshness.safeReproposeAction, `freshness=${freshness.code}`);
  const proposal = goal.completionProposal;
  if (!proposal || !isRuntimeGoalCompletionProposalV2(proposal)) throw oracleRecordError("PROPOSAL_V2_REQUIRED", "completionProposal", "propose_goal_completion", "legacy, malformed, or unbound proposals cannot be reviewed");
  if (proposal.proposalHash !== input.expectedProposalHash) throw oracleRecordError("PROPOSAL_HASH_MISMATCH", "expected_proposal_hash", "get_goal", "the supplied hash does not exactly match the current fresh proposal");
  if (isRuntimeGoalOracleBindingV2(goal.oracle)) throw oracleRecordError("ORACLE_ALREADY_BOUND", "oracle", "propose_goal_completion_then_record_goal_oracle", "an immutable oracle decision is already bound to this Goal revision");
  return proposal;
}

export function recordOracleVerdict(pi: ExtensionAPI, state: HarnessRuntimeState, input: RecordGoalOracleInput): RuntimeGoal {
  if (!input.evidenceSummary.trim()) throw oracleRecordError("EVIDENCE_SUMMARY_REQUIRED", "evidence_summary", "review_evidence", "a non-empty transient evidence summary is required");
  const proposal = assertGoalOracleRecordable(state, input);
  const goal = state.runtimeGoal!;
  const nextGoal = cloneGoal(goal);
  nextGoal.oracle = buildRuntimeGoalOracleBinding({
    proposalHash: proposal.proposalHash,
    proposalGoalRevision: proposal.goalRevision,
    todoGraphRevision: proposal.todoGraphRevision,
    goalRevision: nextGoal.revision + 1,
    verdict: input.verdict,
    noShip: input.noShip,
    evidenceSummary: input.evidenceSummary,
    evidenceRefs: input.evidenceRefs ?? [],
  });
  nextGoal.status = input.verdict === "PASS" && input.noShip === false ? "ready_for_oracle" : "oracle_failed";
  nextGoal.loop.enabled = false;
  nextGoal.updatedAt = unixSeconds();
  appendRuntimeGoalEntry(pi, state, setEntry(nextGoal, "tool"));
  const persistedGoal = state.runtimeGoal!;
  clearRuntimeGoalContinuationStateFor(state, persistedGoal.goalId);
  return persistedGoal;
}
