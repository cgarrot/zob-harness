import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildZobLivePresenceSummary } from "../coms-v2/presence.js";
import { readZobComsV2Policy } from "../coms-v2/policy.js";
import { OrchestrateRunParams, ChainRunParams } from "../schemas.js";
import { createSupervisedReadonlyDispatcher } from "../child-runner.js";
import { runOrchestrateRun } from "../orchestration/run.js";
import { runSupervisedReadonlyOrchestration } from "../orchestration/supervised-readonly.js";
import { runChainPlanOnly } from "../topology/chains.js";
import { sha256 } from "../utils/hashing.js";
import { isRecord } from "../utils/records.js";
import type { HarnessRuntimeState } from "./state.js";
import { strictGoalSpecErrors } from "./state.js";

function agenticComsLivePreflightErrors(repoRoot: string, execution: string | undefined): string[] {
  if (execution !== "supervised_readonly") return [];
  const policy = readZobComsV2Policy(repoRoot);
  if (!policy.agenticWorkflowsRequireLive) return [];
  if (policy.legacy.appendOnlySendEnabled !== false) return ["ZOB coms v2 blocks supervised_readonly: legacy append-only send must be disabled for agentic workflows"];
  if (policy.mode !== "required_local" && policy.mode !== "required_network") return [`ZOB coms v2 blocks supervised_readonly: agentic workflows require required_local live transport, current mode=${policy.mode}`];
  if (policy.mode === "required_network") return ["ZOB coms v2 blocks supervised_readonly: required_network remains gated; use required_local live transport"];
  const presence = buildZobLivePresenceSummary(repoRoot);
  if (presence.dispatchEnabled !== true || presence.online <= 0 || presence.networkEnabled !== false) return [`ZOB coms v2 blocks supervised_readonly: live local registry is not ready (${JSON.stringify({ online: presence.online, stale: presence.stale, offline: presence.offline, dispatchEnabled: presence.dispatchEnabled, networkEnabled: presence.networkEnabled })})`];
  return [];
}

export function registerOrchestrationTools(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerTool({
    name: "orchestrate_run",
    label: "Orchestrate Run",
    description: [
      "Plan a ZOB Orchestrator -> Lead -> Worker run from a team topology manifest.",
      "v1.4 supports plan_only, model-free supervised_smoke metadata, and explicit supervised_readonly parent-owned read-only child dispatch.",
    ].join(" "),
    promptSnippet: "Plan an Orchestrator/Lead/Worker run; only execution=supervised_readonly dispatches read-only child agents",
    promptGuidelines: [
      "Use orchestrate_run when a task needs multiple leads/workers but should remain parent-preflighted.",
      "Use execution=plan_only for contracts only, execution=supervised_smoke for model-free read-only planning metadata, or execution=supervised_readonly only when live parent-owned read-only child dispatch is explicitly intended.",
      "Do not treat a planned orchestration as completed implementation work.",
    ],
    parameters: OrchestrateRunParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const goalErrors = strictGoalSpecErrors(state, { kind: "orchestrate_run", goal: params.goal, originalUserAsk: params.original_user_ask });
      if (goalErrors.length > 0) {
        const result = { status: "failed_preflight", runId: params.run_id ?? "not-started", runDir: "", tasks: 0, artifacts: [], errors: goalErrors };
        return { content: [{ type: "text", text: `orchestrate_run failed_preflight:\n- ${goalErrors.join("\n- ")}\nSet /goal_gate or /job_intake before dispatch.` }], details: result };
      }
      const liveComsErrors = agenticComsLivePreflightErrors(ctx.cwd, params.execution);
      if (liveComsErrors.length > 0) {
        const result = { status: "failed_preflight", runId: params.run_id ?? "not-started", runDir: "", tasks: 0, artifacts: [], errors: liveComsErrors, comsLiveRequired: true };
        return { content: [{ type: "text", text: `orchestrate_run failed_preflight:\n- ${liveComsErrors.join("\n- ")}` }], details: result };
      }
      const result = params.execution === "supervised_readonly"
        ? await runSupervisedReadonlyOrchestration(ctx.cwd, params, createSupervisedReadonlyDispatcher(ctx, signal, undefined, (partial) => {
          onUpdate?.({ content: [{ type: "text", text: partial.output || partial.stderr || "supervised_readonly child running..." }], details: { status: "running", agent: partial.agent, outputHash: partial.output ? sha256(partial.output) : undefined } });
        }))
        : runOrchestrateRun(ctx.cwd, params);
      const resultRecord = isRecord(result) ? result : {};
      pi.appendEntry("zob-orchestrate-run", {
        runId: typeof resultRecord.runId === "string" ? resultRecord.runId : params.run_id ?? "unknown-run",
        team: params.team ?? "zob-core",
        execution: params.execution ?? "plan_only",
        status: typeof resultRecord.status === "string" ? resultRecord.status : "unknown",
        tasks: typeof resultRecord.tasks === "number" ? resultRecord.tasks : 0,
        artifacts: Array.isArray(resultRecord.artifacts) ? resultRecord.artifacts : [],
        errors: Array.isArray(resultRecord.errors) ? resultRecord.errors : [],
      });
      const artifacts = Array.isArray(resultRecord.artifacts) ? resultRecord.artifacts.filter((artifact): artifact is string => typeof artifact === "string") : [];
      const errors = Array.isArray(resultRecord.errors) ? resultRecord.errors.filter((error): error is string => typeof error === "string") : [];
      const text = [
        `orchestrate_run ${String(resultRecord.status ?? "unknown")}: ${String(resultRecord.runId ?? "unknown-run")}`,
        `runDir: ${String(resultRecord.runDir ?? "")}`,
        `execution: ${params.execution ?? "plan_only"}`,
        `tasks: ${String(resultRecord.tasks ?? 0)}`,
        typeof resultRecord.dispatched === "number" ? `dispatched: ${resultRecord.dispatched}` : undefined,
        typeof resultRecord.completed === "number" ? `completed: ${resultRecord.completed}` : undefined,
        typeof resultRecord.failed === "number" ? `failed: ${resultRecord.failed}` : undefined,
        artifacts.length > 0 ? `artifacts:\n- ${artifacts.join("\n- ")}` : "artifacts: none",
        errors.length > 0 ? `errors:\n- ${errors.join("\n- ")}` : "errors: none",
      ].filter((line): line is string => typeof line === "string").join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "chain_run",
    label: "Chain Run",
    description: [
      "Plan a typed contract-first chain from .pi/chains without live child execution.",
      "Only plan_only read-only chains are supported; unsafe tools, unknown agents, and unknown output contracts fail preflight.",
    ].join(" "),
    promptSnippet: "Plan a typed read-only chain run without executing child agents",
    promptGuidelines: [
      "Use chain_run for reusable explore/plan/oracle flows where delegate_task-shaped contracts should be planned first.",
      "Do not use chain_run for write-enabled execution; sandboxed execution is not implemented.",
    ],
    parameters: ChainRunParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = runChainPlanOnly(ctx.cwd, params);
      const text = result.status === "planned"
        ? `chain_run planned ${result.steps} step(s) for ${result.chain} at ${result.runDir}`
        : `chain_run preflight failed:\n- ${result.errors.join("\n- ")}`;
      return { content: [{ type: "text", text }], details: result };
    },
  });
}
