#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, ["scripts/harness-intake/validate-run.mjs", ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
});
process.exit(result.status ?? 1);
