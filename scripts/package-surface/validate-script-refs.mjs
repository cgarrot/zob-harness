#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, sep } from "node:path";

const repoRoot = process.cwd();
const packagePath = "package.json";
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
const fileRefPattern = /\.(?:cjs|js|json|mjs|sh|ts|tsx)$/u;

function runGit(args) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function splitShellWords(command) {
  const words = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    words.push(current);
  }

  return words;
}

function normalizeRepoPath(raw) {
  const withoutPrefix = raw.replace(/^\.\//u, "");
  const normalized = normalize(withoutPrefix);
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    return null;
  }
  return normalized.split(sep).join("/");
}

function looksLikeFileReference(token) {
  if (!token || token.startsWith("-") || token.includes("$")) {
    return false;
  }

  const pathLike = token.startsWith("./") || token.startsWith("scripts/") || token.startsWith(".pi/") || token.includes("/");
  return pathLike && fileRefPattern.test(token);
}

function isIgnored(relPath) {
  const result = runGit(["check-ignore", "--no-index", "--quiet", "--", relPath]);
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(`git check-ignore failed for ${relPath}: ${result.stderr.trim()}`);
}

function gitTrackingState(relPath) {
  const tracked = runGit(["ls-files", "--error-unmatch", "--", relPath]);
  if (tracked.status === 0) {
    return "tracked";
  }

  const status = runGit(["status", "--porcelain", "--", relPath]);
  if (status.status !== 0) {
    throw new Error(`git status failed for ${relPath}: ${status.stderr.trim()}`);
  }

  return status.stdout.trim().startsWith("?? ") ? "pending-add" : "untracked";
}

function coveringFilesEntry(relPath) {
  return packageFiles.find((entry) => {
    const normalizedEntry = normalizeRepoPath(entry);
    return normalizedEntry && (relPath === normalizedEntry || relPath.startsWith(`${normalizedEntry}/`));
  });
}

function hasGlobPattern(relPath) {
  return /[*?[{]/u.test(relPath);
}

function globToRegExp(relPath) {
  let pattern = "^";
  for (let index = 0; index < relPath.length; index += 1) {
    const char = relPath[index];
    const next = relPath[index + 1];

    if (char === "*" && next === "*") {
      const afterGlobstar = relPath[index + 2];
      if (afterGlobstar === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += char.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&");
  }

  return new RegExp(`${pattern}$`, "u");
}

function expandGitVisibleGlob(relPath) {
  const result = runGit(["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (result.status !== 0) {
    throw new Error(`git ls-files failed while expanding ${relPath}: ${result.stderr.trim()}`);
  }

  const pattern = globToRegExp(relPath);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter((entry) => entry && !hasGlobPattern(entry) && pattern.test(entry));
}

const refs = new Map();
for (const [scriptName, command] of Object.entries(scripts)) {
  if (typeof command !== "string") {
    continue;
  }

  for (const token of splitShellWords(command)) {
    if (!looksLikeFileReference(token)) {
      continue;
    }

    const relPath = normalizeRepoPath(token);
    if (!relPath) {
      refs.set(token, [...(refs.get(token) ?? []), scriptName]);
      continue;
    }

    refs.set(relPath, [...(refs.get(relPath) ?? []), scriptName]);
  }
}

const failures = [];
const rows = [];

for (const [relPath, scriptNames] of [...refs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  if (hasGlobPattern(relPath)) {
    const matches = expandGitVisibleGlob(relPath);
    if (!matches.length) {
      failures.push(`${relPath}: glob matched no git-visible files; referenced by ${scriptNames.join(", ")}`);
    }

    for (const match of matches) {
      const absoluteMatch = `${repoRoot}/${match}`;
      const exists = existsSync(absoluteMatch);
      const file = exists && statSync(absoluteMatch).isFile();
      const ignored = exists ? isIgnored(match) : false;
      const tracking = exists && !ignored ? gitTrackingState(match) : "not-checked";

      if (!exists) {
        failures.push(`${relPath}: matched missing file ${match}; referenced by ${scriptNames.join(", ")}`);
      } else if (!file) {
        failures.push(`${relPath}: matched non-file ${match}; referenced by ${scriptNames.join(", ")}`);
      }

      if (exists && ignored) {
        failures.push(`${relPath}: matched ignored file ${match}; referenced by ${scriptNames.join(", ")}`);
      }

      if (exists && !ignored && tracking === "untracked") {
        failures.push(
          `${relPath}: matched untracked file ${match} and not visible as a new pending add; referenced by ${scriptNames.join(", ")}`,
        );
      }
    }

    rows.push({ relPath, scriptNames, coveredBy: "glob", tracking: `${matches.length} match(es)` });
    continue;
  }

  const absolutePath = `${repoRoot}/${relPath}`;
  const exists = existsSync(absolutePath);
  const file = exists && statSync(absolutePath).isFile();
  const coveredBy = coveringFilesEntry(relPath);
  const ignored = exists ? isIgnored(relPath) : false;
  const tracking = exists && !ignored ? gitTrackingState(relPath) : "not-checked";

  if (!exists) {
    failures.push(`${relPath}: missing; referenced by ${scriptNames.join(", ")}`);
  } else if (!file) {
    failures.push(`${relPath}: not a file; referenced by ${scriptNames.join(", ")}`);
  }

  if (exists && ignored) {
    failures.push(`${relPath}: ignored by git; referenced by ${scriptNames.join(", ")}`);
  }

  if (exists && !ignored && tracking === "untracked") {
    failures.push(`${relPath}: untracked and not visible as a new pending add; referenced by ${scriptNames.join(", ")}`);
  }

  if (!coveredBy) {
    failures.push(`${relPath}: not covered by package.json files; referenced by ${scriptNames.join(", ")}`);
  }

  rows.push({ relPath, scriptNames, coveredBy, tracking });
}

if (!refs.size) {
  failures.push("package.json scripts contain no file references to validate");
}

if (failures.length) {
  console.error("script-surface validation FAIL");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`script-surface validation PASS (${rows.length} package.json script file refs checked)`);
for (const row of rows) {
  const location = relative(repoRoot, `${repoRoot}/${row.relPath}`).split(sep).join("/");
  console.log(`- ${location} <- ${row.scriptNames.join(", ")} (${row.tracking}, files:${row.coveredBy})`);
}
