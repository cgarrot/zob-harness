import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HarnessRuntimeState } from "../../../runtime/state.js";
import type { GoalRoomTodoReducerDecision, GoalTodoEvent, GoalTodoNode, GoalTodoState } from "../goal-todo-types.js";
import { SHA256_HEX, VALID_CHILD_GOAL_STATUS, VALID_STATUS_CLAIM, VALID_TARGET_READINESS, ZOB_GOAL_TODO_ENTRY_TYPE } from "./constants.js";
import { applyEvent, baseTodoReducerDecision, cloneNode, goalRoomMessageString, goalRoomMetadata, includesString, metadataString, reducerStringArray } from "./normalize.js";
import { authorizeGoalTodoTransition, blockGoalTodo, hasOnlyNoneLike, patchGoalTodo, returnGoalTodoClaim } from "./operations.js";
import { cloneGoalMutationReceiptState, createGoalMutationReceiptState } from "../mutation-cas.js";

export function reduceGoalRoomEventToTodoDecision(message: Record<string, unknown>): GoalRoomTodoReducerDecision {
  const decision = baseTodoReducerDecision(message);
  const kind = goalRoomMessageString(message, "kind");
  const bodyHash = goalRoomMessageString(message, "bodyHash");
  const metadata = goalRoomMetadata(message);
  decision.validationCommands = reducerStringArray(metadata.validationCommands);
  decision.acceptanceBlockers = reducerStringArray(metadata.acceptanceBlockers);
  decision.noShip = typeof metadata.noShip === "boolean" ? metadata.noShip : kind === "NO_SHIP_ALERT" ? true : undefined;
  decision.childGoalStatus = includesString(VALID_CHILD_GOAL_STATUS, metadata.childGoalStatus) ? metadata.childGoalStatus : undefined;
  decision.statusClaim = includesString(VALID_STATUS_CLAIM, metadata.statusClaim) ? metadata.statusClaim : undefined;
  decision.targetReadiness = includesString(VALID_TARGET_READINESS, metadata.targetReadiness) ? metadata.targetReadiness : undefined;
  decision.outputHash = goalRoomMessageString(message, "outputHash") ?? metadataString(metadata, "outputHash");

  if (message.schema !== "zob.goal-room-message.v1") decision.reasonCodes.push("invalid_schema");
  if (message.parentOwnedActions !== true || message.workerToWorkerDirect !== false || message.hiddenPeerChat !== false) decision.reasonCodes.push("not_parent_owned_visible_event");
  if (message.bodyStored !== false || message.promptBodiesStored !== false || message.outputBodiesStored !== false) decision.reasonCodes.push("not_body_free");
  if (!decision.goalId) decision.reasonCodes.push("missing_goal_id");
  if (!decision.todoId) decision.reasonCodes.push("missing_todo_id");
  if (!bodyHash || !SHA256_HEX.test(bodyHash)) decision.reasonCodes.push("missing_body_hash");
  if (kind && !["TODO_CLAIM", "BLOCKER", "NO_SHIP_ALERT", "ORACLE_REQUEST", "HANDOFF", "DECISION", "STATUS_UPDATE", "ACTION_TAKEN", "ARTIFACT_READY", "FINDING", "RISK"].includes(kind)) decision.reasonCodes.push("unsupported_kind");
  if (decision.reasonCodes.length > 0) return decision;
  const validBodyHash = bodyHash as string;

  if (kind === "TODO_CLAIM") {
    const artifactRefs = reducerStringArray(message.artifactRefs);
    const evidenceRefs = [...new Set([...decision.evidenceRefs, ...artifactRefs])];
    decision.claimHash = validBodyHash;
    decision.outputHash = decision.outputHash && SHA256_HEX.test(decision.outputHash) ? decision.outputHash : validBodyHash;
    decision.evidenceRefs = evidenceRefs;
    if (decision.childGoalStatus !== "ready_for_oracle") decision.reasonCodes.push("child_status_not_ready");
    if (decision.statusClaim !== "done") decision.reasonCodes.push("child_status_claim_not_done");
    if (decision.targetReadiness !== "ready_for_parent_acceptance") decision.reasonCodes.push("target_not_ready");
    if (decision.noShip !== false) decision.reasonCodes.push("no_ship_not_clear");
    if (!hasOnlyNoneLike(decision.acceptanceBlockers)) decision.reasonCodes.push("acceptance_blockers_present");
    if (evidenceRefs.length === 0) decision.reasonCodes.push("missing_evidence_refs");
    if (decision.reasonCodes.length > 0) return decision;
    decision.action = "return_claim";
    return decision;
  }

  if (kind === "BLOCKER" || kind === "NO_SHIP_ALERT") {
    decision.action = "block";
    decision.claimHash = validBodyHash;
    decision.noShip = true;
    decision.acceptanceBlockers = [...new Set([...decision.acceptanceBlockers, `${kind.toLowerCase()}_${validBodyHash.slice(0, 12)}`])];
    return decision;
  }

  if (message.requiresParentAction === true) {
    decision.action = "mark_needs_review";
    decision.claimHash = validBodyHash;
    decision.acceptanceBlockers = [...new Set([...decision.acceptanceBlockers, `parent_action_required_${validBodyHash.slice(0, 12)}`])];
    return decision;
  }

  decision.reasonCodes.push("status_only_no_todo_mutation");
  return decision;
}

export function applyGoalRoomEventTodoReducer(pi: ExtensionAPI, state: HarnessRuntimeState, message: Record<string, unknown>): { decision: GoalRoomTodoReducerDecision; node?: GoalTodoNode } {
  const decision = reduceGoalRoomEventToTodoDecision(message);
  const activeGoalId = state.runtimeGoal?.goalId;
  if (!activeGoalId || activeGoalId !== decision.goalId || !decision.todoId) return { decision };
  if (decision.action === "return_claim" && decision.claimHash) {
    const node = returnGoalTodoClaim(pi, state, activeGoalId, decision.todoId, {
      claimHash: decision.claimHash,
      evidenceRefs: decision.evidenceRefs,
      validationCommands: decision.validationCommands,
      noShip: decision.noShip,
      runId: decision.runId,
      outputHash: decision.outputHash,
      outputContract: metadataString(goalRoomMetadata(message), "outputContract") ?? "agent-event.v1",
      gatePassed: decision.noShip !== true && decision.acceptanceBlockers.length === 0,
      childGoalStatus: decision.childGoalStatus,
      statusClaim: decision.statusClaim,
      targetReadiness: decision.targetReadiness,
      acceptanceBlockers: decision.acceptanceBlockers,
    }, "runtime");
    return { decision, node: node ? cloneNode(node) : undefined };
  }
  if (decision.action === "block") {
    const node = blockGoalTodo(pi, state, activeGoalId, decision.todoId, `goal-room ${decision.sourceKind ?? "event"} ${decision.claimHash?.slice(0, 12) ?? "hash"} requires parent review`, "runtime");
    return { decision, node: cloneNode(node) };
  }
  if (decision.action === "mark_needs_review") {
    const existing = state.goalTodos.nodes.find((candidate) => candidate.goalId === activeGoalId && candidate.id === decision.todoId);
    if (!existing) return { decision };
    const reason = `goal-room event ${decision.claimHash?.slice(0, 12) ?? "hash"} requires parent action`;
    const authorization = authorizeGoalTodoTransition(existing, "mark_needs_review", { reason });
    const node = patchGoalTodo(pi, state, activeGoalId, decision.todoId, { status: authorization.decision.nextStatus, owner: "agent", blocker: reason, reviewNoShip: decision.noShip === true }, "runtime", authorization);
    return { decision, node: cloneNode(node) };
  }
  return { decision };
}

export function appendGoalTodoEvent(pi: ExtensionAPI, state: HarnessRuntimeState, event: GoalTodoEvent): GoalTodoEvent {
  state.goalTodos.graphRevisions ??= {};
  state.goalTodos.revisionDiagnostics ??= [];
  state.goalTodos.restoreBlocked ??= {};
  state.goalTodos.mutationReceipts ??= createGoalMutationReceiptState();
  const blocked = state.goalTodos.restoreBlocked[event.goalId];
  if (blocked) throw new Error(`Goal/TODO stream restore-blocked: ${blocked.message}`);
  const todoId = event.kind === "add"
    ? event.node.id
    : "todoId" in event && event.kind !== "focus" ? event.todoId : undefined;
  const existing = todoId ? state.goalTodos.nodes.find((node) => node.goalId === event.goalId && node.id === todoId) : undefined;
  const revisioned: GoalTodoEvent = event.version === 2
    ? event
    : {
      ...event,
      version: 2,
      graphRevision: (state.goalTodos.graphRevisions[event.goalId] ?? 0) + 1,
      nodeRevision: todoId ? (existing ? (existing.revision ?? 0) + 1 : 1) : undefined,
    } as GoalTodoEvent;
  const shadow: GoalTodoState = {
    nodes: state.goalTodos.nodes.map(cloneNode),
    policy: { ...state.goalTodos.policy },
    graphRevisions: { ...state.goalTodos.graphRevisions },
    revisionDiagnostics: [],
    restoreBlocked: Object.fromEntries(Object.entries(state.goalTodos.restoreBlocked).map(([goalId, diagnostic]) => [goalId, { ...diagnostic }])),
    mutationReceipts: cloneGoalMutationReceiptState(state.goalTodos.mutationReceipts),
    focusTodoId: state.goalTodos.focusTodoId,
  };
  if (!applyEvent(shadow, revisioned)) {
    const rejected = shadow.restoreBlocked?.[event.goalId];
    if (rejected && !state.goalTodos.restoreBlocked[event.goalId]) state.goalTodos.restoreBlocked[event.goalId] = { ...rejected };
    state.goalTodos.revisionDiagnostics.push(...shadow.revisionDiagnostics.map((diagnostic) => ({ ...diagnostic })));
    throw new Error(rejected ? `Goal/TODO stream restore-blocked: ${rejected.message}` : "Goal/TODO v2 revision event rejected");
  }
  pi.appendEntry(ZOB_GOAL_TODO_ENTRY_TYPE, revisioned);
  applyEvent(state.goalTodos, revisioned);
  return revisioned;
}

export function nextTodoId(): string {
  return `todo_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function goalNodes(todoState: GoalTodoState, goalId: string): GoalTodoNode[] {
  return todoState.nodes.filter((node) => node.goalId === goalId).map(cloneNode);
}
