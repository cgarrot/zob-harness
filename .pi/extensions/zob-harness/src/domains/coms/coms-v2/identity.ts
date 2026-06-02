import { basename } from "node:path";

import type { TeamDefinition, TeamLead, TeamWorker } from "../../../types.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { safeFileStem } from "../../../core/utils/paths.js";
import type { ZobComsV2Policy, ZobLivePeerCard, ZobLiveRoleType } from "./types.js";

const PROCESS_STARTED_AT = new Date().toISOString();
const PROCESS_SESSION_ID = safeFileStem(process.env.ZOB_COMS_SESSION_ID ?? `session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

export function buildZobComsProjectId(repoRoot: string): string {
  return safeFileStem(`${basename(repoRoot)}-${sha256(repoRoot).slice(0, 12)}`);
}

function roleFromTeam(definition: TeamDefinition, requestedRoleId: string): { roleId: string; roleType: ZobLiveRoleType; leadId?: string; agent: string } {
  if (definition.orchestrator.id === requestedRoleId) return { roleId: definition.orchestrator.id, roleType: "orchestrator", agent: definition.orchestrator.agent };
  const lead = definition.leads.find((candidate: TeamLead) => candidate.id === requestedRoleId);
  if (lead) return { roleId: lead.id, roleType: "lead", agent: lead.agent };
  const worker = definition.workers.find((candidate: TeamWorker) => candidate.id === requestedRoleId);
  if (worker) return { roleId: worker.id, roleType: "worker", leadId: worker.leadId, agent: worker.agent };
  return { roleId: definition.orchestrator.id, roleType: "orchestrator", agent: definition.orchestrator.agent };
}

export function buildCurrentZobLivePeerCard(repoRoot: string, definition: TeamDefinition, policy: ZobComsV2Policy): ZobLivePeerCard {
  const requestedRoleId = process.env.ZOB_COMS_ROLE_ID ?? definition.orchestrator.id;
  const role = roleFromTeam(definition, requestedRoleId);
  const sessionId = PROCESS_SESSION_ID;
  const endpoint = policy.mode === "observe_only" ? "observe-only" : `pending-${policy.mode}`;
  return {
    schema: "zob.live-peer-card.v1",
    projectId: buildZobComsProjectId(repoRoot),
    team: definition.name,
    roleId: role.roleId,
    roleType: role.roleType,
    leadId: role.leadId,
    agent: role.agent,
    sessionId,
    sessionHash: sha256(sessionId),
    transport: policy.mode === "required_network" ? "sse" : policy.mode === "required_local" ? "local_socket" : "observe_only",
    endpoint,
    endpointHash: sha256(endpoint),
    cwdHash: sha256(repoRoot),
    pid: typeof process.pid === "number" ? process.pid : undefined,
    startedAt: PROCESS_STARTED_AT,
    heartbeatAt: new Date().toISOString(),
    contextUsedPct: 0,
    queueDepth: 0,
    status: policy.mode === "off" ? "offline" : "online",
    staleAfterMs: policy.heartbeat.staleAfterMs,
    offlineAfterMs: policy.heartbeat.offlineAfterMs,
    bodyStored: false,
  };
}
