import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  MissionControlProposeCommandParams,
  MissionControlSnapshotParams,
  ZobComsReadinessParams,
} from "./schemas.js";
import type { TeamDefinition } from "../types.js";
import {
  buildMissionControlSnapshot,
  buildZobCommunicationReadinessAudit,
  writeMissionControlCommandProposal,
} from "../domains/coms/mission-control.js";
import { loadTeamDefinition, validateTeamDefinition } from "../domains/topology/teams.js";

function loadValidTeam(repoRoot: string, teamName: string | undefined): { definition?: TeamDefinition; errors: string[] } {
  const team = loadTeamDefinition(repoRoot, teamName ?? "zob-core");
  const errors = [...team.errors, ...validateTeamDefinition(repoRoot, team.definition)];
  return { definition: team.definition, errors };
}

export function registerMissionControlTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_coms_readiness",
    label: "ZOB Coms Readiness",
    description: "Audit local ZOB communication readiness: topology guard, hash-only ledgers, bounded awaits, disabled transport, proposal-only commands. No network coms.",
    parameters: ZobComsReadinessParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadValidTeam(ctx.cwd, params.team);
      if (team.errors.length > 0 || !team.definition) return { content: [{ type: "text", text: `zob_coms_readiness failed_preflight:\n- ${team.errors.join("\n- ")}` }], details: { status: "failed_preflight", errors: team.errors } };
      const audit = buildZobCommunicationReadinessAudit(ctx.cwd, team.definition);
      return { content: [{ type: "text", text: `zob_coms_readiness: ${audit.verdict}` }], details: audit };
    },
  });

  pi.registerTool({
    name: "zob_mission_control_snapshot",
    label: "ZOB Mission Control Snapshot",
    description: "Read a metadata-only Mission Control dashboard snapshot over queue, runs, factories, telemetry, coms, autonomy audit, and disabled transport status.",
    parameters: MissionControlSnapshotParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadValidTeam(ctx.cwd, params.team);
      if (team.errors.length > 0 || !team.definition) return { content: [{ type: "text", text: `zob_mission_control_snapshot failed_preflight:\n- ${team.errors.join("\n- ")}` }], details: { status: "failed_preflight", errors: team.errors } };
      const snapshot = buildMissionControlSnapshot(ctx.cwd, team.definition, { runId: params.runId, limit: params.limit });
      return { content: [{ type: "text", text: "zob_mission_control_snapshot: metadata-only" }], details: snapshot };
    },
  });

  pi.registerTool({
    name: "zob_mission_control_propose_command",
    label: "ZOB Mission Control Propose Command",
    description: "Create a typed parent-owned Mission Control command proposal. Proposal-only; no direct worker writes, no transport dispatch, no raw rationale/body storage.",
    parameters: MissionControlProposeCommandParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadValidTeam(ctx.cwd, params.team);
      if (team.errors.length > 0 || !team.definition) return { content: [{ type: "text", text: `zob_mission_control_propose_command failed_preflight:\n- ${team.errors.join("\n- ")}` }], details: { status: "failed_preflight", errors: team.errors } };
      try {
        const proposal = writeMissionControlCommandProposal(ctx.cwd, team.definition, {
          proposalId: params.proposalId,
          runId: params.runId,
          command: params.command,
          requestedBy: params.requestedBy,
          targetRole: params.targetRole,
          priority: params.priority,
          rationaleHash: params.rationaleHash,
          artifactRefs: params.artifactRefs,
          todoId: params.todoId,
          subtreeRootTodoId: params.subtreeRootTodoId,
        });
        return { content: [{ type: "text", text: `zob_mission_control_propose_command proposed: ${proposal.proposalId}` }], details: proposal };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_mission_control_propose_command blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });
}
