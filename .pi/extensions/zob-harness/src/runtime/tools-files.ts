import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

import { FullReadParams, ReceiveFullParams } from "./schemas.js";
import { FULL_READ_DEFAULT_IO, FULL_READ_DEFAULT_POLICY, runFullRead, type FullReadContextUsage } from "../domains/files/full-read.js";
import { receiveFullResponse } from "../domains/files/response-receive.js";

/** Adapt the SDK message-based estimator to the domain module's (text: string) => number contract. */
const estimateTextTokens = (text: string): number => estimateTokens({ role: "user", content: text, timestamp: 0 });

export function registerFileTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_read_full",
    label: "ZOB Read Full File",
    description:
      "Read an entire file in one call when the live model context window has enough headroom; refuse with pagination guidance otherwise. v1 supports utf8 text only. Reuses path/secret safety from the file-tool preflight policy and keeps all telemetry body-free. Prefer the native read tool (offset/limit) for paginated or small reads.",
    promptSnippet:
      "Use zob_read_full only when you need the WHOLE file and the context window has headroom; for small/paginated reads use native read with offset/limit, and for discovery use zob_context_search/grep.",
    promptGuidelines: [
      "Use zob_read_full for whole-file loads only when the live context window has sufficient headroom.",
      "For small or paginated reads prefer the native read tool with offset/limit.",
      "Never use zob_read_full on secrets or generated/vendor paths (.env, ~/.ssh, ~/.aws, node_modules, dist, build, .pi/sessions).",
      "On a block (exceeds_context_budget / exceeds_hard_ceiling) switch to paginated native read or zob_context_search/grep.",
      "Tool details are body-free; only the returned text carries file content.",
    ],
    parameters: FullReadParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rawUsage = ctx.getContextUsage();
      const usage: FullReadContextUsage = {
        ...(typeof rawUsage?.tokens === "number" ? { tokens: rawUsage.tokens } : {}),
        ...(typeof rawUsage?.contextWindow === "number" ? { contextWindow: rawUsage.contextWindow } : {}),
        ...(typeof rawUsage?.percent === "number" ? { percent: rawUsage.percent } : {}),
      };

      const result = runFullRead({
        cwd: ctx.cwd,
        path: params.path,
        encoding: params.encoding,
        maxBytesOverride: params.max_bytes,
        usage,
        policy: FULL_READ_DEFAULT_POLICY,
        io: FULL_READ_DEFAULT_IO,
        estimateTokens: estimateTextTokens,
      });

      let text: string;
      if (result.decision === "pass") {
        text = result.content ?? "";
      } else if (result.decision === "observe") {
        text = `[zob_read_full observe: context window unknown; governed by hard ceiling only]\n${result.content ?? ""}`;
      } else {
        const d = result.details;
        const head = [
          `zob_read_full blocked: ${result.reasonCode}`,
          `path: ${params.path}`,
          `byteSize: ${d.byteSize}`,
          `estimatedTokens: ${d.estimatedTokens}`,
        ];
        if (typeof d.contextWindow === "number") head.push(`contextWindow: ${d.contextWindow}`);
        if (typeof d.contextTokensBefore === "number") head.push(`contextTokensBefore: ${d.contextTokensBefore}`);
        if (typeof d.availableTokens === "number") head.push(`availableTokens: ${d.availableTokens}`);
        if (typeof d.allowedTokens === "number") head.push(`allowedTokens: ${d.allowedTokens}`);
        head.push(`hardCeilingBytes: ${d.hardCeilingBytes}`);
        const guidance =
          result.reasonCode === "exceeds_context_budget" || result.reasonCode === "exceeds_hard_ceiling"
            ? "Use the native read tool with offset/limit for paginated reads, or zob_context_search/grep for targeted discovery."
            : "Correct the path or encoding and retry; see reason code.";
        text = `${head.join(" | ")}\n${guidance}`;
      }

      return { content: [{ type: "text", text }], details: result.details };
    },
  });

  pi.registerTool({
    name: "zob_receive_full",
    label: "ZOB Receive Full Response",
    description:
      "Return a long response in one call when the live model context window has enough headroom; refuse with pagination/recovery guidance otherwise. Two sources: run_id resolves a run's persisted report artifact under reports/factory-runs|orchestrations|chains/<runId>/ (raw child output bodies are not persisted; this returns the run's report artifacts such as final-report.md or a named artifact); or path for any repo response file. Reuses the zob_read_full context-budget + path/secret safety (incl. realpath symlink check). Telemetry is body-free. Prefer paginated read/grep for smaller or targeted needs.",
    promptSnippet:
      "Use zob_receive_full to pull a long run report or response artifact into context in one shot only when headroom allows; for small/targeted needs use read (offset/limit), grep, or zob_context_search.",
    promptGuidelines: [
      "Use zob_receive_full for whole run-report/response-artifact loads only when the live context window has sufficient headroom.",
      "run_id returns the run's persisted report artifact, not raw child output (bodies are not stored).",
      "On run_not_found/artifact_not_found check the run_id/run_type/artifact; on exceeds_context_budget/exceeds_hard_ceiling switch to paginated read or grep.",
      "Never point path at secrets/generated/vendor paths (.env, ~/.ssh, ~/.aws, node_modules, dist, build, .pi/sessions).",
      "Tool details are body-free; only the returned text carries content.",
    ],
    parameters: ReceiveFullParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rawUsage = ctx.getContextUsage();
      const usage: FullReadContextUsage = {
        ...(typeof rawUsage?.tokens === "number" ? { tokens: rawUsage.tokens } : {}),
        ...(typeof rawUsage?.contextWindow === "number" ? { contextWindow: rawUsage.contextWindow } : {}),
        ...(typeof rawUsage?.percent === "number" ? { percent: rawUsage.percent } : {}),
      };

      const result = receiveFullResponse({
        cwd: ctx.cwd,
        path: params.path,
        runId: params.run_id,
        runType: params.run_type,
        artifact: params.artifact,
        maxBytesOverride: params.max_bytes,
        usage,
        policy: FULL_READ_DEFAULT_POLICY,
        io: FULL_READ_DEFAULT_IO,
        estimateTokens: estimateTextTokens,
      });

      let text: string;
      if (result.decision === "pass") {
        text = result.content ?? "";
      } else if (result.decision === "observe") {
        text = `[zob_receive_full observe: context window unknown; governed by hard ceiling only]\n${result.content ?? ""}`;
      } else {
        const d = result.details;
        const head = [`zob_receive_full blocked: ${result.reasonCode}`];
        if (d.source === "run") {
          head.push(`runType: ${d.runType}`);
          head.push(`runId: ${d.runId}`);
          head.push(`artifact: ${d.artifact}`);
        } else {
          head.push(`path: ${params.path}`);
        }
        head.push(`byteSize: ${d.byteSize}`);
        head.push(`estimatedTokens: ${d.estimatedTokens}`);
        if (typeof d.contextWindow === "number") head.push(`contextWindow: ${d.contextWindow}`);
        if (typeof d.contextTokensBefore === "number") head.push(`contextTokensBefore: ${d.contextTokensBefore}`);
        if (typeof d.availableTokens === "number") head.push(`availableTokens: ${d.availableTokens}`);
        if (typeof d.allowedTokens === "number") head.push(`allowedTokens: ${d.allowedTokens}`);
        head.push(`hardCeilingBytes: ${d.hardCeilingBytes}`);
        const guidance =
          result.reasonCode === "exceeds_context_budget" || result.reasonCode === "exceeds_hard_ceiling"
            ? "Use the native read tool with offset/limit for paginated reads, or zob_context_search/grep for targeted discovery."
            : result.reasonCode === "run_not_found" || result.reasonCode === "artifact_not_found"
            ? "Check the run_id, run_type, and artifact; list the run dir with ls if needed."
            : result.reasonCode === "run_id_unsafe" || result.reasonCode === "artifact_unsafe"
            ? "Use a path-safe run_id (alphanumeric, ., _, -) and a single-basename artifact (no slashes or ..)."
            : result.reasonCode === "path_secret_rejected" ||
              result.reasonCode === "symlink_resolves_to_zero_access" ||
              result.reasonCode === "path_forbidden_generated"
            ? "Choose a non-secret, non-generated response path."
            : result.reasonCode === "source_required"
            ? "Provide exactly one of path or run_id."
            : result.reasonCode === "ambiguous_source"
            ? "Provide exactly one of path or run_id, not both."
            : "Correct the input and retry; see reason code.";
        text = `${head.join(" | ")}\n${guidance}`;
      }

      return { content: [{ type: "text", text }], details: result.details };
    },
  });
}
