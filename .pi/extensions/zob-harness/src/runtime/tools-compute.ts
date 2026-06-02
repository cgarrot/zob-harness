import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildComputePreview, resolveComputeProfile, validateComputeProfileArtifacts, writeComputeProfileReports } from "../domains/compute/compute-profile.js";
import { buildComputeWorkflowShape } from "../domains/compute/compute-workflow-shape.js";
import { ComputePlanWorkflowParams, ComputePreviewParams, ComputeResolveProfileParams, ComputeValidateProfileParams, ComputeWriteProfileReportsParams } from "./schemas.js";

export function registerComputeTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_compute_preview",
    label: "ZOB Compute Profile Preview",
    description: "Preview task/project complexity and recommend low/medium/high/xhigh/max compute without child dispatch, network access, or source writes.",
    parameters: ComputePreviewParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const preview = buildComputePreview(ctx.cwd, {
          runId: params.run_id,
          domain: params.domain,
          requestedProfile: params.requested_profile,
          targetPath: params.target_path,
          taskHash: params.task_hash,
          maxProfile: params.max_profile,
          computeCaps: params.compute_caps,
          riskHints: params.risk_hints,
        });
        const recommended = typeof preview.recommendedProfile === "string" ? preview.recommendedProfile : "unknown";
        const confidence = typeof preview.confidence === "string" ? preview.confidence : "unknown";
        return { content: [{ type: "text", text: `zob_compute_preview: recommended=${recommended} confidence=${confidence}` }], details: preview };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_compute_preview blocked: ${message}` }], details: { status: "blocked", errors: [message], noExecution: true, childDispatchAllowed: false, networkAccessed: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_compute_resolve_profile",
    label: "ZOB Compute Profile Resolve",
    description: "Resolve requested compute profile into an effective profile, hard caps, and gates. Metadata-only; no child dispatch, network access, or source writes.",
    parameters: ComputeResolveProfileParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const resolution = resolveComputeProfile(ctx.cwd, {
          runId: params.run_id,
          domain: params.domain,
          requestedProfile: params.requested_profile,
          targetPath: params.target_path,
          taskHash: params.task_hash,
          maxProfile: params.max_profile,
          computeCaps: params.compute_caps,
          riskHints: params.risk_hints,
        });
        const effective = typeof resolution.effectiveProfile === "string" ? resolution.effectiveProfile : "unknown";
        const noShip = resolution.noShip === true ? " no_ship=true" : "";
        return { content: [{ type: "text", text: `zob_compute_resolve_profile: effective=${effective}${noShip}` }], details: resolution };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_compute_resolve_profile blocked: ${message}` }], details: { status: "blocked", errors: [message], noExecution: true, childDispatchAllowed: false, networkAccessed: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_compute_plan_workflow",
    label: "ZOB Compute Workflow Shape",
    description: "Build a metadata-only workflow shape from a resolved compute profile. No child dispatch, network access, or source writes.",
    parameters: ComputePlanWorkflowParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const shape = buildComputeWorkflowShape(ctx.cwd, {
          runId: params.run_id,
          domain: params.domain,
          requestedProfile: params.requested_profile,
          targetPath: params.target_path,
          taskHash: params.task_hash,
          maxProfile: params.max_profile,
          computeCaps: params.compute_caps,
          riskHints: params.risk_hints,
          resolutionPath: params.resolution_path,
        });
        const effective = typeof shape.effectiveProfile === "string" ? shape.effectiveProfile : "unknown";
        const laneCount = Array.isArray(shape.lanes) ? shape.lanes.length : 0;
        return { content: [{ type: "text", text: `zob_compute_plan_workflow: effective=${effective} lanes=${laneCount}` }], details: shape };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_compute_plan_workflow blocked: ${message}` }], details: { status: "blocked", errors: [message], noExecution: true, childDispatchAllowed: false, networkAccessed: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_compute_validate_profile",
    label: "ZOB Compute Profile Artifact Validation",
    description: "Validate existing compute-preview/profile-resolution artifacts. Read-only; no execution, network access, or child dispatch.",
    parameters: ComputeValidateProfileParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const validation = validateComputeProfileArtifacts(ctx.cwd, {
          previewPath: params.preview_path,
          resolutionPath: params.resolution_path,
        });
        const status = validation.valid === true ? "valid" : "invalid";
        const errors = Array.isArray(validation.errors) ? validation.errors : [];
        return { content: [{ type: "text", text: errors.length === 0 ? `zob_compute_validate_profile: ${status}` : `zob_compute_validate_profile: ${status}\n- ${errors.join("\n- ")}` }], details: validation };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_compute_validate_profile blocked: ${message}` }], details: { status: "blocked", errors: [message], noExecution: true, childDispatchAllowed: false, networkAccessed: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_compute_write_profile_reports",
    label: "ZOB Compute Profile Report Writer",
    description: "Write local metadata-only compute preview/profile-resolution reports under .pi/logs/compute-profile. No child dispatch, network access, or source writes.",
    parameters: ComputeWriteProfileReportsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const report = writeComputeProfileReports(ctx.cwd, {
          runId: params.run_id,
          domain: params.domain,
          requestedProfile: params.requested_profile,
          targetPath: params.target_path,
          taskHash: params.task_hash,
          maxProfile: params.max_profile,
          computeCaps: params.compute_caps,
          riskHints: params.risk_hints,
        });
        const previewPath = typeof report.previewPath === "string" ? report.previewPath : ".pi/logs/compute-profile";
        return { content: [{ type: "text", text: `zob_compute_write_profile_reports: written -> ${previewPath}` }], details: report };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_compute_write_profile_reports blocked: ${message}` }], details: { status: "blocked", errors: [message], noExecution: true, childDispatchAllowed: false, networkAccessed: false } };
      }
    },
  });
}
