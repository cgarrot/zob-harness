import type { AutocompleteItem } from "@earendil-works/pi-tui";

export function argumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [
    { value: "on", label: "on", description: "restore ZOB Harness from snapshot/defaults and reload" },
    { value: "off", label: "off", description: "snapshot settings, unload ZOB Harness resources, and reload" },
    { value: "status", label: "status", description: "show switch/harness/prompts/skills/snapshot state" },
  ];
  const filtered = query ? items.filter((item) => item.value.startsWith(query)) : items;
  return filtered.length > 0 ? filtered : null;
}
