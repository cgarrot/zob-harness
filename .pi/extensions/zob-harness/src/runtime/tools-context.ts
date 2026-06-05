import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  ContextReadinessParams,
  ContextSearchParams,
  ContextScopeValidateParams,
  ContextWritebackProposalParams,
} from "./schemas.js";
import {
  buildContextGbrainReadinessAudit,
  buildDefaultContextScope,
  validateContextScope,
  writeContextWritebackProposal,
} from "../domains/context/context-gbrain.js";
import { formatContextSearchResult, runContextSearch } from "../domains/context/context-discovery.js";

export function registerContextTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_context_readiness",
    label: "ZOB Context/GBrain Readiness",
    description: "Audit Context/GBrain P0 readiness: context_scope, citations, bounded packs, forbidden sources, and local metadata-only writeback proposals. No GBrain import/embed/sync/write or corpus writes.",
    parameters: ContextReadinessParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const audit = buildContextGbrainReadinessAudit(ctx.cwd, { runId: params.runId });
      return { content: [{ type: "text", text: `zob_context_readiness: ${audit.verdict}` }], details: audit };
    },
  });

  pi.registerTool({
    name: "zob_context_search",
    label: "ZOB Context Search",
    description: "Search bounded repo-local context through the active context backend. Prefers ColGREP when installed and ready, falls back to safe grep/find-style search, never auto-installs ColGREP, and excludes forbidden/session/vendor/build paths.",
    promptSnippet: "Use zob_context_search for bounded repo-local discovery before broad grep/read; verify exact proof with grep/read on returned refs.",
    promptGuidelines: [
      "Call zob_context_search for codebase/context discovery when semantic or broad search is useful.",
      "zob_context_search prefers ColGREP when ready and falls back to bounded grep when ColGREP is missing, not ready, or a query fails.",
      "Never install ColGREP from this tool path; missing ColGREP is not a blocker.",
      "Use returned refs as leads and verify final claims with exact read/grep evidence.",
    ],
    parameters: ContextSearchParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = runContextSearch(ctx.cwd, params);
      return { content: [{ type: "text", text: formatContextSearchResult(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "zob_context_validate_scope",
    label: "ZOB Context Scope Validate",
    description: "Build and validate a P0 context_scope. Requires citations, bounded tokens, explicit allowed brains/sources, forbidden sources, and proposal-only write policy.",
    parameters: ContextScopeValidateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = buildDefaultContextScope(ctx.cwd, {
        runId: params.runId,
        scopeId: params.scopeId,
        todoId: params.todoId,
        allowedBrains: params.allowedBrains,
        allowedSources: params.allowedSources,
        forbiddenSources: params.forbiddenSources,
        agentProfile: params.agentProfile,
        maxContextTokens: params.maxContextTokens,
      });
      const errors = validateContextScope(ctx.cwd, scope);
      return { content: [{ type: "text", text: errors.length === 0 ? `zob_context_validate_scope: valid ${scope.scopeId}` : `zob_context_validate_scope blocked:\n- ${errors.join("\n- ")}` }], details: { schema: "zob.context-scope-validation.v1", valid: errors.length === 0, errors, scope } };
    },
  });

  pi.registerTool({
    name: "zob_context_writeback_proposal",
    label: "ZOB Context Writeback Proposal",
    description: "Append a local metadata-only context learning/writeback proposal. No auto-promotion, no GBrain/corpus write, requires hash-only problem/pattern and evidence refs.",
    parameters: ContextWritebackProposalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const proposal = writeContextWritebackProposal(ctx.cwd, {
          proposalId: params.proposalId,
          runId: params.runId,
          observedProblemHash: params.observedProblemHash,
          newPatternHash: params.newPatternHash,
          evidenceRefs: params.evidenceRefs,
          recommendedArtifact: params.recommendedArtifact,
        });
        return { content: [{ type: "text", text: `zob_context_writeback_proposal proposed: ${proposal.proposalId}` }], details: proposal };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_context_writeback_proposal blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });
}
