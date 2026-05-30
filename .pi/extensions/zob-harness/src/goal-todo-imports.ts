import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { addGoalTodo, completeGoalTodo, type GoalTodoNode, type GoalTodoOwner } from "./goal-todos.js";
import type { HarnessRuntimeState } from "./runtime/state.js";

export interface GoalTodoImportResult {
  kind: "factory" | "orchestration" | "chain";
  runId: string;
  imported: number;
  parent: GoalTodoNode;
  nodes: GoalTodoNode[];
  evidenceRefs: string[];
  missingRefs: string[];
}

function safeRunId(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Unsafe run id: ${runId}`);
  return runId;
}

function existingRepoRefs(repoRoot: string, refs: string[]): string[] {
  return refs.filter((ref) => existsSync(join(repoRoot, ref)));
}

function missingRepoRefs(repoRoot: string, refs: string[]): string[] {
  return refs.filter((ref) => !existsSync(join(repoRoot, ref)));
}

function filesUnder(repoRoot: string, relativeDir: string, suffix?: string): string[] {
  const dir = join(repoRoot, relativeDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => `${relativeDir}/${entry}`)
    .filter((ref) => statSync(join(repoRoot, ref)).isFile())
    .filter((ref) => !suffix || ref.endsWith(suffix))
    .sort();
}

function importArtifactTodos(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, parentId: string, owner: GoalTodoOwner, repoRoot: string, artifactRefs: string[]): GoalTodoNode[] {
  return artifactRefs.map((ref) => addGoalTodo(pi, state, goalId, {
    title: `artifact ${ref}`,
    parentId,
    owner,
    required: false,
    priority: "normal",
    status: existsSync(join(repoRoot, ref)) ? "done" : "planned",
    evidenceRefs: existsSync(join(repoRoot, ref)) ? [ref] : [],
  }, "import"));
}

function maybeCompleteParent(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, parent: GoalTodoNode, evidenceRefs: string[], complete: boolean): GoalTodoNode {
  if (!complete || evidenceRefs.length === 0) return parent;
  return completeGoalTodo(pi, state, goalId, parent.id, { evidenceRefs, validationCommands: [] }, "import");
}

export function importFactoryRunTodos(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, goalId: string, runIdInput: string): GoalTodoImportResult {
  const runId = safeRunId(runIdInput);
  const base = `reports/factory-runs/${runId}`;
  const primaryRefs = [`${base}/manifest.json`, `${base}/agentic-plan.json`, `${base}/validation.json`, `${base}/DONE.sentinel`, `${base}/SMOKE_PASSED.sentinel`, `${base}/PILOT_PASSED.sentinel`];
  const artifactRefs = [...primaryRefs, ...filesUnder(repoRoot, `${base}/checkpoints`, ".checkpoint.json"), ...filesUnder(repoRoot, `${base}/outputs`, ".json")];
  const evidenceRefs = existingRepoRefs(repoRoot, artifactRefs);
  const parent = addGoalTodo(pi, state, goalId, {
    title: `factory ${runId}`,
    owner: "factory",
    required: true,
    priority: "high",
    status: evidenceRefs.length > 0 ? "in_progress" : "planned",
    evidenceRefs,
    validationCommands: existsSync(join(repoRoot, `${base}/validation.json`)) ? [`inspect ${base}/validation.json`] : [],
  }, "import");
  const children = importArtifactTodos(pi, state, goalId, parent.id, "factory", repoRoot, artifactRefs);
  const completedParent = maybeCompleteParent(pi, state, goalId, parent, evidenceRefs, existsSync(join(repoRoot, `${base}/validation.json`)) && existsSync(join(repoRoot, `${base}/DONE.sentinel`)));
  return { kind: "factory", runId, imported: 1 + children.length, parent: completedParent, nodes: [completedParent, ...children], evidenceRefs, missingRefs: missingRepoRefs(repoRoot, artifactRefs) };
}

export function importOrchestrationRunTodos(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, goalId: string, runIdInput: string): GoalTodoImportResult {
  const runId = safeRunId(runIdInput);
  const base = `reports/orchestrations/${runId}`;
  const artifactRefs = [`${base}/orchestration-plan.json`, `${base}/manifest.json`, `${base}/status.jsonl`, `${base}/final-report.md`, `${base}/validation.json`, `${base}/room/evidence-index.json`, `${base}/room/context-pack.json`, `${base}/room/status.jsonl`];
  const evidenceRefs = existingRepoRefs(repoRoot, artifactRefs);
  const parent = addGoalTodo(pi, state, goalId, {
    title: `orchestration ${runId}`,
    owner: "orchestration",
    required: true,
    priority: "high",
    status: evidenceRefs.length > 0 ? "in_progress" : "planned",
    evidenceRefs,
  }, "import");
  const children = importArtifactTodos(pi, state, goalId, parent.id, "orchestration", repoRoot, artifactRefs);
  return { kind: "orchestration", runId, imported: 1 + children.length, parent, nodes: [parent, ...children], evidenceRefs, missingRefs: missingRepoRefs(repoRoot, artifactRefs) };
}

export function importChainRunTodos(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, goalId: string, runIdInput: string): GoalTodoImportResult {
  const runId = safeRunId(runIdInput);
  const base = `reports/chains/${runId}`;
  const artifactRefs = [`${base}/chain-plan.json`, `${base}/status.jsonl`, `${base}/final-report.md`, `${base}/validation.json`];
  const evidenceRefs = existingRepoRefs(repoRoot, artifactRefs);
  const parent = addGoalTodo(pi, state, goalId, {
    title: `chain ${runId}`,
    owner: "orchestration",
    required: true,
    priority: "normal",
    status: evidenceRefs.length > 0 ? "in_progress" : "planned",
    evidenceRefs,
  }, "import");
  const children = importArtifactTodos(pi, state, goalId, parent.id, "orchestration", repoRoot, artifactRefs);
  return { kind: "chain", runId, imported: 1 + children.length, parent, nodes: [parent, ...children], evidenceRefs, missingRefs: missingRepoRefs(repoRoot, artifactRefs) };
}
