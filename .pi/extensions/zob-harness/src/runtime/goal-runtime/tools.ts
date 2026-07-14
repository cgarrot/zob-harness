import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { importChainRunTodos, importFactoryRunTodos, importOrchestrationRunTodos } from "../../domains/goal/goal-todo-imports.js";
import { addGoalTodo, formatGoalTodoSummary, formatGoalTodoTree, goalTodoCompletionDiagnostics, linkGoalTodoDelegation, recordGoalTodoClaimValidationResult, resolveGoalTodo, splitGoalTodo, summarizeGoalTodos, type GoalTodoNode, type GoalTodoOwner, type GoalTodoPriority, type GoalTodoStatus, type GoalTodoSummary, type ResolveGoalTodoAction } from "../../domains/goal/goal-todos.js";
import { RECOVERABLE_DELEGATION_ATTEMPT_STATUSES, assertCurrentGoalTodoClaimSettlementBinding, assertCurrentGoalTodoClaimValidationBinding, authorizeGoalTodoTransition, isCanonicalGoalTodoClaimBinding, markGoalTodoDelegationFailed, recoverGoalTodoDelegation, updateGoalTodo } from "../../domains/goal/goal-todos/operations.js";
import { adaptLegacyGoalTodoReference, resolveCanonicalGoalTodoReference, resolveCanonicalGoalTodoReferences, throwGoalTodoReferenceResolution } from "../../domains/goal/goal-todos/reference.js";
import type { HarnessRuntimeState } from "../state.js";
import { sha256 } from "../../core/utils/hashing.js";
import { isRecord } from "../../core/utils/records.js";
import { newRunId, safeFileStem } from "../../core/utils/paths.js";
import { appendGoalRoomMessage, validateGoalRoomMessageInput, type GoalRoomMessageInput } from "../../domains/goal/goal-room.js";
import { readZobLiveRegistrySnapshot } from "../../domains/coms/coms-v2/registry.js";
import { activeZpeerRoomId, peerAliasInRoom, refreshZpeerSelf, safeZpeerRoomId, sendZpeerPrompt, type ZpeerSendResult } from "../../domains/coms/coms-v2/zpeer.js";
import { loadZteamManifest, type ZTeamAgentManifest, type ZTeamMemberManifest } from "../../domains/coms/zagents.js";
import { loadTeamDefinition, validateTeamDefinition } from "../../domains/topology/teams.js";
import { assertGoalOracleRecordable, recordOracleVerdict } from "./commands.js";
import { createGoalMutationReceiptState, GOAL_MUTATION_PREPARATION_ENTRY_TYPE, GOAL_MUTATION_RECEIPT_ENTRY_TYPE, hashGoalMutationRequest } from "../../domains/goal/mutation-cas.js";
import type { GoalMutationPublicGuard, GoalTodoCanonicalReferenceInput, GoalTodoReferenceResolution } from "../../domains/goal/goal-todo-types.js";
import { executeGoalMutationCas } from "./mutation-cas.js";
import { executeGoalHandoffCas } from "./handoff.js";
import { assessDelegationAttemptLiveness } from "../delegation-monitor.js";
import { GoalDelegationRecoveryGuardSchema, GoalExactRootMutationGuardSchema, GoalExactTodoMutationGuardSchema, GoalMutationGuardSchema, GoalTodoCanonicalReferenceProperties, GoalTodoCanonicalReferenceSchema, GoalTodoClaimHashSchema, parseOptionalGoalMutationGuard, parseRequiredGoalDelegationRecoveryGuard, parseRequiredGoalRootMutationGuard } from "./schemas.js";
import { DEFAULT_GOAL_ACTIVATION_MODE, appendRuntimeGoalEntry, assertRuntimeGoalMutable, buildRuntimeGoalCompletionProposal, clearRuntimeGoalContinuationStateFor, cloneGoal, createRuntimeGoal, evaluateRuntimeGoalCompletionProposalFreshness, evaluateRuntimeGoalOracleFreshness, formatRuntimeGoalCompletionProposal, formatRuntimeGoalSummary, isRuntimeGoalCompletionProposalV2, isRuntimeGoalOracleBindingV2, maybeStructuredGate, publicRuntimeGoal, queueRuntimeGoalContinuation, resumeRuntimeGoal, runtimeGoalCompletionProposalPublicDetails, runtimeGoalOraclePublicDetails, runtimeGoalRestoreBlockedDiagnostic, setEntry, unixSeconds, type RuntimeGoal, type RuntimeGoalCompletionProposalFreshness, type RuntimeGoalOracleFreshness } from "./state.js";

export const EmptyParams = Type.Object({});
const GoalMutationCasProperties = {
  cas: Type.Optional(GoalMutationGuardSchema),
};
export const CreateGoalParams = Type.Object({
  objective: Type.String({ description: "Concrete ZOB runtime objective to pursue until ready_for_oracle." }),
  max_turns: Type.Optional(Type.Integer({ description: "Optional positive turn cap for the autonomous continuation loop.", minimum: 1 })),
  ...GoalMutationCasProperties,
});
export const ResumeGoalParams = Type.Object({
  goal_id: Type.Optional(Type.String({ description: "Expected current runtime goal id." })),
  resume_reason: Type.String({ description: "Why resuming the paused/blocked/oracle_failed goal is safe. Stored as hash only." }),
  additional_turns: Type.Optional(Type.Integer({ description: "Optional positive turn-window extension for resumed auto-continuation.", minimum: 1 })),
  queue_continuation: Type.Optional(Type.Boolean({ description: "Queue a follow-up continuation after resuming. Default false for API callers.", default: false })),
  ...GoalMutationCasProperties,
});
export const ProposeGoalCompletionParams = Type.Object({
  goal_id: Type.Optional(Type.String({ description: "Expected current runtime goal id." })),
  completion_summary: Type.String({ description: "Evidence-backed summary of completed work. Stored as hash only." }),
  requirements_checked: Type.Array(Type.String(), { description: "Explicit requirements checked before oracle." }),
  evidence_refs: Type.Array(Type.String(), { description: "Safe repo-relative evidence references or command names." }),
  validation_commands: Type.Array(Type.String(), { description: "Validation commands run and checked." }),
  known_risks: Type.Array(Type.String(), { description: "Known remaining risks or blockers." }),
  no_ship: Type.Boolean({ description: "True if any no-ship blocker remains." }),
  ...GoalMutationCasProperties,
});
const GoalBindingHashSchema = Type.String({
  description: "Exact full lowercase sha256 binding hash; prefixes and truncated hashes are rejected.",
  pattern: "^[a-f0-9]{64}$",
  minLength: 64,
  maxLength: 64,
});
export const OracleParams = Type.Object({
  verdict: StringEnum(["PASS", "WARN", "FAIL"] as const, { description: "Oracle verdict for the exact proposed goal completion." }),
  no_ship: Type.Boolean({ description: "Must be false to allow update_goal complete." }),
  evidence_summary: Type.String({ description: "Transient oracle evidence summary. Only an ordered evidence hash/count is stored.", minLength: 1 }),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Transient safe repo-relative evidence refs. Only an ordered evidence hash/count is stored." })),
  expected_proposal_hash: GoalBindingHashSchema,
  cas: GoalExactRootMutationGuardSchema,
}, { additionalProperties: false });
export const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete"] as const, { description: "Only complete is accepted, and only after exact bound oracle PASS/no_ship=false." }),
  expected_proposal_hash: GoalBindingHashSchema,
  expected_oracle_decision_hash: GoalBindingHashSchema,
  cas: GoalExactRootMutationGuardSchema,
}, { additionalProperties: false });

export const GoalTodoStatusValues = ["planned", "ready", "in_progress", "delegated", "claim_returned", "needs_review", "needs_oracle", "needs_user", "blocked", "done", "skipped"] as const;
export const GoalTodoOwnerValues = ["agent", "user", "oracle", "subagent", "factory", "orchestration"] as const;
export const GoalTodoPriorityValues = ["low", "normal", "high", "critical"] as const;
export const ResolveGoalTodoActionValues = ["auto", "complete", "accept_claim", "reject_claim", "block", "skip", "reopen"] as const;
export const GetGoalTodosParams = Type.Object({
  goal_id: Type.Optional(Type.String({ description: "Optional goal id. Defaults to current runtime goal." })),
  ...GoalTodoCanonicalReferenceProperties,
});
export const AddGoalTodoItemParams = Type.Object({
  title: Type.String({ description: "Atomic goal TODO title." }),
  parent_id: Type.Optional(Type.String({ description: "Optional parent TODO id for subtodos." })),
  owner: Type.Optional(StringEnum(GoalTodoOwnerValues, { description: "TODO owner. Default agent." })),
  required: Type.Optional(Type.Boolean({ description: "Whether this TODO blocks root completion. Default true." })),
  priority: Type.Optional(StringEnum(GoalTodoPriorityValues, { description: "TODO priority. Default normal." })),
  status: Type.Optional(StringEnum(GoalTodoStatusValues, { description: "Initial TODO status. Default planned." })),
  acceptance_criteria: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria for this TODO." })),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Initial safe evidence refs." })),
  validation_commands: Type.Optional(Type.Array(Type.String(), { description: "Initial validation commands." })),
});
export const AddGoalTodoParams = Type.Object({
  ...AddGoalTodoItemParams.properties,
  ...GoalMutationCasProperties,
});
export const AddGoalTodosParams = Type.Object({
  todos: Type.Array(AddGoalTodoItemParams, { description: "Multiple bounded TODO nodes to add in one tool call. Prefer this over repeated add_goal_todo calls for plans." }),
  goal_id: Type.Optional(Type.String({ description: "Optional goal id. Defaults to current runtime goal." })),
  ...GoalMutationCasProperties,
});
export const UpdateGoalTodoParams = Type.Object({
  ...GoalTodoCanonicalReferenceProperties,
  status: Type.Optional(StringEnum(GoalTodoStatusValues, { description: "New TODO status." })),
  owner: Type.Optional(StringEnum(GoalTodoOwnerValues, { description: "New TODO owner." })),
  required: Type.Optional(Type.Boolean({ description: "Whether this TODO blocks root completion." })),
  priority: Type.Optional(StringEnum(GoalTodoPriorityValues, { description: "New TODO priority." })),
  title: Type.Optional(Type.String({ description: "Replacement title." })),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Evidence refs replacing this TODO evidence list." })),
  validation_commands: Type.Optional(Type.Array(Type.String(), { description: "Validation commands replacing this TODO validation list." })),
  context_scope_id: Type.Optional(Type.String({ description: "Optional context_scope id for this TODO. Metadata only." })),
  context_pack_ref: Type.Optional(Type.String({ description: "Optional safe context pack artifact ref for this TODO." })),
  citations: Type.Optional(Type.Array(Type.String(), { description: "Optional citation refs for this TODO context." })),
  freshness: Type.Optional(Type.String({ description: "Optional context freshness label." })),
  blocker: Type.Optional(Type.String({ description: "Blocker text for blocked/needs_user states." })),
  ...GoalMutationCasProperties,
});
const GoalTodoAttemptIdSchema = Type.String({ description: "Exact latest delegation attempt ID bound to the claim.", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" });
const GoalTodoValidationPolicySchema = StringEnum(["parent_review", "oracle_required"] as const, { description: "Exact immutable validation policy fixed when the delegation attempt launched." });

export const CompleteGoalTodoParams = Type.Object({
  ...GoalTodoCanonicalReferenceProperties,
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Evidence refs proving completion." })),
  validation_commands: Type.Optional(Type.Array(Type.String(), { description: "Validation commands proving completion." })),
  skipped: Type.Optional(Type.Boolean({ description: "Mark skipped instead of done." })),
  reason: Type.Optional(Type.String({ description: "Skip reason when skipped=true." })),
  expected_auto_resolution: Type.Optional(StringEnum(["accept_claim"] as const, { description: "Required legacy-adapter acknowledgement when this alias accepts a returned claim." })),
  expected_claim_hash: Type.Optional(GoalTodoClaimHashSchema),
  expected_attempt_id: Type.Optional(GoalTodoAttemptIdSchema),
  expected_validation_policy: Type.Optional(GoalTodoValidationPolicySchema),
  ...GoalMutationCasProperties,
});
export const ResolveGoalTodoParams = Type.Object({
  ...GoalTodoCanonicalReferenceProperties,
  action: StringEnum(ResolveGoalTodoActionValues, { description: "Transition action. auto completes non-delegated TODOs; returned-claim auto acceptance requires explicit exact expectations." }),
  expected_auto_resolution: Type.Optional(StringEnum(["complete", "accept_claim"] as const, { description: "Explicit expected action for auto; accept_claim is mandatory for returned claims." })),
  expected_claim_hash: Type.Optional(GoalTodoClaimHashSchema),
  expected_attempt_id: Type.Optional(GoalTodoAttemptIdSchema),
  expected_validation_policy: Type.Optional(GoalTodoValidationPolicySchema),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Evidence refs for complete/accept/skip/reopen transitions." })),
  validation_commands: Type.Optional(Type.Array(Type.String(), { description: "Validation commands for complete/accept/skip/reopen transitions." })),
  reason: Type.Optional(Type.String({ description: "Required for block/reject_claim/reopen; skip reason for skip." })),
  user_resolved: Type.Optional(Type.Boolean({ description: "Explicit parent acknowledgement that a needs_user requirement was resolved." })),
  goal_id: Type.Optional(Type.String({ description: "Optional goal id. Defaults to current runtime goal." })),
  ...GoalMutationCasProperties,
});
export const BlockGoalTodoParams = Type.Object({
  ...GoalTodoCanonicalReferenceProperties,
  reason: Type.String({ description: "Blocker reason." }),
  ...GoalMutationCasProperties,
});
export const SplitGoalTodoParams = Type.Object({
  ...GoalTodoCanonicalReferenceProperties,
  titles: Type.Array(Type.String(), { description: "Child TODO titles." }),
  ...GoalMutationCasProperties,
});
export const ClaimGoalTodoParams = Type.Object({
  ...GoalTodoCanonicalReferenceProperties,
  expected_claim_hash: GoalTodoClaimHashSchema,
  expected_attempt_id: GoalTodoAttemptIdSchema,
  expected_validation_policy: GoalTodoValidationPolicySchema,
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Additional evidence refs." })),
  validation_commands: Type.Optional(Type.Array(Type.String(), { description: "Additional validation commands." })),
  reason: Type.Optional(Type.String({ description: "Rejection reason for reject_goal_todo_claim." })),
  cas: GoalExactTodoMutationGuardSchema,
}, { additionalProperties: false });
export const RejectGoalTodoClaimParams = Type.Object({
  ...GoalTodoCanonicalReferenceProperties,
  expected_claim_hash: GoalTodoClaimHashSchema,
  expected_attempt_id: GoalTodoAttemptIdSchema,
  expected_validation_policy: GoalTodoValidationPolicySchema,
  reason: Type.String({ description: "Required parent rejection reason.", minLength: 1 }),
  cas: GoalExactTodoMutationGuardSchema,
}, { additionalProperties: false });
export const RecoverGoalTodoDelegationParams = Type.Object({
  ...GoalTodoCanonicalReferenceProperties,
  expected_attempt_id: Type.String({ description: "Exact latest durable delegation attempt ID.", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" }),
  expected_run_id: Type.String({ description: "Exact child run ID bound to expected_attempt_id.", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" }),
  reason: Type.String({ description: "Required parent recovery reason. Only its sha256 hash is persisted.", minLength: 1 }),
  evidence_refs: Type.Array(Type.String(), { description: "Required safe repo-relative recovery evidence refs.", minItems: 1, maxItems: 32 }),
  proof_refs: Type.Array(Type.String(), { description: "Required safe repo-relative refs supporting the authoritative liveness proof.", minItems: 1, maxItems: 32 }),
  cas: GoalDelegationRecoveryGuardSchema,
}, { additionalProperties: false });
export const ValidateGoalTodoClaimParams = Type.Object({
  ...GoalTodoCanonicalReferenceProperties,
  verdict: StringEnum(["PASS", "WARN", "FAIL"] as const, { description: "Oracle verdict for the returned claim." }),
  recommended_action: StringEnum(["accept_claim", "needs_review", "reject_claim", "block"] as const, { description: "Oracle recommended parent action." }),
  no_ship: Type.Boolean({ description: "True when any no-ship blocker remains." }),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Evidence refs inspected by oracle." })),
  validation_commands: Type.Optional(Type.Array(Type.String(), { description: "Validation commands checked by oracle." })),
  blocking_issues: Type.Optional(Type.Array(Type.String(), { description: "Blocking issues, or empty for PASS." })),
  confidence: StringEnum(["LOW", "MEDIUM", "HIGH"] as const, { description: "Oracle confidence." }),
  claim_hash: GoalTodoClaimHashSchema,
  expected_attempt_id: GoalTodoAttemptIdSchema,
  expected_validation_policy: StringEnum(["oracle_required"] as const, { description: "Validation is only valid for a launch-fixed oracle_required claim." }),
  output_hash: GoalTodoClaimHashSchema,
  run_id: Type.Optional(Type.String({ description: "Oracle validation run id, if available." })),
  agent: Type.Optional(Type.String({ description: "Oracle agent name. Default oracle." })),
  auto_accept: Type.Optional(Type.Boolean({ description: "Auto-accept on strict PASS/no_ship=false. Default true." })),
  cas: GoalExactTodoMutationGuardSchema,
}, { additionalProperties: false });
export const HandoffGoalTodoParams = Type.Object({
  ...GoalTodoCanonicalReferenceProperties,
  todo_ids: Type.Optional(Type.Array(Type.String({ pattern: "^todo_[a-f0-9]{12}$" }), { description: "Deprecated exact-ID batch adapter. Prefer todo_refs canonical objects; paths are rejected here." })),
  todo_refs: Type.Optional(Type.Array(Type.Union([
    GoalTodoCanonicalReferenceSchema,
    Type.String({ description: "Deprecated mixed raw ref adapter. Prefer {todo_id,todo_path}; raw values are adapted explicitly without fallback during strict resolution." }),
  ]), { description: "Atomic canonical object refs, with raw strings retained only as an explicit deprecated compatibility boundary." })),
  target_type: StringEnum(["zpeer", "zteam"] as const, { description: "Explicit handoff target kind." }),
  target: Type.String({ description: "Explicit target alias/role for zpeer (leading @ optional) or project-local zteam id." }),
  custom_message: Type.String({ description: "Maintainer-authored transient instruction body. The raw body is hashed and never persisted in Goal Room/coms/TODO state." }),
  goal_id: Type.Optional(Type.String({ description: "Optional goal id. Defaults to current runtime goal." })),
  run_id: Type.Optional(Type.String({ description: "Optional handoff run id. Defaults to generated handoff_* id." })),
  sender: Type.Optional(Type.String({ description: "Goal Room sender role. Defaults to parent." })),
  goal_room_team: Type.Optional(Type.String({ description: "Team topology used for Goal Room sender validation. Default zob-core." })),
  target_room: Type.Optional(Type.String({ description: "Optional ZPeer room id precondition for a zpeer target." })),
  delegation_depth: Type.Optional(Type.Number({ description: "Parent-owned delegation depth metadata. Default 1." })),
  ...GoalMutationCasProperties,
});
export const ImportGoalTodoRunParams = Type.Object({
  run_id: Type.String({ description: "Run id under reports/factory-runs, reports/orchestrations, or reports/chains." }),
  goal_id: Type.Optional(Type.String({ description: "Optional goal id. Defaults to current runtime goal." })),
  ...GoalMutationCasProperties,
});

type GoalTodoMutationToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

type GoalTodoImportKind = "factory" | "orchestration" | "chain";

export function goalMutationPayload<T extends object>(params: T): Omit<T, "cas"> {
  const { cas: _cas, ...payload } = params as T & { cas?: unknown };
  return payload as Omit<T, "cas">;
}

function directImportFiles(repoRoot: string, relativeDir: string, suffix: string): string[] {
  const absoluteDir = join(repoRoot, relativeDir);
  if (!existsSync(absoluteDir) || !statSync(absoluteDir).isDirectory()) return [];
  return readdirSync(absoluteDir)
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => `${relativeDir}/${entry}`)
    .filter((ref) => statSync(join(repoRoot, ref)).isFile() && ref.endsWith(suffix))
    .sort();
}

function importSourceRefs(repoRoot: string, kind: GoalTodoImportKind, runId: string): string[] {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..") return [];
  if (kind === "factory") {
    const base = `reports/factory-runs/${runId}`;
    return [
      `${base}/manifest.json`,
      `${base}/agentic-plan.json`,
      `${base}/validation.json`,
      `${base}/DONE.sentinel`,
      `${base}/SMOKE_PASSED.sentinel`,
      `${base}/PILOT_PASSED.sentinel`,
      ...directImportFiles(repoRoot, `${base}/checkpoints`, ".checkpoint.json"),
      ...directImportFiles(repoRoot, `${base}/outputs`, ".json"),
    ];
  }
  if (kind === "orchestration") {
    const base = `reports/orchestrations/${runId}`;
    return [`${base}/orchestration-plan.json`, `${base}/manifest.json`, `${base}/status.jsonl`, `${base}/final-report.md`, `${base}/validation.json`, `${base}/room/evidence-index.json`, `${base}/room/context-pack.json`, `${base}/room/status.jsonl`];
  }
  const base = `reports/chains/${runId}`;
  return [`${base}/chain-plan.json`, `${base}/status.jsonl`, `${base}/final-report.md`, `${base}/validation.json`];
}

/** Hash only exact source bytes and refs; raw import bodies never enter requests, receipts, or results. */
export function importGoalTodoMutationPayload<T extends object & { run_id: string; cas?: unknown }>(repoRoot: string, kind: GoalTodoImportKind, params: T): Record<string, unknown> {
  const payload = goalMutationPayload(params);
  if (params.cas === undefined) return payload as Record<string, unknown>;
  const sourceHashes = importSourceRefs(repoRoot, kind, params.run_id).map((ref) => {
    const absolute = join(repoRoot, ref);
    return existsSync(absolute) && statSync(absolute).isFile()
      ? { ref, exists: true, contentHash: sha256(readFileSync(absolute).toString("base64")) }
      : { ref, exists: false };
  });
  return { ...payload, sourceHashes };
}

export function batchGoalTodoMutationPayload<T extends object & { todos: unknown[]; cas?: unknown }>(params: T): Record<string, unknown> {
  const payload = goalMutationPayload(params);
  if (params.cas === undefined) return payload as Record<string, unknown>;
  return { ...payload, itemHashes: params.todos.map((item) => hashGoalMutationRequest(item)) };
}

type PublicGoalTodoReferenceInput = { todo_id?: string; todo_path?: string };

export function resolvePublicGoalTodoTarget(state: HarnessRuntimeState, goalId: string, input: PublicGoalTodoReferenceInput, label = "Goal TODO reference"): GoalTodoReferenceResolution & { node: GoalTodoNode; canonicalId: string; path: string } {
  const resolution = resolveCanonicalGoalTodoReference(state.goalTodos, goalId, { todoId: input.todo_id, todoPath: input.todo_path });
  if (!resolution.node || !resolution.canonicalId || !resolution.path) throwGoalTodoReferenceResolution(label, resolution);
  return resolution as GoalTodoReferenceResolution & { node: GoalTodoNode; canonicalId: string; path: string };
}

export function canonicalGoalTodoMutationPayload<T extends object>(params: T, target: Pick<GoalTodoNode, "id" | "path">): Record<string, unknown> {
  const { cas: _cas, todo_id: _todoId, todo_path: _todoPath, ...payload } = params as T & { cas?: unknown; todo_id?: unknown; todo_path?: unknown };
  return { ...payload, canonical_todo_id: target.id };
}

function publicGoalTodoCasGuard(cas: unknown): GoalMutationPublicGuard | undefined {
  return cas === undefined ? undefined : parseOptionalGoalMutationGuard(cas);
}

function hasExactTodoCasRevisions(guard: GoalMutationPublicGuard | undefined): guard is GoalMutationPublicGuard & { expectedGraphRevision: number; expectedTodoRevision: number } {
  return guard?.expectedGraphRevision !== undefined && guard.expectedTodoRevision !== undefined;
}

function isExactGoalTodoMutationReplay(state: HarnessRuntimeState, goalId: string, toolName: string, resolvedTargetId: string, payload: unknown, guard: GoalMutationPublicGuard | undefined): boolean {
  if (!guard?.mutationId) return false;
  const receipt = state.goalTodos.mutationReceipts?.byGoal?.[goalId]?.[guard.mutationId];
  return Boolean(receipt && receipt.requestHash === hashGoalMutationRequest({ toolName, goalId, resolvedTargetId, payload }));
}

function requireExactClaimBinding(label: string, state: HarnessRuntimeState, goalId: string, node: GoalTodoNode, input: { expectedClaimHash: unknown; expectedAttemptId: unknown; expectedValidationPolicy: unknown; guard: GoalMutationPublicGuard | undefined }, requirePassedValidation: boolean): void {
  if (!isCanonicalGoalTodoClaimBinding(node.claim)) throw new Error(`${label} blocked; code=LEGACY_CLAIM_BINDING_REQUIRED field=claim retry_policy=never safe_next_actions=reject_or_reopen`);
  if (typeof input.expectedClaimHash !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedClaimHash)) throw new Error(`${label} requires exact full expected_claim_hash for returned claim ${node.id}; code=claim_hash_mismatch field=expected_claim_hash retry_policy=fix_input safe_next_actions=refresh_goal_todos`);
  if (typeof input.expectedAttemptId !== "string" || input.expectedAttemptId !== node.claim.attemptId) throw new Error(`${label} requires exact expected_attempt_id for returned claim ${node.id}; code=claim_attempt_mismatch field=expected_attempt_id retry_policy=refresh_goal_todos safe_next_actions=refresh_goal_todos`);
  if ((input.expectedValidationPolicy !== "parent_review" && input.expectedValidationPolicy !== "oracle_required") || input.expectedValidationPolicy !== node.claim.validationPolicy) throw new Error(`${label} requires exact expected_validation_policy for returned claim ${node.id}; code=claim_policy_mismatch field=expected_validation_policy retry_policy=refresh_goal_todos safe_next_actions=refresh_goal_todos`);
  if (!hasExactTodoCasRevisions(input.guard)) throw new Error(`${label} requires cas.expected_graph_revision and cas.expected_todo_revision for returned claim ${node.id}; code=cas_required field=cas retry_policy=refresh_goal_todos safe_next_actions=refresh_goal_todos`);
  assertCurrentGoalTodoClaimSettlementBinding(state, goalId, node.id, {
    expectedClaimHash: input.expectedClaimHash,
    expectedAttemptId: input.expectedAttemptId,
    expectedValidationPolicy: input.expectedValidationPolicy,
    expectedGraphRevision: input.guard.expectedGraphRevision,
    expectedTodoRevision: input.guard.expectedTodoRevision,
  }, requirePassedValidation);
}

function requireAutomaticClaimBinding(label: string, state: HarnessRuntimeState, goalId: string, node: GoalTodoNode, expectedAutoResolution: unknown, expectedClaimHash: unknown, expectedAttemptId: unknown, expectedValidationPolicy: unknown, guard: GoalMutationPublicGuard | undefined): void {
  if (expectedAutoResolution !== "accept_claim") throw new Error(`${label} requires expected_auto_resolution=accept_claim for returned claim ${node.id}; code=auto_resolution_mismatch field=expected_auto_resolution retry_policy=fix_input safe_next_actions=accept_claim`);
  requireExactClaimBinding(label, state, goalId, node, { expectedClaimHash, expectedAttemptId, expectedValidationPolicy, guard }, true);
}

function claimNextValidToolActions(node: GoalTodoNode): string[] {
  if (node.status === "done" || node.status === "skipped") return ["resolve_goal_todo:reopen"];
  if (!node.claim) return [];
  if (node.status === "blocked") return ["resolve_goal_todo:reopen", "resolve_goal_todo:skip"];
  if (node.claim.validationPolicy === "oracle_required" && node.validation?.status !== "passed") return ["validate_goal_todo_claim", "reject_goal_todo_claim", "block_goal_todo"];
  return ["accept_goal_todo_claim", "reject_goal_todo_claim", "block_goal_todo"];
}

function canonicalGoalTodoResultDetails(state: HarnessRuntimeState, goalId: string, node: GoalTodoNode, claimHash?: string): Record<string, unknown> {
  const graphRevision = state.goalTodos.graphRevisions?.[goalId] ?? 0;
  const todoRevision = node.revision ?? 0;
  const fullClaimHash = claimHash ?? node.claim?.claimHash;
  return {
    goalId,
    node,
    todo_id: node.id,
    todo_path: node.path,
    canonical_ref: { todo_id: node.id, todo_path: node.path },
    revisions: {
      goal_revision: state.runtimeGoal?.goalId === goalId ? state.runtimeGoal.revision : undefined,
      graph_revision: graphRevision,
      todo_revision: todoRevision,
    },
    claim_hash: fullClaimHash,
    claimHash: fullClaimHash,
    attemptId: node.claim?.attemptId,
    runId: node.claim?.runId,
    graphRevision,
    todoRevision,
    claimGraphRevision: node.claim?.graphRevision,
    claimTodoRevision: node.claim?.todoRevision,
    validationPolicy: node.claim?.validationPolicy,
    validationStatus: node.validation?.status,
    nextValidActions: claimNextValidToolActions(node),
    claim_binding: node.claim ? { ...node.claim, acceptanceBlockers: [...node.claim.acceptanceBlockers], childChangedPaths: node.claim.childChangedPaths?.map((ref) => ({ ...ref })) } : undefined,
    validation_binding: node.validation ? { ...node.validation, evidenceRefs: [...node.validation.evidenceRefs], validationCommands: [...node.validation.validationCommands], blockingIssues: [...node.validation.blockingIssues] } : undefined,
  };
}

function publicTodoRefLabel(input: PublicGoalTodoReferenceInput): string {
  return input.todo_id ?? input.todo_path ?? "<missing>";
}

function delegationRecoveryRefs(values: string[], label: string): string[] {
  const refs = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  const unsafe = refs.filter((ref) => ref.startsWith("/")
    || ref.startsWith("~/")
    || ref.includes("\\")
    || ref.includes("\0")
    || ref === "."
    || ref === ".."
    || ref.startsWith("../")
    || ref.includes("/../")
    || /(^|\/)\.env(?:\.|$)/i.test(ref)
    || /(^|\/)(?:\.pi\/sessions|\.pi\/agent-sessions|node_modules|dist|build)(?:\/|$)/i.test(ref)
    || /\.(?:key|pem)$/i.test(ref));
  if (refs.length === 0 || unsafe.length > 0) throw new Error(`${label} requires non-empty safe repo-relative refs; unsafe=${unsafe.join("|") || "none"}`);
  return refs;
}

function recoveryRefsHash(refs: string[]): string {
  return sha256(JSON.stringify(refs));
}

function rejectedDelegationRecovery(state: HarnessRuntimeState, goalId: string, node: GoalTodoNode, code: string, retryPolicy: string, liveness?: ReturnType<typeof assessDelegationAttemptLiveness>): GoalTodoMutationToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code} todo=${node.id} attempt=${node.delegationAttempts?.at(-1)?.attemptId ?? "none"} retry_policy=${retryPolicy}` }],
    details: {
      ...canonicalGoalTodoResultDetails(state, goalId, node),
      code,
      retry_policy: retryPolicy,
      ...(liveness ? { liveness } : {}),
      mutated: false,
      auto_dispatch: false,
      bodyStored: false,
    },
  };
}

/** Single public Goal/TODO mutation boundary. Unguarded results are returned by identity. */
export async function executeGoalTodoMutation(pi: ExtensionAPI, state: HarnessRuntimeState, input: {
  toolName: string;
  goalId: string;
  resolvedTargetId: string;
  payload: unknown;
  cas?: unknown;
  apply: () => GoalTodoMutationToolResult | Promise<GoalTodoMutationToolResult>;
}): Promise<GoalTodoMutationToolResult> {
  if (input.cas === undefined) return input.apply();
  state.goalTodos.mutationReceipts ??= createGoalMutationReceiptState();
  const graphRevisionBefore = state.goalTodos.graphRevisions?.[input.goalId] ?? 0;
  const targetBefore = state.goalTodos.nodes.find((node) => node.goalId === input.goalId && node.id === input.resolvedTargetId);
  const goalRevision = state.runtimeGoal?.goalId === input.goalId ? state.runtimeGoal.revision : undefined;
  const guard = input.cas === undefined ? undefined : parseOptionalGoalMutationGuard(input.cas);
  const outcome = await executeGoalMutationCas({
    toolName: input.toolName,
    goalId: input.goalId,
    resolvedTargetId: input.resolvedTargetId,
    ...(targetBefore ? { todoId: targetBefore.id } : {}),
    payload: input.payload,
    guard,
    current: {
      ...(goalRevision !== undefined ? { goalRevision } : {}),
      graphRevision: graphRevisionBefore,
      ...(targetBefore?.revision !== undefined ? { todoRevisions: { [input.resolvedTargetId]: targetBefore.revision } } : {}),
    },
    receipts: state.goalTodos.mutationReceipts,
    restoreBlocked: Boolean(state.goalTodos.restoreBlocked?.[input.goalId]),
    apply: async () => {
      const result = await input.apply();
      const graphRevision = state.goalTodos.graphRevisions?.[input.goalId] ?? graphRevisionBefore;
      const targetAfter = state.goalTodos.nodes.find((node) => node.goalId === input.goalId && node.id === input.resolvedTargetId);
      return {
        result,
        appliedRevisions: {
          ...(goalRevision !== undefined ? { goalRevision } : {}),
          graphRevision,
          ...(targetBefore && targetAfter?.revision !== undefined ? { todoRevision: targetAfter.revision } : {}),
        },
        eventCount: graphRevision - graphRevisionBefore,
      };
    },
    persistPreparation: (preparation) => pi.appendEntry(GOAL_MUTATION_PREPARATION_ENTRY_TYPE, preparation),
    persistReceipt: (receipt) => pi.appendEntry(GOAL_MUTATION_RECEIPT_ENTRY_TYPE, receipt),
    didApply: () => (state.goalTodos.graphRevisions?.[input.goalId] ?? graphRevisionBefore) > graphRevisionBefore,
  });

  if (outcome.status === "observed") return outcome.result;
  if (outcome.status === "applied") {
    return {
      ...outcome.result,
      details: {
        ...outcome.result.details,
        cas: { status: outcome.status, mutationId: outcome.mutationId, requestHash: outcome.requestHash, receipt: outcome.receipt, bodyStored: false },
      },
    };
  }
  if (outcome.status === "replayed") {
    return {
      content: [{ type: "text", text: `goal TODO mutation replayed: tool=${input.toolName} mutation_id=${outcome.mutationId} request_hash=${outcome.requestHash} event_count=${outcome.receipt.eventCount}` }],
      details: { goalId: input.goalId, resolvedTargetId: input.resolvedTargetId, ...(targetBefore ? canonicalGoalTodoResultDetails(state, input.goalId, state.goalTodos.nodes.find((node) => node.goalId === input.goalId && node.id === targetBefore.id) ?? targetBefore) : {}), cas: { status: outcome.status, mutationId: outcome.mutationId, requestHash: outcome.requestHash, receipt: outcome.receipt, bodyStored: false } },
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `goal TODO mutation ${outcome.status}: ${outcome.failureCodes.join(",")} tool=${input.toolName} goal=${input.goalId} target=${input.resolvedTargetId}${outcome.mutationId ? ` mutation_id=${outcome.mutationId}` : ""}${outcome.requestHash ? ` request_hash=${outcome.requestHash}` : ""}` }],
    details: { goalId: input.goalId, resolvedTargetId: input.resolvedTargetId, ...(targetBefore ? canonicalGoalTodoResultDetails(state, input.goalId, targetBefore) : {}), cas: { status: outcome.status, failureCodes: outcome.failureCodes, diagnostic: outcome.diagnostic, bodyStored: false } },
  };
}

type RootGoalMutationToolResult = GoalTodoMutationToolResult;

function rejectedRootGoalMutation(toolName: string, goalId: string, failureCodes: string[]): RootGoalMutationToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `goal mutation rejected: ${failureCodes.join(",")} tool=${toolName} goal=${goalId}` }],
    details: { goalId, resolvedTargetId: goalId, cas: { status: "rejected", failureCodes, bodyStored: false } },
  };
}

function receiptGoalIdForMutation(state: HarnessRuntimeState, mutationId: string): string | undefined {
  let matchedGoalId: string | undefined;
  const goalIds = new Set([
    ...Object.keys(state.goalTodos.mutationReceipts?.byGoal ?? {}),
    ...Object.keys(state.goalTodos.mutationReceipts?.protocolByGoal ?? {}),
  ]);
  for (const goalId of goalIds) {
    const receipt = state.goalTodos.mutationReceipts?.byGoal?.[goalId]?.[mutationId];
    const protocol = state.goalTodos.mutationReceipts?.protocolByGoal?.[goalId]?.[mutationId];
    if (!receipt && !protocol) continue;
    if (matchedGoalId && matchedGoalId !== goalId) throw new Error(`Goal mutation_id is ambiguous across goal streams: ${mutationId}`);
    matchedGoalId = goalId;
  }
  return matchedGoalId;
}

/** Root lifecycle CAS boundary. Guarded mutations require an exact goal revision and bracket one root event with prepared/applied records. */
async function executeRootGoalMutation(pi: ExtensionAPI, state: HarnessRuntimeState, input: {
  toolName: string;
  goalId: string;
  payload: unknown;
  guard: GoalMutationPublicGuard;
  currentGoalRevision: number;
  currentGraphRevision?: number;
  resultIdentityHash?: () => string | undefined;
  resultIdentityKind?: "proposal" | "oracle" | "completion";
  apply: () => RootGoalMutationToolResult | Promise<RootGoalMutationToolResult>;
}): Promise<RootGoalMutationToolResult> {
  if (input.guard.expectedGoalRevision === undefined) return rejectedRootGoalMutation(input.toolName, input.goalId, ["invalid_revision_guard"]);
  state.goalTodos.mutationReceipts ??= createGoalMutationReceiptState();
  const outcome = await executeGoalMutationCas({
    toolName: input.toolName,
    goalId: input.goalId,
    resolvedTargetId: input.goalId,
    payload: input.payload,
    guard: input.guard,
    current: { goalRevision: input.currentGoalRevision, ...(input.currentGraphRevision !== undefined ? { graphRevision: input.currentGraphRevision } : {}) },
    receipts: state.goalTodos.mutationReceipts,
    restoreBlocked: Boolean(runtimeGoalRestoreBlockedDiagnostic(state.runtimeGoal, input.goalId)),
    apply: async () => {
      const result = await input.apply();
      const goalRevision = state.runtimeGoal?.goalId === input.goalId ? state.runtimeGoal.revision : input.currentGoalRevision;
      const eventCount = goalRevision - input.currentGoalRevision;
      if (eventCount !== 1) throw new Error("Guarded root Goal lifecycle mutation must append exactly one root revision before its receipt.");
      const resultIdentityHash = input.resultIdentityHash?.();
      return {
        result,
        appliedRevisions: { goalRevision, ...(input.currentGraphRevision !== undefined ? { graphRevision: input.currentGraphRevision } : {}) },
        eventCount,
        ...(resultIdentityHash ? { sideEffect: { state: "completed" as const, operationHash: resultIdentityHash } } : {}),
      };
    },
    persistPreparation: (preparation) => pi.appendEntry(GOAL_MUTATION_PREPARATION_ENTRY_TYPE, preparation),
    persistReceipt: (receipt) => pi.appendEntry(GOAL_MUTATION_RECEIPT_ENTRY_TYPE, receipt),
    didApply: () => (state.runtimeGoal?.goalId === input.goalId ? state.runtimeGoal.revision : input.currentGoalRevision) > input.currentGoalRevision,
  });

  if (outcome.status === "observed") return outcome.result;
  if (outcome.status === "applied") {
    return {
      ...outcome.result,
      details: {
        ...outcome.result.details,
        cas: { status: outcome.status, mutationId: outcome.mutationId, requestHash: outcome.requestHash, receipt: outcome.receipt, bodyStored: false },
      },
    };
  }
  if (outcome.status === "replayed") {
    const operationHash = outcome.receipt.sideEffect?.operationHash;
    const payload = isRecord(input.payload) ? input.payload : {};
    const proposalHash = input.resultIdentityKind === "proposal" ? operationHash : typeof payload.expected_proposal_hash === "string" ? payload.expected_proposal_hash : undefined;
    const oracleDecisionHash = input.resultIdentityKind === "oracle" || input.resultIdentityKind === "completion"
      ? operationHash ?? (typeof payload.expected_oracle_decision_hash === "string" ? payload.expected_oracle_decision_hash : undefined)
      : undefined;
    const currentProposal = state.runtimeGoal?.completionProposal;
    const proposalGoalRevision = input.resultIdentityKind === "proposal"
      ? outcome.receipt.goalRevision
      : currentProposal && proposalHash === currentProposal.proposalHash ? currentProposal.goalRevision : outcome.receipt.expectedGoalRevision;
    return {
      content: [{ type: "text", text: `goal mutation replayed: tool=${input.toolName} mutation_id=${outcome.mutationId} request_hash=${outcome.requestHash} event_count=${outcome.receipt.eventCount}${proposalHash ? ` proposalHash=${proposalHash}` : ""}${oracleDecisionHash ? ` oracleDecisionHash=${oracleDecisionHash}` : ""}` }],
      details: {
        goalId: input.goalId,
        resolvedTargetId: input.goalId,
        ...(proposalHash ? {
          proposalHash,
          proposal_hash: proposalHash,
          proposalGoalRevision,
          todoGraphRevision: outcome.receipt.graphRevision,
          proposal_binding: { proposalHash, goalRevision: proposalGoalRevision, todoGraphRevision: outcome.receipt.graphRevision, bodyStored: false },
        } : {}),
        ...(oracleDecisionHash ? {
          oracleDecisionHash,
          oracle_decision_hash: oracleDecisionHash,
          oracleGoalRevision: input.resultIdentityKind === "completion" ? outcome.receipt.expectedGoalRevision : outcome.receipt.goalRevision,
          oracle_binding: { oracleDecisionHash, proposalHash, proposalGoalRevision, todoGraphRevision: outcome.receipt.graphRevision, goalRevision: input.resultIdentityKind === "completion" ? outcome.receipt.expectedGoalRevision : outcome.receipt.goalRevision, bodyStored: false },
        } : {}),
        cas: { status: outcome.status, mutationId: outcome.mutationId, requestHash: outcome.requestHash, receipt: outcome.receipt, bodyStored: false },
      },
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `goal mutation ${outcome.status}: ${outcome.failureCodes.join(",")} tool=${input.toolName} goal=${input.goalId} mutation_id=${outcome.mutationId ?? input.guard.mutationId}${outcome.requestHash ? ` request_hash=${outcome.requestHash}` : ""}` }],
    details: { goalId: input.goalId, resolvedTargetId: input.goalId, cas: { status: outcome.status, failureCodes: outcome.failureCodes, diagnostic: outcome.diagnostic, bodyStored: false } },
  };
}

export function currentGoalId(state: HarnessRuntimeState, explicit?: string): string {
  const goalId = explicit ?? state.runtimeGoal?.goalId;
  if (!goalId) throw new Error("Goal TODO tools require an active runtime goal or explicit goal_id.");
  return goalId;
}

function hasGoalMutationReceiptOrProtocol(state: HarnessRuntimeState, goalId: string, mutationId: string): boolean {
  return Boolean(state.goalTodos.mutationReceipts?.byGoal?.[goalId]?.[mutationId]
    || state.goalTodos.mutationReceipts?.protocolByGoal?.[goalId]?.[mutationId]);
}

function currentCompletionProposalFreshness(state: HarnessRuntimeState, goal: RuntimeGoal | undefined = state.runtimeGoal): RuntimeGoalCompletionProposalFreshness {
  const goalId = goal?.goalId;
  const diagnostics = goalTodoCompletionDiagnostics(state.goalTodos, goalId);
  return evaluateRuntimeGoalCompletionProposalFreshness({
    goal,
    todoGraphRevision: goalId ? state.goalTodos.graphRevisions?.[goalId] ?? 0 : 0,
    todoRestoreBlocked: Boolean(goalId && state.goalTodos.restoreBlocked?.[goalId]),
    completionDiagnostics: diagnostics,
  });
}

function currentOracleFreshness(state: HarnessRuntimeState, goal: RuntimeGoal | undefined = state.runtimeGoal): RuntimeGoalOracleFreshness {
  const goalId = goal?.goalId;
  return evaluateRuntimeGoalOracleFreshness({
    goal,
    todoGraphRevision: goalId ? state.goalTodos.graphRevisions?.[goalId] ?? 0 : 0,
    todoRestoreBlocked: Boolean(goalId && state.goalTodos.restoreBlocked?.[goalId]),
    completionDiagnostics: goalTodoCompletionDiagnostics(state.goalTodos, goalId),
  });
}

function completionProposalReadDetails(state: HarnessRuntimeState, goal: RuntimeGoal | undefined, freshness: RuntimeGoalCompletionProposalFreshness): Record<string, unknown> {
  const proposal = goal?.completionProposal;
  const oracle = goal?.oracle;
  const oracleFreshness = currentOracleFreshness(state, goal);
  return {
    completionProposal: runtimeGoalCompletionProposalPublicDetails(proposal),
    proposalHash: proposal?.proposalHash,
    proposal_hash: proposal?.proposalHash,
    proposalGoalRevision: proposal?.goalRevision,
    todoGraphRevision: proposal?.todoGraphRevision,
    proposalFreshness: freshness,
    freshness: freshness.status,
    freshnessCode: freshness.code,
    safeReproposeAction: freshness.safeReproposeAction,
    proposal_binding: proposal ? {
      proposalHash: proposal.proposalHash,
      goalRevision: proposal.goalRevision,
      todoGraphRevision: proposal.todoGraphRevision,
      bodyStored: false,
    } : undefined,
    oracleBinding: oracle ? runtimeGoalOraclePublicDetails(oracle) : undefined,
    oracleDecisionHash: oracle?.oracleDecisionHash,
    oracle_decision_hash: oracle?.oracleDecisionHash,
    oracleProposalHash: oracle?.proposalHash,
    oracleProposalGoalRevision: oracle?.proposalGoalRevision,
    oracleTodoGraphRevision: oracle?.todoGraphRevision,
    oracleGoalRevision: oracle?.goalRevision,
    oracleFreshness,
    oracle_freshness: oracleFreshness.status,
    oracleFreshnessCode: oracleFreshness.code,
    oracleSafeNextAction: oracleFreshness.safeNextAction,
    oracle_binding: oracle ? {
      oracleDecisionHash: oracle.oracleDecisionHash,
      proposalHash: oracle.proposalHash,
      proposalGoalRevision: oracle.proposalGoalRevision,
      todoGraphRevision: oracle.todoGraphRevision,
      goalRevision: oracle.goalRevision,
      verdict: oracle.verdict,
      noShip: oracle.noShip,
      evidenceHash: oracle.evidenceHash,
      evidenceCount: oracle.evidenceCount,
      reviewedAt: oracle.reviewedAt,
      bodyStored: false,
    } : undefined,
  };
}

function rootBindingError(operation: "record_goal_oracle" | "update_goal", code: string, field: string, safeNextActions: string, message: string): Error {
  return new Error(`${operation} blocked; code=${code} field=${field} retry_policy=refresh_goal safe_next_actions=${safeNextActions}; ${message}`);
}

function assertExactBindingHash(operation: "record_goal_oracle" | "update_goal", value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw rootBindingError(operation, "BINDING_HASH_INVALID", field, "get_goal", "an exact full lowercase sha256 is required");
}

function assertGoalCompletableWithBinding(state: HarnessRuntimeState, expectedProposalHash: unknown, expectedOracleDecisionHash: unknown, expectedGoalRevision: number): void {
  const goal = state.runtimeGoal;
  if (!goal) throw rootBindingError("update_goal", "GOAL_MISSING", "goal", "create_goal", "No ZOB runtime goal exists");
  assertRuntimeGoalMutable(goal);
  assertExactBindingHash("update_goal", expectedProposalHash, "expected_proposal_hash");
  assertExactBindingHash("update_goal", expectedOracleDecisionHash, "expected_oracle_decision_hash");
  if (goal.status === "complete") throw rootBindingError("update_goal", "GOAL_ALREADY_COMPLETE", "goal.status", "get_goal", "only the exact original CAS mutation may replay completion");
  if (expectedGoalRevision !== goal.revision) throw rootBindingError("update_goal", "GOAL_REVISION_STALE", "cas.expected_goal_revision", "get_goal", `expected=${expectedGoalRevision} current=${goal.revision}`);
  if (isRuntimeGoalOracleBindingV2(goal.oracle)) {
    if (goal.oracle.oracleDecisionHash !== expectedOracleDecisionHash) throw rootBindingError("update_goal", "ORACLE_DECISION_HASH_MISMATCH", "expected_oracle_decision_hash", "get_goal", "the supplied oracle decision hash is not the exact bound decision");
    if (goal.oracle.verdict !== "PASS") throw rootBindingError("update_goal", "ORACLE_VERDICT_NOT_PASS", "oracle.verdict", "resume_goal_then_propose_goal_completion", `verdict=${goal.oracle.verdict}`);
    if (goal.oracle.noShip !== false) throw rootBindingError("update_goal", "ORACLE_NO_SHIP", "oracle.noShip", "resume_goal_then_propose_goal_completion", "oracle no_ship=false is required");
  }
  if (goal.status !== "ready_for_oracle") throw rootBindingError("update_goal", "GOAL_NOT_READY_FOR_COMPLETION", "goal.status", "resume_goal_then_propose_goal_completion", `current=${goal.status}`);
  const proposalFreshness = currentCompletionProposalFreshness(state, goal);
  if (proposalFreshness.status !== "fresh") throw rootBindingError("update_goal", "PROPOSAL_NOT_FRESH", "completionProposal", proposalFreshness.safeReproposeAction, `freshness=${proposalFreshness.code}`);
  const proposal = goal.completionProposal;
  if (!proposal || !isRuntimeGoalCompletionProposalV2(proposal)) throw rootBindingError("update_goal", "PROPOSAL_V2_REQUIRED", "completionProposal", "propose_goal_completion", "legacy, malformed, or unbound proposals cannot complete");
  if (proposal.proposalHash !== expectedProposalHash) throw rootBindingError("update_goal", "PROPOSAL_HASH_MISMATCH", "expected_proposal_hash", "get_goal", "the supplied proposal hash is not the current exact proposal");
  if (proposal.noShip !== false) throw rootBindingError("update_goal", "PROPOSAL_NO_SHIP", "completionProposal.noShip", "propose_goal_completion", "proposal no_ship=false is required");
  const oracle = goal.oracle;
  if (!isRuntimeGoalOracleBindingV2(oracle)) throw rootBindingError("update_goal", oracle.legacyUnbound ? "LEGACY_ORACLE_UNBOUND" : oracle.oracleVersion === 2 ? "ORACLE_BINDING_MALFORMED" : "ORACLE_V2_REQUIRED", "oracle", "record_goal_oracle", "a canonical bound oracle decision v2 is required");
  if (oracle.oracleDecisionHash !== expectedOracleDecisionHash) throw rootBindingError("update_goal", "ORACLE_DECISION_HASH_MISMATCH", "expected_oracle_decision_hash", "get_goal", "the supplied oracle decision hash is not the exact bound decision");
  if (oracle.proposalHash !== proposal.proposalHash || oracle.proposalGoalRevision !== proposal.goalRevision) throw rootBindingError("update_goal", "ORACLE_PROPOSAL_LINEAGE_MISMATCH", "oracle.proposalHash", "propose_goal_completion_then_record_goal_oracle", "the oracle is not bound to the current proposal and proposal revision");
  if (oracle.todoGraphRevision !== proposal.todoGraphRevision || oracle.todoGraphRevision !== (state.goalTodos.graphRevisions?.[goal.goalId] ?? 0)) throw rootBindingError("update_goal", "ORACLE_TODO_GRAPH_LINEAGE_MISMATCH", "oracle.todoGraphRevision", "resolve_goal_todos_then_propose_goal_completion", "the TODO graph changed after proposal/oracle review");
  if (oracle.goalRevision !== goal.revision) throw rootBindingError("update_goal", "ORACLE_ROOT_LINEAGE_MISMATCH", "oracle.goalRevision", "propose_goal_completion_then_record_goal_oracle", "a root Goal mutation occurred after the oracle decision");
  if (oracle.status !== "passed" || oracle.verdict !== "PASS") throw rootBindingError("update_goal", "ORACLE_VERDICT_NOT_PASS", "oracle.verdict", "resume_goal_then_propose_goal_completion", `verdict=${oracle.verdict ?? "none"}`);
  if (oracle.noShip !== false) throw rootBindingError("update_goal", "ORACLE_NO_SHIP", "oracle.noShip", "resume_goal_then_propose_goal_completion", "oracle no_ship=false is required");
  const oracleFreshness = currentOracleFreshness(state, goal);
  if (oracleFreshness.status !== "fresh") throw rootBindingError("update_goal", "ORACLE_NOT_FRESH", "oracle", oracleFreshness.safeNextAction, `freshness=${oracleFreshness.code}`);
  const diagnostics = goalTodoCompletionDiagnostics(state.goalTodos, goal.goalId);
  if (diagnostics.effectiveNoShip || !diagnostics.completionReady) throw rootBindingError("update_goal", diagnostics.effectiveNoShip ? "COMPLETION_DIAGNOSTICS_NO_SHIP" : "TODO_REQUIREMENTS_INCOMPLETE", "goalTodos", "resolve_goal_todos_then_propose_goal_completion", `completion_ready=${diagnostics.completionReady} effective_no_ship=${diagnostics.effectiveNoShip}`);
}

export type HandoffGoalTodoReferenceInput = { todo_id?: string; todo_path?: string };

export type HandoffGoalTodoInput = {
  todo_id?: string;
  todo_path?: string;
  /** Deprecated exact-ID batch adapter. */
  todo_ids?: string[];
  /** Canonical objects are preferred; raw strings use the explicit compatibility adapter. */
  todo_refs?: Array<HandoffGoalTodoReferenceInput | string>;
  target_type: "zpeer" | "zteam";
  target: string;
  custom_message: string;
  goal_id?: string;
  run_id?: string;
  sender?: string;
  goal_room_team?: string;
  target_room?: string;
  delegation_depth?: number;
  cas?: unknown;
  append_goal_room?: boolean;
};

export function collectHandoffTodoRefs(input: HandoffGoalTodoInput): string[] {
  return [input.todo_id, input.todo_path, ...(input.todo_ids ?? []), ...(input.todo_refs ?? []).filter((ref): ref is string => typeof ref === "string")]
    .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
}

export function adaptLegacyHandoffGoalTodoReference(ref: string): GoalTodoCanonicalReferenceInput {
  return adaptLegacyGoalTodoReference(ref) ?? { todoId: ref };
}

export function collectHandoffCanonicalTodoRefs(input: HandoffGoalTodoInput): { references: GoalTodoCanonicalReferenceInput[]; compatibilityWarnings: string[] } {
  const references: GoalTodoCanonicalReferenceInput[] = [];
  const compatibilityWarnings: string[] = [];
  if (input.todo_id !== undefined || input.todo_path !== undefined) references.push({ todoId: input.todo_id, todoPath: input.todo_path });
  for (const todoId of input.todo_ids ?? []) {
    references.push({ todoId });
    compatibilityWarnings.push("todo_ids is deprecated; use todo_refs canonical objects with todo_id and/or todo_path");
  }
  for (const reference of input.todo_refs ?? []) {
    if (typeof reference === "string") {
      references.push(adaptLegacyHandoffGoalTodoReference(reference));
      compatibilityWarnings.push("raw todo_refs strings are deprecated; use {todo_id,todo_path} canonical objects");
    } else {
      references.push({ todoId: reference.todo_id, todoPath: reference.todo_path });
    }
  }
  return { references, compatibilityWarnings: [...new Set(compatibilityWarnings)] };
}

export function peerAliases(peer: { zpeerAlias?: string; zpeerMemberships?: Array<{ alias?: string; roomId?: string }> }, roomId?: string): string[] {
  const aliases = [peer.zpeerAlias, ...(peer.zpeerMemberships ?? []).filter((membership) => !roomId || membership.roomId === roomId).map((membership) => membership.alias)]
    .filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0);
  return [...new Set(aliases)];
}

export function validateHandoffTarget(repoRoot: string, input: HandoffGoalTodoInput): { targetHash: string; deliveryTarget: string; errors: string[]; peerCount: number } {
  const target = input.target.replace(/^@+/, "").trim();
  if (!target) return { targetHash: sha256(""), deliveryTarget: "", errors: ["handoff target is required and must be explicit"], peerCount: 0 };
  const targetHash = sha256(`${input.target_type}:${target}`);
  const registry = readZobLiveRegistrySnapshot(repoRoot);
  if (input.target_type === "zpeer") {
    const matchesTarget = (peer: (typeof registry.peers)[number]): boolean => peer.roleId === target || peerAliases(peer, input.target_room).includes(target);
    const online = registry.peers.filter((peer) => peer.status === "online" && peer.transport === "local_socket" && !peer.endpoint.startsWith("pending-") && matchesTarget(peer));
    const unavailable = registry.peers.filter((peer) => peer.status !== "online" && matchesTarget(peer));
    if (online.length !== 1) {
      const reason = online.length === 0
        ? unavailable.length > 0 ? `target zpeer '${target}' is stale/offline` : `target zpeer '${target}' is not registered online`
        : `target zpeer '${target}' is ambiguous (${online.length} online matches)`;
      return { targetHash, deliveryTarget: target, errors: [reason], peerCount: online.length };
    }
    return { targetHash, deliveryTarget: target, errors: [], peerCount: online.length };
  }

  const loaded = loadZteamManifest(repoRoot, target);
  if (loaded.errors.length > 0) return { targetHash, deliveryTarget: target, errors: loaded.errors, peerCount: 0 };
  const members = [...(loaded.manifest.members ?? []), ...(loaded.manifest.agents ?? [])];
  const missing: string[] = [];
  for (const member of members) {
    const memberId = "zagentId" in member ? member.zagentId : member.id;
    const alias = typeof member.alias === "string" ? member.alias.replace(/^@+/, "") : undefined;
    const online = registry.peers.some((peer) => peer.status === "online" && peer.transport === "local_socket" && !peer.endpoint.startsWith("pending-") && (peer.roleId === memberId || peer.agent === memberId || (alias ? peerAliases(peer).includes(alias) : false)));
    if (!online) missing.push(alias ? `${memberId}/@${alias}` : memberId);
  }
  if (missing.length > 0) return { targetHash, deliveryTarget: target, errors: [`zteam '${target}' has stale/offline or unregistered member(s): ${missing.join(", ")}`], peerCount: members.length - missing.length };
  return { targetHash, deliveryTarget: target, errors: [], peerCount: members.length };
}

export function parseGoalTodoHandoffTextCommand(text: string): { input?: HandoffGoalTodoInput; error?: string } {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "help" || trimmed === "--help") {
    return { error: "Usage: /goal todo handoff <todoId|path[,todoId|path...]> --to zpeer:@alias|zteam:<id> --message <maintainer instructions>. Batch refs must be comma-separated to avoid ambiguity." };
  }
  const toIndex = trimmed.indexOf(" --to ");
  const messageIndex = trimmed.indexOf(" --message ");
  if (toIndex <= 0 || messageIndex <= toIndex) return { error: "Usage: /goal todo handoff <refs> --to zpeer:@alias|zteam:<id> --message <maintainer instructions>" };
  const refsText = trimmed.slice(0, toIndex).trim();
  if (/\s/.test(refsText) && !/[;,]/.test(refsText)) return { error: "Ambiguous batch syntax: separate multiple TODO refs with commas or semicolons, e.g. /goal todo handoff 1,2 --to zteam:core --message ..." };
  const targetText = trimmed.slice(toIndex + " --to ".length, messageIndex).trim();
  const body = trimmed.slice(messageIndex + " --message ".length).trim();
  const refs = refsText.split(/[;,]/).map((ref) => ref.trim()).filter(Boolean);
  if (refs.length === 0) return { error: "handoff requires at least one TODO ref." };
  if (!body) return { error: "handoff requires --message <maintainer instructions>; raw message is transient and only sha256 is persisted." };
  const targetMatch = targetText.match(/^(zpeer|zteam):(.+)$/i);
  if (!targetMatch) return { error: "handoff target must be explicit: --to zpeer:@alias or --to zteam:<id>." };
  return {
    input: {
      todo_refs: refs.map((ref) => {
        const adapted = adaptLegacyHandoffGoalTodoReference(ref);
        return { todo_id: adapted.todoId, todo_path: adapted.todoPath };
      }),
      target_type: targetMatch[1].toLowerCase() as "zpeer" | "zteam",
      target: targetMatch[2].trim(),
      custom_message: body,
    },
  };
}

export type HandoffLiveDeliveryTarget = { alias: string; roomId: string; targetHash: string; memberId?: string };
export type HandoffLiveDeliveryAttempt = { targetHash: string; targetAliasHash: string; roomIdHash: string; memberIdHash?: string; attempted: true; status: ZpeerSendResult["status"]; succeeded: boolean; msgId?: string; taskHash?: string; outputHash?: string; reasonHash?: string; bodyStored: false };
export type HandoffLiveDeliveryResult = { liveDeliveryAttempted: true; deliveryPreparedOnly: false; deliverySucceeded: boolean; attempted: number; succeeded: number; failed: number; messageIds: string[]; targetHashes: string[]; attempts: HandoffLiveDeliveryAttempt[]; bodyStored: false };

export type HandoffGoalTodoResult = { goalId: string; runId: string; nodes: GoalTodoNode[]; instructionHash: string; goalRoomMessageIds: string[]; targetHash: string; targetType: "zpeer" | "zteam"; compatibilityWarnings: string[]; delivery: HandoffLiveDeliveryResult; deliveryPreparedOnly: false };

export type CanonicalHandoffGoalTodoPreflight = {
  goalId: string;
  runId: string;
  nodes: GoalTodoNode[];
  canonicalTodoIds: string[];
  normalizedTarget: string;
  canonicalTargetHash: string;
  targetRoomHashes: string[];
  instructionHash: string;
  delegationDepth: number;
  sender: string;
  teamName: string;
  compatibilityWarnings: string[];
  input: HandoffGoalTodoInput;
};

export type ValidatedHandoffGoalTodoPreflight = CanonicalHandoffGoalTodoPreflight & {
  nodes: GoalTodoNode[];
  target: ReturnType<typeof validateHandoffTarget>;
  teamDefinition: NonNullable<ReturnType<typeof loadTeamDefinition>["definition"]>;
  deliveryTargets: HandoffLiveDeliveryTarget[];
};

function handoffGoalRoomInput(preflight: CanonicalHandoffGoalTodoPreflight, node: GoalTodoNode): GoalRoomMessageInput {
  return {
    goal_id: preflight.goalId,
    run_id: preflight.runId,
    todo_id: node.id,
    sender: preflight.sender,
    audience: preflight.input.target_type === "zteam" ? "all" : "worker",
    kind: "HANDOFF",
    priority: node.priority,
    body_hash: preflight.instructionHash,
    task_id: node.id,
    requires_parent_action: true,
    metadata: {
      schema: "zob.goal-todo-handoff.v1",
      handoffRunId: preflight.runId,
      targetType: preflight.input.target_type,
      targetHash: preflight.canonicalTargetHash,
      targetRoomHash: preflight.input.target_room ? sha256(preflight.input.target_room) : undefined,
      todoPath: node.path,
      batchSize: preflight.nodes.length,
      instructionHash: preflight.instructionHash,
      canonicalGoalRoomPrepared: true,
      liveDeliveryRequired: true,
      liveDeliveryAttempted: false,
      deliveryPreparedOnly: false,
      bodyStored: false,
    },
  };
}

/** Canonicalize caller identity without requiring the TODOs to remain delegatable on exact replay. */
export function canonicalizeHandoffGoalTodos(state: HarnessRuntimeState, input: HandoffGoalTodoInput, guard?: GoalMutationPublicGuard): CanonicalHandoffGoalTodoPreflight {
  const goalId = currentGoalId(state, input.goal_id);
  const { references, compatibilityWarnings } = collectHandoffCanonicalTodoRefs(input);
  if (references.length === 0) throw new Error("handoff_goal_todo requires todo_id and/or todo_path, or todo_refs canonical objects; deprecated todo_ids/raw todo_refs remain compatibility-only.");
  if (!input.custom_message.trim()) throw new Error("handoff_goal_todo requires a maintainer-authored custom_message body; raw body is transient and only its sha256 is persisted.");
  if (input.append_goal_room === false) throw new Error("handoff_goal_todo requires canonical hash-only Goal Room metadata; append_goal_room=false is not allowed for live TODO handoff.");
  const runId = input.run_id?.trim() || (guard ? `handoff_${sha256(guard.mutationId).slice(0, 24)}` : newRunId("handoff"));
  if (safeFileStem(runId) !== runId) throw new Error(`handoff run_id must be path-safe: ${runId}`);
  const normalizedTarget = input.target.replace(/^@+/, "").trim();
  if (!normalizedTarget) throw new Error("handoff target is required and must be explicit");
  const resolution = resolveCanonicalGoalTodoReferences(state.goalTodos, goalId, references);
  if (resolution.code !== "resolved") throwGoalTodoReferenceResolution("handoff TODO refs", resolution);
  const nodes = resolution.nodes;
  const delegationDepth = Math.max(1, Math.trunc(input.delegation_depth ?? 1));
  if (!Number.isSafeInteger(delegationDepth)) throw new Error("handoff delegation_depth must resolve to a positive safe integer");
  return {
    goalId,
    runId,
    nodes,
    canonicalTodoIds: nodes.map((node) => node.id).sort(),
    normalizedTarget,
    canonicalTargetHash: sha256(`${input.target_type}:${normalizedTarget}`),
    targetRoomHashes: input.target_room ? [sha256(input.target_room)] : [],
    instructionHash: sha256(input.custom_message),
    delegationDepth,
    sender: input.sender ?? "parent",
    teamName: input.goal_room_team ?? "zob-core",
    compatibilityWarnings,
    input,
  };
}

/** Complete all local TODO policy, target, sender, team, and delivery resolution checks without writes. */
export function validateCanonicalHandoffGoalTodos(state: HarnessRuntimeState, repoRoot: string, preflight: CanonicalHandoffGoalTodoPreflight): ValidatedHandoffGoalTodoPreflight {
  const currentResolution = resolveCanonicalGoalTodoReferences(state.goalTodos, preflight.goalId, preflight.nodes.map((node) => ({ todoId: node.id, todoPath: node.path })));
  if (currentResolution.code !== "resolved") throwGoalTodoReferenceResolution("handoff TODO refs", currentResolution);
  const nodes = currentResolution.nodes;
  for (const node of nodes) authorizeGoalTodoTransition(node, "queue_delegation");
  if (preflight.delegationDepth > state.goalTodos.policy.maxDelegationDepth) {
    throw new Error(`handoff delegation depth ${preflight.delegationDepth} exceeds max ${state.goalTodos.policy.maxDelegationDepth}`);
  }
  const target = validateHandoffTarget(repoRoot, preflight.input);
  if (target.errors.length > 0) throw new Error(`handoff target blocked:\n- ${target.errors.join("\n- ")}`);
  if (target.targetHash !== preflight.canonicalTargetHash) throw new Error("handoff target changed during canonical preflight");

  const team = loadTeamDefinition(repoRoot, preflight.teamName);
  const teamErrors = [...team.errors, ...validateTeamDefinition(repoRoot, team.definition)];
  if (teamErrors.length > 0 || !team.definition) throw new Error(`Goal Room handoff metadata blocked:\n- ${teamErrors.join("\n- ")}`);
  const messageErrors = nodes.flatMap((node) => validateGoalRoomMessageInput(repoRoot, team.definition!, handoffGoalRoomInput({ ...preflight, nodes }, node)));
  if (messageErrors.length > 0) throw new Error(`Goal Room handoff metadata blocked:\n- ${messageErrors.join("\n- ")}`);

  if (!state.zobLive.peerCard) throw new Error("handoff live delivery blocked: current session has not registered a local ZPeer endpoint");
  const selfRoomId = safeZpeerRoomId(preflight.input.target_room) ?? activeZpeerRoomId(state.zobLive.peerCard);
  const deliveryTargets = preflight.input.target_type === "zpeer"
    ? [resolveZpeerHandoffTarget(repoRoot, preflight.input, selfRoomId)].filter((target): target is HandoffLiveDeliveryTarget => Boolean(target))
    : resolveZteamHandoffTargets(repoRoot, preflight.input, selfRoomId);
  if (deliveryTargets.length === 0) throw new Error(`handoff live delivery blocked: no resolvable live ${preflight.input.target_type} target`);
  return { ...preflight, nodes, target, teamDefinition: team.definition, deliveryTargets };
}

export function zteamMemberId(member: ZTeamMemberManifest | ZTeamAgentManifest): string {
  return "zagentId" in member ? member.zagentId : member.id;
}

export function zteamMemberRoom(member: ZTeamMemberManifest | ZTeamAgentManifest, fallbackRoomId: string): string {
  return safeZpeerRoomId(member.room) ?? fallbackRoomId;
}

export function resolveZpeerHandoffTarget(repoRoot: string, input: HandoffGoalTodoInput, selfRoomId: string): HandoffLiveDeliveryTarget | undefined {
  const target = input.target.replace(/^@+/, "").trim();
  const roomId = safeZpeerRoomId(input.target_room) ?? selfRoomId;
  const registry = readZobLiveRegistrySnapshot(repoRoot);
  const match = registry.peers.find((peer) => peer.status === "online" && peer.transport === "local_socket" && !peer.endpoint.startsWith("pending-") && (peer.roleId === target || peerAliases(peer, roomId).includes(target)));
  const alias = match ? peerAliasInRoom(match, roomId) ?? peerAliases(match, roomId)[0] : undefined;
  return alias ? { alias, roomId, targetHash: sha256(`zpeer:${target}`) } : undefined;
}

export function resolveZteamHandoffTargets(repoRoot: string, input: HandoffGoalTodoInput, selfRoomId: string): HandoffLiveDeliveryTarget[] {
  const target = input.target.replace(/^@+/, "").trim();
  const loaded = loadZteamManifest(repoRoot, target);
  if (loaded.errors.length > 0) throw new Error(`zteam handoff target blocked:\n- ${loaded.errors.join("\n- ")}`);
  const registry = readZobLiveRegistrySnapshot(repoRoot);
  const members = [...(loaded.manifest.members ?? []), ...(loaded.manifest.agents ?? [])];
  const resolved: HandoffLiveDeliveryTarget[] = [];
  const blockers: string[] = [];
  for (const member of members) {
    const memberId = zteamMemberId(member);
    const roomId = zteamMemberRoom(member, safeZpeerRoomId(input.target_room) ?? selfRoomId);
    const explicitAlias = typeof member.alias === "string" ? member.alias.replace(/^@+/, "") : undefined;
    const peer = registry.peers.find((candidate) => candidate.status === "online" && candidate.transport === "local_socket" && !candidate.endpoint.startsWith("pending-") && (candidate.roleId === memberId || candidate.agent === memberId || (explicitAlias ? peerAliases(candidate, roomId).includes(explicitAlias) : false)));
    const alias = peer ? explicitAlias ?? peerAliasInRoom(peer, roomId) ?? peerAliases(peer, roomId)[0] : undefined;
    if (!alias) {
      blockers.push(explicitAlias ? `${memberId}/@${explicitAlias}` : memberId);
      continue;
    }
    resolved.push({ alias, roomId, memberId, targetHash: sha256(`zteam:${target}:${memberId}:${alias}:${roomId}`) });
  }
  if (blockers.length > 0) throw new Error(`zteam '${target}' has no resolvable online local_socket alias for member(s): ${blockers.join(", ")}`);
  if (resolved.length === 0) throw new Error(`zteam '${target}' has no resolvable live members`);
  return resolved;
}

export async function deliverHandoffLive(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, input: HandoffGoalTodoInput, runId: string, prevalidatedTargets?: HandoffLiveDeliveryTarget[]): Promise<HandoffLiveDeliveryResult> {
  if (!state.zobLive.peerCard) throw new Error("handoff live delivery blocked: current session has not registered a local ZPeer endpoint");
  const self = refreshZpeerSelf(repoRoot, state.zobLive.peerCard);
  state.zobLive.peerCard = self;
  const selfRoomId = safeZpeerRoomId(input.target_room) ?? activeZpeerRoomId(self);
  const targets = prevalidatedTargets ?? (input.target_type === "zpeer"
    ? [resolveZpeerHandoffTarget(repoRoot, input, selfRoomId)].filter((target): target is HandoffLiveDeliveryTarget => Boolean(target))
    : resolveZteamHandoffTargets(repoRoot, input, selfRoomId));
  if (targets.length === 0) throw new Error(`handoff live delivery blocked: no resolvable live ${input.target_type} target`);
  const attempts: HandoffLiveDeliveryAttempt[] = [];
  for (const target of targets) {
    const result = await sendZpeerPrompt(repoRoot, self, target.alias, input.custom_message, (msgId) => state.zobLive.pendingReplies.wait(msgId, 25), { mode: "async", roomId: target.roomId });
    const succeeded = result.status === "waiting" || result.status === "delivered" || result.status === "reply" || result.status === "completed";
    attempts.push({
      targetHash: target.targetHash,
      targetAliasHash: sha256(target.alias),
      roomIdHash: sha256(result.roomId ?? target.roomId),
      memberIdHash: target.memberId ? sha256(target.memberId) : undefined,
      attempted: true,
      status: result.status,
      succeeded,
      msgId: result.msgId,
      taskHash: result.taskHash,
      outputHash: result.outputHash,
      reasonHash: result.reason ? sha256(result.reason) : undefined,
      bodyStored: false,
    });
  }
  const failed = attempts.filter((attempt) => !attempt.succeeded).length;
  const delivery: HandoffLiveDeliveryResult = {
    liveDeliveryAttempted: true,
    deliveryPreparedOnly: false,
    deliverySucceeded: failed === 0,
    attempted: attempts.length,
    succeeded: attempts.length - failed,
    failed,
    messageIds: attempts.map((attempt) => attempt.msgId).filter((msgId): msgId is string => typeof msgId === "string"),
    targetHashes: attempts.map((attempt) => attempt.targetHash),
    attempts,
    bodyStored: false,
  };
  pi.appendEntry("zob-goal-todo-handoff-delivery", { schema: "zob.goal-todo-handoff-delivery.v1", runId, targetType: input.target_type, instructionHash: sha256(input.custom_message), ...delivery, promptBodiesStored: false, outputBodiesStored: false });
  if (!delivery.deliverySucceeded) throw new Error(`handoff live delivery failed: ${delivery.failed}/${delivery.attempted} target(s) did not ACK`);
  return delivery;
}

export interface HandoffGoalTodoEffectOverrides {
  appendGoalRoomMessage?: typeof appendGoalRoomMessage;
  deliverHandoffLive?: typeof deliverHandoffLive;
}

export async function executeHandoffGoalTodoEffects(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, preflight: ValidatedHandoffGoalTodoPreflight, source: "tool" | "command", overrides: HandoffGoalTodoEffectOverrides = {}): Promise<HandoffGoalTodoResult> {
  const { goalId, runId, nodes, input, target, instructionHash, delegationDepth } = preflight;
  const appendGoalRoom = overrides.appendGoalRoomMessage ?? appendGoalRoomMessage;
  const deliverLive = overrides.deliverHandoffLive ?? deliverHandoffLive;
  const goalRoomMessageIds: string[] = [];
  for (const node of nodes) {
    const message = appendGoalRoom(repoRoot, preflight.teamDefinition, handoffGoalRoomInput(preflight, node));
    if (typeof message.msgId === "string") goalRoomMessageIds.push(message.msgId);
  }

  const linked = nodes.map((node) => linkGoalTodoDelegation(pi, state, goalId, node.id, {
    runId,
    agent: `${input.target_type}:${target.deliveryTarget}`,
    requestId: `handoff:${runId}:${node.id}`,
    delegationDepth,
    status: "queued",
  }, source)).filter((node): node is GoalTodoNode => Boolean(node));

  let delivery: HandoffLiveDeliveryResult;
  try {
    delivery = await deliverLive(pi, state, repoRoot, input, runId, preflight.deliveryTargets);
  } catch (error) {
    const failureHash = sha256(error instanceof Error ? error.message : String(error));
    let delegationFailureMarked = 0;
    let delegationFailureMarkFailed = 0;
    for (const node of linked) {
      try {
        markGoalTodoDelegationFailed(pi, state, goalId, node.id, {
          runId,
          requestId: `handoff:${runId}:${node.id}`,
          failureHash,
        }, source);
        delegationFailureMarked += 1;
      } catch {
        delegationFailureMarkFailed += 1;
      }
    }
    pi.appendEntry("zob-goal-todo-handoff", {
      schema: "zob.goal-todo-handoff-result.v1",
      source,
      goalId,
      runId,
      todoIds: linked.map((node) => node.id),
      todoPaths: linked.map((node) => node.path),
      targetType: input.target_type,
      targetHash: target.targetHash,
      targetRoomHash: input.target_room ? sha256(input.target_room) : undefined,
      instructionHash,
      goalRoomMessageIds,
      canonicalGoalRoomPrepared: true,
      liveDeliveryAttempted: true,
      deliveryPreparedOnly: false,
      deliverySucceeded: false,
      delegationFailureMarked,
      delegationFailureMarkFailed,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
      failureHash,
    });
    throw error;
  }

  pi.appendEntry("zob-goal-todo-handoff", {
    schema: "zob.goal-todo-handoff-result.v1",
    source,
    goalId,
    runId,
    todoIds: linked.map((node) => node.id),
    todoPaths: linked.map((node) => node.path),
    targetType: input.target_type,
    targetHash: target.targetHash,
    targetRoomHash: input.target_room ? sha256(input.target_room) : undefined,
    instructionHash,
    goalRoomMessageIds,
    liveDeliveryAttempted: true,
    deliveryPreparedOnly: false,
    deliverySucceeded: delivery.deliverySucceeded,
    deliveryAttempted: delivery.attempted,
    deliverySucceededCount: delivery.succeeded,
    deliveryFailed: delivery.failed,
    deliveryMessageIdHashes: delivery.messageIds.map((msgId) => sha256(msgId)),
    deliveryTargetHashes: delivery.targetHashes,
    deliveryAttempts: delivery.attempts,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  });

  return { goalId, runId, nodes: linked, instructionHash, goalRoomMessageIds, targetHash: target.targetHash, targetType: input.target_type, compatibilityWarnings: [...preflight.compatibilityWarnings], delivery, deliveryPreparedOnly: false };
}

export async function handoffGoalTodos(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, input: HandoffGoalTodoInput, source: "tool" | "command"): Promise<HandoffGoalTodoResult> {
  const canonical = canonicalizeHandoffGoalTodos(state, input);
  const validated = validateCanonicalHandoffGoalTodos(state, repoRoot, canonical);
  return executeHandoffGoalTodoEffects(pi, state, repoRoot, validated, source);
}

export function goalTodoStatusIcon(status: GoalTodoStatus): string {
  if (status === "done") return "✓";
  if (status === "skipped") return "↷";
  if (status === "blocked") return "▲";
  if (status === "delegated") return "⇄";
  if (status === "claim_returned" || status === "needs_review" || status === "needs_oracle") return "◆";
  if (status === "in_progress") return "●";
  return "○";
}

export function formatGoalTodoChangedLine(node: GoalTodoNode): string {
  const required = node.required ? "req" : "opt";
  return `${goalTodoStatusIcon(node.status)} ${node.path} ${node.title} [${node.status}/${node.owner}/${required}/${node.priority}]`;
}

export function formatGoalTodoCompactSummary(summary: GoalTodoSummary): string {
  const closed = summary.done + summary.skipped;
  return `todos ${closed}/${summary.total} · open ${summary.open} · active ${summary.active} · blocked ${summary.blocked} · deleg ${summary.delegated} · claims ${summary.claimReturned}`;
}

export function formatGoalTodoNextLine(summary: GoalTodoSummary): string | undefined {
  if (summary.nextAgent) return `next agent ${summary.nextAgent.path}: ${summary.nextAgent.title}`;
  if (summary.nextUser) return `next user ${summary.nextUser.path}: ${summary.nextUser.title}`;
  return undefined;
}

export function compactGoalTodoHeadline(headline: string, changedCount: number): string {
  return headline
    .replace(/^added (\d+) goal TODO\(s\)$/, "todo +$1")
    .replace(/^added 1 goal TODO$/, "todo +1")
    .replace(/^updated goal TODO .*: (\S+)$/, "todo update $1")
    .replace(/^completed goal TODO .*$/, "todo done")
    .replace(/^skipped goal TODO .*$/, "todo skipped")
    .replace(/^split goal TODO .* into (\d+) child TODO\(s\)$/, "todo split +$1")
    .replace(/^imported (\d+) .* TODO node\(s\).*$/, "todo import +$1")
    || `todo change +${changedCount}`;
}

export function formatGoalTodoToolResult(goalId: string, headline: string, summary: GoalTodoSummary, changedNodes: GoalTodoNode[] = []): string {
  const shownNodes = changedNodes.slice(0, 4).map(formatGoalTodoChangedLine);
  const hiddenCount = Math.max(0, changedNodes.length - shownNodes.length);
  const changed = shownNodes.length > 0 ? `changed ${shownNodes.join(" · ")}${hiddenCount > 0 ? ` · +${hiddenCount} more` : ""}` : undefined;
  const next = formatGoalTodoNextLine(summary);
  return [
    `${compactGoalTodoHeadline(headline, changedNodes.length)} · ${formatGoalTodoCompactSummary(summary)}`,
    changed,
    `${next ?? "next none"} · tree /goal todo tree · goal ${goalId.slice(0, 8)}`,
  ].filter((line): line is string => typeof line === "string" && line.length > 0).join("\n");
}

export function renderGoalTodoResultText(result: unknown): string {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  return isRecord(first) && typeof first.text === "string" ? first.text : "goal TODO updated";
}

function formatHandoffGoalTodoSuccess(state: HarnessRuntimeState, result: HandoffGoalTodoResult, cas?: Record<string, unknown>): GoalTodoMutationToolResult {
  const summary = summarizeGoalTodos(state.goalTodos, result.goalId);
  return {
    content: [{ type: "text", text: formatGoalTodoToolResult(result.goalId, `handoff delivered ${result.nodes.length} goal TODO(s); run=${result.runId}; target=${result.targetType}; instructionHash=${result.instructionHash.slice(0, 12)}; liveDeliveryAttempted=${result.delivery.liveDeliveryAttempted}; deliverySucceeded=${result.delivery.deliverySucceeded}; bodyStored=false`, summary, result.nodes) }],
    details: { schema: "zob.goal-todo-handoff-result.v1", ...result, canonical_refs: result.nodes.map((node) => ({ todo_id: node.id, todo_path: node.path, todo_revision: node.revision ?? 0 })), revisions: { graph_revision: state.goalTodos.graphRevisions?.[result.goalId] ?? 0 }, summary, liveDeliveryAttempted: true, deliverySucceeded: result.delivery.deliverySucceeded, deliveryPreparedOnly: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, ...(cas ? { cas } : {}) },
  };
}

export async function executeHandoffGoalTodoTool(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, input: HandoffGoalTodoInput): Promise<GoalTodoMutationToolResult> {
  const guard = input.cas === undefined ? undefined : parseOptionalGoalMutationGuard(input.cas);
  state.goalTodos.mutationReceipts ??= createGoalMutationReceiptState();
  let validated: ValidatedHandoffGoalTodoPreflight | undefined;
  const execution = await executeGoalHandoffCas({
    guard,
    receipts: state.goalTodos.mutationReceipts,
    restoreBlocked: Boolean(state.goalTodos.restoreBlocked?.[currentGoalId(state, input.goal_id)]),
    preflight: () => {
      const canonical = canonicalizeHandoffGoalTodos(state, input, guard);
      const graphRevisionBefore = state.goalTodos.graphRevisions?.[canonical.goalId] ?? 0;
      const goalRevision = state.runtimeGoal?.goalId === canonical.goalId ? state.runtimeGoal.revision : undefined;
      const singleTodo = canonical.canonicalTodoIds.length === 1
        ? state.goalTodos.nodes.find((node) => node.goalId === canonical.goalId && node.id === canonical.canonicalTodoIds[0])
        : undefined;
      return {
        goalId: canonical.goalId,
        canonicalTodoIds: canonical.canonicalTodoIds,
        runId: canonical.runId,
        targetType: canonical.input.target_type,
        canonicalTargetHash: canonical.canonicalTargetHash,
        targetHashes: [canonical.canonicalTargetHash],
        targetRoomHashes: canonical.targetRoomHashes,
        instructionHash: canonical.instructionHash,
        delegationDepth: canonical.delegationDepth,
        senderHash: sha256(canonical.sender),
        goalRoomTeamHash: sha256(canonical.teamName),
        current: {
          ...(goalRevision !== undefined ? { goalRevision } : {}),
          graphRevision: graphRevisionBefore,
          ...(singleTodo?.revision !== undefined ? { todoRevisions: { [singleTodo.id]: singleTodo.revision } } : {}),
        },
        beforeApply: () => {
          validated = validateCanonicalHandoffGoalTodos(state, repoRoot, canonical);
        },
        apply: async () => {
          if (!validated) throw new Error("handoff local preflight was not completed");
          const result = await executeHandoffGoalTodoEffects(pi, state, repoRoot, validated, "tool");
          const graphRevision = state.goalTodos.graphRevisions?.[canonical.goalId] ?? graphRevisionBefore;
          const singleTodoAfter = singleTodo
            ? state.goalTodos.nodes.find((node) => node.goalId === canonical.goalId && node.id === singleTodo.id)
            : undefined;
          return {
            result,
            appliedRevisions: {
              ...(goalRevision !== undefined ? { goalRevision } : {}),
              graphRevision,
              ...(singleTodoAfter?.revision !== undefined ? { todoRevision: singleTodoAfter.revision } : {}),
            },
            eventCount: graphRevision - graphRevisionBefore,
          };
        },
      };
    },
    persistPreparation: (preparation) => pi.appendEntry(GOAL_MUTATION_PREPARATION_ENTRY_TYPE, preparation),
    persistReceipt: (receipt) => pi.appendEntry(GOAL_MUTATION_RECEIPT_ENTRY_TYPE, receipt),
  });

  const { outcome, preflight } = execution;
  if (outcome.status === "observed") return formatHandoffGoalTodoSuccess(state, outcome.result);
  if (outcome.status === "applied") {
    return formatHandoffGoalTodoSuccess(state, outcome.result, { status: outcome.status, mutationId: outcome.mutationId, requestHash: outcome.requestHash, receipt: outcome.receipt, bodyStored: false });
  }
  if (outcome.status === "replayed") {
    const replayResolution = resolveCanonicalGoalTodoReferences(state.goalTodos, preflight.goalId, preflight.canonicalTodoIds.map((todoId) => ({ todoId })));
    if (replayResolution.code !== "resolved") throwGoalTodoReferenceResolution("handoff TODO replay refs", replayResolution);
    const { compatibilityWarnings } = collectHandoffCanonicalTodoRefs(input);
    return {
      content: [{ type: "text", text: `goal TODO handoff replayed: mutation_id=${outcome.mutationId} request_hash=${outcome.requestHash} event_count=${outcome.receipt.eventCount}` }],
      details: {
        schema: "zob.goal-todo-handoff-result.v1",
        goalId: preflight.goalId,
        runId: preflight.runId,
        todoIds: [...preflight.canonicalTodoIds],
        canonical_refs: replayResolution.nodes.map((node) => ({ todo_id: node.id, todo_path: node.path, todo_revision: node.revision ?? 0 })),
        revisions: { graph_revision: state.goalTodos.graphRevisions?.[preflight.goalId] ?? 0 },
        compatibilityWarnings,
        targetType: preflight.targetType,
        targetHash: preflight.canonicalTargetHash,
        liveDeliveryAttempted: false,
        deliverySucceeded: true,
        deliveryPreparedOnly: false,
        bodyStored: false,
        promptBodiesStored: false,
        outputBodiesStored: false,
        cas: { status: outcome.status, mutationId: outcome.mutationId, requestHash: outcome.requestHash, receipt: outcome.receipt, bodyStored: false },
      },
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `goal TODO handoff ${outcome.status}: ${outcome.failureCodes.join(",")} goal=${preflight.goalId} target=${preflight.canonicalTargetHash}${outcome.mutationId ? ` mutation_id=${outcome.mutationId}` : ""}${outcome.requestHash ? ` request_hash=${outcome.requestHash}` : ""}` }],
    details: { goalId: preflight.goalId, resolvedTargetId: `handoff:${preflight.canonicalTargetHash}`, cas: { status: outcome.status, failureCodes: outcome.failureCodes, diagnostic: outcome.diagnostic, bodyStored: false } },
  };
}

export function registerGoalRuntimeTools(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerTool({
    name: "get_goal",
    label: "Get ZOB Goal",
    description: "Get the current ZOB runtime goal, gate, oracle, and usage state.",
    promptSnippet: "Inspect the current ZOB runtime goal and oracle gate.",
    parameters: EmptyParams,
    async execute() {
      const goal = state.runtimeGoal;
      const todoSummary = goal ? formatGoalTodoSummary(summarizeGoalTodos(state.goalTodos, goal.goalId)) : undefined;
      const freshness = currentCompletionProposalFreshness(state, goal);
      const oracleFreshness = currentOracleFreshness(state, goal);
      return {
        content: [{ type: "text", text: formatRuntimeGoalSummary(goal, state.goalActivationMode, todoSummary, freshness, oracleFreshness) }],
        details: {
          goal: publicRuntimeGoal(goal),
          goalActivationMode: state.goalActivationMode ?? DEFAULT_GOAL_ACTIVATION_MODE,
          goalTodos: goal ? summarizeGoalTodos(state.goalTodos, goal.goalId) : undefined,
          ...completionProposalReadDetails(state, goal, freshness),
        },
      };
    },
  });

  pi.registerTool({
    name: "get_goal_todos",
    label: "Get Goal TODOs",
    description: "Get the TODO tree attached to the current ZOB runtime goal.",
    promptSnippet: "Inspect /goal-linked TODO progress before deciding next action or completion.",
    parameters: GetGoalTodosParams,
    async execute(_toolCallId, params) {
      const goalId = currentGoalId(state, params.goal_id);
      const hasReference = params.todo_id !== undefined || params.todo_path !== undefined;
      const target = hasReference ? resolvePublicGoalTodoTarget(state, goalId, params, "get_goal_todos reference") : undefined;
      const summary = summarizeGoalTodos(state.goalTodos, goalId);
      const diagnostics = goalTodoCompletionDiagnostics(state.goalTodos, goalId);
      const goal = state.runtimeGoal?.goalId === goalId ? state.runtimeGoal : undefined;
      const freshness = currentCompletionProposalFreshness(state, goal);
      const nodes = target ? [target.node] : state.goalTodos.nodes.filter((node) => node.goalId === goalId);
      return {
        content: [{ type: "text", text: `${formatGoalTodoTree(state.goalTodos, goalId)}\n${formatRuntimeGoalCompletionProposal(goal?.completionProposal, freshness)}` }],
        details: {
          goalId,
          graphRevision: state.goalTodos.graphRevisions?.[goalId] ?? 0,
          revisionDiagnostics: (state.goalTodos.revisionDiagnostics ?? []).filter((diagnostic) => diagnostic.goalId === goalId).map((diagnostic) => ({ ...diagnostic })),
          restoreBlocked: state.goalTodos.restoreBlocked?.[goalId] ? { ...state.goalTodos.restoreBlocked[goalId] } : undefined,
          summary,
          diagnostics,
          completion_ready: diagnostics.completionReady,
          hard_no_ship: diagnostics.hardNoShip,
          review_no_ship: diagnostics.reviewNoShip,
          effective_no_ship: diagnostics.effectiveNoShip,
          completion_blockers: diagnostics.completionBlockers,
          next_valid_actions: diagnostics.nextValidActions,
          nodes,
          ...completionProposalReadDetails(state, goal, freshness),
          ...(target ? canonicalGoalTodoResultDetails(state, goalId, target.node) : {}),
          policy: state.goalTodos.policy,
        },
      };
    },
  });

  pi.registerTool({
    name: "handoff_goal_todo",
    label: "Handoff Goal TODO",
    description: "Deliver an explicit single/batch Goal TODO handoff using strict canonical todo_id/todo_path object refs. Deprecated raw batch refs pass only through a named compatibility adapter. Live delivery remains hash-only and never completes TODOs.",
    promptSnippet: "Use for explicit TODO handoff only after resolving active TODO refs and an explicit online target; raw custom_message is transient and durable records are hash-only.",
    promptGuidelines: [
      "Do not use this as completion evidence: it queues/delegates handoff only and never marks TODOs done.",
      "target_type/target must be explicit; stale/offline/ambiguous targets block.",
      "custom_message is required and stored only as instructionHash/body_hash in durable metadata.",
    ],
    parameters: HandoffGoalTodoParams,
    renderCall(args, theme) {
      const count = [(args.todo_id || args.todo_path) ? 1 : undefined, ...(args.todo_ids ?? []), ...(args.todo_refs ?? [])].filter(Boolean).length;
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `handoff ${count || 1} → ${args.target_type}:${args.target}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeHandoffGoalTodoTool(pi, state, ctx.cwd, params as HandoffGoalTodoInput);
    },
  });

  pi.registerTool({
    name: "add_goal_todo",
    label: "Add Goal TODO",
    description: "Add a TODO node to the active ZOB runtime goal. TODOs are parent-owned and block completion when required=true.",
    promptSnippet: "Add one bounded /goal TODO; prefer add_goal_todos for multi-item plans to avoid repeated tool calls.",
    parameters: AddGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `+1 ${args.title}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params) {
      const goalId = currentGoalId(state);
      const parentTarget = params.parent_id ? resolvePublicGoalTodoTarget(state, goalId, { todo_id: params.parent_id }, "Parent TODO reference") : undefined;
      const resolvedTargetId = parentTarget?.canonicalId ?? goalId;
      return executeGoalTodoMutation(pi, state, {
        toolName: "add_goal_todo",
        goalId,
        resolvedTargetId,
        payload: goalMutationPayload(params),
        cas: params.cas,
        apply: () => {
          const node = addGoalTodo(pi, state, goalId, {
            title: params.title,
            parentId: params.parent_id,
            owner: params.owner as GoalTodoOwner | undefined,
            required: params.required,
            priority: params.priority as GoalTodoPriority | undefined,
            status: params.status as GoalTodoStatus | undefined,
            acceptanceCriteria: params.acceptance_criteria,
            evidenceRefs: params.evidence_refs,
            validationCommands: params.validation_commands,
          }, "tool");
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `added 1 goal TODO`, summary, [node]) }], details: { goalId, node, summary } };
        },
      });
    },
  });

  pi.registerTool({
    name: "add_goal_todos",
    label: "Add Goal TODOs",
    description: "Add multiple TODO nodes to the active ZOB runtime goal in one compact tool call. Prefer this for initial TODO plans.",
    promptSnippet: "Batch-create bounded /goal TODO plans; avoid repeated add_goal_todo calls and avoid full-tree spam.",
    parameters: AddGoalTodosParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todos"))} ${theme.fg("accent", `+${args.todos.length}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params) {
      const goalId = currentGoalId(state, params.goal_id);
      for (const item of params.todos) {
        if (item.parent_id) resolvePublicGoalTodoTarget(state, goalId, { todo_id: item.parent_id }, "Parent TODO reference");
      }
      return executeGoalTodoMutation(pi, state, {
        toolName: "add_goal_todos",
        goalId,
        resolvedTargetId: goalId,
        payload: batchGoalTodoMutationPayload(params),
        cas: params.cas,
        apply: () => {
          if (!Array.isArray(params.todos) || params.todos.length === 0) throw new Error("add_goal_todos requires at least one TODO item.");
          if (params.todos.length > state.goalTodos.policy.maxOpenTodos) throw new Error(`add_goal_todos exceeds maxOpenTodos=${state.goalTodos.policy.maxOpenTodos}`);
          const parentAdds = new Map<string | undefined, number>();
          for (const item of params.todos) {
            if (!item.title?.trim()) throw new Error("Each TODO item requires a non-empty title.");
            const parentId = item.parent_id;
            const parent = parentId ? state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === parentId) : undefined;
            if (parentId && !parent) throw new Error(`Parent TODO not found: ${parentId}`);
            if (parent && parent.depth + 1 > state.goalTodos.policy.maxTodoDepth) throw new Error(`Goal TODO depth exceeds maxTodoDepth=${state.goalTodos.policy.maxTodoDepth}.`);
            parentAdds.set(parentId, (parentAdds.get(parentId) ?? 0) + 1);
          }
          for (const [parentId, addedCount] of parentAdds) {
            if (!parentId) continue;
            const existingChildren = state.goalTodos.nodes.filter((node) => node.goalId === goalId && node.parentId === parentId).length;
            if (existingChildren + addedCount > state.goalTodos.policy.maxChildrenPerTodo) throw new Error(`batch would exceed maxChildrenPerTodo=${state.goalTodos.policy.maxChildrenPerTodo} for parent ${parentId}`);
          }
          const nodes = params.todos.map((item) => addGoalTodo(pi, state, goalId, {
            title: item.title,
            parentId: item.parent_id,
            owner: item.owner as GoalTodoOwner | undefined,
            required: item.required,
            priority: item.priority as GoalTodoPriority | undefined,
            status: item.status as GoalTodoStatus | undefined,
            acceptanceCriteria: item.acceptance_criteria,
            evidenceRefs: item.evidence_refs,
            validationCommands: item.validation_commands,
          }, "tool"));
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `added ${nodes.length} goal TODO(s)`, summary, nodes) }], details: { goalId, nodes, summary } };
        },
      });
    },
  });

  pi.registerTool({
    name: "update_goal_todo",
    label: "Update Goal TODO",
    description: "Update TODO metadata or an explicitly authorized ready/in_progress/needs_review/needs_oracle/needs_user intent. Delegation, claim, block, terminal, and recovery states require dedicated tools.",
    promptSnippet: "Update TODO metadata or safe status intent only; use resolve_goal_todo or claim/delegation tools for dedicated lifecycle transitions.",
    parameters: UpdateGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `update ${publicTodoRefLabel(args)}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params) {
      const goalId = currentGoalId(state);
      const target = resolvePublicGoalTodoTarget(state, goalId, params, "Goal TODO not found");
      return executeGoalTodoMutation(pi, state, {
        toolName: "update_goal_todo",
        goalId,
        resolvedTargetId: target.canonicalId,
        payload: canonicalGoalTodoMutationPayload(params, target.node),
        cas: params.cas,
        apply: () => {
          const node = updateGoalTodo(pi, state, goalId, target.canonicalId, {
            title: params.title,
            status: params.status as GoalTodoStatus | undefined,
            owner: params.owner as GoalTodoOwner | undefined,
            required: params.required,
            priority: params.priority as GoalTodoPriority | undefined,
            evidenceRefs: params.evidence_refs,
            validationCommands: params.validation_commands,
            contextScopeId: params.context_scope_id,
            contextPackRef: params.context_pack_ref,
            citations: params.citations,
            freshness: params.freshness,
            blocker: params.blocker,
          }, "tool");
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `updated goal TODO ${node.id} ${node.path}: ${node.status}`, summary, [node]) }], details: { ...canonicalGoalTodoResultDetails(state, goalId, node), summary } };
        },
      });
    },
  });

  pi.registerTool({
    name: "resolve_goal_todo",
    label: "Resolve Goal TODO",
    description: "Primary transition tool for /goal TODOs: auto, complete, accept_claim, reject_claim, block, skip, or reopen. Emits diagnostics-compatible state and preserves parent-owned claim acceptance.",
    promptSnippet: "Use resolve_goal_todo for TODO completion, skip, delegated claim acceptance/rejection, blocking, and reopening; do not use update_goal_todo for done/skipped.",
    promptGuidelines: [
      "Use action=auto for normal closure. Returned claims additionally require expected_auto_resolution=accept_claim, exact expected_claim_hash, and exact graph/TODO CAS revisions.",
      "Treat child no_ship as review evidence: inspect diagnostics and decide accept/reject/block; child no_ship alone is not a child runtime failure.",
      "Root goal completion still requires propose_goal_completion and oracle PASS/no_ship=false.",
    ],
    parameters: ResolveGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `resolve ${args.action} ${publicTodoRefLabel(args)}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state, params.goal_id);
      const target = resolvePublicGoalTodoTarget(state, goalId, params, "Goal TODO not found");
      const guard = publicGoalTodoCasGuard(params.cas);
      const payload = canonicalGoalTodoMutationPayload(params, target.node);
      const replay = isExactGoalTodoMutationReplay(state, goalId, "resolve_goal_todo", target.canonicalId, payload, guard);
      const returnedClaim = target.node.status === "claim_returned" || target.node.status === "needs_oracle" || target.node.delegation?.status === "claim_returned";
      if (!replay && params.action === "auto" && returnedClaim) requireAutomaticClaimBinding("resolve_goal_todo action=auto", state, goalId, target.node, params.expected_auto_resolution, params.expected_claim_hash, params.expected_attempt_id, params.expected_validation_policy, guard);
      if (!replay && params.action === "reject_claim" && !params.reason?.trim()) throw new Error("resolve_goal_todo action=reject_claim requires a non-empty reason");
      if (!replay && params.action === "accept_claim") requireExactClaimBinding("resolve_goal_todo action=accept_claim", state, goalId, target.node, { expectedClaimHash: params.expected_claim_hash, expectedAttemptId: params.expected_attempt_id, expectedValidationPolicy: params.expected_validation_policy, guard }, true);
      if (!replay && params.action === "reject_claim") requireExactClaimBinding("resolve_goal_todo action=reject_claim", state, goalId, target.node, { expectedClaimHash: params.expected_claim_hash, expectedAttemptId: params.expected_attempt_id, expectedValidationPolicy: params.expected_validation_policy, guard }, false);
      const claimHash = params.expected_claim_hash ?? target.node.claim?.claimHash;
      const casBound = hasExactTodoCasRevisions(guard);
      return executeGoalTodoMutation(pi, state, {
        toolName: "resolve_goal_todo",
        goalId,
        resolvedTargetId: target.canonicalId,
        payload,
        cas: params.cas,
        apply: () => {
          const node = resolveGoalTodo(pi, state, goalId, target.canonicalId, {
            action: params.action as ResolveGoalTodoAction,
            expectedAutoResolution: params.expected_auto_resolution,
            expectedClaimHash: params.expected_claim_hash,
            expectedAttemptId: params.expected_attempt_id,
            expectedValidationPolicy: params.expected_validation_policy,
            expectedGraphRevision: guard?.expectedGraphRevision,
            expectedTodoRevision: guard?.expectedTodoRevision,
            evidenceRefs: params.evidence_refs,
            validationCommands: params.validation_commands,
            reason: params.reason,
            repoRoot: ctx.cwd,
            casBound,
            userResolved: params.user_resolved,
          }, "tool");
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          const diagnostics = goalTodoCompletionDiagnostics(state.goalTodos, goalId);
          return { content: [{ type: "text", text: `${formatGoalTodoToolResult(goalId, `resolved goal TODO ${node.id} ${node.path}: ${node.status}`, summary, [node])}\ncompletion_ready=${diagnostics.completionReady} hard_no_ship=${diagnostics.hardNoShip} review_no_ship=${diagnostics.reviewNoShip} effective_no_ship=${diagnostics.effectiveNoShip}` }], details: { ...canonicalGoalTodoResultDetails(state, goalId, node, claimHash), summary, diagnostics } };
        },
      });
    },
  });

  pi.registerTool({
    name: "complete_goal_todo",
    label: "Complete Goal TODO",
    description: "Legacy done/skip compatibility alias. Returned-claim acceptance requires explicit accept_claim expectation, exact full claim hash, and exact graph/TODO CAS revisions. Root goal completion remains separately gated.",
    promptSnippet: "Prefer resolve_goal_todo; this explicit compatibility alias never auto-accepts an unversioned returned claim.",
    parameters: CompleteGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `${args.skipped ? "skip" : "done"} ${publicTodoRefLabel(args)}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state);
      const target = resolvePublicGoalTodoTarget(state, goalId, params, "Goal TODO not found");
      const guard = publicGoalTodoCasGuard(params.cas);
      const returnedClaim = params.skipped !== true && (target.node.status === "claim_returned" || target.node.status === "needs_oracle" || target.node.delegation?.status === "claim_returned");
      if (returnedClaim) requireAutomaticClaimBinding("complete_goal_todo compatibility adapter", state, goalId, target.node, params.expected_auto_resolution, params.expected_claim_hash, params.expected_attempt_id, params.expected_validation_policy, guard);
      const claimHash = params.expected_claim_hash ?? target.node.claim?.claimHash;
      return executeGoalTodoMutation(pi, state, {
        toolName: "complete_goal_todo",
        goalId,
        resolvedTargetId: target.canonicalId,
        payload: canonicalGoalTodoMutationPayload(params, target.node),
        cas: params.cas,
        apply: () => {
          const node = resolveGoalTodo(pi, state, goalId, target.canonicalId, {
            action: returnedClaim ? "auto" : params.skipped === true ? "skip" : "complete",
            expectedAutoResolution: params.expected_auto_resolution,
            expectedClaimHash: params.expected_claim_hash,
            expectedAttemptId: params.expected_attempt_id,
            expectedValidationPolicy: params.expected_validation_policy,
            expectedGraphRevision: guard?.expectedGraphRevision,
            expectedTodoRevision: guard?.expectedTodoRevision,
            evidenceRefs: params.evidence_refs,
            validationCommands: params.validation_commands,
            reason: params.reason,
            repoRoot: ctx.cwd,
          }, "tool");
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `${params.skipped ? "skipped" : "completed"} goal TODO ${node.id} ${node.path}: ${node.title}`, summary, [node]) }], details: { ...canonicalGoalTodoResultDetails(state, goalId, node, claimHash), summary } };
        },
      });
    },
  });

  pi.registerTool({
    name: "block_goal_todo",
    label: "Block Goal TODO",
    description: "Mark a /goal TODO blocked with a reason. Required blocked TODOs prevent propose_goal_completion.",
    promptSnippet: "Block TODOs instead of looping blindly when evidence/input is missing.",
    parameters: BlockGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("warning", `block ${publicTodoRefLabel(args)}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state);
      const target = resolvePublicGoalTodoTarget(state, goalId, params, "Goal TODO not found");
      return executeGoalTodoMutation(pi, state, {
        toolName: "block_goal_todo",
        goalId,
        resolvedTargetId: target.canonicalId,
        payload: canonicalGoalTodoMutationPayload(params, target.node),
        cas: params.cas,
        apply: () => {
          const node = resolveGoalTodo(pi, state, goalId, target.canonicalId, { action: "block", reason: params.reason, repoRoot: ctx.cwd }, "tool");
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `updated goal TODO ${node.id} ${node.path}: blocked`, summary, [node]) }], details: { ...canonicalGoalTodoResultDetails(state, goalId, node), summary } };
        },
      });
    },
  });

  pi.registerTool({
    name: "split_goal_todo",
    label: "Split Goal TODO",
    description: "Split a /goal TODO into bounded subtodos, respecting max depth and fanout policy.",
    promptSnippet: "Use when a TODO is too broad or needs delegation; keep subtodos bounded.",
    parameters: SplitGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `split ${publicTodoRefLabel(args)} +${args.titles.length}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params) {
      const goalId = currentGoalId(state);
      const target = resolvePublicGoalTodoTarget(state, goalId, params, "Parent TODO not found");
      return executeGoalTodoMutation(pi, state, {
        toolName: "split_goal_todo",
        goalId,
        resolvedTargetId: target.canonicalId,
        payload: canonicalGoalTodoMutationPayload(params, target.node),
        cas: params.cas,
        apply: () => {
          const nodes = splitGoalTodo(pi, state, goalId, target.canonicalId, params.titles, "tool");
          const parent = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === target.canonicalId) ?? target.node;
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `split goal TODO ${target.canonicalId} into ${nodes.length} child TODO(s)`, summary, nodes) }], details: { ...canonicalGoalTodoResultDetails(state, goalId, parent), nodes, summary } };
        },
      });
    }
  });

  pi.registerTool({
    name: "validate_goal_todo_claim",
    label: "Validate Goal TODO Claim",
    description: "Record oracle validation for a returned delegated TODO claim; auto-accepts only on strict PASS/no_ship=false when requested.",
    promptSnippet: "Use after oracle claim validation output is available; preserves parent-owned TODO state and blocks unsafe claims.",
    parameters: ValidateGoalTodoClaimParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state);
      const target = resolvePublicGoalTodoTarget(state, goalId, params, "Goal TODO not found");
      const guard = publicGoalTodoCasGuard(params.cas);
      const payload = canonicalGoalTodoMutationPayload(params, target.node);
      const replay = isExactGoalTodoMutationReplay(state, goalId, "validate_goal_todo_claim", target.canonicalId, payload, guard);
      if (!hasExactTodoCasRevisions(guard)) throw new Error(`validate_goal_todo_claim requires exact graph/TODO CAS revisions for ${target.node.id}`);
      if (!replay) assertCurrentGoalTodoClaimValidationBinding(state, goalId, target.node.id, {
        expectedClaimHash: params.claim_hash,
        expectedAttemptId: params.expected_attempt_id,
        expectedValidationPolicy: params.expected_validation_policy,
        expectedGraphRevision: guard.expectedGraphRevision,
        expectedTodoRevision: guard.expectedTodoRevision,
        outputHash: params.output_hash,
      });
      return executeGoalTodoMutation(pi, state, {
        toolName: "validate_goal_todo_claim",
        goalId,
        resolvedTargetId: target.canonicalId,
        payload,
        cas: params.cas,
        apply: () => {
          const node = recordGoalTodoClaimValidationResult(pi, state, goalId, target.canonicalId, {
            result: {
              todoId: target.canonicalId,
              claimHash: params.claim_hash,
              verdict: params.verdict,
              recommendedAction: params.recommended_action,
              evidenceRefs: params.evidence_refs ?? [],
              validationCommands: params.validation_commands ?? [],
              blockingIssues: params.blocking_issues ?? [],
              noShip: params.no_ship,
              confidence: params.confidence,
              hasFinalMarker: true,
            },
            runId: params.run_id,
            agent: params.agent,
            outputHash: params.output_hash,
            autoAccept: params.auto_accept !== false,
            repoRoot: ctx.cwd,
            expectedClaimHash: params.claim_hash,
            expectedAttemptId: params.expected_attempt_id,
            expectedValidationPolicy: params.expected_validation_policy,
            expectedGraphRevision: guard.expectedGraphRevision,
            expectedTodoRevision: guard.expectedTodoRevision,
          }, "tool");
          return { content: [{ type: "text", text: `validated delegated claim for TODO ${node.path}: ${node.status}; full claim hash, bindings, validation status, and next actions are in details` }], details: { ...canonicalGoalTodoResultDetails(state, goalId, node, params.claim_hash), summary: summarizeGoalTodos(state.goalTodos, goalId) } };
        },
      });
    },
  });

  pi.registerTool({
    name: "accept_goal_todo_claim",
    label: "Accept Goal TODO Claim",
    description: "Parent-owned acceptance of a delegated TODO claim after evidence/output gates pass.",
    promptSnippet: "Use when a delegated TODO is claim_returned; accept subagent TODO claims only after evidence and gate checks.",
    parameters: ClaimGoalTodoParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state);
      const target = resolvePublicGoalTodoTarget(state, goalId, params, "Goal TODO not found");
      const guard = publicGoalTodoCasGuard(params.cas);
      const claimHash = params.expected_claim_hash;
      const payload = canonicalGoalTodoMutationPayload(params, target.node);
      if (!isExactGoalTodoMutationReplay(state, goalId, "accept_goal_todo_claim", target.canonicalId, payload, guard)) requireExactClaimBinding("accept_goal_todo_claim", state, goalId, target.node, { expectedClaimHash: params.expected_claim_hash, expectedAttemptId: params.expected_attempt_id, expectedValidationPolicy: params.expected_validation_policy, guard }, true);
      return executeGoalTodoMutation(pi, state, {
        toolName: "accept_goal_todo_claim",
        goalId,
        resolvedTargetId: target.canonicalId,
        payload,
        cas: params.cas,
        apply: () => {
          const node = resolveGoalTodo(pi, state, goalId, target.canonicalId, { action: "accept_claim", expectedClaimHash: params.expected_claim_hash, expectedAttemptId: params.expected_attempt_id, expectedValidationPolicy: params.expected_validation_policy, expectedGraphRevision: guard?.expectedGraphRevision, expectedTodoRevision: guard?.expectedTodoRevision, evidenceRefs: params.evidence_refs, validationCommands: params.validation_commands, repoRoot: ctx.cwd }, "tool");
          return { content: [{ type: "text", text: `accepted delegated claim for TODO ${node.path}: ${node.title}; full claim hash, bindings, validation status, and next actions are in details` }], details: { ...canonicalGoalTodoResultDetails(state, goalId, node, claimHash), summary: summarizeGoalTodos(state.goalTodos, goalId) } };
        },
      });
    },
  });

  pi.registerTool({
    name: "recover_goal_todo_delegation",
    label: "Recover Goal TODO Delegation",
    description: "CAS-bound recovery of one exact failed, cancelled, or liveness-unknown TODO delegation attempt after authoritative inactivity proof. Never launches a child.",
    promptSnippet: "Recover only the exact latest inactive delegation attempt with current TODO refs, attempt/run IDs, evidence/proof refs, and exact graph/TODO CAS revisions.",
    promptGuidelines: [
      "DELEGATION_ACTIVE and DELEGATION_LIVENESS_UNKNOWN are fail-closed no-mutation results.",
      "Controller/PID absence, age, timeout, and session restore never prove inactivity.",
      "Recovery preserves attempt history and does not auto-delegate, auto-rerun, or accept a claim.",
    ],
    parameters: RecoverGoalTodoDelegationParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("warning", `recover delegation ${publicTodoRefLabel(args)} ${args.expected_attempt_id}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params) {
      const goalId = currentGoalId(state);
      const target = resolvePublicGoalTodoTarget(state, goalId, params, "Goal TODO delegation recovery target");
      const latest = target.node.delegationAttempts?.at(-1);
      if (!latest || latest.attemptId !== params.expected_attempt_id || latest.runId !== params.expected_run_id) {
        return rejectedDelegationRecovery(state, goalId, target.node, "DELEGATION_ATTEMPT_MISMATCH", "refresh_goal_todos");
      }
      if (!RECOVERABLE_DELEGATION_ATTEMPT_STATUSES.has(latest.status)) {
        return rejectedDelegationRecovery(state, goalId, target.node, "DELEGATION_NOT_RECOVERABLE", "use_claim_resolution_path");
      }
      const guard = parseRequiredGoalDelegationRecoveryGuard(params.cas);
      const reason = params.reason.trim();
      if (!reason) throw new Error("recover_goal_todo_delegation requires a non-empty reason");
      const evidenceRefs = delegationRecoveryRefs(params.evidence_refs, "recover_goal_todo_delegation evidence_refs");
      const proofRefs = delegationRecoveryRefs(params.proof_refs, "recover_goal_todo_delegation proof_refs");
      const liveness = assessDelegationAttemptLiveness(state.delegations, latest, {
        attemptId: params.expected_attempt_id,
        runId: params.expected_run_id,
      });
      if (liveness.status === "active") return rejectedDelegationRecovery(state, goalId, target.node, "DELEGATION_ACTIVE", "after_terminal_status", liveness);
      if (liveness.status === "unknown") return rejectedDelegationRecovery(state, goalId, target.node, "DELEGATION_LIVENESS_UNKNOWN", "after_authoritative_status", liveness);

      const payload = {
        canonical_todo_id: target.canonicalId,
        expected_attempt_id: latest.attemptId,
        expected_run_id: latest.runId,
        bound_goal_revision: latest.boundGoalRevision,
        bound_graph_revision: latest.boundGraphRevision,
        bound_todo_revision: latest.boundTodoRevision,
        expected_graph_revision: guard.expectedGraphRevision,
        expected_todo_revision: guard.expectedTodoRevision,
        reason_hash: sha256(reason),
        evidence_refs_hash: recoveryRefsHash(evidenceRefs),
        proof_refs_hash: recoveryRefsHash(proofRefs),
        liveness_proof_hash: liveness.proofHash,
        liveness_proof_timestamp_hash: liveness.proofTimestampHash,
      };
      const result = await executeGoalTodoMutation(pi, state, {
        toolName: "recover_goal_todo_delegation",
        goalId,
        resolvedTargetId: target.canonicalId,
        payload,
        cas: params.cas,
        apply: () => {
          const recovered = recoverGoalTodoDelegation(pi, state, goalId, target.canonicalId, {
            expectedAttemptId: latest.attemptId,
            expectedRunId: latest.runId,
            expectedGraphRevision: guard.expectedGraphRevision,
            expectedTodoRevision: guard.expectedTodoRevision,
            reason,
            evidenceRefs,
            proofRefs,
            livenessProof: liveness,
          }, "tool");
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          return {
            content: [{ type: "text", text: `recovered inactive delegation attempt ${latest.attemptId}/${latest.runId} for TODO ${recovered.node.path}; status=ready auto_dispatch=false` }],
            details: {
              ...canonicalGoalTodoResultDetails(state, goalId, recovered.node),
              recovery: recovered.recovery,
              liveness,
              summary,
              auto_dispatch: false,
              bodyStored: false,
            },
          };
        },
      });
      return {
        ...result,
        details: { ...result.details, liveness, auto_dispatch: false, bodyStored: false },
      };
    },
  });

  pi.registerTool({
    name: "reject_goal_todo_claim",
    label: "Reject Goal TODO Claim",
    description: "Parent-owned rejection of a delegated TODO claim with a reason.",
    promptSnippet: "Reject delegated claims when evidence is missing or no_ship remains.",
    parameters: RejectGoalTodoClaimParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state);
      const target = resolvePublicGoalTodoTarget(state, goalId, params, "Goal TODO not found");
      const guard = publicGoalTodoCasGuard(params.cas);
      const claimHash = params.expected_claim_hash;
      const payload = canonicalGoalTodoMutationPayload(params, target.node);
      const replay = isExactGoalTodoMutationReplay(state, goalId, "reject_goal_todo_claim", target.canonicalId, payload, guard);
      if (!replay && !params.reason?.trim()) throw new Error("reject_goal_todo_claim requires a non-empty reason");
      if (!replay) requireExactClaimBinding("reject_goal_todo_claim", state, goalId, target.node, { expectedClaimHash: params.expected_claim_hash, expectedAttemptId: params.expected_attempt_id, expectedValidationPolicy: params.expected_validation_policy, guard }, false);
      return executeGoalTodoMutation(pi, state, {
        toolName: "reject_goal_todo_claim",
        goalId,
        resolvedTargetId: target.canonicalId,
        payload,
        cas: params.cas,
        apply: () => {
          const node = resolveGoalTodo(pi, state, goalId, target.canonicalId, { action: "reject_claim", reason: params.reason, expectedClaimHash: params.expected_claim_hash, expectedAttemptId: params.expected_attempt_id, expectedValidationPolicy: params.expected_validation_policy, expectedGraphRevision: guard?.expectedGraphRevision, expectedTodoRevision: guard?.expectedTodoRevision, repoRoot: ctx.cwd }, "tool");
          return { content: [{ type: "text", text: `rejected delegated claim for TODO ${node.path}: ${node.title}; full claim hash, bindings, validation status, and next actions are in details` }], details: { ...canonicalGoalTodoResultDetails(state, goalId, node, claimHash), summary: summarizeGoalTodos(state.goalTodos, goalId) } };
        },
      });
    }
  });

  pi.registerTool({
    name: "import_factory_todos",
    label: "Import Factory TODOs",
    description: "Import a factory run's reports/checkpoints/sentinels as /goal TODO evidence refs. Bodies are not copied into TODO state.",
    promptSnippet: "Use when a factory run should become goal-linked TODO evidence; cite reports/factory-runs artifacts only.",
    parameters: ImportGoalTodoRunParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state, params.goal_id);
      return executeGoalTodoMutation(pi, state, {
        toolName: "import_factory_todos",
        goalId,
        resolvedTargetId: goalId,
        payload: importGoalTodoMutationPayload(ctx.cwd, "factory", params),
        cas: params.cas,
        apply: () => {
          const result = importFactoryRunTodos(pi, state, ctx.cwd, goalId, params.run_id);
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `imported ${result.imported} factory TODO node(s) for ${result.runId}; evidence=${result.evidenceRefs.length}; missing=${result.missingRefs.length}`, summary, result.nodes) }], details: { goalId, result, summary } };
        },
      });
    },
  });

  pi.registerTool({
    name: "import_orchestration_todos",
    label: "Import Orchestration TODOs",
    description: "Import orchestration run artifacts as /goal TODO evidence refs without storing raw bodies.",
    promptSnippet: "Use when an orchestration run should become goal-linked TODO evidence.",
    parameters: ImportGoalTodoRunParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state, params.goal_id);
      return executeGoalTodoMutation(pi, state, {
        toolName: "import_orchestration_todos",
        goalId,
        resolvedTargetId: goalId,
        payload: importGoalTodoMutationPayload(ctx.cwd, "orchestration", params),
        cas: params.cas,
        apply: () => {
          const result = importOrchestrationRunTodos(pi, state, ctx.cwd, goalId, params.run_id);
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `imported ${result.imported} orchestration TODO node(s) for ${result.runId}; evidence=${result.evidenceRefs.length}; missing=${result.missingRefs.length}`, summary, result.nodes) }], details: { goalId, result, summary } };
        },
      });
    },
  });

  pi.registerTool({
    name: "import_chain_todos",
    label: "Import Chain TODOs",
    description: "Import chain plan/status artifacts as /goal TODO evidence refs without storing raw bodies.",
    promptSnippet: "Use when a plan-only chain should be represented in the goal TODO graph.",
    parameters: ImportGoalTodoRunParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state, params.goal_id);
      return executeGoalTodoMutation(pi, state, {
        toolName: "import_chain_todos",
        goalId,
        resolvedTargetId: goalId,
        payload: importGoalTodoMutationPayload(ctx.cwd, "chain", params),
        cas: params.cas,
        apply: () => {
          const result = importChainRunTodos(pi, state, ctx.cwd, goalId, params.run_id);
          const summary = summarizeGoalTodos(state.goalTodos, goalId);
          return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `imported ${result.imported} chain TODO node(s) for ${result.runId}; evidence=${result.evidenceRefs.length}; missing=${result.missingRefs.length}`, summary, result.nodes) }], details: { goalId, result, summary } };
        },
      });
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create ZOB Goal",
    description: "Create a ZOB runtime goal. Fails if a non-complete goal already exists.",
    promptSnippet: "Create a ZOB runtime goal only when the user asks to track a long-running objective.",
    parameters: CreateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const applyLegacy = () => {
        if (state.runtimeGoal && state.runtimeGoal.status !== "complete") throw new Error("A non-complete ZOB runtime goal already exists. Use propose_goal_completion, update_goal, resume_goal, /goal clear, or /goal <objective> to replace it.");
        const gate = maybeStructuredGate(params.objective);
        const goal = createRuntimeGoal(gate?.activeGoal ?? params.objective, { gate, gateRequired: state.goalRequired, maxTurns: params.max_turns });
        appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
        const publishedGoal = state.runtimeGoal!;
        if (publishedGoal.gate) state.activeGoal = publishedGoal.gate;
        queueRuntimeGoalContinuation(pi, state, ctx);
        const persistedGoal = state.runtimeGoal!;
        return { content: [{ type: "text" as const, text: formatRuntimeGoalSummary(persistedGoal, state.goalActivationMode) }], details: { goal: persistedGoal } };
      };
      if (params.cas === undefined) return applyLegacy();
      const guard = parseOptionalGoalMutationGuard(params.cas);
      if (!guard) return applyLegacy();
      if (guard.expectedGoalRevision === undefined) return rejectedRootGoalMutation("create_goal", "pending", ["invalid_revision_guard"]);

      state.goalTodos.mutationReceipts ??= createGoalMutationReceiptState();
      const receiptGoalId = receiptGoalIdForMutation(state, guard.mutationId);
      if (!receiptGoalId && state.runtimeGoal && state.runtimeGoal.status !== "complete") throw new Error("A non-complete ZOB runtime goal already exists. Use propose_goal_completion, update_goal, resume_goal, /goal clear, or /goal <objective> to replace it.");
      const gate = maybeStructuredGate(params.objective);
      const pendingGoal = createRuntimeGoal(gate?.activeGoal ?? params.objective, { gate, gateRequired: state.goalRequired, maxTurns: params.max_turns });
      if (receiptGoalId) pendingGoal.goalId = receiptGoalId;
      const goalId = pendingGoal.goalId;
      return executeRootGoalMutation(pi, state, {
        toolName: "create_goal",
        goalId,
        payload: goalMutationPayload(params),
        guard,
        currentGoalRevision: 0,
        apply: () => {
          if (state.runtimeGoal && state.runtimeGoal.status !== "complete") throw new Error("A non-complete ZOB runtime goal already exists. Use propose_goal_completion, update_goal, resume_goal, /goal clear, or /goal <objective> to replace it.");
          const goal = pendingGoal!;
          appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
          const publishedGoal = state.runtimeGoal!;
          if (publishedGoal.gate) state.activeGoal = publishedGoal.gate;
          queueRuntimeGoalContinuation(pi, state, ctx);
          const persistedGoal = state.runtimeGoal!;
          return { content: [{ type: "text", text: formatRuntimeGoalSummary(persistedGoal, state.goalActivationMode) }], details: { goal: persistedGoal } };
        },
      });
    },
  });

  pi.registerTool({
    name: "resume_goal",
    label: "Resume ZOB Goal",
    description: "Safely resume a paused, blocked, or oracle_failed ZOB runtime goal without using slash commands.",
    promptSnippet: "Use when a runtime goal is paused/blocked/oracle_failed and a safe reason exists to resume via API tools.",
    promptGuidelines: [
      "Do not use resume_goal to bypass missing evidence or oracle requirements.",
      "Do not call update_goal complete after resume_goal unless propose_goal_completion and oracle PASS/no_ship=false have both succeeded.",
      "If the blocker is unresolved, report blocked instead of resuming.",
    ],
    parameters: ResumeGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goal = state.runtimeGoal;
      if (!goal) throw new Error("No ZOB runtime goal exists.");
      if (params.goal_id && params.goal_id !== goal.goalId) throw new Error("goal_id does not match the active ZOB runtime goal.");
      const apply = () => {
        assertRuntimeGoalMutable(goal);
        const nextGoal = cloneGoal(goal);
        if (nextGoal.status !== "paused" && nextGoal.status !== "blocked" && nextGoal.status !== "oracle_failed") throw new Error(`Only paused, blocked, or oracle_failed goals can be resumed; current status is ${nextGoal.status}.`);
        const resumeReason = params.resume_reason.trim();
        if (!resumeReason) throw new Error("resume_reason is required to resume a ZOB runtime goal.");
        const previousStatus = nextGoal.status;
        const resumed = resumeRuntimeGoal(nextGoal, params.additional_turns);
        const resumeReasonHash = sha256(resumeReason);
        appendRuntimeGoalEntry(pi, state, setEntry(nextGoal, "tool"));
        const publishedGoal = state.runtimeGoal!;
        clearRuntimeGoalContinuationStateFor(state, publishedGoal.goalId);
        if (params.queue_continuation === true) queueRuntimeGoalContinuation(pi, state, ctx);
        const persistedGoal = state.runtimeGoal!;
        const extensionNote = resumed.additionalTurns ? ` · turn window extended +${resumed.additionalTurns} to ${persistedGoal.loop.maxTurns}` : "";
        const blockerNote = resumed.previousBlocker ? ` · cleared blocker: ${resumed.previousBlocker}` : "";
        return { content: [{ type: "text" as const, text: `goal resumed from ${previousStatus}${extensionNote}${blockerNote}\nresume_reason_hash: ${resumeReasonHash}\n${formatRuntimeGoalSummary(persistedGoal, state.goalActivationMode)}` }], details: { goal: persistedGoal, previousStatus, previousBlocker: resumed.previousBlocker, additionalTurns: resumed.additionalTurns, resumeReasonHash, queuedContinuation: params.queue_continuation === true } };
      };
      if (params.cas === undefined) return apply();
      const guard = parseOptionalGoalMutationGuard(params.cas);
      if (!guard) return apply();
      return executeRootGoalMutation(pi, state, { toolName: "resume_goal", goalId: goal.goalId, payload: goalMutationPayload(params), guard, currentGoalRevision: goal.revision, apply });
    },
  });

  pi.registerTool({
    name: "propose_goal_completion",
    label: "Propose Goal Completion",
    description: "Move the active ZOB runtime goal to ready_for_oracle. This stops continuation until oracle PASS/no_ship=false.",
    promptSnippet: "Use before update_goal when all requirements appear evidence-backed and oracle review is needed.",
    promptGuidelines: [
      "Do not call update_goal complete directly.",
      "Call propose_goal_completion only after mapping each explicit requirement to concrete evidence.",
      "If any requirement is incomplete or uncertain, keep working or report blocked instead of proposing completion.",
    ],
    parameters: ProposeGoalCompletionParams,
    async execute(_toolCallId, params) {
      const goal = state.runtimeGoal;
      if (!goal) throw new Error("No ZOB runtime goal exists.");
      if (params.goal_id && params.goal_id !== goal.goalId) throw new Error("goal_id does not match the active ZOB runtime goal.");
      const apply = () => {
        assertRuntimeGoalMutable(goal);
        const nextGoal = cloneGoal(goal);
        const currentFreshness = currentCompletionProposalFreshness(state, goal);
        const oracleFreshness = currentOracleFreshness(state, goal);
        const staleReproposal = nextGoal.status === "ready_for_oracle"
          && Boolean(nextGoal.completionProposal)
          && (currentFreshness.status !== "fresh" || (isRuntimeGoalOracleBindingV2(nextGoal.oracle) && oracleFreshness.status !== "fresh"));
        if (nextGoal.status !== "active" && !staleReproposal) throw new Error(`Goal must be active, or ready_for_oracle with stale proposal/oracle lineage, to propose completion; current status is ${nextGoal.status}.`);
        const diagnostics = goalTodoCompletionDiagnostics(state.goalTodos, nextGoal.goalId);
        if (params.no_ship === true || diagnostics.effectiveNoShip) {
          const reviewBlockers = state.goalTodos.nodes
            .filter((node) => node.goalId === nextGoal.goalId && node.reviewNoShip === true)
            .map((node) => `todo ${node.path} '${node.title}' has unresolved review_no_ship${node.blocker ? `: ${node.blocker}` : ""}`);
          const blockers = [
            params.no_ship === true ? "proposal submitted with no_ship=true" : undefined,
            ...diagnostics.completionBlockers,
            ...reviewBlockers,
          ].filter((blocker): blocker is string => typeof blocker === "string" && blocker.length > 0);
          throw new Error(`Cannot propose goal completion: hard_no_ship=${diagnostics.hardNoShip} review_no_ship=${diagnostics.reviewNoShip} effective_no_ship=${diagnostics.effectiveNoShip}\n- ${blockers.join("\n- ") || "diagnostics report no_ship; inspect get_goal_todos.details.diagnostics"}`);
        }
        nextGoal.status = "ready_for_oracle";
        nextGoal.loop.enabled = false;
        nextGoal.oracle = { required: true, status: "needed", evidenceRefs: [] };
        nextGoal.completionProposal = buildRuntimeGoalCompletionProposal({
          goalId: nextGoal.goalId,
          goalRevision: nextGoal.revision + 1,
          todoGraphRevision: state.goalTodos.graphRevisions?.[nextGoal.goalId] ?? 0,
          completionSummary: params.completion_summary,
          requirementsChecked: params.requirements_checked,
          evidenceRefs: params.evidence_refs,
          validationCommands: params.validation_commands,
          knownRisks: params.known_risks,
          noShip: params.no_ship,
        });
        nextGoal.updatedAt = unixSeconds();
        appendRuntimeGoalEntry(pi, state, setEntry(nextGoal, "tool"));
        const persistedGoal = state.runtimeGoal!;
        clearRuntimeGoalContinuationStateFor(state, persistedGoal.goalId);
        const freshness = currentCompletionProposalFreshness(state, persistedGoal);
        const proposalDetails = completionProposalReadDetails(state, persistedGoal, freshness);
        return {
          content: [{ type: "text" as const, text: `goal ready_for_oracle; oracle required before update_goal complete\n${formatRuntimeGoalSummary(persistedGoal, state.goalActivationMode, undefined, freshness)}` }],
          details: { goal: persistedGoal, ...proposalDetails },
        };
      };
      if (params.cas === undefined) return apply();
      const guard = parseOptionalGoalMutationGuard(params.cas);
      if (!guard) return apply();
      return executeRootGoalMutation(pi, state, {
        toolName: "propose_goal_completion",
        goalId: goal.goalId,
        payload: goalMutationPayload(params),
        guard,
        currentGoalRevision: goal.revision,
        currentGraphRevision: state.goalTodos.graphRevisions?.[goal.goalId] ?? 0,
        resultIdentityHash: () => state.runtimeGoal?.completionProposal?.proposalHash,
        resultIdentityKind: "proposal",
        apply,
      });
    },
  });

  pi.registerTool({
    name: "record_goal_oracle",
    label: "Record Goal Oracle",
    description: "Record one immutable body-free oracle decision bound to the exact fresh proposal v2 hash, proposal/TODO revisions, and current root CAS revision.",
    promptSnippet: "Read get_goal, then record PASS/WARN/FAIL with the exact full proposal hash and cas.expected_goal_revision; PASS/no_ship=false is necessary but not sufficient for completion.",
    promptGuidelines: [
      "Use the full 64-character proposalHash from get_goal; prefixes and legacy/unbound proposals are rejected.",
      "The required CAS revision must equal the current root Goal revision and exact replay emits no new event.",
      "Only evidence hash/count metadata is persisted; raw evidence summary/refs are never stored in the Goal or CAS ledgers.",
    ],
    parameters: OracleParams,
    async execute(_toolCallId, params) {
      const goal = state.runtimeGoal;
      if (!goal) throw rootBindingError("record_goal_oracle", "GOAL_MISSING", "goal", "create_goal", "No ZOB runtime goal exists");
      assertExactBindingHash("record_goal_oracle", params.expected_proposal_hash, "expected_proposal_hash");
      const guard = parseRequiredGoalRootMutationGuard(params.cas);
      const payload = goalMutationPayload(params);
      const knownMutation = hasGoalMutationReceiptOrProtocol(state, goal.goalId, guard.mutationId);
      if (!knownMutation && guard.expectedGoalRevision === goal.revision) {
        if (!params.evidence_summary.trim()) throw rootBindingError("record_goal_oracle", "EVIDENCE_SUMMARY_REQUIRED", "evidence_summary", "review_evidence", "a non-empty transient evidence summary is required");
        assertGoalOracleRecordable(state, { expectedProposalHash: params.expected_proposal_hash, expectedGoalRevision: guard.expectedGoalRevision });
      }
      const apply = () => {
        const recorded = recordOracleVerdict(pi, state, {
          verdict: params.verdict,
          noShip: params.no_ship,
          evidenceSummary: params.evidence_summary,
          evidenceRefs: params.evidence_refs ?? [],
          expectedProposalHash: params.expected_proposal_hash,
          expectedGoalRevision: guard.expectedGoalRevision,
        });
        const proposalFreshness = currentCompletionProposalFreshness(state, recorded);
        const oracleFreshness = currentOracleFreshness(state, recorded);
        return {
          content: [{ type: "text" as const, text: formatRuntimeGoalSummary(recorded, state.goalActivationMode, undefined, proposalFreshness, oracleFreshness) }],
          details: { goal: publicRuntimeGoal(recorded), ...completionProposalReadDetails(state, recorded, proposalFreshness) },
        };
      };
      return executeRootGoalMutation(pi, state, {
        toolName: "record_goal_oracle",
        goalId: goal.goalId,
        payload,
        guard,
        currentGoalRevision: goal.revision,
        currentGraphRevision: state.goalTodos.graphRevisions?.[goal.goalId] ?? 0,
        resultIdentityHash: () => state.runtimeGoal?.oracle.oracleDecisionHash,
        resultIdentityKind: "oracle",
        apply,
      });
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update ZOB Goal",
    description: "Mark the Goal complete exactly once only when caller hashes, proposal/oracle/TODO lineage, diagnostics, and root CAS revision all remain unchanged.",
    promptSnippet: "Use the full proposalHash, oracleDecisionHash, and current root revision from get_goal; any intervening root/TODO/proposal mutation requires reproposal and a new oracle review.",
    promptGuidelines: [
      "Never accept legacy/unbound proposal or oracle state, hash prefixes, WARN/FAIL, or no_ship=true.",
      "Completion requires the current root revision to equal the oracle post-event revision and every required TODO to remain complete.",
      "Exact CAS replay is idempotent and emits no event; a new completion mutation against an already complete Goal is rejected.",
    ],
    parameters: UpdateGoalParams,
    async execute(_toolCallId, params) {
      const goal = state.runtimeGoal;
      if (!goal) throw rootBindingError("update_goal", "GOAL_MISSING", "goal", "create_goal", "No ZOB runtime goal exists");
      assertExactBindingHash("update_goal", params.expected_proposal_hash, "expected_proposal_hash");
      assertExactBindingHash("update_goal", params.expected_oracle_decision_hash, "expected_oracle_decision_hash");
      const guard = parseRequiredGoalRootMutationGuard(params.cas);
      const payload = goalMutationPayload(params);
      const knownMutation = hasGoalMutationReceiptOrProtocol(state, goal.goalId, guard.mutationId);
      if (!knownMutation && guard.expectedGoalRevision === goal.revision) {
        assertGoalCompletableWithBinding(state, params.expected_proposal_hash, params.expected_oracle_decision_hash, guard.expectedGoalRevision);
      }
      const apply = () => {
        assertGoalCompletableWithBinding(state, params.expected_proposal_hash, params.expected_oracle_decision_hash, guard.expectedGoalRevision);
        const currentGoal = state.runtimeGoal!;
        const nextGoal = cloneGoal(currentGoal);
        nextGoal.status = "complete";
        nextGoal.loop.enabled = false;
        nextGoal.updatedAt = unixSeconds();
        appendRuntimeGoalEntry(pi, state, setEntry(nextGoal, "tool"));
        const persistedGoal = state.runtimeGoal!;
        clearRuntimeGoalContinuationStateFor(state, persistedGoal.goalId);
        const proposalFreshness = currentCompletionProposalFreshness(state, persistedGoal);
        const oracleFreshness = currentOracleFreshness(state, persistedGoal);
        return {
          content: [{ type: "text" as const, text: formatRuntimeGoalSummary(persistedGoal, state.goalActivationMode, undefined, proposalFreshness, oracleFreshness) }],
          details: { goal: publicRuntimeGoal(persistedGoal), ...completionProposalReadDetails(state, persistedGoal, proposalFreshness) },
        };
      };
      return executeRootGoalMutation(pi, state, {
        toolName: "update_goal",
        goalId: goal.goalId,
        payload,
        guard,
        currentGoalRevision: goal.revision,
        currentGraphRevision: state.goalTodos.graphRevisions?.[goal.goalId] ?? 0,
        resultIdentityHash: () => state.runtimeGoal?.oracle.oracleDecisionHash,
        resultIdentityKind: "completion",
        apply,
      });
    },
  });
}
