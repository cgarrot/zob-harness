import { createHmac, createHash } from "node:crypto";

import type { WheelFleetV5Intake, WheelStoryExecution } from "../../adapters/fleet-v5.js";
import {
  WHEEL_FIXED_ROLE_ROUTES,
  WHEEL_MODEL_AUDIT,
  WHEEL_MODEL_ROUTES,
  WHEEL_RANDOMIZED_ROLE_POOLS,
  type WheelModelFamily,
  type WheelModelRoute,
  type WheelModelRouteId,
  type WheelProviderId,
  type WheelRandomizedRolePool,
  type WheelThinkingLevel,
} from "../../model-policy/model-registry.js";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const LOW_BUDGET_TOKENS = 4096;
const HIGH_BUDGET_TOKENS = 16384;

export interface WheelEligibilityPolicy {
  minContextTokens?: number;
  requireVision?: boolean;
  maxOutputPriceUsdPerMillion?: number;
  forbiddenProviders?: WheelProviderId[];
  forbiddenFamilies?: WheelModelFamily[];
}

export type WheelThinkingControl =
  | { kind: "pi-level"; level: WheelThinkingLevel; advisory: false }
  | { kind: "reasoning_effort"; reasoning_effort: WheelThinkingLevel; advisory: false }
  | { kind: "budget_tokens"; thinking: { type: "enabled"; budget_tokens: number }; advisory: boolean };

export interface WheelPrivateRouteCandidate {
  routeId: WheelModelRouteId;
  family: WheelModelFamily;
  provider: WheelProviderId;
  messageRoleFormat: WheelModelRoute["messageRoleFormat"];
  thinkingControl: WheelThinkingControl;
}

export interface WheelRoleAssignmentPlan {
  rolePool: WheelRandomizedRolePool;
  required: boolean;
  requestedThinking: WheelThinkingLevel;
  independentFromDevelopment: boolean;
  selected: WheelPrivateRouteCandidate;
  candidates: WheelPrivateRouteCandidate[];
  excluded: Array<{ routeIdHash: string; reason: string }>;
}

export interface WheelStoryMissionPlan {
  storyId: string;
  revision: number;
  contextLoad: WheelStoryExecution["signals"]["contextLoad"];
  parallelizable: boolean;
  humanCheckpointRequired: boolean;
  roleAssignments: WheelRoleAssignmentPlan[];
}

export interface WheelProtectedMissionPlan {
  schema: "wheel.zob.protected-mission-plan.v1";
  missionId: string;
  bundleId: string;
  seedCommitment: string;
  registryAuditRef: string;
  orchestrator: WheelPrivateRouteCandidate;
  stories: WheelStoryMissionPlan[];
  bodyStored: false;
  protectedModelIdentity: true;
  dispatchEnabled: false;
  githubEffectsEnabled: false;
  factoryActivationEnabled: false;
}

export interface WheelPublicMissionPlan {
  schema: "wheel.zob.public-mission-plan.v1";
  missionId: string;
  bundleId: string;
  seedCommitment: string;
  storyCount: number;
  stories: Array<{
    storyId: string;
    revision: number;
    roleAssignments: Array<{
      rolePool: WheelRandomizedRolePool;
      required: boolean;
      requestedThinking: WheelThinkingLevel;
      independentFromDevelopment: boolean;
      candidateCount: number;
      selectedRouteHash: string;
      candidateRouteHashes: string[];
    }>;
  }>;
  bodyStored: false;
  modelIdentityStored: false;
  dispatchEnabled: false;
}

export interface WheelMissionPlanningInput {
  missionId: string;
  intake: WheelFleetV5Intake;
  eligibility?: WheelEligibilityPolicy;
}

export interface WheelMissionPlanningFailure {
  schema: "wheel.zob.mission-planning-failure.v1";
  planned: false;
  errors: string[];
  bodyStored: false;
}

export type WheelMissionPlanningResult =
  | { planned: true; protectedPlan: WheelProtectedMissionPlan; publicPlan: WheelPublicMissionPlan }
  | WheelMissionPlanningFailure;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class DeterministicRng {
  private counter = 0;
  private cache: number[] = [];

  constructor(private readonly seed: string, private readonly domain: string) {}

  private refill(): void {
    const digest = createHmac("sha256", this.seed).update(`${this.domain}:${this.counter++}`).digest();
    this.cache = [];
    for (let offset = 0; offset + 4 <= digest.length; offset += 4) this.cache.push(digest.readUInt32BE(offset));
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error("maxExclusive must be a positive integer");
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    while (true) {
      if (this.cache.length === 0) this.refill();
      const value = this.cache.pop() as number;
      if (value < limit) return value % maxExclusive;
    }
  }
}

function deterministicShuffle<T>(values: readonly T[], seed: string, domain: string): T[] {
  const result = [...values];
  const rng = new DeterministicRng(seed, domain);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = rng.nextInt(index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function contextMinimum(story: WheelStoryExecution): number {
  if (story.signals.contextLoad === "high") return 120000;
  if (story.signals.contextLoad === "medium") return 96000;
  return 32000;
}

function isDocumentationRequired(story: WheelStoryExecution): boolean {
  if (story.profile.base === "docs-process") return true;
  const values = [...story.profile.overlays, ...story.signals.domains, ...story.signals.surfaces, ...story.signals.testDemands].map((value) => value.toLowerCase());
  return values.some((value) => value.includes("doc") || value.includes("content") || value.includes("manual"));
}

function thinkingForRole(rolePool: WheelRandomizedRolePool): WheelThinkingLevel {
  return rolePool === "formal-blind-review" || rolePool === "repository-assurance" ? "high" : "low";
}

export function buildWheelThinkingControl(route: WheelModelRoute, level: WheelThinkingLevel): WheelThinkingControl {
  if (!route.thinking.verifiedLevels.includes(level)) throw new Error(`${route.id} does not have verified thinking level ${level}`);
  if (route.thinking.format === "pi-level") return { kind: "pi-level", level, advisory: false };
  if (route.thinking.format === "reasoning_effort") return { kind: "reasoning_effort", reasoning_effort: level, advisory: false };
  return {
    kind: "budget_tokens",
    thinking: { type: "enabled", budget_tokens: level === "high" ? HIGH_BUDGET_TOKENS : LOW_BUDGET_TOKENS },
    advisory: route.thinking.advisory,
  };
}

function hardEligible(route: WheelModelRoute, policy: WheelEligibilityPolicy, minContextTokens: number): string | undefined {
  if (!route.verified) return "route_not_verified";
  if (route.contextTokens < Math.max(minContextTokens, policy.minContextTokens ?? 0)) return "context_too_small";
  if (policy.requireVision === true && !route.vision) return "vision_required";
  if (policy.forbiddenProviders?.includes(route.provider)) return "provider_forbidden";
  if (policy.forbiddenFamilies?.includes(route.family)) return "family_forbidden";
  const maxOutputPrice = policy.maxOutputPriceUsdPerMillion;
  if (typeof maxOutputPrice === "number") {
    const price = route.pricingUsdPerMillion.output;
    if (price === null || price > maxOutputPrice) return "output_price_exceeds_cap";
  }
  return undefined;
}

function routeCandidate(route: WheelModelRoute, level: WheelThinkingLevel): WheelPrivateRouteCandidate {
  return {
    routeId: route.id as WheelModelRouteId,
    family: route.family,
    provider: route.provider,
    messageRoleFormat: route.messageRoleFormat,
    thinkingControl: buildWheelThinkingControl(route, level),
  };
}

function requiredRolePools(story: WheelStoryExecution): Array<{ pool: WheelRandomizedRolePool; required: boolean }> {
  return [
    { pool: "development", required: true },
    { pool: "qa", required: true },
    { pool: "documentation", required: isDocumentationRequired(story) },
    { pool: "internal-review", required: true },
    { pool: "formal-blind-review", required: true },
    { pool: "repository-assurance", required: true },
  ];
}

function buildPoolPlan(
  story: WheelStoryExecution,
  pool: WheelRandomizedRolePool,
  required: boolean,
  seed: string,
  policy: WheelEligibilityPolicy,
  developmentFamily?: WheelModelFamily,
): WheelRoleAssignmentPlan | string {
  const requestedThinking = thinkingForRole(pool);
  const excluded: Array<{ routeIdHash: string; reason: string }> = [];
  const baseRoutes = WHEEL_RANDOMIZED_ROLE_POOLS[pool].map((routeId) => WHEEL_MODEL_ROUTES[routeId]);
  const independentFromDevelopment = (pool === "qa" || pool === "formal-blind-review") && developmentFamily !== undefined;
  const eligible: WheelModelRoute[] = [];
  const independentFallback: WheelModelRoute[] = [];

  for (const route of baseRoutes) {
    const reason = hardEligible(route, policy, contextMinimum(story));
    if (reason) {
      excluded.push({ routeIdHash: sha256(route.id), reason });
      continue;
    }
    if (independentFromDevelopment && route.family === developmentFamily) {
      independentFallback.push(route);
      excluded.push({ routeIdHash: sha256(route.id), reason: "same_family_as_development" });
      continue;
    }
    eligible.push(route);
  }

  const candidates = eligible.length > 0 ? eligible : independentFallback;
  if (candidates.length === 0) return `${story.storyId}:${pool} has no hard-eligible routes`;
  if (required && candidates.length < 1) return `${story.storyId}:${pool} required pool is empty`;
  const shuffled = deterministicShuffle(candidates, seed, `wheel-zob:model-order:${story.storyId}:${pool}`);
  const mapped = shuffled.map((route) => routeCandidate(route, requestedThinking));
  return {
    rolePool: pool,
    required,
    requestedThinking,
    independentFromDevelopment: independentFromDevelopment && eligible.length > 0,
    selected: mapped[0],
    candidates: mapped,
    excluded,
  };
}

export function publicWheelMissionPlan(plan: WheelProtectedMissionPlan): WheelPublicMissionPlan {
  return {
    schema: "wheel.zob.public-mission-plan.v1",
    missionId: plan.missionId,
    bundleId: plan.bundleId,
    seedCommitment: plan.seedCommitment,
    storyCount: plan.stories.length,
    stories: plan.stories.map((story) => ({
      storyId: story.storyId,
      revision: story.revision,
      roleAssignments: story.roleAssignments.map((assignment) => ({
        rolePool: assignment.rolePool,
        required: assignment.required,
        requestedThinking: assignment.requestedThinking,
        independentFromDevelopment: assignment.independentFromDevelopment,
        candidateCount: assignment.candidates.length,
        selectedRouteHash: sha256(assignment.selected.routeId),
        candidateRouteHashes: assignment.candidates.map((candidate) => sha256(candidate.routeId)),
      })),
    })),
    bodyStored: false,
    modelIdentityStored: false,
    dispatchEnabled: false,
  };
}

export function planWheelMission(input: WheelMissionPlanningInput): WheelMissionPlanningResult {
  const errors: string[] = [];
  if (!SAFE_ID.test(input.missionId)) errors.push("missionId must be path-safe");
  if (!input.intake.accepted) errors.push("Fleet v5 intake must be accepted before planning");
  if (!input.intake.bundleId || !input.intake.missionSeed) errors.push("accepted intake must include bundleId and missionSeed");
  if (errors.length > 0) return { schema: "wheel.zob.mission-planning-failure.v1", planned: false, errors, bodyStored: false };

  const seed = input.intake.missionSeed as string;
  const policy = input.eligibility ?? {};
  const stories: WheelStoryMissionPlan[] = [];

  for (const story of input.intake.stories) {
    const development = buildPoolPlan(story, "development", true, seed, policy);
    if (typeof development === "string") {
      errors.push(development);
      continue;
    }
    const assignments: WheelRoleAssignmentPlan[] = [development];
    for (const role of requiredRolePools(story).slice(1)) {
      const assignment = buildPoolPlan(story, role.pool, role.required, seed, policy, development.selected.family);
      if (typeof assignment === "string") errors.push(assignment);
      else assignments.push(assignment);
    }
    stories.push({
      storyId: story.storyId,
      revision: story.revision,
      contextLoad: story.signals.contextLoad,
      parallelizable: story.signals.parallelizable,
      humanCheckpointRequired: story.signals.humanCheckpoint !== null,
      roleAssignments: assignments,
    });
  }

  if (errors.length > 0) return { schema: "wheel.zob.mission-planning-failure.v1", planned: false, errors, bodyStored: false };
  const orchestratorRoute = WHEEL_MODEL_ROUTES[WHEEL_FIXED_ROLE_ROUTES.orchestrator.routeId];
  const protectedPlan: WheelProtectedMissionPlan = {
    schema: "wheel.zob.protected-mission-plan.v1",
    missionId: input.missionId,
    bundleId: input.intake.bundleId as string,
    seedCommitment: sha256(seed),
    registryAuditRef: WHEEL_MODEL_AUDIT.evidenceRef,
    orchestrator: routeCandidate(orchestratorRoute, WHEEL_FIXED_ROLE_ROUTES.orchestrator.thinking),
    stories,
    bodyStored: false,
    protectedModelIdentity: true,
    dispatchEnabled: false,
    githubEffectsEnabled: false,
    factoryActivationEnabled: false,
  };
  return { planned: true, protectedPlan, publicPlan: publicWheelMissionPlan(protectedPlan) };
}
