import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { DEFAULT_RULES } from "./constants.js";
import type { BudgetSidecar, DamageRules, HarnessAgent } from "./types.js";
import { expandHome, pathMatches } from "./utils/paths.js";

function loadDamageRules(cwd: string): DamageRules {
  const candidates = [join(cwd, ".pi", "damage-control-rules.json"), join(getAgentDir(), "damage-control-rules.json")];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const loaded = JSON.parse(readFileSync(candidate, "utf8")) as Partial<DamageRules>;
      return {
        bashToolPatterns: loaded.bashToolPatterns ?? DEFAULT_RULES.bashToolPatterns,
        zeroAccessPaths: loaded.zeroAccessPaths ?? DEFAULT_RULES.zeroAccessPaths,
        readOnlyPaths: loaded.readOnlyPaths ?? DEFAULT_RULES.readOnlyPaths,
        noDeletePaths: loaded.noDeletePaths ?? DEFAULT_RULES.noDeletePaths,
      };
    } catch {
      return DEFAULT_RULES;
    }
  }
  return DEFAULT_RULES;
}

function formatContractTemplate(task = "[atomic goal]"): string {
  return `1. TASK: ${task}
2. EXPECTED OUTCOME: [observable artifact, verdict, or changed file set]
3. REQUIRED TOOLS: [allowed tools / APIs only]
4. MUST DO:
   - Restate constraints before tool use.
   - Verify existing state before changing anything.
   - Produce concrete evidence before claiming done.
5. MUST NOT DO:
   - No secret reads or writes.
   - No broad destructive commands.
   - No commits unless explicitly requested.
6. CONTEXT:
   - Paths:
   - Prior evidence:
   - Downstream use:

FINAL FORMAT:
- Verdict / result
- Evidence (files, commands, outputs)
- Risks / blockers
- Compliance line
- deliverable_delivered: yes/no`;
}

const CONTRACT_PARTS: Array<{ label: string; pattern: RegExp }> = [
  { label: "TASK", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?TASK\s*:/i },
  { label: "EXPECTED OUTCOME", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?EXPECTED\s+OUTCOME\s*:/i },
  { label: "REQUIRED TOOLS", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?(?:REQUIRED\s+TOOLS|TOOLS)\s*:/i },
  { label: "MUST DO", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?MUST\s+DO\s*:/i },
  { label: "MUST NOT DO", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?MUST\s+NOT(?:\s+DO)?\s*:/i },
  { label: "CONTEXT", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?CONTEXT\s*:/i },
];

export function validateSixPartContract(task: string): string[] {
  const errors: string[] = [];
  const matches = CONTRACT_PARTS.map((part) => {
    const match = part.pattern.exec(task);
    return { ...part, index: match?.index ?? -1, end: match ? match.index + match[0].length : -1 };
  });

  for (const match of matches) {
    if (match.index === -1) errors.push(`Missing contract section: ${match.label}`);
  }
  if (errors.length > 0) return errors;

  for (let index = 1; index < matches.length; index += 1) {
    if (matches[index].index < matches[index - 1].index) {
      errors.push(`Contract section out of order: ${matches[index].label}`);
    }
  }

  const ordered = [...matches].sort((left, right) => left.index - right.index);
  for (const [index, match] of ordered.entries()) {
    const next = ordered[index + 1];
    const body = task.slice(match.end, next?.index ?? task.length).trim();
    if (!body || /^\[.*\]$/.test(body)) errors.push(`Empty contract section: ${match.label}`);
  }
  return errors;
}

export function parseToolList(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  return input
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

export function validateToolList(agent: HarnessAgent, requestedTools: string[] | undefined): string[] {
  const errors: string[] = [];
  const allowed = new Set(agent.tools ?? []);
  if (!requestedTools || requestedTools.length === 0) return errors;
  if (allowed.size === 0) return [`Agent '${agent.name}' has no declared tool allowlist; refusing tool override.`];
  for (const tool of requestedTools) {
    if (!/^[a-zA-Z0-9_-]+$/.test(tool)) errors.push(`Invalid tool name '${tool}'`);
    if (!allowed.has(tool)) errors.push(`Tool '${tool}' is not allowed for agent '${agent.name}'. Allowed: ${[...allowed].join(", ")}`);
  }
  return errors;
}

export function resolveChildCwd(repoRoot: string, requestedCwd: string | undefined): { cwd: string; errors: string[] } {
  const root = resolve(repoRoot);
  const cwd = requestedCwd ? resolve(root, expandHome(requestedCwd)) : root;
  if (cwd !== root && !cwd.startsWith(`${root}/`)) {
    return { cwd, errors: [`Child cwd must stay inside repo root. Requested: ${requestedCwd}`] };
  }
  return { cwd, errors: [] };
}

function staysInsideRepo(path: string, repoRoot: string): boolean {
  const root = resolve(repoRoot);
  const resolved = resolve(root, expandHome(path));
  return resolved === root || resolved.startsWith(`${root}/`);
}

function normalizePolicyPattern(path: string): string {
  return path.trim().replace(/\\+/g, "/").replace(/\/+/g, "/");
}

function isBroadDenyPattern(path: string): boolean {
  const normalized = normalizePolicyPattern(path);
  return normalized === "" || normalized === "." || normalized === "./" || normalized === "/" || normalized === "/*" || normalized === "*" || normalized === "**" || normalized === "~" || normalized === "~/";
}

function isRepoRelativePattern(path: string): boolean {
  const normalized = normalizePolicyPattern(path);
  return !normalized.startsWith("/") && !normalized.startsWith("~/") && normalized !== "~";
}

function isWindowsAbsolutePattern(path: string): boolean {
  return /^[a-zA-Z]:\//.test(normalizePolicyPattern(path));
}

function hasTraversalSegment(path: string): boolean {
  return normalizePolicyPattern(path).split("/").some((segment) => segment === "..");
}

function allowedPathGuidance(label: string, path: string, reason: string): string {
  return `${label} path must be repo-relative only (${reason}) and stay inside repo root: ${path}. If the child needs external context, write or cite a repo-local snapshot/context_ref under reports/... and pass that repo-relative ref instead.`;
}

export function validateAllowedPathPolicy(paths: string[] | undefined, label: string, repoRoot: string): string[] {
  const errors: string[] = [];
  for (const path of paths ?? []) {
    const normalized = normalizePolicyPattern(path);
    if (path.includes("\0")) {
      errors.push(allowedPathGuidance(label, path, "NUL bytes are not allowed"));
      continue;
    }
    if (normalized === "" || normalized === "." || normalized === "./") {
      errors.push(allowedPathGuidance(label, path, "broad repo roots are not allowed"));
      continue;
    }
    if (normalized.startsWith("/") || normalized === "~" || normalized.startsWith("~/") || isWindowsAbsolutePattern(normalized)) {
      errors.push(allowedPathGuidance(label, path, "absolute and home paths are not allowed"));
      continue;
    }
    if (hasTraversalSegment(normalized)) {
      errors.push(allowedPathGuidance(label, path, "path traversal segments are not allowed anywhere in allowed_paths"));
      continue;
    }
    if (!staysInsideRepo(path, repoRoot)) errors.push(allowedPathGuidance(label, path, "path must not escape the repo"));
  }
  return errors;
}

export function validateForbiddenPathPolicy(paths: string[] | undefined, label: string, repoRoot: string): string[] {
  const errors: string[] = [];
  for (const path of paths ?? []) {
    if (path.includes("\0")) {
      errors.push(`${label} path contains a NUL byte: ${path}`);
      continue;
    }
    if (isBroadDenyPattern(path)) {
      errors.push(`${label} path is too broad for a deny-only pattern: ${path}`);
      continue;
    }
    if (isRepoRelativePattern(path) && !staysInsideRepo(path, repoRoot)) {
      errors.push(`${label} repo-relative deny pattern must stay inside repo root: ${path}`);
    }
  }
  return errors;
}

export function validatePathPolicy(paths: string[] | undefined, label: string, repoRoot: string): string[] {
  return validateAllowedPathPolicy(paths, label, repoRoot);
}

export function parsePathListEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,:\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validateRuntimeWritePolicy(input: {
  targetPath: string;
  cwd: string;
  policyRoot?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  zeroAccessPaths?: string[];
  readOnlyPaths?: string[];
  sandboxRoot?: string;
}): { allowed: boolean; violations: string[] } {
  const policyRoot = input.policyRoot ?? input.cwd;
  const violations: string[] = [];
  for (const protectedPattern of input.zeroAccessPaths ?? []) {
    if (pathMatches(input.targetPath, protectedPattern, input.cwd, policyRoot)) violations.push(`zero-access path: ${protectedPattern}`);
  }
  for (const forbiddenPattern of input.forbiddenPaths ?? []) {
    if (pathMatches(input.targetPath, forbiddenPattern, input.cwd, policyRoot)) violations.push(`forbidden path: ${forbiddenPattern}`);
  }
  for (const readOnlyPattern of input.readOnlyPaths ?? []) {
    if (pathMatches(input.targetPath, readOnlyPattern, input.cwd, policyRoot)) violations.push(`read-only path: ${readOnlyPattern}`);
  }
  const allowedPaths = input.allowedPaths ?? [];
  if (allowedPaths.length > 0 && !allowedPaths.some((allowedPath) => pathMatches(input.targetPath, allowedPath, input.cwd, policyRoot))) {
    violations.push(`outside allowed_paths: ${allowedPaths.join(", ")}`);
  }
  if (input.sandboxRoot) {
    const sandboxRoot = resolve(policyRoot, expandHome(input.sandboxRoot));
    const target = resolve(input.cwd, expandHome(input.targetPath));
    if (target !== sandboxRoot && !target.startsWith(`${sandboxRoot}/`)) violations.push(`outside sandbox root: ${input.sandboxRoot}`);
  }
  return { allowed: violations.length === 0, violations };
}

export function validateDelegationWriteScope(source: string, requiredTools: string[], allowedPaths: string[] | undefined): string[] {
  const wantsWrite = requiredTools.some((tool) => tool === "write" || tool === "edit");
  if (wantsWrite && (allowedPaths?.length ?? 0) === 0) return [`${source} with write/edit tools requires non-empty allowed_paths`];
  return [];
}

export function validateDelegateTaskWriteScope(requiredTools: string[], allowedPaths: string[] | undefined): string[] {
  return validateDelegationWriteScope("delegate_task", requiredTools, allowedPaths);
}

export function createSandboxMetadata(input: { runId: string; repoRoot: string; sandboxRoot: string; allowedPaths?: string[]; forbiddenPaths?: string[]; budget?: BudgetSidecar }): Record<string, unknown> {
  return {
    schema: "zob.sandbox-metadata.v1",
    runId: input.runId,
    repoRoot: resolve(input.repoRoot),
    sandboxRoot: resolve(input.repoRoot, input.sandboxRoot),
    allowedPaths: input.allowedPaths ?? [],
    forbiddenPaths: input.forbiddenPaths ?? [],
    tempCopy: true,
    autoApply: false,
    budgetEnforced: false,
    budget: input.budget ?? { mode: "advisory", advisory: true, budgetEnforced: false, strictRequested: false, strictEnabled: false },
    promptBodiesStored: false,
    outputBodiesStored: false,
    createdAt: new Date().toISOString(),
  };
}

export function createDiffGateResult(input: { runId: string; diffHash?: string; changedPaths?: string[]; allowed: boolean; violations?: string[] }): Record<string, unknown> {
  return {
    schema: "zob.diff-gate-result.v1",
    runId: input.runId,
    diffHash: input.diffHash,
    changedPaths: input.changedPaths ?? [],
    allowed: input.allowed,
    violations: input.violations ?? [],
    applyRequired: true,
    autoApply: false,
    budgetEnforced: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    evaluatedAt: new Date().toISOString(),
  };
}

export function createRollbackMetadata(input: { runId: string; baseRef?: string; snapshotPath?: string; changedPaths?: string[] }): Record<string, unknown> {
  return {
    schema: "zob.rollback-metadata.v1",
    runId: input.runId,
    baseRef: input.baseRef,
    snapshotPath: input.snapshotPath,
    changedPaths: input.changedPaths ?? [],
    rollbackPrepared: true,
    rollbackApplied: false,
    autoApply: false,
    budgetEnforced: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    createdAt: new Date().toISOString(),
  };
}

export function buildChildEnv(repoRoot: string, pathPolicy?: { allowedPaths?: string[]; forbiddenPaths?: string[]; sandboxRoot?: string }): NodeJS.ProcessEnv {
  const keepExact = new Set([
    "PATH",
    "HOME",
    "PWD",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "NODE_PATH",
    "NVM_DIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "USER",
    "LOGNAME",
    "PI_OFFLINE",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "ZAI_API_KEY",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (keepExact.has(key)) env[key] = value;
  }
  env.ZOB_HARNESS_ROOT = repoRoot;
  if (pathPolicy?.allowedPaths && pathPolicy.allowedPaths.length > 0) env.ZOB_ALLOWED_PATHS = pathPolicy.allowedPaths.join(",");
  if (pathPolicy?.forbiddenPaths && pathPolicy.forbiddenPaths.length > 0) env.ZOB_FORBIDDEN_PATHS = pathPolicy.forbiddenPaths.join(",");
  if (pathPolicy?.sandboxRoot) env.ZOB_SANDBOX_ROOT = pathPolicy.sandboxRoot;
  return env;
}

export { formatContractTemplate, loadDamageRules };
