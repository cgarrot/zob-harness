import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { addGoalTodo, formatGoalTodoSummary, formatGoalTodoTree, summarizeGoalTodos, type GoalTodoNode } from "../domains/goal/goal-todos.js";
import { formatPlanTodoManifestTree, planTodoSidecarRelativePath, readPlanTodoSidecar, safePlanArtifactPath, writeUpdatedPlanTodoSidecar, type PlanTodoSidecar } from "../domains/plan/plan-todos.js";
import type { HarnessRuntimeState } from "./state.js";
import { ensureCapturedPlanTodoSidecar, listCapturedPlanEntries, updateCapturedPlanEntry, type PlanIndexEntry } from "./plan-capture.js";
import { appendRuntimeGoalEntry, createRuntimeGoal, formatRuntimeGoalSummary, queueRuntimeGoalContinuation, setEntry } from "./goal-runtime/state.js";

export type PlanLaunchSelector = "latest_launchable" | "latest";

export interface PlanLaunchInput {
  plan_id?: string;
  plan_path?: string;
  selector?: PlanLaunchSelector;
  dry_run?: boolean;
  attach_to_active_goal?: boolean;
  queue_continuation?: boolean;
  relaunch_as_new_goal?: boolean;
}

export interface PlanLaunchResult {
  status: "dry_run" | "launched" | "blocked";
  planId?: string;
  planPath?: string;
  sidecarPath?: string;
  goalId?: string;
  todoCount?: number;
  createdTodos?: GoalTodoNode[];
  errors: string[];
  summary: string;
  launch_status?: string;
}

function findEntryByPath(entries: PlanIndexEntry[], planPath: string): PlanIndexEntry | undefined {
  const normalized = planPath.replace(/^\.\//, "");
  return entries.find((entry) => entry.relative_path === normalized || entry.todo_manifest_path === normalized);
}

export function resolveCapturedPlanForLaunch(repoRoot: string, input: PlanLaunchInput = {}): { entry?: PlanIndexEntry; sidecarPath?: string; errors: string[] } {
  const entries = listCapturedPlanEntries(repoRoot);
  let entry: PlanIndexEntry | undefined;
  if (input.plan_id) entry = entries.find((candidate) => candidate.plan_id === input.plan_id);
  else if (input.plan_path) entry = findEntryByPath(entries, input.plan_path);
  else if ((input.selector ?? "latest_launchable") === "latest") entry = entries[0];
  else entry = entries.find((candidate) => (candidate.launch_status === "launchable" && Boolean(candidate.todo_manifest_path)) || candidate.launch_status === "needs_manifest");

  if (!entry) return { errors: [`No captured plan matched ${input.plan_id ? `plan_id=${input.plan_id}` : input.plan_path ? `plan_path=${input.plan_path}` : `selector=${input.selector ?? "latest_launchable"}`}.`] };
  const sidecarPath = entry.todo_manifest_path ?? (entry.relative_path.endsWith(".md") ? planTodoSidecarRelativePath(entry.relative_path) : undefined);
  if (!sidecarPath) return { entry, errors: [`Plan ${entry.plan_id} has no TODO sidecar path.`] };
  return { entry, sidecarPath, errors: [] };
}

function ensurePlanPathSafe(repoRoot: string, entry: PlanIndexEntry): string[] {
  return safePlanArtifactPath(repoRoot, entry.relative_path, ".md").errors;
}

export function previewCapturedPlanLaunch(repoRoot: string, input: PlanLaunchInput = {}): PlanLaunchResult {
  const resolved = resolveCapturedPlanForLaunch(repoRoot, input);
  if (resolved.errors.length > 0 || !resolved.entry || !resolved.sidecarPath) return { status: "blocked", errors: resolved.errors, summary: resolved.errors.join("\n") };
  const pathErrors = ensurePlanPathSafe(repoRoot, resolved.entry);
  if (pathErrors.length > 0) return { status: "blocked", planId: resolved.entry.plan_id, planPath: resolved.entry.relative_path, sidecarPath: resolved.sidecarPath, errors: pathErrors, summary: pathErrors.join("\n") };
  const loaded = readPlanTodoSidecar(repoRoot, resolved.sidecarPath);
  let sidecar = loaded.sidecar;
  let effectiveEntry = resolved.entry;
  let effectiveSidecarPath = resolved.sidecarPath;
  if (loaded.errors.length > 0 || !sidecar) {
    const ensured = ensureCapturedPlanTodoSidecar(repoRoot, resolved.entry.plan_id, { persist: input.dry_run !== true });
    if (!ensured.sidecar || ensured.errors.length > 0) {
      const errors = ensured.errors.length > 0 ? ensured.errors : loaded.errors;
      return { status: "blocked", planId: resolved.entry.plan_id, planPath: resolved.entry.relative_path, sidecarPath: resolved.sidecarPath, errors, summary: errors.join("\n") };
    }
    sidecar = ensured.sidecar;
    effectiveEntry = ensured.entry ?? resolved.entry;
    effectiveSidecarPath = ensured.sidecarPath ?? resolved.sidecarPath;
  }
  const launchedAlready = sidecar.launch_status === "launched" || effectiveEntry.launch_status === "launched";
  if (launchedAlready && input.relaunch_as_new_goal !== true && input.dry_run !== true) {
    return { status: "blocked", planId: effectiveEntry.plan_id, planPath: effectiveEntry.relative_path, sidecarPath: effectiveSidecarPath, errors: [`Plan ${effectiveEntry.plan_id} is already launched; pass relaunch_as_new_goal=true to launch again.`], summary: `plan already launched: ${effectiveEntry.plan_id}`, launch_status: "launched" };
  }
  return { status: "dry_run", planId: effectiveEntry.plan_id, planPath: effectiveEntry.relative_path, sidecarPath: effectiveSidecarPath, todoCount: sidecar.todo_count, errors: [], summary: formatPlanTodoManifestTree(sidecar), launch_status: sidecar.launch_status };
}

function materializeSidecarTodos(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, sidecar: PlanTodoSidecar): GoalTodoNode[] {
  const refToId = new Map<string, string>();
  const created: GoalTodoNode[] = [];
  const pending = [...sidecar.todos];
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let index = 0; index < pending.length;) {
      const todo = pending[index]!;
      const parentId = todo.parent_ref ? refToId.get(todo.parent_ref) : undefined;
      if (todo.parent_ref && !parentId) {
        index += 1;
        continue;
      }
      const node = addGoalTodo(pi, state, goalId, {
        title: todo.title,
        parentId,
        owner: todo.owner,
        required: todo.required,
        priority: todo.priority,
        status: todo.status,
        acceptanceCriteria: todo.acceptance_criteria,
        validationCommands: todo.validation_commands,
        evidenceRefs: [sidecar.plan_path],
      }, "tool");
      refToId.set(todo.ref, node.id);
      created.push(node);
      pending.splice(index, 1);
      progress = true;
    }
  }
  if (pending.length > 0) throw new Error(`Could not materialize plan TODOs; unresolved parent refs: ${pending.map((todo) => `${todo.ref}->${todo.parent_ref ?? "root"}`).join(", ")}`);
  return created;
}

export function launchCapturedPlan(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: ExtensionContext, input: PlanLaunchInput = {}): PlanLaunchResult {
  const preview = previewCapturedPlanLaunch(ctx.cwd, input);
  if (preview.status === "blocked" || !preview.planId || !preview.sidecarPath) return preview;
  if (input.dry_run === true) return preview;
  const resolved = resolveCapturedPlanForLaunch(ctx.cwd, input);
  if (!resolved.entry || !resolved.sidecarPath) return { status: "blocked", errors: resolved.errors, summary: resolved.errors.join("\n") };
  const loaded = readPlanTodoSidecar(ctx.cwd, resolved.sidecarPath);
  if (loaded.errors.length > 0 || !loaded.sidecar) return { status: "blocked", planId: resolved.entry.plan_id, planPath: resolved.entry.relative_path, sidecarPath: resolved.sidecarPath, errors: loaded.errors, summary: loaded.errors.join("\n") };
  const sidecar = loaded.sidecar;
  const activeGoal = state.runtimeGoal;
  if (activeGoal && activeGoal.status !== "complete" && input.attach_to_active_goal !== true) {
    return { status: "blocked", planId: resolved.entry.plan_id, planPath: resolved.entry.relative_path, sidecarPath: resolved.sidecarPath, errors: [`A non-complete runtime goal already exists (${activeGoal.goalId}); pass attach_to_active_goal=true or complete/clear it before launching a saved plan.`], summary: `active goal blocks plan launch: ${activeGoal.goalId}` };
  }

  const goal = input.attach_to_active_goal && activeGoal && activeGoal.status !== "complete"
    ? activeGoal
    : createRuntimeGoal(sidecar.objective, { maxTurns: sidecar.max_turns });
  if (!input.attach_to_active_goal || !activeGoal || activeGoal.status === "complete") appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
  const goalId = goal.goalId;
  const createdTodos = materializeSidecarTodos(pi, state, goalId, sidecar);
  const launchedAt = new Date().toISOString();
  sidecar.launch_status = "launched";
  sidecar.launched_goal_id = goalId;
  sidecar.launched_at = launchedAt;
  writeUpdatedPlanTodoSidecar(ctx.cwd, sidecar);
  updateCapturedPlanEntry(ctx.cwd, resolved.entry.plan_id, {
    launch_status: "launched",
    launched_goal_id: goalId,
    launched_at: launchedAt,
    todo_count: sidecar.todo_count,
    todo_depth: sidecar.max_depth,
    todo_manifest_hash: sidecar.manifest_hash,
    todo_manifest_path: resolved.sidecarPath,
  });
  const summary = summarizeGoalTodos(state.goalTodos, goalId);
  if (input.queue_continuation !== false) queueRuntimeGoalContinuation(pi, state, ctx);
  return {
    status: "launched",
    planId: resolved.entry.plan_id,
    planPath: resolved.entry.relative_path,
    sidecarPath: resolved.sidecarPath,
    goalId,
    todoCount: createdTodos.length,
    createdTodos,
    errors: [],
    summary: [`plan launched: ${resolved.entry.plan_id}`, formatRuntimeGoalSummary(state.runtimeGoal ?? goal, state.goalActivationMode, formatGoalTodoSummary(summary)), formatGoalTodoTree(state.goalTodos, goalId)].join("\n"),
    launch_status: "launched",
  };
}
