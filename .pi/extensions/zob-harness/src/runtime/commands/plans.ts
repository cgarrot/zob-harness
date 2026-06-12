import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { HarnessRuntimeState } from "../state.js";
import { listCapturedPlanEntries } from "../plan-capture.js";
import { launchCapturedPlan, previewCapturedPlanLaunch } from "../plan-launch.js";
import { renderHarnessWidget } from "../widget.js";

function formatPlansList(repoRoot: string, limit = 10): string {
  const entries = listCapturedPlanEntries(repoRoot).slice(0, limit);
  if (entries.length === 0) return "No captured plans in plans/index.json.";
  return entries.map((entry) => {
    const launch = entry.launch_status ?? "legacy";
    const todos = entry.todo_count !== undefined ? ` todos=${entry.todo_count}${entry.todo_depth ? `/d${entry.todo_depth}` : ""}` : "";
    return `${entry.plan_id} · ${launch}${todos} · ${entry.relative_path}`;
  }).join("\n");
}

function planArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [
    { value: "list", label: "list", description: "list captured plans" },
    { value: "inspect latest_launchable", label: "inspect latest_launchable", description: "preview latest launchable TODO sidecar" },
    { value: "inspect latest", label: "inspect latest", description: "preview latest captured plan" },
    { value: "launch latest_launchable", label: "launch latest_launchable", description: "launch latest validated plan TODO sidecar" },
    { value: "launch latest_launchable --dry-run", label: "launch latest_launchable --dry-run", description: "validate without creating goal/TODOs" },
  ];
  const filtered = query ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query)) : items;
  return filtered.length > 0 ? filtered : null;
}

function planRefFromArgs(parts: string[]): { plan_id?: string; plan_path?: string; selector?: "latest_launchable" | "latest" } {
  const ref = parts.find((part) => !part.startsWith("--"));
  if (!ref || ref === "latest_launchable") return { selector: "latest_launchable" };
  if (ref === "latest") return { selector: "latest" };
  if (ref.startsWith("plans/") || ref.endsWith(".md") || ref.endsWith(".json")) return { plan_path: ref };
  return { plan_id: ref };
}

export function registerPlanCommands(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerCommand("plans", {
    description: "List captured ZOB plans and launchability status. Use /plan launch latest_launchable to run one.",
    handler: async (args, ctx) => {
      const limitRaw = args.trim().match(/--limit\s+(\d+)/)?.[1];
      const limit = limitRaw ? Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10))) : 10;
      ctx.ui.notify(formatPlansList(ctx.cwd, limit), "info");
    },
  });

  pi.registerCommand("plan", {
    description: "Inspect or launch saved mode-plan TODO manifests: /plan list | inspect [latest|plan_id|path] | launch [latest_launchable|plan_id|path] [--dry-run] [--attach] [--relaunch] [--no-continue]",
    getArgumentCompletions: planArgumentCompletions,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts.shift() ?? "list";
      if (action === "list" || action === "status") {
        ctx.ui.notify(formatPlansList(ctx.cwd), "info");
        return;
      }
      if (action !== "inspect" && action !== "launch") {
        ctx.ui.notify("Usage: /plan list | inspect [latest_launchable|latest|plan_id|path] | launch [latest_launchable|plan_id|path] [--dry-run] [--attach] [--relaunch] [--no-continue]", "warning");
        return;
      }
      const ref = planRefFromArgs(parts);
      const dryRun = action === "inspect" || parts.includes("--dry-run");
      const input = {
        ...ref,
        dry_run: dryRun,
        attach_to_active_goal: parts.includes("--attach"),
        queue_continuation: !parts.includes("--no-continue"),
        relaunch_as_new_goal: parts.includes("--relaunch"),
      };
      const result = dryRun ? previewCapturedPlanLaunch(ctx.cwd, input) : launchCapturedPlan(pi, state, ctx, input);
      renderHarnessWidget(pi, state, ctx);
      void pi.sendMessage({
        customType: "zob-plan-launch-result",
        content: result.summary,
        display: true,
        details: {
          status: result.status,
          planId: result.planId,
          planPath: result.planPath,
          sidecarPath: result.sidecarPath,
          todoCount: result.todoCount,
          launch_status: result.launch_status,
          errors: result.errors,
          bodyStored: false,
        },
      }, { triggerTurn: false });
      ctx.ui.notify(`${result.status}: ${result.planId ?? "plan"}${result.todoCount !== undefined ? ` · ${result.todoCount} TODOs` : ""}`, result.status === "blocked" ? "warning" : "info");
    },
  });
}
