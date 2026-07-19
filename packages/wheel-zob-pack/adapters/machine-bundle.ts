import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type { WheelValidationIssue } from "./fleet-v5.js";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;

export interface WheelFleetV5MachineBundleSource {
  repositoryId: string;
  sourceSha: string;
  allocationRef: string;
  allocationSha256: string;
  signalsRef: string;
  signalsSha256: string;
}

export interface WheelFleetV5MachineAssignment {
  machineId: string;
  theme: string;
  allocationUnitIds: string[];
  storyIds: string[];
  storyPaths: string[];
}

export interface WheelFleetV5MachineBundle {
  schema: "wheel.zob.fleet-v5-machine-bundle.v1";
  bundleId: string;
  revision: number;
  bundleHash: string;
  source: WheelFleetV5MachineBundleSource;
  machines: WheelFleetV5MachineAssignment[];
}

export interface WheelFleetV5MachineBundleValidation {
  schema: "wheel.zob.fleet-v5-machine-bundle-validation.v1";
  accepted: boolean;
  value?: WheelFleetV5MachineBundle;
  issues: WheelValidationIssue[];
  bodyStored: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: WheelValidationIssue[],
  path: string,
  code: WheelValidationIssue["code"],
  message: string,
): void {
  issues.push({ path, code, message });
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: WheelValidationIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) addIssue(issues, `${path}.${key}`, "additional_property", "field is not allowed");
  }
}

function requiredRecord(
  value: unknown,
  path: string,
  issues: WheelValidationIssue[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    addIssue(issues, path, "type", "must be an object");
    return undefined;
  }
  return value;
}

function nonEmptyString(value: unknown, path: string, issues: WheelValidationIssue[]): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(issues, path, "type", "must be a non-empty string");
    return false;
  }
  return true;
}

function safeId(value: unknown, path: string, issues: WheelValidationIssue[]): value is string {
  if (!nonEmptyString(value, path, issues)) return false;
  if (!SAFE_ID.test(value)) {
    addIssue(issues, path, "pattern", "must be path-safe");
    return false;
  }
  return true;
}

function hashValue(value: unknown, pattern: RegExp, path: string, issues: WheelValidationIssue[]): value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    addIssue(issues, path, "pattern", `must match ${pattern}`);
    return false;
  }
  return true;
}

function repoRelativePath(value: unknown, path: string, issues: WheelValidationIssue[]): value is string {
  if (!nonEmptyString(value, path, issues)) return false;
  const segments = value.split(/[\\/]/);
  if (isAbsolute(value) || value.startsWith("@") || segments.includes("..") || segments.includes(".")) {
    addIssue(issues, path, "pattern", "must be a canonical repo-relative path");
    return false;
  }
  return true;
}

function stringArray(
  value: unknown,
  path: string,
  issues: WheelValidationIssue[],
  validateItem?: (item: unknown, itemPath: string, issues: WheelValidationIssue[]) => item is string,
): value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(issues, path, "required", "must be a non-empty array");
    return false;
  }
  let valid = true;
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (validateItem) valid = validateItem(item, itemPath, issues) && valid;
    else valid = nonEmptyString(item, itemPath, issues) && valid;
  });
  return valid;
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

export function validateWheelFleetV5MachineBundle(input: unknown): WheelFleetV5MachineBundleValidation {
  const issues: WheelValidationIssue[] = [];
  const bundle = requiredRecord(input, "bundle", issues);
  if (!bundle) {
    return {
      schema: "wheel.zob.fleet-v5-machine-bundle-validation.v1",
      accepted: false,
      issues,
      bodyStored: false,
    };
  }

  exactKeys(bundle, ["schema", "bundleId", "revision", "bundleHash", "source", "machines"], "bundle", issues);
  if (bundle.schema !== "wheel.zob.fleet-v5-machine-bundle.v1") {
    addIssue(issues, "bundle.schema", "enum", "must equal wheel.zob.fleet-v5-machine-bundle.v1");
  }
  safeId(bundle.bundleId, "bundle.bundleId", issues);
  if (!Number.isInteger(bundle.revision) || Number(bundle.revision) < 1) {
    addIssue(issues, "bundle.revision", "type", "must be an integer >= 1");
  }
  hashValue(bundle.bundleHash, SHA64, "bundle.bundleHash", issues);

  const source = requiredRecord(bundle.source, "bundle.source", issues);
  if (source) {
    exactKeys(
      source,
      ["repositoryId", "sourceSha", "allocationRef", "allocationSha256", "signalsRef", "signalsSha256"],
      "bundle.source",
      issues,
    );
    nonEmptyString(source.repositoryId, "bundle.source.repositoryId", issues);
    hashValue(source.sourceSha, SHA40, "bundle.source.sourceSha", issues);
    repoRelativePath(source.allocationRef, "bundle.source.allocationRef", issues);
    hashValue(source.allocationSha256, SHA64, "bundle.source.allocationSha256", issues);
    repoRelativePath(source.signalsRef, "bundle.source.signalsRef", issues);
    hashValue(source.signalsSha256, SHA64, "bundle.source.signalsSha256", issues);
  }

  if (!Array.isArray(bundle.machines) || bundle.machines.length === 0) {
    addIssue(issues, "bundle.machines", "required", "must contain at least one machine assignment");
  } else if (bundle.machines.length > 100) {
    addIssue(issues, "bundle.machines", "type", "must contain at most 100 machine assignments");
  }

  const machineIds: string[] = [];
  const allocationUnitIds: string[] = [];
  const storyIds: string[] = [];
  const storyPaths: string[] = [];

  if (Array.isArray(bundle.machines)) {
    bundle.machines.forEach((rawMachine, machineIndex) => {
      const path = `bundle.machines[${machineIndex}]`;
      const machine = requiredRecord(rawMachine, path, issues);
      if (!machine) return;
      exactKeys(machine, ["machineId", "theme", "allocationUnitIds", "storyIds", "storyPaths"], path, issues);
      if (safeId(machine.machineId, `${path}.machineId`, issues)) machineIds.push(machine.machineId);
      nonEmptyString(machine.theme, `${path}.theme`, issues);

      const rawAllocationUnitIds = machine.allocationUnitIds;
      const rawStoryIds = machine.storyIds;
      const rawStoryPaths = machine.storyPaths;
      if (stringArray(rawAllocationUnitIds, `${path}.allocationUnitIds`, issues)) {
        allocationUnitIds.push(...rawAllocationUnitIds);
      }
      const validStoryIds = stringArray(rawStoryIds, `${path}.storyIds`, issues, safeId);
      const validStoryPaths = stringArray(rawStoryPaths, `${path}.storyPaths`, issues, repoRelativePath);
      if (validStoryIds) storyIds.push(...rawStoryIds);
      if (validStoryPaths) storyPaths.push(...rawStoryPaths);
      if (Array.isArray(rawStoryIds) && Array.isArray(rawStoryPaths) && rawStoryIds.length !== rawStoryPaths.length) {
        addIssue(issues, path, "type", "storyIds and storyPaths must have the same length");
      }
      if (Array.isArray(rawStoryIds)) {
        for (const duplicate of duplicateValues(rawStoryIds.filter((item): item is string => typeof item === "string"))) {
          addIssue(issues, `${path}.storyIds`, "duplicate", `duplicate storyId ${duplicate} within machine`);
        }
      }
      if (Array.isArray(rawStoryPaths)) {
        for (const duplicate of duplicateValues(rawStoryPaths.filter((item): item is string => typeof item === "string"))) {
          addIssue(issues, `${path}.storyPaths`, "duplicate", `duplicate storyPath ${duplicate} within machine`);
        }
      }
    });
  }

  for (const duplicate of duplicateValues(machineIds)) {
    addIssue(issues, "bundle.machines", "duplicate", `duplicate machineId ${duplicate}`);
  }
  for (const duplicate of duplicateValues(allocationUnitIds)) {
    addIssue(issues, "bundle.machines", "duplicate", `allocation unit ${duplicate} is assigned more than once`);
  }
  for (const duplicate of duplicateValues(storyIds)) {
    addIssue(issues, "bundle.machines", "duplicate", `storyId ${duplicate} is assigned more than once`);
  }
  for (const duplicate of duplicateValues(storyPaths)) {
    addIssue(issues, "bundle.machines", "duplicate", `storyPath ${duplicate} is assigned more than once`);
  }
  if (storyIds.length > 100) addIssue(issues, "bundle.machines", "type", "machine bundle may contain at most 100 stories");

  return {
    schema: "wheel.zob.fleet-v5-machine-bundle-validation.v1",
    accepted: issues.length === 0,
    value: issues.length === 0 ? bundle as unknown as WheelFleetV5MachineBundle : undefined,
    issues,
    bodyStored: false,
  };
}

function canonicalHashValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("machine bundle hash input cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalHashValue(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalHashValue(record[key])]),
    );
  }
  throw new Error(`unsupported machine bundle hash input type ${typeof value}`);
}

export function computeWheelFleetV5MachineBundleHash(
  bundle: Omit<WheelFleetV5MachineBundle, "bundleHash"> | WheelFleetV5MachineBundle,
  storyFileHashes: Readonly<Record<string, string>>,
): string {
  const preimage = {
    schema: "wheel.zob.fleet-v5-machine-bundle-hash-preimage.v2",
    bundle: {
      schema: bundle.schema,
      bundleId: bundle.bundleId,
      revision: bundle.revision,
      source: {
        repositoryId: bundle.source.repositoryId,
        sourceSha: bundle.source.sourceSha,
        allocationRef: bundle.source.allocationRef,
        allocationSha256: bundle.source.allocationSha256,
        signalsRef: bundle.source.signalsRef,
        signalsSha256: bundle.source.signalsSha256,
      },
      machines: bundle.machines.map((machine) => ({
        machineId: machine.machineId,
        theme: machine.theme,
        allocationUnitIds: [...machine.allocationUnitIds],
        storyIds: [...machine.storyIds],
        storyPaths: [...machine.storyPaths],
      })),
    },
    storyFiles: bundle.machines.flatMap((machine) => machine.storyPaths.map((storyPath) => ({
      storyPath,
      storyFileHash: storyFileHashes[storyPath] ?? null,
    }))),
  };
  return createHash("sha256").update(JSON.stringify(canonicalHashValue(preimage))).digest("hex");
}
