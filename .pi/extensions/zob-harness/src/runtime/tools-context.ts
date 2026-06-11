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
    promptSnippet: "For exploratory/natural-language repo discovery, call zob_context_search before broad grep/find and reuse it at context pivots; if this tool is not exposed but bash is available, use compact npm run --silent zob:context:query before rg/grep; verify exact proof with grep/read on returned refs or known identifiers.",
    promptGuidelines: [
      "Call zob_context_search first for exploratory/natural-language codebase discovery when semantic or broad search is useful.",
      "zob_context_search prefers ColGREP when ready and falls back to bounded grep when ColGREP is missing, not ready, or a query fails.",
      "If zob_context_search is not available in the current toolset, use the compact local wrapper: npm run --silent zob:context:query -- --query \"<query>\" --max-results 6 --max-context-lines 1 before broad rg/grep.",
      "Never install ColGREP from this tool path; missing ColGREP is not a blocker.",
      "Reuse zob_context_search at context pivot points: new subsystem/domain, ambiguous or broad file area, fallback_status suggesting narrower paths, repeated low-signal grep/find, unfamiliar code before edits, or unknown validation/test failure.",
      "Never run broad grep/find over .pi unless .pi/sessions and .pi/agent-sessions are explicitly excluded/pruned.",
      "Use returned refs as leads and verify final claims with exact read/grep evidence; use grep/read directly when exact identifiers or paths are already known.",
    ],
    parameters: ContextSearchParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runContextSearch(ctx.cwd, params);
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
