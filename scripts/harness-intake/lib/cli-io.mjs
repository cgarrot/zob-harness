import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LEGACY_RUNS_ROOT, RUNS_ROOT, repoRoot } from "./constants.mjs";

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    const rawValue = eq === -1 ? undefined : arg.slice(eq + 1);
    if (["allow-sessions", "demo", "self", "prepare-only", "help", "allow-repo-root", "write"].includes(key)) {
      out[toCamel(key)] = true;
      continue;
    }
    const value = rawValue ?? argv[++i];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    const camel = toCamel(key);
    if (["sessionPath", "source", "allowedFile"].includes(camel)) {
      out[camel] = [...(out[camel] ?? []), value];
    } else {
      out[camel] = value;
    }
  }
  return out;
}

export function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace(/[TZ]/g, "-").replace(/-$/u, "").toLowerCase();
}

export function safeRunId(value) {
  const cleaned = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.length > 120) throw new Error(`invalid run id: ${value}`);
  return cleaned;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeText(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, value, "utf8");
}

export function runDirFor(runId) {
  return join(RUNS_ROOT, safeRunId(runId));
}

export function resolveRunDir(runIdOrDir) {
  if (!runIdOrDir) throw new Error("missing run id or run dir");
  const candidate = String(runIdOrDir);
  const maybeDir = candidate.includes("/") ? candidate : (existsSync(runDirFor(candidate)) || !existsSync(join(LEGACY_RUNS_ROOT, safeRunId(candidate))) ? runDirFor(candidate) : join(LEGACY_RUNS_ROOT, safeRunId(candidate)));
  const resolved = resolve(repoRoot, maybeDir);
  const rel = relative(repoRoot, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("run dir must stay inside repo");
  return resolved;
}

export function repoRel(path) {
  return relative(repoRoot, path).split(sep).join("/");
}
