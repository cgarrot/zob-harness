#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const localEconomyPath = ".pi/model-economy.json";
const exampleEconomyPath = ".pi/model-economy.example.json";
const localCatalogPath = ".pi/model-catalog.json";
const exampleCatalogPath = ".pi/model-catalog.example.json";
const economyPath = existsSync(join(repoRoot, localEconomyPath)) ? localEconomyPath : exampleEconomyPath;
const catalogPath = existsSync(join(repoRoot, localCatalogPath)) ? localCatalogPath : exampleCatalogPath;
const routingPath = ".pi/model-routing.json";
const computeDefaultsPath = ".pi/compute-profiles/defaults.json";
const errors = [];
const warnings = [];

function readJson(path) {
  const full = join(repoRoot, path);
  if (!existsSync(full)) {
    errors.push(`missing ${path}`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    errors.push(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function warn(condition, message) {
  if (!condition) warnings.push(message);
}

const forbiddenExactKeys = new Set([
  "apikey",
  "api_key",
  "secret",
  "password",
  "credential",
  "authorization",
  "authheader",
  "auth_header",
  "headers",
  "bearer",
  "privatekey",
  "private_key",
  "env",
  "prompt",
  "task",
  "output",
  "body",
  "content"
]);

function scanForbiddenKeys(value, path = "$") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[\s-]/g, "_");
    const compact = normalized.replace(/_/g, "");
    if (forbiddenExactKeys.has(normalized) || forbiddenExactKeys.has(compact)) {
      errors.push(`forbidden secret/body-like key at ${path}.${key}`);
    }
    scanForbiddenKeys(child, `${path}.${key}`);
  }
}

const profiles = ["low", "medium", "high", "xhigh", "max"];
const expectedRoles = ["root", "orchestrator", "lead", "planner", "scout", "worker", "implementer", "qa", "oracle", "security", "high_context"];
const costTiers = new Set(["free", "low", "medium", "high"]);
const qualityTiers = new Set(["unknown", "experimental", "reliable", "strong"]);
const statusValues = new Set(["preferred", "fallback", "candidate", "disabled"]);
const qualityRank = { unknown: 0, experimental: 1, reliable: 2, strong: 3 };

const economy = readJson(economyPath);
const catalog = readJson(catalogPath);
const routing = readJson(routingPath);
const computeDefaults = readJson(computeDefaultsPath);
const modelClasses = isRecord(routing?.modelClasses) ? Object.keys(routing.modelClasses).sort() : [];
const knownClasses = new Set(modelClasses);
const catalogModels = isRecord(catalog?.models) ? catalog.models : {};
const catalogDefaults = isRecord(catalog?.classDefaults) ? catalog.classDefaults : {};

if (economy) {
  assert(economy.schema === "zob.model-economy-policy.v1", "economy schema must be zob.model-economy-policy.v1");
  assert(economy.advisoryOnly === true, "economy advisoryOnly must be true");
  assert(economy.computeProfileRef === computeDefaultsPath, `computeProfileRef must be ${computeDefaultsPath}`);
  assert(economy.modelRoutingRef === routingPath, `modelRoutingRef must be ${routingPath}`);
  assert([localCatalogPath, exampleCatalogPath, catalogPath].includes(economy.modelCatalogRef), `modelCatalogRef must reference ${localCatalogPath} or ${exampleCatalogPath}`);
  for (const flag of ["liveRoutingEnabled", "modelRouterUsed", "routingApplied", "childDispatchAllowed", "budgetEnforced", "strictEnabled", "networkAccessed", "bodyStored", "promptBodiesStored", "outputBodiesStored"]) {
    assert(economy[flag] === false, `economy must keep ${flag}=false`);
  }
  scanForbiddenKeys(economy);

  assert(stringArray(economy.selectionOrder) && economy.selectionOrder.length > 0, "selectionOrder must be a non-empty string array");
  assert(isRecord(economy.downgradePolicy), "downgradePolicy must be an object");
  assert(economy.downgradePolicy?.oracleSecurityDowngrade === "blocked", "oracle/security downgrade policy must be blocked");
  assert(economy.downgradePolicy?.unknownModelAsDefault === "blocked", "unknown model as default must be blocked");
  assert(stringArray(economy.roles), "roles must be a string array");
  for (const role of expectedRoles) assert(economy.roles?.includes(role), `roles missing ${role}`);
  assert(isRecord(economy.profiles), "profiles must be an object");

  const computeProfiles = isRecord(computeDefaults?.profiles) ? Object.keys(computeDefaults.profiles).sort() : [];
  for (const profile of profiles) {
    assert(computeProfiles.includes(profile), `compute defaults missing ${profile}`);
    const entry = economy.profiles?.[profile];
    assert(isRecord(entry), `profiles.${profile} must be an object`);
    if (!isRecord(entry)) continue;

    assert(typeof entry.intent === "string" && entry.intent.trim().length > 0, `profiles.${profile}.intent must be non-empty`);
    assert(stringArray(entry.preferCostTier) && entry.preferCostTier.length > 0, `profiles.${profile}.preferCostTier must be a non-empty string array`);
    for (const tier of entry.preferCostTier ?? []) assert(costTiers.has(tier), `profiles.${profile}.preferCostTier has invalid tier: ${tier}`);
    assert(qualityTiers.has(entry.minimumQualityTier), `profiles.${profile}.minimumQualityTier is invalid`);
    assert(stringArray(entry.allowedStatuses) && entry.allowedStatuses.length > 0, `profiles.${profile}.allowedStatuses must be a non-empty string array`);
    for (const status of entry.allowedStatuses ?? []) assert(statusValues.has(status), `profiles.${profile}.allowedStatuses has invalid status: ${status}`);
    for (const booleanField of ["allowUnverified", "requireVerified", "requireReliable", "requireStrongQuality"]) {
      assert(typeof entry[booleanField] === "boolean", `profiles.${profile}.${booleanField} must be boolean`);
    }
    assert(isRecord(entry.roleClasses), `profiles.${profile}.roleClasses must be an object`);
    for (const role of expectedRoles) {
      const modelClass = entry.roleClasses?.[role];
      assert(knownClasses.has(modelClass), `profiles.${profile}.roleClasses.${role} must reference a known model class`);
    }
    assert(entry.roleClasses?.oracle === "strong_oracle", `profiles.${profile}.oracle must stay strong_oracle`);
    assert(entry.roleClasses?.security === "strong_reasoning", `profiles.${profile}.security must stay strong_reasoning`);
    if (profile === "low") {
      assert(entry.roleClasses?.scout === "cheap_scout", "low.scout should default to cheap_scout");
      assert(["cheap_scout", "balanced_worker"].includes(entry.roleClasses?.worker), "low.worker should stay cheap_scout or balanced_worker");
    }
    if (profile === "medium") {
      assert(entry.roleClasses?.orchestrator === "strong_reasoning", "medium.orchestrator should use strong_reasoning");
      assert(entry.roleClasses?.scout === "cheap_scout", "medium.scout should stay cheap_scout");
    }
    if (profile === "max") {
      assert(entry.requireVerified === true, "max must require verified models");
      assert(entry.requireStrongQuality === true, "max must require strong quality");
      assert(entry.allowUnverified === false, "max must not allow unverified models");
      assert(!entry.allowedStatuses.includes("candidate"), "max must not allow candidate defaults");
    }
    if (entry.requireStrongQuality === true) {
      assert(qualityRank[entry.minimumQualityTier] >= qualityRank.strong, `profiles.${profile} requiring strong quality must set minimumQualityTier=strong`);
    }
    if (entry.requireReliable === true) {
      assert(qualityRank[entry.minimumQualityTier] >= qualityRank.reliable, `profiles.${profile} requiring reliable models must set minimumQualityTier reliable or strong`);
    }
    if (entry.notes !== undefined) assert(stringArray(entry.notes), `profiles.${profile}.notes must be a string array when present`);
  }

  for (const [profileName] of Object.entries(isRecord(economy.profiles) ? economy.profiles : {})) {
    assert(profiles.includes(profileName), `unknown economy profile: ${profileName}`);
  }

  const missingCatalogDefaults = new Set();
  for (const profile of profiles) {
    const entry = economy.profiles?.[profile];
    if (!isRecord(entry)) continue;
    const classesUsed = new Set(Object.values(entry.roleClasses ?? {}).filter((value) => typeof value === "string"));
    for (const modelClass of classesUsed) {
      if (!Array.isArray(catalogDefaults[modelClass]) || catalogDefaults[modelClass].length === 0) {
        missingCatalogDefaults.add(modelClass);
      }
    }
  }
  for (const modelClass of [...missingCatalogDefaults].sort()) {
    warnings.push(`catalog classDefaults.${modelClass} has no concrete model yet`);
  }

  for (const [modelId, model] of Object.entries(catalogModels)) {
    if (!isRecord(model)) continue;
    for (const profile of profiles) {
      const entry = economy.profiles?.[profile];
      if (!isRecord(entry)) continue;
      const defaultedClasses = Object.values(entry.roleClasses ?? {});
      const defaulted = Array.isArray(model.classes) && model.classes.some((modelClass) => defaultedClasses.includes(modelClass));
      if (!defaulted) continue;
      if (entry.requireVerified === true && model.resolutionStatus !== "verified") {
        warn(false, `profiles.${profile} requires verified; catalog model ${modelId} is ${model.resolutionStatus}`);
      }
      if (entry.requireStrongQuality === true && model.qualityTier !== "strong") {
        warn(false, `profiles.${profile} requires strong quality; catalog model ${modelId} has qualityTier=${model.qualityTier}`);
      }
      if (entry.requireReliable === true && qualityRank[model.qualityTier] < qualityRank.reliable) {
        warn(false, `profiles.${profile} requires reliable; catalog model ${modelId} has qualityTier=${model.qualityTier}`);
      }
    }
  }
}

const result = {
  schema: "zob.model-economy-validation.v1",
  valid: errors.length === 0,
  errors,
  warnings,
  economyPath,
  catalogPath,
  routingPath,
  computeDefaultsPath,
  profiles,
  modelClasses,
  noExecution: true,
  childDispatchAllowed: false,
  networkAccessed: false,
  bodyStored: false
};

console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) process.exit(1);
