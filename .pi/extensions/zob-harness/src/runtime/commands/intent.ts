import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { classifyIntent, loadIntentClassifierConfig, writeIntentClassifierConfig, type IntentClassifierConfig, type IntentClassifierFallback, type IntentClassifierProvider } from "../../domains/intent/intent-classifier.js";
import type { HarnessRuntimeState } from "../state.js";
import type { HarnessCommandContext } from "./types.js";

type IntentClassifierModelItem = { value: string; label: string; description?: string };

let cachedIntentClassifierModelItems: IntentClassifierModelItem[] = [];

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function modelLabel(model: { provider: string; id: string; name?: string }): string {
  return model.name && model.name !== model.id ? `${model.provider}/${model.id} · ${model.name}` : `${model.provider}/${model.id}`;
}

export function refreshIntentClassifierModelCache(ctx: { modelRegistry: HarnessCommandContext["modelRegistry"]; model?: HarnessCommandContext["model"] }): void {
  const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
  cachedIntentClassifierModelItems = ctx.modelRegistry.getAvailable()
    .filter((model) => model.input.includes("text"))
    .map((model) => ({
      value: modelKey(model),
      label: modelLabel(model),
      description: modelKey(model) === currentKey ? "current model" : `${model.provider} · ${model.api}`,
    }))
    .sort((a, b) => (a.description === "current model" ? -1 : b.description === "current model" ? 1 : a.value.localeCompare(b.value)))
    .slice(0, 200);
}

function intentClassifierArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const commandItems: AutocompleteItem[] = [
    { value: "status", label: "status", description: "show current classifier posture" },
    { value: "regex", label: "regex", description: "local regex-only classifier; no model call" },
    { value: "model-strict", label: "model-strict", description: "use selected/current Pi model; failures/low-confidence become unknown, not regex" },
    { value: "model-fallback", label: "model-fallback", description: "use selected/current Pi model first; fallback to regex" },
    { value: "test ", label: "test <text>", description: "classify one prompt with the current config" },
    { value: "help", label: "help", description: "insert usage help" },
  ];
  const modelItems: AutocompleteItem[] = [];
  const modelMatch = /^(model-strict|model-fallback)\s+(.+)?$/i.exec(prefix);
  if (modelMatch) {
    const modelQuery = (modelMatch[2] ?? "").trim().toLowerCase();
    const command = modelMatch[1];
    for (const item of cachedIntentClassifierModelItems) {
      if (!modelQuery || item.value.toLowerCase().includes(modelQuery) || item.label.toLowerCase().includes(modelQuery) || item.description?.toLowerCase().includes(modelQuery)) {
        modelItems.push({ value: `${command} ${item.value}`, label: item.label, description: item.description });
      }
    }
    return modelItems.length > 0 ? modelItems.slice(0, 30) : null;
  }
  const filtered = query
    ? commandItems.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : commandItems;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

type IntentClassifierCommandAction = "status" | "help" | "regex" | "model" | "model-strict" | "model-fallback" | "test";

type IntentClassifierCommandOptions = {
  provider?: IntentClassifierProvider;
  model?: string;
  endpoint?: string;
  apiKeyEnv?: string;
  requestFormat?: "openai-chat" | "generic-chat";
  fallback?: IntentClassifierFallback;
  sendUserTextToProvider?: boolean;
  minConfidence?: number;
  timeoutMs?: number;
  errors: string[];
};

function parseIntentClassifierBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["on", "true", "yes", "1"].includes(normalized)) return true;
  if (["off", "false", "no", "0"].includes(normalized)) return false;
  return undefined;
}

function parseIntentClassifierOptions(raw: string): IntentClassifierCommandOptions {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const parsed: IntentClassifierCommandOptions = { errors: [] };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const readValue = (flag: string): string | undefined => {
      const value = parts[index + 1];
      if (!value || value.startsWith("--")) {
        parsed.errors.push(`${flag} requires a value`);
        return undefined;
      }
      index += 1;
      return value;
    };
    if (part === "--api-key" || part === "--apikey" || part === "--token") {
      parsed.errors.push("do not pass secrets to /intent-classifier; configure provider auth through Pi/login or environment-backed config");
      continue;
    }
    if (part === "--provider") {
      const value = readValue(part);
      if (value === "http-json" || value === "pi-provider") parsed.provider = value;
      else if (value) parsed.errors.push("--provider must be pi-provider or http-json");
      continue;
    }
    if (part === "--model") {
      const value = readValue(part);
      if (value) parsed.model = value;
      continue;
    }
    if (part === "--endpoint") {
      const value = readValue(part);
      if (value) parsed.endpoint = value;
      continue;
    }
    if (part === "--api-key-env") {
      const value = readValue(part);
      if (value) parsed.apiKeyEnv = value;
      continue;
    }
    if (part === "--format" || part === "--request-format") {
      const value = readValue(part);
      if (value === "openai-chat" || value === "generic-chat") parsed.requestFormat = value;
      else if (value) parsed.errors.push("--format must be openai-chat or generic-chat");
      continue;
    }
    if (part === "--fallback") {
      const value = readValue(part);
      if (value === "regex" || value === "unknown") parsed.fallback = value;
      else if (value) parsed.errors.push("--fallback must be regex or unknown");
      continue;
    }
    if (part === "--send" || part === "--send-user-text") {
      const value = parseIntentClassifierBoolean(readValue(part));
      if (typeof value === "boolean") parsed.sendUserTextToProvider = value;
      else parsed.errors.push(`${part} must be on|off|true|false`);
      continue;
    }
    if (part === "--min-confidence") {
      const value = Number(readValue(part));
      if (Number.isFinite(value) && value >= 0 && value <= 1) parsed.minConfidence = value;
      else parsed.errors.push("--min-confidence must be a number between 0 and 1");
      continue;
    }
    if (part === "--timeout-ms") {
      const value = Number(readValue(part));
      if (Number.isFinite(value) && value >= 250 && value <= 30_000) parsed.timeoutMs = Math.trunc(value);
      else parsed.errors.push("--timeout-ms must be between 250 and 30000");
      continue;
    }
    if (!part.startsWith("--") && !parsed.model) {
      parsed.model = part;
      continue;
    }
    parsed.errors.push(`unknown option: ${part}`);
  }
  return parsed;
}

function cloneIntentClassifierConfig(config: IntentClassifierConfig): IntentClassifierConfig {
  return {
    ...config,
    allowedIntents: [...config.allowedIntents],
    providers: {
      ...config.providers,
      "http-json": { ...(config.providers["http-json"] ?? {}) },
      "pi-provider": { ...(config.providers["pi-provider"] ?? {}) },
    },
  };
}

function applyIntentClassifierPreset(current: IntentClassifierConfig, action: Extract<IntentClassifierCommandAction, "regex" | "model" | "model-strict" | "model-fallback">, options: IntentClassifierCommandOptions, activeModel?: string): IntentClassifierConfig {
  const next = cloneIntentClassifierConfig(current);
  if (action === "regex") {
    next.enabled = false;
    next.provider = "regex";
    next.fallback = "regex";
    next.sendUserTextToProvider = false;
  } else {
    next.enabled = true;
    next.provider = options.provider ?? "pi-provider";
    next.fallback = options.fallback ?? (action === "model-fallback" ? "regex" : "unknown");
    next.sendUserTextToProvider = options.sendUserTextToProvider ?? true;
    next.model = options.model ?? activeModel ?? next.model;
  }
  if (options.model) next.model = options.model;
  if (typeof options.minConfidence === "number") next.minConfidence = options.minConfidence;
  if (typeof options.timeoutMs === "number") next.timeoutMs = options.timeoutMs;
  const httpProvider = next.providers["http-json"] ?? {};
  next.providers["http-json"] = {
    ...httpProvider,
    endpoint: options.endpoint ?? httpProvider.endpoint ?? "",
    apiKeyEnv: options.apiKeyEnv ?? httpProvider.apiKeyEnv ?? "",
    requestFormat: options.requestFormat ?? httpProvider.requestFormat ?? "openai-chat",
  };
  next.providers["pi-provider"] = {
    ...(next.providers["pi-provider"] ?? {}),
    enabled: next.provider === "pi-provider",
  };
  return next;
}

function intentClassifierPosture(config: IntentClassifierConfig): string {
  if (!config.enabled || config.provider === "regex") return "regex-only";
  if (!config.sendUserTextToProvider) return `model-configured-but-send-disabled → fallback:${config.fallback}`;
  return config.fallback === "unknown" ? "model-strict" : "model-with-regex-fallback";
}

function formatIntentClassifierStatus(config: IntentClassifierConfig): string {
  const httpProvider = config.providers["http-json"] ?? {};
  return [
    `posture=${intentClassifierPosture(config)}`,
    `enabled=${config.enabled}`,
    `provider=${config.provider}`,
    `model=${config.model || "active/default"}`,
    `fallback=${config.fallback}`,
    `autoSwitch=${config.autoSwitchIntents.join(",")}`,
    `sendUserTextToProvider=${config.sendUserTextToProvider}`,
    config.provider === "http-json" ? `endpoint=${httpProvider.endpoint ? "set" : "unset"}` : undefined,
    config.provider === "http-json" ? `apiKeyEnv=${httpProvider.apiKeyEnv || "unset"}` : undefined,
    config.provider === "http-json" ? `format=${httpProvider.requestFormat ?? "openai-chat"}` : undefined,
    `minConfidence=${config.minConfidence}`,
    `timeoutMs=${config.timeoutMs}`,
  ].filter(Boolean).join(" · ");
}

function intentClassifierHelpTemplate(): string {
  return [
    "# ZOB intent classifier",
    "",
    "Usage:",
    "/intent status",
    "/intent regex",
    "/intent model-strict [provider/model-id]",
    "/intent model-fallback [provider/model-id]",
    "/intent test <text to classify>",
    "",
    "Examples:",
    "/intent model-strict",
    "/intent model-strict anthropic/claude-sonnet-4-20250514",
    "/intent model-fallback openai/gpt-4o-mini",
    "",
    "Presets:",
    "- regex: local regex only; no provider call",
    "- model-strict: Pi provider model when available; failures/low-confidence become unknown, never regex",
    "- model-fallback: Pi provider model when available; otherwise regex fallback",
    "- auto-switch: configured intents switch mode directly; default config enables explore, plan, implement, oracle, factory, orchestrator, vanilla",
    "",
    "Model selection:",
    "- If no model is passed, the current Pi model is used.",
    "- Autocomplete after `model-strict ` or `model-fallback ` lists available Pi models.",
    "- Advanced direct HTTP testing remains possible with hidden flags: --provider http-json --endpoint <url> --model <id>.",
    "",
    "Safety:",
    "- The classifier only suggests intent/mode routing.",
    "- It never approves secrets, destructive commands, commits, deploys, no-ship, or session access.",
    "- /intent test stores only inputHash metadata, not raw test text.",
  ].join("\n");
}

export function registerIntentCommands(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  const handleIntentClassifierCommand = async (args: string, ctx: HarnessCommandContext): Promise<void> => {
    const trimmed = args.trim();
    const actionToken = trimmed.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "status";
    const rest = actionToken ? trimmed.slice(actionToken.length).trim() : "";
    const action = actionToken as IntentClassifierCommandAction;
    if (action === "help") {
      ctx.ui.setEditorText(intentClassifierHelpTemplate());
      ctx.ui.notify("Intent classifier command help inserted. Use /intent status or /intent model-strict [model].", "info");
      return;
    }
    if (action === "status") {
      const config = loadIntentClassifierConfig(ctx.cwd);
      pi.appendEntry("zob-intent-classifier-command", {
        schema: "zob.intent-classifier-command.v1",
        action: "status",
        posture: intentClassifierPosture(config),
        enabled: config.enabled,
        provider: config.provider,
        fallback: config.fallback,
        autoSwitchIntents: config.autoSwitchIntents,
        sendUserTextToProvider: config.sendUserTextToProvider,
        endpointConfigured: Boolean(config.providers["http-json"]?.endpoint),
        apiKeyEnv: config.providers["http-json"]?.apiKeyEnv || undefined,
        rawInputStored: false,
        bodyStored: false,
        generatedAt: new Date().toISOString(),
      });
      ctx.ui.notify(`intent-classifier ${formatIntentClassifierStatus(config)}`, "info");
      return;
    }
    if (action === "test") {
      if (!rest) {
        ctx.ui.notify("Usage: /intent-classifier test <text to classify>", "warning");
        return;
      }
      const classified = await classifyIntent(rest, ctx.cwd, undefined, { model: ctx.model, modelRegistry: ctx.modelRegistry, signal: ctx.signal });
      pi.appendEntry("zob-intent-classifier-command", {
        schema: "zob.intent-classifier-command.v1",
        action: "test",
        intent: classified.intent,
        confidence: classified.confidence,
        provider: classified.provider,
        configuredProvider: classified.configuredProvider,
        model: classified.model,
        fallbackReason: classified.fallbackReason,
        inputHash: classified.inputHash,
        rawInputStored: false,
        safetyApproved: false,
        bodyStored: false,
        generatedAt: new Date().toISOString(),
      });
      ctx.ui.notify(`intent=${classified.intent} provider=${classified.provider} configured=${classified.configuredProvider} confidence=${classified.confidence.toFixed(2)}${classified.fallbackReason ? ` fallback=${classified.fallbackReason}` : ""} rawInputStored=false safetyApproved=false`, classified.provider === "fallback" ? "warning" : "info");
      return;
    }
    if (action !== "regex" && action !== "model" && action !== "model-strict" && action !== "model-fallback") {
      ctx.ui.notify("Unknown /intent-classifier command. Use status | regex | model-strict | model-fallback | test <text> | help", "warning");
      return;
    }
    const options = parseIntentClassifierOptions(rest);
    if (options.errors.length > 0) {
      ctx.ui.notify(`/intent-classifier blocked: ${options.errors.join(" | ")}`, "warning");
      return;
    }
    refreshIntentClassifierModelCache(ctx);
    if (action !== "regex" && options.provider !== "http-json") {
      const available = ctx.modelRegistry.getAvailable().filter((model) => model.input.includes("text"));
      const requestedModel = options.model;
      if (requestedModel) {
        const matched = available.find((model) => modelKey(model) === requestedModel || model.id === requestedModel || model.name === requestedModel);
        options.model = matched ? modelKey(matched) : requestedModel;
      } else if (ctx.model) {
        options.model = modelKey(ctx.model);
      } else if (ctx.hasUI && available.length > 0) {
        const choices = available.slice(0, 80).map(modelKey);
        const selected = await ctx.ui.select("Intent classifier model", choices);
        if (!selected) {
          ctx.ui.notify("/intent-classifier cancelled: no model selected", "warning");
          return;
        }
        options.model = selected;
      } else {
        ctx.ui.notify("/intent-classifier blocked: no current or available Pi model found", "warning");
        return;
      }
    }
    const current = loadIntentClassifierConfig(ctx.cwd);
    const activeModel = ctx.model ? modelKey(ctx.model) : undefined;
    const next = writeIntentClassifierConfig(ctx.cwd, applyIntentClassifierPreset(current, action, options, activeModel));
    pi.appendEntry("zob-intent-classifier-command", {
      schema: "zob.intent-classifier-command.v1",
      action,
      posture: intentClassifierPosture(next),
      enabled: next.enabled,
      provider: next.provider,
      model: next.model,
      fallback: next.fallback,
      autoSwitchIntents: next.autoSwitchIntents,
      sendUserTextToProvider: next.sendUserTextToProvider,
      endpointConfigured: Boolean(next.providers["http-json"]?.endpoint),
      apiKeyEnv: next.providers["http-json"]?.apiKeyEnv || undefined,
      rawInputStored: false,
      bodyStored: false,
      generatedAt: new Date().toISOString(),
    });
    const endpointWarning = next.enabled && next.provider === "http-json" && !next.providers["http-json"]?.endpoint ? " · endpoint unset: tests will fallback" : "";
    const sendWarning = next.enabled && next.provider !== "regex" && next.sendUserTextToProvider ? " · future classification text may be sent to selected provider" : "";
    ctx.ui.notify(`intent-classifier updated: ${formatIntentClassifierStatus(next)}${endpointWarning}${sendWarning}`, next.enabled && next.provider !== "regex" ? "warning" : "info");
  };

  pi.registerCommand("intent-classifier", {
    description: "Configure/test ZOB intent classifier: status | regex | model-strict | model-fallback | test <text>",
    getArgumentCompletions: intentClassifierArgumentCompletions,
    handler: handleIntentClassifierCommand,
  });

  pi.registerCommand("intent", {
    description: "Alias for /intent-classifier",
    getArgumentCompletions: intentClassifierArgumentCompletions,
    handler: handleIntentClassifierCommand,
  });
}
