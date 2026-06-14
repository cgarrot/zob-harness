import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { addGoalTodo, formatGoalTodoSummary, formatGoalTodoTree, summarizeGoalTodos, type GoalTodoNode } from "../domains/goal/goal-todos.js";
import { formatPlanTodoManifestTree, planTodoSidecarRelativePath, readPlanTodoSidecar, safePlanArtifactPath, writeUpdatedPlanTodoSidecar, type PlanTodoSidecar } from "../domains/plan/plan-todos.js";
import type { HarnessRuntimeState } from "./state.js";
import { ensureCapturedPlanTodoSidecar, listCapturedPlanEntries, updateCapturedPlanEntry, type PlanIndexEntry } from "./plan-capture.js";
import { appendRuntimeGoalEntry, createRuntimeGoal, formatRuntimeGoalSummary, queueRuntimeGoalContinuation, setEntry, type RuntimeGoal } from "./goal-runtime/state.js";

export type PlanLaunchSelector = "latest_launchable" | "latest";
export type PlanActiveGoalStrategy = "auto" | "block" | "attach";

export interface PlanLaunchInput {
  plan_id?: string;
  plan_path?: string;
  selector?: PlanLaunchSelector;
  dry_run?: boolean;
  attach_to_active_goal?: boolean;
  active_goal_strategy?: PlanActiveGoalStrategy;
  queue_continuation?: boolean;
  relaunch_as_new_goal?: boolean;
}

export interface PlanLaunchResult {
  status: "dry_run" | "launched" | "already_launched" | "blocked";
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

function activeGoalStrategy(input: PlanLaunchInput): PlanActiveGoalStrategy {
  if (input.attach_to_active_goal === true) return "attach";
  if (input.active_goal_strategy) return input.active_goal_strategy;
  return input.relaunch_as_new_goal === true ? "block" : "auto";
}

function nonCompleteGoal(goal: RuntimeGoal | undefined): RuntimeGoal | undefined {
  return goal && goal.status !== "complete" ? goal : undefined;
}

function launchedGoalId(sidecar: PlanTodoSidecar, entry: PlanIndexEntry): string | undefined {
  return sidecar.launched_goal_id ?? entry.launched_goal_id;
}

function alreadyLaunchedSummary(planId: string, goalId: string, todoSummary: string, todoTree: string): string {
  return [
    `plan already launched in active goal: ${planId}`,
    `goal: ${goalId}`,
    "no TODOs duplicated",
    todoSummary,
    todoTree,
  ].filter(Boolean).join("\n");
}

function launchedElsewhereBlock(planId: string, launchedForGoalId: string | undefined, activeGoalId: string | undefined): string[] {
  const target = launchedForGoalId ? `goal ${launchedForGoalId}` : "an unknown prior goal";
  const active = activeGoalId ? ` Active goal is ${activeGoalId}.` : "";
  return [
    `Plan ${planId} is already launched for ${target}.${active}`,
    "Use relaunch_as_new_goal=true only when you intentionally want another materialization of the same saved plan.",
  ];
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
  const preview = previewCapturedPlanLaunch(ctx.cwd, { ...input, relaunch_as_new_goal: true });
  if (preview.status === "blocked" || !preview.planId || !preview.sidecarPath) return preview;
  if (input.dry_run === true) return preview;
  const resolved = resolveCapturedPlanForLaunch(ctx.cwd, input);
  if (!resolved.entry || !resolved.sidecarPath) return { status: "blocked", errors: resolved.errors, summary: resolved.errors.join("\n") };
  const loaded = readPlanTodoSidecar(ctx.cwd, resolved.sidecarPath);
  if (loaded.errors.length > 0 || !loaded.sidecar) return { status: "blocked", planId: resolved.entry.plan_id, planPath: resolved.entry.relative_path, sidecarPath: resolved.sidecarPath, errors: loaded.errors, summary: loaded.errors.join("\n") };
  const sidecar = loaded.sidecar;
  const activeGoal = nonCompleteGoal(state.runtimeGoal);
  const strategy = activeGoalStrategy(input);
  const launchedAlready = sidecar.launch_status === "launched" || resolved.entry.launch_status === "launched";
  const priorGoalId = launchedGoalId(sidecar, resolved.entry);

  if (launchedAlready && input.relaunch_as_new_goal !== true) {
    if (activeGoal && priorGoalId === activeGoal.goalId) {
      const summary = summarizeGoalTodos(state.goalTodos, activeGoal.goalId);
      return {
        status: "already_launched",
        planId: resolved.entry.plan_id,
        planPath: resolved.entry.relative_path,
        sidecarPath: resolved.sidecarPath,
        goalId: activeGoal.goalId,
        todoCount: sidecar.todo_count,
        createdTodos: [],
        errors: [],
        summary: alreadyLaunchedSummary(
          resolved.entry.plan_id,
          activeGoal.goalId,
          formatRuntimeGoalSummary(activeGoal, state.goalActivationMode, formatGoalTodoSummary(summary)),
          formatGoalTodoTree(state.goalTodos, activeGoal.goalId),
        ),
        launch_status: "launched",
      };
    }
    const errors = launchedElsewhereBlock(resolved.entry.plan_id, priorGoalId, activeGoal?.goalId);
    return { status: "blocked", planId: resolved.entry.plan_id, planPath: resolved.entry.relative_path, sidecarPath: resolved.sidecarPath, goalId: priorGoalId, errors, summary: errors.join("\n"), launch_status: "launched" };
  }

  if (activeGoal && strategy === "block") {
    const errors = [
      `A non-complete runtime goal already exists (${activeGoal.goalId}) and active_goal_strategy=block was requested.`,
      `Retry with active_goal_strategy=attach or remove the block strategy to auto-attach this plan to the active goal.`,
      `/plan launch ${resolved.entry.plan_id} --attach`,
    ];
    return { status: "blocked", planId: resolved.entry.plan_id, planPath: resolved.entry.relative_path, sidecarPath: resolved.sidecarPath, goalId: activeGoal.goalId, errors, summary: errors.join("\n") };
  }

  const attachingToActiveGoal = Boolean(activeGoal && (strategy === "auto" || strategy === "attach"));
  const goal = attachingToActiveGoal && activeGoal
    ? activeGoal
    : createRuntimeGoal(sidecar.objective, { maxTurns: sidecar.max_turns });
  if (!attachingToActiveGoal) appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
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
    summary: [attachingToActiveGoal ? `plan attached to active goal: ${resolved.entry.plan_id}` : `plan launched: ${resolved.entry.plan_id}`, formatRuntimeGoalSummary(state.runtimeGoal ?? goal, state.goalActivationMode, formatGoalTodoSummary(summary)), formatGoalTodoTree(state.goalTodos, goalId)].join("\n"),
    launch_status: "launched",
  };
}
