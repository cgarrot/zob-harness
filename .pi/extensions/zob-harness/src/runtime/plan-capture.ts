import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ModeName } from "../types.js";
import { sha256 } from "../utils/hashing.js";
import { safeFileStem } from "../utils/paths.js";
import { looksLikeCompletePlanResponse, stripModeIntentMarkup } from "./mode-intent.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plansDir(repoRoot: string): string {
  return join(repoRoot, "plans");
}

function planIndexPath(repoRoot: string): string {
  return join(plansDir(repoRoot), "index.json");
}

function planIndexMarkdownPath(repoRoot: string): string {
  return join(plansDir(repoRoot), "index.md");
}

function planReadmePath(repoRoot: string): string {
  return join(plansDir(repoRoot), "README.md");
}

function normalizePlanText(text: string): string {
  return stripModeIntentMarkup(text).replace(/\s+$/g, "").trim();
}

function userAskedForPlan(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(plan|planning|roadmap|architecture|strat[eé]gie|sp[eé]cification|spec|conception|design|impl[eé]mentation|ordre de patch|tdd|étapes?|etapes?)\b/i.test(text);
}

export function shouldCapturePlanResponse(input: PlanCaptureInput): boolean {
  const text = normalizePlanText(input.assistantText);
  if (text.length < 160) return false;
  if (looksLikeCompletePlanResponse(text)) return true;
  if (!userAskedForPlan(input.userText) && input.mode !== "plan") return false;
  const structuralSignals = [
    /^\s*#{1,3}\s+.*\bplan\b/im.test(text),
    /^\s*(?:plan|roadmap|objectif|objectifs|scope|p[eé]rim[eè]tre)\b/im.test(text),
    (text.match(/^\s*(?:#{1,4}\s*)?(?:phase|patch|étape|etape|step)\s+\d+/gim) ?? []).length >= 1,
    (text.match(/^\s*\d+[.)]\s+/gm) ?? []).length >= 3,
    /\b(validation|tests?|risques?|risks?|fichiers?|files|succ[eè]s|success)\b/i.test(text),
  ].filter(Boolean).length;
  return structuralSignals >= 2;
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
  return {
    plan_id: planId,
    title,
    created_at: createdAt,
    mode: mode === "explore" || mode === "plan" || mode === "implement" || mode === "oracle" || mode === "factory" ? mode : "unknown",
    status,
    relative_path: relativePath,
    body_hash: bodyHash,
    user_request_hash: userRequestHash,
    assistant_output_hash: assistantOutputHash,
  };
}

function readPlanIndex(repoRoot: string, now: Date): PlanIndex {
  const indexPath = planIndexPath(repoRoot);
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

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function markdownLink(entry: PlanIndexEntry): string {
  const href = entry.relative_path.replace(/^plans\//, "");
  return `[${escapeMarkdownTableCell(entry.title)}](${href})`;
}

function renderPlanIndexMarkdown(index: PlanIndex): string {
  const rows = index.entries.map((entry) => `| ${entry.created_at.slice(0, 10)} | ${markdownLink(entry)} | ${entry.mode} | ${entry.status} | ${entry.body_hash.slice(0, 12)} |`);
  return [
    "# ZOB Plans Index",
    "",
    "Visible auto-captured planning artifacts. Source user prompts are stored as hashes only; captured assistant plans are stored in the linked Markdown files.",
    "",
    "| Date | Plan | Mode | Status | Hash |",
    "|---|---|---|---|---|",
    ...(rows.length > 0 ? rows : ["| — | — | — | — | — |"]),
    "",
  ].join("\n");
}

function ensurePlansReadme(repoRoot: string): void {
  const readmePath = planReadmePath(repoRoot);
  if (existsSync(readmePath)) return;
  writeFileSync(readmePath, [
    "# ZOB Plans",
    "",
    "This directory stores visible planning artifacts automatically captured by the ZOB harness.",
    "",
    "- `index.md` is the human-readable index.",
    "- `index.json` is the machine-readable duplicate-detection manifest.",
    "- Date folders contain the captured Markdown plans.",
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
    "---",
    "",
    `# ${entry.title}`,
    "",
    "> Captured automatically by the ZOB harness. Source user prompt text is not persisted in this artifact; hashes are retained for duplicate detection.",
    "",
    "## Captured Plan",
    "",
    assistantText.trim(),
    "",
    "## Metadata",
    "",
    `- plan_id: ${entry.plan_id}`,
    `- mode: ${entry.mode}`,
    `- status: ${entry.status}`,
    `- body_hash: ${entry.body_hash}`,
    "",
  ].join("\n");
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
  const relativePath = `plans/${dateDir}/${planId}-${slug}.md`;
  const absolutePath = join(repoRoot, relativePath);
  const entry: PlanIndexEntry = {
    plan_id: planId,
    title,
    created_at: createdAt,
    mode: input.mode ?? "unknown",
    status: "draft",
    relative_path: relativePath,
    body_hash: bodyHash,
    user_request_hash: sha256(userText),
    assistant_output_hash: sha256(assistantText),
  };

  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, renderPlanMarkdown(entry, assistantText), "utf8");
  const updatedIndex: PlanIndex = { schema: PLAN_INDEX_SCHEMA, updated_at: createdAt, entries: [entry, ...index.entries] };
  writePlanIndex(repoRoot, updatedIndex);
  return { captured: true, reason: "captured", planId, title, relativePath, bodyHash };
}
