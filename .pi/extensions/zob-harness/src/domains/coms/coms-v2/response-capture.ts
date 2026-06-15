import { sha256 } from "../../../core/utils/hashing.js";
import { buildZobLiveEnvelope, type ZobLiveEnvelope } from "./envelope.js";

export interface ZobLiveResponseCapture {
  schema: "zob.live-response-capture.v1";
  msgId: string;
  outputHash: string;
  artifactRefs: string[];
  artifactHashes: string[];
  responseBytes: number;
  bodyStored: false;
}

function safeArtifactRefs(refs: string[] | undefined): string[] {
  return (refs ?? []).filter((ref) => ref.length > 0 && !ref.startsWith("/") && !ref.includes("..") && !ref.includes("\\") && !ref.includes(".env"));
}

function safeArtifactHashes(hashes: string[] | undefined): string[] {
  return (hashes ?? []).filter((hash) => /^[a-f0-9]{64}$/i.test(hash));
}

export function buildZobLiveResponseCapture(msgId: string, transientResponse: string, artifactRefs?: string[], artifactHashes?: string[]): ZobLiveResponseCapture {
  return {
    schema: "zob.live-response-capture.v1",
    msgId,
    outputHash: sha256(transientResponse),
    artifactRefs: safeArtifactRefs(artifactRefs),
    artifactHashes: safeArtifactHashes(artifactHashes),
    responseBytes: Buffer.byteLength(transientResponse, "utf8"),
    bodyStored: false,
  };
}

export function buildZobLiveResponseEnvelope(request: ZobLiveEnvelope, transientResponse: string, artifactRefs?: string[], artifactHashes?: string[]): ZobLiveEnvelope {
  const capture = buildZobLiveResponseCapture(request.msgId, transientResponse, artifactRefs, artifactHashes);
  return buildZobLiveEnvelope({
    type: "response",
    msgId: request.msgId,
    runId: request.runId,
    sender: request.receiver,
    receiver: request.sender,
    team: request.team,
    hops: request.hops,
    taskHash: request.taskHash,
    outputHash: capture.outputHash,
    artifactRefs: capture.artifactRefs,
    artifactHashes: capture.artifactHashes,
    replyToMsgId: request.msgId,
    responseHash: capture.outputHash,
    transientResponse,
  });
}
