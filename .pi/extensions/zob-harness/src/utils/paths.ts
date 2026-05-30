import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

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

function safeFileStem(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "agent";
}

function newRunId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeRunId(value: string | undefined, prefix: string): string {
  const raw = value ?? newRunId(prefix);
  return safeFileStem(raw);
}

function resolveRepoPath(repoRoot: string, requestedPath: string): { path: string; errors: string[] } {
  const root = resolve(repoRoot);
  const resolvedPath = resolve(root, expandHome(requestedPath));
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}/`)) {
    return { path: resolvedPath, errors: [`Path must stay inside repo root: ${requestedPath}`] };
  }
  return { path: resolvedPath, errors: [] };
}

function isSafeArtifactName(value: string): boolean {
  return value.length > 0 && value === basename(value) && !value.includes("..") && !value.includes("/") && !value.includes("\\\\") && /^[a-zA-Z0-9._-]+$/.test(value);
}

export { expandHome, isSafeArtifactName, newRunId, resolveRepoPath, safeFileStem, safeRunId };
