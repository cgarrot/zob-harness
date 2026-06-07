import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type HarnessCommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];
