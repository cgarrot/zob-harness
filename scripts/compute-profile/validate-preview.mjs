#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const profiles = new Set(["low", "medium", "high", "xhigh", "max"]);
const requested = new Set(["auto", ...profiles]);
const forbiddenKeys = new Set(["task", "prompt", "output", "body", "content", "diff", "patch"]);

function usage() {
  console.error("Usage: node scripts/compute-profile/validate-preview.mjs --preview reports/.../compute-preview.json [--resolution reports/.../compute-profile-resolution.json]");
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--preview") out.preview = argv[++i];
    else if (arg === "--resolution") out.resolution = argv[++i];
    else if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.preview) throw new Error("--preview is required");
  return out;
}
function insideRepo(path) {
  const resolved = resolve(repoRoot, path);
  const root = resolve(repoRoot);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error(`path must stay inside repo: ${path}`);
  return resolved;
}
function readJson(path) {
  const resolved = insideRepo(path);
  if (!existsSync(resolved)) throw new Error(`missing artifact: ${path}`);
  return JSON.parse(readFileSync(resolved, "utf8"));
}
function hasForbiddenKeys(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKeys);
  return Object.entries(value).some(([key, child]) => forbiddenKeys.has(key) || hasForbiddenKeys(child));
}
function validScores(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["size", "material", "complexity", "ambiguity", "risk", "novelty", "reuseValue", "validationNeed"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1);
}
function checkFlag(record, key, expected, errors, label) {
  if (record[key] !== expected) errors.push(`${label} must keep ${key}=${expected}`);
}
function validatePreview(preview, errors) {
  if (preview.schema !== "zob.compute-preview.v1") errors.push("preview schema must be zob.compute-preview.v1");
  if (!requested.has(preview.requestedProfile)) errors.push("preview requestedProfile invalid");
  if (!profiles.has(preview.recommendedProfile)) errors.push("preview recommendedProfile invalid");
  if (!validScores(preview.scores)) errors.push("preview scores invalid");
  checkFlag(preview, "noExecution", true, errors, "preview");
  checkFlag(preview, "childDispatchAllowed", false, errors, "preview");
  checkFlag(preview, "networkAccessed", false, errors, "preview");
  checkFlag(preview, "sourceProjectModified", false, errors, "preview");
  checkFlag(preview, "knowledgeBackendWriteEnabled", false, errors, "preview");
  checkFlag(preview, "bodyStored", false, errors, "preview");
  checkFlag(preview, "promptBodiesStored", false, errors, "preview");
  checkFlag(preview, "outputBodiesStored", false, errors, "preview");
  if (hasForbiddenKeys(preview)) errors.push("preview must not contain raw body/prompt/output/content/diff/patch keys");
}
function validateResolution(resolution, errors) {
  if (resolution.schema !== "zob.compute-profile-resolution.v1") errors.push("resolution schema must be zob.compute-profile-resolution.v1");
  if (!requested.has(resolution.requestedProfile)) errors.push("resolution requestedProfile invalid");
  if (!profiles.has(resolution.recommendedProfile)) errors.push("resolution recommendedProfile invalid");
  if (!profiles.has(resolution.effectiveProfile)) errors.push("resolution effectiveProfile invalid");
  if (!resolution.caps || typeof resolution.caps !== "object") errors.push("resolution caps missing");
  checkFlag(resolution, "noExecution", true, errors, "resolution");
  checkFlag(resolution, "childDispatchAllowed", false, errors, "resolution");
  checkFlag(resolution, "networkAccessed", false, errors, "resolution");
  checkFlag(resolution, "sourceProjectModified", false, errors, "resolution");
  checkFlag(resolution, "knowledgeBackendWriteEnabled", false, errors, "resolution");
  checkFlag(resolution, "bodyStored", false, errors, "resolution");
  checkFlag(resolution, "promptBodiesStored", false, errors, "resolution");
  checkFlag(resolution, "outputBodiesStored", false, errors, "resolution");
  if (resolution.gates?.parentOwnedDispatch !== true) errors.push("resolution gate parentOwnedDispatch must be true");
  if (resolution.gates?.childDirectDispatch !== false) errors.push("resolution gate childDirectDispatch must be false");
  if (resolution.adaptiveDelegationPolicyHint?.parentOwnedDispatch !== true) errors.push("resolution adaptiveDelegationPolicyHint.parentOwnedDispatch must be true");
  if (resolution.adaptiveDelegationPolicyHint?.childDirectDispatch !== false) errors.push("resolution adaptiveDelegationPolicyHint.childDirectDispatch must be false");
  if (hasForbiddenKeys(resolution)) errors.push("resolution must not contain raw body/prompt/output/content/diff/patch keys");
}
try {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  validatePreview(readJson(args.preview), errors);
  if (args.resolution) validateResolution(readJson(args.resolution), errors);
  const result = { schema: "zob.compute-profile-validation.v1", valid: errors.length === 0, errors, previewPath: args.preview, resolutionPath: args.resolution, noExecution: true, childDispatchAllowed: false, networkAccessed: false, bodyStored: false };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
