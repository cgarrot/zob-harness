import { join } from "node:path";

import type { ZobComsTranscriptMode, ZobComsTranscriptRetentionClass, ZobComsTransportMode, ZobComsV2Policy } from "./types.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { readJsonObjectIfPresent } from "../../../core/utils/json.js";
import { isRecord } from "../../../core/utils/records.js";

const TRANSPORT_POLICY_RELATIVE_PATH = ".pi/mission-control/zob_coms_transport.json";
const MODES = new Set<ZobComsTransportMode>(["off", "observe_only", "required_local", "required_network", "break_glass_ledger_only"]);
const TRANSCRIPT_MODES = new Set<ZobComsTranscriptMode>(["off", "redacted_report", "encrypted_vault", "raw_opt_in"]);
const RETENTION_CLASSES = new Set<ZobComsTranscriptRetentionClass>(["ephemeral", "session", "short", "project", "manual_delete"]);

function numberFromRecord(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function modeFromRaw(raw: Record<string, unknown>): ZobComsTransportMode {
  const envMode = process.env.ZOB_COMS_MODE;
  if (envMode && MODES.has(envMode as ZobComsTransportMode)) return envMode as ZobComsTransportMode;
  if (typeof raw.mode === "string" && MODES.has(raw.mode as ZobComsTransportMode)) return raw.mode as ZobComsTransportMode;
  if (raw.networkEnabled === true || raw.globalActivation === true) return "required_network";
  if (raw.enabled === true || raw.localDispatchEnabled === true || raw.dispatchAllowed === true) return "required_local";
  return "observe_only";
}

function transcriptModeFromRaw(raw: Record<string, unknown>, transcriptCapture: Record<string, unknown>): ZobComsTranscriptMode {
  const envMode = process.env.ZOB_COMS_TRANSCRIPT_MODE ?? process.env.ZOB_COMS_CAPTURE_MODE;
  if (envMode && TRANSCRIPT_MODES.has(envMode as ZobComsTranscriptMode)) return envMode as ZobComsTranscriptMode;
  if (process.env.ZOB_COMS_SAVE_TRANSCRIPTS === "1") return "redacted_report";
  if (typeof transcriptCapture.mode === "string" && TRANSCRIPT_MODES.has(transcriptCapture.mode as ZobComsTranscriptMode)) return transcriptCapture.mode as ZobComsTranscriptMode;
  if (typeof raw.transcriptMode === "string" && TRANSCRIPT_MODES.has(raw.transcriptMode as ZobComsTranscriptMode)) return raw.transcriptMode as ZobComsTranscriptMode;
  return "off";
}

function retentionClassFromRaw(transcriptCapture: Record<string, unknown>): ZobComsTranscriptRetentionClass {
  const envRetention = process.env.ZOB_COMS_TRANSCRIPT_RETENTION;
  if (envRetention && RETENTION_CLASSES.has(envRetention as ZobComsTranscriptRetentionClass)) return envRetention as ZobComsTranscriptRetentionClass;
  if (typeof transcriptCapture.retentionClass === "string" && RETENTION_CLASSES.has(transcriptCapture.retentionClass as ZobComsTranscriptRetentionClass)) return transcriptCapture.retentionClass as ZobComsTranscriptRetentionClass;
  return "short";
}

export function readZobComsV2Policy(repoRoot: string): ZobComsV2Policy {
  const raw = readJsonObjectIfPresent(join(repoRoot, TRANSPORT_POLICY_RELATIVE_PATH)) ?? {};
  const heartbeat = isRecord(raw.heartbeat) ? raw.heartbeat : {};
  const responseCapture = isRecord(raw.responseCapture) ? raw.responseCapture : {};
  const network = isRecord(raw.network) ? raw.network : {};
  const legacy = isRecord(raw.legacy) ? raw.legacy : {};
  const transcriptCapture = isRecord(raw.transcriptCapture) ? raw.transcriptCapture : {};
  const envMode = process.env.ZOB_COMS_MODE;
  const envModeOverride = Boolean(envMode && MODES.has(envMode as ZobComsTransportMode));
  const mode = modeFromRaw(raw);
  const transcriptMode = transcriptModeFromRaw(raw, transcriptCapture);
  const transcriptEnvEnabled = typeof process.env.ZOB_COMS_TRANSCRIPT_MODE === "string" || typeof process.env.ZOB_COMS_CAPTURE_MODE === "string" || process.env.ZOB_COMS_SAVE_TRANSCRIPTS === "1";
  const localDispatchEnabled = envModeOverride ? mode === "required_local" : bool(raw.localDispatchEnabled) || mode === "required_local";
  const networkEnabled = envModeOverride ? mode === "required_network" : bool(raw.networkEnabled) || mode === "required_network";
  const dispatchAllowed = envModeOverride ? mode === "required_local" || mode === "required_network" : bool(raw.dispatchAllowed) || mode === "required_local" || mode === "required_network";
  return {
    schema: raw.schema === "zob.coms-transport-policy.v2" ? "zob.coms-transport-policy.v2" : "zob.coms-transport-policy.v1",
    name: "zob_coms_transport",
    enabled: envModeOverride ? dispatchAllowed : bool(raw.enabled) || dispatchAllowed,
    mode,
    localDispatchEnabled,
    networkEnabled,
    dispatchAllowed,
    globalActivation: bool(raw.globalActivation),
    canonicalLedger: ".pi/coms/messages.jsonl",
    statusLedger: ".pi/coms/status.jsonl",
    bodyPolicy: "hash_only",
    persistBodies: false,
    transientBodyTransport: mode === "required_local" || mode === "required_network",
    topologyGuardRequired: true,
    workerToWorkerFreeChat: false,
    agenticWorkflowsRequireLive: true,
    breakGlassApprovalRequired: true,
    heartbeat: {
      enabled: mode !== "off",
      intervalMs: numberFromRecord(heartbeat, "intervalMs", 10_000),
      staleAfterMs: numberFromRecord(heartbeat, "staleAfterMs", 30_000),
      offlineAfterMs: numberFromRecord(heartbeat, "offlineAfterMs", 60_000),
      stalePeerCountsAsCompletion: false,
    },
    responseCapture: {
      enabled: bool(responseCapture.enabled, mode === "required_local" || mode === "required_network"),
      storeBodies: false,
      storeOutputHashOnly: true,
      artifactRefsAllowed: true,
    },
    network: {
      enabled: networkEnabled,
      requiresBearerToken: true,
      loopbackDefaultOnly: true,
      tlsRequiredOutsideTrustedLan: bool(network.tlsRequiredOutsideTrustedLan, true),
      logToken: false,
    },
    legacy: {
      appendOnlySendEnabled: bool(legacy.appendOnlySendEnabled, false),
      breakGlassLedgerOnlyRequiresApproval: true,
    },
    transcriptCapture: {
      enabled: transcriptMode !== "off" && (transcriptEnvEnabled || bool(transcriptCapture.enabled, false)),
      mode: transcriptMode,
      artifactRoot: typeof process.env.ZOB_COMS_TRANSCRIPT_ARTIFACT_ROOT === "string" ? process.env.ZOB_COMS_TRANSCRIPT_ARTIFACT_ROOT : typeof transcriptCapture.artifactRoot === "string" ? transcriptCapture.artifactRoot : "reports/coms-captures",
      artifactRefsOnlyInLedger: true,
      persistBodiesInComsLedger: false,
      redactionRequired: true,
      encryptionRequiredForVault: true,
      rawOptInRequired: true,
      retentionClass: retentionClassFromRaw(transcriptCapture),
      maxArtifactBytes: numberFromRecord(transcriptCapture, "maxArtifactBytes", 32_768),
      redactionProfile: typeof transcriptCapture.redactionProfile === "string" ? transcriptCapture.redactionProfile : "zob-default-v1",
    },
    sourcePolicyHash: sha256(JSON.stringify(raw)),
  };
}

export function zobComsRegistryEnabled(policy: ZobComsV2Policy): boolean {
  return policy.mode !== "off";
}

export { TRANSPORT_POLICY_RELATIVE_PATH };
