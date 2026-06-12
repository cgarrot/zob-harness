import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { sha256 } from "../../core/utils/hashing.js";
import { isRecord } from "../../core/utils/records.js";
import type { GoalTodoOwner, GoalTodoPolicy, GoalTodoPriority, GoalTodoStatus } from "../goal/goal-todo-types.js";
import { defaultGoalTodoPolicy } from "../goal/goal-todos.js";

export const PLAN_TODOS_BLOCK_START = "<!-- ZOB_PLAN_TODOS_START -->";
export const PLAN_TODOS_BLOCK_END = "<!-- ZOB_PLAN_TODOS_END -->";
export const PLAN_TODOS_INPUT_SCHEMA = "zob.plan-todos.v1";
export const PLAN_TODOS_CANONICAL_SCHEMA = "zob.plan-todos.canonical.v1";
export const PLAN_TODOS_SIDECAR_SCHEMA = "zob.plan-todos.sidecar.v1";
export const PLAN_TODOS_DISPLAY_CARD_START = "<!-- ZOB_PLAN_TODOS_DISPLAY_CARD_START -->";
export const PLAN_TODOS_DISPLAY_CARD_END = "<!-- ZOB_PLAN_TODOS_DISPLAY_CARD_END -->";
const PLAN_TODOS_BLOCK_PATTERN = /<!--\s*ZOB_PLAN_TODOS_START\s*-->\s*(?:```[^\r\n]*\r?\n)?([\s\S]*?)(?:\r?\n```)?\s*<!--\s*ZOB_PLAN_TODOS_END\s*-->/i;

export type PlanLaunchStatus = "needs_manifest" | "invalid_manifest" | "launchable" | "launched";
export type PlanTodoManifestSource = "explicit_block" | "markdown_fallback";
export type PlanTodoManifestQuality = "explicit" | "fallback_structured";

export interface PlanTodoCanonicalItem {
  ref: string;
  parent_ref?: string;
  title: string;
  owner: GoalTodoOwner;
  required: boolean;
  priority: GoalTodoPriority;
  status: Exclude<GoalTodoStatus, "done" | "skipped" | "delegated" | "claim_returned">;
  acceptance_criteria: string[];
  validation_commands: string[];
}

export interface PlanTodoCanonicalManifest {
  schema: typeof PLAN_TODOS_CANONICAL_SCHEMA;
  objective: string;
  max_turns?: number;
  oracle_required: true;
  todos: PlanTodoCanonicalItem[];
  todo_count: number;
  max_depth: number;
}

export interface PlanTodoSidecar extends Omit<PlanTodoCanonicalManifest, "schema"> {
  schema: typeof PLAN_TODOS_SIDECAR_SCHEMA;
  manifest_schema: typeof PLAN_TODOS_CANONICAL_SCHEMA;
  plan_id: string;
  plan_path: string;
  plan_body_hash: string;
  user_request_hash: string;
  assistant_output_hash: string;
  manifest_hash: string;
  manifest_source: PlanTodoManifestSource;
  manifest_quality: PlanTodoManifestQuality;
  manifest_warnings?: string[];
  manifest_errors?: string[];
  launch_status: PlanLaunchStatus;
  created_at: string;
  launched_goal_id?: string;
  launched_at?: string;
  bodyStored: false;
  promptBodiesStored: false;
}

export interface PlanTodoManifestResult {
  found: boolean;
  manifest?: PlanTodoCanonicalManifest;
  errors: string[];
  warnings: string[];
  rawHash?: string;
  source?: PlanTodoManifestSource;
  quality?: PlanTodoManifestQuality;
}

export interface PlanTodoSidecarBuildInput {
  planId: string;
  planPath: string;
  planBodyHash: string;
  userRequestHash: string;
  assistantOutputHash: string;
  createdAt: string;
  manifest: PlanTodoCanonicalManifest;
  manifestSource?: PlanTodoManifestSource;
  manifestQuality?: PlanTodoManifestQuality;
  manifestWarnings?: string[];
  manifestErrors?: string[];
}

const VALID_OWNER: readonly GoalTodoOwner[] = ["agent", "user", "oracle", "subagent", "factory", "orchestration"];
const VALID_PRIORITY: readonly GoalTodoPriority[] = ["low", "normal", "high", "critical"];
const VALID_INITIAL_STATUS: readonly PlanTodoCanonicalItem["status"][] = ["planned", "ready", "in_progress", "needs_review", "needs_oracle", "needs_user", "blocked"];
const REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function boolField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function positiveIntField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : undefined;
}

function stringArrayField(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .flatMap((item) => typeof item === "string" ? [item.trim()] : [])
        .filter((item) => item.length > 0 && !/^(none|n\/a|null)$/i.test(item));
    }
  }
  return [];
}

function enumValue<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : fallback;
}

function normalizeRef(raw: string, errors: string[], label: string): string {
  const ref = raw.trim();
  if (!REF_PATTERN.test(ref)) errors.push(`${label} ref '${ref}' must match ${REF_PATTERN.source}`);
  return ref;
}

function maxDepthForTodos(todos: PlanTodoCanonicalItem[]): number {
  const byRef = new Map(todos.map((todo) => [todo.ref, todo]));
  const depthOf = (todo: PlanTodoCanonicalItem, seen = new Set<string>()): number => {
    if (!todo.parent_ref) return 1;
    if (seen.has(todo.ref)) return 999;
    seen.add(todo.ref);
    const parent = byRef.get(todo.parent_ref);
    return parent ? depthOf(parent, seen) + 1 : 2;
  };
  return todos.reduce((max, todo) => Math.max(max, depthOf(todo)), 0);
}

function childrenFrom(record: Record<string, unknown>): unknown[] {
  const candidates = [record.children, record.subtodos, record.sub_todos, record.todos];
  const value = candidates.find((candidate) => Array.isArray(candidate));
  return Array.isArray(value) ? value : [];
}

function normalizeTodoItem(value: unknown, parentRef: string | undefined, path: number[], todos: PlanTodoCanonicalItem[], errors: string[], warnings: string[]): void {
  if (!isRecord(value)) {
    errors.push(`todo ${path.join(".")} must be an object`);
    return;
  }
  const generatedRef = `t${path.join("_")}`;
  const rawRef = stringField(value, "key", "ref", "id") ?? generatedRef;
  if (!stringField(value, "key", "ref", "id")) warnings.push(`todo ${path.join(".")} is missing key/ref; generated ${generatedRef}`);
  const ref = normalizeRef(rawRef, errors, `todo ${path.join(".")}`);
  const explicitParent = stringField(value, "parent_ref", "parentRef", "parent");
  const normalizedParent = explicitParent ? normalizeRef(explicitParent, errors, `todo ${path.join(".")} parent_ref`) : parentRef;
  const title = stringField(value, "title", "name");
  if (!title) errors.push(`todo ${ref} requires non-empty title`);
  const rawStatus = value.status;
  if (typeof rawStatus === "string" && (rawStatus === "done" || rawStatus === "skipped" || rawStatus === "delegated" || rawStatus === "claim_returned")) {
    errors.push(`todo ${ref} status '${rawStatus}' is not a valid initial plan-launch status`);
  }
  const item: PlanTodoCanonicalItem = {
    ref,
    parent_ref: normalizedParent,
    title: title ?? `Untitled TODO ${path.join(".")}`,
    owner: enumValue(VALID_OWNER, value.owner, "agent"),
    required: boolField(value, "required", true),
    priority: enumValue(VALID_PRIORITY, value.priority, "normal"),
    status: enumValue(VALID_INITIAL_STATUS, rawStatus, "planned"),
    acceptance_criteria: stringArrayField(value, "acceptance_criteria", "acceptanceCriteria", "done_when", "doneWhen"),
    validation_commands: stringArrayField(value, "validation_commands", "validationCommands", "checks"),
  };
  todos.push(item);
  childrenFrom(value).forEach((child, index) => normalizeTodoItem(child, ref, [...path, index + 1], todos, errors, warnings));
}

export function extractPlanTodosJson(text: string): { found: boolean; jsonText?: string; errors: string[]; rawHash?: string } {
  const match = text.match(PLAN_TODOS_BLOCK_PATTERN);
  if (!match) return { found: false, errors: [] };
  const jsonText = (match[1] ?? "").trim();
  if (!jsonText) return { found: true, errors: ["ZOB_PLAN_TODOS block is empty"] };
  return { found: true, jsonText, errors: [], rawHash: sha256(jsonText) };
}

export function normalizePlanTodoManifest(value: unknown, options: { defaultObjective?: string; policy?: GoalTodoPolicy } = {}): PlanTodoManifestResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const policy = options.policy ?? defaultGoalTodoPolicy();
  if (!isRecord(value)) return { found: true, errors: ["plan TODO manifest must be a JSON object"], warnings };
  const schema = typeof value.schema === "string" ? value.schema : PLAN_TODOS_INPUT_SCHEMA;
  if (schema !== PLAN_TODOS_INPUT_SCHEMA && schema !== PLAN_TODOS_CANONICAL_SCHEMA && schema !== PLAN_TODOS_SIDECAR_SCHEMA) {
    errors.push(`unsupported plan TODO schema: ${schema}`);
  }
  const objective = stringField(value, "objective", "goal", "active_goal") ?? options.defaultObjective ?? "ZOB saved plan";
  const rawTodos = Array.isArray(value.todos) ? value.todos : [];
  if (rawTodos.length === 0) errors.push("plan TODO manifest requires at least one todo");
  const todos: PlanTodoCanonicalItem[] = [];
  rawTodos.forEach((item, index) => normalizeTodoItem(item, undefined, [index + 1], todos, errors, warnings));

  const refs = new Set<string>();
  for (const todo of todos) {
    if (refs.has(todo.ref)) errors.push(`duplicate todo ref: ${todo.ref}`);
    refs.add(todo.ref);
  }
  for (const todo of todos) {
    if (todo.parent_ref && !refs.has(todo.parent_ref)) errors.push(`todo ${todo.ref} references missing parent_ref ${todo.parent_ref}`);
  }
  const byParent = new Map<string | undefined, number>();
  for (const todo of todos) byParent.set(todo.parent_ref, (byParent.get(todo.parent_ref) ?? 0) + 1);
  for (const [parentRef, count] of byParent) {
    if (parentRef && count > policy.maxChildrenPerTodo) errors.push(`parent ${parentRef} exceeds maxChildrenPerTodo=${policy.maxChildrenPerTodo}`);
  }
  if (todos.length > policy.maxOpenTodos) errors.push(`plan TODO count exceeds maxOpenTodos=${policy.maxOpenTodos}`);
  const maxDepth = maxDepthForTodos(todos);
  if (maxDepth > policy.maxTodoDepth) errors.push(`plan TODO depth ${maxDepth} exceeds maxTodoDepth=${policy.maxTodoDepth}`);

  const manifest: PlanTodoCanonicalManifest = {
    schema: PLAN_TODOS_CANONICAL_SCHEMA,
    objective,
    max_turns: positiveIntField(value, "max_turns") ?? positiveIntField(value, "maxTurns"),
    oracle_required: true,
    todos,
    todo_count: todos.length,
    max_depth: maxDepth,
  };
  return { found: true, manifest: errors.length === 0 ? manifest : undefined, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}


function stripPlanCaptureEnvelope(text: string): string {
  let body = text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "");
  const lines = body.split(/\r?\n/);
  const capturedPlanIndex = lines.findIndex((line) => /^\s*##\s+Captured Plan\s*$/i.test(line));
  const scoped = capturedPlanIndex >= 0 ? lines.slice(capturedPlanIndex + 1) : lines;
  const metadataIndex = scoped.findIndex((line) => /^\s*##\s+Metadata\s*$/i.test(line));
  body = (metadataIndex >= 0 ? scoped.slice(0, metadataIndex) : scoped).join("\n");
  return body;
}

function cleanMarkdownListText(raw: string): string {
  return raw
    .replace(/^\[[ xX-]\]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*[:：]\s*$/, "")
    .trim();
}

function isIgnoredFallbackSection(title: string): boolean {
  const normalized = cleanMarkdownListText(title).toLowerCase();
  return /^(metadata|méta|meta|fichiers?\b|files?\b|likely files?\b|probable files?\b|project files?\b|paths?\b|artefacts?\b|artifacts?\b)/i.test(normalized);
}

function isNonActionableFallbackTitle(title: string): boolean {
  const normalized = title.trim();
  if (normalized.length < 3) return true;
  if (/^(oui|voici|pr[eê]t|ready|note|notes?)\b/i.test(normalized)) return true;
  if (/^(lancer|run|ex[eé]cuter)\s*$/i.test(normalized)) return true;
  if (/^[-–—]+$/.test(normalized)) return true;
  return false;
}

function looksLikeValidationCommand(value: string): boolean {
  const candidate = value.trim().replace(/^`|`$/g, "");
  return /^(?:npm\s+(?:run\s+|test\b|exec\b)|pnpm\s+|yarn\s+|bun\s+|node\s+|npx\s+|tsx\s+|tsc\b|jest\b|vitest\b|pytest\b|python3?\s+|deno\s+|go\s+test\b|cargo\s+(?:test|check|build)\b|make\b)/i.test(candidate);
}

function validationCommandFromListText(raw: string): string | undefined {
  const trimmed = raw.trim();
  const inline = trimmed.match(/`([^`]+)`/);
  if (inline && looksLikeValidationCommand(inline[1] ?? "")) return (inline[1] ?? "").trim();
  const cleaned = trimmed.replace(/^`([^`]+)`$/, "$1").trim();
  return looksLikeValidationCommand(cleaned) ? cleaned : undefined;
}

function addUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function fallbackTodo(ref: string, title: string, parentRef?: string): PlanTodoCanonicalItem {
  return {
    ref,
    parent_ref: parentRef,
    title,
    owner: "agent",
    required: true,
    priority: /\b(test|validation|oracle|safety|security|risk)\b/i.test(title) ? "high" : "normal",
    status: "planned",
    acceptance_criteria: parentRef ? [`Completed: ${title}`] : [],
    validation_commands: [],
  };
}

function parseMarkdownFallbackTodos(text: string, allowRootBullets: boolean): PlanTodoCanonicalItem[] {
  const todos: PlanTodoCanonicalItem[] = [];
  const childCounts = new Map<string, number>();
  let currentRoot: PlanTodoCanonicalItem | undefined;
  let rootCount = 0;
  let ignoredSection = false;
  let inFence = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      ignoredSection = isIgnoredFallbackSection(heading[1] ?? "");
      currentRoot = undefined;
      continue;
    }

    const numbered = line.match(/^\s{0,3}\d+[.)]\s+(.+)$/);
    if (numbered && !ignoredSection) {
      const title = cleanMarkdownListText(numbered[1] ?? "");
      if (!isNonActionableFallbackTitle(title)) {
        rootCount += 1;
        currentRoot = fallbackTodo(`t${rootCount}`, title);
        todos.push(currentRoot);
      }
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (!bullet || ignoredSection) continue;

    const rawText = bullet[2] ?? "";
    const command = validationCommandFromListText(rawText);
    if (command) {
      if (currentRoot) addUnique(currentRoot.validation_commands, command);
      continue;
    }

    const title = cleanMarkdownListText(rawText);
    if (isNonActionableFallbackTitle(title)) continue;

    if (currentRoot) {
      const nextChild = (childCounts.get(currentRoot.ref) ?? 0) + 1;
      childCounts.set(currentRoot.ref, nextChild);
      todos.push(fallbackTodo(`${currentRoot.ref}_${nextChild}`, title, currentRoot.ref));
      continue;
    }

    if (allowRootBullets) {
      rootCount += 1;
      currentRoot = fallbackTodo(`t${rootCount}`, title);
      todos.push(currentRoot);
    }
  }

  return todos;
}

function fallbackObjectiveFromMarkdown(text: string, defaultObjective?: string): string {
  const heading = text.split(/\r?\n/)
    .map((line) => line.match(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/)?.[1])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return cleanMarkdownListText(heading ?? defaultObjective ?? "ZOB saved plan");
}

export function compileMarkdownPlanTodoManifest(text: string, options: { defaultObjective?: string; policy?: GoalTodoPolicy } = {}): PlanTodoManifestResult {
  const body = stripPlanCaptureEnvelope(text);
  const todos = parseMarkdownFallbackTodos(body, false);
  const fallbackTodos = todos.length > 0 ? todos : parseMarkdownFallbackTodos(body, true);
  const warnings = [
    "ZOB_PLAN_TODOS block missing; used deterministic Markdown fallback compiler.",
    "Fallback manifests are best-effort; explicit ZOB_PLAN_TODOS JSON remains the preferred plan contract.",
  ];
  if (fallbackTodos.length === 0) {
    return {
      found: false,
      errors: ["No ZOB_PLAN_TODOS block and deterministic Markdown fallback found no numbered/bulleted TODO list."],
      warnings,
      rawHash: sha256(body),
      source: "markdown_fallback",
      quality: "fallback_structured",
    };
  }

  const normalized = normalizePlanTodoManifest({
    schema: PLAN_TODOS_CANONICAL_SCHEMA,
    objective: fallbackObjectiveFromMarkdown(body, options.defaultObjective),
    todos: fallbackTodos,
  }, options);
  return {
    ...normalized,
    warnings: [...new Set([...warnings, ...normalized.warnings])],
    rawHash: sha256(body),
    source: "markdown_fallback",
    quality: "fallback_structured",
  };
}

export function extractAndNormalizePlanTodoManifest(text: string, options: { defaultObjective?: string; policy?: GoalTodoPolicy } = {}): PlanTodoManifestResult {
  const block = extractPlanTodosJson(text);
  if (!block.found) return compileMarkdownPlanTodoManifest(text, options);
  if (block.errors.length > 0 || !block.jsonText) return { found: true, errors: block.errors, warnings: [], rawHash: block.rawHash, source: "explicit_block", quality: "explicit" };
  try {
    const parsed = JSON.parse(block.jsonText) as unknown;
    const normalized = normalizePlanTodoManifest(parsed, options);
    return { ...normalized, rawHash: block.rawHash, source: "explicit_block", quality: "explicit" };
  } catch (error) {
    return { found: true, errors: [`invalid JSON in ZOB_PLAN_TODOS block: ${error instanceof Error ? error.message : String(error)}`], warnings: [], rawHash: block.rawHash, source: "explicit_block", quality: "explicit" };
  }
}


export interface PlanTodoDisplayCardOptions {
  planPath?: string;
  sidecarPath?: string;
  launchStatus?: PlanLaunchStatus;
  source?: PlanTodoManifestSource;
  quality?: PlanTodoManifestQuality;
  maxRoots?: number;
  maxChildrenPerRoot?: number;
  includeRawHint?: boolean;
  includeLaunchHint?: boolean;
}

export interface PlanTodoDisplayRedactionResult {
  text: string;
  changed: boolean;
  manifest?: PlanTodoCanonicalManifest;
  errors: string[];
  warnings: string[];
  source?: PlanTodoManifestSource;
  quality?: PlanTodoManifestQuality;
}

function truncateForDisplay(value: string, max = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…` : normalized;
}

function displaySourceLabel(source: PlanTodoManifestSource | undefined, quality: PlanTodoManifestQuality | undefined): string {
  if (source === "markdown_fallback") return quality === "fallback_structured" ? "Markdown fallback" : "fallback";
  return "explicit manifest";
}

export function formatPlanTodoManifestDisplayCard(manifest: PlanTodoCanonicalManifest | PlanTodoSidecar, options: PlanTodoDisplayCardOptions = {}): string {
  const byParent = new Map<string | undefined, PlanTodoCanonicalItem[]>();
  for (const todo of manifest.todos) {
    const list = byParent.get(todo.parent_ref) ?? [];
    list.push(todo);
    byParent.set(todo.parent_ref, list);
  }
  const roots = byParent.get(undefined) ?? [];
  const childCount = manifest.todos.filter((todo) => Boolean(todo.parent_ref)).length;
  const launchStatus = options.launchStatus ?? ("launch_status" in manifest ? manifest.launch_status : "launchable");
  const source = options.source ?? ("manifest_source" in manifest ? manifest.manifest_source : "explicit_block");
  const quality = options.quality ?? ("manifest_quality" in manifest ? manifest.manifest_quality : source === "markdown_fallback" ? "fallback_structured" : "explicit");
  const maxRoots = options.maxRoots ?? 8;
  const maxChildrenPerRoot = options.maxChildrenPerRoot ?? 3;
  const icon = launchStatus === "invalid_manifest" || launchStatus === "needs_manifest" ? "⚠️" : launchStatus === "launched" ? "🚀" : "✅";
  const title = launchStatus === "launched" ? "ZOB plan launched" : launchStatus === "launchable" ? "ZOB plan launchable" : "ZOB plan manifest";
  const lines: string[] = [
    PLAN_TODOS_DISPLAY_CARD_START,
    `> ${icon} **${title}** · ${manifest.todo_count} TODO${manifest.todo_count === 1 ? "" : "s"}${childCount ? ` · ${childCount} subtask${childCount === 1 ? "" : "s"}` : ""} · depth ${manifest.max_depth}`,
    `> **Objective:** ${truncateForDisplay(manifest.objective, 140)}`,
    `> **Source:** ${displaySourceLabel(source, quality)} · raw JSON hidden from feed · sidecar is canonical`,
  ];
  if (options.planPath) lines.push(`> **Plan:** \`${options.planPath}\``);
  const sidecarPath = options.sidecarPath ?? ("plan_path" in manifest ? planTodoSidecarRelativePath(manifest.plan_path) : options.planPath ? planTodoSidecarRelativePath(options.planPath) : undefined);
  if (sidecarPath) lines.push(`> **TODO sidecar:** \`${sidecarPath}\``);
  lines.push(">", "> **TODO preview**");
  roots.slice(0, maxRoots).forEach((todo) => {
    lines.push(`> ${todo.ref}. ${truncateForDisplay(todo.title)}`);
    const children = byParent.get(todo.ref) ?? [];
    children.slice(0, maxChildrenPerRoot).forEach((child, index) => {
      const prefix = index === children.length - 1 || index === maxChildrenPerRoot - 1 ? "└─" : "├─";
      lines.push(`>    ${prefix} ${child.ref} ${truncateForDisplay(child.title)}`);
    });
    if (children.length > maxChildrenPerRoot) lines.push(`>    … ${children.length - maxChildrenPerRoot} more subtask${children.length - maxChildrenPerRoot === 1 ? "" : "s"}`);
  });
  if (roots.length > maxRoots) lines.push(`> … ${roots.length - maxRoots} more top-level TODO${roots.length - maxRoots === 1 ? "" : "s"}`);
  if (options.includeLaunchHint !== false) lines.push(">", "> Use `/plan inspect latest_launchable` or `zob_plan_launch` to preview/launch from the sidecar.");
  if (options.includeRawHint !== false) lines.push("> Raw manifest available in the `.todos.json` sidecar; not repeated in chat.");
  lines.push(PLAN_TODOS_DISPLAY_CARD_END);
  return lines.join("\n");
}

export function redactPlanTodosBlockForDisplay(text: string, options: PlanTodoDisplayCardOptions & { defaultObjective?: string; policy?: GoalTodoPolicy } = {}): PlanTodoDisplayRedactionResult {
  const block = extractPlanTodosJson(text);
  if (!block.found) return { text, changed: false, errors: [], warnings: [] };
  if (block.errors.length > 0 || !block.jsonText) return { text, changed: false, errors: block.errors, warnings: [] };
  const normalized = extractAndNormalizePlanTodoManifest(text, { defaultObjective: options.defaultObjective, policy: options.policy });
  if (!normalized.manifest) return { text, changed: false, errors: normalized.errors, warnings: normalized.warnings, source: normalized.source, quality: normalized.quality };
  const card = formatPlanTodoManifestDisplayCard(normalized.manifest, {
    ...options,
    source: normalized.source ?? options.source,
    quality: normalized.quality ?? options.quality,
    launchStatus: options.launchStatus ?? "launchable",
  });
  return {
    text: text.replace(PLAN_TODOS_BLOCK_PATTERN, card),
    changed: true,
    manifest: normalized.manifest,
    errors: normalized.errors,
    warnings: normalized.warnings,
    source: normalized.source,
    quality: normalized.quality,
  };
}

export function canonicalManifestHash(manifest: PlanTodoCanonicalManifest): string {
  return sha256(JSON.stringify(manifest));
}

export function buildPlanTodoSidecar(input: PlanTodoSidecarBuildInput): PlanTodoSidecar {
  const manifestHash = canonicalManifestHash(input.manifest);
  return {
    schema: PLAN_TODOS_SIDECAR_SCHEMA,
    manifest_schema: PLAN_TODOS_CANONICAL_SCHEMA,
    plan_id: input.planId,
    plan_path: input.planPath,
    plan_body_hash: input.planBodyHash,
    user_request_hash: input.userRequestHash,
    assistant_output_hash: input.assistantOutputHash,
    manifest_hash: manifestHash,
    manifest_source: input.manifestSource ?? "explicit_block",
    manifest_quality: input.manifestQuality ?? "explicit",
    manifest_warnings: input.manifestWarnings && input.manifestWarnings.length > 0 ? [...new Set(input.manifestWarnings)] : undefined,
    manifest_errors: input.manifestErrors && input.manifestErrors.length > 0 ? [...new Set(input.manifestErrors)] : undefined,
    launch_status: "launchable",
    created_at: input.createdAt,
    objective: input.manifest.objective,
    max_turns: input.manifest.max_turns,
    oracle_required: true,
    todos: input.manifest.todos,
    todo_count: input.manifest.todo_count,
    max_depth: input.manifest.max_depth,
    bodyStored: false,
    promptBodiesStored: false,
  };
}

export function planTodoSidecarRelativePath(planRelativePath: string): string {
  return planRelativePath.replace(/\.md$/i, ".todos.json");
}

export function safePlanArtifactPath(repoRoot: string, relativePath: string, extension: ".md" | ".json"): { absolutePath: string; relativePath: string; errors: string[] } {
  const normalizedInput = relativePath.replace(/^\.\//, "");
  const absolutePath = resolve(repoRoot, normalizedInput);
  const root = resolve(repoRoot);
  const rel = relative(root, absolutePath).split("\\").join("/");
  const errors: string[] = [];
  if (rel.startsWith("../") || rel === ".." || rel.startsWith("/")) errors.push(`plan artifact path must stay inside repo: ${relativePath}`);
  if (!rel.startsWith("plans/")) errors.push(`plan artifact path must be under plans/: ${relativePath}`);
  if (!rel.endsWith(extension)) errors.push(`plan artifact path must end with ${extension}: ${relativePath}`);
  return { absolutePath, relativePath: rel, errors };
}

export function writePlanTodoSidecar(repoRoot: string, sidecar: PlanTodoSidecar): string {
  const sidecarRelativePath = planTodoSidecarRelativePath(sidecar.plan_path);
  const safe = safePlanArtifactPath(repoRoot, sidecarRelativePath, ".json");
  if (safe.errors.length > 0) throw new Error(safe.errors.join("; "));
  mkdirSync(dirname(safe.absolutePath), { recursive: true });
  writeFileSync(safe.absolutePath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  return safe.relativePath;
}

export function readPlanTodoSidecar(repoRoot: string, sidecarRelativePath: string): { sidecar?: PlanTodoSidecar; errors: string[] } {
  const safe = safePlanArtifactPath(repoRoot, sidecarRelativePath, ".json");
  if (safe.errors.length > 0) return { errors: safe.errors };
  if (!existsSync(safe.absolutePath)) return { errors: [`plan TODO sidecar not found: ${safe.relativePath}`] };
  try {
    const parsed = JSON.parse(readFileSync(safe.absolutePath, "utf8")) as unknown;
    const validation = validatePlanTodoSidecar(parsed);
    return validation.errors.length > 0 ? { errors: validation.errors } : { sidecar: validation.sidecar, errors: [] };
  } catch (error) {
    return { errors: [`failed to read plan TODO sidecar ${safe.relativePath}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function writeUpdatedPlanTodoSidecar(repoRoot: string, sidecar: PlanTodoSidecar): void {
  const safe = safePlanArtifactPath(repoRoot, planTodoSidecarRelativePath(sidecar.plan_path), ".json");
  if (safe.errors.length > 0) throw new Error(safe.errors.join("; "));
  writeFileSync(safe.absolutePath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
}

export function validatePlanTodoSidecar(value: unknown, policy: GoalTodoPolicy = defaultGoalTodoPolicy()): { sidecar?: PlanTodoSidecar; errors: string[] } {
  if (!isRecord(value)) return { errors: ["plan TODO sidecar must be an object"] };
  if (value.schema !== PLAN_TODOS_SIDECAR_SCHEMA) return { errors: [`unsupported plan TODO sidecar schema: ${String(value.schema)}`] };
  const normalized = normalizePlanTodoManifest({ ...value, schema: PLAN_TODOS_CANONICAL_SCHEMA }, { defaultObjective: typeof value.objective === "string" ? value.objective : undefined, policy });
  const errors = [...normalized.errors];
  for (const key of ["plan_id", "plan_path", "plan_body_hash", "user_request_hash", "assistant_output_hash", "manifest_hash", "created_at"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) errors.push(`plan TODO sidecar missing ${key}`);
  }
  if (value.launch_status !== "launchable" && value.launch_status !== "launched") errors.push(`plan TODO sidecar launch_status must be launchable or launched`);
  const manifestSource = enumValue(["explicit_block", "markdown_fallback"] as const, value.manifest_source, "explicit_block");
  const manifestQuality = enumValue(["explicit", "fallback_structured"] as const, value.manifest_quality, manifestSource === "markdown_fallback" ? "fallback_structured" : "explicit");
  if (value.bodyStored !== false || value.promptBodiesStored !== false) errors.push("plan TODO sidecar must be body-free metadata only outside TODO titles/criteria");
  if (normalized.manifest && typeof value.manifest_hash === "string" && canonicalManifestHash(normalized.manifest) !== value.manifest_hash) errors.push("plan TODO sidecar manifest_hash mismatch");
  if (errors.length > 0 || !normalized.manifest) return { errors: [...new Set(errors)] };
  return {
    sidecar: {
      schema: PLAN_TODOS_SIDECAR_SCHEMA,
      manifest_schema: PLAN_TODOS_CANONICAL_SCHEMA,
      plan_id: String(value.plan_id),
      plan_path: String(value.plan_path),
      plan_body_hash: String(value.plan_body_hash),
      user_request_hash: String(value.user_request_hash),
      assistant_output_hash: String(value.assistant_output_hash),
      manifest_hash: String(value.manifest_hash),
      manifest_source: manifestSource,
      manifest_quality: manifestQuality,
      manifest_warnings: stringArrayField(value, "manifest_warnings"),
      manifest_errors: stringArrayField(value, "manifest_errors"),
      launch_status: value.launch_status as PlanLaunchStatus,
      created_at: String(value.created_at),
      launched_goal_id: typeof value.launched_goal_id === "string" ? value.launched_goal_id : undefined,
      launched_at: typeof value.launched_at === "string" ? value.launched_at : undefined,
      objective: normalized.manifest.objective,
      max_turns: normalized.manifest.max_turns,
      oracle_required: true,
      todos: normalized.manifest.todos,
      todo_count: normalized.manifest.todo_count,
      max_depth: normalized.manifest.max_depth,
      bodyStored: false,
      promptBodiesStored: false,
    },
    errors: [],
  };
}

export function formatPlanTodoManifestTree(manifest: PlanTodoCanonicalManifest | PlanTodoSidecar): string {
  const byParent = new Map<string | undefined, PlanTodoCanonicalItem[]>();
  for (const todo of manifest.todos) {
    const list = byParent.get(todo.parent_ref) ?? [];
    list.push(todo);
    byParent.set(todo.parent_ref, list);
  }
  const lines = [`${manifest.objective} · todos ${manifest.todo_count} · depth ${manifest.max_depth}`];
  const walk = (parentRef: string | undefined, indent = ""): void => {
    const children = byParent.get(parentRef) ?? [];
    children.forEach((todo, index) => {
      const last = index === children.length - 1;
      lines.push(`${indent}${indent ? (last ? "└─" : "├─") : ""}${todo.ref} ${todo.title} [${todo.status}/${todo.owner}/${todo.required ? "req" : "opt"}/${todo.priority}]`);
      walk(todo.ref, `${indent}${indent ? (last ? "  " : "│ ") : "  "}`);
    });
  };
  walk(undefined);
  return lines.join("\n");
}
