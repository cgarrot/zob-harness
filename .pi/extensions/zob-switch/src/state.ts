import { HARNESS_EXTENSION, SWITCH_EXTENSION, ZOB_PROMPTS, ZOB_SKILLS } from "./paths.js";
import { asStringArray } from "./settings.js";
import type { JsonObject } from "./settings.js";

function uniqueWithRequiredFirst(values: string[], requiredFirst: string[]): string[] {
  const result: string[] = [];
  for (const value of [...requiredFirst, ...values]) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function withoutValues(values: string[], remove: string[]): string[] {
  return values.filter((value) => !remove.includes(value));
}

export function hasValue(settings: JsonObject, key: "extensions" | "prompts" | "skills", value: string): boolean {
  return asStringArray(settings[key]).includes(value);
}

export function buildOffSettings(current: JsonObject): JsonObject {
  return {
    ...current,
    extensions: uniqueWithRequiredFirst(withoutValues(asStringArray(current.extensions), [HARNESS_EXTENSION]), [SWITCH_EXTENSION]),
    prompts: withoutValues(asStringArray(current.prompts), [ZOB_PROMPTS]),
    skills: withoutValues(asStringArray(current.skills), [ZOB_SKILLS]),
  };
}

export function buildOnSettings(base: JsonObject, usedSnapshot: boolean): JsonObject {
  return {
    ...base,
    extensions: uniqueWithRequiredFirst(asStringArray(base.extensions), [SWITCH_EXTENSION, HARNESS_EXTENSION]),
    prompts: usedSnapshot ? asStringArray(base.prompts) : uniqueWithRequiredFirst(asStringArray(base.prompts), [ZOB_PROMPTS]),
    skills: usedSnapshot ? asStringArray(base.skills) : uniqueWithRequiredFirst(asStringArray(base.skills), [ZOB_SKILLS]),
  };
}

export function statusFor(settings: JsonObject, snapshotPresent: boolean): string {
  const switchConfigured = hasValue(settings, "extensions", SWITCH_EXTENSION);
  const harnessConfigured = hasValue(settings, "extensions", HARNESS_EXTENSION);
  const promptsConfigured = hasValue(settings, "prompts", ZOB_PROMPTS);
  const skillsConfigured = hasValue(settings, "skills", ZOB_SKILLS);
  const state = switchConfigured && harnessConfigured && promptsConfigured && skillsConfigured
    ? "on"
    : switchConfigured && !harnessConfigured && !promptsConfigured && !skillsConfigured
      ? "off"
      : "partial";
  return [
    `ZOB Harness switch: ${state}`,
    `switch extension: ${switchConfigured ? "configured" : "missing"}`,
    `harness extension: ${harnessConfigured ? "configured" : "missing"}`,
    `prompts: ${promptsConfigured ? "configured" : "missing"}`,
    `skills: ${skillsConfigured ? "configured" : "missing"}`,
    `snapshot: ${snapshotPresent ? "present" : "missing"}`,
  ].join("\n");
}
