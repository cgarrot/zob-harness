#!/usr/bin/env node
import { detectColgrep, loadConfig, printJson } from "./shared.mjs";

const config = loadConfig();
const colgrep = detectColgrep();
const report = {
  ok: true,
  mode: colgrep.ready ? "colgrep-ready" : "grep-fallback",
  colgrep,
  config: {
    loadedFrom: config.loadedFrom,
    includePaths: config.includePaths,
    excludePaths: config.excludePaths,
    limits: config.limits,
    promptInjection: config.promptInjection,
  },
  guidance: colgrep.guidance,
};

if (process.argv.includes("--json")) {
  printJson(report);
} else {
  console.log("ZOB context discovery doctor");
  console.log(`mode: ${report.mode}`);
  console.log(`config: ${config.loadedFrom}`);
  console.log(`includePaths: ${config.includePaths.join(", ")}`);
  console.log(`excludePaths: ${config.excludePaths.join(", ")}`);
  console.log(`promptInjection: enabled=${String(config.promptInjection.enabled)} includeInstallHint=${String(config.promptInjection.includeInstallHint)}`);
  console.log(`guidance: ${report.guidance}`);
}

process.exit(0);
