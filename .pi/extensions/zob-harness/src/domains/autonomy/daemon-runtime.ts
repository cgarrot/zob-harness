import type { InteractiveAutonomyMode, InteractiveLaunchAuthorization, MissionReadinessReport } from "./interactive-autonomy.js";
import type { RuntimeGoal, RuntimeGoalStatus } from "../../runtime/goal-runtime.js";
import type { GoalTodoNode, GoalTodoState, GoalTodoStatus } from "../goal/goal-todos.js";

export const DAEMON_RUNTIME_STATUSES = [
  "off",
  "no_goal",
  "no_launch_authorization",
  "needs_user",
  "claim_returned",
  "needs_oracle",
  "actionable_todo",
  "idle",
  "blocked",
] as const;

export type DaemonRuntimeStatus = typeof DAEMON_RUNTIME_STATUSES[number];
export type DaemonRuntimeActionKind = "none" | "wait" | "request_user" | "request_oracle" | "review_claim" | "continue_todo" | "report_blocked";
export type DaemonLoopStatus = "stopped" | "running";

export interface DaemonLoopSnapshot {
  schema: "zob.daemon-loop-snapshot.v1";
  status: DaemonLoopStatus;
  tickCount: number;
  maxTicks?: number;
  startedAt?: string;
  stoppedAt?: string;
  lastTickAt?: string;
  blocker?: string;
  supervised: true;
  bounded: true;
  sessionLocal: true;
  autoStartDaemon: false;
  continuousLoop: false;
  cronEnabled: false;
}

export interface DaemonRuntimePolicy {
  enabled: boolean;
  planOnly: true;
  scopedToActiveGoal: true;
  requireLaunchAuthorization: boolean;
  autoStartAllowed: false;
  continuousLoopAllowed: false;
  cronAllowed: false;
  childDispatchAllowed: false;
  queueClaimsAllowed: false;
  todoMutationAllowed: false;
  productionApplyAllowed: false;
}

export interface DaemonRuntimeAutonomySnapshot {
  mode?: InteractiveAutonomyMode;
  enabled?: boolean;
  lastReadiness?: MissionReadinessReport;
  lastLaunchAuthorization?: InteractiveLaunchAuthorization;
}

export interface DaemonRuntimeStateInput {
  policy?: Partial<DaemonRuntimePolicy>;
  runtimeGoal?: RuntimeGoal;
  goalTodos?: GoalTodoState;
  autonomy?: DaemonRuntimeAutonomySnapshot;
  loop?: DaemonLoopSnapshot;
}

export interface DaemonRuntimeTodoRef {
  id: string;
  goalId: string;
  path: string;
  status: GoalTodoStatus;
  owner: GoalTodoNode["owner"];
  required: boolean;
  priority: GoalTodoNode["priority"];
  evidenceRefCount: number;
  validationCommandCount: number;
  hasClaim: boolean;
  hasValidation: boolean;
  reviewNoShip: boolean;
}

export interface DaemonRuntimeTodoCounts {
  total: number;
  open: number;
  requiredOpen: number;
  needsUser: number;
  claimReturned: number;
  needsOracle: number;
  actionable: number;
  blocked: number;
}

export interface DaemonRuntimeState {
  schema: "zob.daemon-runtime-state.v1";
  status: DaemonRuntimeStatus;
  reasonCodes: string[];
  policy: DaemonRuntimePolicy;
  loop?: DaemonLoopSnapshot;
  goal?: {
    goalId: string;
    status: RuntimeGoalStatus;
    oracleStatus: RuntimeGoal["oracle"]["status"];
    oracleRequired: boolean;
    oracleNoShip?: boolean;
    loopEnabled: boolean;
    turnsUsed: number;
    maxTurns: number;
  };
  launchAuthorized: boolean;
  selectedTodo?: DaemonRuntimeTodoRef;
  todoCounts: DaemonRuntimeTodoCounts;
  planOnly: true;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  autoStartDaemon: false;
  continuousLoop: false;
  cronEnabled: false;
  childDispatchAllowed: false;
  queueClaimed: false;
  todoMutated: false;
  productionApplyAllowed: false;
}

export interface DaemonStopCondition {
  schema: "zob.daemon-stop-condition.v1";
  stop: boolean;
  status: DaemonRuntimeStatus;
  reasonCodes: string[];
  planOnly: true;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface DaemonTickPlan {
  schema: "zob.daemon-tick-plan.v1";
  status: DaemonRuntimeStatus;
  action: DaemonRuntimeActionKind;
  reasonCodes: string[];
  goalId?: string;
  todo?: DaemonRuntimeTodoRef;
  stop: DaemonStopCondition;
  planOnly: true;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  writesPlanned: false;
  todoMutationPlanned: false;
  queueClaimPlanned: false;
  childDispatchPlanned: false;
  autoStartDaemon: false;
  continuousLoop: false;
  cronEnabled: false;
  productionApplyAllowed: false;
}

const OPEN_TODO_STATUSES = new Set<GoalTodoStatus>(["planned", "ready", "in_progress", "delegated", "claim_returned", "needs_review", "needs_oracle", "needs_user", "blocked"]);
const ACTIONABLE_TODO_STATUSES = new Set<GoalTodoStatus>(["planned", "ready", "in_progress", "needs_review"]);

export const DEFAULT_DAEMON_RUNTIME_POLICY: DaemonRuntimePolicy = {
  enabled: true,
  planOnly: true,
  scopedToActiveGoal: true,
  requireLaunchAuthorization: true,
  autoStartAllowed: false,
  continuousLoopAllowed: false,
  cronAllowed: false,
  childDispatchAllowed: false,
  queueClaimsAllowed: false,
  todoMutationAllowed: false,
  productionApplyAllowed: false,
};

function normalizePolicy(input: Partial<DaemonRuntimePolicy> | undefined): DaemonRuntimePolicy {
  return {
    ...DEFAULT_DAEMON_RUNTIME_POLICY,
    ...input,
    planOnly: true,
    scopedToActiveGoal: true,
    autoStartAllowed: false,
    continuousLoopAllowed: false,
    cronAllowed: false,
    childDispatchAllowed: false,
    queueClaimsAllowed: false,
    todoMutationAllowed: false,
    productionApplyAllowed: false,
  };
}

function todoSort(left: GoalTodoNode, right: GoalTodoNode): number {
  const priorityRank: Record<GoalTodoNode["priority"], number> = { critical: 0, high: 1, normal: 2, low: 3 };
  return priorityRank[left.priority] - priorityRank[right.priority]
    || left.path.localeCompare(right.path, undefined, { numeric: true })
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id);
}

function todosForGoal(goalTodos: GoalTodoState | undefined, goalId: string): GoalTodoNode[] {
  return (goalTodos?.nodes ?? []).filter((node) => node.goalId === goalId).sort(todoSort);
}

function isOpenTodo(node: GoalTodoNode): boolean {
  return OPEN_TODO_STATUSES.has(node.status);
}

function isActionableTodo(node: GoalTodoNode): boolean {
  return ACTIONABLE_TODO_STATUSES.has(node.status) && node.owner !== "user" && node.owner !== "oracle";
}

function todoRef(node: GoalTodoNode): DaemonRuntimeTodoRef {
  return {
    id: node.id,
    goalId: node.goalId,
    path: node.path,
    status: node.status,
    owner: node.owner,
    required: node.required,
    priority: node.priority,
    evidenceRefCount: node.evidenceRefs.length,
    validationCommandCount: node.validationCommands.length,
    hasClaim: Boolean(node.claim),
    hasValidation: Boolean(node.validation),
    reviewNoShip: node.reviewNoShip === true,
  };
}

function countTodos(nodes: GoalTodoNode[]): DaemonRuntimeTodoCounts {
  const open = nodes.filter(isOpenTodo);
  return {
    total: nodes.length,
    open: open.length,
    requiredOpen: open.filter((node) => node.required !== false).length,
    needsUser: open.filter((node) => node.status === "needs_user" || node.owner === "user").length,
    claimReturned: open.filter((node) => node.status === "claim_returned").length,
    needsOracle: open.filter((node) => node.status === "needs_oracle" || node.owner === "oracle").length,
    actionable: open.filter(isActionableTodo).length,
    blocked: open.filter((node) => node.status === "blocked").length,
  };
}

function launchAuthorized(input: DaemonRuntimeStateInput, policy: DaemonRuntimePolicy, goal: RuntimeGoal | undefined): boolean {
  if (!policy.requireLaunchAuthorization) return true;
  if (!goal) return false;
  const authorization = input.autonomy?.lastLaunchAuthorization;
  return Boolean(
    input.autonomy?.enabled !== false
      && input.autonomy?.mode !== "off"
      && authorization
      && authorization.launchAuthorizesInScopeActions === true
      && authorization.applyPolicy.productionApplyAllowed === false
      && authorization.globalProductionClaimAllowed === false,
  );
}

export function selectNextActionableTodo(goalTodos: GoalTodoState | undefined, goalId: string | undefined): GoalTodoNode | undefined {
  if (!goalId) return undefined;
  const nodes = todosForGoal(goalTodos, goalId).filter(isOpenTodo);
  return nodes.find((node) => node.status === "claim_returned")
    ?? nodes.find((node) => node.status === "needs_oracle" || node.owner === "oracle")
    ?? nodes.find((node) => node.status === "needs_user" || node.owner === "user")
    ?? nodes.find(isActionableTodo)
    ?? nodes.find((node) => node.status === "blocked");
}

export function buildDaemonRuntimeState(input: DaemonRuntimeStateInput = {}): DaemonRuntimeState {
  const policy = normalizePolicy(input.policy);
  const goal = input.runtimeGoal;
  const nodes = goal ? todosForGoal(input.goalTodos, goal.goalId) : [];
  const todoCounts = countTodos(nodes);
  const selectedTodo = selectNextActionableTodo(input.goalTodos, goal?.goalId);
  const authorized = launchAuthorized(input, policy, goal);
  const reasonCodes: string[] = [];
  let status: DaemonRuntimeStatus;

  if (!policy.enabled) {
    status = "off";
    reasonCodes.push("daemon_policy_disabled");
  } else if (!goal) {
    status = "no_goal";
    reasonCodes.push("runtime_goal_missing");
  } else if (goal.status === "blocked" || goal.status === "budget_limited" || goal.status === "oracle_failed") {
    status = "blocked";
    reasonCodes.push(`runtime_goal_${goal.status}`);
  } else if (goal.status === "ready_for_oracle" || goal.oracle.status === "needed" || goal.oracle.noShip === true) {
    status = "needs_oracle";
    reasonCodes.push("runtime_goal_needs_oracle");
  } else if (!authorized) {
    status = "no_launch_authorization";
    reasonCodes.push("launch_authorization_missing");
  } else if (todoCounts.needsUser > 0) {
    status = "needs_user";
    reasonCodes.push("todo_needs_user");
  } else if (todoCounts.claimReturned > 0) {
    status = "claim_returned";
    reasonCodes.push("todo_claim_returned_parent_review_required");
  } else if (todoCounts.needsOracle > 0) {
    status = "needs_oracle";
    reasonCodes.push("todo_needs_oracle");
  } else if (selectedTodo && isActionableTodo(selectedTodo)) {
    status = "actionable_todo";
    reasonCodes.push("todo_actionable_plan_available");
  } else if (todoCounts.open > 0 && todoCounts.open === todoCounts.blocked) {
    status = "blocked";
    reasonCodes.push("all_open_todos_blocked");
  } else {
    status = "idle";
    reasonCodes.push(todoCounts.open === 0 ? "no_open_todos" : "no_actionable_todo");
  }

  return {
    schema: "zob.daemon-runtime-state.v1",
    status,
    reasonCodes,
    policy,
    loop: input.loop,
    goal: goal
      ? {
        goalId: goal.goalId,
        status: goal.status,
        oracleStatus: goal.oracle.status,
        oracleRequired: goal.oracle.required,
        oracleNoShip: goal.oracle.noShip,
        loopEnabled: goal.loop.enabled,
        turnsUsed: goal.usage.turnsUsed,
        maxTurns: goal.loop.maxTurns,
      }
      : undefined,
    launchAuthorized: authorized,
    selectedTodo: selectedTodo ? todoRef(selectedTodo) : undefined,
    todoCounts,
    planOnly: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
    childDispatchAllowed: false,
    queueClaimed: false,
    todoMutated: false,
    productionApplyAllowed: false,
  };
}

export function evaluateDaemonStopCondition(state: DaemonRuntimeState): DaemonStopCondition {
  const stop = state.status !== "actionable_todo";
  return {
    schema: "zob.daemon-stop-condition.v1",
    stop,
    status: state.status,
    reasonCodes: state.reasonCodes,
    planOnly: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function actionForStatus(status: DaemonRuntimeStatus): DaemonRuntimeActionKind {
  if (status === "needs_user") return "request_user";
  if (status === "needs_oracle") return "request_oracle";
  if (status === "claim_returned") return "review_claim";
  if (status === "actionable_todo") return "continue_todo";
  if (status === "blocked") return "report_blocked";
  if (status === "off" || status === "no_goal" || status === "no_launch_authorization" || status === "idle") return "wait";
  return "none";
}

export function buildDaemonTickPlan(input: DaemonRuntimeStateInput | DaemonRuntimeState = {}): DaemonTickPlan {
  const state = "schema" in input && input.schema === "zob.daemon-runtime-state.v1" ? input : buildDaemonRuntimeState(input);
  return {
    schema: "zob.daemon-tick-plan.v1",
    status: state.status,
    action: actionForStatus(state.status),
    reasonCodes: state.reasonCodes,
    goalId: state.goal?.goalId,
    todo: state.selectedTodo,
    stop: evaluateDaemonStopCondition(state),
    planOnly: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    writesPlanned: false,
    todoMutationPlanned: false,
    queueClaimPlanned: false,
    childDispatchPlanned: false,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
    productionApplyAllowed: false,
  };
}
