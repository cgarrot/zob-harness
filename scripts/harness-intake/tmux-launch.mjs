#!/usr/bin/env node
import { inferRunSpecFromRequest, launchTmux, parseArgs, printJson, runFullAnalysis, tmuxSessionName } from "./lib.mjs";

function help() {
  return {
    schema: "zob.harness-intake.tmux.help.v1",
    usage: [
      "node scripts/harness-intake/tmux-launch.mjs start \"Analyze ../repo-x as a Claude Code setup\"",
      "node scripts/harness-intake/tmux-launch.mjs start --target ../repo-x --allow-sessions \"You may read the sessions\"",
      "node scripts/harness-intake/tmux-launch.mjs status <run_id>",
      "node scripts/harness-intake/tmux-launch.mjs attach <run_id> [agent]",
      "node scripts/harness-intake/tmux-launch.mjs stop <run_id>",
    ],
    no_ship: false,
  };
}

try {
  const raw = process.argv.slice(2);
  const command = raw[0] && !raw[0].startsWith("--") ? raw[0] : "help";
  const opts = parseArgs(command === "help" ? raw : raw.slice(1));
  if (command === "help" || opts.help) {
    printJson(help());
    process.exit(0);
  }
  if (["status", "attach", "stop"].includes(command)) {
    const runId = opts._[0] || opts.runId;
    if (!runId) throw new Error(`${command} requires a run id`);
    const result = launchTmux(runId, { command, agent: opts._[1] || opts.agent });
    if (command !== "attach") printJson(result);
    if (result.no_ship) process.exitCode = 1;
    process.exit(0);
  }
  if (!["start", "start-detached", "prepare"].includes(command)) throw new Error(`unknown tmux command: ${command}`);
  const request = opts._.join(" ");
  const spec = inferRunSpecFromRequest(request, opts);
  const prepared = runFullAnalysis(spec, { prepareOnly: true });
  if (command === "prepare") {
    printJson({ ...prepared, tmux_session: tmuxSessionName(spec.run_id) });
    process.exit(prepared.no_ship ? 1 : 0);
  }
  const launched = launchTmux(spec, { command: "start" });
  printJson({ ...launched, prepared });
  if (launched.no_ship) process.exitCode = 1;
} catch (error) {
  printJson({ schema: "zob.harness-intake.tmux.error.v1", status: "error", no_ship: true, message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
