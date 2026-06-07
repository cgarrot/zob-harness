import { join } from "node:path";
import { ensureDir, repoRel, resolveRunDir, writeJson, writeText } from "./cli-io.mjs";
import { FACTORY_NAME, SCHEMA_PREFIX } from "./constants.mjs";

export function initializeRun(spec) {
  const runDir = resolveRunDir(spec.run_id);
  const relRunDir = repoRel(runDir);
  ensureDir(runDir);
  for (const child of ["checkpoints", "outputs", "validation", "oracle", "generated-proposals/teams", "generated-proposals/agents", "generated-proposals/factories", "generated-proposals/kickoff", "kickoff", "tmux"]) {
    ensureDir(join(runDir, child));
  }
  writeText(join(runDir, "request.md"), `# Harness Intake Request\n\n${spec.request}\n\nRequest hash: \`${spec.request_hash}\`\n`);
  writeJson(join(runDir, "inferred-run-spec.json"), spec);
  const manifest = {
    schema: `${SCHEMA_PREFIX}.manifest.v1`,
    factory: FACTORY_NAME,
    run_id: spec.run_id,
    mode: spec.mode,
    run_dir: relRunDir,
    target: spec.target,
    harness_hint: spec.harness_hint,
    goal: spec.goal,
    sessions: spec.sessions,
    output_policy: spec.output_policy,
    expected_artifacts: [
      "artifact-contracts.json",
      "autonomous-status.md",
      "sources-index.json",
      "harness-profile.json",
      "skills-profile.json",
      "commands-profile.json",
      "workflow-patterns.json",
      "team-candidates.json",
      "factory-candidates.json",
      "validation.json",
      "oracle-review.json",
    ],
    team: {
      id: "harness-intake-team",
      entry_agent: "harness-intake-orchestrator",
      agents: HARNESS_INTAKE_AGENTS.map((agent) => agent.id),
    },
  };
  writeJson(join(runDir, "manifest.json"), manifest);
  writeJson(join(runDir, "agentic-plan.json"), buildAgenticPlan(spec, relRunDir));
  writeJson(join(runDir, "artifact-contracts.json"), buildArtifactContracts(spec, relRunDir));
  writeText(join(runDir, "autonomous-status.md"), renderAutonomousStatus(spec, relRunDir));
  writeJson(join(runDir, "status.json"), {
    schema: `${SCHEMA_PREFIX}.status.v1`,
    run_id: spec.run_id,
    status: "initialized",
    no_ship: false,
    phase: "init",
    run_dir: relRunDir,
    updated_at: new Date().toISOString(),
  });
  renderKickoffFiles(spec, runDir);
  return { runDir, manifest };
}

export function buildArtifactContracts(spec, relRunDir) {
  return {
    schema: `${SCHEMA_PREFIX}.artifact-contracts.v1`,
    run_id: spec.run_id,
    run_dir: relRunDir,
    room: "harness-intake-control",
    entry_agent: "harness-intake-orchestrator",
    startup_file_delivery_required: true,
    raw_prompt_transport_line_by_line: false,
    post_start_tmux_paste_disabled: true,
    contracts: HARNESS_INTAKE_AGENTS.map((agent) => ({
      agent: agent.id,
      alias: agent.alias,
      lane: agent.lane,
      role: agent.role,
      outputs: agent.outputFiles,
      done_when: agent.doneWhen,
      requires_authorization: agent.requiresAuthorization || null,
    })),
    final_gate: {
      validation_ref: "validation.json",
      oracle_review_ref: "oracle-review.json",
      done_sentinel_ref: "DONE.sentinel",
      completion_requires: [
        "validation.json status=pass",
        "oracle-review.json verdict PASS or WARN with no no-ship blockers",
        "generated proposals remain quarantine-only",
        "tmux kickoff-dispatch, when present, proves startup file delivery and no line-by-line prompt paste",
      ],
    },
  };
}

export function renderAutonomousStatus(spec, relRunDir) {
  return `# Harness Intake Autonomous Status

Run id: ${spec.run_id}
Run dir: ${relRunDir}
Status: initialized
No-ship: false
Target: ${spec.target.input}
Harness hint: ${spec.harness_hint}
Sessions: ${spec.sessions.authorized ? "authorized" : spec.sessions.mentioned ? "mentioned but not authorized" : "not requested"}

## Lanes

${HARNESS_INTAKE_AGENTS.map((agent) => `- ${agent.id} (${agent.lane}): planned; outputs: ${agent.outputFiles.join(", ")}`).join("\n")}

## Gates

- Source project remains read-only.
- Sessions require explicit authorization.
- Generated teams/factories stay in generated-proposals/.
- Tmux launch is startup/visibility only, not completion.
`;
}

export function buildAgenticPlan(spec, relRunDir) {
  return {
    schema: `${SCHEMA_PREFIX}.agentic-plan.v1`,
    run_id: spec.run_id,
    run_dir: relRunDir,
    control_plane: "natural-language-launcher-plus-supervised-agent-team",
    deterministic_tools: ["scan-sources", "validate-run", "tmux-launch"],
    stages: [
      "infer_run_spec",
      "source_cartography",
      "harness_interpretation",
      "skill_command_analysis",
      "session_mining_if_authorized",
      "workflow_pattern_mining",
      "team_candidate_generation",
      "factory_candidate_generation",
      "oracle_validation",
    ],
    quarantine_only: true,
    activation_enabled: false,
    tmux_optional: true,
  };
}

export const HARNESS_INTAKE_AGENTS = [
  {
    id: "harness-intake-orchestrator",
    alias: "intake_chief",
    lane: "control",
    role: "Coordinate the full harness intake run and consolidate evidence.",
    outputFiles: ["run-summary.md", "oracle-review.json"],
    doneWhen: ["All required run artifacts exist or blockers are explicit.", "Validation/oracle posture is recorded."],
  },
  {
    id: "harness-source-cartographer",
    alias: "source_cartographer",
    lane: "source",
    role: "Map allowed setup sources and risk posture.",
    outputFiles: ["sources-index.json", "source-risk-report.json"],
    doneWhen: ["Source index exists.", "Forbidden/skipped paths and source risks are recorded."],
  },
  {
    id: "harness-interpreter",
    alias: "harness_interpreter",
    lane: "harness",
    role: "Interpret the external harness model and conventions.",
    outputFiles: ["harness-profile.json"],
    doneWhen: ["Harness model, conventions, unknowns, and ZOB mappings are evidence-backed."],
  },
  {
    id: "harness-skill-command-analyst",
    alias: "skill_command_analyst",
    lane: "skills",
    role: "Analyze skills, commands, prompts, and hooks.",
    outputFiles: ["skills-profile.json", "commands-profile.json", "prompt-patterns.json"],
    doneWhen: ["Skills/commands/prompts are mapped to possible ZOB roles, workflow steps, or validators."],
  },
  {
    id: "harness-session-miner",
    alias: "session_miner",
    lane: "sessions",
    role: "Mine authorized sessions without persisting raw conversation bodies.",
    outputFiles: ["sessions-analysis.json", "session-evidence-index.json"],
    doneWhen: ["Sessions are analyzed only when authorized, or a skip reason is recorded."],
    requiresAuthorization: "sessions.authorized=true",
  },
  {
    id: "harness-workflow-pattern-miner",
    alias: "workflow_miner",
    lane: "patterns",
    role: "Detect reusable workflow patterns from static and behavioral evidence.",
    outputFiles: ["workflow-patterns.json", "workflow-patterns.md"],
    doneWhen: ["Workflow patterns include confidence, candidate flags, and evidence refs."],
  },
  {
    id: "zob-team-architect",
    alias: "team_architect",
    lane: "teams",
    role: "Generate ZOB team candidates in quarantine.",
    outputFiles: ["team-candidates.json", "generated-proposals/teams", "generated-proposals/agents", "generated-proposals/kickoff"],
    doneWhen: ["Team candidates remain quarantine-only and include activation blockers."],
  },
  {
    id: "harness-factory-designer",
    alias: "factory_designer",
    lane: "factories",
    role: "Generate factory candidates and activation blockers.",
    outputFiles: ["factory-candidates.json", "generated-proposals/factories"],
    doneWhen: ["Factory candidates define input contract, validators, smoke posture, and activation blockers."],
  },
  {
    id: "harness-intake-oracle",
    alias: "intake_oracle",
    lane: "oracle",
    role: "Validate evidence, privacy, quarantine posture, and no-ship status.",
    outputFiles: ["validation.json", "oracle-review.json", "DONE.sentinel"],
    doneWhen: ["Validation passes or no-ship blockers are explicit.", "Tmux launch is not treated as completion."],
  },
];

export function renderKickoffFiles(spec, runDir) {
  for (const agent of HARNESS_INTAKE_AGENTS) {
    const isChief = agent.id === "harness-intake-orchestrator";
    const artifactRefs = {
      manifest: repoRel(join(runDir, "manifest.json")),
      runSpec: repoRel(join(runDir, "inferred-run-spec.json")),
      artifactContracts: repoRel(join(runDir, "artifact-contracts.json")),
      status: repoRel(join(runDir, "autonomous-status.md")),
      generatedProposals: repoRel(join(runDir, "generated-proposals")),
    };
    const body = `# Harness Intake Kickoff — ${agent.id}

Run id: ${spec.run_id}
Target: ${spec.target.input}
Harness hint: ${spec.harness_hint}
Lane: ${agent.lane}
Alias: @${agent.alias}
Run manifest: ${artifactRefs.manifest}
Run spec: ${artifactRefs.runSpec}
Artifact contracts: ${artifactRefs.artifactContracts}
Status: ${artifactRefs.status}
Generated proposals: ${artifactRefs.generatedProposals}

This startup file is the complete task contract. It is passed as \`pi @<kickoff-file>\`; tmux must not paste this prompt line-by-line.

## READY handshake — first action

If live peer messaging is available, send a short READY/STATUS_UPDATE to @intake_chief. If not, write your status to the run status/artifact lane and continue.

\`\`\`text
READY
agent: ${agent.id}
run_id: ${spec.run_id}
lane: ${agent.lane}
owned_outputs:
${agent.outputFiles.map((file) => `- ${file}`).join("\n")}
blockers: none|...
\`\`\`

## TASK

${agent.role}
${isChief ? "Coordinate the full run, keep artifacts canonical, and make sure blocked lanes are visible." : "Read upstream run artifacts and produce/validate your owned slice only."}

## EXPECTED OUTCOME

Owned outputs are present, evidence-backed, and safe for downstream team/factory proposal review.

## MUST DO

- Read the run manifest, run spec, artifact contracts, and status before conclusions.
- Keep source project reads bounded and read-only.
- Cite artifact/source refs for every important claim.
- Keep generated content under the run directory, especially generated-proposals/.
- Mark blockers instead of inventing missing evidence.
${agent.requiresAuthorization ? "- Verify sessions.authorized=true before reading any sessions. If not authorized, record skip/blocker only." : "- Treat session artifacts as unavailable unless authorization is recorded."}

## MUST NOT

- Do not read secrets, credentials, env files, keys, SSH/AWS config, vendor folders, or build artifacts.
- Do not mutate the source project.
- Do not persist raw session bodies in generated prompts or proposals.
- Do not activate generated teams/factories automatically.
- Do not treat tmux launch as completion.

## OUTPUT FILES

${agent.outputFiles.map((file) => `- ${file}`).join("\n")}

## DONE WHEN

${agent.doneWhen.map((item) => `- ${item}`).join("\n")}

## Final claim shape

\`\`\`text
ARTIFACT_READY
agent: ${agent.id}
run_id: ${spec.run_id}
outputs:
- <path>
validation:
- <command or artifact check>
blockers: none|...
needs_review: yes/no
\`\`\`
`;
    writeText(join(runDir, "kickoff", `${agent.id}-kickoff.md`), body);
  }
}
