import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readJson, repoRel, resolveRunDir, safeRunId, sha256, writeJson } from "./cli-io.mjs";
import { SCHEMA_PREFIX, repoRoot } from "./constants.mjs";
import { HARNESS_INTAKE_AGENTS } from "./run-init.mjs";

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

export function requireTmux() {
  const found = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (found.status !== 0) throw new Error("tmux is required for tmux mode");
}

export function spawnTmux(args) {
  const result = spawnSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`tmux ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function tmuxSessionExists(sessionName) {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0;
}

export function tmuxStatus(sessionName, runId) {
  requireTmux();
  if (!tmuxSessionExists(sessionName)) return { schema: `${SCHEMA_PREFIX}.tmux-status.v1`, status: "not-running", no_ship: false, run_id: runId, session: sessionName };
  const list = spawnTmux(["list-windows", "-t", sessionName, "-F", "#{window_name}:#{pane_current_command}:#{pane_active}"]);
  return { schema: `${SCHEMA_PREFIX}.tmux-status.v1`, status: "running", no_ship: false, run_id: runId, session: sessionName, windows: list.split("\n").filter(Boolean) };
}

export function tmuxAttach(sessionName, agent) {
  requireTmux();
  if (!tmuxSessionExists(sessionName)) return { schema: `${SCHEMA_PREFIX}.tmux-attach.v1`, status: "not-running", no_ship: true, session: sessionName };
  const child = spawnSync("tmux", ["attach", "-t", `${sessionName}:${agent}`], { stdio: "inherit" });
  return { schema: `${SCHEMA_PREFIX}.tmux-attach.v1`, status: child.status === 0 ? "attached" : "failed", no_ship: child.status !== 0, session: sessionName, agent };
}

export function tmuxStop(sessionName, runId) {
  requireTmux();
  if (!tmuxSessionExists(sessionName)) return { schema: `${SCHEMA_PREFIX}.tmux-stop.v1`, status: "not-running", no_ship: false, run_id: runId, session: sessionName };
  spawnTmux(["kill-session", "-t", sessionName]);
  return { schema: `${SCHEMA_PREFIX}.tmux-stop.v1`, status: "stopped", no_ship: false, run_id: runId, session: sessionName };
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
