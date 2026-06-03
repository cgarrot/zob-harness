#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RUNS_ROOT = "reports/agentic-spec-runs";
const TEAM_SCRIPT = ".pi/zteams/agentic-spec-run.tmux.sh";
const DEFAULT_AGENT = "spec-chief";
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "help";

try {
  const result = await dispatch(command, command === "help" ? args : args.slice(1));
  if (result) print(result);
  if (result?.no_ship) process.exitCode = 1;
} catch (error) {
  print({ schema: "agentic-spec-run.error.v1", status: "error", no_ship: true, message: error?.message || String(error) });
  process.exitCode = 1;
}

async function dispatch(cmd, values) {
  if (cmd === "help" || values.includes("--help") || args.includes("--help")) return help();
  if (cmd === "init") return initRun(parseOptions(values));
  if (cmd === "auto-pilot") return autoPilot(parseOptions(values));
  if (cmd === "send-kickoff") return sendKickoff(values[0], parseOptions(values.slice(1)));
  if (cmd === "team-start") return teamStart(values[0]);
  if (cmd === "team-status") return teamStatus(parseRunOrSession(values));
  if (cmd === "team-attach") return teamAttach(values[0], values[1] || DEFAULT_AGENT);
  if (cmd === "team-close") return teamClose(parseRunOrSession(values));
  if (cmd === "wait") return waitForCompletion(values[0], parseOptions(values.slice(1)));
  if (cmd === "validate") return validateRun(values[0]);
  if (cmd === "questions") return listQuestions(values[0], parseOptions(values.slice(1)));
  if (cmd === "answer") return answerQuestion(values[0], values[1], parseOptions(values.slice(2)));
  if (cmd === "resume") return resumeRun(values[0]);
  if (cmd === "status") return readRunStatus(values[0]);
  return { ...help(), status: "blocked", no_ship: true, message: `unknown command: ${cmd}` };
}

function help() {
  return {
    schema: "agentic-spec-run.help.v1",
    usage: [
      "node scripts/spec-run.mjs init --mission <text>|--mission-file <path> --source <path> [--source <path>] [--name name] [--run-id id] [--owner owner] [--prepare-only]",
      "node scripts/spec-run.mjs auto-pilot --mission <text>|--mission-file <path> --source <path> [--timeout-ms 14400000] [--poll-ms 30000] [--no-submit] [--no-wait] [--no-close]",
      "node scripts/spec-run.mjs send-kickoff reports/agentic-spec-runs/<run_id> --session agentic-spec-run-<run_id> --agent spec-chief --submit",
      "node scripts/spec-run.mjs answer <run_id> Q-001 --text '<answer>' --answered-by owner",
      "node scripts/spec-run.mjs validate <run_id>",
    ],
    output: "json",
    v1_posture: "skill + factory + ZTeam + CLI; no runtime extension",
    no_ship: false,
  };
}

async function initRun(opts) {
  const sources = opts.source ?? [];
  const mission = await resolveMission(opts);
  if (!mission) return blocked("init", "missing mission; use --mission or --mission-file");
  if (!sources.length) return blocked("init", "missing at least one --source path");

  const runId = safeRunId(opts.runId || `${opts.name || "spec"}-${timestamp()}`);
  const runDir = path.join(RUNS_ROOT, runId);
  const createdAt = new Date().toISOString();
  await mkdirs(runDir, ["analysis", "spec", "validation", "handoff", "oracle", "checkpoints"]);

  const sourceRows = sources.map((source, index) => inspectSource(source, index));
  const manifest = {
    schema: "agentic-spec-run.manifest.v1",
    run_id: runId,
    name: opts.name || runId,
    owner: opts.owner || "owner",
    created_at: createdAt,
    mission,
    mission_file: opts.missionFile || null,
    source_count: sourceRows.length,
    source_refs: sourceRows.map((row) => row.source_id),
    run_dir: runDir,
    team_id: "agentic-spec-run",
    entry_agent: DEFAULT_AGENT,
    expected_session: sessionName(runId),
    policies: {
      source_policy: "citation_only_by_default",
      raw_secret_storage: false,
      human_questions_block_completion: true,
      final_oracle_required: true,
      traceability_required: true,
      runtime_extension_v1: false,
    },
  };
  const teamPlan = {
    schema: "agentic-spec.team-plan.v1",
    run_id: runId,
    session: sessionName(runId),
    entry_agent: DEFAULT_AGENT,
    agents: ["spec-chief", "source-intake-steward", "data-profile-analyst", "domain-modeler", "ux-flow-analyst", "spec-writer", "bdd-writer", "planner-handoff-writer", "spec-oracle"],
    rooms: ["spec-control", "intake", "data", "domain", "ux", "writing", "validation", "handoff", "oracle"],
  };
  const status = {
    schema: "agentic-spec-run.status.v1",
    run_id: runId,
    status: "ready",
    phase: "init",
    no_ship: false,
    run_dir: runDir,
    open_blocking_questions: 0,
    final_oracle: "pending",
    updated_at: createdAt,
  };

  await writeJson(path.join(runDir, "run-manifest.json"), manifest);
  await writeJson(path.join(runDir, "source-register.json"), { schema: "agentic-spec.source-register.v1", run_id: runId, sources: sourceRows });
  await writeJson(path.join(runDir, "team-plan.json"), teamPlan);
  await writeJson(path.join(runDir, "status.json"), status);
  await fs.writeFile(path.join(runDir, "source-register.md"), renderSourceRegister(sourceRows), "utf8");
  await fs.writeFile(path.join(runDir, "chief-kickoff.md"), renderKickoff(manifest, sourceRows), "utf8");
  await fs.writeFile(path.join(runDir, "questions.md"), "# Open Questions\n\nNo questions recorded yet.\n", "utf8");
  await fs.writeFile(path.join(runDir, "answers.md"), "# Answers\n\nNo answers recorded yet.\n", "utf8");
  await fs.writeFile(path.join(runDir, "questions.jsonl"), "", "utf8");
  await fs.writeFile(path.join(runDir, "answers.jsonl"), "", "utf8");
  await fs.writeFile(path.join(runDir, "assumptions.md"), "# Assumptions\n\n", "utf8");
  await fs.writeFile(path.join(runDir, "validation/traceability-matrix.md"), "# Traceability Matrix\n\n| Source | Fact / answer / assumption | Requirement | Acceptance criteria | Task | Oracle check |\n| --- | --- | --- | --- | --- | --- |\n", "utf8");
  await writeJson(path.join(runDir, "validation/traceability-matrix.json"), { schema: "agentic-spec.traceability.v1", run_id: runId, rows: [] });

  return { schema: "agentic-spec-run.init-result.v1", status: "ready", no_ship: false, run_id: runId, run_dir: runDir, prepare_only: opts.prepareOnly !== false, full_team_launched: false, expected_session: sessionName(runId) };
}

async function autoPilot(opts) {
  const timeoutMs = Number(opts.timeoutMs || 4 * 60 * 60 * 1000);
  const pollMs = Number(opts.pollMs || 30 * 1000);
  const submit = opts.submit !== false;
  const wait = opts.wait !== false;
  const close = opts.close !== false;
  const init = await initRun({ ...opts, prepareOnly: true });
  if (init.no_ship) return init;
  const sessionGuard = validateSessionOverride(opts.session, sessionName(init.run_id));
  if (sessionGuard.no_ship) return { schema: "agentic-spec-run.auto-pilot-result.v1", status: "blocked", no_ship: true, phase: "session-guard", init, session_guard: sessionGuard };
  const team_start = teamStart(init.run_id);
  if (team_start.no_ship) return { schema: "agentic-spec-run.auto-pilot-result.v1", status: "blocked", no_ship: true, phase: "team-start", init, team_start };
  const kickoff = await sendKickoff(init.run_dir, { session: sessionGuard.session, agent: opts.agent || DEFAULT_AGENT, submit });
  if (kickoff.no_ship) return { schema: "agentic-spec-run.auto-pilot-result.v1", status: "blocked", no_ship: true, phase: "send-kickoff", init, team_start, kickoff };
  if (!wait) return { schema: "agentic-spec-run.auto-pilot-result.v1", status: "launched", no_ship: false, run_id: init.run_id, run_dir: init.run_dir, run_session: sessionGuard.session, waited: false, closed: false, next_command: `npm run spec-run -- team-status --session ${sessionGuard.session}` };
  const completion = await waitForCompletion(init.run_id, { timeoutMs, pollMs });
  if (completion.status !== "pass") return { schema: "agentic-spec-run.auto-pilot-result.v1", status: completion.status, no_ship: true, run_id: init.run_id, run_dir: init.run_dir, run_session: sessionGuard.session, completion, closed: false, close_skipped_reason: "completion_not_pass_no_ship_false" };
  let closeResult = { status: "skipped", closed: false, reason: "--no-close" };
  if (close) closeResult = teamClose({ runId: init.run_id, confirm: true, session: sessionGuard.session });
  return { schema: "agentic-spec-run.auto-pilot-result.v1", status: "pass", no_ship: false, run_id: init.run_id, run_dir: init.run_dir, run_session: sessionGuard.session, completion, close: closeResult, closed: closeResult.closed === true };
}

async function sendKickoff(runDirOrId, opts) {
  const runDir = resolveRunDir(runDirOrId);
  const manifest = await readJson(path.join(runDir, "run-manifest.json"));
  const kickoffPath = path.join(runDir, "chief-kickoff.md");
  const session = opts.session || sessionName(manifest.run_id);
  const guard = validateSessionOverride(session, sessionName(manifest.run_id));
  if (guard.no_ship) return { schema: "agentic-spec-run.kickoff-result.v1", status: "blocked", no_ship: true, session_guard: guard };
  const agent = opts.agent || DEFAULT_AGENT;
  if (!opts.submit) return { schema: "agentic-spec-run.kickoff-result.v1", status: "pass", no_ship: false, submitted: false, run_id: manifest.run_id, run_dir: runDir, kickoff_ref: kickoffPath, session, agent };
  const target = `${session}:${agent}`;
  const body = await fs.readFile(kickoffPath, "utf8");
  const payload = `Please execute this Agentic Spec kickoff. Read ${kickoffPath} and coordinate the run.\n\n${body}`;
  const sent = spawnSync("tmux", ["send-keys", "-t", target, payload, "C-m"], { encoding: "utf8" });
  if (sent.status !== 0) return { schema: "agentic-spec-run.kickoff-result.v1", status: "blocked", no_ship: true, submitted: false, reason: "tmux_send_failed", stderr: sent.stderr?.trim(), target };
  return { schema: "agentic-spec-run.kickoff-result.v1", status: "pass", no_ship: false, submitted: true, run_id: manifest.run_id, run_dir: runDir, kickoff_ref: kickoffPath, session, agent };
}

function teamStart(runId) {
  if (!runId) return blocked("team-start", "missing run_id");
  return runTeamScript(["start-detached", runId], "agentic-spec-run.team-start-result.v1");
}

function teamStatus(spec) {
  const session = spec.session || (spec.runId ? sessionName(spec.runId) : null);
  if (!session) return blocked("team-status", "missing --session or run_id");
  const runId = spec.runId || session.replace(/^agentic-spec-run-/u, "");
  return runTeamScript(["status", runId], "agentic-spec-run.team-status-result.v1", { session });
}

function teamAttach(runId, agent) {
  if (!runId) return blocked("team-attach", "missing run_id");
  return runTeamScript(["attach", runId, agent || DEFAULT_AGENT], "agentic-spec-run.team-attach-result.v1");
}

function teamClose(spec) {
  const session = spec.session || (spec.runId ? sessionName(spec.runId) : null);
  const runId = spec.runId || session?.replace(/^agentic-spec-run-/u, "");
  if (!runId || !session) return blocked("team-close", "missing --session or run_id");
  const guard = validateSessionOverride(session, sessionName(runId));
  if (guard.no_ship) return { schema: "agentic-spec-run.team-close-result.v1", status: "blocked", no_ship: true, closed: false, session_guard: guard };
  if (!spec.confirm) return { schema: "agentic-spec-run.team-close-result.v1", status: "blocked", no_ship: true, closed: false, reason: "team-close requires --confirm" };
  return runTeamScript(["close", runId], "agentic-spec-run.team-close-result.v1", { session, closed: true });
}

async function waitForCompletion(runId, opts) {
  const runDir = resolveRunDir(runId);
  const timeoutMs = Number(opts.timeoutMs || 4 * 60 * 60 * 1000);
  const pollMs = Number(opts.pollMs || 30 * 1000);
  const deadline = Date.now() + timeoutMs;
  const checked = [];
  while (Date.now() <= deadline) {
    for (const file of [path.join(runDir, "final-report.json"), path.join(runDir, "status.json")]) {
      const parsed = await readJsonIfExists(file);
      if (!parsed) continue;
      checked.push(file);
      if (isPassingCompletion(parsed)) return { schema: "agentic-spec-run.wait-result.v1", status: "pass", no_ship: false, completion_ref: file, report: parsed };
      if (isBlockingCompletion(parsed)) return { schema: "agentic-spec-run.wait-result.v1", status: "blocked", no_ship: true, completion_ref: file, report: parsed };
    }
    await sleep(pollMs);
  }
  return { schema: "agentic-spec-run.wait-result.v1", status: "timeout", no_ship: true, timeout_ms: timeoutMs, checked_refs: [...new Set(checked)] };
}

async function validateRun(runIdOrDir) {
  const runDir = resolveRunDir(runIdOrDir);
  const required = ["run-manifest.json", "source-register.json", "source-register.md", "team-plan.json", "chief-kickoff.md", "status.json", "questions.md", "answers.md", "validation/traceability-matrix.json", "validation/traceability-matrix.md"];
  const missing = required.filter((file) => !existsSync(path.join(runDir, file)));
  const errors = [...missing.map((file) => `missing ${file}`)];
  const manifest = await readJsonIfExists(path.join(runDir, "run-manifest.json"));
  const sources = await readJsonIfExists(path.join(runDir, "source-register.json"));
  const traceability = await readJsonIfExists(path.join(runDir, "validation/traceability-matrix.json"));
  if (manifest?.schema !== "agentic-spec-run.manifest.v1") errors.push("manifest schema mismatch");
  if (!Array.isArray(sources?.sources) || sources.sources.length < 1) errors.push("source-register must include at least one source");
  if (!Array.isArray(traceability?.rows)) errors.push("traceability rows must be an array");
  const questions = await readJsonlIfExists(path.join(runDir, "questions.jsonl"));
  const openBlocking = questions.filter((q) => q?.blocking === true && q?.status !== "answered" && q?.status !== "closed");
  if (openBlocking.length > 0) errors.push(`open blocking questions: ${openBlocking.map((q) => q.question_id).join(", ")}`);
  return { schema: "agentic-spec-run.validation-result.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, run_dir: runDir, errors, checked_files: required };
}

async function listQuestions(runId, opts) {
  const runDir = resolveRunDir(runId);
  const questions = await readJsonlIfExists(path.join(runDir, "questions.jsonl"));
  const rows = opts.openOnly ? questions.filter((q) => q.status === "open") : questions;
  return { schema: "agentic-spec-run.questions-result.v1", status: "pass", no_ship: false, run_id: path.basename(runDir), questions: rows };
}

async function answerQuestion(runId, questionId, opts) {
  if (!runId || !questionId) return blocked("answer", "usage: answer <run_id> <question_id> --text '<answer>'");
  if (!opts.text) return blocked("answer", "missing --text answer");
  const runDir = resolveRunDir(runId);
  const answer = {
    schema: "agentic-spec.answer.v1",
    question_id: questionId,
    answered_by: opts.answeredBy || "owner",
    answer_summary: opts.text,
    selected_option: opts.option || null,
    raw_answer_stored: false,
    answered_at: new Date().toISOString(),
  };
  await fs.appendFile(path.join(runDir, "answers.jsonl"), `${JSON.stringify(answer)}\n`, "utf8");
  await fs.appendFile(path.join(runDir, "answers.md"), `\n## ${questionId}\n\nAnswered by: ${answer.answered_by}\n\n${answer.answer_summary}\n`, "utf8");
  const statusPath = path.join(runDir, "status.json");
  const status = await readJsonIfExists(statusPath) || {};
  status.status = "answer_recorded";
  status.phase = "human-clarification";
  status.no_ship = true;
  status.updated_at = new Date().toISOString();
  status.next_command = `npm run spec-run -- resume ${path.basename(runDir)}`;
  await writeJson(statusPath, status);
  return { schema: "agentic-spec-run.answer-result.v1", status: "pass", no_ship: false, run_id: path.basename(runDir), answer_ref: path.join(runDir, "answers.md"), next_command: status.next_command };
}

async function resumeRun(runId) {
  const runDir = resolveRunDir(runId);
  const statusPath = path.join(runDir, "status.json");
  const status = await readJsonIfExists(statusPath) || {};
  status.status = "ready";
  status.phase = "resume_after_human_answer";
  status.no_ship = false;
  status.updated_at = new Date().toISOString();
  await writeJson(statusPath, status);
  return { schema: "agentic-spec-run.resume-result.v1", status: "pass", no_ship: false, run_id: path.basename(runDir), status_ref: statusPath, next_step: `send kickoff or attach spec-chief in ${sessionName(path.basename(runDir))}` };
}

async function readRunStatus(runId) {
  const runDir = resolveRunDir(runId);
  return await readJson(path.join(runDir, "status.json"));
}

function runTeamScript(teamArgs, schema, extra = {}) {
  if (!existsSync(TEAM_SCRIPT)) return { schema, status: "blocked", no_ship: true, reason: `missing ${TEAM_SCRIPT}` };
  const result = spawnSync("bash", [TEAM_SCRIPT, ...teamArgs], { encoding: "utf8", cwd: process.cwd(), env: process.env });
  if (result.status !== 0) return { schema, status: "blocked", no_ship: true, stdout: result.stdout?.trim(), stderr: result.stderr?.trim(), ...extra };
  return { schema, status: "pass", no_ship: false, stdout: result.stdout?.trim(), ...extra };
}

function parseOptions(values) {
  const opts = { source: [], submit: true, wait: true, close: true, prepareOnly: true };
  for (let i = 0; i < values.length; i++) {
    const arg = values[i];
    if (arg === "--source") opts.source.push(values[++i]);
    else if (arg === "--mission") opts.mission = values[++i];
    else if (arg === "--mission-file") opts.missionFile = values[++i];
    else if (arg === "--name") opts.name = values[++i];
    else if (arg === "--run-id") opts.runId = values[++i];
    else if (arg === "--owner") opts.owner = values[++i];
    else if (arg === "--session") opts.session = values[++i];
    else if (arg === "--agent") opts.agent = values[++i];
    else if (arg === "--timeout-ms") opts.timeoutMs = values[++i];
    else if (arg === "--poll-ms") opts.pollMs = values[++i];
    else if (arg === "--answered-by") opts.answeredBy = values[++i];
    else if (arg === "--text") opts.text = values[++i];
    else if (arg === "--option") opts.option = values[++i];
    else if (arg === "--prepare-only") opts.prepareOnly = true;
    else if (arg === "--no-submit") opts.submit = false;
    else if (arg === "--no-wait") opts.wait = false;
    else if (arg === "--no-close") opts.close = false;
    else if (arg === "--open-only") opts.openOnly = true;
    else if (arg === "--confirm") opts.confirm = true;
  }
  return opts;
}

function parseRunOrSession(values) {
  const opts = parseOptions(values);
  const runId = values.find((value) => !value.startsWith("--") && ![opts.session].includes(value));
  return { runId, session: opts.session, confirm: opts.confirm };
}

async function resolveMission(opts) {
  if (opts.missionFile) return fs.readFile(opts.missionFile, "utf8");
  return opts.mission || "";
}

function inspectSource(source, index) {
  const exists = existsSync(source);
  const stat = exists ? statSync(source) : null;
  return {
    source_id: `SRC-${String(index + 1).padStart(3, "0")}`,
    path: source,
    exists,
    kind: stat?.isDirectory() ? "directory" : stat?.isFile() ? "file" : "missing",
    size_bytes: stat?.isFile() ? stat.size : null,
    policy: "citation_only",
    sensitivity: "unknown_until_intake",
  };
}

function renderSourceRegister(rows) {
  return `# Source Register\n\n| Source | Path | Kind | Exists | Policy | Sensitivity |\n| --- | --- | --- | --- | --- | --- |\n${rows.map((row) => `| ${row.source_id} | ${row.path} | ${row.kind} | ${row.exists} | ${row.policy} | ${row.sensitivity} |`).join("\n")}\n`;
}

function renderKickoff(manifest, sources) {
  return `# Agentic Spec Run Kickoff\n\nRun: ${manifest.run_id}\nSession: ${manifest.expected_session}\nEntry agent: ${manifest.entry_agent}\n\n## Mission\n\n${manifest.mission}\n\n## Sources\n\n${sources.map((row) => `- ${row.source_id}: ${row.path} (${row.kind}, policy=${row.policy})`).join("\n")}\n\n## Required outputs\n\n- source register and source quality report\n- data profile / domain model / UX flows as applicable\n- mission spec, requirements, BDD acceptance criteria\n- validation/traceability-matrix.md and .json\n- handoff/workgraph.md and implementation tasks\n- oracle/final-oracle-review.json and final-report.json\n\n## Rules\n\nSpec Chief is the only human interlocutor. Do not invent answers to blocking business questions. Completion requires oracle PASS and no_ship=false.\n`;
}

async function mkdirs(root, children) {
  await fs.mkdir(root, { recursive: true });
  for (const child of children) await fs.mkdir(path.join(root, child), { recursive: true });
}

function sessionName(runId) { return `agentic-spec-run-${safeRunId(runId)}`; }
function safeRunId(value) { return String(value || "").trim().replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 120) || "spec-run"; }
function timestamp() { return new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14); }
function resolveRunDir(runIdOrDir) { return String(runIdOrDir || "").startsWith(RUNS_ROOT) ? runIdOrDir : path.join(RUNS_ROOT, safeRunId(runIdOrDir)); }
function validateSessionOverride(requestedSession, expectedSession) { const session = requestedSession || expectedSession; return session === expectedSession ? { status: "pass", no_ship: false, session, expected_session: expectedSession } : { status: "blocked", no_ship: true, session, expected_session: expectedSession, reason: "session_must_equal_isolated_agentic_spec_run_session" }; }
function isPassingCompletion(value) { return value?.no_ship === false && ["pass", "complete", "completed"].includes(String(value?.status || value?.verdict || "").toLowerCase()); }
function isBlockingCompletion(value) { return value?.no_ship === true || ["blocked", "fail", "failed", "needs_human"].includes(String(value?.status || value?.verdict || "").toLowerCase()); }
function blocked(phase, reason) { return { schema: "agentic-spec-run.blocked.v1", status: "blocked", no_ship: true, phase, reason }; }
async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function readJsonIfExists(file) { try { return await readJson(file); } catch { return null; } }
async function readJsonlIfExists(file) { try { const text = await fs.readFile(file, "utf8"); return text.split(/\n/u).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }
async function writeJson(file, value) { await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function print(value) { console.log(JSON.stringify(value, null, 2)); }
