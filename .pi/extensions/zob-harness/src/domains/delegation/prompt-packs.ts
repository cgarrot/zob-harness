import { existsSync } from "node:fs";

import { DEFAULT_RULES } from "../../core/constants.js";
import { validateOutputContractId } from "./output-contracts.js";
import { sha256 } from "../../core/utils/hashing.js";
import { pathMatches, resolveRepoPath } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

export type PromptPackRole = "orchestrator" | "factory-selector" | "worker-implementer" | "oracle";

export interface PromptPackContextPolicy {
  contextScopeId: string;
  maxContextTokens: number;
  allowedSources: string[];
  forbiddenSources: string[];
  citationsRequired: true;
}

export interface PromptPackEventPolicy {
  emitStatusOnStart: true;
  emitStatusOnAttentionNeeded: true;
  emitTodoClaimOnDone: true;
  eventContract: "agent-event.v1";
  todoClaimReducerRequired: true;
  parentOwnedActions: true;
  directTodoMutationAllowed: false;
}

export interface PromptPackDefinition {
  schema: "zob.prompt-pack.v1";
  roleId: PromptPackRole;
  purposeHash: string;
  promptRefs: string[];
  skillRefs: string[];
  docRefs: string[];
  outputContract: string;
  contextPolicy: PromptPackContextPolicy;
  eventPolicy: PromptPackEventPolicy;
  launchAuthorizationRequired: true;
  oracleRequiredForCompletion: boolean;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface PromptPackEvalResult {
  roleId: PromptPackRole;
  passed: boolean;
  failedChecks: string[];
  refsChecked: string[];
  outputContract: string;
  maxContextTokens: number;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface PromptPackReport {
  schema: "zob.prompt-pack-eval.v1";
  status: "passed" | "failed";
  runId: string;
  packs: PromptPackDefinition[];
  evals: PromptPackEvalResult[];
  failedChecks: string[];
  no_ship: boolean;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  generatedAt: string;
}

const BODY_LIKE_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "text", "rationale", "diff", "patch", "raw"]);

function forbiddenPlaintextPaths(value: unknown, path = "root"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenPlaintextPaths(item, `${path}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(BODY_LIKE_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...forbiddenPlaintextPaths(child, `${path}.${key}`),
  ]);
}

function contextPolicy(roleId: PromptPackRole, maxContextTokens: number): PromptPackContextPolicy {
  return {
    contextScopeId: `factory-agent-${roleId}`,
    maxContextTokens,
    allowedSources: ["repo-docs", "repo-prompts", "repo-skills", "project-dna-smoke"],
    forbiddenSources: [".env", "**/.env*", "~/.ssh", "~/.aws", "raw-conversation-history", "secrets"],
    citationsRequired: true,
  };
}

function eventPolicy(): PromptPackEventPolicy {
  return {
    emitStatusOnStart: true,
    emitStatusOnAttentionNeeded: true,
    emitTodoClaimOnDone: true,
    eventContract: "agent-event.v1",
    todoClaimReducerRequired: true,
    parentOwnedActions: true,
    directTodoMutationAllowed: false,
  };
}

function pack(roleId: PromptPackRole, purpose: string, promptRefs: string[], skillRefs: string[], docRefs: string[], outputContract: string, maxContextTokens: number, oracleRequiredForCompletion: boolean): PromptPackDefinition {
  return {
    schema: "zob.prompt-pack.v1",
    roleId,
    purposeHash: sha256(purpose),
    promptRefs,
    skillRefs,
    docRefs,
    outputContract,
    contextPolicy: contextPolicy(roleId, maxContextTokens),
    eventPolicy: eventPolicy(),
    launchAuthorizationRequired: true,
    oracleRequiredForCompletion,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function defaultFactoryAgentPromptPacks(): PromptPackDefinition[] {
  return [
    pack(
      "orchestrator",
      "Route a launch-authorized general factory agent run through plan, coms, TODO claims, validation, and oracle gates.",
      [".pi/prompts/adaptive-workflow.md", ".pi/prompts/autonomous-runtime.md", ".pi/prompts/factory.md"],
      [".pi/skills/zob-harness/SKILL.md", ".pi/skills/zob-delegation-routing/SKILL.md", ".pi/skills/zob-goal-todo-tree/SKILL.md", ".pi/skills/zob-coms-v2-live/SKILL.md", ".pi/skills/zob-coms-safety/SKILL.md"],
      ["docs/ZOB_GENERAL_FACTORY_AGENT_L4_L6_MASTER_PLAN.md", "docs/AUTONOMY_LEVELS.md", "docs/ZOB_ROOM_AND_ORCHESTRATOR_TARGET.md"],
      "lead-plan.v1",
      8000,
      true,
    ),
    pack(
      "factory-selector",
      "Select an existing factory or forge a quarantined candidate under launch authorization and strict budget gates.",
      [".pi/prompts/factory.md", ".pi/prompts/spec.md"],
      [".pi/skills/zob-factory/SKILL.md", ".pi/skills/zob-sandbox/SKILL.md", ".pi/skills/zob-compute-profile/SKILL.md"],
      ["docs/ZOB_SOFTWARE_FACTORY_MODE.md", "docs/AUTONOMOUS_SUPER_FACTORY_GOAL.md", "docs/HARNESS_CAPABILITY_MATRIX.md"],
      "factory.v1",
      6000,
      true,
    ),
    pack(
      "worker-implementer",
      "Perform bounded in-scope implementation slices, emit status events, and return TODO claims with evidence rather than mutating parent TODO state.",
      [".pi/prompts/implement.md", ".pi/prompts/adaptive-workflow.md"],
      [".pi/skills/zob-harness/SKILL.md", ".pi/skills/zob-sandbox/SKILL.md", ".pi/skills/zob-coms-v2-live/SKILL.md"],
      ["docs/OPERATING_MODEL.md", "docs/ARCHITECTURE.md", "docs/ZOB_GENERAL_FACTORY_AGENT_L4_L6_MASTER_PLAN.md"],
      "implement.v1",
      6000,
      false,
    ),
    pack(
      "oracle",
      "Skeptically review claims, source freshness, no-ship state, and final release readiness for L4/L5/L6 autonomy.",
      [".pi/prompts/autonomous-runtime.md", ".pi/prompts/spec.md"],
      [".pi/skills/zob-oracle/SKILL.md", ".pi/skills/zob-autonomous-runtime/SKILL.md", ".pi/skills/zob-coms-safety/SKILL.md"],
      ["docs/AUTONOMY_LEVELS.md", "docs/HARNESS_CAPABILITY_MATRIX.md", "docs/ZOB_GENERAL_FACTORY_AGENT_L4_L6_MASTER_PLAN.md"],
      "oracle.v1",
      7000,
      true,
    ),
  ];
}

function validateRefs(repoRoot: string, refs: string[], label: string): string[] {
  const errors: string[] = [];
  for (const ref of refs) {
    const resolved = resolveRepoPath(repoRoot, ref);
    errors.push(...resolved.errors.map((error) => `${label}:${error}`));
    if (resolved.errors.length === 0 && !existsSync(resolved.path)) errors.push(`${label}:missing:${ref}`);
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(ref, protectedPattern, repoRoot, repoRoot)) errors.push(`${label}:zero_access:${protectedPattern}`);
    }
  }
  return errors;
}

export function validatePromptPack(repoRoot: string, promptPack: PromptPackDefinition): PromptPackEvalResult {
  const failedChecks: string[] = [];
  if (promptPack.schema !== "zob.prompt-pack.v1") failedChecks.push("schema");
  if (!promptPack.purposeHash || promptPack.purposeHash.length !== 64) failedChecks.push("purpose_hash");
  failedChecks.push(...validateRefs(repoRoot, promptPack.promptRefs, "prompt_refs"));
  failedChecks.push(...validateRefs(repoRoot, promptPack.skillRefs, "skill_refs"));
  failedChecks.push(...validateRefs(repoRoot, promptPack.docRefs, "doc_refs"));
  failedChecks.push(...validateOutputContractId(promptPack.outputContract).map((error) => `output_contract:${error}`));
  failedChecks.push(...validateOutputContractId(promptPack.eventPolicy.eventContract).map((error) => `event_contract:${error}`));
  if (promptPack.contextPolicy.maxContextTokens <= 0 || promptPack.contextPolicy.maxContextTokens > 8000) failedChecks.push("max_context_tokens");
  if (promptPack.contextPolicy.citationsRequired !== true) failedChecks.push("citations_required");
  if (promptPack.eventPolicy.todoClaimReducerRequired !== true || promptPack.eventPolicy.directTodoMutationAllowed !== false || promptPack.eventPolicy.parentOwnedActions !== true) failedChecks.push("event_policy_parent_owned");
  if (promptPack.launchAuthorizationRequired !== true) failedChecks.push("launch_authorization_required");
  if (promptPack.bodyStored !== false || promptPack.promptBodiesStored !== false || promptPack.outputBodiesStored !== false) failedChecks.push("body_free_flags");
  failedChecks.push(...forbiddenPlaintextPaths(promptPack).map((path) => `body_like_key:${path}`));
  return {
    roleId: promptPack.roleId,
    passed: failedChecks.length === 0,
    failedChecks,
    refsChecked: [...promptPack.promptRefs, ...promptPack.skillRefs, ...promptPack.docRefs],
    outputContract: promptPack.outputContract,
    maxContextTokens: promptPack.contextPolicy.maxContextTokens,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildPromptPackReport(repoRoot: string, runId = "factory-agent-prompt-pack-smoke"): PromptPackReport {
  const packs = defaultFactoryAgentPromptPacks();
  const evals = packs.map((promptPack) => validatePromptPack(repoRoot, promptPack));
  const failedChecks = evals.flatMap((result) => result.failedChecks.map((check) => `${result.roleId}:${check}`));
  const report: PromptPackReport = {
    schema: "zob.prompt-pack-eval.v1",
    status: failedChecks.length === 0 ? "passed" : "failed",
    runId,
    packs,
    evals,
    failedChecks,
    no_ship: failedChecks.length > 0,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const bodyViolations = promptPackBodyFreeViolations(report);
  if (bodyViolations.length > 0) {
    report.status = "failed";
    report.no_ship = true;
    report.failedChecks.push(...bodyViolations.map((path) => `report_body_like_key:${path}`));
  }
  return report;
}

export function promptPackBodyFreeViolations(value: unknown): string[] {
  if (!isRecord(value) && !Array.isArray(value)) return [];
  return forbiddenPlaintextPaths(value);
}
