import { join } from "node:path";

export const SETTINGS_PATH = join(".pi", "settings.json");
export const SNAPSHOT_PATH = join(".pi", "tmp", "zob-switch", "settings-snapshot.json");
export const SWITCH_EXTENSION = "extensions/zob-switch/index.ts";
export const HARNESS_EXTENSION = "extensions/zob-harness/index.ts";
export const ZOB_PROMPTS = "prompts";
export const ZOB_SKILLS = "skills";
