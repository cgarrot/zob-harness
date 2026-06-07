import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { repoRel, resolveRunDir, writeJson, writeText } from "./cli-io.mjs";
import { SCHEMA_PREFIX } from "./constants.mjs";
import { buildProfiles, writeProfileArtifacts } from "./profiles.mjs";
import { HARNESS_INTAKE_AGENTS, initializeRun } from "./run-init.mjs";
import { scanSources } from "./scan.mjs";

export function validateRun(runIdOrDir) {
  const runDir = resolveRunDir(runIdOrDir);
  const required = [
    "request.md",
    "inferred-run-spec.json",
    "manifest.json",
    "agentic-plan.json",
    "artifact-contracts.json",
    "autonomous-status.md",
    "sources-index.json",
    "source-risk-report.json",
    "harness-profile.json",
    "skills-profile.json",
    "commands-profile.json",
    "prompt-patterns.json",
    "sessions-analysis.json",
    "workflow-patterns.json",
    "team-candidates.json",
    "factory-candidates.json",
  ];
  const errors = [];
  const warnings = [];
  for (const file of required) {
    if (!existsSync(join(runDir, file))) errors.push(`missing ${file}`);
  }
  const spec = readJsonIfExists(join(runDir, "inferred-run-spec.json"));
  const sources = readJsonIfExists(join(runDir, "sources-index.json"));
  const sessions = readJsonIfExists(join(runDir, "sessions-analysis.json"));
  const teams = readJsonIfExists(join(runDir, "team-candidates.json"));
  const factories = readJsonIfExists(join(runDir, "factory-candidates.json"));
  const artifactContracts = readJsonIfExists(join(runDir, "artifact-contracts.json"));
  if (spec && spec.schema !== `${SCHEMA_PREFIX}.inferred-run-spec.v1`) errors.push("inferred-run-spec schema mismatch");
  if (sources && sources.schema !== `${SCHEMA_PREFIX}.sources-index.v1`) errors.push("sources-index schema mismatch");
  if (artifactContracts && artifactContracts.schema !== `${SCHEMA_PREFIX}.artifact-contracts.v1`) errors.push("artifact-contracts schema mismatch");
  if (artifactContracts?.startup_file_delivery_required !== true) errors.push("artifact-contracts must require startup file delivery");
  if (artifactContracts?.raw_prompt_transport_line_by_line !== false) errors.push("artifact-contracts must set raw_prompt_transport_line_by_line=false");
  if (sessions?.status === "analyzed" && spec?.sessions?.authorized !== true) errors.push("sessions were analyzed without recorded authorization");
  if ((sources?.sources ?? []).some((source) => source.contains_possible_secret)) errors.push("source index includes possible secret-like content/path; review source-risk-report.json");
  if (!Array.isArray(teams?.candidates) || teams.candidates.length < 1) errors.push("team-candidates must include at least one candidate");
  if (!Array.isArray(factories?.candidates) || factories.candidates.length < 1) warnings.push("no factory candidates produced");
  const generatedDir = join(runDir, "generated-proposals");
  if (!existsSync(generatedDir)) errors.push("missing generated-proposals directory");
  for (const agent of HARNESS_INTAKE_AGENTS) {
    const kickoffPath = join(runDir, "kickoff", `${agent.id}-kickoff.md`);
    if (!existsSync(kickoffPath)) errors.push(`missing kickoff file for ${agent.id}`);
  }
  const dispatch = readJsonIfExists(join(runDir, "tmux", "kickoff-dispatch.json"));
  if (dispatch) {
    if (dispatch.startup_file_delivery !== true) errors.push("tmux kickoff-dispatch must set startup_file_delivery=true");
    if (dispatch.raw_prompt_transport_line_by_line !== false) errors.push("tmux kickoff-dispatch must set raw_prompt_transport_line_by_line=false");
    if (dispatch.post_start_tmux_paste_disabled !== true) errors.push("tmux kickoff-dispatch must set post_start_tmux_paste_disabled=true");
    if (!Array.isArray(dispatch.panes) || dispatch.panes.length !== HARNESS_INTAKE_AGENTS.length) errors.push("tmux kickoff-dispatch panes must cover every harness-intake agent");
  }
  const validation = {
    schema: `${SCHEMA_PREFIX}.validation.v1`,
    run_id: spec?.run_id ?? basename(runDir),
    status: errors.length ? "fail" : "pass",
    no_ship: errors.length > 0,
    errors,
    warnings,
    checked_files: required,
    source_project_modified: false,
    activation_performed: false,
    quarantine_only: true,
    validated_at: new Date().toISOString(),
  };
  writeJson(join(runDir, "validation.json"), validation);
  const oracle = {
    schema: `${SCHEMA_PREFIX}.oracle-review.v1`,
    verdict: errors.length ? "FAIL" : warnings.length ? "WARN" : "PASS",
    no_ship: errors.length > 0,
    confidence: errors.length ? "HIGH" : "MEDIUM",
    evidence_refs: required.filter((file) => existsSync(join(runDir, file))),
    blocking_issues: errors,
    non_blocking_notes: warnings,
    reviewed_at: new Date().toISOString(),
    compliance: "deterministic local validation; no activation; no source mutation",
  };
  writeJson(join(runDir, "oracle-review.json"), oracle);
  if (errors.length) {
    writeText(join(runDir, "NO_SHIP.sentinel"), `${errors.join("\n")}\n`);
  } else {
    const mode = spec?.mode === "pilot" ? "PILOT_PASSED.sentinel" : spec?.mode === "batch" ? "BATCH_PASSED.sentinel" : "SMOKE_PASSED.sentinel";
    writeText(join(runDir, mode), "pass\n");
    writeText(join(runDir, "DONE.sentinel"), "done\n");
  }
  writeJson(join(runDir, "status.json"), {
    schema: `${SCHEMA_PREFIX}.status.v1`,
    run_id: spec?.run_id ?? basename(runDir),
    status: validation.status,
    no_ship: validation.no_ship,
    phase: "validation",
    run_dir: repoRel(runDir),
    updated_at: new Date().toISOString(),
  });
  return validation;
}

export function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeSourceArtifacts(runDir, sourceIndex) {
  writeJson(join(runDir, "sources-index.json"), sourceIndex);
  const risky = (sourceIndex.sources ?? []).filter((source) => source.contains_possible_secret || source.secret_like_reasons?.length);
  const report = {
    schema: `${SCHEMA_PREFIX}.source-risk-report.v1`,
    run_id: sourceIndex.run_id,
    status: risky.length ? "review-required" : "pass",
    no_ship: risky.length > 0,
    source_project_modified: false,
    risks: risky.map((source) => ({ source_id: source.source_id, path: source.path, reasons: source.secret_like_reasons })),
    skipped_secret_like_paths: (sourceIndex.skipped ?? []).filter((row) => String(row.reason).startsWith("forbidden:")),
  };
  writeJson(join(runDir, "source-risk-report.json"), report);
}

export function runFullAnalysis(spec, opts = {}) {
  const { runDir } = initializeRun(spec);
  if (opts.prepareOnly) {
    return { schema: `${SCHEMA_PREFIX}.launch-result.v1`, status: "prepared", no_ship: false, run_id: spec.run_id, run_dir: repoRel(runDir), prepared_only: true };
  }
  const sourcesIndex = scanSources(spec);
  writeSourceArtifacts(runDir, sourcesIndex);
  const profiles = buildProfiles(spec, sourcesIndex);
  writeProfileArtifacts(runDir, profiles);
  const validation = validateRun(runDir);
  return {
    schema: `${SCHEMA_PREFIX}.launch-result.v1`,
    status: validation.status,
    no_ship: validation.no_ship,
    run_id: spec.run_id,
    run_dir: repoRel(runDir),
    target: spec.target.input,
    harness_hint: spec.harness_hint,
    validation_ref: `${repoRel(runDir)}/validation.json`,
    generated_proposals_ref: `${repoRel(runDir)}/generated-proposals`,
  };
}
