import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { showDelegationOverlay } from "../delegation-overlay.js";
import type { HarnessRuntimeState } from "../state.js";

function delegationArgumentCompletions(state: HarnessRuntimeState, prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string, description?: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    items.push({ value, label, ...(description ? { description } : {}) });
  };
  const runs = [...state.delegations.runs].sort((a, b) => b.startedAtMs - a.startedAtMs);
  for (const run of runs) add(run.agent, run.agent, "agent");
  for (const run of runs.slice(0, 40)) add(run.id.slice(0, 8), run.id.slice(0, 8), `${run.agent} · ${run.status}`);
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

export function registerDelegatesCommands(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerShortcut("ctrl+alt+d", {
    description: "Open ZOB delegated-agent viewer",
    handler: async (ctx) => {
      await showDelegationOverlay(ctx, state);
    },
  });

  const openDelegatesCommand = async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): Promise<void> => {
    await showDelegationOverlay(ctx, state, args.trim().split(/\s+/).filter(Boolean)[0]);
  };

  pi.registerCommand("delegates", {
    description: "Open ZOB delegated-agent viewer. Optional: /delegates <id|agent>",
    getArgumentCompletions: (prefix) => delegationArgumentCompletions(state, prefix),
    handler: openDelegatesCommand,
  });

  pi.registerCommand("delegate", {
    description: "Alias for /delegates. Optional: /delegate <id|agent>",
    getArgumentCompletions: (prefix) => delegationArgumentCompletions(state, prefix),
    handler: openDelegatesCommand,
  });
}
