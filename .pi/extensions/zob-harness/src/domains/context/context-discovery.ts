import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, sep } from "node:path";

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
    colgrepTimeoutMs: number;
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
  limits: { maxResults: 6, maxContextLines: 1, maxFileBytes: 1024 * 1024, colgrepTimeoutMs: 8_000 },
  promptInjection: { enabled: true, includeInstallHint: true },
  loadedFrom: "defaults",
};
const TEXT_EXTENSIONS = new Set(["", ".cjs", ".css", ".js", ".json", ".md", ".mjs", ".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const COLGREP_DEFAULT_TIMEOUT_MS = 8_000;
const COLGREP_MAX_OUTPUT_BYTES = 1024 * 1024;
const FALLBACK_CANDIDATE_BUDGET = 500;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numberValue)));
}

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractFallbackSearchTerms(query: string): string[] {
  const rawTerms = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const usefulTerms = rawTerms.filter((term) => term.length >= 3 || /\d/u.test(term) || term.includes("_") || term.includes("-"));
  return [...new Set(usefulTerms)].sort((left, right) => right.length - left.length || left.localeCompare(right)).slice(0, 12);
}

function fallbackLineScore(lineLower: string, queryLower: string, terms: string[]): number {
  let score = queryLower.length > 0 && lineLower.includes(queryLower) ? 100 : 0;
  for (const term of terms) {
    if (lineLower.includes(term)) score += Math.min(10, term.length);
  }
  return score;
}

function getColgrepTimeoutMs(config: ContextDiscoveryConfig): number {
  return clampInteger(process.env.ZOB_CONTEXT_COLGREP_TIMEOUT_MS ?? config.limits.colgrepTimeoutMs, COLGREP_DEFAULT_TIMEOUT_MS, 500, 30_000);
}

function buildFallbackVerificationCommand(query: string, roots: string[], searchTerms: string[], mode: ContextSearchMode, pattern?: string): string {
  const rootArgs = roots.map(shellQuote).join(" ") || ".";
  if (mode === "regex") return `grep -R -n -E ${shellQuote(pattern ?? query)} ${rootArgs}`;
  const grepPattern = searchTerms.length > 0 ? searchTerms.slice(0, 10).map(escapeRegExpLiteral).join("|") : escapeRegExpLiteral(query);
  return `grep -R -n -E ${shellQuote(grepPattern)} ${rootArgs}`;
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

function normalizeBackendPath(repoRoot: string, raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.includes("\0")) return undefined;
  if (!isAbsolute(raw)) return normalizeRepoPath(raw);
  const relPath = relative(repoRoot, raw);
  if (!relPath || relPath === ".." || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) return undefined;
  return normalizeRepoPath(relPath);
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
    return `\n\nZOB ACTIVE SEARCH BACKEND\n- active search backend: colgrep\n- prompt injection: enabled by ${scope}; bounded per turn from current repo config, not a global/stale context pack.\n- For exploratory, natural-language, or "where is this mechanism?" repo discovery, start with zob_context_search/ColGREP before grep/find.\n- If zob_context_search is not listed in your available tools but bash is available, run npm run --silent zob:context:query -- --query "<natural language query>" --max-results 6 --max-context-lines 1 before rg/grep; the wrapper returns compact refs by default.\n- Do not conclude the native tool is unavailable and immediately use broad rg/grep; use the wrapper above as the ColGREP path.\n- Reuse zob_context_search/ColGREP at context pivot points: new subsystem/domain, ambiguous or broad file area, fallback_status suggesting narrower paths, repeated low-signal grep/find, unfamiliar code before edits, or unknown validation/test failure.\n- Use grep/read after semantic discovery for exact proof, known identifiers, final citations, and line refs; use grep/read directly when exact identifiers or paths are already known.\n- Never run broad grep/find over .pi unless .pi/sessions and .pi/agent-sessions are explicitly excluded/pruned.\n- Search output must stay bounded and avoid forbidden paths/secrets.`;
  }
  const installHint = config.promptInjection.includeInstallHint ? `\n- Optional ColGREP setup hint: ${detection.guidance}` : "";
  return `\n\nZOB ACTIVE SEARCH BACKEND\n- active search backend: grep fallback\n- prompt injection: enabled by ${scope}; bounded per turn from current repo config, not a global/stale context pack.\n- Prefer zob_context_search when listed; if not listed and bash is available, npm run --silent zob:context:query -- --query "<query>" still gives the same bounded compact fallback path.${installHint}\n- Reuse the active context path at pivots such as new subsystem/domain, ambiguous file area, fallback_status suggesting narrower paths, repeated low-signal grep/find, unfamiliar code before edits, or unknown validation/test failure.\n- Missing ColGREP is not a blocker; do not auto-install it.\n- Use grep/read for exact proof and when exact identifiers or paths are already known; never run broad grep/find over .pi unless .pi/sessions and .pi/agent-sessions are explicitly excluded/pruned.`;
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
  const unit = typeof item.unit === "object" && item.unit !== null ? item.unit as Record<string, unknown> : undefined;
  const rawPath = item.path ?? item.file ?? item.filename ?? item.source_path ?? unit?.path ?? unit?.file ?? unit?.filename ?? unit?.source_path;
  const path = normalizeBackendPath(repoRoot, rawPath);
  if (!path || pathIsExcluded(path, config.excludePaths) || !existsSync(join(repoRoot, path))) return undefined;
  const lineValue = item.line ?? item.lineNumber ?? item.line_number ?? item.start_line ?? unit?.line ?? unit?.lineNumber ?? unit?.line_number ?? unit?.start_line;
  const line = typeof lineValue === "number" ? Math.max(1, Math.floor(lineValue)) : undefined;
  const rawPreview = item.preview ?? item.text ?? item.lineText ?? item.content ?? item.match ?? unit?.preview ?? unit?.text ?? unit?.lineText ?? unit?.content ?? unit?.code ?? unit?.docstring ?? unit?.signature ?? unit?.qualified_name ?? unit?.name ?? "";
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

type ColgrepRunResult = { ok: boolean; results: NormalizedContextResult[]; error?: string };

async function runColgrep(repoRoot: string, query: string, roots: string[], config: ContextDiscoveryConfig, maxResults: number, maxContextLines: number, timeoutMs: number): Promise<ColgrepRunResult> {
  const args = ["--json", "-k", String(maxResults), "-n", String(maxContextLines), query, ...roots];
  return await new Promise<ColgrepRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("colgrep", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (value: ColgrepRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, results: [], error: `ColGREP exceeded ${String(timeoutMs)}ms; bounded grep fallback used. Retry with narrower paths for semantic ranking.` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > COLGREP_MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish({ ok: false, results: [], error: "colgrep output exceeded compact result budget; retry with lower max_results." });
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, results: [], error: error.message.slice(0, 240) }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, results: [], error: stderr.trim().slice(0, 240) || `colgrep exited ${String(code)}` });
        return;
      }
      finish({ ok: true, results: extractJsonResults(repoRoot, stdout, config, maxResults) });
    });
  });
}

function fallbackSearch(repoRoot: string, params: Required<Pick<ContextSearchParams, "query" | "mode">> & Pick<ContextSearchParams, "pattern" | "paths">, config: ContextDiscoveryConfig, maxResults: number, maxContextLines: number): { results: NormalizedContextResult[]; rejectedPaths: string[]; roots: string[]; searchTerms: string[] } {
  const { roots, rejected } = safeSearchRoots(repoRoot, config, params.paths);
  const files: string[] = [];
  for (const root of roots) collectFiles(repoRoot, root, config, files);
  const needle = params.mode === "regex" ? params.pattern ?? params.query : params.query;
  const queryLower = params.query.toLowerCase();
  const searchTerms = params.mode === "regex" ? [] : extractFallbackSearchTerms(params.query);
  let regex: RegExp | undefined;
  if (params.mode === "regex") {
    try { regex = new RegExp(needle, "iu"); } catch { regex = undefined; }
  }
  const results: NormalizedContextResult[] = [];
  const rankedResults: NormalizedContextResult[] = [];
  const pushRankedResult = (result: NormalizedContextResult): void => {
    rankedResults.push(result);
    if (rankedResults.length > FALLBACK_CANDIDATE_BUDGET) {
      rankedResults.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.ref.localeCompare(right.ref));
      rankedResults.length = FALLBACK_CANDIDATE_BUDGET;
    }
  };
  for (const path of [...new Set(files)].sort()) {
    if ((params.mode === "files" || params.mode === "regex") && results.length >= maxResults) break;
    if (params.mode === "files") {
      if (!path.toLowerCase().includes(queryLower)) continue;
      results.push({ path, ref: path, preview: path });
      continue;
    }
    const lines = readFileSync(join(repoRoot, path), "utf8").split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index];
      const score = regex ? undefined : fallbackLineScore(lineText.toLowerCase(), queryLower, searchTerms);
      const matched = regex ? regex.test(lineText) : (score ?? 0) > 0;
      if (!matched) continue;
      const start = Math.max(0, index - maxContextLines);
      const end = Math.min(lines.length, index + maxContextLines + 1);
      const result = {
        path,
        line: index + 1,
        ref: `${path}:${index + 1}`,
        preview: lineText.trim().slice(0, 240),
        context: lines.slice(start, end).map((text, offset) => ({ line: start + offset + 1, text: text.slice(0, 240) })),
        score,
      } satisfies NormalizedContextResult;
      if (regex) {
        results.push(result);
        if (results.length >= maxResults) break;
      } else {
        pushRankedResult(result);
      }
    }
  }
  if (params.mode !== "files" && params.mode !== "regex") {
    rankedResults.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.ref.localeCompare(right.ref));
    results.push(...rankedResults.slice(0, maxResults));
  }
  return { results, rejectedPaths: rejected, roots, searchTerms };
}

export async function runContextSearch(repoRoot: string, input: ContextSearchParams): Promise<Record<string, unknown>> {
  const config = loadContextDiscoveryConfig(repoRoot);
  const query = String(input.query ?? "").trim();
  const mode = input.mode ?? "auto";
  const maxResults = clampInteger(input.max_results, config.limits.maxResults, 1, 50);
  const maxContextLines = clampInteger(input.max_context_lines, config.limits.maxContextLines, 0, 5);
  const colgrepTimeoutMs = getColgrepTimeoutMs(config);
  const detection = detectColgrep(repoRoot);
  const { roots, rejected } = safeSearchRoots(repoRoot, config, input.paths);
  let provider = detection.ready ? "colgrep" : "grep-fallback";
  let fallback = !detection.ready;
  let fallbackReason = detection.ready ? undefined : detection.guidance;
  let fallbackSearchTerms: string[] = [];
  let results: NormalizedContextResult[] = [];
  if (detection.ready && mode !== "regex" && mode !== "files") {
    const colgrep = await runColgrep(repoRoot, query, roots, config, maxResults, maxContextLines, colgrepTimeoutMs);
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
    if (!fallback) {
      provider = "grep-fallback";
      fallback = true;
      fallbackReason = "ColGREP returned no compact refs; tokenized grep fallback used.";
    }
    const fallbackResult = fallbackSearch(repoRoot, { query, mode, pattern: input.pattern, paths: input.paths }, config, maxResults, maxContextLines);
    results = fallbackResult.results;
    fallbackSearchTerms = fallbackResult.searchTerms;
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
    limits: { maxResults, maxContextLines, colgrepTimeoutMs },
    fallbackSearchTerms,
    recommendedVerification: refs.length > 0
      ? [`read ${results[0]?.path ?? roots[0] ?? "."}`, "Then grep exact identifiers/strings for proof; rerun zob_context_search at context pivots or when fallback_status suggests narrower paths."]
      : [buildFallbackVerificationCommand(query, roots, fallbackSearchTerms, mode, input.pattern), "If low-signal or ambiguous, rerun zob_context_search with narrower paths/query, then read exact files."],
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
