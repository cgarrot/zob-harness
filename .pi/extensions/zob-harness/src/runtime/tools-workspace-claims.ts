import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createWorkspaceClaim, listWorkspaceClaims, releaseWorkspaceClaim, workspaceClaimBodyFreeViolations } from "../domains/governance/workspace-claims.js";
import { WorkspaceClaimParams, WorkspaceClaimsListParams, WorkspaceReleaseParams } from "./schemas.js";
import { loadTeamDefinition, validateTeamDefinition } from "../domains/topology/teams.js";

export function registerWorkspaceClaimTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_workspace_claim",
    label: "ZOB Workspace Claim",
    description: "Create a metadata-only workspace path lease for parallel write intent. Detects conflicts and never writes source files or applies changes.",
    promptSnippet: "Claim workspace paths for governed parallel write intent.",
    parameters: WorkspaceClaimParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (!team.definition || errors.length > 0) return { content: [{ type: "text", text: `zob_workspace_claim failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      try {
        const claim = createWorkspaceClaim(ctx.cwd, team.definition, params);
        const bodyFreeViolations = workspaceClaimBodyFreeViolations(claim);
        pi.appendEntry("zob-workspace-claim", { event: claim.status, claimId: claim.claimId, conflicts: claim.conflicts.length, productionWritesPerformed: false, autoApply: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
        return { content: [{ type: "text", text: `zob_workspace_claim: ${claim.status} ${claim.claimId}` }], details: { schema: "zob.workspace-claim-result.v1", claim, bodyFreeViolations } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_workspace_claim blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_workspace_release",
    label: "ZOB Workspace Release",
    description: "Release a metadata-only workspace path lease. Does not apply changes or mutate source files.",
    promptSnippet: "Release a governed workspace claim.",
    parameters: WorkspaceReleaseParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (!team.definition || errors.length > 0) return { content: [{ type: "text", text: `zob_workspace_release failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      try {
        const release = releaseWorkspaceClaim(ctx.cwd, team.definition, params);
        pi.appendEntry("zob-workspace-claim", { event: "released", claimId: release.claimId, releaseId: release.releaseId, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
        return { content: [{ type: "text", text: `zob_workspace_release: ${release.claimId}` }], details: { schema: "zob.workspace-release-result.v1", release } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_workspace_release blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_workspace_claims_list",
    label: "ZOB Workspace Claims List",
    description: "List active metadata-only workspace claims/leases. Bodies are never stored or returned.",
    promptSnippet: "List governed workspace claims.",
    parameters: WorkspaceClaimsListParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const claims = listWorkspaceClaims(ctx.cwd, params);
      return { content: [{ type: "text", text: `zob_workspace_claims_list: ${claims.length} claim(s)` }], details: { schema: "zob.workspace-claims-list.v1", claims, bodyFreeViolations: workspaceClaimBodyFreeViolations(claims) } };
    },
  });
}
