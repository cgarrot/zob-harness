#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const profiles = ["low", "medium", "high", "xhigh", "max"];
const defaults = JSON.parse(readFileSync(join(repoRoot, ".pi/compute-profiles/defaults.json"), "utf8"));
const errors = [];
for (const profile of profiles) {
  const caps = defaults.profiles?.[profile];
  if (!caps) {
    errors.push(`missing caps for ${profile}`);
    continue;
  }
  if (caps.maxAgents > defaults.hardCaps.maxAgents) errors.push(`${profile} maxAgents exceeds hard cap`);
  if (caps.maxDelegationDepth > defaults.hardCaps.maxDelegationDepth) errors.push(`${profile} maxDelegationDepth exceeds hard cap`);
  if (caps.maxParallel > defaults.hardCaps.maxParallel) errors.push(`${profile} maxParallel exceeds hard cap`);
  if (profile === "low" && caps.maxAgents !== 1) errors.push("low must remain single-agent");
  if ((profile === "high" || profile === "xhigh" || profile === "max") && caps.oracleRequired !== true) errors.push(`${profile} must require oracle`);
  if ((profile === "xhigh" || profile === "max") && caps.strictBudgetRequired !== true) errors.push(`${profile} must require strict budget`);
  if (profile === "max" && caps.humanApprovalRequired !== true) errors.push("max must require human approval");
}
if (defaults.parentOwnedDispatch !== true) errors.push("parentOwnedDispatch must be true");
if (defaults.childDirectDispatch !== false) errors.push("childDirectDispatch must be false");
const result = {
  schema: "zob.compute-profile-regression-smoke.v1",
  valid: errors.length === 0,
  profilesChecked: profiles,
  errors,
  maxApprovalGated: defaults.profiles.max?.humanApprovalRequired === true,
  parentOwnedDispatch: defaults.parentOwnedDispatch === true,
  childDirectDispatch: defaults.childDirectDispatch === false ? false : true,
  noExecution: true,
  networkAccessed: false,
  bodyStored: false
};
console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) process.exit(1);
