import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const FACTORY_NAME = "harness-intake-agent-team";
export const RUNS_ROOT = "reports/factory-runs";
export const SCHEMA_PREFIX = "zob.harness-intake";
export const repoRoot = process.cwd();

export const DEFAULT_FORBIDDEN = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ed25519",
  "secrets",
  "secret",
  "credentials",
  "tokens",
  ".ssh",
  ".aws",
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "out",
];

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
  ".mjs",
  ".js",
  ".cjs",
  ".ts",
  ".tsx",
  ".sh",
  ".zsh",
  ".fish",
  ".py",
  ".log",
]);

const MAX_FILE_BYTES = 320 * 1024;
const MAX_SCAN_FILES = 1200;
const MAX_SESSION_FILES = 200;

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    const rawValue = eq === -1 ? undefined : arg.slice(eq + 1);
    if (["allow-sessions", "demo", "self", "prepare-only", "help", "allow-repo-root", "write"].includes(key)) {
      out[toCamel(key)] = true;
      continue;
    }
    const value = rawValue ?? argv[++i];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    const camel = toCamel(key);
    if (["sessionPath", "source", "allowedFile"].includes(camel)) {
      out[camel] = [...(out[camel] ?? []), value];
    } else {
      out[camel] = value;
    }
  }
  return out;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace(/[TZ]/g, "-").replace(/-$/u, "").toLowerCase();
}

export function safeRunId(value) {
  const cleaned = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.length > 120) throw new Error(`invalid run id: ${value}`);
  return cleaned;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeText(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, value, "utf8");
}

export function runDirFor(runId) {
  return join(RUNS_ROOT, safeRunId(runId));
}

export function resolveRunDir(runIdOrDir) {
  if (!runIdOrDir) throw new Error("missing run id or run dir");
  const candidate = String(runIdOrDir);
  const maybeDir = candidate.includes("/") ? candidate : runDirFor(candidate);
  const resolved = resolve(repoRoot, maybeDir);
  const rel = relative(repoRoot, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("run dir must stay inside repo");
  return resolved;
}

export function repoRel(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

export function inferRunSpecFromRequest(request, opts = {}) {
  const rawRequest = String(request || opts.request || "").trim();
  if (!rawRequest && !opts.demo && !opts.self && !opts.target && !opts.path) {
    throw new Error("missing natural-language request or --target/--path");
  }

  const runId = safeRunId(opts.runId || `harness-intake-${timestamp()}`);
  const targetInput = opts.target || opts.path || (opts.demo ? "examples/agent-factory-tmux-comms" : opts.self ? "." : extractPathLike(rawRequest));
  if (!targetInput) throw new Error("could not infer target path; pass --target <path> or mention a path in the request");
  const target = resolveTargetPath(targetInput, { allowRepoRoot: Boolean(opts.allowRepoRoot || opts.self) });
  const requestLower = rawRequest.toLowerCase();
  const harnessHint = opts.harness || inferHarnessHint(rawRequest, targetInput);
  const sessionMentioned = /\b(session|sessions|conversation|conversations|transcript|transcripts|history)\b/i.test(rawRequest) || opts.sessionPath?.length > 0;
  const explicitAllowSessions = Boolean(
    opts.allowSessions ||
      ["yes", "true", "allow", "allowed", "authorized"].includes(String(opts.sessions || "").toLowerCase()) ||
      /\b(you may read|authorized sessions?|allow sessions|read sessions)\b/i.test(rawRequest)
  );
  const sessionMode = explicitAllowSessions ? "authorized" : sessionMentioned ? "needs_authorization" : "disabled";
  const sessionPaths = explicitAllowSessions ? resolveSessionPaths(target, opts.sessionPath ?? []) : [];
  const goal = inferGoal(rawRequest);
  const mode = opts.mode || inferMode(rawRequest);
  const createdAt = new Date().toISOString();
  return {
    schema: `${SCHEMA_PREFIX}.inferred-run-spec.v1`,
    run_id: runId,
    created_at: createdAt,
    request: rawRequest || `Analyze ${targetInput}`,
    request_hash: sha256(rawRequest || `Analyze ${targetInput}`),
    target: {
      input: targetInput,
      path: target,
      repo_relative: isInside(repoRoot, target) ? repoRel(target) : null,
      broad_root_allowed: Boolean(opts.allowRepoRoot || opts.self),
    },
    harness_hint: harnessHint,
    mode,
    goal,
    sessions: {
      mentioned: sessionMentioned,
      mode: sessionMode,
      authorized: explicitAllowSessions,
      authorization_source: explicitAllowSessions ? (opts.allowSessions ? "flag" : "natural_request") : null,
      paths: sessionPaths,
      skipped_reason: sessionMentioned && !explicitAllowSessions ? "session analysis requires explicit authorization; rerun with --allow-sessions or say that sessions are authorized" : null,
    },
    output_policy: {
      quarantine_only: true,
      activation_enabled: false,
      raw_session_body_persisted: false,
      source_project_modified: false,
    },
    safety: {
      forbidden_patterns: DEFAULT_FORBIDDEN,
      max_file_bytes: MAX_FILE_BYTES,
      max_scan_files: MAX_SCAN_FILES,
      max_session_files: MAX_SESSION_FILES,
    },
  };
}

function inferMode(request) {
  const lower = request.toLowerCase();
  if (/\bbatch\b/.test(lower)) return "batch";
  if (/\bpilot\b/.test(lower)) return "pilot";
  if (/\bdeep|complete|xhigh|max\b/.test(lower)) return "smoke-deep";
  return "smoke";
}

function inferGoal(request) {
  const lower = request.toLowerCase();
  if (/factory|factories|factor/i.test(lower)) return "propose-zob-team-and-factory";
  if (/team|agents? team/i.test(lower)) return "propose-zob-team";
  return "analyze-harness";
}

function inferHarnessHint(request, targetInput) {
  const value = `${request} ${targetInput}`.toLowerCase();
  if (value.includes("claude")) return "claude-code";
  if (value.includes("codex")) return "codex";
  if (value.includes("cursor")) return "cursor";
  if (value.includes("aider")) return "aider";
  if (value.includes("pi") || value.includes("zob")) return "pi-zob";
  return "unknown";
}

function extractPathLike(request) {
  const tokens = String(request || "").match(/(?:\.\.?|~|\/)?[A-Za-z0-9_./@:-]+/g) ?? [];
  const stop = new Set(["analyze", "setup", "claude", "codex", "cursor", "aider", "team", "factory", "sessions", "project"]);
  for (const token of tokens) {
    if (stop.has(token.toLowerCase())) continue;
    if (token.includes("/") || token.startsWith(".") || token.startsWith("~")) return token.replace(/[,.]$/u, "");
  }
  return null;
}

function resolveTargetPath(input, opts = {}) {
  const expanded = String(input).startsWith("~/") ? join(process.env.HOME || "", String(input).slice(2)) : String(input);
  const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(repoRoot, expanded);
  if (!existsSync(resolved)) throw new Error(`target path does not exist: ${input}`);
  const stat = statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`target must be a directory: ${input}`);
  const forbiddenBroad = new Set(["/", "/home", "/Users"]);
  if (forbiddenBroad.has(resolved)) throw new Error(`refusing broad target path: ${resolved}`);
  if (!opts.allowRepoRoot && resolved === repoRoot) throw new Error("refusing repo root target without --self or --allow-repo-root");
  return resolved;
}

function resolveSessionPaths(target, explicitPaths) {
  const candidates = explicitPaths.length ? explicitPaths : [".claude/sessions", ".codex/sessions", ".cursor/sessions", "sessions", "transcripts", ".sessions"];
  const out = [];
  for (const candidate of candidates) {
    const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(target, candidate);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) out.push(resolved);
  }
  return [...new Set(out)];
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

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

function buildArtifactContracts(spec, relRunDir) {
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

function renderAutonomousStatus(spec, relRunDir) {
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

function buildAgenticPlan(spec, relRunDir) {
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

export function scanSources(spec) {
  const targetRoot = spec.target.path;
  const files = [];
  const skipped = [];
  const startedAt = new Date().toISOString();
  walkRelevant(targetRoot, spec, files, skipped);
  const limited = files.slice(0, MAX_SCAN_FILES);
  if (files.length > limited.length) skipped.push({ path: "<scan-limit>", reason: `max_scan_files>${MAX_SCAN_FILES}`, omitted_count: files.length - limited.length });
  const sources = limited.map((file, index) => inspectSourceFile(targetRoot, file, index, spec));
  const harnesses = summarizeHarnesses(sources, spec.harness_hint);
  return {
    schema: `${SCHEMA_PREFIX}.sources-index.v1`,
    run_id: spec.run_id,
    target: spec.target,
    scanned_at: startedAt,
    source_project_modified: false,
    raw_secret_storage: false,
    session_authorized: spec.sessions.authorized,
    source_count: sources.length,
    sources,
    harnesses,
    skipped,
  };
}

function walkRelevant(root, spec, files, skipped) {
  function visit(dir, depth) {
    if (files.length >= MAX_SCAN_FILES * 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: safeRel(root, dir), reason: `read_error:${error.message}` });
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relPath = safeRel(root, full);
      const forbidden = pathForbidden(relPath, DEFAULT_FORBIDDEN);
      if (forbidden) {
        skipped.push({ path: relPath, reason: `forbidden:${forbidden}`, directory: entry.isDirectory() });
        continue;
      }
      if (entry.isDirectory()) {
        if (!isRelevantDirectory(relPath, spec) && depth > 1) {
          skipped.push({ path: relPath, reason: "not_harness_relevant_directory", directory: true });
          continue;
        }
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: relPath, reason: "not_regular_file" });
        continue;
      }
      if (!isRelevantFile(relPath, spec)) {
        skipped.push({ path: relPath, reason: "not_harness_relevant_file" });
        continue;
      }
      const size = statSync(full).size;
      if (size > MAX_FILE_BYTES) {
        skipped.push({ path: relPath, reason: `too_large>${MAX_FILE_BYTES}` });
        continue;
      }
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) && !isExtensionlessRelevant(relPath)) {
        skipped.push({ path: relPath, reason: "unsupported_extension" });
        continue;
      }
      files.push({ full, relPath, size });
    }
  }
  visit(root, 0);
}

function safeRel(root, full) {
  const rel = relative(root, full).split(sep).join("/");
  return rel || ".";
}

function isRelevantDirectory(relPath, spec) {
  const normalized = relPath.toLowerCase();
  if (normalized === ".") return true;
  if (isSessionLikePath(normalized) && !spec.sessions.authorized) return false;
  if (normalized.startsWith(".claude") || normalized.startsWith(".codex") || normalized.startsWith(".cursor")) return true;
  if (normalized.startsWith(".pi/agents") || normalized.startsWith(".pi/zagents") || normalized.startsWith(".pi/skills") || normalized.startsWith(".pi/prompts") || normalized.startsWith(".pi/teams") || normalized.startsWith(".pi/zteams") || normalized.startsWith(".pi/factories")) return true;
  if (/^(docs?|prompts?|skills?|commands?|agents?|scripts?|workflows?|hooks?)(\/|$)/.test(normalized)) return true;
  if (spec.sessions.authorized && /(^|\/)(sessions?|transcripts?|conversation-history)(\/|$)/.test(normalized)) return true;
  return false;
}

function isRelevantFile(relPath, spec) {
  const normalized = relPath.toLowerCase();
  const base = basename(normalized);
  if (isSessionLikePath(normalized) && !spec.sessions.authorized) return false;
  if (["agents.md", "claude.md", "codex.md", "gemini.md", "readme.md", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".aider.conf.yml", ".aider.conf.yaml", ".aider.model.settings.yml"].includes(base)) return true;
  if (/\.(team|factory)\.json$/.test(normalized)) return true;
  if (/(kickoff|prompt|agent|team|factory|tmux|workflow|command|skill).*(\.template)?\.(md|json|ya?ml|toml|sh|mjs|js|ts)$/.test(normalized)) return true;
  if (normalized.startsWith(".claude/") || normalized.startsWith(".codex/") || normalized.startsWith(".cursor/")) return true;
  if (normalized.startsWith(".pi/agents/") || normalized.startsWith(".pi/zagents/") || normalized.startsWith(".pi/skills/") || normalized.startsWith(".pi/prompts/") || normalized.startsWith(".pi/teams/") || normalized.startsWith(".pi/zteams/") || normalized.startsWith(".pi/factories/")) return true;
  if (/^(docs?|prompts?|skills?|commands?|agents?|scripts?|workflows?|hooks?)(\/|$)/.test(normalized)) return true;
  if (spec.sessions.authorized && /(^|\/)(sessions?|transcripts?|conversation-history)(\/|$)/.test(normalized)) return true;
  return false;
}

function isSessionLikePath(normalizedRelPath) {
  return /(^|\/)(sessions?|transcripts?|conversation-history|conversation_history|chat-history|chat_history)(\/|$)/.test(normalizedRelPath);
}

function isExtensionlessRelevant(relPath) {
  return ["agents", "claude", "codex", "readme"].includes(basename(relPath).toLowerCase());
}

function pathForbidden(relPath, forbiddenPatterns) {
  const normalized = relPath.split(sep).join("/");
  const segments = normalized.split("/").filter(Boolean);
  for (const pattern of forbiddenPatterns) {
    const clean = String(pattern).replace(/\\/g, "/").replace(/\/$/, "");
    if (!clean) continue;
    if (clean.includes("/")) {
      if (normalized === clean || normalized.startsWith(`${clean}/`)) return clean;
      continue;
    }
    for (const segment of segments) {
      if (segmentMatches(segment, clean)) return clean;
    }
  }
  return null;
}

function segmentMatches(segment, pattern) {
  if (pattern.startsWith("*")) return segment.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return segment.startsWith(pattern.slice(0, -1));
  return segment === pattern;
}

function inspectSourceFile(root, file, index, spec) {
  const text = safeRead(file.full);
  const lines = text.split(/\r?\n/u);
  const sourceId = `S-${String(index + 1).padStart(4, "0")}`;
  const type = classifySource(file.relPath, spec);
  const harness = detectHarness(file.relPath, text, spec.harness_hint);
  const signals = extractSignals(file.relPath, lines);
  const secretLike = detectSecretLike(file.relPath, text);
  return {
    source_id: sourceId,
    path: file.relPath,
    absolute_path_hash: sha256(file.full),
    type,
    harness,
    size_bytes: file.size,
    lines: lines.length,
    content_hash: sha256(text),
    contains_possible_secret: secretLike.length > 0,
    secret_like_reasons: secretLike,
    citations: signals.slice(0, 12),
    used_for: usageForType(type),
  };
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function classifySource(relPath, spec) {
  const lower = relPath.toLowerCase();
  const base = basename(lower);
  if (spec.sessions.authorized && /(^|\/)(sessions?|transcripts?|conversation-history)(\/|$)/.test(lower)) return "session";
  if (lower.startsWith(".pi/zagents/prompts/") || lower.includes("/zagents/prompts/")) return "zagent-prompt";
  if (lower.startsWith(".pi/zagents/") || lower.includes("/zagents/")) return "zagent";
  if ((lower.startsWith(".pi/zteams/") || lower.includes("/zteams/")) && lower.endsWith(".tmux.sh")) return "zteam-launcher";
  if ((lower.startsWith(".pi/zteams/") || lower.includes("/zteams/")) && /runtime\.(mjs|js|ts)$/.test(lower)) return "zteam-runtime";
  if (lower.startsWith(".pi/zteams/") || lower.includes("/zteams/")) return "zteam";
  if (base === "agents.md" || lower.includes("/agents/") || lower.startsWith(".pi/agents/")) return "agent-definition";
  if (base === "claude.md" || base === "codex.md" || base === "gemini.md") return "harness-instructions";
  if (lower.includes("/skills/") || lower.startsWith(".pi/skills/")) return "skill";
  if (lower.includes("/commands/") || lower.includes("/hooks/")) return "command";
  if (lower.includes("/prompts/") || lower.includes("prompt")) return "prompt";
  if (lower.includes("/teams/") || lower.endsWith(".team.json") || lower.includes("team")) return "team";
  if (lower.includes("/factories/") || base === "factory.json" || lower.includes("factory")) return "factory";
  if (base === "package.json") return "package-manifest";
  if (lower.startsWith("scripts/") || lower.includes("/scripts/")) return "script";
  if (lower.startsWith("docs/") || lower.includes("/docs/") || base === "readme.md") return "documentation";
  return "config";
}

function detectHarness(relPath, text, hint) {
  const lower = `${relPath}\n${text.slice(0, 5000)}`.toLowerCase();
  if (lower.includes("claude") || relPath.toLowerCase().startsWith(".claude/")) return "claude-code";
  if (lower.includes("codex") || relPath.toLowerCase().startsWith(".codex/")) return "codex";
  if (lower.includes("cursor") || relPath.toLowerCase().startsWith(".cursor/")) return "cursor";
  if (lower.includes("aider")) return "aider";
  if (lower.includes("zob") || lower.includes(" pi ") || relPath.toLowerCase().startsWith(".pi/")) return "pi-zob";
  return hint || "unknown";
}

function extractSignals(relPath, lines) {
  const patterns = [
    ["agent", /\bagents?\b|\bsub-?agents?\b|\bworker\b|\borchestrator\b/i],
    ["skill", /\bskills?\b|\bcapabilit(y|ies)\b/i],
    ["command", /\bcommands?\b|slash command|\/\w+/i],
    ["tool", /\btools?\b|read|write|edit|bash|grep|find/i],
    ["session", /\bsessions?\b|conversation|transcript|history/i],
    ["workflow", /\bworkflow\b|\bplan\b|\bimplement\b|\breview\b|\boracle\b|validate/i],
    ["factory", /\bfactory\b|factories|batch|smoke|pilot/i],
    ["safety", /secret|credential|token|forbidden|must not|never|safety|no-ship/i],
  ];
  const citations = [];
  lines.forEach((line, index) => {
    for (const [kind, pattern] of patterns) {
      if (pattern.test(line)) citations.push({ kind, ref: `${relPath}:L${index + 1}` });
    }
  });
  return citations.slice(0, 48);
}

function detectSecretLike(relPath, text) {
  const reasons = [];
  if (pathForbidden(relPath, DEFAULT_FORBIDDEN)) reasons.push("secret_like_path");
  const probes = [
    [/AKIA[0-9A-Z]{16}/, "aws_access_key_like"],
    [/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/, "private_key_like"],
    [/(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}/i, "credential_assignment_like"],
  ];
  for (const [pattern, reason] of probes) {
    if (pattern.test(text)) reasons.push(reason);
  }
  return [...new Set(reasons)];
}

function usageForType(type) {
  const map = {
    "agent-definition": ["harness-profile", "team-candidates"],
    zagent: ["harness-profile", "team-candidates"],
    "zagent-prompt": ["prompt-patterns", "team-candidates"],
    zteam: ["team-candidates", "harness-profile"],
    "zteam-launcher": ["commands-profile", "factory-candidates"],
    "zteam-runtime": ["commands-profile", "factory-candidates", "workflow-patterns"],
    "harness-instructions": ["harness-profile", "workflow-patterns"],
    skill: ["skills-profile", "team-candidates"],
    command: ["commands-profile", "workflow-patterns"],
    prompt: ["prompt-patterns", "team-candidates"],
    session: ["sessions-analysis", "workflow-patterns"],
    team: ["team-candidates"],
    factory: ["factory-candidates"],
    "package-manifest": ["commands-profile"],
    script: ["commands-profile", "factory-candidates"],
    documentation: ["harness-profile", "workflow-patterns"],
    config: ["harness-profile"],
  };
  return map[type] ?? ["harness-profile"];
}

function summarizeHarnesses(sources, hint) {
  const counts = new Map();
  for (const source of sources) counts.set(source.harness, (counts.get(source.harness) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count, hint_match: name === hint }));
}

export function buildProfiles(spec, sourcesIndex) {
  const sources = sourcesIndex.sources ?? [];
  const harnessProfile = buildHarnessProfile(spec, sources);
  const skillsProfile = buildSkillsProfile(spec, sources);
  const commandsProfile = buildCommandsProfile(spec, sources);
  const promptPatterns = buildPromptPatterns(spec, sources);
  const sessionArtifacts = buildSessionArtifacts(spec, sources);
  const workflowPatterns = buildWorkflowPatterns(spec, harnessProfile, skillsProfile, commandsProfile, sessionArtifacts.sessionsAnalysis);
  const teamCandidates = buildTeamCandidates(spec, workflowPatterns, sources);
  const factoryCandidates = buildFactoryCandidates(spec, teamCandidates, workflowPatterns);
  return { harnessProfile, skillsProfile, commandsProfile, promptPatterns, ...sessionArtifacts, workflowPatterns, teamCandidates, factoryCandidates };
}

function evidenceFor(sources, predicate, limit = 12) {
  return sources.filter(predicate).flatMap((source) => source.citations.map((citation) => citation.ref)).slice(0, limit);
}

function buildHarnessProfile(spec, sources) {
  const harnessCounts = summarizeHarnesses(sources, spec.harness_hint);
  const sourceTypes = countBy(sources, (source) => source.type);
  const safetyRefs = evidenceFor(sources, (source) => source.citations.some((citation) => citation.kind === "safety"));
  return {
    schema: `${SCHEMA_PREFIX}.harness-profile.v1`,
    run_id: spec.run_id,
    harness_hint: spec.harness_hint,
    detected_harnesses: harnessCounts,
    primary_harness: harnessCounts[0]?.name ?? spec.harness_hint,
    source_types: sourceTypes,
    agent_definition_count: countType(sources, "agent-definition"),
    zagent_count: countType(sources, "zagent"),
    zagent_prompt_count: countType(sources, "zagent-prompt"),
    zteam_count: countType(sources, "zteam"),
    zteam_launcher_count: countType(sources, "zteam-launcher"),
    zteam_runtime_count: countType(sources, "zteam-runtime"),
    skill_count: countType(sources, "skill"),
    command_count: countType(sources, "command") + countType(sources, "package-manifest"),
    prompt_count: countType(sources, "prompt"),
    session_source_count: countType(sources, "session"),
    conventions: inferConventions(sources),
    setup_steps: inferSetupSteps(sources),
    safety_rules: safetyRefs.map((ref) => ({ ref, rule: "safety/secret/no-ship signal observed" })),
    confidence: confidenceFromSignals(sources.length, harnessCounts[0]?.count ?? 0),
    evidence_refs: evidenceFor(sources, () => true, 24),
    unknowns: buildUnknowns(spec, sources),
  };
}

function inferConventions(sources) {
  const paths = sources.map((source) => source.path.toLowerCase());
  const conventions = [];
  if (paths.some((path) => path === "claude.md" || path.endsWith("/claude.md"))) conventions.push("CLAUDE.md root/local instruction file");
  if (paths.some((path) => path.startsWith(".claude/agents/"))) conventions.push("Claude Code agent definitions under .claude/agents");
  if (paths.some((path) => path.startsWith(".claude/commands/"))) conventions.push("Claude Code slash commands under .claude/commands");
  if (paths.some((path) => path.startsWith(".cursor/"))) conventions.push("Cursor rules/configuration under .cursor");
  if (paths.some((path) => path.startsWith(".codex/"))) conventions.push("Codex configuration under .codex");
  if (paths.some((path) => path.startsWith(".pi/"))) conventions.push("Pi/ZOB project-local agents, skills, teams or factories");
  if (paths.some((path) => path.startsWith(".pi/zagents/"))) conventions.push("Full-session ZAgent definitions under .pi/zagents");
  if (paths.some((path) => path.startsWith(".pi/zteams/"))) conventions.push("ZTeam manifests, tmux launchers, and runtime scripts under .pi/zteams");
  if (paths.some((path) => path.includes("skills/"))) conventions.push("Skill-oriented behavior instructions");
  if (paths.some((path) => path.includes("commands/"))) conventions.push("Command-oriented reusable workflows");
  return conventions;
}

function inferSetupSteps(sources) {
  return sources
    .filter((source) => ["documentation", "harness-instructions", "package-manifest", "script"].includes(source.type))
    .slice(0, 20)
    .map((source) => ({ source_id: source.source_id, path: source.path, inferred_step: `review ${source.type} for setup/use instructions` }));
}

function buildUnknowns(spec, sources) {
  const unknowns = [];
  if (!sources.length) unknowns.push("No harness-relevant sources were found.");
  if (spec.sessions.mentioned && !spec.sessions.authorized) unknowns.push("Sessions were mentioned but not authorized, so real behavioral usage was not mined.");
  if (!sources.some((source) => source.type === "skill")) unknowns.push("No explicit skill files were found.");
  if (!sources.some((source) => source.type === "command" || source.type === "package-manifest")) unknowns.push("No explicit command/package command files were found.");
  return unknowns;
}

function buildSkillsProfile(spec, sources) {
  const skillSources = sources.filter((source) => ["skill", "agent-definition", "zagent", "zagent-prompt", "harness-instructions"].includes(source.type));
  return {
    schema: `${SCHEMA_PREFIX}.skills-profile.v1`,
    run_id: spec.run_id,
    skill_count: skillSources.filter((source) => source.type === "skill").length,
    role_definition_count: skillSources.filter((source) => source.type === "agent-definition" || source.type === "zagent").length,
    skills: skillSources.map((source) => ({
      source_id: source.source_id,
      name: inferNameFromPath(source.path),
      path: source.path,
      type: source.type,
      harness: source.harness,
      trigger_evidence_refs: source.citations.filter((citation) => ["skill", "workflow", "tool"].includes(citation.kind)).map((citation) => citation.ref).slice(0, 8),
      possible_zob_mapping: possibleMappingForSource(source),
      confidence: source.citations.length ? 0.72 : 0.45,
    })),
    evidence_refs: evidenceFor(skillSources, () => true, 24),
  };
}

function buildCommandsProfile(spec, sources) {
  const commandSources = sources.filter((source) => ["command", "package-manifest", "script"].includes(source.type));
  const packageScripts = [];
  for (const source of sources.filter((entry) => entry.type === "package-manifest")) {
    const full = resolve(spec.target.path, source.path);
    try {
      const parsed = JSON.parse(readFileSync(full, "utf8"));
      for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
        packageScripts.push({ name, command_hash: sha256(String(command)), source_ref: `${source.path}:scripts.${name}` });
      }
    } catch {
      // ignore invalid package manifests; validation can flag separately if needed
    }
  }
  return {
    schema: `${SCHEMA_PREFIX}.commands-profile.v1`,
    run_id: spec.run_id,
    command_source_count: commandSources.length,
    package_scripts: packageScripts,
    commands: commandSources.map((source) => ({
      source_id: source.source_id,
      name: inferNameFromPath(source.path),
      path: source.path,
      type: source.type,
      harness: source.harness,
      evidence_refs: source.citations.filter((citation) => ["command", "workflow", "tool"].includes(citation.kind)).map((citation) => citation.ref).slice(0, 8),
      possible_zob_mapping: source.type === "script" ? "validator-or-launcher" : "slash-command-or-workflow-step",
    })),
  };
}

function buildPromptPatterns(spec, sources) {
  const promptSources = sources.filter((source) => ["prompt", "harness-instructions", "agent-definition"].includes(source.type));
  return {
    schema: `${SCHEMA_PREFIX}.prompt-patterns.v1`,
    run_id: spec.run_id,
    prompt_source_count: promptSources.length,
    patterns: promptSources.map((source) => ({
      source_id: source.source_id,
      path: source.path,
      pattern: inferPromptPattern(source),
      evidence_refs: source.citations.map((citation) => citation.ref).slice(0, 8),
    })),
  };
}

function buildSessionArtifacts(spec, sources) {
  if (!spec.sessions.authorized) {
    return {
      sessionsAnalysis: {
        schema: `${SCHEMA_PREFIX}.sessions-analysis.v1`,
        run_id: spec.run_id,
        status: spec.sessions.mentioned ? "skipped-needs-authorization" : "skipped-not-requested",
        raw_session_body_persisted: false,
        session_count: 0,
        findings: [],
        skipped_reason: spec.sessions.skipped_reason || "sessions not requested",
      },
      sessionEvidenceIndex: {
        schema: `${SCHEMA_PREFIX}.session-evidence-index.v1`,
        run_id: spec.run_id,
        status: "skipped",
        evidence: [],
      },
    };
  }
  const sessionSources = sources.filter((source) => source.type === "session").slice(0, MAX_SESSION_FILES);
  const evidence = [];
  const findings = [];
  for (const source of sessionSources) {
    const full = resolve(spec.target.path, source.path);
    const text = safeRead(full);
    const lines = text.split(/\r?\n/u);
    const metrics = sessionMetrics(lines);
    evidence.push({
      session_id: source.source_id,
      path: source.path,
      content_hash: source.content_hash,
      raw_body_persisted: false,
      line_count: lines.length,
      metrics,
      evidence_refs: source.citations.map((citation) => citation.ref).slice(0, 12),
    });
    for (const finding of metrics.patterns) {
      findings.push({ session_id: source.source_id, ...finding });
    }
  }
  return {
    sessionsAnalysis: {
      schema: `${SCHEMA_PREFIX}.sessions-analysis.v1`,
      run_id: spec.run_id,
      status: "analyzed",
      raw_session_body_persisted: false,
      authorization_source: spec.sessions.authorization_source,
      session_count: sessionSources.length,
      findings,
      aggregate: {
        tool_mentions: sumMetric(evidence, "tool_mentions"),
        agent_mentions: sumMetric(evidence, "agent_mentions"),
        skill_mentions: sumMetric(evidence, "skill_mentions"),
        validation_mentions: sumMetric(evidence, "validation_mentions"),
      },
    },
    sessionEvidenceIndex: {
      schema: `${SCHEMA_PREFIX}.session-evidence-index.v1`,
      run_id: spec.run_id,
      status: "indexed",
      raw_session_body_persisted: false,
      evidence,
    },
  };
}

function sessionMetrics(lines) {
  const text = lines.join("\n").toLowerCase();
  const metrics = {
    tool_mentions: countMatches(text, /\b(read|write|edit|bash|grep|find|ls|web_search|web_fetch|delegate(_agent|_task)?)\b/g),
    agent_mentions: countMatches(text, /\b(agent|subagent|worker|orchestrator|planner|implementer|oracle|reviewer)\b/g),
    skill_mentions: countMatches(text, /\bskill|skills|capability|capabilities\b/g),
    validation_mentions: countMatches(text, /\bvalidate|validation|test|oracle|review|pass|fail|no-ship\b/g),
    patterns: [],
  };
  if (/spec[\s\S]{0,300}plan[\s\S]{0,300}(implement|code)[\s\S]{0,300}(review|oracle|validate)/.test(text)) metrics.patterns.push({ pattern: "spec-plan-implement-review", confidence: 0.78 });
  if (/delegate|subagent|worker/.test(text) && /review|oracle|validate/.test(text)) metrics.patterns.push({ pattern: "delegate-then-review", confidence: 0.72 });
  if (/skill/.test(text) && /trigger|use|load|when/.test(text)) metrics.patterns.push({ pattern: "skill-triggered-workflow", confidence: 0.68 });
  return metrics;
}

function sumMetric(evidence, metric) {
  return evidence.reduce((sum, row) => sum + Number(row.metrics?.[metric] ?? 0), 0);
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function buildWorkflowPatterns(spec, harnessProfile, skillsProfile, commandsProfile, sessionsAnalysis) {
  const patterns = [];
  const staticSupport = Object.values(harnessProfile.source_types ?? {}).reduce((sum, count) => sum + Number(count || 0), 0);
  patterns.push({
    id: "harness-static-intake-to-team-proposal",
    description: "Scan harness setup files, interpret roles/skills/commands, then synthesize ZOB team proposals.",
    static_support: staticSupport > 0,
    session_support: sessionsAnalysis.status === "analyzed" && sessionsAnalysis.findings.length > 0,
    observed_count: Math.max(1, staticSupport),
    candidate_team: true,
    confidence: clamp(0.45 + Math.min(staticSupport, 8) * 0.04 + (sessionsAnalysis.status === "analyzed" ? 0.15 : 0), 0.35, 0.92),
    evidence_refs: [...(harnessProfile.evidence_refs ?? []), ...(skillsProfile.evidence_refs ?? [])].slice(0, 16),
  });
  if (skillsProfile.skill_count > 0) {
    patterns.push({
      id: "skill-to-role-or-validator-mapping",
      description: "External skills can map to ZOB role prompts, workflow steps, or validators depending on trigger and tool posture.",
      static_support: true,
      session_support: sessionsAnalysis.findings.some((finding) => finding.pattern === "skill-triggered-workflow"),
      observed_count: skillsProfile.skill_count,
      candidate_team: true,
      confidence: clamp(0.52 + Math.min(skillsProfile.skill_count, 8) * 0.04, 0.4, 0.88),
      evidence_refs: skillsProfile.evidence_refs.slice(0, 16),
    });
  }
  for (const finding of sessionsAnalysis.findings ?? []) {
    patterns.push({
      id: finding.pattern,
      description: `Session-mined behavioral pattern: ${finding.pattern}`,
      static_support: false,
      session_support: true,
      observed_count: 1,
      candidate_team: true,
      confidence: finding.confidence,
      evidence_refs: [],
    });
  }
  return {
    schema: `${SCHEMA_PREFIX}.workflow-patterns.v1`,
    run_id: spec.run_id,
    patterns,
  };
}

function buildTeamCandidates(spec, workflowPatterns, sources) {
  const bestConfidence = Math.max(...workflowPatterns.patterns.map((pattern) => pattern.confidence), 0.4);
  const includeSessionMiner = spec.sessions.authorized;
  const roles = [
    "harness-intake-orchestrator",
    "harness-source-cartographer",
    "harness-interpreter",
    "harness-skill-command-analyst",
    ...(includeSessionMiner ? ["harness-session-miner"] : []),
    "harness-workflow-pattern-miner",
    "zob-team-architect",
    "harness-factory-designer",
    "harness-intake-oracle",
  ];
  return {
    schema: `${SCHEMA_PREFIX}.team-candidates.v1`,
    run_id: spec.run_id,
    candidates: [
      {
        team_name: `${normalizeName(spec.harness_hint)}-harness-intake-team`,
        purpose: "Analyze an external agent harness and propose reusable ZOB teams/factories from cited setup and session evidence.",
        entry_agent: "harness-intake-orchestrator",
        roles,
        communication_policy: {
          parent_visible: true,
          hidden_peer_chat: false,
          goal_room_canonical: true,
        },
        expected_artifacts: ["sources-index.json", "harness-profile.json", "skills-profile.json", "workflow-patterns.json", "factory-candidates.json", "validation.json"],
        activation_status: "quarantine-only",
        confidence: bestConfidence,
        evidence_refs: evidenceFor(sources, () => true, 20),
        blockers: bestConfidence < 0.7 ? ["Low confidence: inspect sources and consider authorizing sessions or adding docs before activation."] : [],
      },
    ],
  };
}

function buildFactoryCandidates(spec, teamCandidates, workflowPatterns) {
  const team = teamCandidates.candidates[0];
  const confidence = clamp(team.confidence - 0.05, 0.3, 0.88);
  const blockers = [];
  if (confidence < 0.75) blockers.push("Factory proposal is useful but not activation-ready until confidence >= 0.75 and validators are reviewed.");
  if (!spec.sessions.authorized && spec.sessions.mentioned) blockers.push("Session mining was requested but not authorized; behavioral evidence is incomplete.");
  return {
    schema: `${SCHEMA_PREFIX}.factory-candidates.v1`,
    run_id: spec.run_id,
    candidates: [
      {
        factory_name: `${normalizeName(spec.harness_hint)}-derived-agent-team-factory`,
        purpose: "Reusable factory proposal that relaunches a harness-intake analysis team for similar external setups.",
        input_contract: "natural-language-request compiled to inferred-run-spec.v1",
        output_artifacts: ["team-candidates.json", "generated-proposals/teams", "generated-proposals/agents", "validation.json"],
        validators: ["validate-run.mjs", "validate-no-secrets", "validate-quarantine"],
        smoke_mode: true,
        pilot_mode: true,
        batch_mode: true,
        activation_status: blockers.length ? "needs-review" : "activation-review-eligible",
        confidence,
        evidence_refs: workflowPatterns.patterns.flatMap((pattern) => pattern.evidence_refs).slice(0, 20),
        blockers,
      },
    ],
  };
}

function countBy(items, fn) {
  const out = {};
  for (const item of items) {
    const key = fn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function countType(sources, type) {
  return sources.filter((source) => source.type === type).length;
}

function confidenceFromSignals(total, primary) {
  if (!total) return 0.2;
  return clamp(0.45 + Math.min(total, 20) * 0.015 + Math.min(primary, 10) * 0.02, 0.35, 0.9);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value.toFixed(3))));
}

function inferNameFromPath(path) {
  return basename(path).replace(/\.(md|json|ya?ml|toml|txt|mjs|js|ts|sh)$/i, "");
}

function normalizeName(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function possibleMappingForSource(source) {
  if (source.type === "skill") return "zob-skill-or-workflow-step";
  if (source.type === "agent-definition" || source.type === "zagent") return "zob-agent-role";
  if (source.type === "zagent-prompt") return "zob-agent-prompt";
  if (source.type === "zteam") return "zob-team-topology";
  if (source.type === "harness-instructions") return "team-global-instructions";
  return "analysis-evidence";
}

function inferPromptPattern(source) {
  if (source.type === "agent-definition" || source.type === "zagent") return "role-prompt";
  if (source.type === "zagent-prompt") return "zagent-prompt";
  if (source.type === "harness-instructions") return "global-instructions";
  if (source.type === "prompt") return "reusable-prompt-template";
  return "instruction-pattern";
}

export function writeProfileArtifacts(runDir, profiles) {
  writeJson(join(runDir, "harness-profile.json"), profiles.harnessProfile);
  writeJson(join(runDir, "skills-profile.json"), profiles.skillsProfile);
  writeJson(join(runDir, "commands-profile.json"), profiles.commandsProfile);
  writeJson(join(runDir, "prompt-patterns.json"), profiles.promptPatterns);
  writeJson(join(runDir, "sessions-analysis.json"), profiles.sessionsAnalysis);
  writeJson(join(runDir, "session-evidence-index.json"), profiles.sessionEvidenceIndex);
  writeJson(join(runDir, "workflow-patterns.json"), profiles.workflowPatterns);
  writeText(join(runDir, "workflow-patterns.md"), renderWorkflowPatternsMarkdown(profiles.workflowPatterns));
  writeJson(join(runDir, "team-candidates.json"), profiles.teamCandidates);
  writeJson(join(runDir, "factory-candidates.json"), profiles.factoryCandidates);
  renderGeneratedProposals(runDir, profiles.teamCandidates, profiles.factoryCandidates);
}

function renderWorkflowPatternsMarkdown(workflowPatterns) {
  const rows = workflowPatterns.patterns.map((pattern) => `| ${pattern.id} | ${pattern.confidence} | ${pattern.candidate_team ? "yes" : "no"} | ${pattern.description} |`).join("\n");
  return `# Workflow Patterns\n\n| Pattern | Confidence | Candidate team | Description |\n| --- | ---: | --- | --- |\n${rows}\n`;
}

function renderGeneratedProposals(runDir, teamCandidates, factoryCandidates) {
  for (const candidate of teamCandidates.candidates) {
    writeJson(join(runDir, "generated-proposals", "teams", `${candidate.team_name}.json`), {
      schema: `${SCHEMA_PREFIX}.generated-team.v1`,
      ...candidate,
      generated_by: FACTORY_NAME,
    });
    writeText(join(runDir, "generated-proposals", "kickoff", `${candidate.team_name}-kickoff.md`), renderTeamKickoff(candidate));
    for (const role of candidate.roles) {
      writeText(join(runDir, "generated-proposals", "agents", `${role}.md`), renderGeneratedAgent(role, candidate));
    }
  }
  for (const candidate of factoryCandidates.candidates) {
    const dir = join(runDir, "generated-proposals", "factories", candidate.factory_name);
    writeJson(join(dir, "factory.json"), {
      name: candidate.factory_name,
      version: "0.1.0-proposal",
      description: candidate.purpose,
      status: candidate.activation_status,
      autoPromotion: false,
      manualPromotionRequired: true,
      inputContract: candidate.input_contract,
      expectedArtifacts: candidate.output_artifacts,
      validators: candidate.validators,
      modes: { smoke: candidate.smoke_mode, pilot: candidate.pilot_mode, batch: candidate.batch_mode },
      confidence: candidate.confidence,
      evidenceRefs: candidate.evidence_refs,
      blockers: candidate.blockers,
    });
    writeText(join(dir, "README.md"), `# ${candidate.factory_name}\n\nStatus: ${candidate.activation_status}.\n\n${candidate.purpose}\n\nThis is a quarantine proposal. Do not activate without owner review, validators, and oracle PASS/no_ship=false.\n`);
  }
}

function renderTeamKickoff(candidate) {
  return `# ${candidate.team_name} Kickoff\n\nPurpose: ${candidate.purpose}\n\nEntry agent: ${candidate.entry_agent}\n\nRoles:\n${candidate.roles.map((role) => `- ${role}`).join("\n")}\n\nRules:\n- Keep all outputs under the run directory.\n- Preserve parent-visible coordination.\n- Do not activate generated artifacts automatically.\n- Cite evidence refs for each important claim.\n`;
}

function renderGeneratedAgent(role, candidate) {
  return `---\nname: ${role}\ndescription: Generated quarantine role proposal for ${candidate.team_name}. Review before activation.\ntools: read,grep,find,ls,bash\n---\nYou are ${role}, a proposed ZOB harness-intake team role.\n\nMission: support ${candidate.purpose}\n\nRules:\n- Read only approved run artifacts and approved source refs.\n- Do not read secrets.\n- Do not mutate source project files.\n- Keep conclusions evidence-backed and cite artifact refs.\n- Return blockers instead of inventing missing evidence.\n\nOutput:\n- findings\n- evidence_refs\n- risks_blockers\n- recommended_next_steps\n- deliverable_delivered: yes/no\n`;
}

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

function readJsonIfExists(path) {
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

export function launchTmux(specOrRunDir, options = {}) {
  const runDir = typeof specOrRunDir === "string" ? resolveRunDir(specOrRunDir) : resolveRunDir(specOrRunDir.run_id);
  const spec = readJson(join(runDir, "inferred-run-spec.json"));
  const sessionName = tmuxSessionName(spec.run_id);
  const agents = HARNESS_INTAKE_AGENTS.map((agent) => agent.id);
  if (options.command === "status") return tmuxStatus(sessionName, spec.run_id);
  if (options.command === "attach") return tmuxAttach(sessionName, options.agent || agents[0]);
  if (options.command === "stop") return tmuxStop(sessionName, spec.run_id);
  requireTmux();
  if (tmuxSessionExists(sessionName)) {
    return { schema: `${SCHEMA_PREFIX}.tmux-result.v1`, status: "already-running", no_ship: false, run_id: spec.run_id, session: sessionName, attach_command: `npm run harness:intake:tmux -- attach ${spec.run_id}` };
  }
  const first = agents[0];
  spawnTmux(["new-session", "-d", "-s", sessionName, "-n", first, "-c", repoRoot]);
  const panes = [];
  for (let i = 0; i < agents.length; i += 1) {
    const agent = agents[i];
    if (i !== 0) spawnTmux(["new-window", "-t", sessionName, "-n", agent, "-c", repoRoot]);
    const kickoff = join(runDir, "kickoff", `${agent}-kickoff.md`);
    const command = `cd ${shellQuote(repoRoot)} && HARNESS_INTAKE_RUN_ID=${shellQuote(spec.run_id)} ZOB_ZAGENT_ID=${shellQuote(agent)} ${process.env.PI_BIN || "pi"} @${shellQuote(kickoff)}`;
    spawnTmux(["send-keys", "-t", `${sessionName}:${agent}`, command, "C-m"]);
    panes.push({ agent, window: agent, kickoff_ref: repoRel(kickoff), command_hash: sha256(command) });
  }
  const dispatch = {
    schema: `${SCHEMA_PREFIX}.kickoff-dispatch.v1`,
    run_id: spec.run_id,
    session: sessionName,
    panes,
    launched_at: new Date().toISOString(),
    launch_is_not_completion: true,
    startup_file_delivery: true,
    worker_startup_file_delivery: true,
    raw_prompt_transport_line_by_line: false,
    post_start_tmux_paste_disabled: true,
    transport: "pi @startup-kickoff.md for every harness-intake agent",
  };
  writeJson(join(runDir, "tmux", "kickoff-dispatch.json"), dispatch);
  writeJson(join(runDir, "tmux", "session.json"), { schema: `${SCHEMA_PREFIX}.tmux-session.v1`, run_id: spec.run_id, session: sessionName, agents });
  writeJson(join(runDir, "tmux", "panes.json"), { schema: `${SCHEMA_PREFIX}.tmux-panes.v1`, run_id: spec.run_id, panes });
  return { schema: `${SCHEMA_PREFIX}.tmux-result.v1`, status: "started", no_ship: false, run_id: spec.run_id, session: sessionName, attach_command: `npm run harness:intake:tmux -- attach ${spec.run_id}` };
}

export function tmuxSessionName(runId) {
  return `zob-harness-intake-${safeRunId(runId)}`;
}

function requireTmux() {
  const found = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (found.status !== 0) throw new Error("tmux is required for tmux mode");
}

function spawnTmux(args) {
  const result = spawnSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`tmux ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function tmuxSessionExists(sessionName) {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0;
}

function tmuxStatus(sessionName, runId) {
  requireTmux();
  if (!tmuxSessionExists(sessionName)) return { schema: `${SCHEMA_PREFIX}.tmux-status.v1`, status: "not-running", no_ship: false, run_id: runId, session: sessionName };
  const list = spawnTmux(["list-windows", "-t", sessionName, "-F", "#{window_name}:#{pane_current_command}:#{pane_active}"]);
  return { schema: `${SCHEMA_PREFIX}.tmux-status.v1`, status: "running", no_ship: false, run_id: runId, session: sessionName, windows: list.split("\n").filter(Boolean) };
}

function tmuxAttach(sessionName, agent) {
  requireTmux();
  if (!tmuxSessionExists(sessionName)) return { schema: `${SCHEMA_PREFIX}.tmux-attach.v1`, status: "not-running", no_ship: true, session: sessionName };
  const child = spawnSync("tmux", ["attach", "-t", `${sessionName}:${agent}`], { stdio: "inherit" });
  return { schema: `${SCHEMA_PREFIX}.tmux-attach.v1`, status: child.status === 0 ? "attached" : "failed", no_ship: child.status !== 0, session: sessionName, agent };
}

function tmuxStop(sessionName, runId) {
  requireTmux();
  if (!tmuxSessionExists(sessionName)) return { schema: `${SCHEMA_PREFIX}.tmux-stop.v1`, status: "not-running", no_ship: false, run_id: runId, session: sessionName };
  spawnTmux(["kill-session", "-t", sessionName]);
  return { schema: `${SCHEMA_PREFIX}.tmux-stop.v1`, status: "stopped", no_ship: false, run_id: runId, session: sessionName };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
