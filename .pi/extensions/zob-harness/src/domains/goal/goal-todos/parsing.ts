import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HarnessRuntimeState } from "../../../runtime/state.js";
import type { GoalTodoChildGoalStatus, GoalTodoClaimTargetReadiness, GoalTodoCommandResult, GoalTodoEventSource, GoalTodoNode, GoalTodoStatusClaim, TodoClaimValidationResult, TodoPeerResultItem, TodoPeerResultParseResult, TodoSplitRequest } from "../goal-todo-types.js";
import { VALID_OWNER, VALID_PRIORITY } from "./constants.js";
import { formatGoalTodoTree, summarizeGoalTodos } from "./formatting.js";
import { includesString } from "./normalize.js";
import { addGoalTodo, completeGoalTodo, focusGoalTodo, patchGoalTodo, resolveGoalTodo, splitGoalTodo } from "./operations.js";

export function extractTodoClaimFromText(text: string): { todoId?: string; childGoalStatus?: GoalTodoChildGoalStatus; statusClaim?: GoalTodoStatusClaim; evidenceRefs: string[]; validationCommands: string[]; noShip?: boolean; hasFinalMarker: boolean; subtodoDeltaProposals: string[]; acceptanceBlockers: string[]; targetReadiness?: GoalTodoClaimTargetReadiness; risksBlockers: string[] } {
  const todoIdMatch = text.match(/todo_id\s*[:=]\s*([^\s]+)/i);
  const statusMatch = text.match(/child_goal_status\s*[:=]\s*(ready_for_oracle|incomplete|blocked)/i);
  const statusClaimMatch = text.match(/status_claim\s*[:=]\s*(done|incomplete|blocked)/i);
  const noShipMatch = text.match(/no_ship\s*[:=]\s*(true|yes|false|no)/i);
  const targetReadinessRaw = text.match(/target_readiness\s*[:=]\s*(ready_for_parent_acceptance|needs_parent_review|blocked)/i)?.[1]?.toLowerCase();
  const lines = text.split(/\r?\n/);
  const collectAfter = (label: RegExp): string[] => {
    const result: string[] = [];
    let collecting = false;
    for (const line of lines) {
      if (label.test(line)) {
        collecting = true;
        const inline = line.split(/[:=]/).slice(1).join(":").trim();
        if (inline && !/^\s*$/.test(inline)) result.push(inline.replace(/^[-*]\s*/, ""));
        continue;
      }
      if (collecting) {
        if (/^[A-Za-z_ -]+\s*[:=]/.test(line) && !/^\s*[-*]/.test(line)) break;
        const item = line.trim().replace(/^[-*]\s*/, "");
        if (item) result.push(item);
      }
    }
    return result.filter((item) => item.length > 0);
  };
  return {
    todoId: todoIdMatch?.[1]?.trim(),
    childGoalStatus: statusMatch?.[1]?.toLowerCase() as GoalTodoChildGoalStatus | undefined,
    statusClaim: statusClaimMatch?.[1]?.toLowerCase() as GoalTodoStatusClaim | undefined,
    evidenceRefs: collectAfter(/^\s*evidence_refs\s*[:=]/i),
    validationCommands: collectAfter(/^\s*validation_commands\s*[:=]/i),
    noShip: noShipMatch ? /^(true|yes)$/i.test(noShipMatch[1]) : undefined,
    targetReadiness: targetReadinessRaw as GoalTodoClaimTargetReadiness | undefined,
    acceptanceBlockers: collectAfter(/^\s*acceptance_blockers\s*[:=]/i).filter((item) => !/^(none|n\/a|null)$/i.test(item)),
    risksBlockers: collectAfter(/^\s*risks_blockers\s*[:=]/i),
    hasFinalMarker: /FINAL_MARKER\s*:\s*(TODO_CHILD_RESULT_END|TODO_CHILD_RESULT_V2_END)|TODO_CHILD_RESULT_END|TODO_CHILD_RESULT_V2_END/.test(text),
    subtodoDeltaProposals: collectAfter(/^\s*subtodo_delta_proposals\s*[:=]/i),
  };
}

export function collectLabeledLines(text: string, label: RegExp): string[] {
  const result: string[] = [];
  let collecting = false;
  for (const line of text.split(/\r?\n/)) {
    if (label.test(line)) {
      collecting = true;
      const inline = line.split(/[:=]/).slice(1).join(":").trim();
      if (inline) result.push(inline.replace(/^[-*]\s*/, ""));
      continue;
    }
    if (collecting) {
      const labelLine = /^\s*(?:[-*]\s*)?[A-Za-z_ -]+\s*[:=]/.test(line);
      const indentedBulletItem = /^\s{2,}[-*]\s+/.test(line);
      if (labelLine && !indentedBulletItem) break;
      const item = line.trim().replace(/^[-*]\s*/, "");
      if (item) result.push(item);
    }
  }
  return result.map((item) => item.trim()).filter((item) => item.length > 0 && !/^(none|n\/a|null)$/i.test(item));
}

export function extractLabeledScalar(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^\\s*(?:[-*]\\s*)?${label}\\s*[:=]\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

export function normalizePeerStatusClaim(value: string | undefined): TodoPeerResultItem["statusClaim"] {
  const normalized = value?.trim().toLowerCase().replace(/[ -]/g, "_");
  return normalized === "done" || normalized === "incomplete" || normalized === "blocked" ? normalized : undefined;
}

export function extractTodoPeerResultItemFromText(text: string, hasFinalMarker: boolean): TodoPeerResultItem {
  const todoIdMatch = text.match(/todo_id\s*[:=]\s*([^\s]+)/i);
  const statusRaw = extractLabeledScalar(text, "status_claim") ?? extractLabeledScalar(text, "status");
  const noShipMatch = text.match(/no_ship\s*[:=]\s*(true|yes|false|no)/i);
  return {
    todoId: todoIdMatch?.[1]?.trim(),
    statusClaim: normalizePeerStatusClaim(statusRaw),
    evidenceRefs: collectLabeledLines(text, /^\s*(?:[-*]\s*)?evidence_refs\s*[:=]/i),
    validationCommands: collectLabeledLines(text, /^\s*(?:[-*]\s*)?validation_commands\s*[:=]/i),
    risks: collectLabeledLines(text, /^\s*(?:[-*]\s*)?risks\s*[:=]/i),
    acceptanceBlockers: collectLabeledLines(text, /^\s*(?:[-*]\s*)?acceptance_blockers\s*[:=]/i),
    noShip: noShipMatch ? /^(true|yes)$/i.test(noShipMatch[1]) : undefined,
    hasFinalMarker,
  };
}

export function extractTodoPeerResultFromText(text: string): TodoPeerResultParseResult {
  const bundle = /TODO_PEER_BUNDLE_RESULT\.v1/i.test(text);
  const single = /TODO_PEER_RESULT\.v1/i.test(text);
  const hasBundleMarker = /FINAL_MARKER\s*:\s*TODO_PEER_BUNDLE_RESULT_END|TODO_PEER_BUNDLE_RESULT_END/.test(text);
  const hasSingleMarker = /FINAL_MARKER\s*:\s*TODO_PEER_RESULT_END|TODO_PEER_RESULT_END/.test(text);
  const contract = bundle ? "TODO_PEER_BUNDLE_RESULT.v1" : single ? "TODO_PEER_RESULT.v1" : undefined;
  const hasFinalMarker = bundle ? hasBundleMarker : single ? hasSingleMarker : false;
  const errors: string[] = [];
  if (!contract) return { items: [], hasFinalMarker: false, errors };
  if (!hasFinalMarker) errors.push("missing_final_marker");
  const itemTexts = bundle
    ? text.split(/(?=^\s*(?:[-*]\s*)?todo_id\s*[:=])/gim).filter((part) => /todo_id\s*[:=]/i.test(part))
    : [text];
  const items = itemTexts.map((part) => extractTodoPeerResultItemFromText(part, hasFinalMarker));
  if (items.length === 0) errors.push("missing_result_items");
  for (const item of items) {
    if (!item.todoId) errors.push("missing_todo_id");
    if (!item.statusClaim) errors.push(`missing_status_claim:${item.todoId ?? "unknown"}`);
    if (item.statusClaim === "done" && item.evidenceRefs.length === 0 && item.validationCommands.length === 0) errors.push(`missing_evidence_for_done:${item.todoId ?? "unknown"}`);
    if (item.noShip === true) errors.push(`no_ship_true:${item.todoId ?? "unknown"}`);
  }
  return { contract, items, hasFinalMarker, errors: [...new Set(errors)] };
}

export function extractTodoClaimValidationFromText(text: string): TodoClaimValidationResult {
  const todoIdMatch = text.match(/todo_id\s*[:=]\s*([^\s]+)/i);
  const claimHashMatch = text.match(/claim_hash\s*[:=]\s*([a-f0-9]{64})/i);
  const verdictRaw = extractLabeledScalar(text, "verdict")?.toUpperCase();
  const actionRaw = extractLabeledScalar(text, "recommended_action")?.toLowerCase().replace(/[ -]/g, "_");
  const noShipMatch = text.match(/no_ship\s*[:=]\s*(true|yes|false|no)/i);
  const confidenceRaw = extractLabeledScalar(text, "confidence")?.toUpperCase();
  return {
    todoId: todoIdMatch?.[1]?.trim(),
    claimHash: claimHashMatch?.[1]?.trim(),
    verdict: verdictRaw === "PASS" || verdictRaw === "WARN" || verdictRaw === "FAIL" ? verdictRaw : undefined,
    recommendedAction: actionRaw === "accept_claim" || actionRaw === "needs_review" || actionRaw === "reject_claim" || actionRaw === "block" ? actionRaw : undefined,
    evidenceRefs: collectLabeledLines(text, /^\s*(?:[-*]\s*)?evidence_refs\s*[:=]/i),
    validationCommands: collectLabeledLines(text, /^\s*(?:[-*]\s*)?validation_commands\s*[:=]/i),
    blockingIssues: collectLabeledLines(text, /^\s*(?:[-*]\s*)?blocking_issues\s*[:=]/i),
    noShip: noShipMatch ? /^(true|yes)$/i.test(noShipMatch[1]) : undefined,
    confidence: confidenceRaw === "LOW" || confidenceRaw === "MEDIUM" || confidenceRaw === "HIGH" ? confidenceRaw : undefined,
    hasFinalMarker: /FINAL_MARKER\s*:\s*TODO_CLAIM_VALIDATION_END|TODO_CLAIM_VALIDATION_END/.test(text),
  };
}

export function isActionableTodoClaimValidation(result: TodoClaimValidationResult, todoId: string, claimHash?: string): boolean {
  return result.todoId === todoId
    && result.hasFinalMarker
    && Boolean(result.verdict)
    && Boolean(result.recommendedAction)
    && Boolean(result.confidence)
    && result.noShip !== undefined
    && (!claimHash || result.claimHash === claimHash);
}

export function extractTodoSplitRequestFromText(text: string): TodoSplitRequest {
  const todoIdMatch = text.match(/todo_id\s*[:=]\s*([^\s]+)/i);
  const actionRaw = extractLabeledScalar(text, "recommended_action")?.toLowerCase().replace(/[ -]/g, "_");
  const riskRaw = extractLabeledScalar(text, "risk_level")?.toLowerCase();
  const noShipMatch = text.match(/no_ship\s*[:=]\s*(true|yes|false|no)/i);
  return {
    todoId: todoIdMatch?.[1]?.trim(),
    reason: extractLabeledScalar(text, "reason"),
    recommendedAction: actionRaw === "split" || actionRaw === "replan" || actionRaw === "factory" || actionRaw === "needs_user" || actionRaw === "blocked" ? actionRaw : undefined,
    proposedSubtodos: collectLabeledLines(text, /^\s*(?:[-*]\s*)?proposed_subtodos\s*[:=]/i),
    riskLevel: riskRaw === "low" || riskRaw === "medium" || riskRaw === "high" ? riskRaw : undefined,
    validationPlan: collectLabeledLines(text, /^\s*(?:[-*]\s*)?validation_plan\s*[:=]/i),
    noShip: noShipMatch ? /^(true|yes)$/i.test(noShipMatch[1]) : undefined,
    hasFinalMarker: /FINAL_MARKER\s*:\s*TODO_SPLIT_REQUEST_END|TODO_SPLIT_REQUEST_END/.test(text),
  };
}

export function isActionableTodoSplitRequest(request: TodoSplitRequest, todoId: string): boolean {
  return request.todoId === todoId
    && request.hasFinalMarker
    && request.recommendedAction === "split"
    && request.noShip !== true
    && request.proposedSubtodos.length > 0;
}

export function applyTodoSplitRequest(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, request: TodoSplitRequest, source: GoalTodoEventSource = "delegation"): GoalTodoNode[] {
  if (!isActionableTodoSplitRequest(request, todoId)) throw new Error(`TODO split request for ${todoId} is not actionable.`);
  const titles = request.proposedSubtodos.map((title) => title.trim()).filter(Boolean);
  const children = splitGoalTodo(pi, state, goalId, todoId, titles, source);
  completeGoalTodo(pi, state, goalId, todoId, { skipped: true, reason: `decomposed into ${children.length} child TODO(s) by TODO_SPLIT_REQUEST`, validationCommands: request.validationPlan }, source);
  return children;
}

export function parseOptionValue(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
}

export function stripKnownOptions(text: string): string {
  return text
    .replace(/(^|\s)--parent\s+\S+/g, " ")
    .replace(/(^|\s)--owner\s+\S+/g, " ")
    .replace(/(^|\s)--priority\s+\S+/g, " ")
    .replace(/(^|\s)--optional\b/g, " ")
    .replace(/(^|\s)--required\b/g, " ")
    .replace(/(^|\s)--evidence\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function handleGoalTodoTextCommand(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string | undefined, text: string, repoRoot?: string): GoalTodoCommandResult {
  if (!goalId) return { ok: false, message: "Goal TODOs require an active runtime goal. Use /goal <objective> first." };
  const trimmed = text.trim();
  if (!trimmed || trimmed === "list" || trimmed === "tree" || trimmed === "status") return { ok: true, message: formatGoalTodoTree(state.goalTodos, goalId) };
  if (trimmed === "next") {
    const summary = summarizeGoalTodos(state.goalTodos, goalId);
    const next = summary.nextAgent ?? summary.nextUser;
    return { ok: true, message: next ? `${next.id} ${next.path} ${next.title} [${next.status}/${next.owner}]` : "No next goal TODO found." };
  }
  const [command = "", ...rest] = trimmed.split(/\s+/);
  const body = rest.join(" ").trim();
  const tokens = rest;
  try {
    if (command === "add") {
      const ownerRaw = parseOptionValue(tokens, "--owner");
      const priorityRaw = parseOptionValue(tokens, "--priority");
      const parentId = parseOptionValue(tokens, "--parent");
      const owner = includesString(VALID_OWNER, ownerRaw) ? ownerRaw : "agent";
      const priority = includesString(VALID_PRIORITY, priorityRaw) ? priorityRaw : "normal";
      const required = tokens.includes("--optional") ? false : true;
      const title = stripKnownOptions(body);
      const node = addGoalTodo(pi, state, goalId, { title, parentId, owner, priority, required }, "command");
      return { ok: true, message: `added TODO ${node.id} ${node.path}: ${node.title}`, node };
    }
    if (command === "done" || command === "skip") {
      const todoId = rest[0];
      if (!todoId) return { ok: false, message: `Usage: /goal todo ${command} <todoId> [evidence/reason]` };
      const evidence = rest.slice(1).join(" ").replace(/^--evidence\s+/, "").trim();
      const node = resolveGoalTodo(pi, state, goalId, todoId, { action: command === "skip" ? "skip" : "complete", evidenceRefs: evidence ? [evidence] : [], reason: evidence, repoRoot }, "command");
      return { ok: true, message: `${command === "skip" ? "skipped" : "done"} TODO ${node.path}: ${node.title}`, node };
    }
    if (command === "block" || command === "user") {
      const todoId = rest[0];
      const reason = rest.slice(1).join(" ").trim();
      if (!todoId || !reason) return { ok: false, message: `Usage: /goal todo ${command} <todoId> <reason>` };
      const node = command === "user"
        ? patchGoalTodo(pi, state, goalId, todoId, { status: "needs_user", owner: "user", blocker: reason, reviewNoShip: true }, "command")
        : resolveGoalTodo(pi, state, goalId, todoId, { action: "block", reason, repoRoot }, "command");
      return { ok: true, message: `updated TODO ${node.path}: ${node.status}`, node };
    }
    if (command === "start") {
      const todoId = rest[0];
      if (!todoId) return { ok: false, message: "Usage: /goal todo start <todoId>" };
      const node = patchGoalTodo(pi, state, goalId, todoId, { status: "in_progress", owner: "agent" }, "command");
      return { ok: true, message: `started TODO ${node.path}: ${node.title}`, node };
    }
    if (command === "focus") {
      const todoId = rest[0];
      focusGoalTodo(pi, state, goalId, todoId, "command");
      return { ok: true, message: todoId ? `focused TODO ${todoId}` : "cleared TODO focus" };
    }
    if (command === "split") {
      const todoId = rest[0];
      const titles = rest.slice(1).join(" ").split(";").map((item) => item.trim()).filter(Boolean);
      if (!todoId || titles.length === 0) return { ok: false, message: "Usage: /goal todo split <todoId> child A; child B" };
      const nodes = splitGoalTodo(pi, state, goalId, todoId, titles, "command");
      return { ok: true, message: `split TODO ${todoId} into ${nodes.length} child TODO(s)` };
    }
    if (command === "accept-claim" || command === "accept") {
      const todoId = rest[0];
      if (!todoId) return { ok: false, message: `Usage: /goal todo ${command} <todoId> [evidence]` };
      const evidence = rest.slice(1).join(" ").trim();
      const node = resolveGoalTodo(pi, state, goalId, todoId, { action: "accept_claim", evidenceRefs: evidence ? [evidence] : [], repoRoot }, "command");
      return { ok: true, message: `accepted claim for TODO ${node.path}: ${node.title}`, node };
    }
    if (command === "reject-claim" || command === "reject") {
      const todoId = rest[0];
      const reason = rest.slice(1).join(" ").trim();
      if (!todoId || !reason) return { ok: false, message: `Usage: /goal todo ${command} <todoId> <reason>` };
      const node = resolveGoalTodo(pi, state, goalId, todoId, { action: "reject_claim", reason, repoRoot }, "command");
      return { ok: true, message: `rejected claim for TODO ${node.path}: ${node.title}`, node };
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: false, message: "Usage: /goal todo [tree|next|add|done|block|skip|user|start|focus|split|accept-claim|reject-claim]; primary API tool is resolve_goal_todo" };
}
