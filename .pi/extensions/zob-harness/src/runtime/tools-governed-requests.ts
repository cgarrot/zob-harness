import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { appendGovernedRequestsToGoalRoom, extractGovernedRequestsFromText, governedRequestBodyFreeViolations } from "../governed-requests.js";
import { GovernedRequestExtractParams } from "../schemas.js";
import { loadTeamDefinition, validateTeamDefinition } from "../topology/teams.js";

export function registerGovernedRequestTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_governed_request_extract",
    label: "ZOB Governed Request Extract",
    description: "Extract DELEGATION_REQUEST.v1 / ORACLE_REQUEST.v1 / CONTEXT_REQUEST.v1 from transient text, append parent-visible Goal Room requests, and never dispatch or mutate TODO state.",
    promptSnippet: "Extract governed requests from transient child output without executing actions.",
    parameters: GovernedRequestExtractParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (!team.definition || errors.length > 0) return { content: [{ type: "text", text: `zob_governed_request_extract failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      const extraction = extractGovernedRequestsFromText(params.transient_text);
      const persisted = params.append_to_goal_room === false ? extraction : appendGovernedRequestsToGoalRoom(ctx.cwd, team.definition, params.goal_id, extraction);
      const bodyFreeViolations = governedRequestBodyFreeViolations(persisted);
      const details = {
        ...persisted,
        bodyFreeViolations,
        appendToGoalRoom: params.append_to_goal_room !== false,
        parentOwnedActions: true,
        childDirectDispatch: false,
        dispatchExecuted: false,
        canonicalTodoMutation: false,
      };
      const status = persisted.extractionErrors.length === 0 && bodyFreeViolations.length === 0 ? "ok" : "blocked";
      pi.appendEntry("zob-governed-request", { event: "extracted", status, requests: persisted.requests.length, goalRoomMessages: persisted.goalRoomMessageIds.length, sourceOutputHash: persisted.sourceOutputHash, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, dispatchExecuted: false, childDirectDispatch: false });
      return {
        content: [{ type: "text", text: `zob_governed_request_extract: ${status}; requests=${persisted.requests.length}; goal_room_messages=${persisted.goalRoomMessageIds.length}` }],
        details,
      };
    },
  });
}
