import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { argumentCompletions } from "./src/autocomplete.js";
import { HARNESS_EXTENSION, SETTINGS_PATH } from "./src/paths.js";
import { readSettings, writeSettings } from "./src/settings.js";
import type { JsonObject } from "./src/settings.js";
import { readSnapshot, writeSnapshot } from "./src/snapshot.js";
import type { Snapshot } from "./src/snapshot.js";
import { buildOffSettings, buildOnSettings, hasValue, statusFor } from "./src/state.js";

const SNAPSHOT_PATH = join(".pi", "tmp", "zob-switch", "settings-snapshot.json");

function shouldWriteOffSnapshot(current: JsonObject, snapshot: Snapshot | null): boolean {
  return snapshot === null || hasValue(current, "extensions", HARNESS_EXTENSION);
}

export default function zobSwitch(pi: ExtensionAPI): void {
  pi.registerCommand("zob", {
    description: "Switch ZOB Harness on/off or show status: /zob on|off|status",
    getArgumentCompletions: argumentCompletions,
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      const projectSettingsAvailable = existsSync(join(ctx.cwd, SETTINGS_PATH));
      if (!projectSettingsAvailable) {
        const globalMessage = [
          "ZOB Harness switch: global package loaded",
          "project switch: unavailable in this cwd (no .pi/settings.json)",
          "global disable: use `pi remove /Users/cgarrot/zob/zob-harness` outside Pi if needed",
        ].join("\n");
        ctx.ui.notify(action === "" || action === "status" ? globalMessage : `${globalMessage}\n/zob on|off only edits project-local .pi/settings.json when present.`, action === "" || action === "status" ? "info" : "warning");
        return;
      }

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
