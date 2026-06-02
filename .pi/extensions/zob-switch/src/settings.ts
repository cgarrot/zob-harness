import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SETTINGS_PATH } from "./paths.js";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function readSettings(cwd: string): Promise<JsonObject> {
  const raw = await readFile(join(cwd, SETTINGS_PATH), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isObject(parsed)) throw new Error(`${SETTINGS_PATH} must contain a JSON object`);
  return parsed;
}

export async function writeSettings(cwd: string, settings: JsonObject): Promise<void> {
  await writeFile(join(cwd, SETTINGS_PATH), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
