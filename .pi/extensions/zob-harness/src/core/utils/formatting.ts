import type { ChildResult } from "../../types.js";

function blockedFeedback(toolName: string, reason: string, attempted: string): string {
  return [
    `ZOB damage-control blocked ${toolName}: ${reason}`,
    "",
    `Attempted: ${attempted}`,
    "",
    "Continue safely:",
    "- If this was non-destructive reconnaissance, skip it or ask the user for the specific value.",
    "- If this was destructive, stop and ask for explicit approval with exact command, risk, and rollback plan.",
    "- Do not retry the same blocked call.",
  ].join("\n");
}

function capOutput(output: string, limit = 50 * 1024): string {
  if (Buffer.byteLength(output, "utf8") <= limit) return output;
  let truncated = output.slice(0, limit);
  while (Buffer.byteLength(truncated, "utf8") > limit) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[truncated: full output stored in tool details]`;
}

function formatChildResultText(result: ChildResult): string {
  const messages: string[] = [];
  if (result.failureKind) messages.push(`Failure kind: ${result.failureKind}`);
  if (result.contractErrors && result.contractErrors.length > 0) messages.push(`Blocked before child launch (preflight/config):\n- ${result.contractErrors.join("\n- ")}`);
  if (result.gateErrors && result.gateErrors.length > 0) messages.push(`Output-contract gate errors (format repair may be enough; inspect and rerun only if content is actually missing):\n- ${result.gateErrors.join("\n- ")}`);
  if (result.errorMessage) messages.push(`Error: ${result.errorMessage}`);
  if (result.stderr.trim()) messages.push(`stderr:\n${result.stderr.trim()}`);
  if (result.output.trim()) messages.push(result.output.trim());
  return messages.length > 0 ? messages.join("\n\n") : "(no output)";
}

export { blockedFeedback, capOutput, formatChildResultText };
