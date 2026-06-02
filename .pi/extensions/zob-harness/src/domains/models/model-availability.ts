import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isRecord } from "../../core/utils/records.js";

export type ExplicitModelOverrideValidation = {
  ok: boolean;
  errors: string[];
};

function explicitModelOverrideHelp(model: string, reason: string): string {
  return [
    `explicit model override '${model}' is not allowed for child launch: ${reason}`,
    "desired, configured, or catalogued model names are not runtime availability/authentication proof",
    "omit model to use the parent/session default, or choose a model in .pi/model-catalog.json with resolutionStatus=verified after confirming current provider availability for this session",
  ].join("; ");
}

export function validateExplicitModelOverride(repoRoot: string, modelOverride: string | undefined): ExplicitModelOverrideValidation {
  const model = modelOverride?.trim();
  if (!model) return { ok: true, errors: [] };

  const catalogPath = join(repoRoot, ".pi", "model-catalog.json");
  if (!existsSync(catalogPath)) {
    return { ok: false, errors: [explicitModelOverrideHelp(model, ".pi/model-catalog.json is missing")] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(catalogPath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [explicitModelOverrideHelp(model, `.pi/model-catalog.json could not be read as JSON (${message})`)] };
  }

  const models = isRecord(parsed) && isRecord(parsed.models) ? parsed.models : undefined;
  if (!models) {
    return { ok: false, errors: [explicitModelOverrideHelp(model, ".pi/model-catalog.json has no models object")] };
  }

  const entry = models[model];
  if (!isRecord(entry)) {
    return { ok: false, errors: [explicitModelOverrideHelp(model, "model is not present in .pi/model-catalog.json")] };
  }

  if (entry.resolutionStatus !== "verified") {
    const status = typeof entry.resolutionStatus === "string" ? entry.resolutionStatus : "missing";
    return { ok: false, errors: [explicitModelOverrideHelp(model, `catalog resolutionStatus is '${status}', not 'verified'`)] };
  }

  return { ok: true, errors: [] };
}
