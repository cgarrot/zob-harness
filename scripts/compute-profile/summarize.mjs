#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const repoRoot = process.cwd();
function usage() { console.error("Usage: node scripts/compute-profile/summarize.mjs --resolution reports/.../compute-profile-resolution.json --workflow reports/.../compute-workflow-shape.json --out reports/.../compute-mission-control-summary.json"); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--resolution") out.resolution = argv[++i];
    else if (argv[i] === "--workflow") out.workflow = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.resolution || !out.workflow || !out.out) throw new Error("--resolution, --workflow, and --out are required");
  return out;
}
function repoPath(path) {
  const resolved = resolve(repoRoot, path);
  const root = resolve(repoRoot);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error(`path must stay inside repo: ${path}`);
  return resolved;
}
function readJson(path) {
  const resolved = repoPath(path);
  if (!existsSync(resolved)) throw new Error(`missing artifact: ${path}`);
  return JSON.parse(readFileSync(resolved, "utf8"));
}
try {
  const args = parseArgs(process.argv.slice(2));
  const resolution = readJson(args.resolution);
  const workflow = readJson(args.workflow);
  const summary = {
    schema: "zob.compute-mission-control-summary.v1",
    runId: resolution.runId,
    domain: resolution.domain,
    requestedProfile: resolution.requestedProfile,
    recommendedProfile: resolution.recommendedProfile,
    effectiveProfile: resolution.effectiveProfile,
    caps: resolution.caps,
    gates: resolution.gates,
    workflow: {
      laneCount: Array.isArray(workflow.lanes) ? workflow.lanes.length : 0,
      laneIds: Array.isArray(workflow.lanes) ? workflow.lanes.map((lane) => lane.id).filter(Boolean) : [],
      parentOwnedDispatch: workflow.parentOwnedDispatch === true,
      childDirectDispatch: workflow.childDirectDispatch === true,
      liveDispatchEnabled: workflow.liveDispatchEnabled === true,
      noExecution: workflow.noExecution === true
    },
    noShip: resolution.noShip === true || workflow.noShip === true,
    blockers: [...new Set([...(resolution.blockers || []), ...(workflow.blockers || [])])],
    uiReadyMetadataOnly: true,
    fullHudWidgetWiringImplemented: false,
    fullHudWidgetWiringBlocker: "runtime TUI/HUD rendering is intentionally left as a future UI slice; this summary provides body-free Mission Control-compatible metadata now",
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    networkAccessed: false,
    childDispatchAllowed: false,
    generatedAt: new Date().toISOString()
  };
  const outPath = repoPath(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({ schema: "zob.compute-summary-cli.v1", summaryPath: relative(repoRoot, outPath), effectiveProfile: summary.effectiveProfile, noShip: summary.noShip }, null, 2));
  if (summary.noShip) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
