import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RULES, blockedFeedback, parsePathListEnv, pathMatches, validateRuntimeWritePolicy } from "./src/policy.js";
import type { DamageRules } from "./src/policy.js";

export { pathMatches, parsePathListEnv, validateRuntimeWritePolicy } from "./src/policy.js";

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
