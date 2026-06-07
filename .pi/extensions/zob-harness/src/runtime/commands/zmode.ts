import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODE_PROMPTS } from "../../core/constants.js";
import type { ModeName } from "../../types.js";
import { resolveAdaptiveZmodeEntrypoint, renderAdaptiveZmodeTemplate } from "../adaptive-zmode.js";
import { resolveRuleProfile } from "../../domains/governance/rules.js";
import type { HarnessRuntimeState } from "../state.js";
import { applyMode, renderHarnessWidget } from "../widget.js";

export function registerZmodeCommand(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerCommand("zmode", {
    description: "Switch ZOB harness mode: explore | plan | implement | oracle | factory | orchestrator | vanilla. Orchestrator routes to adaptive-chief-vision plan_only defaults; vanilla restores Pi base-style unrestricted tool access outside ZOB governance.",
    handler: async (args, ctx) => {
      const requestedText = args.trim();
      const adaptiveEntrypoint = resolveAdaptiveZmodeEntrypoint(requestedText);
      if (adaptiveEntrypoint) {
        applyMode(pi, state, ctx, adaptiveEntrypoint.appliedHarnessMode);
        state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
        pi.appendEntry("zob-adaptive-zmode-entrypoint", adaptiveEntrypoint);
        ctx.ui.setEditorText(renderAdaptiveZmodeTemplate(adaptiveEntrypoint));
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`ZOB ${adaptiveEntrypoint.requestedMode} routed to ${adaptiveEntrypoint.profile} (${adaptiveEntrypoint.executionDefault}); root remains non-coding and parent-owned.`, "info");
        return;
      }
      const requested = requestedText as ModeName;
      const modes = Object.keys(MODE_PROMPTS) as ModeName[];
      if (!requested) {
        const choice = await ctx.ui.select("ZOB mode", modes);
        if (choice) {
          applyMode(pi, state, ctx, choice as ModeName);
          state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
        }
        return;
      }
      if (!modes.includes(requested)) {
        ctx.ui.notify(`Unknown mode '${requested}'. Use: ${modes.join(", ")}`, "warning");
        return;
      }
      applyMode(pi, state, ctx, requested);
      state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
    },
  });
}
