import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { QueueTickResult } from "../../types.js";
import { buildDaemonRuntimeState, buildDaemonTickPlan, type DaemonRuntimeState, type DaemonTickPlan } from "../../domains/autonomy/daemon-runtime.js";
import { runQueueDaemonTick } from "../../domains/telemetry/queue.js";
import type { HarnessRuntimeState } from "../state.js";
import { renderHarnessWidget } from "../widget.js";
import type { HarnessCommandContext } from "./types.js";

export function daemonInputFromState(state: HarnessRuntimeState) {
  return {
    policy: state.daemon.policy,
    runtimeGoal: state.runtimeGoal,
    goalTodos: state.goalTodos,
    autonomy: {
      mode: state.autonomy.mode,
      enabled: state.autonomy.enabled,
      lastReadiness: state.autonomy.lastReadiness,
      lastLaunchAuthorization: state.autonomy.lastLaunchAuthorization,
    },
    loop: state.daemon.loop,
  };
}

export function daemonRuntimeLedgerEntry(daemonState: DaemonRuntimeState): Record<string, unknown> {
  return {
    schema: daemonState.schema,
    status: daemonState.status,
    reasonCodes: daemonState.reasonCodes,
    enabled: daemonState.policy.enabled,
    planOnly: true,
    scopedToActiveGoal: true,
    goalId: daemonState.goal?.goalId,
    goalStatus: daemonState.goal?.status,
    oracleStatus: daemonState.goal?.oracleStatus,
    launchAuthorized: daemonState.launchAuthorized,
    selectedTodoId: daemonState.selectedTodo?.id,
    selectedTodoPath: daemonState.selectedTodo?.path,
    selectedTodoStatus: daemonState.selectedTodo?.status,
    todoCounts: daemonState.todoCounts,
    loop: daemonState.loop,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
    childDispatchAllowed: false,
    queueClaimed: false,
    todoMutated: false,
    productionApplyAllowed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

export function daemonPlanLedgerEntry(plan: DaemonTickPlan, daemonState: DaemonRuntimeState): Record<string, unknown> {
  return {
    schema: plan.schema,
    status: plan.status,
    action: plan.action,
    reasonCodes: plan.reasonCodes,
    enabled: daemonState.policy.enabled,
    planOnly: true,
    goalId: plan.goalId,
    selectedTodoId: plan.todo?.id,
    selectedTodoPath: plan.todo?.path,
    selectedTodoStatus: plan.todo?.status,
    loop: daemonState.loop,
    stop: { stop: plan.stop.stop, status: plan.stop.status, reasonCodes: plan.stop.reasonCodes },
    writesPlanned: false,
    todoMutationPlanned: false,
    queueClaimPlanned: false,
    childDispatchPlanned: false,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
    productionApplyAllowed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

export function formatDaemonStatusForUi(daemonState: DaemonRuntimeState): string {
  const todo = daemonState.selectedTodo ? ` · todo=${daemonState.selectedTodo.path}/${daemonState.selectedTodo.status}` : "";
  const loop = daemonState.loop;
  const loopText = loop ? ` · loop=${loop.status} ticks=${loop.tickCount}${loop.maxTicks ? `/${loop.maxTicks}` : ""}${loop.blocker ? ` blocker=${loop.blocker}` : ""}` : "";
  return `daemon ${daemonState.policy.enabled ? "plan-only" : "off"}/${daemonState.status}${todo}${loopText} · reasons=${daemonState.reasonCodes.slice(0, 3).join(",") || "none"} · autoStart=false globalLoop=false execution=false`;
}

export function formatDaemonPlanForUi(plan: DaemonTickPlan, queueTick?: QueueTickResult): string {
  const todo = plan.todo ? ` · todo=${plan.todo.path}/${plan.todo.status}` : "";
  const queue = queueTick ? ` · queue=${queueTick.status}/claimed=${queueTick.claimed}` : "";
  return `daemon tick action=${plan.action} status=${plan.status}${todo}${queue} · stop=${plan.stop.stop} · writes=false todo_mutation=false child_dispatch=false`;
}
const DAEMON_SESSION_TICK_INTERVAL_MS = 1_000;
export function clearDaemonLoopTimer(state: HarnessRuntimeState): void {
  if (state.daemon.loopTimer) clearTimeout(state.daemon.loopTimer);
  state.daemon.loopTimer = undefined;
}

export function stopDaemonLoop(state: HarnessRuntimeState, blocker?: string): void {
  clearDaemonLoopTimer(state);
  state.daemon.loop = {
    ...state.daemon.loop,
    status: "stopped",
    stoppedAt: new Date().toISOString(),
    blocker: blocker ?? state.daemon.loop.blocker,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
  };
  state.daemon.updatedAt = state.daemon.loop.stoppedAt;
}

export function parseDaemonMaxTicks(parts: string[]): number | undefined {
  const index = parts.findIndex((part) => part === "--max-ticks" || part === "--max_ticks");
  if (index < 0 || !parts[index + 1]) return undefined;
  const parsed = Number.parseInt(parts[index + 1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.trunc(parsed), 100) : undefined;
}

export function daemonQueueTickLedgerEntry(result: QueueTickResult): Record<string, unknown> {
  return {
    schema: result.schema,
    claimed: result.claimed,
    jobId: result.jobId,
    jobType: result.jobType,
    status: result.status,
    stopCondition: result.stopCondition,
    errors: result.errors,
    staleRecovered: result.staleRecovered,
    maxWorkers: result.maxWorkers,
    budgetEnforced: result.budgetEnforced,
    promptBodiesStored: false,
    outputBodiesStored: false,
    bodyStored: false,
    explicitManualReadOnlyBridge: true,
    productionApplyAllowed: false,
    childDispatchAllowed: false,
    generatedAt: new Date().toISOString(),
  };
}

export function recordDaemonTick(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: HarnessCommandContext, options: { queueReadonly?: boolean } = {}): { daemonState: DaemonRuntimeState; plan: DaemonTickPlan; queueTick?: QueueTickResult } {
  const now = new Date().toISOString();
  state.daemon.loop = {
    ...state.daemon.loop,
    tickCount: state.daemon.loop.tickCount + 1,
    lastTickAt: now,
    blocker: undefined,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
  };
  const daemonInput = daemonInputFromState(state);
  const daemonState = buildDaemonRuntimeState({ ...daemonInput, policy: { ...state.daemon.policy, enabled: true } });
  const plan = buildDaemonTickPlan(daemonState);
  let queueTick: QueueTickResult | undefined;
  if (options.queueReadonly === true) {
    queueTick = runQueueDaemonTick(ctx.cwd);
    state.daemon.lastQueueTick = queueTick;
    pi.appendEntry("zob-daemon-queue-tick", daemonQueueTickLedgerEntry(queueTick));
  }
  state.daemon.lastStatus = daemonState;
  state.daemon.lastPlan = plan;
  state.daemon.updatedAt = now;
  pi.appendEntry("zob-daemon-runtime", daemonRuntimeLedgerEntry(daemonState));
  pi.appendEntry("zob-daemon-plan", daemonPlanLedgerEntry(plan, daemonState));
  return { daemonState, plan, queueTick };
}

export function scheduleDaemonLoop(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: HarnessCommandContext): void {
  if (state.daemon.loop.status !== "running") return;
  if (state.daemon.loop.maxTicks !== undefined && state.daemon.loop.tickCount >= state.daemon.loop.maxTicks) {
    stopDaemonLoop(state, "max_ticks_reached");
    renderHarnessWidget(pi, state, ctx);
    return;
  }
  clearDaemonLoopTimer(state);
  const timer = setTimeout(() => {
    if (state.daemon.loop.status !== "running") return;
    const { plan } = recordDaemonTick(pi, state, ctx);
    if (plan.stop.stop) stopDaemonLoop(state, `stop_condition_${plan.status}`);
    if (state.daemon.loop.maxTicks !== undefined && state.daemon.loop.tickCount >= state.daemon.loop.maxTicks) stopDaemonLoop(state, "max_ticks_reached");
    renderHarnessWidget(pi, state, ctx);
    if (state.daemon.loop.status === "running") scheduleDaemonLoop(pi, state, ctx);
  }, DAEMON_SESSION_TICK_INTERVAL_MS);
  timer.unref?.();
  state.daemon.loopTimer = timer;
}
