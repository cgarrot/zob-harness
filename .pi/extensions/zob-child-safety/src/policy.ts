import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DamageRule {
  pattern: string;
  reason: string;
  ask?: boolean;
}

export interface DamageRules {
  bashToolPatterns: DamageRule[];
  zeroAccessPaths: string[];
  readOnlyPaths: string[];
  noDeletePaths: string[];
}

export const DEFAULT_RULES: DamageRules = {
  bashToolPatterns: [
    { pattern: "\\brm\\s+(-rf?|--recursive)", reason: "recursive deletion" },
    { pattern: "\\bgit\\s+reset\\s+--hard\\b", reason: "destructive git reset" },
    { pattern: "\\bgit\\s+clean\\s+-", reason: "destructive git clean" },
    { pattern: "\\bgit\\s+add\\s+(-A|\\.)", reason: "bulk git staging" },
    { pattern: "\\bsudo\\b", reason: "privileged command" },
  ],
  zeroAccessPaths: [".env", ".env.*", "~/.ssh", "~/.aws", "*.pem", "*.key"],
  readOnlyPaths: [".git/", "node_modules/", "dist/", "build/", "package-lock.json", "pnpm-lock.yaml", "bun.lock"],
  noDeletePaths: [".git/", "AGENTS.md", "README.md", ".pi/"],
};

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`(^|/)${escaped}($|/)`);
}

export function pathMatches(targetPath: string, pattern: string, cwd: string, policyRoot = cwd): boolean {
  const expanded = expandHome(pattern);
  const root = resolve(policyRoot);
  const normalizedTarget = resolve(cwd, expandHome(targetPath));
  const relativeTarget = normalizedTarget.startsWith(root) ? normalizedTarget.slice(root.length + 1) : normalizedTarget;
  if (expanded.endsWith("/")) {
    const prefix = resolve(root, expanded.slice(0, -1));
    return normalizedTarget === prefix || normalizedTarget.startsWith(`${prefix}/`) || relativeTarget.startsWith(expanded);
  }
  const regex = wildcardToRegex(expanded);
  return regex.test(normalizedTarget) || regex.test(relativeTarget) || relativeTarget.includes(expanded);
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

export function blockedFeedback(toolName: string, reason: string, attempted: string): string {
  return [
    `ZOB child safety blocked ${toolName}: ${reason}`,
    "",
    `Attempted: ${attempted}`,
    "",
    "Continue safely:",
    "- Do not retry the same blocked call.",
    "- If a secret or destructive operation is required, stop and ask the parent/user for explicit approval.",
    "- Produce a safe partial result with evidence and blockers instead.",
  ].join("\n");
}
