#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { detectColgrep, loadConfig, printJson } from "./shared.mjs";

const config = loadConfig();
const colgrep = detectColgrep();

if (!colgrep.installed) {
  const report = {
    ok: false,
    action: "init-colgrep",
    skipped: true,
    reason: "colgrep-missing",
    guidance: "ColGREP is not installed or not on PATH. This script will not auto-install it. Install ColGREP manually, then rerun npm run zob:context:init.",
  };
  if (process.argv.includes("--json")) {
    printJson(report);
  } else {
    console.log(report.guidance);
  }
  process.exit(0);
}

const settingsArgs = [
  "settings",
  "--relative-paths",
  "--force-include",
  ".pi",
  ...config.excludePaths.flatMap((pattern) => ["--ignore", pattern]),
];
const settings = spawnSync("colgrep", settingsArgs, {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const init = spawnSync("colgrep", ["init", "-y"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const ok = settings.status === 0 && init.status === 0;
const report = {
  ok,
  action: "init-colgrep",
  skipped: false,
  settingsStatus: settings.status,
  initStatus: init.status,
  stdout: [settings.stdout, init.stdout].filter(Boolean).join("\n").trim(),
  stderr: [settings.stderr, init.stderr].filter(Boolean).join("\n").trim(),
  guidance: ok ? "ColGREP settings/init completed." : "ColGREP exists but settings/init failed; inspect stdout/stderr and run colgrep help/status manually.",
};

if (process.argv.includes("--json")) {
  printJson(report);
} else {
  console.log(report.guidance);
  if (report.stderr) {
    console.log(report.stderr);
  }
}

process.exit(ok ? 0 : 1);
