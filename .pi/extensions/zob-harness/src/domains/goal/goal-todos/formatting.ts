import type { GoalTodoCompletionDiagnostics, GoalTodoNode, GoalTodoState, GoalTodoSummary } from "../goal-todo-types.js";
import { ACTIONABLE_STATUSES, ACTIVE_STATUSES, OPEN_REQUIRED_STATUSES } from "./constants.js";
import { cloneNode } from "./normalize.js";
import { childrenOf, nextValidGoalTodoActions, validateGoalTodoGraph } from "./operations.js";
import { goalNodes } from "./reducer.js";

export function summarizeGoalTodos(todoState: GoalTodoState, goalId?: string): GoalTodoSummary {
  const nodes = goalId ? goalNodes(todoState, goalId) : todoState.nodes.map(cloneNode);
  const done = nodes.filter((node) => node.status === "done").length;
  const skipped = nodes.filter((node) => node.status === "skipped").length;
  const open = nodes.filter((node) => OPEN_REQUIRED_STATUSES.has(node.status)).length;
  const active = nodes.filter((node) => ACTIVE_STATUSES.has(node.status)).length;
  const blocked = nodes.filter((node) => node.status === "blocked").length;
  const delegated = nodes.filter((node) => node.status === "delegated" || node.delegation?.status === "running" || node.delegation?.status === "queued").length;
  const claimReturned = nodes.filter((node) => node.status === "claim_returned").length;
  const validationQueued = nodes.filter((node) => node.validation?.status === "queued").length;
  const validationRunning = nodes.filter((node) => node.validation?.status === "running").length;
  const validationPassed = nodes.filter((node) => node.validation?.status === "passed").length;
  const validationFailed = nodes.filter((node) => node.validation?.status === "failed" || node.validation?.status === "blocked" || node.validation?.status === "warn").length;
  const needsUser = nodes.filter((node) => node.status === "needs_user").length;
  const needsOracle = nodes.filter((node) => node.status === "needs_oracle").length;
  const hasOpenChildren = (node: GoalTodoNode): boolean => nodes.some((candidate) => candidate.parentId === node.id && OPEN_REQUIRED_STATUSES.has(candidate.status));
  const agentCandidates = nodes.filter((node) => node.owner === "agent" && (node.status === "ready" || node.status === "planned" || node.status === "in_progress"));
  const nextAgent = agentCandidates.find((node) => !hasOpenChildren(node)) ?? agentCandidates[0];
  const userCandidates = nodes.filter((node) => ACTIONABLE_STATUSES.has(node.status) && (node.owner === "user" || node.status === "needs_user"));
  const nextUser = userCandidates.find((node) => !hasOpenChildren(node)) ?? userCandidates[0];
  return {
    goalId,
    total: nodes.length,
    required: nodes.filter((node) => node.required).length,
    done,
    skipped,
    open,
    active,
    blocked,
    delegated,
    claimReturned,
    validationQueued,
    validationRunning,
    validationPassed,
    validationFailed,
    needsUser,
    needsOracle,
    nextAgent,
    nextUser,
  };
}

export function formatGoalTodoSummary(summary: GoalTodoSummary): string {
  if (summary.total === 0) return "todos unset";
  const closed = summary.done + summary.skipped;
  const validation = summary.validationQueued + summary.validationRunning > 0 ? ` · validation ${summary.validationQueued + summary.validationRunning}` : summary.validationFailed > 0 ? ` · validation_alerts ${summary.validationFailed}` : "";
  return `todos ${closed}/${summary.total} · open ${summary.open} · active ${summary.active} · blocked ${summary.blocked} · delegated ${summary.delegated} · claims ${summary.claimReturned}${validation}`;
}

export function formatGoalTodoHudLine(todoState: GoalTodoState, goalId: string | undefined): string {
  if (!goalId) return "todos unset";
  const summary = summarizeGoalTodos(todoState, goalId);
  const next = summary.nextAgent ? ` · next agent ${summary.nextAgent.path} ${summary.nextAgent.title}` : summary.nextUser ? ` · next user ${summary.nextUser.path} ${summary.nextUser.title}` : "";
  return `${formatGoalTodoSummary(summary)}${next}`;
}

export function formatGoalTodoPromptHint(todoState: GoalTodoState, goalId: string | undefined): string {
  if (!goalId) return "- goal_todos: no active runtime goal";
  const summary = summarizeGoalTodos(todoState, goalId);
  if (summary.total === 0) return "- goal_todos: none set; create TODOs for long, multi-step goal work when appropriate";
  return [
    `- goal_todos: ${formatGoalTodoSummary(summary)}`,
    summary.nextAgent ? `- next_agent_todo: ${summary.nextAgent.path} ${summary.nextAgent.title}` : undefined,
    summary.nextUser ? `- next_user_todo: ${summary.nextUser.path} ${summary.nextUser.title}` : undefined,
    summary.claimReturned > 0 ? "- delegated_claims: claim_returned TODOs require parent evidence checks or agentic validation; use resolve_goal_todo(action=auto|complete|accept_claim), complete_goal_todo, /goal todo done, or accept_goal_todo_claim to accept returned claims" : undefined,
    summary.validationQueued + summary.validationRunning > 0 ? `- claim_validation: ${summary.validationQueued + summary.validationRunning} oracle validation(s) queued/running; auto-accept only after PASS/no_ship=false` : undefined,
    "- completion rule: use resolve_goal_todo for done/skip/claim/block/reopen transitions; required TODOs must be done/skipped with evidence before propose_goal_completion",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function formatGoalTodoTree(todoState: GoalTodoState, goalId: string | undefined): string {
  if (!goalId) return "No active runtime goal; goal TODOs require a goalId.";
  const nodes = goalNodes(todoState, goalId);
  if (nodes.length === 0) return "No goal TODOs set. Use /goal todo add <title>.";
  const icon = (node: GoalTodoNode): string => {
    if (node.status === "done") return "✓";
    if (node.status === "skipped") return "↷";
    if (node.status === "blocked") return "▲";
    if (node.status === "delegated") return "⇄";
    if (node.status === "claim_returned") return "◇";
    if (node.status === "needs_user") return "?";
    if (node.status === "needs_oracle") return "◆";
    if (node.status === "in_progress") return "●";
    return "○";
  };
  const diagnostics = goalTodoCompletionDiagnostics(todoState, goalId);
  const lines = [formatGoalTodoSummary(summarizeGoalTodos(todoState, goalId)), formatGoalTodoDiagnostics(diagnostics)];
  const walk = (parentId: string | undefined, indent = ""): void => {
    const children = childrenOf(todoState, goalId, parentId);
    children.forEach((node, index) => {
      const last = index === children.length - 1;
      const branch = indent ? (last ? "└─" : "├─") : "";
      const required = node.required ? "req" : "opt";
      const latestAttempt = node.delegationAttempts?.at(-1);
      const delegation = latestAttempt
        ? ` · attempt ${latestAttempt.attemptId} ${latestAttempt.status}${(node.delegationAttempts?.length ?? 0) > 1 ? ` (${node.delegationAttempts?.length} total)` : ""}`
        : node.delegation?.runId ? ` · run ${node.delegation.runId}` : "";
      const claim = node.claim?.claimHash ? ` · claim ${node.claim.claimHash.slice(0, 12)} (full hash/bindings/next actions in tool details)` : "";
      const validation = node.validation ? ` · validation ${node.validation.status}${node.validation.verdict ? `/${node.validation.verdict}` : ""}${node.validation.runId ? ` ${node.validation.runId}` : ""}` : "";
      const blocker = node.blocker ? ` · blocker ${node.blocker}` : "";
      lines.push(`${indent}${branch}${icon(node)} ${node.path} ${node.title} [${node.status}/${node.owner}/${required}/${node.priority}] · id ${node.id}${delegation}${claim}${validation}${blocker}`);
      walk(node.id, `${indent}${last ? "  " : "│ "}`);
    });
  };
  walk(undefined);
  return lines.join("\n");
}

export function goalTodoCompletionBlockers(todoState: GoalTodoState, goalId: string | undefined): string[] {
  if (!goalId) return [];
  const nodes = goalNodes(todoState, goalId);
  if (nodes.length === 0) return [];
  const blockers: string[] = [];
  for (const node of nodes) {
    if (node.required && OPEN_REQUIRED_STATUSES.has(node.status)) blockers.push(`todo ${node.path} '${node.title}' is required and ${node.status}`);
    if (node.required && node.status === "skipped" && !node.skipReason?.trim()) blockers.push(`todo ${node.path} '${node.title}' skipped without explicit reason`);
    const evidenceRequired = todoState.policy.requireEvidenceForCritical && (node.priority === "critical" || Boolean(node.delegation) || node.owner === "factory" || node.owner === "orchestration");
    if (node.status === "done" && evidenceRequired && node.evidenceRefs.length === 0 && node.validationCommands.length === 0 && !node.artifacts?.outputHash) blockers.push(`todo ${node.path} '${node.title}' done without evidence`);
    if (node.status === "skipped" && evidenceRequired && node.evidenceRefs.length === 0 && node.validationCommands.length === 0 && !node.artifacts?.outputHash) blockers.push(`todo ${node.path} '${node.title}' skipped without evidence`);
    if (node.status === "done" && node.delegation && node.delegation.status !== "accepted") blockers.push(`todo ${node.path} '${node.title}' delegated claim is not parent-accepted`);
    if (node.status === "done") {
      const openChildren = nodes.filter((candidate) => candidate.parentId === node.id && candidate.required && OPEN_REQUIRED_STATUSES.has(candidate.status));
      if (openChildren.length > 0) blockers.push(`todo ${node.path} '${node.title}' is done but has open required child TODOs`);
    }
  }
  blockers.push(...validateGoalTodoGraph(todoState, goalId));
  return blockers;
}

export function goalTodoCompletionDiagnostics(todoState: GoalTodoState, goalId: string | undefined): GoalTodoCompletionDiagnostics {
  const nodes = goalId ? goalNodes(todoState, goalId) : [];
  const completionBlockers = goalTodoCompletionBlockers(todoState, goalId);
  const reviewNoShip = nodes.some((node) => node.reviewNoShip === true);
  const hardNoShip = completionBlockers.length > 0;
  return {
    completionReady: completionBlockers.length === 0 && !reviewNoShip,
    hardNoShip,
    reviewNoShip,
    effectiveNoShip: hardNoShip || reviewNoShip,
    completionBlockers,
    nextValidActions: Object.fromEntries(nodes.map((node) => [node.id, nextValidGoalTodoActions(node)])),
  };
}

export function formatGoalTodoDiagnostics(diagnostics: GoalTodoCompletionDiagnostics): string {
  const blockers = diagnostics.completionBlockers.slice(0, 3).join(" | ") || "none";
  return `completion_ready=${diagnostics.completionReady} · hard_no_ship=${diagnostics.hardNoShip} · review_no_ship=${diagnostics.reviewNoShip} · effective_no_ship=${diagnostics.effectiveNoShip} · completion_blockers=${blockers}`;
}
