import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AutonomousDryRunParams, AutonomousReadOnlySmokeParams, AutonomousValidateRunParams, AutonomousValidateSmokeParams } from "../schemas.js";
import { validateAutonomousReadOnlySmokeRunArtifacts, validateAutonomousRuntimeDryRunArtifacts, writeAutonomousReadOnlySmokeRunReport, writeAutonomousRuntimeDryRunReport } from "../autonomous-runtime.js";

export function registerAutonomousTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_autonomous_dry_run",
    label: "ZOB Autonomous Runtime Dry-Run",
    description: "Build a metadata-only P0 autonomous runtime dry-run: spec gate, context_scope, model routing plan, factory selection, proof plan, and final report plan. No child dispatch, no daemon, no production writes, no live/global routing, no global autonomy claim.",
    parameters: AutonomousDryRunParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const report = writeAutonomousRuntimeDryRunReport(ctx.cwd, {
          userNeed: params.user_need,
          refinedSpec: params.refined_spec,
          runId: params.run_id,
          constraints: params.constraints,
          acceptanceCriteria: params.acceptance_criteria,
          expectedArtifacts: params.expected_artifacts,
          allowedPaths: params.allowed_paths,
          forbiddenPaths: params.forbidden_paths,
          allowedSources: params.allowed_sources,
          maxContextTokens: params.max_context_tokens,
          applyPolicy: params.apply_policy,
          budgetProfile: params.budget_profile,
          risk: params.risk,
          authorizedAutonomyLevel: params.authorized_autonomy_level,
          userLaunchConfirmed: params.user_launch_confirmed,
          launchConfirmedAt: params.launch_confirmed_at,
          allowedActions: params.allowed_actions,
        });
        const status = typeof report.status === "string" ? report.status : "unknown";
        const runId = typeof report.runId === "string" ? report.runId : "unknown";
        const reportPath = typeof report.reportPath === "string" ? report.reportPath : "reports/autonomous-runs";
        return { content: [{ type: "text", text: `zob_autonomous_dry_run: ${status} ${runId} -> ${reportPath}` }], details: report };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_autonomous_dry_run blocked: ${message}` }], details: { status: "blocked", errors: [message], noExecution: true, childDispatchAllowed: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_autonomous_readonly_smoke",
    label: "ZOB Autonomous Read-Only Smoke",
    description: "Run a Phase 4A reports-only deterministic autonomous smoke: spec/context/model-routing/factory-selection gates, deterministic factory_run smoke, structural oracle review, validation, and SMOKE_AUTONOMY_PASSED sentinel. No child dispatch, no daemon, no production writes, no live/global routing, no global autonomy claim.",
    parameters: AutonomousReadOnlySmokeParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const report = writeAutonomousReadOnlySmokeRunReport(ctx.cwd, {
          userNeed: params.user_need,
          refinedSpec: params.refined_spec,
          runId: params.run_id,
          factoryRunId: params.factory_run_id,
          constraints: params.constraints,
          acceptanceCriteria: params.acceptance_criteria,
          expectedArtifacts: params.expected_artifacts,
          allowedPaths: params.allowed_paths,
          forbiddenPaths: params.forbidden_paths,
          allowedSources: params.allowed_sources,
          maxContextTokens: params.max_context_tokens,
          applyPolicy: params.apply_policy,
          budgetProfile: params.budget_profile,
          risk: params.risk,
          authorizedAutonomyLevel: params.authorized_autonomy_level,
          userLaunchConfirmed: params.user_launch_confirmed,
          launchConfirmedAt: params.launch_confirmed_at,
          allowedActions: params.allowed_actions,
        });
        const status = typeof report.status === "string" ? report.status : "unknown";
        const runId = typeof report.runId === "string" ? report.runId : "unknown";
        const validationPath = typeof report.validationPath === "string" ? report.validationPath : "reports/autonomous-runs";
        return { content: [{ type: "text", text: `zob_autonomous_readonly_smoke: ${status} ${runId} -> ${validationPath}` }], details: report };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_autonomous_readonly_smoke blocked: ${message}` }], details: { status: "blocked", errors: [message], childDispatchAllowed: false, daemonStarted: false, productionWritesPerformed: false, autoApply: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_autonomous_validate_run",
    label: "ZOB Autonomous Dry-Run Artifact Validation",
    description: "Read-only validation for an existing P0 autonomous dry-run artifact set. Checks required artifacts, metadata/hash-only posture, context citations, runtime gates, run graph, factory proof requirements, and no-execution/no-network/no-global-autonomy flags.",
    parameters: AutonomousValidateRunParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const validation = validateAutonomousRuntimeDryRunArtifacts(ctx.cwd, params.run_id);
        const status = validation.valid === true ? "valid" : "invalid";
        const failedChecks = Array.isArray(validation.failedChecks) ? validation.failedChecks : [];
        return { content: [{ type: "text", text: failedChecks.length === 0 ? `zob_autonomous_validate_run: ${status} ${params.run_id}` : `zob_autonomous_validate_run: ${status} ${params.run_id}\n- ${failedChecks.join("\n- ")}` }], details: validation };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_autonomous_validate_run blocked: ${message}` }], details: { status: "blocked", errors: [message], noExecution: true, childDispatchAllowed: false, networkAccessed: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_autonomous_validate_smoke",
    label: "ZOB Autonomous Read-Only Smoke Validation",
    description: "Read-only validation for an existing Phase 4A autonomous read-only smoke artifact set. Checks factory-run-ref, structural oracle, validation, sentinels, and no global autonomy flags.",
    parameters: AutonomousValidateSmokeParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const validation = validateAutonomousReadOnlySmokeRunArtifacts(ctx.cwd, params.run_id);
        const status = validation.valid === true ? "valid" : "invalid";
        const failedChecks = Array.isArray(validation.failedChecks) ? validation.failedChecks : [];
        return { content: [{ type: "text", text: failedChecks.length === 0 ? `zob_autonomous_validate_smoke: ${status} ${params.run_id}` : `zob_autonomous_validate_smoke: ${status} ${params.run_id}\n- ${failedChecks.join("\n- ")}` }], details: validation };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_autonomous_validate_smoke blocked: ${message}` }], details: { status: "blocked", errors: [message], childDispatchAllowed: false, networkAccessed: false } };
      }
    },
  });
}
