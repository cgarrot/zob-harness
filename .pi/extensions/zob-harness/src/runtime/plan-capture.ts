import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { artifactPath, artifactRootPath, artifactRef, legacyArtifactPath } from "../core/artifact-roots.js";
import type { ModeName } from "../types.js";
import { sha256 } from "../core/utils/hashing.js";
import { safeFileStem } from "../core/utils/paths.js";
import { looksLikeCompletePlanResponse, stripModeIntentMarkup } from "./mode-intent.js";
import { buildPlanTodoSidecar, extractAndNormalizePlanTodoManifest, planTodoSidecarRelativePath, redactPlanTodosBlockForDisplay, safePlanArtifactPath, writePlanTodoSidecar, type PlanLaunchStatus, type PlanTodoManifestQuality, type PlanTodoManifestSource, type PlanTodoSidecar } from "../domains/plan/plan-todos.js";

const PLAN_INDEX_SCHEMA = "zob.plan-index.v1";
const PLAN_CAPTURE_SCHEMA = "zob.plan-capture.v1";

type PlanCaptureStatus = "draft";

export interface PlanIndexEntry {
  plan_id: string;
  title: string;
  created_at: string;
  mode: ModeName | "unknown";
  status: PlanCaptureStatus;
  relative_path: string;
  body_hash: string;
  user_request_hash: string;
  assistant_output_hash: string;
  launch_status?: PlanLaunchStatus;
  todo_manifest_path?: string;
  todo_manifest_hash?: string;
  todo_manifest_source?: PlanTodoManifestSource;
  todo_manifest_quality?: PlanTodoManifestQuality;
  todo_count?: number;
  todo_depth?: number;
  todo_manifest_errors?: string[];
  todo_manifest_warnings?: string[];
  launched_goal_id?: string;
  launched_at?: string;
}

interface PlanIndex {
  schema: typeof PLAN_INDEX_SCHEMA;
  updated_at: string;
  entries: PlanIndexEntry[];
}

export interface PlanCaptureInput {
  assistantText: string;
  userText?: string;
  mode?: ModeName;
  now?: Date;
}

export interface PlanCaptureResult {
  captured: boolean;
  reason: "captured" | "not_plan" | "duplicate";
  planId?: string;
  title?: string;
  relativePath?: string;
  duplicateOf?: string;
  bodyHash?: string;
}

export interface PlanSidecarEnsureResult {
  entry?: PlanIndexEntry;
  sidecar?: PlanTodoSidecar;
  sidecarPath?: string;
  created: boolean;
  errors: string[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plansDir(repoRoot: string): string {
  return artifactRootPath(repoRoot, "plans");
}

function planIndexPath(repoRoot: string): string {
  return artifactPath(repoRoot, "plans", "index.json");
}

function legacyPlanIndexPath(repoRoot: string): string {
  return legacyArtifactPath(repoRoot, "plans", "index.json");
}

function planIndexMarkdownPath(repoRoot: string): string {
  return artifactPath(repoRoot, "plans", "index.md");
}

function planReadmePath(repoRoot: string): string {
  return artifactPath(repoRoot, "plans", "README.md");
}

function normalizePlanText(text: string): string {
  return stripModeIntentMarkup(text).replace(/\s+$/g, "").trim();
}

function userAskedForPlan(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(plan|planning|roadmap|architecture|strategy|specification|spec|design|implementation|patch order|tdd|steps?)\b/i.test(text);
}

export function shouldCapturePlanResponse(input: PlanCaptureInput): boolean {
  const text = normalizePlanText(input.assistantText);
  if (text.length < 160) return false;

  // Plan capture must be intentional. Delivery reports in implement/oracle/explore modes can
  // share plan-like formatting (files, validation, risks), so formatting alone is not enough.
  if (input.mode !== "plan") return false;

  if (looksLikeCompletePlanResponse(text)) return true;
  const structuralSignals = [
    /^\s*#{1,3}\s+.*\bplan\b/im.test(text),
    /^\s*(?:plan|roadmap|objectives?|scope)\b/im.test(text),
    (text.match(/^\s*(?:#{1,4}\s*)?(?:phase|patch|step)\s+\d+/gim) ?? []).length >= 1,
    (text.match(/^\s*\d+[.)]\s+/gm) ?? []).length >= 3,
    /\b(validation|tests?|risks?|files|success)\b/i.test(text),
  ].filter(Boolean).length;
  return userAskedForPlan(input.userText) ? structuralSignals >= 2 : structuralSignals >= 3;
}

export function extractPlanTitle(text: string): string {
  const normalized = normalizePlanText(text);
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,3}\s+/.test(line));
  const candidate = heading?.replace(/^#{1,3}\s+/, "")
    ?? lines.find((line) => /\bplan\b/i.test(line))
    ?? lines[0]
    ?? "ZOB plan";
  return candidate.replace(/[<>]/g, "").slice(0, 120).trim() || "ZOB plan";
}

function emptyPlanIndex(now: Date): PlanIndex {
  return { schema: PLAN_INDEX_SCHEMA, updated_at: now.toISOString(), entries: [] };
}

function asPlanIndexEntry(value: unknown): PlanIndexEntry | undefined {
  if (!isRecord(value)) return undefined;
  const planId = typeof value.plan_id === "string" ? value.plan_id : "";
  const title = typeof value.title === "string" ? value.title : "";
  const createdAt = typeof value.created_at === "string" ? value.created_at : "";
  const mode = typeof value.mode === "string" ? value.mode : "unknown";
  const status = value.status === "draft" ? "draft" : undefined;
  const relativePath = typeof value.relative_path === "string" ? value.relative_path : "";
  const bodyHash = typeof value.body_hash === "string" ? value.body_hash : "";
  const userRequestHash = typeof value.user_request_hash === "string" ? value.user_request_hash : "";
  const assistantOutputHash = typeof value.assistant_output_hash === "string" ? value.assistant_output_hash : "";
  if (!planId || !title || !createdAt || !status || !relativePath || !bodyHash || !userRequestHash || !assistantOutputHash) return undefined;
  const launchStatus = value.launch_status === "needs_manifest" || value.launch_status === "invalid_manifest" || value.launch_status === "launchable" || value.launch_status === "launched" ? value.launch_status : undefined;
  const todoCount = typeof value.todo_count === "number" && Number.isFinite(value.todo_count) ? Math.max(0, Math.trunc(value.todo_count)) : undefined;
  const todoDepth = typeof value.todo_depth === "number" && Number.isFinite(value.todo_depth) ? Math.max(0, Math.trunc(value.todo_depth)) : undefined;
  const todoManifestSource = value.todo_manifest_source === "explicit_block" || value.todo_manifest_source === "markdown_fallback" ? value.todo_manifest_source : undefined;
  const todoManifestQuality = value.todo_manifest_quality === "explicit" || value.todo_manifest_quality === "fallback_structured" ? value.todo_manifest_quality : undefined;
  return {
    plan_id: planId,
    title,
    created_at: createdAt,
    mode: mode === "explore" || mode === "plan" || mode === "implement" || mode === "oracle" || mode === "factory" || mode === "orchestrator" || mode === "vanilla" ? mode : "unknown",
    status,
    relative_path: relativePath,
    body_hash: bodyHash,
    user_request_hash: userRequestHash,
    assistant_output_hash: assistantOutputHash,
    launch_status: launchStatus,
    todo_manifest_path: typeof value.todo_manifest_path === "string" ? value.todo_manifest_path : undefined,
    todo_manifest_hash: typeof value.todo_manifest_hash === "string" ? value.todo_manifest_hash : undefined,
    todo_manifest_source: todoManifestSource,
    todo_manifest_quality: todoManifestQuality,
    todo_count: todoCount,
    todo_depth: todoDepth,
    todo_manifest_errors: Array.isArray(value.todo_manifest_errors) ? value.todo_manifest_errors.filter((item): item is string => typeof item === "string") : undefined,
    todo_manifest_warnings: Array.isArray(value.todo_manifest_warnings) ? value.todo_manifest_warnings.filter((item): item is string => typeof item === "string") : undefined,
    launched_goal_id: typeof value.launched_goal_id === "string" ? value.launched_goal_id : undefined,
    launched_at: typeof value.launched_at === "string" ? value.launched_at : undefined,
  };
}

function readPlanIndexFile(indexPath: string, now: Date): PlanIndex {
  if (!existsSync(indexPath)) return emptyPlanIndex(now);
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
    if (!isRecord(parsed) || parsed.schema !== PLAN_INDEX_SCHEMA || !Array.isArray(parsed.entries)) return emptyPlanIndex(now);
    return {
      schema: PLAN_INDEX_SCHEMA,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : now.toISOString(),
      entries: parsed.entries.map(asPlanIndexEntry).filter((entry): entry is PlanIndexEntry => Boolean(entry)),
    };
  } catch {
    return emptyPlanIndex(now);
  }
}

function readPlanIndex(repoRoot: string, now: Date): PlanIndex {
  const primary = readPlanIndexFile(planIndexPath(repoRoot), now);
  const legacy = readPlanIndexFile(legacyPlanIndexPath(repoRoot), now);
  if (legacy.entries.length === 0) return primary;
  const seen = new Set<string>();
  const entries = [...primary.entries, ...legacy.entries].filter((entry) => {
    const key = entry.plan_id || entry.relative_path || entry.body_hash;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    schema: PLAN_INDEX_SCHEMA,
    updated_at: primary.updated_at >= legacy.updated_at ? primary.updated_at : legacy.updated_at,
    entries,
  };
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function markdownLink(entry: PlanIndexEntry): string {
  const href = entry.relative_path.startsWith(".pi/plans/") ? entry.relative_path.replace(/^\.pi\/plans\//, "") : entry.relative_path.startsWith("plans/") ? `../../${entry.relative_path}` : entry.relative_path;
  return `[${escapeMarkdownTableCell(entry.title)}](${href})`;
}

function renderPlanIndexMarkdown(index: PlanIndex): string {
  const rows = index.entries.map((entry) => {
    const launch = entry.launch_status ?? "legacy";
    const todos = entry.todo_count !== undefined ? `${entry.todo_count}${entry.todo_depth ? ` / d${entry.todo_depth}` : ""}` : "—";
    return `| ${entry.created_at.slice(0, 10)} | ${markdownLink(entry)} | ${entry.mode} | ${entry.status} | ${launch} | ${todos} | ${entry.body_hash.slice(0, 12)} |`;
  });
  return [
    "# ZOB Plans Index",
    "",
    "Visible auto-captured planning artifacts. New captures are stored under `.pi/plans`; legacy `plans/` entries remain readable. Source user prompts are stored as hashes only; captured assistant plans are stored in the linked Markdown files. Launchable plans have a validated `.todos.json` sidecar used by `zob_plan_launch`.",
    "",
    "| Date | Plan | Mode | Status | Launch | Todos | Hash |",
    "|---|---|---|---|---|---|---|",
    ...(rows.length > 0 ? rows : ["| — | — | — | — | — | — | — |"]),
    "",
  ].join("\n");
}

function ensurePlansReadme(repoRoot: string): void {
  const readmePath = planReadmePath(repoRoot);
  if (existsSync(readmePath)) return;
  writeFileSync(readmePath, [
    "# ZOB Plans",
    "",
    "This directory stores visible planning artifacts automatically captured by the ZOB harness. New artifacts live under `.pi/plans`; legacy root `plans/` artifacts remain readable by plan launch tools.",
    "",
    "- `index.md` is the human-readable index.",
    "- `index.json` is the machine-readable duplicate-detection manifest.",
    "- Date folders contain the captured Markdown plans.",
    "- Launchable plans also have a sibling `.todos.json` sidecar that stores canonical TODO/sub-TODO manifests for `zob_plan_launch`.",
    "- Source user prompts are not persisted here; hashes are used for correlation.",
    "",
  ].join("\n"), "utf8");
}

function writePlanIndex(repoRoot: string, index: PlanIndex): void {
  mkdirSync(plansDir(repoRoot), { recursive: true });
  ensurePlansReadme(repoRoot);
  writeFileSync(planIndexPath(repoRoot), JSON.stringify(index, null, 2), "utf8");
  writeFileSync(planIndexMarkdownPath(repoRoot), renderPlanIndexMarkdown(index), "utf8");
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function renderPlanMarkdown(entry: PlanIndexEntry, assistantText: string): string {
  const displayText = redactPlanTodosBlockForDisplay(assistantText, {
    defaultObjective: entry.title,
    planPath: entry.relative_path,
    sidecarPath: entry.todo_manifest_path,
    launchStatus: entry.launch_status,
    source: entry.todo_manifest_source,
    quality: entry.todo_manifest_quality,
  }).text;
  return [
    "---",
    `schema: ${quoted(PLAN_CAPTURE_SCHEMA)}`,
    `plan_id: ${quoted(entry.plan_id)}`,
    `created_at: ${quoted(entry.created_at)}`,
    `mode: ${quoted(entry.mode)}`,
    `status: ${quoted(entry.status)}`,
    `title: ${quoted(entry.title)}`,
    `user_request_hash: ${quoted(entry.user_request_hash)}`,
    `assistant_output_hash: ${quoted(entry.assistant_output_hash)}`,
    `body_hash: ${quoted(entry.body_hash)}`,
    entry.launch_status ? `launch_status: ${quoted(entry.launch_status)}` : undefined,
    entry.todo_manifest_path ? `todo_manifest_path: ${quoted(entry.todo_manifest_path)}` : undefined,
    entry.todo_manifest_hash ? `todo_manifest_hash: ${quoted(entry.todo_manifest_hash)}` : undefined,
    entry.todo_manifest_source ? `todo_manifest_source: ${quoted(entry.todo_manifest_source)}` : undefined,
    entry.todo_manifest_quality ? `todo_manifest_quality: ${quoted(entry.todo_manifest_quality)}` : undefined,
    entry.todo_count !== undefined ? `todo_count: ${entry.todo_count}` : undefined,
    entry.todo_depth !== undefined ? `todo_depth: ${entry.todo_depth}` : undefined,
    entry.launched_goal_id ? `launched_goal_id: ${quoted(entry.launched_goal_id)}` : undefined,
    entry.launched_at ? `launched_at: ${quoted(entry.launched_at)}` : undefined,
    "---",
    "",
    `# ${entry.title}`,
    "",
    "> Captured automatically by the ZOB harness. Source user prompt text is not persisted in this artifact; hashes are retained for duplicate detection. If `launch_status=launchable`, the sibling `.todos.json` sidecar is the canonical machine input for `zob_plan_launch`.",
    "",
    "## Captured Plan",
    "",
    displayText.trim(),
    "",
    "## Metadata",
    "",
    `- plan_id: ${entry.plan_id}`,
    `- mode: ${entry.mode}`,
    `- status: ${entry.status}`,
    `- launch_status: ${entry.launch_status ?? "legacy"}`,
    entry.todo_manifest_path ? `- todo_manifest_path: ${entry.todo_manifest_path}` : undefined,
    entry.todo_manifest_hash ? `- todo_manifest_hash: ${entry.todo_manifest_hash}` : undefined,
    entry.todo_manifest_source ? `- todo_manifest_source: ${entry.todo_manifest_source}` : undefined,
    entry.todo_manifest_quality ? `- todo_manifest_quality: ${entry.todo_manifest_quality}` : undefined,
    entry.todo_count !== undefined ? `- todo_count: ${entry.todo_count}` : undefined,
    `- body_hash: ${entry.body_hash}`,
    "",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function capturePlanArtifact(repoRoot: string, input: PlanCaptureInput): PlanCaptureResult {
  const assistantText = normalizePlanText(input.assistantText);
  if (!shouldCapturePlanResponse({ ...input, assistantText })) return { captured: false, reason: "not_plan" };

  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const userText = input.userText?.trim() ?? "";
  const bodyHash = sha256(JSON.stringify({ userText, assistantText }));
  const index = readPlanIndex(repoRoot, now);
  const duplicate = index.entries.find((entry) => entry.body_hash === bodyHash);
  if (duplicate) return { captured: false, reason: "duplicate", duplicateOf: duplicate.relative_path, bodyHash };

  const title = extractPlanTitle(assistantText);
  const dateDir = createdAt.slice(0, 10);
  const planId = safeFileStem(`plan-${createdAt.replace(/\D/g, "").slice(0, 14)}-${bodyHash.slice(0, 8)}`);
  const slug = safeFileStem(title).toLowerCase();
  const relativePath = artifactRef("plans", dateDir, `${planId}-${slug}.md`);
  const absolutePath = join(repoRoot, relativePath);
  const userRequestHash = sha256(userText);
  const assistantOutputHash = sha256(assistantText);
  const entry: PlanIndexEntry = {
    plan_id: planId,
    title,
    created_at: createdAt,
    mode: input.mode ?? "unknown",
    status: "draft",
    relative_path: relativePath,
    body_hash: bodyHash,
    user_request_hash: userRequestHash,
    assistant_output_hash: assistantOutputHash,
  };

  const manifestResult = extractAndNormalizePlanTodoManifest(assistantText, { defaultObjective: title });
  if (manifestResult.manifest) {
    const sidecar = buildPlanTodoSidecar({
      planId,
      planPath: relativePath,
      planBodyHash: bodyHash,
      userRequestHash,
      assistantOutputHash,
      createdAt,
      manifest: manifestResult.manifest,
      manifestSource: manifestResult.source,
      manifestQuality: manifestResult.quality,
      manifestWarnings: manifestResult.warnings,
      manifestErrors: manifestResult.errors,
    });
    const sidecarPath = writePlanTodoSidecar(repoRoot, sidecar);
    entry.launch_status = "launchable";
    entry.todo_manifest_path = sidecarPath;
    entry.todo_manifest_hash = sidecar.manifest_hash;
    entry.todo_manifest_source = sidecar.manifest_source;
    entry.todo_manifest_quality = sidecar.manifest_quality;
    entry.todo_count = sidecar.todo_count;
    entry.todo_depth = sidecar.max_depth;
    entry.todo_manifest_warnings = manifestResult.warnings.length > 0 ? manifestResult.warnings : undefined;
  } else if (manifestResult.found) {
    entry.launch_status = "invalid_manifest";
    entry.todo_manifest_errors = manifestResult.errors;
    entry.todo_manifest_warnings = manifestResult.warnings.length > 0 ? manifestResult.warnings : undefined;
  } else {
    entry.launch_status = "needs_manifest";
    entry.todo_manifest_errors = manifestResult.errors.length > 0 ? manifestResult.errors : undefined;
    entry.todo_manifest_warnings = manifestResult.warnings.length > 0 ? manifestResult.warnings : undefined;
  }

  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, renderPlanMarkdown(entry, assistantText), "utf8");
  const updatedIndex: PlanIndex = { schema: PLAN_INDEX_SCHEMA, updated_at: createdAt, entries: [entry, ...index.entries] };
  writePlanIndex(repoRoot, updatedIndex);
  return { captured: true, reason: "captured", planId, title, relativePath, bodyHash };
}


export function ensureCapturedPlanTodoSidecar(repoRoot: string, planId: string, options: { persist?: boolean; now?: Date } = {}): PlanSidecarEnsureResult {
  const now = options.now ?? new Date();
  const index = readPlanIndex(repoRoot, now);
  const position = index.entries.findIndex((entry) => entry.plan_id === planId);
  if (position < 0) return { created: false, errors: [`Plan not found in .pi/plans/index.json or legacy plans/index.json: ${planId}`], warnings: [] };
  const entry = index.entries[position]!;
  const sidecarPath = entry.todo_manifest_path ?? planTodoSidecarRelativePath(entry.relative_path);
  if (entry.todo_manifest_path && (entry.launch_status === "launchable" || entry.launch_status === "launched")) {
    const safeSidecar = safePlanArtifactPath(repoRoot, entry.todo_manifest_path, ".json");
    if (safeSidecar.errors.length === 0 && existsSync(safeSidecar.absolutePath)) {
      return { entry, sidecarPath, created: false, errors: [], warnings: entry.todo_manifest_warnings ?? [] };
    }
  }

  const safe = safePlanArtifactPath(repoRoot, entry.relative_path, ".md");
  if (safe.errors.length > 0) return { entry, sidecarPath, created: false, errors: safe.errors, warnings: [] };
  if (!existsSync(safe.absolutePath)) return { entry, sidecarPath, created: false, errors: [`captured plan markdown not found: ${entry.relative_path}`], warnings: [] };

  const planText = readFileSync(safe.absolutePath, "utf8");
  const manifestResult = extractAndNormalizePlanTodoManifest(planText, { defaultObjective: entry.title });
  if (!manifestResult.manifest) {
    const errors = manifestResult.errors.length > 0 ? manifestResult.errors : ["Captured plan has no launchable TODO manifest and Markdown fallback did not produce one."];
    if (options.persist !== false) {
      const patched: PlanIndexEntry = {
        ...entry,
        launch_status: manifestResult.found ? "invalid_manifest" : "needs_manifest",
        todo_manifest_errors: errors,
        todo_manifest_warnings: manifestResult.warnings.length > 0 ? manifestResult.warnings : undefined,
      };
      index.entries[position] = patched;
      index.updated_at = now.toISOString();
      writePlanIndex(repoRoot, index);
      return { entry: patched, sidecarPath, created: false, errors, warnings: manifestResult.warnings };
    }
    return { entry, sidecarPath, created: false, errors, warnings: manifestResult.warnings };
  }

  const sidecar = buildPlanTodoSidecar({
    planId: entry.plan_id,
    planPath: entry.relative_path,
    planBodyHash: entry.body_hash,
    userRequestHash: entry.user_request_hash,
    assistantOutputHash: entry.assistant_output_hash,
    createdAt: entry.created_at,
    manifest: manifestResult.manifest,
    manifestSource: manifestResult.source,
    manifestQuality: manifestResult.quality,
    manifestWarnings: manifestResult.warnings,
    manifestErrors: manifestResult.errors,
  });

  const patched: PlanIndexEntry = {
    ...entry,
    launch_status: "launchable",
    todo_manifest_path: sidecarPath,
    todo_manifest_hash: sidecar.manifest_hash,
    todo_manifest_source: sidecar.manifest_source,
    todo_manifest_quality: sidecar.manifest_quality,
    todo_count: sidecar.todo_count,
    todo_depth: sidecar.max_depth,
    todo_manifest_errors: undefined,
    todo_manifest_warnings: manifestResult.warnings.length > 0 ? manifestResult.warnings : undefined,
  };

  if (options.persist !== false) {
    writePlanTodoSidecar(repoRoot, sidecar);
    index.entries[position] = patched;
    index.updated_at = now.toISOString();
    writePlanIndex(repoRoot, index);
  }

  return { entry: patched, sidecar, sidecarPath, created: true, errors: [], warnings: manifestResult.warnings };
}

export function listCapturedPlanEntries(repoRoot: string): PlanIndexEntry[] {
  return readPlanIndex(repoRoot, new Date()).entries;
}

export function updateCapturedPlanEntry(repoRoot: string, planId: string, patch: Partial<PlanIndexEntry>): PlanIndexEntry {
  const now = new Date();
  const index = readPlanIndex(repoRoot, now);
  const position = index.entries.findIndex((entry) => entry.plan_id === planId);
  if (position < 0) throw new Error(`Plan not found in .pi/plans/index.json or legacy plans/index.json: ${planId}`);
  const entry: PlanIndexEntry = { ...index.entries[position]!, ...patch, plan_id: index.entries[position]!.plan_id };
  index.entries[position] = entry;
  index.updated_at = now.toISOString();
  writePlanIndex(repoRoot, index);
  return entry;
}
