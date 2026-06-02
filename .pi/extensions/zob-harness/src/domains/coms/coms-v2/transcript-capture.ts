import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ZobComsTranscriptCapturePolicy } from "./types.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { safeFileStem } from "../../../core/utils/paths.js";

export type ZobComsRedactedCaptureKind = "live_prompt" | "live_response" | "live_exchange";

export interface ZobComsRedactedCaptureInput {
  runId?: string;
  msgId: string;
  sender?: string;
  receiver?: string;
  team?: string;
  kind: ZobComsRedactedCaptureKind;
  taskHash?: string;
  outputHash?: string;
  transientPrompt?: string;
  transientResponse?: string;
  artifactRefs?: string[];
}

export interface ZobComsRedactedCaptureRef {
  schema: "zob.coms-redacted-capture-ref.v1";
  mode: "redacted_report";
  artifactRef: string;
  artifactHash: string;
  redactionProfileHash: string;
  retentionClass: ZobComsTranscriptCapturePolicy["retentionClass"];
  expiresAt?: string;
  bodyStored: false;
}

const DEFAULT_ARTIFACT_ROOT = "reports/coms-captures";
const DEFAULT_REDACTION_PROFILE = "zob-default-v1";
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "private_key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: "api_key", pattern: /\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{10,}\b/g },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "secret_assignment", pattern: /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*[^\s]+/gi },
  { name: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
];

function normalizeArtifactRoot(root: string | undefined): string {
  const candidate = (root ?? DEFAULT_ARTIFACT_ROOT).trim().replace(/^\.\//, "").replace(/\/+$/g, "");
  if (!candidate || candidate.startsWith("/") || candidate.includes("..") || candidate.includes("\\") || candidate.includes(".env") || candidate.includes("/node_modules") || candidate.includes("/dist") || candidate.includes("/build")) return DEFAULT_ARTIFACT_ROOT;
  if (candidate !== DEFAULT_ARTIFACT_ROOT && !candidate.startsWith(`${DEFAULT_ARTIFACT_ROOT}/`)) return DEFAULT_ARTIFACT_ROOT;
  return candidate;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const limit = Math.max(256, Math.min(256 * 1024, Math.floor(maxBytes)));
  let bytes = 0;
  let output = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > limit) return { value: `${output}\n[...truncated...]`, truncated: true };
    output += char;
    bytes += charBytes;
  }
  return { value: output, truncated: false };
}

function retentionExpiresAt(retentionClass: ZobComsTranscriptCapturePolicy["retentionClass"]): string | undefined {
  const now = Date.now();
  if (retentionClass === "ephemeral") return new Date(now + 24 * 60 * 60 * 1000).toISOString();
  if (retentionClass === "short") return new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (retentionClass === "session") return new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  return undefined;
}

export function redactZobComsText(input: string, maxBytes = 32_768): { redacted: string; originalBytes: number; savedBytes: number; truncated: boolean; redactionCounts: Record<string, number> } {
  let redacted = input;
  const redactionCounts: Record<string, number> = {};
  for (const item of SECRET_PATTERNS) {
    let count = 0;
    redacted = redacted.replace(item.pattern, () => {
      count += 1;
      return `[REDACTED:${item.name}]`;
    });
    if (count > 0) redactionCounts[item.name] = count;
  }
  const truncated = truncateUtf8(redacted, maxBytes);
  return {
    redacted: truncated.value,
    originalBytes: Buffer.byteLength(input, "utf8"),
    savedBytes: Buffer.byteLength(truncated.value, "utf8"),
    truncated: truncated.truncated,
    redactionCounts,
  };
}

export function writeZobComsRedactedCapture(repoRoot: string, policy: ZobComsTranscriptCapturePolicy, input: ZobComsRedactedCaptureInput): ZobComsRedactedCaptureRef | undefined {
  if (!policy.enabled || policy.mode !== "redacted_report") return undefined;
  const root = normalizeArtifactRoot(policy.artifactRoot);
  const runStem = safeFileStem(input.runId ?? "unknown-run");
  const msgStem = safeFileStem(input.msgId);
  const kindStem = safeFileStem(input.kind);
  const artifactRef = `${root}/${runStem}/${msgStem}.${kindStem}.redacted.json`;
  const artifactDir = join(repoRoot, root, runStem);
  const artifactPath = join(artifactDir, `${msgStem}.${kindStem}.redacted.json`);
  const maxPerField = Math.max(256, Math.floor(policy.maxArtifactBytes / 2));
  const request = typeof input.transientPrompt === "string" ? redactZobComsText(input.transientPrompt, maxPerField) : undefined;
  const answer = typeof input.transientResponse === "string" ? redactZobComsText(input.transientResponse, maxPerField) : undefined;
  const expiresAt = retentionExpiresAt(policy.retentionClass);
  const artifact = {
    schema: "zob.coms-redacted-capture.v1",
    runId: input.runId ?? "unknown-run",
    msgId: input.msgId,
    kind: input.kind,
    sender: input.sender,
    receiver: input.receiver,
    team: input.team,
    taskHash: input.taskHash,
    outputHash: input.outputHash,
    mode: "redacted_report",
    redactionProfile: policy.redactionProfile,
    redactionProfileHash: sha256(policy.redactionProfile),
    retentionClass: policy.retentionClass,
    expiresAt,
    sourceBytes: {
      request: request?.originalBytes ?? 0,
      answer: answer?.originalBytes ?? 0,
    },
    savedBytes: {
      request: request?.savedBytes ?? 0,
      answer: answer?.savedBytes ?? 0,
    },
    truncated: {
      request: request?.truncated ?? false,
      answer: answer?.truncated ?? false,
    },
    redactionCounts: {
      request: request?.redactionCounts ?? {},
      answer: answer?.redactionCounts ?? {},
    },
    redacted: {
      request: request?.redacted,
      answer: answer?.redacted,
    },
    priorArtifactRefs: input.artifactRefs ?? [],
    rawBodiesStored: false,
    redactedBodiesStored: true,
    comsLedgerBodyStored: false,
    bodyStored: false,
    createdAt: new Date().toISOString(),
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const artifactHash = sha256(serialized);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(artifactPath, serialized, "utf8");
  return {
    schema: "zob.coms-redacted-capture-ref.v1",
    mode: "redacted_report",
    artifactRef,
    artifactHash,
    redactionProfileHash: sha256(policy.redactionProfile || DEFAULT_REDACTION_PROFILE),
    retentionClass: policy.retentionClass,
    expiresAt,
    bodyStored: false,
  };
}
