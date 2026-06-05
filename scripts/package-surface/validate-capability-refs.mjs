#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize, sep } from "node:path";

const registryPath = ".pi/capabilities/zob-public-runtime-capabilities.json";
const validModeNames = new Set(["explore", "plan", "implement", "oracle", "factory", "orchestrator", "vanilla", "all"]);
const secretishPattern = /(^|\/)\.env(?:\.|$)|(^|\/)(?:id_rsa|id_ed25519|\.ssh|\.aws)(?:\/|$)|\.(?:pem|p12|pfx)$/iu;

function normalizeRepoPath(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  if (isAbsolute(raw)) return null;
  const normalized = normalize(raw.replace(/^\.\//u, ""));
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) return null;
  return normalized.split(sep).join("/");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function checkRefs(kind, owner, refs, errors, warnings, seenRefs) {
  if (!Array.isArray(refs)) {
    if (refs !== undefined) errors.push(`${owner}.${kind} must be an array when present`);
    return;
  }

  for (const ref of refs) {
    const normalized = normalizeRepoPath(ref);
    if (!normalized) {
      errors.push(`${owner}.${kind} has unsafe non-repo ref: ${String(ref)}`);
      continue;
    }
    if (secretishPattern.test(normalized)) {
      errors.push(`${owner}.${kind} must not reference secret-like path: ${normalized}`);
      continue;
    }
    seenRefs.add(normalized);
    if (!existsSync(normalized)) errors.push(`${owner}.${kind} missing file: ${normalized}`);
    if (kind === "skillRefs" && !normalized.endsWith("/SKILL.md")) warnings.push(`${owner}.${kind} is not a SKILL.md path: ${normalized}`);
  }
}

function checkCapabilityRecord(section, index, record, errors, warnings, seenNames, seenRefs) {
  const owner = `${section}[${index}]${record?.name ? `:${record.name}` : ""}`;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    errors.push(`${section}[${index}] must be an object`);
    return;
  }
  if (typeof record.name !== "string" || record.name.trim() === "") errors.push(`${owner}.name is required`);
  else {
    const key = `${section}:${record.name}`;
    if (seenNames.has(key)) errors.push(`${section} duplicate name: ${record.name}`);
    seenNames.add(key);
  }
  if (typeof record.family !== "string" || record.family.trim() === "") warnings.push(`${owner}.family is missing`);
  if (!Array.isArray(record.modes) || record.modes.length === 0) errors.push(`${owner}.modes must be a non-empty array`);
  else {
    for (const mode of record.modes) {
      if (typeof mode !== "string" || mode.trim() === "") errors.push(`${owner}.modes contains invalid mode: ${String(mode)}`);
      else if (!validModeNames.has(mode)) warnings.push(`${owner}.modes contains non-standard mode: ${mode}`);
    }
  }
  if (typeof record.noShipNotes !== "string" || record.noShipNotes.trim() === "") warnings.push(`${owner}.noShipNotes is missing`);
  checkRefs("skillRefs", owner, record.skillRefs, errors, warnings, seenRefs);
  checkRefs("docRefs", owner, record.docRefs, errors, warnings, seenRefs);
}

try {
  const errors = [];
  const warnings = [];
  const seenRefs = new Set();
  const seenNames = new Set();

  if (!existsSync(registryPath)) throw new Error(`missing registry: ${registryPath}`);
  const registry = readJson(registryPath);

  if (registry.schemaVersion !== 1) warnings.push("registry.schemaVersion is not 1");
  checkRefs("defaultSkillRefs", "registry", registry.defaultSkillRefs, errors, warnings, seenRefs);
  checkRefs("defaultDocRefs", "registry", registry.defaultDocRefs, errors, warnings, seenRefs);

  for (const [index, record] of asArray(registry.tools).entries()) checkCapabilityRecord("tools", index, record, errors, warnings, seenNames, seenRefs);
  for (const [index, record] of asArray(registry.commands).entries()) checkCapabilityRecord("commands", index, record, errors, warnings, seenNames, seenRefs);

  if (!Array.isArray(registry.tools) || registry.tools.length === 0) errors.push("registry.tools must be a non-empty array");
  if (!Array.isArray(registry.commands) || registry.commands.length === 0) warnings.push("registry.commands is empty or missing");

  const result = {
    schema: "zob.capability-ref-validation.v1",
    valid: errors.length === 0,
    registryPath,
    checkedRefs: [...seenRefs].sort(),
    checkedRefCount: seenRefs.size,
    toolCount: Array.isArray(registry.tools) ? registry.tools.length : 0,
    commandCount: Array.isArray(registry.commands) ? registry.commands.length : 0,
    errors,
    warnings,
    noExecution: true,
    sourceProjectModified: false,
    networkAccessed: false,
    bodyStored: false
  };

  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
