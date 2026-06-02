import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildProjectDnaAgenticPlan, buildProjectDnaFederatedQueryResult, buildProjectDnaQueryResult, buildProjectDnaReadinessAudit, writeProjectDnaWritebackProposal } from "../domains/project-dna/project-dna.js";
import { ProjectDnaFederatedQueryParams, ProjectDnaPlanWorkflowParams, ProjectDnaQueryParams, ProjectDnaReadinessParams, ProjectDnaWritebackProposalParams } from "./schemas.js";

export function registerProjectDnaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_project_dna_readiness",
    label: "ZOB ProjectDNA Readiness",
    description: "Audit ProjectDNA plan/runtime readiness from repo-local artifacts. Read-only, metadata-only, no source scan or backend write.",
    parameters: ProjectDnaReadinessParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const audit = buildProjectDnaReadinessAudit(ctx.cwd, { scanDir: params.scan_dir });
        const verdict = typeof audit.verdict === "string" ? audit.verdict : "unknown";
        const noShip = audit.no_ship === true ? " no_ship=true" : "";
        return { content: [{ type: "text", text: `zob_project_dna_readiness: ${verdict}${noShip}` }], details: audit };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_project_dna_readiness blocked: ${message}` }], details: { schema: "zob.project-dna-readiness.v1", verdict: "blocked", errors: [message], no_ship: true, source_project_modified: false, knowledge_backend_write_enabled: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_project_dna_plan_workflow",
    label: "ZOB ProjectDNA Plan Workflow",
    description: "Build a metadata-only agentic ProjectDNA workflow plan from a repo-local manifest v2. No source scan, child dispatch, network, source write, or backend write.",
    parameters: ProjectDnaPlanWorkflowParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const plan = buildProjectDnaAgenticPlan(ctx.cwd, {
          manifestPath: params.manifest_path,
          scanDir: params.scan_dir,
        });
        const profile = typeof plan.effective_compute_profile === "string" ? plan.effective_compute_profile : "unknown";
        const capture = typeof plan.effective_capture_mode === "string" ? plan.effective_capture_mode : "unknown";
        const lanes = Array.isArray(plan.lanes) ? plan.lanes.length : 0;
        return { content: [{ type: "text", text: `zob_project_dna_plan_workflow: profile=${profile} capture=${capture} lanes=${lanes}` }], details: plan };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_project_dna_plan_workflow blocked: ${message}` }], details: { schema: "zob.project-dna-agentic-plan.v1", status: "blocked", errors: [message], metadata_only: true, no_execution: true, source_project_modified: false, knowledge_backend_write_enabled: false, child_direct_dispatch: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_project_dna_query",
    label: "ZOB ProjectDNA Query",
    description: "Return a bounded cited ProjectDNA context pack from repo-local scan artifacts. Read-only; no source scan, no backend write, no child dispatch.",
    parameters: ProjectDnaQueryParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = buildProjectDnaQueryResult(ctx.cwd, {
          scanDir: params.scan_dir,
          query: params.query,
          maxFiles: params.max_files,
          maxContextTokens: params.max_context_tokens,
          allowedSources: params.allowed_sources,
          contextScopeId: params.context_scope_id,
        });
        const sourceId = typeof result.source_id === "string" ? result.source_id : "unknown-source";
        const files = Array.isArray(result.files_to_read_first) ? result.files_to_read_first.length : 0;
        const citations = Array.isArray(result.citations) ? result.citations.length : 0;
        return { content: [{ type: "text", text: `zob_project_dna_query: source=${sourceId} files=${files} citations=${citations}` }], details: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_project_dna_query blocked: ${message}` }], details: { schema: "zob.project-dna-query-result.v1", status: "blocked", errors: [message], raw_query_persisted: false, source_project_modified: false, knowledge_backend_write_enabled: false, child_dispatch_allowed: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_project_dna_federated_query",
    label: "ZOB ProjectDNA Federated Query",
    description: "Merge bounded cited ProjectDNA context from multiple repo-local scan artifact directories. Metadata-only and proposal-only.",
    parameters: ProjectDnaFederatedQueryParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = buildProjectDnaFederatedQueryResult(ctx.cwd, {
          scanDirs: params.scan_dirs,
          query: params.query,
          maxFilesPerSource: params.max_files_per_source,
          maxTotalFiles: params.max_total_files,
          maxContextTokens: params.max_context_tokens,
          allowedSources: params.allowed_sources,
          contextScopeId: params.context_scope_id,
        });
        const sourceCount = typeof result.source_count === "number" ? result.source_count : 0;
        const files = Array.isArray(result.files_to_read_first) ? result.files_to_read_first.length : 0;
        return { content: [{ type: "text", text: `zob_project_dna_federated_query: sources=${sourceCount} files=${files}` }], details: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_project_dna_federated_query blocked: ${message}` }], details: { schema: "zob.project-dna-federated-query-result.v1", status: "blocked", errors: [message], raw_query_persisted: false, source_project_modified: false, knowledge_backend_write_enabled: false, child_dispatch_allowed: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_project_dna_writeback_proposal",
    label: "ZOB ProjectDNA Writeback Proposal",
    description: "Append a hash-only ProjectDNA learning/writeback proposal. No durable promotion and no external knowledge-backend write.",
    parameters: ProjectDnaWritebackProposalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const proposal = writeProjectDnaWritebackProposal(ctx.cwd, {
          runId: params.run_id,
          proposalId: params.proposal_id,
          sourceIds: params.source_ids,
          observedPatternHash: params.observed_pattern_hash,
          proposedCapsuleHash: params.proposed_capsule_hash,
          evidenceRefs: params.evidence_refs,
          recommendedArtifact: params.recommended_artifact,
        });
        const proposalId = typeof proposal.proposal_id === "string" ? proposal.proposal_id : "unknown";
        return { content: [{ type: "text", text: `zob_project_dna_writeback_proposal proposed: ${proposalId}` }], details: proposal };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_project_dna_writeback_proposal blocked: ${message}` }], details: { schema: "zob.project-dna-writeback-proposal.v1", status: "blocked", errors: [message], raw_problem_stored: false, raw_pattern_stored: false, external_knowledge_backend_write_enabled: false } };
      }
    },
  });
}
