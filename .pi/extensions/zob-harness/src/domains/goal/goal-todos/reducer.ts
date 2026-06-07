import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HarnessRuntimeState } from "../../../runtime/state.js";
import type { GoalRoomTodoReducerDecision, GoalTodoEvent, GoalTodoNode, GoalTodoState } from "../goal-todo-types.js";
import { SHA256_HEX, VALID_CHILD_GOAL_STATUS, VALID_STATUS_CLAIM, VALID_TARGET_READINESS, ZOB_GOAL_TODO_ENTRY_TYPE } from "./constants.js";
import { applyEvent, baseTodoReducerDecision, cloneNode, goalRoomMessageString, goalRoomMetadata, includesString, metadataString, reducerStringArray } from "./normalize.js";
import { blockGoalTodo, patchGoalTodo, returnGoalTodoClaim } from "./operations.js";

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
    decision.action = "return_claim";
    decision.claimHash = validBodyHash;
    decision.outputHash = decision.outputHash && SHA256_HEX.test(decision.outputHash) ? decision.outputHash : validBodyHash;
    decision.evidenceRefs = evidenceRefs;
    decision.statusClaim = decision.statusClaim ?? "done";
    decision.childGoalStatus = decision.childGoalStatus ?? "ready_for_oracle";
    decision.targetReadiness = decision.targetReadiness ?? (decision.noShip === true || decision.acceptanceBlockers.length > 0 ? "needs_parent_review" : "ready_for_parent_acceptance");
    if (evidenceRefs.length === 0) decision.acceptanceBlockers = [...new Set([...decision.acceptanceBlockers, "missing_evidence_refs"] )];
    if (decision.acceptanceBlockers.length > 0 && decision.noShip !== true) decision.noShip = true;
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
    const node = patchGoalTodo(pi, state, activeGoalId, decision.todoId, { status: "needs_review", owner: "agent", blocker: `goal-room event ${decision.claimHash?.slice(0, 12) ?? "hash"} requires parent action`, reviewNoShip: decision.noShip === true }, "runtime");
    return { decision, node: cloneNode(node) };
  }
  return { decision };
}

export function appendGoalTodoEvent(pi: ExtensionAPI, state: HarnessRuntimeState, event: GoalTodoEvent): GoalTodoEvent {
  pi.appendEntry(ZOB_GOAL_TODO_ENTRY_TYPE, event);
  applyEvent(state.goalTodos, event);
  return event;
}

export function nextTodoId(): string {
  return `todo_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function goalNodes(todoState: GoalTodoState, goalId: string): GoalTodoNode[] {
  return todoState.nodes.filter((node) => node.goalId === goalId).map(cloneNode);
}
