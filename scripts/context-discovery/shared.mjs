#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, sep } from "node:path";

export const repoRoot = process.cwd();
export const configPath = ".pi/context-discovery.json";

export const defaultConfig = {
  schemaVersion: 1,
  preferredProvider: "colgrep",
  fallbackProvider: "grep",
  includePaths: [
    ".pi/extensions",
    ".pi/skills",
    ".pi/capabilities",
    "scripts",
    "docs",
    "README.md",
    "AGENTS.md",
  ],
  excludePaths: [
    ".env",
    "**/.env",
    ".env.*",
    "**/*secret*",
    "**/*key*",
    "*.pem",
    ".pi/sessions",
    ".pi/agent-sessions",
    "node_modules",
    "dist",
    "build",
  ],
  limits: {
    maxResults: 6,
    maxContextLines: 1,
    maxFileBytes: 1024 * 1024,
  },
  promptInjection: {
    enabled: true,
    includeInstallHint: true,
  },
};

export function loadConfig() {
  if (!existsSync(join(repoRoot, configPath))) {
    return { ...defaultConfig, loadedFrom: "defaults" };
  }
  const parsed = JSON.parse(readFileSync(join(repoRoot, configPath), "utf8"));
  return {
    ...defaultConfig,
    ...parsed,
    includePaths: Array.isArray(parsed.includePaths) ? parsed.includePaths : defaultConfig.includePaths,
    excludePaths: Array.isArray(parsed.excludePaths) ? parsed.excludePaths : defaultConfig.excludePaths,
    limits: { ...defaultConfig.limits, ...(parsed.limits ?? {}) },
    promptInjection: { ...defaultConfig.promptInjection, ...(parsed.promptInjection ?? {}) },
    loadedFrom: configPath,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function commandExists(command) {
  if (process.env.ZOB_CONTEXT_FORCE_FALLBACK === "1") {
    return false;
  }
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(command)}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

export function detectColgrep() {
  const installed = commandExists("colgrep");
  if (!installed) {
    return {
      provider: "grep-fallback",
      installed: false,
      ready: false,
      guidance: "ColGREP is not on PATH. Install/setup it manually if desired, then run npm run zob:context:init. Fallback search remains active.",
    };
  }

  const status = spawnSync("colgrep", ["status"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    provider: status.status === 0 ? "colgrep" : "grep-fallback",
    installed: true,
    ready: status.status === 0,
    statusCode: status.status,
    stdout: status.stdout?.trim() ?? "",
    stderr: status.stderr?.trim() ?? "",
    guidance: status.status === 0
      ? "ColGREP detected and status check passed."
      : "ColGREP is installed but not ready/indexed. Run npm run zob:context:init or inspect colgrep status output.",
  };
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export function normalizeRepoPath(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.includes("\0") || raw.includes("\\")) {
    return null;
  }
  const trimmed = raw.trim().replace(/^\.\//u, "");
  if (isAbsolute(trimmed)) {
    return null;
  }
  const normalized = normalize(trimmed);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    return null;
  }
  return normalized.split(sep).join("/");
}

export function normalizeBackendPath(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.includes("\0")) {
    return null;
  }
  const trimmed = raw.trim();
  if (!isAbsolute(trimmed)) {
    return normalizeRepoPath(trimmed);
  }
  const relPath = relative(repoRoot, trimmed);
  if (!relPath || relPath === ".." || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) {
    return null;
  }
  return normalizeRepoPath(relPath);
}

function globToRegExp(pattern) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "iu");
}

export function isExcluded(relPath, excludePaths) {
  const normalized = normalizeRepoPath(relPath);
  if (!normalized) {
    return true;
  }
  return excludePaths.some((pattern) => {
    const clean = normalizeRepoPath(pattern) ?? pattern;
    if (clean.includes("*")) {
      return globToRegExp(clean).test(normalized) || globToRegExp(clean.replace(/^\*\*\//u, "")).test(basename(normalized));
    }
    return normalized === clean || normalized.startsWith(`${clean}/`) || basename(normalized) === clean;
  });
}

function looksTextFile(relPath) {
  const textExts = new Set(["", ".cjs", ".css", ".js", ".json", ".md", ".mjs", ".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
  return textExts.has(extname(relPath).toLowerCase());
}

function collectFiles(startRel, config, out) {
  const safeRel = normalizeRepoPath(startRel);
  if (!safeRel || isExcluded(safeRel, config.excludePaths)) {
    return;
  }
  const absolute = join(repoRoot, safeRel);
  if (!existsSync(absolute)) {
    return;
  }
  const stat = statSync(absolute);
  if (stat.isFile()) {
    if (stat.size <= config.limits.maxFileBytes && looksTextFile(safeRel)) {
      out.push(safeRel);
    }
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    collectFiles(join(safeRel, entry.name), config, out);
  }
}

export function fallbackSearch({ query, config, maxResults, maxContextLines }) {
  const files = [];
  for (const includePath of config.includePaths) {
    collectFiles(includePath, config, files);
  }

  const wanted = String(query ?? "").toLowerCase();
  const results = [];
  for (const relPath of [...new Set(files)].sort()) {
    if (results.length >= maxResults) {
      break;
    }
    const content = readFileSync(join(repoRoot, relPath), "utf8");
    const lines = content.split(/\r?\n/u);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (!lines[lineIndex].toLowerCase().includes(wanted)) {
        continue;
      }
      const start = Math.max(0, lineIndex - maxContextLines);
      const end = Math.min(lines.length, lineIndex + maxContextLines + 1);
      results.push({
        path: relPath,
        line: lineIndex + 1,
        ref: `${relPath}:${lineIndex + 1}`,
        preview: lines[lineIndex].trim().slice(0, 240),
        context: lines.slice(start, end).map((text, offset) => ({ line: start + offset + 1, text: text.slice(0, 240) })),
      });
      if (results.length >= maxResults) {
        break;
      }
    }
  }

  return {
    provider: "grep-fallback",
    fallback: true,
    query,
    maxResults,
    maxContextLines,
    resultCount: results.length,
    results,
    recommendedVerification: results.length
      ? [`grep -n ${shellQuote(query)} ${shellQuote(results[0].path)}`, `read ${results[0].path}`]
      : [`grep -R -n ${shellQuote(query)} ${config.includePaths.map(shellQuote).join(" ")}`],
  };
}

export function normalizeColgrepResults(stdout, { query, config, maxResults, maxContextLines }) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = [];
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? [parsed.results, parsed.matches, parsed.items].find(Array.isArray) ?? []
      : [];
  const results = [];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const unit = item.unit && typeof item.unit === "object" ? item.unit : {};
    const path = normalizeBackendPath(item.path ?? item.file ?? item.filename ?? item.source_path ?? unit.path ?? unit.file ?? unit.filename ?? unit.source_path);
    if (!path || isExcluded(path, config.excludePaths) || !existsSync(join(repoRoot, path))) continue;
    const lineValue = item.line ?? item.lineNumber ?? item.line_number ?? item.start_line ?? unit.line ?? unit.lineNumber ?? unit.line_number ?? unit.start_line;
    const line = Number.isFinite(Number(lineValue)) ? Math.max(1, Math.floor(Number(lineValue))) : undefined;
    const previewSource = item.preview ?? item.text ?? item.lineText ?? item.match ?? unit.docstring ?? unit.signature ?? unit.qualified_name ?? unit.name ?? path;
    const preview = String(previewSource).replace(/\s+/gu, " ").trim().slice(0, 240);
    results.push({
      path,
      line,
      ref: line ? `${path}:${line}` : path,
      preview,
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : undefined,
    });
    if (results.length >= maxResults) break;
  }
  return {
    provider: "colgrep",
    fallback: false,
    query,
    maxResults,
    maxContextLines,
    resultCount: results.length,
    results,
    recommendedVerification: results.length
      ? [`read ${results[0].path}`, "After reading, grep exact identifiers/strings found in returned refs for final proof."]
      : ["No compact ColGREP refs parsed; retry with a narrower query or inspect ColGREP status."],
  };
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printHumanSearch(result) {
  console.log(`provider: ${result.provider}`);
  console.log(`fallback: ${result.fallback ? "yes" : "no"}`);
  console.log(`results: ${result.resultCount}`);
  for (const item of result.results ?? []) {
    console.log(`- ${item.ref}: ${item.preview}`);
  }
  const verification = Array.isArray(result.recommendedVerification) ? result.recommendedVerification.slice(0, 2) : [];
  if (verification.length > 0) {
    console.log(`verify: ${verification.join(" ; ")}`);
  }
}

export function repoRelative(path) {
  return relative(repoRoot, join(repoRoot, path)).split(sep).join("/");
}
