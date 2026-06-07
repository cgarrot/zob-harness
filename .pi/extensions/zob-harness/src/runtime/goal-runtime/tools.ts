import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { importChainRunTodos, importFactoryRunTodos, importOrchestrationRunTodos } from "../../domains/goal/goal-todo-imports.js";
import { addGoalTodo, formatGoalTodoSummary, formatGoalTodoTree, goalTodoCompletionDiagnostics, linkGoalTodoDelegation, patchGoalTodo, recordGoalTodoClaimValidationResult, resolveGoalTodo, resolveGoalTodoReference, splitGoalTodo, summarizeGoalTodos, type GoalTodoNode, type GoalTodoOwner, type GoalTodoPriority, type GoalTodoStatus, type GoalTodoSummary, type ResolveGoalTodoAction } from "../../domains/goal/goal-todos.js";
import type { HarnessRuntimeState } from "../state.js";
import { sha256 } from "../../core/utils/hashing.js";
import { isRecord } from "../../core/utils/records.js";
import { newRunId, safeFileStem } from "../../core/utils/paths.js";
import { appendGoalRoomMessage } from "../../domains/goal/goal-room.js";
import { readZobLiveRegistrySnapshot } from "../../domains/coms/coms-v2/registry.js";
import { activeZpeerRoomId, peerAliasInRoom, refreshZpeerSelf, safeZpeerRoomId, sendZpeerPrompt, type ZpeerSendResult } from "../../domains/coms/coms-v2/zpeer.js";
import { loadZteamManifest, type ZTeamAgentManifest, type ZTeamMemberManifest } from "../../domains/coms/zagents.js";
import { loadTeamDefinition, validateTeamDefinition } from "../../domains/topology/teams.js";
import { recordOracleVerdict } from "./commands.js";
import { DEFAULT_GOAL_ACTIVATION_MODE, appendRuntimeGoalEntry, clearRuntimeGoalContinuationStateFor, createRuntimeGoal, formatRuntimeGoalSummary, maybeStructuredGate, queueRuntimeGoalContinuation, resumeRuntimeGoal, setEntry, unixSeconds } from "./state.js";

export const EmptyParams = Type.Object({});
export const CreateGoalParams = Type.Object({
  objective: Type.String({ description: "Concrete ZOB runtime objective to pursue until ready_for_oracle." }),
  max_turns: Type.Optional(Type.Integer({ description: "Optional positive turn cap for the autonomous continuation loop.", minimum: 1 })),
});
export const ResumeGoalParams = Type.Object({
  goal_id: Type.Optional(Type.String({ description: "Expected current runtime goal id." })),
  resume_reason: Type.String({ description: "Why resuming the paused/blocked/oracle_failed goal is safe. Stored as hash only." }),
  additional_turns: Type.Optional(Type.Integer({ description: "Optional positive turn-window extension for resumed auto-continuation.", minimum: 1 })),
  queue_continuation: Type.Optional(Type.Boolean({ description: "Queue a follow-up continuation after resuming. Default false for API callers.", default: false })),
});
export const ProposeGoalCompletionParams = Type.Object({
  goal_id: Type.Optional(Type.String({ description: "Expected current runtime goal id." })),
  completion_summary: Type.String({ description: "Evidence-backed summary of completed work. Stored as hash only." }),
  requirements_checked: Type.Array(Type.String(), { description: "Explicit requirements checked before oracle." }),
  evidence_refs: Type.Array(Type.String(), { description: "Safe repo-relative evidence references or command names." }),
  validation_commands: Type.Array(Type.String(), { description: "Validation commands run and checked." }),
  known_risks: Type.Array(Type.String(), { description: "Known remaining risks or blockers." }),
  no_ship: Type.Boolean({ description: "True if any no-ship blocker remains." }),
});
export const OracleParams = Type.Object({
  verdict: StringEnum(["PASS", "WARN", "FAIL"] as const, { description: "Oracle verdict for the proposed goal completion." }),
  no_ship: Type.Boolean({ description: "Must be false to allow update_goal complete." }),
  evidence_summary: Type.String({ description: "Oracle evidence summary. Stored as hash only." }),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Safe repo-relative evidence refs." })),
});
export const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete"] as const, { description: "Only complete is accepted, and only after oracle PASS/no_ship=false." }),
});

export const GoalTodoStatusValues = ["planned", "ready", "in_progress", "delegated", "claim_returned", "needs_review", "needs_oracle", "needs_user", "blocked", "done", "skipped"] as const;
export const GoalTodoOwnerValues = ["agent", "user", "oracle", "subagent", "factory", "orchestration"] as const;
export const GoalTodoPriorityValues = ["low", "normal", "high", "critical"] as const;
export const ResolveGoalTodoActionValues = ["auto", "complete", "accept_claim", "reject_claim", "block", "skip", "reopen"] as const;
export const GetGoalTodosParams = Type.Object({ goal_id: Type.Optional(Type.String({ description: "Optional goal id. Defaults to current runtime goal." })) });
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
export const AddGoalTodoParams = AddGoalTodoItemParams;
export const AddGoalTodosParams = Type.Object({
  todos: Type.Array(AddGoalTodoItemParams, { description: "Multiple bounded TODO nodes to add in one tool call. Prefer this over repeated add_goal_todo calls for plans." }),
  goal_id: Type.Optional(Type.String({ description: "Optional goal id. Defaults to current runtime goal." })),
});
export const UpdateGoalTodoParams = Type.Object({
  todo_id: Type.String({ description: "Goal TODO id to update." }),
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
});
export const CompleteGoalTodoParams = Type.Object({
  todo_id: Type.String({ description: "Goal TODO id to mark done or skipped." }),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Evidence refs proving completion." })),
  validation_commands: Type.Optional(Type.Array(Type.String(), { description: "Validation commands proving completion." })),
  skipped: Type.Optional(Type.Boolean({ description: "Mark skipped instead of done." })),
  reason: Type.Optional(Type.String({ description: "Skip reason when skipped=true." })),
});
export const ResolveGoalTodoParams = Type.Object({
  todo_id: Type.String({ description: "Goal TODO id to resolve." }),
  action: StringEnum(ResolveGoalTodoActionValues, { description: "Transition action. auto accepts returned claims or completes non-delegated TODOs." }),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Evidence refs for complete/accept/skip transitions." })),
  validation_commands: Type.Optional(Type.Array(Type.String(), { description: "Validation commands for complete/accept/skip transitions." })),
  reason: Type.Optional(Type.String({ description: "Required for block/reject_claim; skip reason for skip." })),
  goal_id: Type.Optional(Type.String({ description: "Optional goal id. Defaults to current runtime goal." })),
});
export const BlockGoalTodoParams = Type.Object({
  todo_id: Type.String({ description: "Goal TODO id to block." }),
  reason: Type.String({ description: "Blocker reason." }),
});
export const SplitGoalTodoParams = Type.Object({
  todo_id: Type.String({ description: "Parent TODO id to split." }),
  titles: Type.Array(Type.String(), { description: "Child TODO titles." }),
});
export const ClaimGoalTodoParams = Type.Object({
  todo_id: Type.String({ description: "Goal TODO id whose delegated claim is accepted/rejected." }),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Additional evidence refs." })),
  validation_commands: Type.Optional(Type.Array(Type.String(), { description: "Additional validation commands." })),
  reason: Type.Optional(Type.String({ description: "Rejection reason for reject_goal_todo_claim." })),
});
export const ValidateGoalTodoClaimParams = Type.Object({
  todo_id: Type.String({ description: "Goal TODO id whose returned delegated claim was validated." }),
  verdict: StringEnum(["PASS", "WARN", "FAIL"] as const, { description: "Oracle verdict for the returned claim." }),
  recommended_action: StringEnum(["accept_claim", "needs_review", "reject_claim", "block"] as const, { description: "Oracle recommended parent action." }),
  no_ship: Type.Boolean({ description: "True when any no-ship blocker remains." }),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Evidence refs inspected by oracle." })),
  validation_commands: Type.Optional(Type.Array(Type.String(), { description: "Validation commands checked by oracle." })),
  blocking_issues: Type.Optional(Type.Array(Type.String(), { description: "Blocking issues, or empty for PASS." })),
  confidence: StringEnum(["LOW", "MEDIUM", "HIGH"] as const, { description: "Oracle confidence." }),
  claim_hash: Type.String({ description: "Expected claim hash to guard against stale validation." }),
  output_hash: Type.Optional(Type.String({ description: "Hash of the oracle validation output, if available." })),
  run_id: Type.Optional(Type.String({ description: "Oracle validation run id, if available." })),
  agent: Type.Optional(Type.String({ description: "Oracle agent name. Default oracle." })),
  auto_accept: Type.Optional(Type.Boolean({ description: "Auto-accept on strict PASS/no_ship=false. Default true." })),
});
export const HandoffGoalTodoParams = Type.Object({
  todo_id: Type.Optional(Type.String({ description: "Single Goal TODO id/path ref to hand off." })),
  todo_ids: Type.Optional(Type.Array(Type.String(), { description: "One or more Goal TODO id/path refs to hand off as a batch. Refs must resolve uniquely and be delegatable." })),
  todo_refs: Type.Optional(Type.Array(Type.String(), { description: "Alias for todo_ids; supports visible TODO paths such as 1.2." })),
  target_type: StringEnum(["zpeer", "zteam"] as const, { description: "Explicit handoff target kind." }),
  target: Type.String({ description: "Explicit target alias/role for zpeer (leading @ optional) or project-local zteam id." }),
  custom_message: Type.String({ description: "Maintainer-authored transient instruction body. The raw body is hashed and never persisted in Goal Room/coms/TODO state." }),
  goal_id: Type.Optional(Type.String({ description: "Optional goal id. Defaults to current runtime goal." })),
  run_id: Type.Optional(Type.String({ description: "Optional handoff run id. Defaults to generated handoff_* id." })),
  sender: Type.Optional(Type.String({ description: "Goal Room sender role. Defaults to parent." })),
  goal_room_team: Type.Optional(Type.String({ description: "Team topology used for Goal Room sender validation. Default zob-core." })),
  target_room: Type.Optional(Type.String({ description: "Optional ZPeer room id precondition for a zpeer target." })),
  delegation_depth: Type.Optional(Type.Number({ description: "Parent-owned delegation depth metadata. Default 1." })),
});
export const ImportGoalTodoRunParams = Type.Object({
  run_id: Type.String({ description: "Run id under reports/factory-runs, reports/orchestrations, or reports/chains." }),
  goal_id: Type.Optional(Type.String({ description: "Optional goal id. Defaults to current runtime goal." })),
});

export function currentGoalId(state: HarnessRuntimeState, explicit?: string): string {
  const goalId = explicit ?? state.runtimeGoal?.goalId;
  if (!goalId) throw new Error("Goal TODO tools require an active runtime goal or explicit goal_id.");
  return goalId;
}

export type HandoffGoalTodoInput = {
  todo_id?: string;
  todo_ids?: string[];
  todo_refs?: string[];
  target_type: "zpeer" | "zteam";
  target: string;
  custom_message: string;
  goal_id?: string;
  run_id?: string;
  sender?: string;
  goal_room_team?: string;
  target_room?: string;
  delegation_depth?: number;
};

export function collectHandoffTodoRefs(input: HandoffGoalTodoInput): string[] {
  const refs = [input.todo_id, ...(input.todo_ids ?? []), ...(input.todo_refs ?? [])]
    .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
    .map((ref) => ref.trim());
  return [...new Set(refs)];
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
      todo_refs: refs,
      target_type: targetMatch[1].toLowerCase() as "zpeer" | "zteam",
      target: targetMatch[2].trim(),
      custom_message: body,
    },
  };
}

export type HandoffLiveDeliveryTarget = { alias: string; roomId: string; targetHash: string; memberId?: string };
export type HandoffLiveDeliveryAttempt = { targetHash: string; targetAliasHash: string; roomIdHash: string; memberIdHash?: string; attempted: true; status: ZpeerSendResult["status"]; succeeded: boolean; msgId?: string; taskHash?: string; outputHash?: string; reasonHash?: string; bodyStored: false };
export type HandoffLiveDeliveryResult = { liveDeliveryAttempted: true; deliveryPreparedOnly: false; deliverySucceeded: boolean; attempted: number; succeeded: number; failed: number; messageIds: string[]; targetHashes: string[]; attempts: HandoffLiveDeliveryAttempt[]; bodyStored: false };

export type HandoffGoalTodoResult = { goalId: string; runId: string; nodes: GoalTodoNode[]; instructionHash: string; goalRoomMessageIds: string[]; targetHash: string; targetType: "zpeer" | "zteam"; delivery: HandoffLiveDeliveryResult; deliveryPreparedOnly: false };

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

export async function deliverHandoffLive(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, input: HandoffGoalTodoInput, runId: string): Promise<HandoffLiveDeliveryResult> {
  if (!state.zobLive.peerCard) throw new Error("handoff live delivery blocked: current session has not registered a local ZPeer endpoint");
  const self = refreshZpeerSelf(repoRoot, state.zobLive.peerCard);
  state.zobLive.peerCard = self;
  const selfRoomId = safeZpeerRoomId(input.target_room) ?? activeZpeerRoomId(self);
  const targets = input.target_type === "zpeer"
    ? [resolveZpeerHandoffTarget(repoRoot, input, selfRoomId)].filter((target): target is HandoffLiveDeliveryTarget => Boolean(target))
    : resolveZteamHandoffTargets(repoRoot, input, selfRoomId);
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

export async function handoffGoalTodos(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, input: HandoffGoalTodoInput, source: "tool" | "command"): Promise<HandoffGoalTodoResult> {
  const goalId = currentGoalId(state, input.goal_id);
  const refs = collectHandoffTodoRefs(input);
  if (refs.length === 0) throw new Error("handoff_goal_todo requires todo_id, todo_ids, or todo_refs.");
  if (!input.custom_message.trim()) throw new Error("handoff_goal_todo requires a maintainer-authored custom_message body; raw body is transient and only its sha256 is persisted.");
  if ((input as { append_goal_room?: boolean }).append_goal_room === false) throw new Error("handoff_goal_todo requires canonical hash-only Goal Room metadata; append_goal_room=false is not allowed for live TODO handoff.");
  const runId = input.run_id?.trim() || newRunId("handoff");
  if (safeFileStem(runId) !== runId) throw new Error(`handoff run_id must be path-safe: ${runId}`);
  const resolved = refs.map((ref) => {
    const match = resolveGoalTodoReference(state.goalTodos, goalId, ref, "handoff TODO ref", { requireDelegatable: true });
    if (!match.node) throw new Error(match.errors.join("\n") || `handoff TODO ref not found: ${ref}`);
    return match.node;
  });
  const nodes = [...new Map(resolved.map((node) => [node.id, node])).values()];
  const target = validateHandoffTarget(repoRoot, input);
  if (target.errors.length > 0) throw new Error(`handoff target blocked:\n- ${target.errors.join("\n- ")}`);

  const instructionHash = sha256(input.custom_message);
  const teamName = input.goal_room_team ?? "zob-core";
  const team = loadTeamDefinition(repoRoot, teamName);
  const errors = [...team.errors, ...validateTeamDefinition(repoRoot, team.definition)];
  if (errors.length > 0 || !team.definition) throw new Error(`Goal Room handoff metadata blocked:\n- ${errors.join("\n- ")}`);

  const goalRoomMessageIds: string[] = [];
  for (const node of nodes) {
    const message = appendGoalRoomMessage(repoRoot, team.definition, {
      goal_id: goalId,
      run_id: runId,
      todo_id: node.id,
      sender: input.sender ?? "parent",
      audience: input.target_type === "zteam" ? "all" : "worker",
      kind: "HANDOFF",
      priority: node.priority,
      body_hash: instructionHash,
      task_id: node.id,
      requires_parent_action: true,
      metadata: {
        schema: "zob.goal-todo-handoff.v1",
        handoffRunId: runId,
        targetType: input.target_type,
        targetHash: target.targetHash,
        targetRoomHash: input.target_room ? sha256(input.target_room) : undefined,
        todoPath: node.path,
        batchSize: nodes.length,
        instructionHash,
        canonicalGoalRoomPrepared: true,
        liveDeliveryRequired: true,
        liveDeliveryAttempted: false,
        deliveryPreparedOnly: false,
        bodyStored: false,
      },
    });
    if (typeof message.msgId === "string") goalRoomMessageIds.push(message.msgId);
  }

  const delegationDepth = Math.max(1, Math.trunc(input.delegation_depth ?? 1));
  const linked = nodes.map((node) => linkGoalTodoDelegation(pi, state, goalId, node.id, {
    runId,
    agent: `${input.target_type}:${target.deliveryTarget}`,
    requestId: `handoff:${runId}:${node.id}`,
    delegationDepth,
    status: "queued",
  }, source)).filter((node): node is GoalTodoNode => Boolean(node));

  let delivery: HandoffLiveDeliveryResult;
  try {
    delivery = await deliverHandoffLive(pi, state, repoRoot, input, runId);
  } catch (error) {
    for (const node of linked) {
      linkGoalTodoDelegation(pi, state, goalId, node.id, {
        runId,
        agent: `${input.target_type}:${target.deliveryTarget}`,
        requestId: `handoff:${runId}:${node.id}`,
        delegationDepth,
        status: "failed",
      }, source);
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
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
      failureHash: sha256(error instanceof Error ? error.message : String(error)),
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

  return { goalId, runId, nodes: linked, instructionHash, goalRoomMessageIds, targetHash: target.targetHash, targetType: input.target_type, delivery, deliveryPreparedOnly: false };
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
      return { content: [{ type: "text", text: formatRuntimeGoalSummary(goal, state.goalActivationMode, todoSummary) }], details: { goal: goal ?? null, goalActivationMode: state.goalActivationMode ?? DEFAULT_GOAL_ACTIVATION_MODE, goalTodos: goal ? summarizeGoalTodos(state.goalTodos, goal.goalId) : undefined } };
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
      const summary = summarizeGoalTodos(state.goalTodos, goalId);
      const diagnostics = goalTodoCompletionDiagnostics(state.goalTodos, goalId);
      return { content: [{ type: "text", text: formatGoalTodoTree(state.goalTodos, goalId) }], details: { goalId, summary, diagnostics, completion_ready: diagnostics.completionReady, hard_no_ship: diagnostics.hardNoShip, review_no_ship: diagnostics.reviewNoShip, effective_no_ship: diagnostics.effectiveNoShip, completion_blockers: diagnostics.completionBlockers, next_valid_actions: diagnostics.nextValidActions, nodes: state.goalTodos.nodes.filter((node) => node.goalId === goalId), policy: state.goalTodos.policy } };
    },
  });

  pi.registerTool({
    name: "handoff_goal_todo",
    label: "Handoff Goal TODO",
    description: "Deliver an explicit single/batch Goal TODO handoff to a live ZPeer or project-local ZTeam through governed local ZPeer transport. Requires a maintainer-authored transient custom_message; persists only hashes/metadata, records mandatory hash-only Goal Room HANDOFF records before live delivery, and marks TODOs delegated/queued without done transition.",
    promptSnippet: "Use for explicit TODO handoff only after resolving active TODO refs and an explicit online target; raw custom_message is transient and durable records are hash-only.",
    promptGuidelines: [
      "Do not use this as completion evidence: it queues/delegates handoff only and never marks TODOs done.",
      "target_type/target must be explicit; stale/offline/ambiguous targets block.",
      "custom_message is required and stored only as instructionHash/body_hash in durable metadata.",
    ],
    parameters: HandoffGoalTodoParams,
    renderCall(args, theme) {
      const count = [args.todo_id, ...(args.todo_ids ?? []), ...(args.todo_refs ?? [])].filter(Boolean).length;
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `handoff ${count || 1} → ${args.target_type}:${args.target}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await handoffGoalTodos(pi, state, ctx.cwd, params as HandoffGoalTodoInput, "tool");
      const summary = summarizeGoalTodos(state.goalTodos, result.goalId);
      return {
        content: [{ type: "text", text: formatGoalTodoToolResult(result.goalId, `handoff delivered ${result.nodes.length} goal TODO(s); run=${result.runId}; target=${result.targetType}; instructionHash=${result.instructionHash.slice(0, 12)}; liveDeliveryAttempted=${result.delivery.liveDeliveryAttempted}; deliverySucceeded=${result.delivery.deliverySucceeded}; bodyStored=false`, summary, result.nodes) }],
        details: { schema: "zob.goal-todo-handoff-result.v1", ...result, summary, liveDeliveryAttempted: true, deliverySucceeded: result.delivery.deliverySucceeded, deliveryPreparedOnly: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false },
      };
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

  pi.registerTool({
    name: "update_goal_todo",
    label: "Update Goal TODO",
    description: "Update a /goal TODO node metadata/status except done/skipped. Use resolve_goal_todo for complete/skip/claim/block/reopen transitions.",
    promptSnippet: "Update TODO metadata only; use resolve_goal_todo for done, skipped, claim acceptance/rejection, block, or reopen.",
    parameters: UpdateGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `update ${args.todo_id}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params) {
      const goalId = currentGoalId(state);
      if (params.status === "done" || params.status === "skipped") throw new Error("update_goal_todo cannot mark TODOs done or skipped; use resolve_goal_todo with action=complete or action=skip.");
      const node = patchGoalTodo(pi, state, goalId, params.todo_id, {
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
      return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `updated goal TODO ${node.id} ${node.path}: ${node.status}`, summary, [node]) }], details: { goalId, node, summary } };
    },
  });

  pi.registerTool({
    name: "resolve_goal_todo",
    label: "Resolve Goal TODO",
    description: "Primary transition tool for /goal TODOs: auto, complete, accept_claim, reject_claim, block, skip, or reopen. Emits diagnostics-compatible state and preserves parent-owned claim acceptance.",
    promptSnippet: "Use resolve_goal_todo for TODO completion, skip, delegated claim acceptance/rejection, blocking, and reopening; do not use update_goal_todo for done/skipped.",
    promptGuidelines: [
      "Use action=auto for normal closure: it accepts returned delegated claims and completes non-delegated TODOs.",
      "Treat child no_ship as review evidence: inspect diagnostics and decide accept/reject/block; child no_ship alone is not a child runtime failure.",
      "Root goal completion still requires propose_goal_completion and oracle PASS/no_ship=false.",
    ],
    parameters: ResolveGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `resolve ${args.action} ${args.todo_id}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state, params.goal_id);
      const node = resolveGoalTodo(pi, state, goalId, params.todo_id, { action: params.action as ResolveGoalTodoAction, evidenceRefs: params.evidence_refs, validationCommands: params.validation_commands, reason: params.reason, repoRoot: ctx.cwd }, "tool");
      const summary = summarizeGoalTodos(state.goalTodos, goalId);
      const diagnostics = goalTodoCompletionDiagnostics(state.goalTodos, goalId);
      return { content: [{ type: "text", text: `${formatGoalTodoToolResult(goalId, `resolved goal TODO ${node.id} ${node.path}: ${node.status}`, summary, [node])}\ncompletion_ready=${diagnostics.completionReady} hard_no_ship=${diagnostics.hardNoShip} review_no_ship=${diagnostics.reviewNoShip} effective_no_ship=${diagnostics.effectiveNoShip}` }], details: { goalId, node, summary, diagnostics } };
    },
  });

  pi.registerTool({
    name: "complete_goal_todo",
    label: "Complete Goal TODO",
    description: "Mark a /goal TODO done or skipped with evidence; claim_returned delegated TODOs are accepted through the same parent-owned compatibility path. Root goal completion still requires propose_goal_completion and oracle PASS/no_ship=false.",
    promptSnippet: "Use for legacy done/skip compatibility; returned delegated claims are accepted, but running/failed delegated TODOs stay blocked from direct done.",
    parameters: CompleteGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `${args.skipped ? "skip" : "done"} ${args.todo_id}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state);
      const node = resolveGoalTodo(pi, state, goalId, params.todo_id, { action: params.skipped === true ? "skip" : "complete", evidenceRefs: params.evidence_refs, validationCommands: params.validation_commands, reason: params.reason, repoRoot: ctx.cwd }, "tool");
      const summary = summarizeGoalTodos(state.goalTodos, goalId);
      return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `${params.skipped ? "skipped" : "completed"} goal TODO ${node.id} ${node.path}: ${node.title}`, summary, [node]) }], details: { goalId, node, summary } };
    },
  });

  pi.registerTool({
    name: "block_goal_todo",
    label: "Block Goal TODO",
    description: "Mark a /goal TODO blocked with a reason. Required blocked TODOs prevent propose_goal_completion.",
    promptSnippet: "Block TODOs instead of looping blindly when evidence/input is missing.",
    parameters: BlockGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("warning", `block ${args.todo_id}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state);
      const node = resolveGoalTodo(pi, state, goalId, params.todo_id, { action: "block", reason: params.reason, repoRoot: ctx.cwd }, "tool");
      const summary = summarizeGoalTodos(state.goalTodos, goalId);
      return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `updated goal TODO ${node.id} ${node.path}: blocked`, summary, [node]) }], details: { goalId, node, summary } };
    },
  });

  pi.registerTool({
    name: "split_goal_todo",
    label: "Split Goal TODO",
    description: "Split a /goal TODO into bounded subtodos, respecting max depth and fanout policy.",
    promptSnippet: "Use when a TODO is too broad or needs delegation; keep subtodos bounded.",
    parameters: SplitGoalTodoParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal_todo"))} ${theme.fg("accent", `split ${args.todo_id} +${args.titles.length}`)}`, 0, 0);
    },
    renderResult(result) {
      return new Text(renderGoalTodoResultText(result), 0, 0);
    },
    async execute(_toolCallId, params) {
      const goalId = currentGoalId(state);
      const nodes = splitGoalTodo(pi, state, goalId, params.todo_id, params.titles, "tool");
      const summary = summarizeGoalTodos(state.goalTodos, goalId);
      return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `split goal TODO ${params.todo_id} into ${nodes.length} child TODO(s)`, summary, nodes) }], details: { goalId, nodes, summary } };
    },
  });

  pi.registerTool({
    name: "validate_goal_todo_claim",
    label: "Validate Goal TODO Claim",
    description: "Record oracle validation for a returned delegated TODO claim; auto-accepts only on strict PASS/no_ship=false when requested.",
    promptSnippet: "Use after oracle claim validation output is available; preserves parent-owned TODO state and blocks unsafe claims.",
    parameters: ValidateGoalTodoClaimParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state);
      const node = recordGoalTodoClaimValidationResult(pi, state, goalId, params.todo_id, {
        result: {
          todoId: params.todo_id,
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
      }, "tool");
      return { content: [{ type: "text", text: `validated delegated claim for TODO ${node.path}: ${node.status}` }], details: { goalId, node, summary: summarizeGoalTodos(state.goalTodos, goalId) } };
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
      const node = resolveGoalTodo(pi, state, goalId, params.todo_id, { action: "accept_claim", evidenceRefs: params.evidence_refs, validationCommands: params.validation_commands, repoRoot: ctx.cwd }, "tool");
      return { content: [{ type: "text", text: `accepted delegated claim for TODO ${node.path}: ${node.title}` }], details: { goalId, node, summary: summarizeGoalTodos(state.goalTodos, goalId) } };
    },
  });

  pi.registerTool({
    name: "reject_goal_todo_claim",
    label: "Reject Goal TODO Claim",
    description: "Parent-owned rejection of a delegated TODO claim with a reason.",
    promptSnippet: "Reject delegated claims when evidence is missing or no_ship remains.",
    parameters: ClaimGoalTodoParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state);
      if (!params.reason) throw new Error("reject_goal_todo_claim requires reason.");
      const node = resolveGoalTodo(pi, state, goalId, params.todo_id, { action: "reject_claim", reason: params.reason, repoRoot: ctx.cwd }, "tool");
      return { content: [{ type: "text", text: `rejected delegated claim for TODO ${node.path}: ${node.title}` }], details: { goalId, node, summary: summarizeGoalTodos(state.goalTodos, goalId) } };
    },
  });

  pi.registerTool({
    name: "import_factory_todos",
    label: "Import Factory TODOs",
    description: "Import a factory run's reports/checkpoints/sentinels as /goal TODO evidence refs. Bodies are not copied into TODO state.",
    promptSnippet: "Use when a factory run should become goal-linked TODO evidence; cite reports/factory-runs artifacts only.",
    parameters: ImportGoalTodoRunParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalId = currentGoalId(state, params.goal_id);
      const result = importFactoryRunTodos(pi, state, ctx.cwd, goalId, params.run_id);
      const summary = summarizeGoalTodos(state.goalTodos, goalId);
      return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `imported ${result.imported} factory TODO node(s) for ${result.runId}; evidence=${result.evidenceRefs.length}; missing=${result.missingRefs.length}`, summary, result.nodes) }], details: { goalId, result, summary } };
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
      const result = importOrchestrationRunTodos(pi, state, ctx.cwd, goalId, params.run_id);
      const summary = summarizeGoalTodos(state.goalTodos, goalId);
      return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `imported ${result.imported} orchestration TODO node(s) for ${result.runId}; evidence=${result.evidenceRefs.length}; missing=${result.missingRefs.length}`, summary, result.nodes) }], details: { goalId, result, summary } };
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
      const result = importChainRunTodos(pi, state, ctx.cwd, goalId, params.run_id);
      const summary = summarizeGoalTodos(state.goalTodos, goalId);
      return { content: [{ type: "text", text: formatGoalTodoToolResult(goalId, `imported ${result.imported} chain TODO node(s) for ${result.runId}; evidence=${result.evidenceRefs.length}; missing=${result.missingRefs.length}`, summary, result.nodes) }], details: { goalId, result, summary } };
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create ZOB Goal",
    description: "Create a ZOB runtime goal. Fails if a non-complete goal already exists.",
    promptSnippet: "Create a ZOB runtime goal only when the user asks to track a long-running objective.",
    parameters: CreateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (state.runtimeGoal && state.runtimeGoal.status !== "complete") throw new Error("A non-complete ZOB runtime goal already exists. Use propose_goal_completion, update_goal, resume_goal, /goal clear, or /goal <objective> to replace it.");
      const gate = maybeStructuredGate(params.objective);
      if (gate) state.activeGoal = gate;
      const goal = createRuntimeGoal(gate?.activeGoal ?? params.objective, { gate, gateRequired: state.goalRequired, maxTurns: params.max_turns });
      appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
      queueRuntimeGoalContinuation(pi, state, ctx);
      return { content: [{ type: "text", text: formatRuntimeGoalSummary(goal, state.goalActivationMode) }], details: { goal } };
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
      if (goal.status !== "paused" && goal.status !== "blocked" && goal.status !== "oracle_failed") throw new Error(`Only paused, blocked, or oracle_failed goals can be resumed; current status is ${goal.status}.`);
      const resumeReason = params.resume_reason.trim();
      if (!resumeReason) throw new Error("resume_reason is required to resume a ZOB runtime goal.");
      const previousStatus = goal.status;
      const resumed = resumeRuntimeGoal(goal, params.additional_turns);
      const resumeReasonHash = sha256(resumeReason);
      clearRuntimeGoalContinuationStateFor(state, goal.goalId);
      appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
      if (params.queue_continuation === true) queueRuntimeGoalContinuation(pi, state, ctx);
      const currentGoal = state.runtimeGoal ?? goal;
      const extensionNote = resumed.additionalTurns ? ` · turn window extended +${resumed.additionalTurns} to ${currentGoal.loop.maxTurns}` : "";
      const blockerNote = resumed.previousBlocker ? ` · cleared blocker: ${resumed.previousBlocker}` : "";
      return { content: [{ type: "text", text: `goal resumed from ${previousStatus}${extensionNote}${blockerNote}\nresume_reason_hash: ${resumeReasonHash}\n${formatRuntimeGoalSummary(currentGoal, state.goalActivationMode)}` }], details: { goal: currentGoal, previousStatus, previousBlocker: resumed.previousBlocker, additionalTurns: resumed.additionalTurns, resumeReasonHash, queuedContinuation: params.queue_continuation === true } };
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
      if (goal.status !== "active") throw new Error(`Goal must be active to propose completion; current status is ${goal.status}.`);
      const diagnostics = goalTodoCompletionDiagnostics(state.goalTodos, goal.goalId);
      if (params.no_ship === true || diagnostics.effectiveNoShip) {
        const reviewBlockers = state.goalTodos.nodes
          .filter((node) => node.goalId === goal.goalId && node.reviewNoShip === true)
          .map((node) => `todo ${node.path} '${node.title}' has unresolved review_no_ship${node.blocker ? `: ${node.blocker}` : ""}`);
        const blockers = [
          params.no_ship === true ? "proposal submitted with no_ship=true" : undefined,
          ...diagnostics.completionBlockers,
          ...reviewBlockers,
        ].filter((blocker): blocker is string => typeof blocker === "string" && blocker.length > 0);
        throw new Error(`Cannot propose goal completion: hard_no_ship=${diagnostics.hardNoShip} review_no_ship=${diagnostics.reviewNoShip} effective_no_ship=${diagnostics.effectiveNoShip}\n- ${blockers.join("\n- ") || "diagnostics report no_ship; inspect get_goal_todos.details.diagnostics"}`);
      }
      goal.status = "ready_for_oracle";
      goal.loop.enabled = false;
      goal.oracle.status = "needed";
      goal.completionProposal = {
        proposedAt: new Date().toISOString(),
        summaryHash: sha256(params.completion_summary),
        requirementsChecked: params.requirements_checked,
        evidenceRefs: params.evidence_refs,
        validationCommands: params.validation_commands,
        knownRisks: params.known_risks,
        noShip: params.no_ship,
      };
      goal.updatedAt = unixSeconds();
      appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
      return { content: [{ type: "text", text: `goal ready_for_oracle; oracle required before update_goal complete\n${formatRuntimeGoalSummary(goal, state.goalActivationMode)}` }], details: { goal } };
    },
  });

  pi.registerTool({
    name: "record_goal_oracle",
    label: "Record Goal Oracle",
    description: "Record a parent/oracle review for a proposed ZOB runtime goal completion.",
    promptSnippet: "Record oracle PASS/WARN/FAIL for a ready_for_oracle goal; PASS and no_ship=false are required before update_goal complete.",
    parameters: OracleParams,
    async execute(_toolCallId, params) {
      const goal = recordOracleVerdict(pi, state, params.verdict, params.no_ship, params.evidence_summary, params.evidence_refs ?? []);
      if (!goal) throw new Error("No ZOB runtime goal exists.");
      return { content: [{ type: "text", text: formatRuntimeGoalSummary(goal, state.goalActivationMode) }], details: { goal } };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update ZOB Goal",
    description: "Mark the ZOB runtime goal complete only after propose_goal_completion and oracle PASS/no_ship=false.",
    promptSnippet: "Mark goal complete only after an oracle PASS/no_ship=false proves all requirements are done.",
    promptGuidelines: [
      "Never call update_goal complete before propose_goal_completion.",
      "Never call update_goal complete without oracle PASS and no_ship=false.",
      "If oracle failed or evidence is incomplete, resume the goal instead of completing it.",
    ],
    parameters: UpdateGoalParams,
    async execute() {
      const goal = state.runtimeGoal;
      if (!goal) throw new Error("No ZOB runtime goal exists.");
      if (goal.status === "complete") return { content: [{ type: "text", text: formatRuntimeGoalSummary(goal, state.goalActivationMode) }], details: { goal } };
      if (!goal.completionProposal) throw new Error("Goal completion proposal is required before update_goal complete.");
      if (goal.completionProposal.noShip === true) throw new Error("Completion proposal no_ship=false is required before update_goal complete.");
      if (goal.oracle.status !== "passed" || goal.oracle.verdict !== "PASS" || goal.oracle.noShip !== false) throw new Error("Oracle PASS/no_ship=false is required before update_goal complete.");
      goal.status = "complete";
      goal.loop.enabled = false;
      goal.updatedAt = unixSeconds();
      appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
      return { content: [{ type: "text", text: formatRuntimeGoalSummary(goal, state.goalActivationMode) }], details: { goal } };
    },
  });
}
