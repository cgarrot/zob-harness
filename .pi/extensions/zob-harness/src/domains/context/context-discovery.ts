import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";

export type ContextSearchMode = "auto" | "semantic" | "hybrid" | "regex" | "files";

export interface ContextDiscoveryConfig {
  schemaVersion: number;
  preferredProvider: string;
  fallbackProvider: string;
  includePaths: string[];
  excludePaths: string[];
  limits: {
    maxResults: number;
    maxContextLines: number;
    maxFileBytes: number;
  };
  promptInjection: {
    enabled: boolean;
    includeInstallHint: boolean;
  };
  loadedFrom: string;
}

export interface ContextSearchParams {
  query: string;
  mode?: ContextSearchMode;
  pattern?: string;
  paths?: string[];
  max_results?: number;
  max_context_lines?: number;
  json?: boolean;
}

interface NormalizedContextResult {
  path: string;
  line?: number;
  ref: string;
  preview: string;
  context?: Array<{ line: number; text: string }>;
  score?: number;
}

const CONFIG_PATH = ".pi/context-discovery.json";
const DEFAULT_CONFIG: ContextDiscoveryConfig = {
  schemaVersion: 1,
  preferredProvider: "colgrep",
  fallbackProvider: "grep",
  includePaths: [".pi/extensions", ".pi/skills", ".pi/capabilities", "scripts", "docs", "README.md", "AGENTS.md"],
  excludePaths: [".env", "**/.env", ".env.*", "**/*secret*", "**/*key*", "*.pem", ".pi/sessions", ".pi/agent-sessions", "node_modules", "dist", "build"],
  limits: { maxResults: 20, maxContextLines: 2, maxFileBytes: 1024 * 1024 },
  promptInjection: { enabled: true, includeInstallHint: true },
  loadedFrom: "defaults",
};
const TEXT_EXTENSIONS = new Set(["", ".cjs", ".css", ".js", ".json", ".md", ".mjs", ".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numberValue)));
}

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "iu");
}

export function normalizeRepoPath(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim().replace(/^\.\//u, "");
  if (trimmed.includes("\0") || trimmed.includes("\\") || isAbsolute(trimmed)) return undefined;
  const normalized = normalize(trimmed);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) return undefined;
  return normalized.split(sep).join("/");
}

function pathIsExcluded(relPath: string, excludePaths: string[]): boolean {
  const normalized = normalizeRepoPath(relPath);
  if (!normalized) return true;
  return excludePaths.some((pattern) => {
    const clean = normalizeRepoPath(pattern) ?? pattern;
    if (clean.includes("*")) {
      return globToRegExp(clean).test(normalized) || globToRegExp(clean.replace(/^\*\*\//u, "")).test(basename(normalized));
    }
    return normalized === clean || normalized.startsWith(`${clean}/`) || basename(normalized) === clean;
  });
}

export function loadContextDiscoveryConfig(repoRoot: string): ContextDiscoveryConfig {
  const path = join(repoRoot, CONFIG_PATH);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ContextDiscoveryConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      includePaths: Array.isArray(parsed.includePaths) ? parsed.includePaths.filter((item): item is string => typeof item === "string") : DEFAULT_CONFIG.includePaths,
      excludePaths: Array.isArray(parsed.excludePaths) ? parsed.excludePaths.filter((item): item is string => typeof item === "string") : DEFAULT_CONFIG.excludePaths,
      limits: { ...DEFAULT_CONFIG.limits, ...(parsed.limits ?? {}) },
      promptInjection: { ...DEFAULT_CONFIG.promptInjection, ...(parsed.promptInjection ?? {}) },
      loadedFrom: CONFIG_PATH,
    };
  } catch {
    return { ...DEFAULT_CONFIG, loadedFrom: `${CONFIG_PATH}:unreadable-fallback-defaults` };
  }
}

function commandExists(repoRoot: string, command: string): boolean {
  if (process.env.ZOB_CONTEXT_FORCE_FALLBACK === "1") return false;
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(command)}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2_000 });
  return result.status === 0 && result.stdout.trim().length > 0;
}

export function detectColgrep(repoRoot: string): { provider: "colgrep" | "grep-fallback"; installed: boolean; ready: boolean; statusCode?: number | null; guidance: string } {
  if (!commandExists(repoRoot, "colgrep")) {
    return { provider: "grep-fallback", installed: false, ready: false, guidance: "ColGREP is not on PATH. Optional setup: install ColGREP manually, then run npm run zob:context:init. Grep/find fallback is active." };
  }
  const status = spawnSync("colgrep", ["status"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
  const ready = status.status === 0;
  return {
    provider: ready ? "colgrep" : "grep-fallback",
    installed: true,
    ready,
    statusCode: status.status,
    guidance: ready ? "ColGREP detected and ready." : "ColGREP is installed but not ready/indexed. Run npm run zob:context:init or inspect colgrep status. Grep/find fallback is active.",
  };
}

export function buildActiveSearchBackendPromptSnippet(repoRoot: string): string {
  const config = loadContextDiscoveryConfig(repoRoot);
  if (!config.promptInjection.enabled) return "";
  const detection = detectColgrep(repoRoot);
  const scope = `${config.loadedFrom}; roots=${config.includePaths.slice(0, 6).join(",")}; excludes=${config.excludePaths.length}`;
  if (detection.ready) {
    return `\n\nZOB ACTIVE SEARCH BACKEND\n- active search backend: colgrep\n- prompt injection: enabled by ${scope}; bounded per turn from current repo config, not a global/stale context pack.\n- Prefer zob_context_search for codebase discovery and broad/semantic search; use grep/read for exact proof and final citations.\n- Search output must stay bounded and avoid forbidden paths/secrets.`;
  }
  const installHint = config.promptInjection.includeInstallHint ? `\n- Optional ColGREP setup hint: ${detection.guidance}` : "";
  return `\n\nZOB ACTIVE SEARCH BACKEND\n- active search backend: grep fallback\n- prompt injection: enabled by ${scope}; bounded per turn from current repo config, not a global/stale context pack.\n- Prefer zob_context_search, grep, find, and read for bounded repo-local discovery and exact proof.${installHint}\n- Missing ColGREP is not a blocker; do not auto-install it.`;
}

function safeSearchRoots(repoRoot: string, config: ContextDiscoveryConfig, requestedPaths?: string[]): { roots: string[]; rejected: string[] } {
  const source = requestedPaths && requestedPaths.length > 0 ? requestedPaths : config.includePaths;
  const roots: string[] = [];
  const rejected: string[] = [];
  for (const raw of source) {
    const relPath = normalizeRepoPath(raw);
    if (!relPath || pathIsExcluded(relPath, config.excludePaths)) {
      rejected.push(String(raw));
      continue;
    }
    if (!existsSync(join(repoRoot, relPath))) {
      rejected.push(String(raw));
      continue;
    }
    roots.push(relPath);
  }
  return { roots: [...new Set(roots)].sort(), rejected };
}

function looksTextFile(relPath: string): boolean {
  return TEXT_EXTENSIONS.has(extname(relPath).toLowerCase());
}

function collectFiles(repoRoot: string, relPath: string, config: ContextDiscoveryConfig, out: string[]): void {
  const safeRel = normalizeRepoPath(relPath);
  if (!safeRel || pathIsExcluded(safeRel, config.excludePaths)) return;
  const absolute = join(repoRoot, safeRel);
  if (!existsSync(absolute)) return;
  const stat = statSync(absolute);
  if (stat.isFile()) {
    if (stat.size <= config.limits.maxFileBytes && looksTextFile(safeRel)) out.push(safeRel);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) collectFiles(repoRoot, join(safeRel, entry.name), config, out);
}

function normalizeLineResult(repoRoot: string, item: Record<string, unknown>, config: ContextDiscoveryConfig): NormalizedContextResult | undefined {
  const rawPath = item.path ?? item.file ?? item.filename ?? item.source_path;
  const path = normalizeRepoPath(rawPath);
  if (!path || pathIsExcluded(path, config.excludePaths) || !existsSync(join(repoRoot, path))) return undefined;
  const lineValue = item.line ?? item.lineNumber ?? item.line_number ?? item.start_line;
  const line = typeof lineValue === "number" ? Math.max(1, Math.floor(lineValue)) : undefined;
  const rawPreview = item.preview ?? item.text ?? item.lineText ?? item.content ?? item.match ?? "";
  const preview = String(rawPreview).replace(/\s+/gu, " ").trim().slice(0, 240);
  const score = typeof item.score === "number" ? item.score : undefined;
  return { path, line, ref: line ? `${path}:${line}` : path, preview, score };
}

function extractJsonResults(repoRoot: string, stdout: string, config: ContextDiscoveryConfig, maxResults: number): NormalizedContextResult[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const container = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
    const candidates = Array.isArray(container) ? container : [container.results, container.matches, container.items].find(Array.isArray) ?? [];
    return (candidates as unknown[]).filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null).map((item) => normalizeLineResult(repoRoot, item, config)).filter((item): item is NormalizedContextResult => Boolean(item)).slice(0, maxResults);
  } catch {
    return [];
  }
}

function runColgrep(repoRoot: string, query: string, roots: string[], config: ContextDiscoveryConfig, maxResults: number, maxContextLines: number): { ok: boolean; results: NormalizedContextResult[]; error?: string } {
  const args = ["--json", "-k", String(maxResults), "-n", String(maxContextLines), query, ...roots];
  const result = spawnSync("colgrep", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) return { ok: false, results: [], error: result.stderr.trim().slice(0, 240) || `colgrep exited ${String(result.status)}` };
  const results = extractJsonResults(repoRoot, result.stdout, config, maxResults);
  return { ok: true, results };
}

function fallbackSearch(repoRoot: string, params: Required<Pick<ContextSearchParams, "query" | "mode">> & Pick<ContextSearchParams, "pattern" | "paths">, config: ContextDiscoveryConfig, maxResults: number, maxContextLines: number): { results: NormalizedContextResult[]; rejectedPaths: string[]; roots: string[] } {
  const { roots, rejected } = safeSearchRoots(repoRoot, config, params.paths);
  const files: string[] = [];
  for (const root of roots) collectFiles(repoRoot, root, config, files);
  const needle = params.mode === "regex" ? params.pattern ?? params.query : params.query;
  let regex: RegExp | undefined;
  if (params.mode === "regex") {
    try { regex = new RegExp(needle, "iu"); } catch { regex = undefined; }
  }
  const results: NormalizedContextResult[] = [];
  for (const path of [...new Set(files)].sort()) {
    if (results.length >= maxResults) break;
    if (params.mode === "files") {
      if (!path.toLowerCase().includes(params.query.toLowerCase())) continue;
      results.push({ path, ref: path, preview: path });
      continue;
    }
    const lines = readFileSync(join(repoRoot, path), "utf8").split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const matched = regex ? regex.test(lines[index]) : lines[index].toLowerCase().includes(params.query.toLowerCase());
      if (!matched) continue;
      const start = Math.max(0, index - maxContextLines);
      const end = Math.min(lines.length, index + maxContextLines + 1);
      results.push({
        path,
        line: index + 1,
        ref: `${path}:${index + 1}`,
        preview: lines[index].trim().slice(0, 240),
        context: lines.slice(start, end).map((text, offset) => ({ line: start + offset + 1, text: text.slice(0, 240) })),
      });
      if (results.length >= maxResults) break;
    }
  }
  return { results, rejectedPaths: rejected, roots };
}

export function runContextSearch(repoRoot: string, input: ContextSearchParams): Record<string, unknown> {
  const config = loadContextDiscoveryConfig(repoRoot);
  const query = String(input.query ?? "").trim();
  const mode = input.mode ?? "auto";
  const maxResults = clampInteger(input.max_results, config.limits.maxResults, 1, 50);
  const maxContextLines = clampInteger(input.max_context_lines, config.limits.maxContextLines, 0, 5);
  const detection = detectColgrep(repoRoot);
  const { roots, rejected } = safeSearchRoots(repoRoot, config, input.paths);
  let provider = detection.ready ? "colgrep" : "grep-fallback";
  let fallback = !detection.ready;
  let fallbackReason = detection.ready ? undefined : detection.guidance;
  let results: NormalizedContextResult[] = [];
  if (detection.ready && mode !== "regex" && mode !== "files") {
    const colgrep = runColgrep(repoRoot, query, roots, config, maxResults, maxContextLines);
    if (colgrep.ok) results = colgrep.results;
    else {
      provider = "grep-fallback";
      fallback = true;
      fallbackReason = colgrep.error ?? "ColGREP query failed; grep fallback used.";
    }
  } else if (detection.ready) {
    provider = "grep-fallback";
    fallback = true;
    fallbackReason = `${mode} mode uses exact grep/find fallback for deterministic results.`;
  }
  if (fallback || results.length === 0) {
    const fallbackResult = fallbackSearch(repoRoot, { query, mode, pattern: input.pattern, paths: input.paths }, config, maxResults, maxContextLines);
    results = fallbackResult.results;
  }
  const refs = results.map((item) => item.ref);
  return {
    schema: "zob.context-search-result.v1",
    provider,
    preferredProvider: config.preferredProvider,
    fallback,
    fallbackReason,
    colgrepInstalled: detection.installed,
    colgrepReady: detection.ready,
    mode,
    resultCount: results.length,
    refs,
    results,
    searchedRoots: roots,
    rejectedPaths: rejected,
    limits: { maxResults, maxContextLines },
    recommendedVerification: refs.length > 0
      ? [`grep -n ${shellQuote(query)} ${shellQuote(results[0]?.path ?? roots[0] ?? ".")}`, `read ${results[0]?.path ?? roots[0] ?? "."}`]
      : [`grep -R -n ${shellQuote(query)} ${roots.map(shellQuote).join(" ") || "."}`, "find relevant safe paths, then read exact files"],
    safety: { repoRelativeOnly: true, forbiddenPathsExcluded: config.excludePaths, rawPromptOrConversationPersisted: false, autoInstall: false },
  };
}

export function formatContextSearchResult(result: Record<string, unknown>): string {
  const provider = String(result.provider ?? "unknown");
  const fallback = result.fallback === true ? "yes" : "no";
  const count = typeof result.resultCount === "number" ? result.resultCount : 0;
  const lines = [`zob_context_search: provider=${provider} fallback=${fallback} results=${count}`];
  const reason = typeof result.fallbackReason === "string" ? result.fallbackReason : undefined;
  if (reason) lines.push(`fallback_status: ${reason}`);
  const results = Array.isArray(result.results) ? result.results.slice(0, 10) : [];
  for (const item of results) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    lines.push(`- ${String(record.ref ?? record.path ?? "result")}: ${String(record.preview ?? "").slice(0, 240)}`);
  }
  const verification = Array.isArray(result.recommendedVerification) ? result.recommendedVerification.slice(0, 2).map(String) : [];
  if (verification.length > 0) lines.push(`verify: ${verification.join(" ; ")}`);
  return lines.join("\n");
}
