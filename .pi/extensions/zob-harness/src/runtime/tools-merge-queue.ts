import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { decideMergeCandidate, listMergeQueue, mergeQueueBodyFreeViolations, submitMergeCandidate } from "../domains/governance/merge-queue.js";
import { MergeCandidateSubmitParams, MergeQueueDecideParams, MergeQueueListParams } from "./schemas.js";
import { loadTeamDefinition, validateTeamDefinition } from "../domains/topology/teams.js";

export function registerMergeQueueTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_merge_candidate_submit",
    label: "ZOB Merge Candidate Submit",
    description: "Submit a sandbox diff as a parent-owned merge-queue candidate. Metadata-only; never applies changes or writes source files.",
    promptSnippet: "Queue a sandboxed merge candidate for parent review.",
    parameters: MergeCandidateSubmitParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (!team.definition || errors.length > 0) return { content: [{ type: "text", text: `zob_merge_candidate_submit failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      try {
        const candidate = submitMergeCandidate(ctx.cwd, team.definition, params);
        pi.appendEntry("zob-merge-queue", { event: "candidate_queued", candidateId: candidate.candidateId, runId: candidate.runId, applyPerformed: false, productionWritesPerformed: false, autoApply: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
        return { content: [{ type: "text", text: `zob_merge_candidate_submit: queued ${candidate.candidateId}` }], details: { schema: "zob.merge-candidate-submit-result.v1", candidate, bodyFreeViolations: mergeQueueBodyFreeViolations(candidate) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_merge_candidate_submit blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_merge_queue_decide",
    label: "ZOB Merge Queue Decide",
    description: "Record a parent-owned merge queue decision. Approval means manual-apply eligible only; this tool never applies changes.",
    promptSnippet: "Record a parent-owned merge queue decision.",
    parameters: MergeQueueDecideParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (!team.definition || errors.length > 0) return { content: [{ type: "text", text: `zob_merge_queue_decide failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      try {
        const decision = decideMergeCandidate(ctx.cwd, team.definition, params);
        pi.appendEntry("zob-merge-queue", { event: "decision_recorded", candidateId: decision.candidateId, decision: decision.decision, applyPerformed: false, productionWritesPerformed: false, autoApply: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
        return { content: [{ type: "text", text: `zob_merge_queue_decide: ${decision.decision} ${decision.candidateId}` }], details: { schema: "zob.merge-decision-result.v1", decision, bodyFreeViolations: mergeQueueBodyFreeViolations(decision) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_merge_queue_decide blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_merge_queue_list",
    label: "ZOB Merge Queue List",
    description: "List metadata-only parent merge-queue candidates and latest decisions. Bodies/diffs are never returned.",
    promptSnippet: "List parent-owned merge queue metadata.",
    parameters: MergeQueueListParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const candidates = listMergeQueue(ctx.cwd, params);
      return { content: [{ type: "text", text: `zob_merge_queue_list: ${candidates.length} candidate(s)` }], details: { schema: "zob.merge-queue-list.v1", candidates, bodyFreeViolations: mergeQueueBodyFreeViolations(candidates) } };
    },
  });
}
