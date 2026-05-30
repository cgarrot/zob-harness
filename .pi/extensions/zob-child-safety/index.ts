import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

interface DamageRule {
  pattern: string;
  reason: string;
  ask?: boolean;
}

interface DamageRules {
  bashToolPatterns: DamageRule[];
  zeroAccessPaths: string[];
  readOnlyPaths: string[];
  noDeletePaths: string[];
}

const DEFAULT_RULES: DamageRules = {
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

function loadDamageRules(cwd: string): DamageRules {
  const root = process.env.ZOB_HARNESS_ROOT || cwd;
  const candidate = join(root, ".pi", "damage-control-rules.json");
  if (!existsSync(candidate)) return DEFAULT_RULES;
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

function blockedFeedback(toolName: string, reason: string, attempted: string): string {
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

export default function zobChildSafety(pi: ExtensionAPI): void {
  let rules: DamageRules = DEFAULT_RULES;

  pi.on("session_start", async (_event, ctx) => {
    rules = loadDamageRules(ctx.cwd);
    ctx.ui.setStatus("zob-child-safety", ctx.ui.theme.fg("accent", "child-safe"));
  });

  pi.on("tool_call", async (event, ctx) => {
    let violation: string | undefined;
    let attempted = JSON.stringify(event.input);
    const pathInputs: string[] = [];
    const policyRoot = process.env.ZOB_HARNESS_ROOT || ctx.cwd;

    if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      pathInputs.push(event.input.path);
    }
    if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
      pathInputs.push(event.input.path ?? ".");
    }

    const inheritedAllowedPaths = parsePathListEnv(process.env.ZOB_ALLOWED_PATHS);
    const inheritedForbiddenPaths = parsePathListEnv(process.env.ZOB_FORBIDDEN_PATHS);
    const sandboxRoot = process.env.ZOB_SANDBOX_ROOT;

    for (const inputPath of pathInputs) {
      for (const protectedPattern of rules.zeroAccessPaths) {
        if (pathMatches(inputPath, protectedPattern, ctx.cwd, policyRoot)) violation = `zero-access path: ${protectedPattern}`;
      }
      if (!violation) {
        for (const forbiddenPattern of inheritedForbiddenPaths) {
          if (pathMatches(inputPath, forbiddenPattern, ctx.cwd, policyRoot)) violation = `forbidden path: ${forbiddenPattern}`;
        }
      }
      if ((event.toolName === "write" || event.toolName === "edit") && !violation) {
        const writePolicy = validateRuntimeWritePolicy({
          targetPath: inputPath,
          cwd: ctx.cwd,
          policyRoot,
          allowedPaths: inheritedAllowedPaths,
          forbiddenPaths: inheritedForbiddenPaths,
          zeroAccessPaths: rules.zeroAccessPaths,
          readOnlyPaths: rules.readOnlyPaths,
          sandboxRoot,
        });
        if (!writePolicy.allowed) violation = writePolicy.violations[0];
      }
    }

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;
      attempted = command;
      for (const rule of rules.bashToolPatterns) {
        if (new RegExp(rule.pattern, "i").test(command)) {
          violation = rule.reason;
          break;
        }
      }
      if (!violation) {
        for (const protectedPattern of rules.zeroAccessPaths) {
          if (command.includes(protectedPattern)) violation = `bash references zero-access path: ${protectedPattern}`;
        }
      }
      if (!violation) {
        for (const forbiddenPattern of inheritedForbiddenPaths) {
          if (command.includes(forbiddenPattern)) violation = `bash references forbidden path: ${forbiddenPattern}`;
        }
      }
      if (!violation) {
        for (const noDelete of rules.noDeletePaths) {
          if (command.includes(noDelete) && /\b(rm|mv)\b/.test(command)) violation = `delete/move protected path: ${noDelete}`;
        }
      }
    }

    if (violation) {
      pi.appendEntry("zob-child-safety", { tool: event.toolName, input: event.input, violation, timestamp: Date.now() });
      return { block: true, reason: blockedFeedback(event.toolName, violation, attempted) };
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("zob-child-safety", undefined);
  });
}
