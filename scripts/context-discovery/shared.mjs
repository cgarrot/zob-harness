#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, normalize, relative, sep } from "node:path";

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
    maxResults: 20,
    maxContextLines: 2,
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
  const normalized = normalize(String(raw).replace(/^\.\//u, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    return null;
  }
  return normalized.split(sep).join("/");
}

function globToRegExp(pattern) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "iu");
}

function isExcluded(relPath, excludePaths) {
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
}

export function repoRelative(path) {
  return relative(repoRoot, join(repoRoot, path)).split(sep).join("/");
}
