export type ZobComsTransportMode = "off" | "observe_only" | "required_local" | "required_network" | "break_glass_ledger_only";
export type ZobComsTranscriptMode = "off" | "redacted_report" | "encrypted_vault" | "raw_opt_in";
export type ZobComsTranscriptRetentionClass = "ephemeral" | "session" | "short" | "project" | "manual_delete";
export type ZobLiveTransportKind = "observe_only" | "local_socket" | "named_pipe" | "sse";
export type ZobLivePeerStatus = "online" | "stale" | "offline";
export type ZobLiveRoleType = "orchestrator" | "lead" | "worker";
export type ZpeerRoomMembershipRole = "member" | "bridge" | "observer";

export interface ZpeerRoomMembership {
  roomId: string;
  alias: string;
  role: ZpeerRoomMembershipRole;
  joinedAt: string;
  localOnly: true;
  networkEnabled: false;
  bodyStored: false;
}

export interface ZobComsHeartbeatPolicy {
  enabled: boolean;
  intervalMs: number;
  staleAfterMs: number;
  offlineAfterMs: number;
  stalePeerCountsAsCompletion: false;
}

export interface ZobComsResponseCapturePolicy {
  enabled: boolean;
  storeBodies: false;
  storeOutputHashOnly: true;
  artifactRefsAllowed: boolean;
}

export interface ZobComsNetworkPolicy {
  enabled: boolean;
  requiresBearerToken: true;
  loopbackDefaultOnly: true;
  tlsRequiredOutsideTrustedLan: boolean;
  logToken: false;
}

export interface ZobComsLegacyPolicy {
  appendOnlySendEnabled: boolean;
  breakGlassLedgerOnlyRequiresApproval: true;
}

export interface ZobComsTranscriptCapturePolicy {
  enabled: boolean;
  mode: ZobComsTranscriptMode;
  artifactRoot: string;
  artifactRefsOnlyInLedger: true;
  persistBodiesInComsLedger: false;
  redactionRequired: true;
  encryptionRequiredForVault: true;
  rawOptInRequired: true;
  retentionClass: ZobComsTranscriptRetentionClass;
  maxArtifactBytes: number;
  redactionProfile: string;
}

export interface ZobComsV2Policy {
  schema: "zob.coms-transport-policy.v1" | "zob.coms-transport-policy.v2";
  name: "zob_coms_transport";
  enabled: boolean;
  mode: ZobComsTransportMode;
  localDispatchEnabled: boolean;
  networkEnabled: boolean;
  dispatchAllowed: boolean;
  globalActivation: boolean;
  canonicalLedger: ".pi/coms/messages.jsonl";
  statusLedger: ".pi/coms/status.jsonl";
  bodyPolicy: "hash_only";
  persistBodies: false;
  transientBodyTransport: boolean;
  topologyGuardRequired: true;
  workerToWorkerFreeChat: false;
  agenticWorkflowsRequireLive: true;
  breakGlassApprovalRequired: true;
  heartbeat: ZobComsHeartbeatPolicy;
  responseCapture: ZobComsResponseCapturePolicy;
  network: ZobComsNetworkPolicy;
  legacy: ZobComsLegacyPolicy;
  transcriptCapture: ZobComsTranscriptCapturePolicy;
  sourcePolicyHash?: string;
}

export interface ZobLivePeerCard {
  schema: "zob.live-peer-card.v1";
  projectId: string;
  team: string;
  roleId: string;
  roleType: ZobLiveRoleType;
  leadId?: string;
  agent: string;
  sessionId: string;
  sessionHash: string;
  transport: ZobLiveTransportKind;
  endpoint: string;
  endpointHash: string;
  cwdHash: string;
  pid?: number;
  startedAt: string;
  heartbeatAt: string;
  contextUsedPct: number;
  queueDepth: number;
  status: ZobLivePeerStatus;
  zpeerRoomId?: string;
  zpeerAlias?: string;
  zpeerActiveRoomId?: string;
  zpeerMemberships?: ZpeerRoomMembership[];
  zpeerLocalOnly?: true;
  staleAfterMs: number;
  offlineAfterMs: number;
  bodyStored: false;
}

export interface ZobLiveTeamAgentLease {
  schema: "zob.live-team-agent-lease.v1";
  projectId: string;
  teamId: string;
  agentId: string;
  roleId: string;
  roleType: ZobLiveRoleType;
  leadId?: string;
  agent: string;
  sessionId: string;
  sessionHash: string;
  leaseOwnerId: string;
  leaseOwnerHash: string;
  transport: ZobLiveTransportKind;
  endpoint: string;
  endpointHash: string;
  cwdHash: string;
  pid?: number;
  startedAt: string;
  heartbeatAt: string;
  leasedAt: string;
  renewedAt: string;
  expiresAt: string;
  contextUsedPct: number;
  queueDepth: number;
  status: ZobLivePeerStatus;
  zpeerRoomId?: string;
  zpeerAlias?: string;
  zpeerActiveRoomId?: string;
  zpeerMemberships?: ZpeerRoomMembership[];
  zpeerLocalOnly?: true;
  staleAfterMs: number;
  offlineAfterMs: number;
  stableLease: true;
  exclusiveBy: "teamId+agentId";
  localOnly: true;
  networkEnabled: false;
  bodyStored: false;
}

export interface ZobLiveRegistrySnapshot {
  schema: "zob.live-registry-snapshot.v1";
  projectId: string;
  registry: "user_runtime" | "env_override";
  team?: string;
  generatedAt: string;
  peers: ZobLivePeerCard[];
  counts: Record<ZobLivePeerStatus, number>;
  bodyStored: false;
}

export interface ZobComsCaptureRef {
  artifactRef: string;
  artifactHash: string;
  mode: ZobComsTranscriptMode;
  bodyStored: false;
}

export interface ZobLivePresenceSummary {
  schema: "zob.live-presence-summary.v1";
  available: boolean;
  mode: ZobComsTransportMode;
  registry: "user_runtime" | "env_override";
  team?: string;
  peerCount: number;
  online: number;
  stale: number;
  offline: number;
  stalePeerCountsAsCompletion: false;
  dispatchEnabled: boolean;
  networkEnabled: boolean;
  bodyStored: false;
}
