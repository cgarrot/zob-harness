import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SNAPSHOT_PATH } from "./paths.js";
import { isObject } from "./settings.js";
import type { JsonObject } from "./settings.js";

export type Snapshot = {
  schema: "zob.harness-switch.settings-snapshot.v1";
  savedAt: string;
  settings: JsonObject;
};

export async function writeSnapshot(cwd: string, settings: JsonObject): Promise<void> {
  const snapshot: Snapshot = {
    schema: "zob.harness-switch.settings-snapshot.v1",
    savedAt: new Date().toISOString(),
    settings,
  };
  const snapshotPath = join(cwd, SNAPSHOT_PATH);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function readSnapshot(cwd: string): Promise<Snapshot | null> {
  const snapshotPath = join(cwd, SNAPSHOT_PATH);
  if (!existsSync(snapshotPath)) return null;
  const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as unknown;
  if (!isObject(parsed) || parsed.schema !== "zob.harness-switch.settings-snapshot.v1" || !isObject(parsed.settings)) {
    throw new Error(`${SNAPSHOT_PATH} is not a valid ZOB switch snapshot`);
  }
  return parsed as Snapshot;
}
