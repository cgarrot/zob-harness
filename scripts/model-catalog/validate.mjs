#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const localCatalogPath = ".pi/model-catalog.json";
const exampleCatalogPath = ".pi/model-catalog.example.json";
const catalogPath = existsSync(join(repoRoot, localCatalogPath)) ? localCatalogPath : exampleCatalogPath;
const routingPath = ".pi/model-routing.json";
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
    for (let index = 0; index < value.length; index += 1) {
      scanForbiddenKeys(value[index], `${path}[${index}]`);
    }
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

function safeModelPattern(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 160
    && !value.includes("\0")
    && !value.includes("\n")
    && !value.includes("\r")
    && !value.includes("..")
    && !value.startsWith("/")
    && !value.startsWith("~")
    && /^[a-zA-Z0-9._:/+@-]+$/.test(value);
}

function uniqueStrings(values) {
  return new Set(values).size === values.length;
}

const catalog = readJson(catalogPath);
const routing = readJson(routingPath);
const modelClasses = isRecord(routing?.modelClasses) ? Object.keys(routing.modelClasses).sort() : [];
const knownClasses = new Set(modelClasses);
const statusValues = new Set(["candidate", "preferred", "fallback", "disabled"]);
const resolutionValues = new Set(["verified", "unverified", "needs_user"]);
const costTiers = new Set(["unknown", "free", "low", "medium", "high"]);
const qualityTiers = new Set(["unknown", "experimental", "reliable", "strong"]);

if (catalog) {
  assert(catalog.schema === "zob.model-catalog.v1", "catalog schema must be zob.model-catalog.v1");
  assert(catalog.advisoryOnly === true, "catalog advisoryOnly must be true");
  assert(catalog.routingConfigRef === routingPath, `catalog routingConfigRef must be ${routingPath}`);
  for (const flag of ["liveRoutingEnabled", "modelRouterUsed", "routingApplied", "childDispatchAllowed", "networkAccessed", "bodyStored", "promptBodiesStored", "outputBodiesStored"]) {
    assert(catalog[flag] === false, `catalog must keep ${flag}=false`);
  }
  scanForbiddenKeys(catalog);

  assert(isRecord(catalog.models), "catalog.models must be an object");
  assert(isRecord(catalog.classDefaults), "catalog.classDefaults must be an object");
  assert(isRecord(catalog.agentPreferences), "catalog.agentPreferences must be an object");

  const modelIds = new Set(Object.keys(isRecord(catalog.models) ? catalog.models : {}));
  for (const modelId of modelIds) {
    assert(safeModelPattern(modelId), `model key must be a safe Pi --model pattern: ${modelId}`);
    const entry = catalog.models[modelId];
    assert(isRecord(entry), `models.${modelId} must be an object`);
    if (!isRecord(entry)) continue;
    assert(typeof entry.label === "string" && entry.label.trim().length > 0, `models.${modelId}.label must be non-empty`);
    assert(statusValues.has(entry.status), `models.${modelId}.status must be one of ${[...statusValues].join(",")}`);
    assert(resolutionValues.has(entry.resolutionStatus), `models.${modelId}.resolutionStatus must be one of ${[...resolutionValues].join(",")}`);
    assert(stringArray(entry.classes) && entry.classes.length > 0, `models.${modelId}.classes must be a non-empty string array`);
    for (const modelClass of entry.classes ?? []) {
      assert(knownClasses.has(modelClass), `models.${modelId}.classes contains unknown model class: ${modelClass}`);
    }
    assert(typeof entry.whyWeLikeIt === "string" && entry.whyWeLikeIt.trim().length > 0, `models.${modelId}.whyWeLikeIt must be non-empty`);
    assert(stringArray(entry.bestFor), `models.${modelId}.bestFor must be a string array`);
    assert(stringArray(entry.avoidFor), `models.${modelId}.avoidFor must be a string array`);
    assert(costTiers.has(entry.costTier), `models.${modelId}.costTier must be one of ${[...costTiers].join(",")}`);
    assert(qualityTiers.has(entry.qualityTier), `models.${modelId}.qualityTier must be one of ${[...qualityTiers].join(",")}`);
    if (entry.contextWindow !== undefined) {
      assert(Number.isInteger(entry.contextWindow) && entry.contextWindow > 0, `models.${modelId}.contextWindow must be a positive integer when present`);
    }
    if (entry.notes !== undefined) assert(stringArray(entry.notes), `models.${modelId}.notes must be a string array when present`);
    if (entry.lastUpdated !== undefined) assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.lastUpdated), `models.${modelId}.lastUpdated must be YYYY-MM-DD when present`);
    warn(entry.resolutionStatus === "verified" || entry.status !== "preferred", `models.${modelId} is preferred but not verified`);
  }

  for (const modelClass of modelClasses) {
    assert(Object.hasOwn(catalog.classDefaults, modelClass), `classDefaults missing ${modelClass}`);
  }
  for (const [modelClass, defaults] of Object.entries(isRecord(catalog.classDefaults) ? catalog.classDefaults : {})) {
    assert(knownClasses.has(modelClass), `classDefaults contains unknown class: ${modelClass}`);
    assert(stringArray(defaults), `classDefaults.${modelClass} must be a string array`);
    if (stringArray(defaults)) {
      assert(uniqueStrings(defaults), `classDefaults.${modelClass} must not contain duplicate models`);
      for (const modelId of defaults) {
        assert(modelIds.has(modelId), `classDefaults.${modelClass} references unknown model: ${modelId}`);
        const entry = catalog.models?.[modelId];
        if (isRecord(entry)) {
          assert(entry.status !== "disabled", `classDefaults.${modelClass} references disabled model: ${modelId}`);
          assert(Array.isArray(entry.classes) && entry.classes.includes(modelClass), `classDefaults.${modelClass} model ${modelId} must include class ${modelClass}`);
          if (modelClass === "strong_oracle") {
            assert(entry.qualityTier === "strong", `strong_oracle default ${modelId} must have qualityTier=strong`);
            assert(entry.status === "preferred" || entry.status === "fallback", `strong_oracle default ${modelId} must be preferred or fallback`);
          }
        }
      }
    }
  }

  for (const [agent, preference] of Object.entries(isRecord(catalog.agentPreferences) ? catalog.agentPreferences : {})) {
    assert(/^[a-zA-Z0-9._-]+$/.test(agent), `agentPreferences key must be agent-name safe: ${agent}`);
    assert(isRecord(preference), `agentPreferences.${agent} must be an object`);
    if (!isRecord(preference)) continue;
    for (const field of ["preferred", "fallback", "avoid"]) {
      if (preference[field] === undefined) continue;
      assert(stringArray(preference[field]), `agentPreferences.${agent}.${field} must be a string array`);
      for (const modelId of preference[field] ?? []) {
        assert(modelIds.has(modelId), `agentPreferences.${agent}.${field} references unknown model: ${modelId}`);
      }
    }
    if (preference.notes !== undefined) assert(stringArray(preference.notes), `agentPreferences.${agent}.notes must be a string array when present`);
  }
}

const result = {
  schema: "zob.model-catalog-validation.v1",
  valid: errors.length === 0,
  errors,
  warnings,
  catalogPath,
  routingPath,
  modelClasses,
  modelCount: catalog && isRecord(catalog.models) ? Object.keys(catalog.models).length : 0,
  noExecution: true,
  childDispatchAllowed: false,
  networkAccessed: false,
  bodyStored: false
};

console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) process.exit(1);
