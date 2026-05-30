#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
function usage() { console.error("Usage: node scripts/compute-profile/validate-workflow.mjs --workflow reports/.../compute-workflow-shape.json"); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--workflow") out.workflow = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.workflow) throw new Error("--workflow is required");
  return out;
}
function repoPath(path) {
  const resolved = resolve(repoRoot, path);
  const root = resolve(repoRoot);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error(`path must stay inside repo: ${path}`);
  return resolved;
}
function validate(shape) {
  const errors = [];
  if (shape.schema !== "zob.compute-workflow-shape.v1") errors.push("workflow schema must be zob.compute-workflow-shape.v1");
  if (shape.parentOwnedDispatch !== true) errors.push("parentOwnedDispatch must be true");
  if (shape.childDirectDispatch !== false) errors.push("childDirectDispatch must be false");
  if (shape.liveDispatchEnabled !== false) errors.push("liveDispatchEnabled must be false");
  if (shape.noExecution !== true) errors.push("noExecution must be true");
  if (shape.networkAccessed !== false) errors.push("networkAccessed must be false");
  if (shape.sourceProjectModified !== false) errors.push("sourceProjectModified must be false");
  if (shape.bodyStored !== false || shape.promptBodiesStored !== false || shape.outputBodiesStored !== false) errors.push("workflow must keep body/prompt/output storage false");
  if (!Array.isArray(shape.lanes) || shape.lanes.length < 1) errors.push("workflow requires lanes");
  if (shape.promptPolicy?.rootCanWriteDirectly !== false) errors.push("promptPolicy rootCanWriteDirectly must be false");
  if (shape.modelPolicy?.downgradePolicy !== "blocked_for_oracle_security") errors.push("modelPolicy must block oracle/security downgrade");
  if (shape.scalePolicy?.stalePeerBlocksCompletion !== true || shape.scalePolicy?.duplicateDetectionRequired !== true) errors.push("scalePolicy must require stale and duplicate safeguards");
  if (shape.documentationPolicy?.roleDocPacksRequired !== true || shape.documentationPolicy?.writebackPolicy !== "human_approval_required") errors.push("documentationPolicy must require role doc packs and human-approved writeback");
  for (const [index, lane] of (shape.lanes || []).entries()) {
    if (lane.parentOwnedDispatch !== true) errors.push(`lane ${index} parentOwnedDispatch must be true`);
    if (lane.childDirectDispatch !== false) errors.push(`lane ${index} childDirectDispatch must be false`);
    if (!Array.isArray(lane.tools)) errors.push(`lane ${index} tools must be array`);
  }
  return errors;
}
try {
  const args = parseArgs(process.argv.slice(2));
  const workflowPath = repoPath(args.workflow);
  if (!existsSync(workflowPath)) throw new Error(`missing workflow: ${args.workflow}`);
  const shape = JSON.parse(readFileSync(workflowPath, "utf8"));
  const errors = validate(shape);
  const result = { schema: "zob.compute-workflow-shape-validation.v1", valid: errors.length === 0, errors, workflowPath: args.workflow, noExecution: true, childDispatchAllowed: false, networkAccessed: false, bodyStored: false };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
