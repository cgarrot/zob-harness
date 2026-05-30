import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AdaptiveDelegationPolicy, OrchestrateExecutionMode, OrchestrateRunInput, OrchestrationProfileDefinition, TeamDefinition, TeamRoleBase, TeamLead, TeamWorker } from "../types.js";
import { sha256 } from "../utils/hashing.js";
import { safeFileStem } from "../utils/paths.js";
import { isRecord } from "../utils/records.js";

const BODY_FREE_SCHEMA_VERSION = "v1";
const GUIDANCE_SCAN_LIMIT = 200;
const FORBIDDEN_BODY_KEYS = new Set(["task", "prompt", "output", "body", "content", "patch", "diff", "messages", "transcript", "rawContext", "rawPrompt"]);
const SECRET_PATH_PATTERN = /(^|\/)\.env($|[./])|(^|\/)(\.ssh|\.aws)(\/|$)|secret|credential|\.pem$|\.p12$|\.pfx$|(^|[-_])key([-_.]|$)/i;

export interface AdaptiveWorkflowArtifactsInput {
  repoRoot: string;
  runDir: string;
  runId: string;
  definition: TeamDefinition;
  profileDefinition?: OrchestrationProfileDefinition;
  input: OrchestrateRunInput;
  computeProfile: Record<string, unknown>;
  adaptiveDelegation: AdaptiveDelegationPolicy;
  execution: OrchestrateExecutionMode;
  goal: string;
  originalUserAsk: string;
}

export interface AdaptiveWorkflowArtifactsResult {
  artifacts: string[];
  context: Record<string, unknown>;
  validationSummary: Record<string, unknown>;
}

type GuidanceKind = "root_doc" | "layer_doc" | "rule" | "skill" | "prompt" | "agent" | "output_contract" | "runtime_doc";

type RoleLike = (TeamRoleBase | TeamLead | TeamWorker) & { roleType?: string; leadId?: string };

function profileRank(profile: string | undefined): number {
  return ["low", "medium", "high", "xhigh", "max"].indexOf(profile ?? "low");
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isSafeGuidancePath(path: string): boolean {
  return path.length > 0 && !path.includes("\0") && !path.startsWith("/") && !path.startsWith("../") && !path.includes("/../") && !SECRET_PATH_PATTERN.test(path) && !/(^|\/)(node_modules|dist|build|coverage)(\/|$)/.test(path);
}

function guidanceEntry(repoRoot: string, ref: string, kind: GuidanceKind, extra: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  if (!isSafeGuidancePath(ref)) return undefined;
  const absolute = join(repoRoot, ref);
  if (!existsSync(absolute)) return undefined;
  const stat = statSync(absolute);
  if (!stat.isFile()) return undefined;
  const raw = readFileSync(absolute, "utf8");
  return {
    schema: "zob.guidance-ref.v1",
    ref,
    kind,
    bytes: stat.size,
    sha256: sha256(raw),
    bodyStored: false,
    ...extra,
  };
}

function pushEntry(target: Record<string, unknown>[], repoRoot: string, ref: string, kind: GuidanceKind, extra: Record<string, unknown> = {}): void {
  const entry = guidanceEntry(repoRoot, ref, kind, extra);
  if (entry) target.push(entry);
}

function listFiles(repoRoot: string, relativeDir: string, predicate: (relativePath: string) => boolean, limit = GUIDANCE_SCAN_LIMIT): string[] {
  const root = join(repoRoot, relativeDir);
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const visit = (dir: string, rel: string, depth: number): void => {
    if (results.length >= limit || depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const repoRel = `${relativeDir}/${childRel}`.replace(/\/+/g, "/");
      if (!isSafeGuidancePath(repoRel)) continue;
      const childAbs = join(dir, entry.name);
      if (entry.isDirectory()) visit(childAbs, childRel, depth + 1);
      else if (entry.isFile() && predicate(repoRel)) results.push(repoRel);
      if (results.length >= limit) return;
    }
  };
  visit(root, "", 0);
  return results;
}

function buildGuidanceIndex(repoRoot: string, definition: TeamDefinition): Record<string, unknown> {
  const rootDocs: Record<string, unknown>[] = [];
  const layerDocs: Record<string, unknown>[] = [];
  const rules: Record<string, unknown>[] = [];
  const skills: Record<string, unknown>[] = [];
  const prompts: Record<string, unknown>[] = [];
  const agents: Record<string, unknown>[] = [];
  const outputContracts: Record<string, unknown>[] = [];

  for (const ref of ["AGENTS.md", "README.md", "docs/ROADMAP.md", "docs/OPERATING_MODEL.md", "docs/ZOB_ADAPTIVE_WORKFLOW_RUNTIME_PLAN.md", "docs/ZOB_RULES_SYSTEM.md"]) {
    pushEntry(rootDocs, repoRoot, ref, "root_doc", { layerId: "project-root" });
  }
  for (const ref of listFiles(repoRoot, ".", (candidate) => /(^|\/)AGENTS\.md$/.test(candidate), 50)) {
    pushEntry(layerDocs, repoRoot, ref, "layer_doc", { layerId: safeFileStem(ref.replace(/\/AGENTS\.md$/, "") || "project-root") });
  }
  for (const ref of listFiles(repoRoot, ".pi/rules", (candidate) => candidate.endsWith(".md"), 80)) pushEntry(rules, repoRoot, ref, "rule");
  for (const ref of listFiles(repoRoot, ".pi/skills", (candidate) => candidate.endsWith("/SKILL.md"), 80)) pushEntry(skills, repoRoot, ref, "skill");
  for (const ref of listFiles(repoRoot, ".pi/prompts", (candidate) => candidate.endsWith(".md"), 80)) pushEntry(prompts, repoRoot, ref, "prompt");
  for (const ref of listFiles(repoRoot, ".pi/agents", (candidate) => candidate.endsWith(".md"), 120)) pushEntry(agents, repoRoot, ref, "agent");
  for (const ref of listFiles(repoRoot, ".pi/output-contracts", (candidate) => candidate.endsWith(".json"), 120)) pushEntry(outputContracts, repoRoot, ref, "output_contract");

  const roleRefs = [definition.orchestrator, ...definition.leads, ...definition.workers].map((role) => ({
    roleId: role.id,
    agent: role.agent,
    agentRef: `.pi/agents/${safeFileStem(role.agent)}.md`,
    outputContractRef: `.pi/output-contracts/${safeFileStem(role.outputContract)}.json`,
  }));

  return {
    schema: "zob.guidance-index.v1",
    schemaVersion: BODY_FREE_SCHEMA_VERSION,
    rootDocs,
    layerDocs,
    rules,
    skills,
    prompts,
    agents,
    outputContracts,
    roleRefs,
    totalRefs: rootDocs.length + layerDocs.length + rules.length + skills.length + prompts.length + agents.length + outputContracts.length,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function allRoles(definition: TeamDefinition, profileDefinition?: OrchestrationProfileDefinition): RoleLike[] {
  const profileRoles = new Map<string, { roleType?: string; modelClass?: string }>();
  if (profileDefinition) {
    profileRoles.set(profileDefinition.orchestrator.id, { roleType: profileDefinition.orchestrator.roleType, modelClass: profileDefinition.orchestrator.modelClass });
    for (const role of profileDefinition.roles) profileRoles.set(role.id, { roleType: role.roleType, modelClass: role.modelClass });
  }
  const roles: RoleLike[] = [
    { ...definition.orchestrator, roleType: "orchestrator" },
    ...definition.leads.map((role) => ({ ...role, roleType: "lead" })),
    ...definition.workers.map((role) => ({ ...role, roleType: "worker" })),
  ];
  return roles.map((role) => ({ ...role, ...profileRoles.get(role.id) }));
}

const DEFAULT_MODEL_CLASSES: Record<string, Record<string, unknown>> = {
  cheap_scout: { description: "Fast low-risk exploration", downgradeAllowed: true },
  balanced_worker: { description: "Standard execution and QA", downgradeAllowed: true },
  strong_reasoning: { description: "Planning, orchestration, architecture", downgradeAllowed: false },
  strong_oracle: { description: "Critical validation, oracle, security", downgradeAllowed: false },
  high_context: { description: "Large-context synthesis and documentation", downgradeAllowed: false },
};

function chooseModelClass(role: RoleLike): string {
  const text = `${role.id} ${role.agent} ${role.outputContract} ${role.roleType ?? ""}`.toLowerCase();
  const profileModelClass = (role as unknown as Record<string, unknown>).modelClass;
  if (typeof profileModelClass === "string" && profileModelClass.length > 0) return profileModelClass;
  if (text.includes("oracle") || text.includes("security") || text.includes("validation")) return "strong_oracle";
  if (role.roleType === "orchestrator" || role.roleType === "lead" || text.includes("planner")) return "strong_reasoning";
  if (text.includes("explore") || text.includes("scout")) return "cheap_scout";
  if (text.includes("context") || text.includes("documentation") || text.includes("doc")) return "high_context";
  return "balanced_worker";
}

function buildAdaptiveModelPolicy(runId: string, definition: TeamDefinition, profileDefinition?: OrchestrationProfileDefinition): Record<string, unknown> {
  const classes = isRecord(profileDefinition?.modelPolicy?.classes) && Object.keys(profileDefinition?.modelPolicy?.classes ?? {}).length > 0
    ? profileDefinition?.modelPolicy?.classes as Record<string, unknown>
    : DEFAULT_MODEL_CLASSES;
  const roleAssignments = allRoles(definition, profileDefinition).map((role) => {
    const modelClass = chooseModelClass(role);
    const classConfig = isRecord(classes[modelClass]) ? classes[modelClass] as Record<string, unknown> : {};
    return {
      roleId: role.id,
      roleType: role.roleType ?? "role",
      agent: role.agent,
      outputContract: role.outputContract,
      modelClass,
      downgradeAllowed: classConfig.downgradeAllowed === true,
      reasonHash: sha256(JSON.stringify({ roleId: role.id, roleType: role.roleType, agent: role.agent, outputContract: role.outputContract, modelClass })),
    };
  });
  return {
    schema: "zob.adaptive-model-policy.v1",
    runId,
    source: profileDefinition?.modelPolicy ? "orchestration_profile" : "runtime_defaults",
    classes,
    layers: {
      root: roleAssignments.filter((role) => role.roleType === "orchestrator").map((role) => role.modelClass),
      leads: roleAssignments.filter((role) => role.roleType === "lead").map((role) => role.modelClass),
      workers: roleAssignments.filter((role) => role.roleType === "worker").map((role) => role.modelClass),
      tempAgentCreator: "strong_reasoning",
      oracleSecurity: "strong_oracle",
    },
    roleAssignments,
    downgradePolicy: "blocked_for_oracle_security",
    criticalNoDowngradeRoles: roleAssignments.filter((role) => role.modelClass === "strong_oracle" || role.modelClass === "strong_reasoning").map((role) => role.roleId),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function buildAdaptiveCaps(input: AdaptiveWorkflowArtifactsInput): Record<string, unknown> {
  const caps = isRecord(input.computeProfile.caps) ? input.computeProfile.caps : {};
  const effectiveProfile = asString(input.computeProfile.effectiveProfile, "low");
  const maxDelegationDepth = asNumber(caps.maxDelegationDepth, input.adaptiveDelegation.runtimeMaxDepth ?? 1);
  const maxTotalAgents = asNumber(caps.maxAgents, input.adaptiveDelegation.maxTotalAgents ?? Math.max(1, input.definition.leads.length + input.definition.workers.length + 1));
  const highProfile = profileRank(effectiveProfile) >= profileRank("high");
  return {
    schema: "zob.adaptive-workflow-caps.v1",
    maxTodoDepth: Math.max(2, maxDelegationDepth + 2),
    maxDelegationDepth,
    maxChildrenPerTodo: input.adaptiveDelegation.nodeFanoutMax,
    maxTotalAgents,
    maxParallelAgents: asNumber(caps.maxParallel, input.adaptiveDelegation.globalParallelMax ?? 1),
    maxAgentsPerWave: Math.max(1, Math.min(asNumber(caps.maxParallel, input.adaptiveDelegation.globalParallelMax ?? 1), input.adaptiveDelegation.globalParallelMax ?? 1, maxTotalAgents)),
    maxIterations: asNumber(caps.maxIterations, 1),
    maxDurationMs: caps.maxDurationMs,
    maxCostUsd: caps.maxCostUsd,
    strictBudgetRequired: asBool(caps.strictBudgetRequired, input.adaptiveDelegation.strictBudgetRequired ?? highProfile),
    oracleRequired: asBool(caps.oracleRequired, highProfile || input.adaptiveDelegation.oracle !== "off"),
    humanApprovalRequired: effectiveProfile === "max" || input.adaptiveDelegation.maxTotalAgentsWithOracle > 20,
    sandboxRequiredForWrites: true,
    liveComsRequired: input.execution === "supervised_readonly",
    allowTempAgents: highProfile || input.adaptiveDelegation.maxTotalAgents > 4,
    allowLargeScaleAgentPool: input.adaptiveDelegation.maxTotalAgentsWithOracle > 20,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function buildAdaptiveScalePolicy(input: AdaptiveWorkflowArtifactsInput, caps: Record<string, unknown>): Record<string, unknown> {
  const maxTotalAgents = asNumber(caps.maxTotalAgents, 1);
  const maxParallelAgents = asNumber(caps.maxParallelAgents, 1);
  const maxAgentsPerWave = Math.max(1, asNumber(caps.maxAgentsPerWave, 1));
  const maxWaves = Math.max(1, Math.ceil(maxTotalAgents / maxAgentsPerWave));
  const highScale = input.adaptiveDelegation.maxTotalAgentsWithOracle > 20 || maxTotalAgents > 20;
  return {
    schema: "zob.adaptive-scale-policy.v1",
    runId: input.runId,
    requestedScale: highScale ? "large" : "default",
    maxTotalAgents,
    maxTotalAgentsWithOracle: input.adaptiveDelegation.maxTotalAgentsWithOracle,
    maxParallelAgents,
    maxAgentsPerWave,
    maxWaves,
    waveSchedulerRequired: true,
    requiresBudget: caps.strictBudgetRequired === true,
    requiresScaleApproval: highScale,
    scaleApprovalPresent: Boolean(input.adaptiveDelegation.scaleApproval),
    requiresOracleAfterWave: highScale || caps.oracleRequired === true,
    duplicateDetectionRequired: true,
    stalePeerBlocksCompletion: true,
    blocks: highScale && !input.adaptiveDelegation.scaleApproval ? ["scale_approval_missing"] : [],
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function buildAdaptivePromptPolicy(input: AdaptiveWorkflowArtifactsInput, caps: Record<string, unknown>): { policy: Record<string, unknown>; stackHashes: Record<string, unknown> } {
  const components = [
    { name: "root_non_coding", hash: sha256("root cannot edit/write/bash directly in Chief Vision/orchestrator mode"), required: true },
    { name: "goal_hash", hash: sha256(input.goal), required: true },
    { name: "original_user_ask_hash", hash: sha256(input.originalUserAsk), required: true },
    { name: "todo_graph_policy", hash: sha256("all delegations/messages/evidence attach to TODO nodes when goal TODOs are active"), required: true },
    { name: "compute_caps", hash: sha256(JSON.stringify(caps)), required: true },
    { name: "model_policy", hash: sha256("model policy artifact required per layer/agent"), required: true },
    { name: "documentation_policy", hash: sha256("documentation policy and guidance index required for multi-layer runs"), required: true },
    { name: "temp_agent_policy", hash: sha256("temp agents are run-scoped proposal-only until validated"), required: true },
    { name: "no_ship_gates", hash: sha256("no completion without evidence/oracle/no_ship=false"), required: true },
  ];
  return {
    policy: {
      schema: "zob.adaptive-prompt-policy.v1",
      runId: input.runId,
      rootRoleId: input.definition.orchestrator.id,
      rootMode: "chief_vision_orchestrator",
      rootCanWriteDirectly: false,
      rootDirectWriteToolsBlocked: ["bash", "edit", "write"],
      delegationToolsParentOwned: true,
      promptBodiesStored: false,
      outputBodiesStored: false,
      bodyStored: false,
      components,
    },
    stackHashes: {
      schema: "zob.prompt-stack-hashes.v1",
      runId: input.runId,
      algorithm: "sha256",
      components,
      stackHash: sha256(JSON.stringify(components.map((component) => [component.name, component.hash]))),
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    },
  };
}

function buildDocumentationPolicy(runId: string, definition: TeamDefinition, guidanceIndex: Record<string, unknown>): Record<string, unknown> {
  const rootDocs = Array.isArray(guidanceIndex.rootDocs) ? guidanceIndex.rootDocs.filter(isRecord).map((doc) => doc.ref).filter((ref): ref is string => typeof ref === "string") : [];
  const layerDocRefs = Array.isArray(guidanceIndex.layerDocs) ? guidanceIndex.layerDocs.filter(isRecord).map((doc) => doc.ref).filter((ref): ref is string => typeof ref === "string") : [];
  const ruleRefs = Array.isArray(guidanceIndex.rules) ? guidanceIndex.rules.filter(isRecord).map((doc) => doc.ref).filter((ref): ref is string => typeof ref === "string") : [];
  const roleDocs = [definition.orchestrator, ...definition.leads, ...definition.workers].map((role) => ({
    roleId: role.id,
    refs: [
      `.pi/agents/${safeFileStem(role.agent)}.md`,
      `.pi/output-contracts/${safeFileStem(role.outputContract)}.json`,
      ...ruleRefs.slice(0, 4),
    ].filter(isSafeGuidancePath),
  }));
  return {
    schema: "zob.adaptive-documentation-policy.v1",
    runId,
    rootDocs,
    layerDocs: [
      { layerId: "project-root", paths: rootDocs, appliesToRoles: [definition.orchestrator.id, ...definition.leads.map((lead) => lead.id)] },
      { layerId: "runtime-layers", paths: layerDocRefs, appliesToRoles: [definition.orchestrator.id, ...definition.leads.map((lead) => lead.id), ...definition.workers.map((worker) => worker.id)] },
      { layerId: "rules", paths: ruleRefs, appliesToRoles: [definition.orchestrator.id, ...definition.leads.map((lead) => lead.id), ...definition.workers.map((worker) => worker.id)] },
    ],
    roleDocs,
    runDocs: ["adaptive-workflow-run.json", "prompt-policy.json", "prompt-stack-hashes.json", "model-policy.json", "scale-policy.json", "documentation-policy.json", "guidance-index.json"],
    writebackPolicy: "human_approval_required",
    maxDocsPerAgent: 12,
    maxDocContextTokens: 4000,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function buildDocPacks(definition: TeamDefinition, documentationPolicy: Record<string, unknown>, guidanceIndex: Record<string, unknown>): { layerDocPack: Record<string, unknown>; roleDocPacks: Record<string, unknown>; writebackProposals: Record<string, unknown> } {
  const maxDocs = asNumber(documentationPolicy.maxDocsPerAgent, 12);
  const layerDocPack = {
    schema: "zob.layer-doc-pack.v1",
    layers: documentationPolicy.layerDocs,
    guidanceIndexHash: sha256(JSON.stringify(guidanceIndex)),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const roleDocPacks = {
    schema: "zob.role-doc-packs.v1",
    packs: [definition.orchestrator, ...definition.leads, ...definition.workers].map((role) => {
      const roleDoc = Array.isArray(documentationPolicy.roleDocs) ? documentationPolicy.roleDocs.find((doc) => isRecord(doc) && doc.roleId === role.id) : undefined;
      const refs = isRecord(roleDoc) && Array.isArray(roleDoc.refs) ? roleDoc.refs.filter((ref): ref is string => typeof ref === "string").slice(0, maxDocs) : [];
      return { roleId: role.id, agent: role.agent, refs, guidanceIndexHash: sha256(JSON.stringify({ roleId: role.id, refs })), bodyStored: false };
    }),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const writebackProposals = {
    schema: "zob.doc-writeback-proposal-set.v1",
    proposals: [],
    writebackPolicy: documentationPolicy.writebackPolicy,
    durableWritesPerformed: false,
    autoPromotion: false,
    requiresReview: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  return { layerDocPack, roleDocPacks, writebackProposals };
}

function buildTempAgentRoster(input: AdaptiveWorkflowArtifactsInput, caps: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "zob.temp-agent-roster.v1",
    runId: input.runId,
    allowTempAgents: caps.allowTempAgents === true,
    requestKind: "AGENT_CREATE_REQUEST.v1",
    tempAgentCardSchema: "zob.temp-agent-card.v1",
    tempAgents: [],
    pendingCreateRequests: [],
    durableAgentWritesPerformed: false,
    promotionStatus: "proposal",
    promotionRequires: ["run_finished", "oracle_PASS_no_ship_false", "repeated_usefulness", "human_approval", "smoke_test"],
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function buildFactoryCandidate(input: AdaptiveWorkflowArtifactsInput): Record<string, unknown> {
  return {
    schema: "zob.workflow-to-factory-candidate.v1",
    runId: input.runId,
    candidateStatus: "not_candidate_until_workflow_validated",
    repeatableWorkflowDetected: false,
    promotionReady: false,
    promotionPerformed: false,
    requiresSmoke: true,
    requiresPilot: true,
    requiresOracle: true,
    requiresHumanApproval: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function buildWorkflowRun(input: AdaptiveWorkflowArtifactsInput, caps: Record<string, unknown>): Record<string, unknown> {
  const requestedProfile = asString(input.computeProfile.requestedProfile, input.input.compute_profile ?? "auto");
  const effectiveProfile = asString(input.computeProfile.effectiveProfile, "low");
  return {
    schema: "zob.adaptive-workflow-run.v1",
    runId: input.runId,
    goalHash: sha256(input.goal),
    originalUserAskHash: sha256(input.originalUserAsk),
    goalStored: false,
    rootRole: "chief_vision",
    rootRoleId: input.definition.orchestrator.id,
    status: "planning",
    completionClaim: "not_complete",
    rootCompletionRequiresOracle: true,
    executionMode: input.execution,
    liveExecutionStatus: input.execution === "supervised_readonly" ? "supervised_readonly_metadata_only" : "not_started",
    writeCapableExecution: false,
    durableWritesPerformed: false,
    requestedComputeProfile: requestedProfile,
    effectiveComputeProfile: effectiveProfile,
    caps,
    todoGraphRef: input.input.todo_id ? `goal:${input.input.goal_id ?? "active"}/todo:${input.input.todo_id}` : "runtime-goal-todos-if-active",
    todoGraphBinding: input.input.todo_id ? { goalId: input.input.goal_id, rootTodoId: input.input.todo_id, parentOwned: true, attachmentPolicy: "messages_delegations_blockers_claims_evidence_attach_to_todo", bodyStored: false } : undefined,
    roomRef: "room/room.json",
    factoryCandidateRef: "factory-candidate.json",
    artifacts: ["prompt-policy.json", "prompt-stack-hashes.json", "model-policy.json", "scale-policy.json", "documentation-policy.json", "guidance-index.json", "agents/temp-agent-cards.json"],
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function hasForbiddenBodyKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKeys(child));
}

function bodyFlagsFalse(value: unknown): boolean {
  return isRecord(value) && value.bodyStored === false && value.promptBodiesStored === false && value.outputBodiesStored === false;
}

export function validateAdaptiveWorkflowArtifacts(artifacts: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [name, artifact] of Object.entries(artifacts)) {
    if (!isRecord(artifact)) {
      errors.push(`${name} must be an object`);
      continue;
    }
    if (!bodyFlagsFalse(artifact)) errors.push(`${name} must keep bodyStored/promptBodiesStored/outputBodiesStored false`);
    if (hasForbiddenBodyKeys(artifact)) errors.push(`${name} contains forbidden raw body-like keys`);
  }
  const workflowRun = artifacts.workflowRun;
  const promptPolicy = artifacts.promptPolicy;
  const modelPolicy = artifacts.modelPolicy;
  const scalePolicy = artifacts.scalePolicy;
  const documentationPolicy = artifacts.documentationPolicy;
  const guidanceIndex = artifacts.guidanceIndex;
  const writebackProposals = artifacts.writebackProposals;
  const tempAgentRoster = artifacts.tempAgentRoster;
  const factoryCandidate = artifacts.factoryCandidate;
  if (!isRecord(workflowRun) || workflowRun.schema !== "zob.adaptive-workflow-run.v1") errors.push("workflowRun schema mismatch");
  if (isRecord(workflowRun)) {
    if (workflowRun.status === "complete" || workflowRun.completionClaim === "complete") errors.push("workflowRun must not claim root completion");
    if (workflowRun.rootCompletionRequiresOracle !== true) errors.push("workflowRun root completion must require oracle");
    if (workflowRun.writeCapableExecution !== false || workflowRun.durableWritesPerformed !== false) errors.push("workflowRun must not claim write-capable or durable execution");
    if (!["not_started", "supervised_readonly_metadata_only"].includes(asString(workflowRun.liveExecutionStatus, ""))) errors.push("workflowRun liveExecutionStatus must avoid live completion overclaim");
  }
  if (!isRecord(promptPolicy) || promptPolicy.rootCanWriteDirectly !== false) errors.push("promptPolicy must block direct root coding");
  if (!isRecord(modelPolicy) || modelPolicy.downgradePolicy !== "blocked_for_oracle_security") errors.push("modelPolicy must block oracle/security downgrades");
  if (!isRecord(scalePolicy) || scalePolicy.stalePeerBlocksCompletion !== true || scalePolicy.duplicateDetectionRequired !== true) errors.push("scalePolicy must require stale/duplicate safeguards");
  if (isRecord(scalePolicy) && scalePolicy.requestedScale !== "default" && scalePolicy.requiresScaleApproval !== true) errors.push("large scale requires explicit scale approval gate");
  if (!isRecord(documentationPolicy) || !Array.isArray(documentationPolicy.roleDocs) || documentationPolicy.writebackPolicy !== "human_approval_required") errors.push("documentationPolicy must include role docs and human-approved durable writeback");
  if (!isRecord(guidanceIndex) || asNumber(guidanceIndex.totalRefs, 0) < 1) errors.push("guidanceIndex must include at least one guidance ref");
  if (!isRecord(writebackProposals) || writebackProposals.writebackPolicy !== "human_approval_required" || writebackProposals.durableWritesPerformed !== false || writebackProposals.autoPromotion !== false || writebackProposals.requiresReview !== true) errors.push("writebackProposals must remain proposal-only with human review and no durable writes");
  if (!isRecord(tempAgentRoster) || tempAgentRoster.durableAgentWritesPerformed !== false || tempAgentRoster.promotionStatus !== "proposal") errors.push("tempAgentRoster must remain proposal-only and must not perform durable agent writes");
  if (isRecord(tempAgentRoster)) {
    const promotionRequires = Array.isArray(tempAgentRoster.promotionRequires) ? tempAgentRoster.promotionRequires : [];
    for (const requiredGate of ["oracle_PASS_no_ship_false", "human_approval", "smoke_test"]) {
      if (!promotionRequires.includes(requiredGate)) errors.push(`tempAgentRoster promotion must require ${requiredGate}`);
    }
  }
  if (!isRecord(factoryCandidate) || factoryCandidate.promotionPerformed !== false || factoryCandidate.requiresOracle !== true || factoryCandidate.requiresHumanApproval !== true) errors.push("factoryCandidate must not promote without oracle and human approval gates");
  return errors;
}

function writeJson(runDir: string, relativePath: string, value: Record<string, unknown>): string {
  const absolute = join(runDir, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(value, null, 2), "utf8");
  return relativePath;
}

function ensureSubdirs(runDir: string): void {
  mkdirSync(join(runDir, "agents"), { recursive: true });
  mkdirSync(join(runDir, "docs"), { recursive: true });
}

export function writeAdaptiveWorkflowArtifacts(input: AdaptiveWorkflowArtifactsInput): AdaptiveWorkflowArtifactsResult {
  ensureSubdirs(input.runDir);
  const caps = buildAdaptiveCaps(input);
  const workflowRun = buildWorkflowRun(input, caps);
  const modelPolicy = buildAdaptiveModelPolicy(input.runId, input.definition, input.profileDefinition);
  const scalePolicy = buildAdaptiveScalePolicy(input, caps);
  const { policy: promptPolicy, stackHashes } = buildAdaptivePromptPolicy(input, caps);
  const guidanceIndex = buildGuidanceIndex(input.repoRoot, input.definition);
  const documentationPolicy = buildDocumentationPolicy(input.runId, input.definition, guidanceIndex);
  const { layerDocPack, roleDocPacks, writebackProposals } = buildDocPacks(input.definition, documentationPolicy, guidanceIndex);
  const tempAgentRoster = buildTempAgentRoster(input, caps);
  const factoryCandidate = buildFactoryCandidate(input);
  const artifactSet = { workflowRun, promptPolicy, stackHashes, modelPolicy, scalePolicy, documentationPolicy, guidanceIndex, layerDocPack, roleDocPacks, writebackProposals, tempAgentRoster, factoryCandidate };
  const validationErrors = validateAdaptiveWorkflowArtifacts(artifactSet);
  const validationSummary = {
    schema: "zob.adaptive-workflow-artifacts-validation.v1",
    runId: input.runId,
    valid: validationErrors.length === 0,
    errors: validationErrors,
    rootNonCoding: promptPolicy.rootCanWriteDirectly === false,
    modelPolicyPresent: true,
    scalePolicyPresent: true,
    documentationPolicyPresent: true,
    tempAgentRosterPresent: true,
    factoryCandidatePresent: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const artifacts = [
    writeJson(input.runDir, "adaptive-workflow-run.json", workflowRun),
    writeJson(input.runDir, "prompt-policy.json", promptPolicy),
    writeJson(input.runDir, "prompt-stack-hashes.json", stackHashes),
    writeJson(input.runDir, "model-policy.json", modelPolicy),
    writeJson(input.runDir, "scale-policy.json", scalePolicy),
    writeJson(input.runDir, "documentation-policy.json", documentationPolicy),
    writeJson(input.runDir, "guidance-index.json", guidanceIndex),
    writeJson(input.runDir, "agents/temp-agent-cards.json", tempAgentRoster),
    writeJson(input.runDir, "docs/layer-doc-pack.json", layerDocPack),
    writeJson(input.runDir, "docs/role-doc-packs.json", roleDocPacks),
    writeJson(input.runDir, "docs/writeback-proposals.json", writebackProposals),
    writeJson(input.runDir, "factory-candidate.json", factoryCandidate),
    writeJson(input.runDir, "adaptive-workflow-validation.json", validationSummary),
  ];
  return {
    artifacts,
    context: {
      schema: "zob.adaptive-workflow-context.v1",
      runId: input.runId,
      adaptiveWorkflowRefs: artifacts,
      modelPolicyRef: "model-policy.json",
      scalePolicyRef: "scale-policy.json",
      documentationPolicyRef: "documentation-policy.json",
      guidanceIndexRef: "guidance-index.json",
      tempAgentRosterRef: "agents/temp-agent-cards.json",
      promptPolicyRef: "prompt-policy.json",
      rootNonCoding: true,
      parentOwnedDispatch: true,
      childDirectDispatch: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    },
    validationSummary,
  };
}
