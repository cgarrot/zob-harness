import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const SETTINGS_PATH = join(".pi", "settings.json");
const SNAPSHOT_PATH = join(".pi", "tmp", "zob-switch", "settings-snapshot.json");
const SWITCH_EXTENSION = "extensions/zob-switch/index.ts";
const HARNESS_EXTENSION = "extensions/zob-harness/index.ts";
const ZOB_PROMPTS = "prompts";
const ZOB_SKILLS = "skills";

type JsonObject = Record<string, unknown>;

type Snapshot = {
  schema: "zob.harness-switch.settings-snapshot.v1";
  savedAt: string;
  settings: JsonObject;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

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

function hasValue(settings: JsonObject, key: "extensions" | "prompts" | "skills", value: string): boolean {
  return asStringArray(settings[key]).includes(value);
}

async function readSettings(cwd: string): Promise<JsonObject> {
  const raw = await readFile(join(cwd, SETTINGS_PATH), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isObject(parsed)) throw new Error(`${SETTINGS_PATH} must contain a JSON object`);
  return parsed;
}

async function writeSettings(cwd: string, settings: JsonObject): Promise<void> {
  await writeFile(join(cwd, SETTINGS_PATH), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function writeSnapshot(cwd: string, settings: JsonObject): Promise<void> {
  const snapshot: Snapshot = {
    schema: "zob.harness-switch.settings-snapshot.v1",
    savedAt: new Date().toISOString(),
    settings,
  };
  const snapshotPath = join(cwd, SNAPSHOT_PATH);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function readSnapshot(cwd: string): Promise<Snapshot | null> {
  const snapshotPath = join(cwd, SNAPSHOT_PATH);
  if (!existsSync(snapshotPath)) return null;
  const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as unknown;
  if (!isObject(parsed) || parsed.schema !== "zob.harness-switch.settings-snapshot.v1" || !isObject(parsed.settings)) {
    throw new Error(`${SNAPSHOT_PATH} is not a valid ZOB switch snapshot`);
  }
  return parsed as Snapshot;
}

function shouldWriteOffSnapshot(current: JsonObject, snapshot: Snapshot | null): boolean {
  return snapshot === null || hasValue(current, "extensions", HARNESS_EXTENSION);
}

function buildOffSettings(current: JsonObject): JsonObject {
  return {
    ...current,
    extensions: uniqueWithRequiredFirst(withoutValues(asStringArray(current.extensions), [HARNESS_EXTENSION]), [SWITCH_EXTENSION]),
    prompts: withoutValues(asStringArray(current.prompts), [ZOB_PROMPTS]),
    skills: withoutValues(asStringArray(current.skills), [ZOB_SKILLS]),
  };
}

function buildOnSettings(base: JsonObject, usedSnapshot: boolean): JsonObject {
  return {
    ...base,
    extensions: uniqueWithRequiredFirst(asStringArray(base.extensions), [SWITCH_EXTENSION, HARNESS_EXTENSION]),
    prompts: usedSnapshot ? asStringArray(base.prompts) : uniqueWithRequiredFirst(asStringArray(base.prompts), [ZOB_PROMPTS]),
    skills: usedSnapshot ? asStringArray(base.skills) : uniqueWithRequiredFirst(asStringArray(base.skills), [ZOB_SKILLS]),
  };
}

function statusFor(settings: JsonObject, snapshotPresent: boolean): string {
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

function argumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [
    { value: "on", label: "on", description: "restore ZOB Harness from snapshot/defaults and reload" },
    { value: "off", label: "off", description: "snapshot settings, unload ZOB Harness resources, and reload" },
    { value: "status", label: "status", description: "show switch/harness/prompts/skills/snapshot state" },
  ];
  const filtered = query ? items.filter((item) => item.value.startsWith(query)) : items;
  return filtered.length > 0 ? filtered : null;
}

export default function zobSwitch(pi: ExtensionAPI): void {
  pi.registerCommand("zob", {
    description: "Switch ZOB Harness on/off or show status: /zob on|off|status",
    getArgumentCompletions: argumentCompletions,
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "off") {
        const current = await readSettings(ctx.cwd);
        const snapshot = await readSnapshot(ctx.cwd);
        if (shouldWriteOffSnapshot(current, snapshot)) {
          await writeSnapshot(ctx.cwd, current);
        }
        await writeSettings(ctx.cwd, buildOffSettings(current));
        ctx.ui.notify("ZOB Harness switched off. Reloading Pi resources...", "info");
        await ctx.reload();
        return;
      }

      if (action === "on") {
        const snapshot = await readSnapshot(ctx.cwd);
        const base = snapshot?.settings ?? await readSettings(ctx.cwd);
        await writeSettings(ctx.cwd, buildOnSettings(base, Boolean(snapshot)));
        ctx.ui.notify(`ZOB Harness switched on${snapshot ? " from snapshot" : " with safe defaults"}. Reloading Pi resources...`, "info");
        await ctx.reload();
        return;
      }

      if (action === "" || action === "status") {
        const settings = await readSettings(ctx.cwd);
        const snapshot = await readSnapshot(ctx.cwd);
        ctx.ui.notify(statusFor(settings, Boolean(snapshot)), "info");
        return;
      }

      ctx.ui.notify("Usage: /zob on|off|status", "error");
    },
  });
}
