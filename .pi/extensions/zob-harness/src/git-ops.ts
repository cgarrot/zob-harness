import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { pathMatches } from "./utils/paths.js";

export type ZcommitToggleState = "on" | "off";

export type ZcommitValidationMode = "off" | "advisory" | "blocking";
export type ZcommitFileSelectionStrategy = "agent_owned" | "workspace_filtered";

export interface ZcommitPolicy {
  schema?: string;
  defaults?: { autocommit?: ZcommitToggleState; autopush?: ZcommitToggleState };
  commandSurface?: { allowedCommands?: string[]; aliasesAllowed?: boolean; explicitOnly?: boolean };
  authorization?: { baseline?: string; autocommitRequires?: string[]; autopushRequires?: string[] };
  commitMessage?: { allowedTypes?: string[]; format?: string; required?: boolean; requireImperativeSummary?: boolean; includeValidationEvidenceWhenUseful?: boolean };
  validation?: { mode?: ZcommitValidationMode; runBeforeCommit?: boolean; requiredBeforeCommit?: boolean; requiredBeforePush?: boolean; recordCommandsAndResults?: boolean; allowExplicitException?: boolean };
  fileSelection?: { strategy?: ZcommitFileSelectionStrategy; forbiddenPaths?: string[]; onlyAgentOwnedFiles?: boolean; excludeUnrelatedDirtyFiles?: boolean; bulkStageAllAllowed?: boolean };
  remotes?: { allowed?: string[]; default?: string };
  branches?: { allowedPatterns?: string[]; protectedDirectPushRequiresExplicitUserApproval?: string[] };
  push?: { forcePushAllowed?: boolean; tagsAllowed?: boolean; pushAllAllowed?: boolean; setUpstreamAllowedOnlyWhenExplicit?: boolean };
}

export type ZcommitOwnershipSource = "local_tool_call" | "parent_accepted_child_claim" | "compaction_continuity" | "explicit_zcommit_adopt";

export interface ZcommitChildChangedPathRef {
  path: string;
  pathHash: string;
  status: string;
  contentHash?: string;
}

export interface ZcommitChildDirtySnapshot {
  paths: Record<string, ZcommitChildChangedPathRef>;
  errors: string[];
}

export interface ZcommitTouchedFileRecord {
  path: string;
  firstTouchedAt: string;
  lastTouchedAt: string;
  tools: Array<"edit" | "write">;
  sources: ZcommitOwnershipSource[];
  count: number;
}

export interface ZcommitOwnedPathRef {
  path: string;
  source: ZcommitOwnershipSource;
  pathHash: string;
  firstOwnedAt: string;
  lastOwnedAt: string;
}

export interface ZcommitValidationRecord {
  command: string[];
  ok: boolean;
  output: string;
  ranAt: string;
}

export interface ZcommitLastCommitRecord {
  hash: string;
  shortHash: string;
  subject: string;
  files: string[];
  remote?: string;
  branch?: string;
  createdAt: string;
  pushedAt?: string;
}

export interface ZcommitRuntimeState {
  autocommit: ZcommitToggleState;
  autopush: ZcommitToggleState;
  touchedFiles: Record<string, ZcommitTouchedFileRecord>;
  ownedPathRefs: Record<string, ZcommitOwnedPathRef>;
  lastValidation?: ZcommitValidationRecord;
  lastCommit?: ZcommitLastCommitRecord;
  sessionStartedAt?: string;
  updatedAt?: string;
}

export interface GitDirtyFile {
  path: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
  originalPath?: string;
}

export interface ZcommitPlanFile extends GitDirtyFile {
  owned: boolean;
  forbidden: boolean;
  staged: boolean;
  reason?: string;
}

export interface ZcommitPlanOptions {
  pathspecs?: string[];
  message?: string;
  body?: string[];
}

export interface ZcommitPlan {
  schema: "zob.zcommit-plan.v1";
  policyLoaded: boolean;
  policyErrors: string[];
  gitErrors: string[];
  toggles: { autocommit: ZcommitToggleState; autopush: ZcommitToggleState };
  selectionMode: ZcommitFileSelectionStrategy;
  validationMode: ZcommitValidationMode;
  selectionPathspecs: string[];
  dirtyFiles: GitDirtyFile[];
  touchedFiles: string[];
  eligible: ZcommitPlanFile[];
  excluded: ZcommitPlanFile[];
  forbidden: ZcommitPlanFile[];
  unexpectedStaged: ZcommitPlanFile[];
  noShip: boolean;
  noShipNotes: string[];
  conventionalCommit: { type: string; scope: string; subject: string; body: string[] };
  requiredValidation: string[][];
  commitEnabled: boolean;
  pushEnabled: boolean;
}

export interface ZcommitCommandResult {
  ok: boolean;
  action: "commit" | "push";
  message: string;
  plan: ZcommitPlan;
  errors: string[];
  validation?: ZcommitValidationRecord;
  commit?: ZcommitLastCommitRecord;
  actualGitCommitRun: boolean;
  actualGitPushRun: boolean;
}

export interface ZcommitAdoptResult {
  ok: boolean;
  action: "adopt";
  message: string;
  requestedPaths: string[];
  adopted: string[];
  excluded: Array<{ path: string; reason: string; status?: string }>;
  errors: string[];
  plan: ZcommitPlan;
  actualGitCommitRun: false;
  actualGitPushRun: false;
}

export function createZcommitRuntimeState(policy?: ZcommitPolicy): ZcommitRuntimeState {
  return {
    autocommit: policy?.defaults?.autocommit === "on" ? "on" : "off",
    autopush: policy?.defaults?.autopush === "on" ? "on" : "off",
    touchedFiles: {},
    ownedPathRefs: {},
    sessionStartedAt: new Date().toISOString(),
  };
}

export function normalizeRepoRelativePath(repoRoot: string, inputPath: string): string | undefined {
  const root = resolve(repoRoot);
  const absolutePath = resolve(root, inputPath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) return undefined;
  const rel = relative(root, absolutePath).replace(/\\/g, "/");
  return rel.length > 0 ? rel : ".";
}

function hardForbiddenZcommitPatterns(policy: ZcommitPolicy): string[] {
  return [
    ...(policy.fileSelection?.forbiddenPaths ?? []),
    ".git/",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "node_modules/",
    "dist/",
    "build/",
    "reports/",
    ".pi/sessions/",
    ".pi/agent-sessions/",
    ".pi/tmp/",
    ".pi/logs/",
    ".pi/coms/",
    ".pi/context/",
    ".pi/goal-rooms/",
    ".pi/workspace-claims/",
    ".pi/worker-pools/",
    ".pi/merge-queue/",
  ];
}

function zcommitPathAllowed(repoRoot: string, policy: ZcommitPolicy, normalizedPath: string): boolean {
  if (normalizedPath === "." || normalizedPath.trim().length === 0 || normalizedPath.includes("\0")) return false;
  return !hardForbiddenZcommitPatterns(policy).some((pattern) => pathMatches(normalizedPath, pattern, repoRoot));
}

function zcommitPathHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function zcommitFileContentHash(repoRoot: string, path: string): string | undefined {
  const absolutePath = resolve(repoRoot, path);
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) return undefined;
    return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  } catch {
    return undefined;
  }
}

function zcommitPathWithinAllowed(repoRoot: string, normalizedPath: string, allowedPaths: string[] | undefined): boolean {
  if (!allowedPaths || allowedPaths.length === 0) return false;
  return allowedPaths.some((allowedPath) => pathMatches(normalizedPath, allowedPath, repoRoot));
}

function hasZcommitAdoptWildcard(inputPath: string): boolean {
  return /[*?[\]{}]/.test(inputPath);
}

function isExplicitZcommitAdoptArg(repoRoot: string, inputPath: string, normalizedPath: string): boolean {
  if (inputPath.trim().length === 0) return false;
  if (inputPath.startsWith("/")) return false;
  if (inputPath.includes("\0")) return false;
  if (hasZcommitAdoptWildcard(inputPath)) return false;
  if (normalizedPath === "." || normalizedPath.trim().length === 0) return false;
  try {
    if (statSync(resolve(repoRoot, normalizedPath)).isDirectory()) return false;
  } catch {
    // Deleted dirty files may no longer exist on disk; exact deleted file paths remain adoptable.
  }
  return true;
}

function zcommitDirtyFileMatchesAdoptPath(file: GitDirtyFile, requestedPath: string): boolean {
  return file.path === requestedPath || file.originalPath === requestedPath;
}

function hasZcommitPathspecWildcard(inputPath: string): boolean {
  return /[*?[\]{}]/.test(inputPath);
}

function normalizeZcommitPathspec(repoRoot: string, inputPath: string): string | undefined {
  const trimmed = inputPath.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) return undefined;
  if (trimmed === "." || trimmed === "./" || trimmed.startsWith("/") || trimmed.startsWith("~")) return undefined;
  if (/(^|\/)\.\.(\/|$)/.test(trimmed)) return undefined;
  const withoutDotSlash = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  if (hasZcommitPathspecWildcard(withoutDotSlash)) return withoutDotSlash;
  const normalized = normalizeRepoRelativePath(repoRoot, withoutDotSlash);
  if (!normalized || normalized === ".") return undefined;
  return withoutDotSlash.endsWith("/") ? `${normalized}/` : normalized;
}

function normalizeZcommitPathspecs(repoRoot: string, inputPathspecs: string[] = []): { pathspecs: string[]; errors: string[] } {
  const pathspecs: string[] = [];
  const errors: string[] = [];
  for (const inputPathspec of inputPathspecs) {
    const normalized = normalizeZcommitPathspec(repoRoot, inputPathspec);
    if (!normalized) {
      errors.push(`invalid zcommit pathspec (must be repo-relative file, directory, or glob): ${inputPathspec || "<empty>"}`);
      continue;
    }
    pathspecs.push(normalized);
  }
  return { pathspecs: uniqueSorted(pathspecs), errors };
}

function zcommitPathspecMatchesDirtyFile(file: GitDirtyFile, pathspec: string, repoRoot: string): boolean {
  return pathMatches(file.path, pathspec, repoRoot) || Boolean(file.originalPath && pathMatches(file.originalPath, pathspec, repoRoot));
}

export function captureZcommitChildDirtySnapshot(repoRoot: string, policyInput: { allowedPaths?: string[]; forbiddenPaths?: string[] } = {}): ZcommitChildDirtySnapshot {
  const { policy } = readZcommitPolicy(repoRoot);
  const mergedPolicy: ZcommitPolicy = {
    ...policy,
    fileSelection: {
      ...(policy.fileSelection ?? {}),
      forbiddenPaths: [...(policy.fileSelection?.forbiddenPaths ?? []), ...(policyInput.forbiddenPaths ?? [])],
    },
  };
  const { files, errors } = readGitDirtyFiles(repoRoot);
  const paths: Record<string, ZcommitChildChangedPathRef> = {};
  for (const file of files) {
    const normalizedPath = normalizeRepoRelativePath(repoRoot, file.path);
    if (!normalizedPath) continue;
    if (!zcommitPathAllowed(repoRoot, mergedPolicy, normalizedPath)) continue;
    if (!zcommitPathWithinAllowed(repoRoot, normalizedPath, policyInput.allowedPaths)) continue;
    paths[normalizedPath] = {
      path: normalizedPath,
      pathHash: zcommitPathHash(normalizedPath),
      status: file.status,
      contentHash: zcommitFileContentHash(repoRoot, normalizedPath),
    };
  }
  return { paths, errors };
}

export function diffZcommitChildDirtySnapshots(before: ZcommitChildDirtySnapshot, after: ZcommitChildDirtySnapshot): ZcommitChildChangedPathRef[] {
  return Object.values(after.paths)
    .filter((afterRef) => {
      const beforeRef = before.paths[afterRef.path];
      if (!beforeRef) return true;
      return beforeRef.status !== afterRef.status || beforeRef.contentHash !== afterRef.contentHash;
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function recordZcommitOwnedPaths(state: ZcommitRuntimeState, repoRoot: string, paths: ZcommitChildChangedPathRef[], source: ZcommitOwnershipSource, at = new Date().toISOString()): string[] {
  const recorded: string[] = [];
  for (const ref of paths) {
    if (recordZcommitOwnedPath(state, repoRoot, ref.path, source, at)) recorded.push(ref.path);
  }
  return recorded.sort();
}

export function recordZcommitOwnedPath(state: ZcommitRuntimeState, repoRoot: string, inputPath: string, source: ZcommitOwnershipSource, at = new Date().toISOString()): boolean {
  const normalizedPath = normalizeRepoRelativePath(repoRoot, inputPath);
  if (!normalizedPath) return false;
  const { policy } = readZcommitPolicy(repoRoot);
  if (!zcommitPathAllowed(repoRoot, policy, normalizedPath)) return false;
  const existing = state.ownedPathRefs[normalizedPath];
  state.ownedPathRefs[normalizedPath] = existing
    ? { ...existing, source: existing.source === source ? existing.source : source, lastOwnedAt: at }
    : { path: normalizedPath, source, pathHash: zcommitPathHash(normalizedPath), firstOwnedAt: at, lastOwnedAt: at };
  state.updatedAt = at;
  return true;
}

export function recordZcommitTouchedFile(state: ZcommitRuntimeState, repoRoot: string, inputPath: string, tool: "edit" | "write", at = new Date().toISOString()): void {
  if (!recordZcommitOwnedPath(state, repoRoot, inputPath, "local_tool_call", at)) return;
  const normalizedPath = normalizeRepoRelativePath(repoRoot, inputPath);
  if (!normalizedPath) return;
  const existing = state.touchedFiles[normalizedPath];
  const nextSources: ZcommitOwnershipSource[] = existing?.sources?.includes("local_tool_call") ? existing.sources : [...(existing?.sources ?? []), "local_tool_call"];
  state.touchedFiles[normalizedPath] = existing
    ? { ...existing, lastTouchedAt: at, tools: existing.tools.includes(tool) ? existing.tools : [...existing.tools, tool], sources: nextSources, count: existing.count + 1 }
    : { path: normalizedPath, firstTouchedAt: at, lastTouchedAt: at, tools: [tool], sources: ["local_tool_call"], count: 1 };
  state.updatedAt = at;
}

export function runGovernedZcommitAdopt(repoRoot: string, runtime: ZcommitRuntimeState, inputPaths: string[]): ZcommitAdoptResult {
  const { policy, loaded, errors: policyErrors } = readZcommitPolicy(repoRoot);
  const { files: dirtyFiles, errors: gitErrors } = readGitDirtyFiles(repoRoot);
  const requestedPaths: string[] = [];
  const requestedSet = new Set<string>();
  const adopted: string[] = [];
  const excluded: ZcommitAdoptResult["excluded"] = [];
  const errors = [...policyErrors, ...gitErrors];
  const at = new Date().toISOString();

  if (!loaded) errors.push(".pi/git-policy.json must load before /zcommit adopt");
  if (inputPaths.length === 0) errors.push("usage: /zcommit adopt <repo-relative dirty paths...>");

  for (const inputPath of inputPaths) {
    const normalizedPath = normalizeRepoRelativePath(repoRoot, inputPath);
    if (!normalizedPath || !isExplicitZcommitAdoptArg(repoRoot, inputPath, normalizedPath)) {
      errors.push(`adopt path rejected (must be exact repo-relative dirty file path, non-root, non-directory, no wildcards): ${inputPath || "<empty>"}`);
      continue;
    }
    if (!zcommitPathAllowed(repoRoot, policy, normalizedPath)) {
      excluded.push({ path: normalizedPath, reason: "forbidden_by_git_policy" });
      continue;
    }
    if (!requestedSet.has(normalizedPath)) {
      requestedSet.add(normalizedPath);
      requestedPaths.push(normalizedPath);
    }
  }

  for (const requestedPath of requestedPaths) {
    const matches = dirtyFiles.filter((file) => zcommitDirtyFileMatchesAdoptPath(file, requestedPath));
    if (matches.length === 0) {
      excluded.push({ path: requestedPath, reason: "no_matching_dirty_file" });
      continue;
    }
    for (const file of matches) {
      const originalForbidden = file.originalPath ? !zcommitPathAllowed(repoRoot, policy, file.originalPath) : false;
      if (!zcommitPathAllowed(repoRoot, policy, file.path) || originalForbidden) {
        excluded.push({ path: file.path, reason: "forbidden_by_git_policy", status: file.status });
        continue;
      }
      if (isStaged(file)) {
        excluded.push({ path: file.path, reason: "staged_file_not_adopted", status: file.status });
        errors.push(`adopt blocked for staged dirty path: ${file.path}`);
        continue;
      }
      if (recordZcommitOwnedPath(runtime, repoRoot, file.path, "explicit_zcommit_adopt", at)) adopted.push(file.path);
    }
  }

  const uniqueAdopted = uniqueSorted(adopted);
  const plan = buildZcommitPlan(repoRoot, runtime);
  const ok = errors.length === 0 && uniqueAdopted.length > 0;
  const message = `zcommit adopt ${ok ? "completed" : "blocked"}: adopted=${uniqueAdopted.length} excluded=${excluded.length} errors=${errors.length}; plan eligible=${plan.eligible.length} commit=${plan.commitEnabled ? "gated" : "blocked"}`;
  return { ok, action: "adopt", message, requestedPaths, adopted: uniqueAdopted, excluded, errors, plan, actualGitCommitRun: false, actualGitPushRun: false };
}

export function readZcommitPolicy(repoRoot: string): { policy: ZcommitPolicy; loaded: boolean; errors: string[] } {
  const policyPath = resolve(repoRoot, ".pi/git-policy.json");
  if (!existsSync(policyPath)) return { policy: {}, loaded: false, errors: [".pi/git-policy.json not found"] };
  try {
    const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as ZcommitPolicy;
    return { policy: parsed, loaded: true, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { policy: {}, loaded: false, errors: [`failed to parse .pi/git-policy.json: ${message}`] };
  }
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function parsePorcelainZ(stdout: string): GitDirtyFile[] {
  const entries = stdout.split("\0").filter((entry) => entry.length > 0);
  const files: GitDirtyFile[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    const file: GitDirtyFile = { path, status, indexStatus: status[0] ?? " ", worktreeStatus: status[1] ?? " " };
    if (status.includes("R") || status.includes("C")) {
      const originalPath = entries[index + 1];
      if (originalPath) {
        file.originalPath = originalPath;
        index += 1;
      }
    }
    files.push(file);
  }
  return files;
}

export function readGitDirtyFiles(repoRoot: string): { files: GitDirtyFile[]; errors: string[] } {
  try {
    return { files: parsePorcelainZ(runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])), errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { files: [], errors: [`git status failed: ${message}`] };
  }
}

function isStaged(file: GitDirtyFile): boolean {
  return file.indexStatus !== " " && file.indexStatus !== "?";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringSet(left: string[], right: string[]): boolean {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function zcommitValidationMode(policy: ZcommitPolicy): ZcommitValidationMode {
  const mode = policy.validation?.mode;
  if (mode === "off" || mode === "advisory" || mode === "blocking") return mode;
  if (policy.validation?.requiredBeforeCommit === false) return "off";
  return "blocking";
}

function zcommitFileSelectionStrategy(policy: ZcommitPolicy): ZcommitFileSelectionStrategy {
  const strategy = policy.fileSelection?.strategy;
  if (strategy === "agent_owned" || strategy === "workspace_filtered") return strategy;
  if (policy.fileSelection?.onlyAgentOwnedFiles === false || policy.fileSelection?.bulkStageAllAllowed === true || policy.fileSelection?.excludeUnrelatedDirtyFiles === false) return "workspace_filtered";
  return "agent_owned";
}

function defaultValidationCommands(policy: ZcommitPolicy): string[][] {
  const mode = zcommitValidationMode(policy);
  if (mode === "off") return [];
  if (policy.validation?.runBeforeCommit === false) return [];
  return [["npm", "run", "check", "--", "--pretty", "false"]];
}

function zcommitEligiblePaths(eligible: ZcommitPlanFile[]): string[] {
  return eligible.map((file) => file.path);
}

function isWorkerPoolCommit(paths: string[]): boolean {
  return paths.some((path) => path.includes("worker-pool") || path.includes("owner-pool") || path.includes("ZOB_PARALLEL_OWNER_POOLS"));
}

function inferConventionalCommitType(policy: ZcommitPolicy, eligible: ZcommitPlanFile[]): string {
  const allowed = policy.commitMessage?.allowedTypes ?? ["feat", "fix", "docs", "test", "refactor", "chore", "ci", "build", "perf", "revert"];
  const paths = zcommitEligiblePaths(eligible);
  const preferred = isWorkerPoolCommit(paths)
    ? "feat"
    : paths.length > 0 && paths.every((path) => /(^docs\/|\.md$)/.test(path))
      ? "docs"
      : paths.some((path) => /(^test\/|\.test\.|\.spec\.|smoke)/.test(path))
        ? "test"
        : paths.some((path) => /(^package(-lock)?\.json$|^\.github\/|^scripts\/)/.test(path)) && !paths.some((path) => path.includes("src/"))
          ? "chore"
          : "chore";
  return allowed.includes(preferred) ? preferred : (allowed.includes("chore") ? "chore" : (allowed[0] ?? "chore"));
}

function inferConventionalCommitScope(eligible: ZcommitPlanFile[]): string {
  const paths = zcommitEligiblePaths(eligible);
  if (isWorkerPoolCommit(paths)) return "worker-pool";
  if (paths.some((path) => path.includes("zcommit") || path === ".pi/git-policy.json" || path.includes("git-ops"))) return "zcommit";
  if (paths.some((path) => path.includes("runtime/"))) return "runtime";
  if (paths.some((path) => path.startsWith("scripts/"))) return "tooling";
  if (paths.length > 0 && paths.every((path) => /(^docs\/|\.md$)/.test(path))) return "docs";
  return "workspace";
}

function inferredConventionalCommitPlan(policy: ZcommitPolicy, eligible: ZcommitPlanFile[], selectionMode: ZcommitFileSelectionStrategy, validationMode: ZcommitValidationMode): ZcommitPlan["conventionalCommit"] {
  const type = inferConventionalCommitType(policy, eligible);
  const scope = inferConventionalCommitScope(eligible);
  if (scope === "worker-pool") {
    return {
      type,
      scope,
      subject: "add supervised owner micro-worker pools",
      body: [
        "Add metadata-only parallel owner micro-worker pool coordination with read-across/write-by-owner semantics, Goal Room owner requests/decisions, governed child owner-change extraction, workspace/sandbox/merge safety gates, public registry entries, prompts, skills, docs, and smoke coverage.",
        `Validation mode: ${validationMode}.`,
        `Eligible files: ${eligible.length}`,
      ],
    };
  }
  const subject = scope === "zcommit" ? "simplify governed commit workflow" : `update ${scope} changes`;
  return {
    type,
    scope,
    subject,
    body: [
      `Select safe workspace changes using ${selectionMode} mode.`,
      `Keep Conventional Commit formatting as the primary commit policy.`,
      `Validation mode: ${validationMode}.`,
      `Eligible files: ${eligible.length}`,
    ],
  };
}

function parseConventionalCommitOverride(policy: ZcommitPolicy, message: string | undefined, body: string[] | undefined, fallback: ZcommitPlan["conventionalCommit"]): { commit: ZcommitPlan["conventionalCommit"]; errors: string[] } {
  const trimmed = message?.trim();
  if (!trimmed) return { commit: fallback, errors: [] };
  const match = /^(\w+)(?:\(([A-Za-z0-9._-]+)\))?:\s+(.+)$/.exec(trimmed);
  if (!match) return { commit: fallback, errors: [`invalid Conventional Commit message: ${trimmed}`] };
  const [, type, rawScope, subject] = match;
  const allowed = policy.commitMessage?.allowedTypes ?? ["feat", "fix", "docs", "test", "refactor", "chore", "ci", "build", "perf", "revert"];
  const errors: string[] = [];
  if (!allowed.includes(type)) errors.push(`commit type '${type}' is not allowed by .pi/git-policy.json`);
  if (!subject || subject.trim().length === 0) errors.push("Conventional Commit subject must be non-empty");
  if (trimmed.length > 180) errors.push("Conventional Commit subject line is too long for /zcommit override");
  const safeBody = (body ?? []).map((line) => line.trim()).filter((line) => line.length > 0).slice(0, 20);
  return {
    commit: errors.length > 0 ? fallback : { type, scope: rawScope ?? fallback.scope, subject: subject.trim(), body: safeBody.length > 0 ? safeBody : fallback.body },
    errors,
  };
}

export function buildZcommitPlan(repoRoot: string, runtime: ZcommitRuntimeState, options: ZcommitPlanOptions = {}): ZcommitPlan {
  const { policy, loaded, errors: policyErrors } = readZcommitPolicy(repoRoot);
  const { files, errors: gitErrors } = readGitDirtyFiles(repoRoot);
  const { pathspecs: selectionPathspecs, errors: pathspecErrors } = normalizeZcommitPathspecs(repoRoot, options.pathspecs ?? []);
  const forbiddenPatterns = hardForbiddenZcommitPatterns(policy);
  const touched = new Set([...Object.keys(runtime.touchedFiles), ...Object.keys(runtime.ownedPathRefs ?? {})]);
  const selectionMode = zcommitFileSelectionStrategy(policy);
  const validationMode = zcommitValidationMode(policy);
  const workspaceFiltered = selectionMode === "workspace_filtered";
  const eligible: ZcommitPlanFile[] = [];
  const excluded: ZcommitPlanFile[] = [];
  const forbidden: ZcommitPlanFile[] = [];
  const unexpectedStaged: ZcommitPlanFile[] = [];

  for (const file of files) {
    const fileForbidden = forbiddenPatterns.some((pattern) => pathMatches(file.path, pattern, repoRoot));
    const originalForbidden = file.originalPath ? forbiddenPatterns.some((pattern) => pathMatches(file.originalPath ?? "", pattern, repoRoot)) : false;
    const isForbidden = fileForbidden || originalForbidden;
    const owned = touched.has(file.path) || (file.originalPath ? touched.has(file.originalPath) : false);
    const staged = isStaged(file);
    const matchesPathspecs = selectionPathspecs.length === 0 || selectionPathspecs.some((pathspec) => zcommitPathspecMatchesDirtyFile(file, pathspec, repoRoot));
    const planned: ZcommitPlanFile = { ...file, owned, forbidden: isForbidden, staged };
    if (!matchesPathspecs) {
      planned.reason = "outside_zcommit_pathspec_filter";
      excluded.push(planned);
      if (staged) unexpectedStaged.push(planned);
    } else if (isForbidden) {
      planned.reason = staged ? "forbidden_staged_path" : "forbidden_by_git_policy_excluded";
      forbidden.push(planned);
      excluded.push(planned);
      if (staged) unexpectedStaged.push(planned);
    } else if (workspaceFiltered || owned) {
      eligible.push(planned);
    } else {
      planned.reason = staged ? "unexpected_staged_file_not_touched_by_current_session" : "dirty_file_not_touched_by_current_session";
      excluded.push(planned);
      if (staged) unexpectedStaged.push(planned);
    }
  }

  const requiredValidation = defaultValidationCommands(policy);
  const inferredCommitMessage = inferredConventionalCommitPlan(policy, eligible, selectionMode, validationMode);
  const { commit: commitMessage, errors: commitMessageErrors } = parseConventionalCommitOverride(policy, options.message, options.body, inferredCommitMessage);
  const forbiddenStaged = forbidden.filter((file) => file.staged);
  const blockingNotes = [
    ...policyErrors,
    ...gitErrors,
    ...pathspecErrors,
    ...commitMessageErrors,
    ...(!loaded ? ["abort: .pi/git-policy.json must load before governed commit/push"] : []),
    ...(eligible.length === 0 ? [selectionPathspecs.length > 0 ? "abort: no safe dirty files match zcommit pathspecs" : workspaceFiltered ? "abort: no safe dirty workspace files to commit" : "abort: no eligible explicitly tracked agent-owned dirty files"] : []),
    ...(forbiddenStaged.length > 0 ? [`abort: forbidden paths are already staged and must be unstaged first: ${forbiddenStaged.map((file) => file.path).join(", ")}`] : []),
    ...(unexpectedStaged.some((file) => !file.forbidden) ? [selectionPathspecs.length > 0 ? "abort: pre-existing staged files outside zcommit pathspec selection" : workspaceFiltered ? "abort: pre-existing staged files outside safe workspace selection" : "abort: pre-existing staged files outside eligible touched set"] : []),
  ];
  const warningNotes = [
    ...(forbidden.some((file) => !file.staged) ? ["warning: forbidden dirty paths are excluded from the easy commit"] : []),
    ...(!workspaceFiltered && excluded.some((file) => file.reason === "dirty_file_not_touched_by_current_session") ? ["warning: unrelated unstaged dirty files are excluded and will not be staged"] : []),
    ...(requiredValidation.length > 0 ? [`validation ${validationMode} before commit: ${requiredValidation.map((cmd) => cmd.join(" ")).join(" && ")}`] : ["validation off before commit"]),
  ];
  const commitEnabled = loaded && policyErrors.length === 0 && gitErrors.length === 0 && pathspecErrors.length === 0 && commitMessageErrors.length === 0 && eligible.length > 0 && forbiddenStaged.length === 0 && !unexpectedStaged.some((file) => !file.forbidden);
  const pushEnabled = Boolean(runtime.lastCommit?.hash) && loaded && policyErrors.length === 0 && gitErrors.length === 0;

  return {
    schema: "zob.zcommit-plan.v1",
    policyLoaded: loaded,
    policyErrors,
    gitErrors,
    toggles: { autocommit: runtime.autocommit, autopush: runtime.autopush },
    selectionMode,
    validationMode,
    selectionPathspecs,
    dirtyFiles: files,
    touchedFiles: [...touched].sort(),
    eligible,
    excluded,
    forbidden,
    unexpectedStaged,
    noShip: blockingNotes.length > 0,
    noShipNotes: [...blockingNotes, ...warningNotes],
    conventionalCommit: commitMessage,
    requiredValidation,
    commitEnabled,
    pushEnabled,
  };
}

export function formatZcommitStatus(plan: ZcommitPlan): string {
  const pathspecs = plan.selectionPathspecs.join(", ") || "all-safe-dirty";
  return `zcommit status: mode=${plan.selectionMode} pathspecs=[${pathspecs}] validation=${plan.validationMode} autocommit=${plan.toggles.autocommit} autopush=${plan.toggles.autopush} policy=${plan.policyLoaded ? "loaded" : "missing/error"} dirty=${plan.dirtyFiles.length} touched=${plan.touchedFiles.length} eligible=${plan.eligible.length} excluded=${plan.excluded.length} forbidden=${plan.forbidden.length} unexpected_staged=${plan.unexpectedStaged.length} commit=${plan.commitEnabled ? "easy-ready" : "blocked"} push=${plan.pushEnabled ? "gated-ready" : "blocked"}`;
}

export function formatZcommitPlan(plan: ZcommitPlan): string {
  const eligible = plan.eligible.map((file) => file.path).join(", ") || "none";
  const excluded = plan.excluded.map((file) => `${file.path}${file.reason ? `(${file.reason})` : ""}`).join(", ") || "none";
  const notes = plan.noShipNotes.join(" | ") || "none";
  const commit = `${plan.conventionalCommit.type}(${plan.conventionalCommit.scope}): ${plan.conventionalCommit.subject}`;
  const validation = plan.requiredValidation.map((cmd) => cmd.join(" ")).join(" && ") || "none";
  const pathspecs = plan.selectionPathspecs.join(", ") || "all-safe-dirty";
  return `zcommit plan: mode=${plan.selectionMode} pathspecs=[${pathspecs}] eligible=[${eligible}] excluded=[${excluded}] no_ship=${String(plan.noShip)} notes=${notes} validation_mode=${plan.validationMode} validation="${validation}" conventional_commit="${commit}" commit=${plan.commitEnabled ? "easy" : "blocked"} push=${plan.pushEnabled ? "gated" : "blocked"}`;
}

function cachedNames(repoRoot: string): string[] {
  const stdout = runGit(repoRoot, ["diff", "--cached", "--name-only", "-z"]);
  return stdout.split("\0").filter(Boolean).sort();
}

function cachedPatch(repoRoot: string, paths: string[]): string {
  if (paths.length === 0) return "";
  return runGit(repoRoot, ["diff", "--cached", "--binary", "--", ...paths]);
}

function restoreCachedPaths(repoRoot: string, paths: string[], preAddPatch: string): void {
  if (paths.length === 0) return;
  execFileSync("git", ["restore", "--staged", "--", ...paths], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (preAddPatch.trim().length > 0) {
    execFileSync("git", ["apply", "--cached", "--binary", "--whitespace=nowarn"], { cwd: repoRoot, input: preAddPatch, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  }
}

function currentHead(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "HEAD"]).trim();
}

function currentBranch(repoRoot: string): string {
  return runGit(repoRoot, ["branch", "--show-current"]).trim();
}

function runRequiredValidation(repoRoot: string, commands: string[][]): ZcommitValidationRecord {
  const ranAt = new Date().toISOString();
  const outputs: string[] = [];
  try {
    for (const command of commands) {
      if (command.length === 0) continue;
      const [bin, ...args] = command;
      const output = execFileSync(bin, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      outputs.push(output.trim());
    }
    return { command: commands.flatMap((cmd, index) => (index === 0 ? cmd : ["&&", ...cmd])), ok: true, output: outputs.join("\n").slice(-4000), ranAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { command: commands.flatMap((cmd, index) => (index === 0 ? cmd : ["&&", ...cmd])), ok: false, output: message.slice(-4000), ranAt };
  }
}

function commitMessageArgs(plan: ZcommitPlan, validation: ZcommitValidationRecord): string[] {
  const subject = `${plan.conventionalCommit.type}(${plan.conventionalCommit.scope}): ${plan.conventionalCommit.subject}`;
  const validationLine = validation.command.length > 0 ? `Validation (${plan.validationMode}): ${validation.command.join(" ")} => ${validation.ok ? "passed" : "failed"}` : "Validation: not run";
  const body = [...plan.conventionalCommit.body, validationLine].join("\n");
  return ["commit", "-m", subject, "-m", body];
}

export function runGovernedZcommitCommit(repoRoot: string, runtime: ZcommitRuntimeState, options: ZcommitPlanOptions = {}): ZcommitCommandResult {
  let plan = buildZcommitPlan(repoRoot, runtime, options);
  if (!plan.commitEnabled) {
    return { ok: false, action: "commit", message: `zcommit commit blocked: ${plan.noShipNotes.join(" | ") || "commit gates failed"}`, plan, errors: plan.noShipNotes, actualGitCommitRun: false, actualGitPushRun: false };
  }

  const eligiblePaths = uniqueSorted(plan.eligible.map((file) => file.path));
  const preStaged = cachedNames(repoRoot);
  const preAddPatch = cachedPatch(repoRoot, eligiblePaths);
  let stagedByZcommit = false;
  const cleanupStagedByZcommit = (): void => {
    if (!stagedByZcommit) return;
    restoreCachedPaths(repoRoot, eligiblePaths, preAddPatch);
    stagedByZcommit = false;
  };
  const unexpectedPreStaged = preStaged.filter((file) => !eligiblePaths.includes(file));
  if (unexpectedPreStaged.length > 0) {
    const errors = ["pre-existing staged files outside safe zcommit selection", ...unexpectedPreStaged.map((file) => `unexpected staged: ${file}`)];
    return { ok: false, action: "commit", message: `zcommit commit blocked: ${errors.join(" | ")}`, plan, errors, actualGitCommitRun: false, actualGitPushRun: false };
  }

  const validation = runRequiredValidation(repoRoot, plan.requiredValidation);
  runtime.lastValidation = validation;
  runtime.updatedAt = validation.ranAt;
  if (!validation.ok && plan.validationMode === "blocking") {
    return { ok: false, action: "commit", message: `zcommit commit blocked: validation failed for ${validation.command.join(" ")}`, plan, errors: [validation.output], validation, actualGitCommitRun: false, actualGitPushRun: false };
  }

  try {
    execFileSync("git", ["add", "--", ...eligiblePaths], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    stagedByZcommit = true;
    const stagedAfterAdd = cachedNames(repoRoot);
    if (!sameStringSet(stagedAfterAdd, eligiblePaths)) {
      cleanupStagedByZcommit();
      const errors = [`cached diff path set mismatch: cached=[${stagedAfterAdd.join(", ")}] eligible=[${eligiblePaths.join(", ")}]`];
      return { ok: false, action: "commit", message: `zcommit commit blocked: ${errors[0]}`, plan, errors, validation, actualGitCommitRun: false, actualGitPushRun: false };
    }
    try {
      runGit(repoRoot, ["diff", "--cached", "--check"]);
    } catch (error) {
      cleanupStagedByZcommit();
      throw error;
    }
    try {
      execFileSync("git", commitMessageArgs(plan, validation), { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      cleanupStagedByZcommit();
      throw error;
    }
    stagedByZcommit = false;
    const hash = currentHead(repoRoot);
    const shortHash = runGit(repoRoot, ["rev-parse", "--short", "HEAD"]).trim();
    const subject = `${plan.conventionalCommit.type}(${plan.conventionalCommit.scope}): ${plan.conventionalCommit.subject}`;
    const createdAt = new Date().toISOString();
    const commit: ZcommitLastCommitRecord = { hash, shortHash, subject, files: eligiblePaths, createdAt };
    runtime.lastCommit = commit;
    runtime.updatedAt = createdAt;
    plan = buildZcommitPlan(repoRoot, runtime, options);
    return { ok: true, action: "commit", message: `zcommit commit created ${shortHash}: ${subject}`, plan, errors: [], validation, commit, actualGitCommitRun: true, actualGitPushRun: false };
  } catch (error) {
    try {
      cleanupStagedByZcommit();
    } catch (cleanupError) {
      const message = error instanceof Error ? error.message : String(error);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      return { ok: false, action: "commit", message: `zcommit commit failed: ${message}; cleanup failed: ${cleanupMessage}`, plan, errors: [message, `cleanup failed: ${cleanupMessage}`], validation, actualGitCommitRun: false, actualGitPushRun: false };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, action: "commit", message: `zcommit commit failed: ${message}`, plan, errors: [message], validation, actualGitCommitRun: false, actualGitPushRun: false };
  }
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function branchAllowed(branch: string, patterns: string[]): boolean {
  return patterns.some((pattern) => patternToRegex(pattern).test(branch));
}

export function runGovernedZcommitPush(repoRoot: string, runtime: ZcommitRuntimeState, options: { explicitPush: boolean } = { explicitPush: true }): ZcommitCommandResult {
  const plan = buildZcommitPlan(repoRoot, runtime);
  const errors: string[] = [];
  const { policy, loaded, errors: policyErrors } = readZcommitPolicy(repoRoot);
  if (!loaded) errors.push(".pi/git-policy.json must load before push");
  errors.push(...policyErrors);
  errors.push(...plan.gitErrors);
  if (plan.unexpectedStaged.length > 0) errors.push(`unexpected staged files present before push: ${plan.unexpectedStaged.map((file) => file.path).join(", ")}`);
  if (!runtime.lastCommit?.hash) errors.push("last commit must be created by /zcommit commit before push");
  if (!options.explicitPush && runtime.autocommit !== "on") errors.push("autocommit is off and no explicit /zcommit push command was used");
  if (!options.explicitPush && runtime.autopush !== "on") errors.push("autopush is off and no explicit /zcommit push command was used");

  let head = "";
  let branch = "";
  try {
    head = currentHead(repoRoot);
    branch = currentBranch(repoRoot);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (runtime.lastCommit?.hash && head && runtime.lastCommit.hash !== head) errors.push("HEAD is not the last commit created by /zcommit commit");
  if (!branch) errors.push("current branch is detached or unavailable");

  const forbiddenPatterns = policy.fileSelection?.forbiddenPaths ?? [];
  const forbiddenLastCommitFiles = (runtime.lastCommit?.files ?? []).filter((file) => forbiddenPatterns.some((pattern) => pathMatches(file, pattern, repoRoot)));
  if (forbiddenLastCommitFiles.length > 0) errors.push(`last /zcommit commit contains forbidden files: ${forbiddenLastCommitFiles.join(", ")}`);

  if (policy.validation?.requiredBeforePush !== false) {
    const validation = runtime.lastValidation;
    const commitCreatedAt = runtime.lastCommit?.createdAt;
    if (!validation) {
      errors.push("validation.requiredBeforePush requires successful validation before /zcommit push");
    } else if (!validation.ok) {
      errors.push("validation.requiredBeforePush requires the last validation to pass before /zcommit push");
    } else if (!commitCreatedAt) {
      errors.push("validation.requiredBeforePush requires last /zcommit commit creation time before /zcommit push");
    } else {
      const validationRanAt = Date.parse(validation.ranAt);
      const lastCommitCreatedAt = Date.parse(commitCreatedAt);
      if (Number.isNaN(validationRanAt) || Number.isNaN(lastCommitCreatedAt)) {
        errors.push("validation.requiredBeforePush requires valid validation and commit timestamps before /zcommit push");
      } else if (validationRanAt > lastCommitCreatedAt) {
        errors.push("validation.requiredBeforePush requires validation to run before or at the last /zcommit commit creation");
      }
    }
  }

  const remote = policy.remotes?.default ?? "origin";
  const allowedRemotes = policy.remotes?.allowed ?? [remote];
  if (!allowedRemotes.includes(remote)) errors.push(`remote '${remote}' is not allowed by .pi/git-policy.json`);
  const allowedBranches = policy.branches?.allowedPatterns ?? [];
  if (branch && !branchAllowed(branch, allowedBranches)) errors.push(`branch '${branch}' is not allowed by .pi/git-policy.json`);
  const protectedBranches = policy.branches?.protectedDirectPushRequiresExplicitUserApproval ?? [];
  if (branch && protectedBranches.includes(branch) && !options.explicitPush) errors.push(`branch '${branch}' requires explicit /zcommit push approval`);
  if (policy.push?.forcePushAllowed) errors.push("policy misconfiguration: forcePushAllowed must be false for governed zcommit push");
  if (policy.push?.tagsAllowed) errors.push("policy misconfiguration: tagsAllowed must be false for governed zcommit push");
  if (policy.push?.pushAllAllowed) errors.push("policy misconfiguration: pushAllAllowed must be false for governed zcommit push");

  if (errors.length > 0) return { ok: false, action: "push", message: `zcommit push blocked: ${errors.join(" | ")}`, plan, errors, actualGitCommitRun: false, actualGitPushRun: false };

  try {
    execFileSync("git", ["push", remote, `HEAD:${branch}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const pushedAt = new Date().toISOString();
    runtime.lastCommit = { ...runtime.lastCommit!, remote, branch, pushedAt };
    runtime.updatedAt = pushedAt;
    return { ok: true, action: "push", message: `zcommit push completed: ${remote} HEAD:${branch}`, plan: buildZcommitPlan(repoRoot, runtime), errors: [], commit: runtime.lastCommit, actualGitCommitRun: false, actualGitPushRun: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, action: "push", message: `zcommit push failed: ${message}`, plan, errors: [message], actualGitCommitRun: false, actualGitPushRun: false };
  }
}
