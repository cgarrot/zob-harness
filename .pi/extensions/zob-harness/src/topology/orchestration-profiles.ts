import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadProjectAgents } from "../agents.js";
import { normalizeAdaptiveDelegationPolicy, validateAdaptiveDelegationPolicy } from "../orchestration/adaptive-delegation.js";
import { validateOutputContractId } from "../output-contracts.js";
import { validateAllowedPathPolicy, validateDelegateTaskWriteScope, validateForbiddenPathPolicy, validateToolList } from "../safety.js";
import type { OrchestrateRunInput, OrchestrationProfileDefinition, OrchestrationProfilePhase, OrchestrationProfileRole, TeamDefinition } from "../types.js";
import { parseJsonFile } from "../utils/json.js";
import { isSafeArtifactName, safeFileStem } from "../utils/paths.js";
import { isRecord } from "../utils/records.js";
import { listZobResourceJsonStems, readableZobResourcePath } from "../utils/resources.js";
import { isStringArray, loadTeamDefinition, validateTeamDefinition } from "./teams.js";

function orchestrationProfilesDir(repoRoot: string): string {
  return join(repoRoot, ".pi", "orchestrations");
}

function isOrchestrationProfileRole(value: unknown): value is OrchestrationProfileRole {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.roleType === "string" &&
    typeof value.agent === "string" &&
    typeof value.outputContract === "string" &&
    (value.modelClass === undefined || typeof value.modelClass === "string") &&
    (value.leadId === undefined || typeof value.leadId === "string") &&
    (value.canDelegateTo === undefined || isStringArray(value.canDelegateTo)) &&
    (value.requiredTools === undefined || isStringArray(value.requiredTools)) &&
    (value.tools === undefined || isStringArray(value.tools)) &&
    (value.allowedPaths === undefined || isStringArray(value.allowedPaths)) &&
    (value.forbiddenPaths === undefined || isStringArray(value.forbiddenPaths)) &&
    (value.rules === undefined || isStringArray(value.rules))
  );
}

function isOrchestrationProfilePhase(value: unknown): value is OrchestrationProfilePhase {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    (value.run === undefined || isStringArray(value.run)) &&
    (value.required === undefined || typeof value.required === "boolean") &&
    (value.requiresOutputContract === undefined || typeof value.requiresOutputContract === "string") &&
    (value.modelClassOverride === undefined || typeof value.modelClassOverride === "string") &&
    (value.noShipOnFail === undefined || typeof value.noShipOnFail === "boolean")
  );
}

function isOrchestrationProfileDefinition(value: unknown): value is OrchestrationProfileDefinition {
  return (
    isRecord(value) &&
    (value.schema === undefined || value.schema === "zob.orchestration-profile.v1") &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    (value.description === undefined || typeof value.description === "string") &&
    isOrchestrationProfileRole(value.orchestrator) &&
    Array.isArray(value.roles) &&
    value.roles.every(isOrchestrationProfileRole) &&
    Array.isArray(value.edges) &&
    value.edges.every((edge) => Array.isArray(edge) && edge.length === 2 && typeof edge[0] === "string" && typeof edge[1] === "string") &&
    Array.isArray(value.phases) &&
    value.phases.every(isOrchestrationProfilePhase) &&
    (value.finalReportRole === undefined || typeof value.finalReportRole === "string")
  );
}

export function listOrchestrationProfiles(repoRoot: string): string[] {
  return listZobResourceJsonStems(repoRoot, "orchestrations");
}

export function loadOrchestrationProfile(repoRoot: string, profileName: string): { definition?: OrchestrationProfileDefinition; profilePath: string; errors: string[] } {
  if (!/^[a-zA-Z0-9._-]+$/.test(profileName)) return { profilePath: join(orchestrationProfilesDir(repoRoot), `${safeFileStem(profileName)}.json`), errors: [`Invalid orchestration profile name '${profileName}'`] };
  const profilePath = readableZobResourcePath(repoRoot, "orchestrations", `${profileName}.json`);
  if (!existsSync(profilePath)) return { profilePath, errors: [`Orchestration profile not found: ${profilePath}`] };
  try {
    const parsed = parseJsonFile(profilePath);
    if (!isOrchestrationProfileDefinition(parsed)) return { profilePath, errors: [`Invalid orchestration profile: ${profilePath}`] };
    if (parsed.name !== profileName) return { profilePath, errors: [`Orchestration profile name '${parsed.name}' does not match requested '${profileName}'`] };
    return { definition: parsed, profilePath, errors: [] };
  } catch (error) {
    return { profilePath, errors: [`Could not parse orchestration profile '${profilePath}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function validateOrchestrationProfile(repoRoot: string, profile: OrchestrationProfileDefinition | undefined): string[] {
  const errors: string[] = [];
  if (!profile) return ["Orchestration profile is missing"];
  if (!isSafeArtifactName(profile.name)) errors.push(`Orchestration profile name must be path-safe: ${profile.name}`);
  const agents = new Map(loadProjectAgents(repoRoot).map((agent) => [agent.name.toLowerCase(), agent]));
  const modelClasses = new Set(Object.keys(profile.modelPolicy?.classes ?? {}));
  if (modelClasses.size === 0) errors.push("Orchestration profile must define modelPolicy.classes");

  const roleIds = new Set<string>();
  const allRoles = [profile.orchestrator, ...profile.roles];
  for (const role of allRoles) {
    if (roleIds.has(role.id)) errors.push(`Duplicate orchestration role id: ${role.id}`);
    roleIds.add(role.id);
    if (!isSafeArtifactName(role.id)) errors.push(`Orchestration role id must be path-safe: ${role.id}`);
    const agent = agents.get(role.agent.toLowerCase());
    if (!agent) {
      errors.push(`Role '${role.id}' references unknown agent '${role.agent}'`);
    } else {
      const tools = role.requiredTools ?? role.tools ?? [];
      errors.push(...validateToolList(agent, tools).map((error) => `Role '${role.id}': ${error}`));
      errors.push(...validateDelegateTaskWriteScope(tools, role.allowedPaths).map((error) => `Role '${role.id}': ${error}`));
    }
    errors.push(...validateAllowedPathPolicy(role.allowedPaths, `Role '${role.id}' allowedPaths`, repoRoot));
    errors.push(...validateForbiddenPathPolicy(role.forbiddenPaths, `Role '${role.id}' forbiddenPaths`, repoRoot));
    errors.push(...validateOutputContractId(role.outputContract).map((error) => `Role '${role.id}': ${error}`));
    if (role.modelClass && !modelClasses.has(role.modelClass)) errors.push(`Role '${role.id}' references unknown modelClass '${role.modelClass}'`);
  }

  const leadIds = new Set(profile.roles.filter((role) => role.roleType === "lead" || role.canDelegateTo !== undefined).map((role) => role.id));
  for (const role of profile.roles) {
    if (role.roleType === "worker" && role.leadId && !leadIds.has(role.leadId)) errors.push(`Worker '${role.id}' references unknown lead '${role.leadId}'`);
    for (const workerId of role.canDelegateTo ?? []) {
      if (!roleIds.has(workerId)) errors.push(`Role '${role.id}' canDelegateTo unknown role '${workerId}'`);
    }
  }

  const seenEdges = new Set<string>();
  for (const [sender, receiver] of profile.edges) {
    const edgeKey = `${sender}->${receiver}`;
    if (seenEdges.has(edgeKey)) errors.push(`Duplicate orchestration edge: ${edgeKey}`);
    seenEdges.add(edgeKey);
    if (!roleIds.has(sender)) errors.push(`Edge sender unknown: ${sender}`);
    if (!roleIds.has(receiver)) errors.push(`Edge receiver unknown: ${receiver}`);
    const senderRole = allRoles.find((role) => role.id === sender);
    const receiverRole = allRoles.find((role) => role.id === receiver);
    if (senderRole?.roleType === "worker" && receiverRole?.roleType === "worker") errors.push(`Worker-to-worker edge requires explicit future policy gate: ${edgeKey}`);
  }

  for (const phase of profile.phases) {
    if (!isSafeArtifactName(phase.id)) errors.push(`Orchestration phase id must be path-safe: ${phase.id}`);
    for (const roleId of phase.run ?? []) {
      if (!roleIds.has(roleId)) errors.push(`Phase '${phase.id}' references unknown role '${roleId}'`);
    }
    if (phase.requiresOutputContract) errors.push(...validateOutputContractId(phase.requiresOutputContract).map((error) => `Phase '${phase.id}': ${error}`));
    if (phase.modelClassOverride && !modelClasses.has(phase.modelClassOverride)) errors.push(`Phase '${phase.id}' references unknown modelClassOverride '${phase.modelClassOverride}'`);
  }
  if (profile.finalReportRole && !roleIds.has(profile.finalReportRole)) errors.push(`finalReportRole references unknown role '${profile.finalReportRole}'`);
  return errors;
}

function roleTools(role: OrchestrationProfileRole): string[] {
  return role.requiredTools ?? role.tools ?? [];
}

export function teamDefinitionFromOrchestrationProfile(profile: OrchestrationProfileDefinition): TeamDefinition {
  const leads = profile.roles.filter((role) => role.roleType === "lead" || role.canDelegateTo !== undefined).map((role) => ({
    id: role.id,
    agent: role.agent,
    description: `Lead role from orchestration profile ${profile.name}`,
    requiredTools: roleTools(role),
    outputContract: role.outputContract,
    workerIds: role.canDelegateTo ?? profile.roles.filter((candidate) => candidate.roleType === "worker" && candidate.leadId === role.id).map((candidate) => candidate.id),
    responsibilities: role.rules,
  }));
  const workers = profile.roles.filter((role) => role.roleType === "worker").map((role) => ({
    id: role.id,
    leadId: role.leadId ?? "",
    agent: role.agent,
    description: `Worker role from orchestration profile ${profile.name}`,
    requiredTools: roleTools(role),
    outputContract: role.outputContract,
    taskTemplate: `Execute profile worker '${role.id}' for goal: {goal}. Return evidence, blockers, compliance, and deliverable_delivered. Run id: {run.id}.`,
  }));
  return {
    name: profile.name,
    version: profile.version,
    description: profile.description ?? `Orchestration profile ${profile.name}`,
    orchestrator: {
      id: profile.orchestrator.id,
      agent: profile.orchestrator.agent,
      description: `Orchestrator role from orchestration profile ${profile.name}`,
      requiredTools: roleTools(profile.orchestrator),
      outputContract: profile.orchestrator.outputContract,
      responsibilities: profile.orchestrator.rules,
    },
    leads,
    workers,
  };
}

export function validateOrchestrateRunInputs(repoRoot: string, input: OrchestrateRunInput): string[] {
  const errors: string[] = [];
  if (!input.goal || input.goal.trim().length === 0) errors.push("goal is required");
  if (input.run_id && safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  if (input.execution !== undefined && input.execution !== "plan_only" && input.execution !== "supervised_smoke" && input.execution !== "supervised_readonly") errors.push("orchestrate_run only supports execution=plan_only, execution=supervised_smoke, or execution=supervised_readonly");
  if (input.max_workers !== undefined && (!Number.isInteger(input.max_workers) || input.max_workers < 1)) errors.push("max_workers must be a positive integer");
  errors.push(...validateAdaptiveDelegationPolicy(normalizeAdaptiveDelegationPolicy(input.adaptive_delegation)));
  if (input.team && input.profile) errors.push("orchestrate_run accepts either team or profile, not both");
  if (input.profile) {
    const profile = loadOrchestrationProfile(repoRoot, input.profile);
    errors.push(...profile.errors);
    errors.push(...validateOrchestrationProfile(repoRoot, profile.definition));
  } else {
    const team = loadTeamDefinition(repoRoot, input.team ?? "zob-core");
    errors.push(...team.errors);
    errors.push(...validateTeamDefinition(repoRoot, team.definition));
  }
  return errors;
}
