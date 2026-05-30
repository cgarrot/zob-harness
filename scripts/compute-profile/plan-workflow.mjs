#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const profiles = new Set(["low", "medium", "high", "xhigh", "max"]);
const lanes = {
  low: [{ id: "deterministic_preview", agent: "agent", maxWorkers: 1, tools: ["read", "grep", "find", "ls"], outputContract: "metadata.v1", validation: "narrow" }],
  medium: [{ id: "deterministic_preview", agent: "agent", maxWorkers: 1, tools: ["read", "grep", "find", "ls"], outputContract: "metadata.v1", validation: "targeted" }, { id: "targeted_validation", agent: "qa", maxWorkers: 1, tools: ["read", "grep", "find", "ls", "bash"], outputContract: "oracle.v1", validation: "smoke" }],
  high: [{ id: "architecture", agent: "explore", maxWorkers: 2, tools: ["read", "grep", "find", "ls"], outputContract: "explore.v1", validation: "cited" }, { id: "implementation", agent: "implementer", maxWorkers: 2, tools: ["read", "grep", "find", "ls"], outputContract: "implement.v1", validation: "full_local" }, { id: "validation", agent: "oracle", maxWorkers: 1, tools: ["read", "grep", "find", "ls", "bash"], outputContract: "oracle.v1", validation: "required" }],
  xhigh: [{ id: "architecture", agent: "explore", maxWorkers: 3, tools: ["read", "grep", "find", "ls"], outputContract: "explore.v1", validation: "cited" }, { id: "safety", agent: "oracle", maxWorkers: 2, tools: ["read", "grep", "find", "ls"], outputContract: "oracle.v1", validation: "adversarial" }, { id: "implementation", agent: "implementer", maxWorkers: 4, tools: ["read", "grep", "find", "ls"], outputContract: "implement.v1", validation: "full_plus_adversarial" }, { id: "benchmark", agent: "qa", maxWorkers: 2, tools: ["read", "grep", "find", "ls", "bash"], outputContract: "qa.v1", validation: "suite" }],
  max: [{ id: "architecture", agent: "explore", maxWorkers: 4, tools: ["read", "grep", "find", "ls"], outputContract: "explore.v1", validation: "cited" }, { id: "safety", agent: "oracle", maxWorkers: 4, tools: ["read", "grep", "find", "ls"], outputContract: "oracle.v1", validation: "multi_oracle" }, { id: "implementation", agent: "implementer", maxWorkers: 8, tools: ["read", "grep", "find", "ls"], outputContract: "implement.v1", validation: "exhaustive_within_scope" }, { id: "benchmark", agent: "qa", maxWorkers: 4, tools: ["read", "grep", "find", "ls", "bash"], outputContract: "qa.v1", validation: "suite_plus_regression" }, { id: "human_approval_packet", agent: "planner", maxWorkers: 1, tools: ["read", "grep", "find", "ls"], outputContract: "plan.v1", validation: "human_required" }],
};
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function usage() { console.error("Usage: node scripts/compute-profile/plan-workflow.mjs --resolution reports/.../compute-profile-resolution.json --out reports/.../compute-workflow-shape.json"); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--resolution") out.resolution = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.resolution || !out.out) throw new Error("--resolution and --out are required");
  return out;
}
function repoPath(path) {
  const resolved = resolve(repoRoot, path);
  const root = resolve(repoRoot);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error(`path must stay inside repo: ${path}`);
  return resolved;
}
try {
  const args = parseArgs(process.argv.slice(2));
  const resolutionPath = repoPath(args.resolution);
  if (!existsSync(resolutionPath)) throw new Error(`missing resolution: ${args.resolution}`);
  const resolution = JSON.parse(readFileSync(resolutionPath, "utf8"));
  const profile = profiles.has(resolution.effectiveProfile) ? resolution.effectiveProfile : "low";
  const caps = resolution.caps || {};
  const maxAgents = typeof caps.maxAgents === "number" ? caps.maxAgents : 1;
  const maxParallel = typeof caps.maxParallel === "number" ? caps.maxParallel : 1;
  const plannedLanes = lanes[profile].map((lane) => ({ ...lane, maxWorkers: Math.min(lane.maxWorkers, maxAgents, maxParallel), parentOwnedDispatch: true, childDirectDispatch: false }));
  const highScale = profile === 'max' || maxAgents > 20;
  const maxAgentsPerWave = Math.max(1, Math.min(maxParallel, maxAgents));
  const shape = {
    schema: "zob.compute-workflow-shape.v1",
    runId: resolution.runId,
    domain: resolution.domain,
    requestedProfile: resolution.requestedProfile,
    effectiveProfile: profile,
    resolutionHash: sha256(JSON.stringify(resolution)),
    resolutionEmbedded: false,
    caps: { maxAgents, maxDelegationDepth: caps.maxDelegationDepth, maxParallel, maxIterations: caps.maxIterations, maxDurationMs: caps.maxDurationMs, maxContextTokens: caps.maxContextTokens },
    lanes: plannedLanes,
    promptPolicy: { schema: 'zob.adaptive-prompt-policy-hint.v1', rootCanWriteDirectly: false, rootDirectWriteToolsBlocked: ['bash', 'edit', 'write'], promptStackHashRequired: true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false },
    modelPolicy: { schema: 'zob.adaptive-model-policy.v1', downgradePolicy: 'blocked_for_oracle_security', laneAssignments: plannedLanes.map((lane) => ({ laneId: lane.id, agent: lane.agent, outputContract: lane.outputContract, modelClass: lane.agent === 'oracle' ? 'strong_oracle' : lane.agent === 'planner' || lane.id === 'architecture' ? 'strong_reasoning' : lane.agent === 'agent' || lane.agent === 'explore' ? 'cheap_scout' : 'balanced_worker', reasonHash: sha256(JSON.stringify({ laneId: lane.id, agent: lane.agent, outputContract: lane.outputContract })) })), bodyStored: false, promptBodiesStored: false, outputBodiesStored: false },
    scalePolicy: { schema: 'zob.adaptive-scale-policy.v1', requestedScale: highScale ? 'large' : 'default', maxTotalAgents: maxAgents, maxParallelAgents: maxParallel, maxAgentsPerWave, maxWaves: Math.max(1, Math.ceil(maxAgents / maxAgentsPerWave)), requiresBudget: caps.strictBudgetRequired === true, requiresScaleApproval: highScale, requiresOracleAfterWave: highScale || caps.oracleRequired === true, duplicateDetectionRequired: true, stalePeerBlocksCompletion: true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false },
    documentationPolicy: { schema: 'zob.adaptive-documentation-policy-hint.v1', required: true, rootDocs: ['AGENTS.md', 'README.md'], layerDocsRequired: true, roleDocPacksRequired: true, writebackPolicy: 'human_approval_required', maxDocsPerAgent: 12, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false },
    validationLevel: caps.validationLevel,
    oraclePolicy: caps.oraclePolicy,
    benchmarkLevel: caps.benchmarkLevel,
    adaptiveDelegationPolicyHint: resolution.adaptiveDelegationPolicyHint,
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    liveDispatchEnabled: false,
    noExecution: true,
    networkAccessed: false,
    sourceProjectModified: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    noShip: resolution.noShip === true,
    blockers: Array.isArray(resolution.blockers) ? resolution.blockers : [],
    generatedAt: new Date().toISOString(),
  };
  const outPath = repoPath(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(shape, null, 2), "utf8");
  console.log(JSON.stringify({ schema: "zob.compute-workflow-shape-cli.v1", workflowShapePath: relative(repoRoot, outPath), effectiveProfile: profile, lanes: shape.lanes.length, noShip: shape.noShip }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
