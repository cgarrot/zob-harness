const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export const FLEET_V5_SIGNAL_FIELDS = Object.freeze([
  "profileWeights",
  "routeHint",
  "domains",
  "surfaces",
  "blast",
  "securityFlags",
  "diffBreadth",
  "reversibility",
  "verification",
  "testDemands",
  "contextLoad",
  "designFreedom",
  "opsTouch",
  "humanCheckpoint",
  "parallelizable",
  "reviewerGate",
  "escalationTriggers",
] as const);

export type FleetV5SignalField = typeof FLEET_V5_SIGNAL_FIELDS[number];
export type WheelRouteHint = "light" | "std" | "heavy";
export type WheelDiffBreadth = "contained" | "multi-file" | "cross-cutting";
export type WheelReversibility = "easy" | "hard";
export type WheelContextLoad = "low" | "medium" | "high";

export interface FleetV5Signals {
  schemaVersion: string;
  profileWeights: Record<string, number>;
  routeHint: WheelRouteHint;
  domains: string[];
  surfaces: string[];
  blast: string[];
  securityFlags: string[];
  diffBreadth: WheelDiffBreadth;
  reversibility: WheelReversibility;
  verification: string[];
  testDemands: string[];
  contextLoad: WheelContextLoad;
  designFreedom: string;
  opsTouch: string[];
  humanCheckpoint: string | null;
  parallelizable: boolean;
  reviewerGate: string;
  escalationTriggers: string[];
}

export interface WheelStoryDependency {
  storyId: string;
  type: "hard" | "stack" | "artifact" | "soft";
  prBaseRef?: string;
}

export interface WheelStoryExecution {
  schema: "zob.story-execution.v1";
  storyId: string;
  title: string;
  revision: number;
  parentRevisionHash?: string | null;
  revisionReason?: string;
  bundle: { rootRef: string; bundleHash: string; ratificationRef: string };
  repository: { repositoryId: string; baseRef: string; admissionBaseSha?: string };
  profile: { base: "full-feature" | "quick-fix" | "docs-process" | "refactor-cleanup"; overlays: string[]; versionRefs: string[] };
  scopeRefs: { acceptance: string; nonGoals: string };
  signals: FleetV5Signals;
  dependencies: WheelStoryDependency[];
  gates: Array<{ gateId: string; manifestRef: string; manifestHash: string; required: boolean }>;
  branchContract: { branchName: string; prTarget: string; draftRequired: true; stackParentStoryId?: string };
  humanGateRefs: string[];
  prClose: { profile: string; evidenceSchema: string; requiredAudits: Array<"source-integration" | "evidence-qa-ci" | "finalizer"> };
  deferredActions: Array<"formal-review" | "ready" | "merge" | "deploy" | "publish" | "provider-activation" | "post-deploy-confirmation">;
}

export interface WheelFleetV5BundleInput {
  schema: "wheel.zob.fleet-v5-bundle.v1";
  bundleId: string;
  missionSeed: string;
  stories: unknown[];
}

export interface WheelValidationIssue {
  path: string;
  code: "required" | "type" | "enum" | "pattern" | "additional_property" | "duplicate" | "dependency" | "policy";
  message: string;
}

export interface WheelStoryValidation {
  valid: boolean;
  issues: WheelValidationIssue[];
  value?: WheelStoryExecution;
}

export interface WheelFleetV5Intake {
  schema: "wheel.zob.fleet-v5-intake.v1";
  accepted: boolean;
  bundleId?: string;
  missionSeed?: string;
  stories: WheelStoryExecution[];
  storyIds: string[];
  dependencyEdges: Array<{ from: string; to: string; type: WheelStoryDependency["type"] }>;
  issues: WheelValidationIssue[];
  bodyStored: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(issues: WheelValidationIssue[], path: string, code: WheelValidationIssue["code"], message: string): void {
  issues.push({ path, code, message });
}

function checkExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: WheelValidationIssue[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issue(issues, `${path}.${key}`, "additional_property", "field is not allowed");
  }
}

function requiredRecord(value: unknown, path: string, issues: WheelValidationIssue[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issue(issues, path, "type", "must be an object");
    return undefined;
  }
  return value;
}

function nonEmptyString(value: unknown, path: string, issues: WheelValidationIssue[]): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issue(issues, path, "type", "must be a non-empty string");
    return false;
  }
  return true;
}

function stringArray(value: unknown, path: string, issues: WheelValidationIssue[]): value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    issue(issues, path, "type", "must be an array of strings");
    return false;
  }
  return true;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string, issues: WheelValidationIssue[]): value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issue(issues, path, "enum", `must be one of: ${allowed.join(", ")}`);
    return false;
  }
  return true;
}

function hashValue(value: unknown, pattern: RegExp, path: string, issues: WheelValidationIssue[]): value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    issue(issues, path, "pattern", `must match ${pattern}`);
    return false;
  }
  return true;
}

function validateSignals(value: unknown, path: string, issues: WheelValidationIssue[]): value is FleetV5Signals {
  const signals = requiredRecord(value, path, issues);
  if (!signals) return false;
  const keys = ["schemaVersion", ...FLEET_V5_SIGNAL_FIELDS];
  checkExactKeys(signals, keys, path, issues);
  for (const key of keys) if (!(key in signals)) issue(issues, `${path}.${key}`, "required", "field is required");
  nonEmptyString(signals.schemaVersion, `${path}.schemaVersion`, issues);

  const weights = requiredRecord(signals.profileWeights, `${path}.profileWeights`, issues);
  if (weights) {
    if (Object.keys(weights).length === 0) issue(issues, `${path}.profileWeights`, "required", "must include at least one profile weight");
    for (const [key, weight] of Object.entries(weights)) {
      if (!key || typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) issue(issues, `${path}.profileWeights.${key}`, "type", "weight must be a number from 0 to 1");
    }
  }
  enumValue(signals.routeHint, ["light", "std", "heavy"], `${path}.routeHint`, issues);
  stringArray(signals.domains, `${path}.domains`, issues);
  stringArray(signals.surfaces, `${path}.surfaces`, issues);
  stringArray(signals.blast, `${path}.blast`, issues);
  stringArray(signals.securityFlags, `${path}.securityFlags`, issues);
  enumValue(signals.diffBreadth, ["contained", "multi-file", "cross-cutting"], `${path}.diffBreadth`, issues);
  enumValue(signals.reversibility, ["easy", "hard"], `${path}.reversibility`, issues);
  stringArray(signals.verification, `${path}.verification`, issues);
  stringArray(signals.testDemands, `${path}.testDemands`, issues);
  enumValue(signals.contextLoad, ["low", "medium", "high"], `${path}.contextLoad`, issues);
  nonEmptyString(signals.designFreedom, `${path}.designFreedom`, issues);
  stringArray(signals.opsTouch, `${path}.opsTouch`, issues);
  if (signals.humanCheckpoint !== null && typeof signals.humanCheckpoint !== "string") issue(issues, `${path}.humanCheckpoint`, "type", "must be null or a string");
  if (typeof signals.parallelizable !== "boolean") issue(issues, `${path}.parallelizable`, "type", "must be a boolean");
  nonEmptyString(signals.reviewerGate, `${path}.reviewerGate`, issues);
  stringArray(signals.escalationTriggers, `${path}.escalationTriggers`, issues);
  return issues.every((item) => !item.path.startsWith(path));
}

export function validateFleetV5StoryExecution(input: unknown, path = "story"): WheelStoryValidation {
  const issues: WheelValidationIssue[] = [];
  const story = requiredRecord(input, path, issues);
  if (!story) return { valid: false, issues };
  const allowedTop = ["schema", "storyId", "title", "revision", "parentRevisionHash", "revisionReason", "bundle", "repository", "profile", "scopeRefs", "signals", "dependencies", "gates", "branchContract", "humanGateRefs", "prClose", "deferredActions"];
  checkExactKeys(story, allowedTop, path, issues);
  for (const key of ["schema", "storyId", "title", "revision", "bundle", "repository", "profile", "scopeRefs", "signals", "dependencies", "gates", "branchContract", "humanGateRefs", "prClose", "deferredActions"]) {
    if (!(key in story)) issue(issues, `${path}.${key}`, "required", "field is required");
  }
  if (story.schema !== "zob.story-execution.v1") issue(issues, `${path}.schema`, "enum", "must equal zob.story-execution.v1");
  nonEmptyString(story.storyId, `${path}.storyId`, issues);
  nonEmptyString(story.title, `${path}.title`, issues);
  if (!Number.isInteger(story.revision) || Number(story.revision) < 1) issue(issues, `${path}.revision`, "type", "must be an integer >= 1");
  if (story.parentRevisionHash !== undefined && story.parentRevisionHash !== null) hashValue(story.parentRevisionHash, SHA64, `${path}.parentRevisionHash`, issues);
  if (story.revisionReason !== undefined) nonEmptyString(story.revisionReason, `${path}.revisionReason`, issues);

  const bundle = requiredRecord(story.bundle, `${path}.bundle`, issues);
  if (bundle) {
    checkExactKeys(bundle, ["rootRef", "bundleHash", "ratificationRef"], `${path}.bundle`, issues);
    nonEmptyString(bundle.rootRef, `${path}.bundle.rootRef`, issues);
    hashValue(bundle.bundleHash, SHA64, `${path}.bundle.bundleHash`, issues);
    nonEmptyString(bundle.ratificationRef, `${path}.bundle.ratificationRef`, issues);
  }
  const repository = requiredRecord(story.repository, `${path}.repository`, issues);
  if (repository) {
    checkExactKeys(repository, ["repositoryId", "baseRef", "admissionBaseSha"], `${path}.repository`, issues);
    nonEmptyString(repository.repositoryId, `${path}.repository.repositoryId`, issues);
    if (repository.baseRef !== "develop-staging") issue(issues, `${path}.repository.baseRef`, "policy", "ordinary Wheel stories must use develop-staging");
    if (repository.admissionBaseSha !== undefined) hashValue(repository.admissionBaseSha, SHA40, `${path}.repository.admissionBaseSha`, issues);
  }
  const profile = requiredRecord(story.profile, `${path}.profile`, issues);
  if (profile) {
    checkExactKeys(profile, ["base", "overlays", "versionRefs"], `${path}.profile`, issues);
    enumValue(profile.base, ["full-feature", "quick-fix", "docs-process", "refactor-cleanup"], `${path}.profile.base`, issues);
    stringArray(profile.overlays, `${path}.profile.overlays`, issues);
    if (stringArray(profile.versionRefs, `${path}.profile.versionRefs`, issues) && profile.versionRefs.length === 0) issue(issues, `${path}.profile.versionRefs`, "required", "must include at least one version ref");
  }
  const scopeRefs = requiredRecord(story.scopeRefs, `${path}.scopeRefs`, issues);
  if (scopeRefs) {
    checkExactKeys(scopeRefs, ["acceptance", "nonGoals"], `${path}.scopeRefs`, issues);
    nonEmptyString(scopeRefs.acceptance, `${path}.scopeRefs.acceptance`, issues);
    nonEmptyString(scopeRefs.nonGoals, `${path}.scopeRefs.nonGoals`, issues);
  }
  validateSignals(story.signals, `${path}.signals`, issues);

  if (!Array.isArray(story.dependencies)) {
    issue(issues, `${path}.dependencies`, "type", "must be an array");
  } else {
    const ids = new Set<string>();
    story.dependencies.forEach((rawDependency, index) => {
      const dependency = requiredRecord(rawDependency, `${path}.dependencies[${index}]`, issues);
      if (!dependency) return;
      checkExactKeys(dependency, ["storyId", "type", "prBaseRef"], `${path}.dependencies[${index}]`, issues);
      if (nonEmptyString(dependency.storyId, `${path}.dependencies[${index}].storyId`, issues)) {
        if (dependency.storyId === story.storyId) issue(issues, `${path}.dependencies[${index}].storyId`, "dependency", "story cannot depend on itself");
        if (ids.has(dependency.storyId)) issue(issues, `${path}.dependencies[${index}].storyId`, "duplicate", "duplicate dependency storyId");
        ids.add(dependency.storyId);
      }
      enumValue(dependency.type, ["hard", "stack", "artifact", "soft"], `${path}.dependencies[${index}].type`, issues);
      if (dependency.prBaseRef !== undefined) nonEmptyString(dependency.prBaseRef, `${path}.dependencies[${index}].prBaseRef`, issues);
    });
  }

  if (!Array.isArray(story.gates) || story.gates.length === 0) {
    issue(issues, `${path}.gates`, "required", "must contain at least one gate");
  } else {
    const gateIds = new Set<string>();
    story.gates.forEach((rawGate, index) => {
      const gate = requiredRecord(rawGate, `${path}.gates[${index}]`, issues);
      if (!gate) return;
      checkExactKeys(gate, ["gateId", "manifestRef", "manifestHash", "required"], `${path}.gates[${index}]`, issues);
      if (nonEmptyString(gate.gateId, `${path}.gates[${index}].gateId`, issues)) {
        if (gateIds.has(gate.gateId)) issue(issues, `${path}.gates[${index}].gateId`, "duplicate", "duplicate gateId");
        gateIds.add(gate.gateId);
      }
      nonEmptyString(gate.manifestRef, `${path}.gates[${index}].manifestRef`, issues);
      hashValue(gate.manifestHash, SHA64, `${path}.gates[${index}].manifestHash`, issues);
      if (typeof gate.required !== "boolean") issue(issues, `${path}.gates[${index}].required`, "type", "must be a boolean");
    });
  }

  const branch = requiredRecord(story.branchContract, `${path}.branchContract`, issues);
  if (branch) {
    checkExactKeys(branch, ["branchName", "prTarget", "draftRequired", "stackParentStoryId"], `${path}.branchContract`, issues);
    nonEmptyString(branch.branchName, `${path}.branchContract.branchName`, issues);
    if (branch.prTarget !== "develop-staging") issue(issues, `${path}.branchContract.prTarget`, "policy", "ordinary Wheel PR target must be develop-staging");
    if (branch.draftRequired !== true) issue(issues, `${path}.branchContract.draftRequired`, "policy", "draftRequired must be true");
    if (branch.stackParentStoryId !== undefined) nonEmptyString(branch.stackParentStoryId, `${path}.branchContract.stackParentStoryId`, issues);
  }
  stringArray(story.humanGateRefs, `${path}.humanGateRefs`, issues);

  const prClose = requiredRecord(story.prClose, `${path}.prClose`, issues);
  if (prClose) {
    checkExactKeys(prClose, ["profile", "evidenceSchema", "requiredAudits"], `${path}.prClose`, issues);
    nonEmptyString(prClose.profile, `${path}.prClose.profile`, issues);
    nonEmptyString(prClose.evidenceSchema, `${path}.prClose.evidenceSchema`, issues);
    if (!Array.isArray(prClose.requiredAudits) || prClose.requiredAudits.length < 3) {
      issue(issues, `${path}.prClose.requiredAudits`, "required", "must include all three PR-close audits");
    } else {
      const required = new Set(["source-integration", "evidence-qa-ci", "finalizer"]);
      for (const audit of prClose.requiredAudits) if (!required.has(String(audit))) issue(issues, `${path}.prClose.requiredAudits`, "enum", `unsupported audit ${String(audit)}`);
      for (const audit of required) if (!prClose.requiredAudits.includes(audit)) issue(issues, `${path}.prClose.requiredAudits`, "required", `missing ${audit}`);
    }
  }

  if (!Array.isArray(story.deferredActions)) {
    issue(issues, `${path}.deferredActions`, "type", "must be an array");
  } else {
    const allowed = ["formal-review", "ready", "merge", "deploy", "publish", "provider-activation", "post-deploy-confirmation"] as const;
    for (const action of story.deferredActions) enumValue(action, allowed, `${path}.deferredActions`, issues);
    for (const requiredAction of ["formal-review", "ready", "merge", "deploy"] as const) {
      if (!story.deferredActions.includes(requiredAction)) issue(issues, `${path}.deferredActions`, "policy", `must defer ${requiredAction}`);
    }
  }

  return { valid: issues.length === 0, issues, value: issues.length === 0 ? story as unknown as WheelStoryExecution : undefined };
}

function findBlockingDependencyCycle(
  storyIds: readonly string[],
  edges: ReadonlyArray<{ from: string; to: string; type: WheelStoryDependency["type"] }>,
): string[] | undefined {
  const included = new Set(storyIds);
  const adjacency = new Map(storyIds.map((storyId) => [storyId, [] as string[]]));
  for (const edge of edges) {
    if ((edge.type === "hard" || edge.type === "stack") && included.has(edge.to)) adjacency.get(edge.from)?.push(edge.to);
  }
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visit = (storyId: string): string[] | undefined => {
    if (state.get(storyId) === "visited") return undefined;
    if (state.get(storyId) === "visiting") {
      const start = stack.indexOf(storyId);
      return [...stack.slice(start), storyId];
    }
    state.set(storyId, "visiting");
    stack.push(storyId);
    for (const dependencyId of adjacency.get(storyId) ?? []) {
      const cycle = visit(dependencyId);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(storyId, "visited");
    return undefined;
  };
  for (const storyId of storyIds) {
    const cycle = visit(storyId);
    if (cycle) return cycle;
  }
  return undefined;
}

export function ingestFleetV5StoryBundle(input: unknown): WheelFleetV5Intake {
  const issues: WheelValidationIssue[] = [];
  const bundle = requiredRecord(input, "bundle", issues);
  if (!bundle) return { schema: "wheel.zob.fleet-v5-intake.v1", accepted: false, stories: [], storyIds: [], dependencyEdges: [], issues, bodyStored: false };
  checkExactKeys(bundle, ["schema", "bundleId", "missionSeed", "stories"], "bundle", issues);
  if (bundle.schema !== "wheel.zob.fleet-v5-bundle.v1") issue(issues, "bundle.schema", "enum", "must equal wheel.zob.fleet-v5-bundle.v1");
  const bundleId = nonEmptyString(bundle.bundleId, "bundle.bundleId", issues) && SAFE_ID.test(bundle.bundleId) ? bundle.bundleId : undefined;
  if (typeof bundle.bundleId === "string" && !SAFE_ID.test(bundle.bundleId)) issue(issues, "bundle.bundleId", "pattern", "must be path-safe");
  const missionSeed = nonEmptyString(bundle.missionSeed, "bundle.missionSeed", issues) && bundle.missionSeed.length >= 16 ? bundle.missionSeed : undefined;
  if (typeof bundle.missionSeed === "string" && bundle.missionSeed.length < 16) issue(issues, "bundle.missionSeed", "pattern", "must contain at least 16 characters");
  if (!Array.isArray(bundle.stories) || bundle.stories.length === 0) issue(issues, "bundle.stories", "required", "must contain at least one story");

  const stories: WheelStoryExecution[] = [];
  if (Array.isArray(bundle.stories)) {
    bundle.stories.forEach((rawStory, index) => {
      const validation = validateFleetV5StoryExecution(rawStory, `bundle.stories[${index}]`);
      issues.push(...validation.issues);
      if (validation.value) stories.push(validation.value);
    });
  }

  const storyIds = stories.map((story) => story.storyId);
  const seen = new Set<string>();
  storyIds.forEach((storyId, index) => {
    if (seen.has(storyId)) issue(issues, `bundle.stories[${index}].storyId`, "duplicate", `duplicate storyId ${storyId}`);
    seen.add(storyId);
  });
  const included = new Set(storyIds);
  const dependencyEdges = stories.flatMap((story) => story.dependencies.map((dependency) => ({ from: story.storyId, to: dependency.storyId, type: dependency.type })));
  for (const edge of dependencyEdges) {
    if ((edge.type === "hard" || edge.type === "stack") && !included.has(edge.to)) issue(issues, `bundle.dependencies.${edge.from}->${edge.to}`, "dependency", `${edge.type} dependency must be included in the mission bundle`);
  }
  const blockingCycle = findBlockingDependencyCycle(storyIds, dependencyEdges);
  if (blockingCycle) issue(issues, "bundle.dependencies", "dependency", `hard/stack dependency cycle detected: ${blockingCycle.join(" -> ")}`);

  return {
    schema: "wheel.zob.fleet-v5-intake.v1",
    accepted: issues.length === 0,
    bundleId,
    missionSeed,
    stories: issues.length === 0 ? stories : [],
    storyIds: issues.length === 0 ? storyIds : [],
    dependencyEdges: issues.length === 0 ? dependencyEdges : [],
    issues,
    bodyStored: false,
  };
}
