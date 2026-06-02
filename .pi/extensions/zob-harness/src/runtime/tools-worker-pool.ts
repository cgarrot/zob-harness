import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createWorkerPoolOwnerDecision, createWorkerPoolOwnerRequest, createWorkerPoolPlan, listWorkerPoolPlans, workerPoolBodyFreeViolations } from "../domains/governance/worker-pool.js";
import { WorkerPoolOwnerDecisionParams, WorkerPoolOwnerRequestParams, WorkerPoolPlanParams, WorkerPoolStatusParams } from "./schemas.js";
import { loadTeamDefinition, validateTeamDefinition } from "../domains/topology/teams.js";

export function registerWorkerPoolTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_worker_pool_plan",
    label: "ZOB Worker Pool Plan",
    description: "Create a parent-owned metadata-only worker pool plan for read-across/write-by-owner coordination. Enforces write paths within owned paths, integrates active workspace claims, records sandbox/merge/rollback/oracle gates, and never applies changes.",
    promptSnippet: "Plan parent-owned worker pool assignments with owned/write/read-across paths, workspace claims, and no-apply safety gates.",
    parameters: WorkerPoolPlanParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (!team.definition || errors.length > 0) return { content: [{ type: "text", text: `zob_worker_pool_plan failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      try {
        const { team: _team, ...input } = params;
        const plan = createWorkerPoolPlan(ctx.cwd, team.definition, input);
        const bodyFreeViolations = workerPoolBodyFreeViolations(plan);
        pi.appendEntry("zob-worker-pool", { event: "plan_recorded", poolId: plan.poolId, goalId: plan.goalId, status: plan.status, conflicts: plan.conflicts.length, productionWritesPerformed: false, autoApply: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
        return { content: [{ type: "text", text: `zob_worker_pool_plan: ${plan.status} ${plan.poolId}` }], details: { schema: "zob.worker-pool-plan-result.v1", plan, bodyFreeViolations } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_worker_pool_plan blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_worker_pool_status",
    label: "ZOB Worker Pool Status",
    description: "List parent-owned metadata-only worker pool plans, ownership coverage, workspace-claim posture, and sandbox/merge gate blockers. Bodies are never persisted or returned.",
    promptSnippet: "List worker pool metadata, ownership coverage, claim coverage, and conflict posture.",
    parameters: WorkerPoolStatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const plans = listWorkerPoolPlans(ctx.cwd, params);
        return { content: [{ type: "text", text: `zob_worker_pool_status: ${plans.length} plan(s)` }], details: { schema: "zob.worker-pool-status.v1", plans, bodyFreeViolations: workerPoolBodyFreeViolations(plans) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_worker_pool_status blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_worker_pool_owner_request",
    label: "ZOB Worker Pool Owner Request",
    description: "Validate an owner request against the existing pool plan, then append a body-free OWNER_CHANGE_REQUEST to parent-visible Goal Room. No direct worker-to-worker free chat or apply.",
    promptSnippet: "Request an owner-handled change through canonical Goal Room metadata after owner path coverage validation.",
    parameters: WorkerPoolOwnerRequestParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (!team.definition || errors.length > 0) return { content: [{ type: "text", text: `zob_worker_pool_owner_request failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      try {
        const { team: _team, ...input } = params;
        const request = createWorkerPoolOwnerRequest(ctx.cwd, team.definition, input);
        const bodyFreeViolations = workerPoolBodyFreeViolations(request);
        pi.appendEntry("zob-worker-pool", { event: "owner_request_recorded", requestId: request.requestId, poolId: request.poolId, goalRoomMsgId: request.goalRoomMsgId, parentVisible: true, hiddenPeerChat: false, workerToWorkerDirect: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
        return { content: [{ type: "text", text: `zob_worker_pool_owner_request: ${request.requestId}` }], details: { schema: "zob.worker-pool-owner-request-result.v1", request, bodyFreeViolations } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_worker_pool_owner_request blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_worker_pool_owner_decision",
    label: "ZOB Worker Pool Owner Decision",
    description: "Append a body-free OWNER_CHANGE_DECISION to the parent-visible Goal Room and record parent-owned owner decision metadata. Does not apply diffs.",
    promptSnippet: "Record an owner decision for a worker pool change request.",
    parameters: WorkerPoolOwnerDecisionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (!team.definition || errors.length > 0) return { content: [{ type: "text", text: `zob_worker_pool_owner_decision failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      try {
        const { team: _team, ...input } = params;
        const decision = createWorkerPoolOwnerDecision(ctx.cwd, team.definition, input);
        const bodyFreeViolations = workerPoolBodyFreeViolations(decision);
        pi.appendEntry("zob-worker-pool", { event: "owner_decision_recorded", decisionId: decision.decisionId, requestId: decision.requestId, poolId: decision.poolId, goalRoomMsgId: decision.goalRoomMsgId, parentVisible: true, hiddenPeerChat: false, workerToWorkerDirect: false, productionWritesPerformed: false, autoApply: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
        return { content: [{ type: "text", text: `zob_worker_pool_owner_decision: ${decision.decisionId}` }], details: { schema: "zob.worker-pool-owner-decision-result.v1", decision, bodyFreeViolations } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_worker_pool_owner_decision blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });
}
