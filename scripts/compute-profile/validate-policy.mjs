#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const files = {
  defaults: ".pi/compute-profiles/defaults.json",
  overrides: ".pi/compute-profiles/overrides.json",
  riskRules: ".pi/compute-profiles/risk-rules.json",
};
const profiles = ["low", "medium", "high", "xhigh", "max"];
function readJson(path) {
  const full = join(repoRoot, path);
  if (!existsSync(full)) throw new Error(`missing ${path}`);
  return JSON.parse(readFileSync(full, "utf8"));
}
const errors = [];
let defaults;
let overrides;
let riskRules;
try { defaults = readJson(files.defaults); } catch (error) { errors.push(error.message); }
try { overrides = readJson(files.overrides); } catch (error) { errors.push(error.message); }
try { riskRules = readJson(files.riskRules); } catch (error) { errors.push(error.message); }
if (defaults) {
  if (defaults.schema !== "zob.compute-profile-defaults.v1") errors.push("defaults schema mismatch");
  for (const profile of profiles) {
    const entry = defaults.profiles?.[profile];
    if (!entry) errors.push(`missing profile ${profile}`);
    if (entry?.maxAgents > defaults.hardCaps?.maxAgents) errors.push(`${profile} maxAgents exceeds hard cap`);
    if (entry?.maxDelegationDepth > defaults.hardCaps?.maxDelegationDepth) errors.push(`${profile} maxDelegationDepth exceeds hard cap`);
    if (entry?.maxParallel > defaults.hardCaps?.maxParallel) errors.push(`${profile} maxParallel exceeds hard cap`);
  }
  if (defaults.profiles?.max?.humanApprovalRequired !== true) errors.push("max profile must require human approval");
  if (defaults.childDirectDispatch !== false) errors.push("defaults childDirectDispatch must be false");
  if (defaults.bodyStored !== false) errors.push("defaults bodyStored must be false");
}
if (overrides) {
  if (overrides.schema !== "zob.compute-profile-overrides.v1") errors.push("overrides schema mismatch");
  if (overrides.maxRequiresHumanApproval !== true) errors.push("overrides must keep maxRequiresHumanApproval=true");
  if (overrides.bodyStored !== false) errors.push("overrides bodyStored must be false");
}
if (riskRules) {
  if (riskRules.schema !== "zob.compute-profile-risk-rules.v1") errors.push("risk rules schema mismatch");
  if (!riskRules.secretPatterns?.includes(".env")) errors.push("risk rules must include .env secret pattern");
  if (riskRules.childDirectDispatch !== false) errors.push("risk rules childDirectDispatch must be false");
  if (riskRules.bodyStored !== false) errors.push("risk rules bodyStored must be false");
}
const result = { schema: "zob.compute-profile-policy-validation.v1", valid: errors.length === 0, errors, files, noExecution: true, childDispatchAllowed: false, networkAccessed: false, bodyStored: false };
console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) process.exit(1);
