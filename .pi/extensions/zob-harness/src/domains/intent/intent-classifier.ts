import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { completeSimple, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { sha256 } from "../../core/utils/hashing.js";
import type { ModeName } from "../../types.js";

export type IntentName = ModeName | "unknown";
export type IntentClassifierProvider = "regex" | "http-json" | "pi-provider";
export type IntentClassifierFallback = "regex" | "unknown";
export type IntentClassifierRequestFormat = "openai-chat" | "generic-chat";

export interface IntentClassifierHttpProviderConfig {
  endpoint?: string;
  apiKeyEnv?: string;
  requestFormat?: IntentClassifierRequestFormat;
}

export interface IntentClassifierConfig {
  schema: "zob.intent-classifier.config.v1";
  enabled: boolean;
  provider: IntentClassifierProvider;
  model: string;
  minConfidence: number;
  timeoutMs: number;
  fallback: IntentClassifierFallback;
  sendUserTextToProvider: boolean;
  providers: {
    "http-json"?: IntentClassifierHttpProviderConfig;
    "pi-provider"?: {
      enabled?: boolean;
      note?: string;
    };
  };
  allowedIntents: IntentName[];
  autoSwitchIntents: ModeName[];
}

export interface IntentClassifierResult {
  schema: "zob.intent-classifier.result.v1";
  intent: IntentName;
  confidence: number;
  needsClarification: boolean;
  provider: "regex" | "model" | "fallback";
  configuredProvider: IntentClassifierProvider;
  model?: string;
  reason: string;
  evidence: string[];
  fallbackReason?: string;
  inputHash: string;
  rawInputStored: false;
  safetyApproved: false;
  autoSwitch: boolean;
}

interface ModelResponseShape {
  intent?: unknown;
  confidence?: unknown;
  needsClarification?: unknown;
  reason?: unknown;
  evidence?: unknown;
}

export interface IntentClassifierPiRuntime {
  model?: Model<Api>;
  modelRegistry?: ModelRegistry;
  signal?: AbortSignal;
}

export const INTENT_CLASSIFIER_CONFIG_PATH = join(".pi", "routing", "intent-classifier.json");
const CONFIG_PATH = INTENT_CLASSIFIER_CONFIG_PATH;
const MODE_INTENTS: readonly ModeName[] = ["explore", "plan", "implement", "oracle", "factory", "orchestrator", "vanilla"];
const ALLOWED_INTENTS: readonly IntentName[] = [...MODE_INTENTS, "unknown"];

const DEFAULT_CONFIG: IntentClassifierConfig = {
  schema: "zob.intent-classifier.config.v1",
  enabled: false,
  provider: "regex",
  model: "",
  minConfidence: 0.72,
  timeoutMs: 5000,
  fallback: "regex",
  sendUserTextToProvider: false,
  providers: {
    "http-json": {
      endpoint: "",
      apiKeyEnv: "",
      requestFormat: "openai-chat",
    },
    "pi-provider": {
      enabled: false,
      note: "Uses Pi model registry/auth for one-shot active-provider classification when runtime context is available.",
    },
  },
  allowedIntents: [...ALLOWED_INTENTS],
  autoSwitchIntents: [...MODE_INTENTS],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function intentName(value: unknown): IntentName {
  return typeof value === "string" && ALLOWED_INTENTS.includes(value as IntentName) ? value as IntentName : "unknown";
}

function modeName(value: unknown): ModeName | undefined {
  return typeof value === "string" && MODE_INTENTS.includes(value as ModeName) ? value as ModeName : undefined;
}

function providerName(value: unknown): IntentClassifierProvider {
  if (value === "http-json" || value === "pi-provider") return value;
  return "regex";
}

function fallbackName(value: unknown): IntentClassifierFallback {
  return value === "unknown" ? "unknown" : "regex";
}

function requestFormat(value: unknown): IntentClassifierRequestFormat {
  return value === "generic-chat" ? "generic-chat" : "openai-chat";
}

function normalizeConfig(value: unknown): IntentClassifierConfig {
  if (!isRecord(value) || value.schema !== "zob.intent-classifier.config.v1") {
    return {
      ...DEFAULT_CONFIG,
      providers: {
        "http-json": { ...DEFAULT_CONFIG.providers["http-json"] },
        "pi-provider": { ...DEFAULT_CONFIG.providers["pi-provider"] },
      },
      allowedIntents: [...DEFAULT_CONFIG.allowedIntents],
      autoSwitchIntents: [...DEFAULT_CONFIG.autoSwitchIntents],
    };
  }
  const providers = isRecord(value.providers) ? value.providers : {};
  const httpJson = isRecord(providers["http-json"]) ? providers["http-json"] : {};
  const piProvider = isRecord(providers["pi-provider"]) ? providers["pi-provider"] : {};
  const allowedIntentValues = Array.isArray(value.allowedIntents) ? value.allowedIntents : undefined;
  const allowedIntents = allowedIntentValues
    ? allowedIntentValues.map(intentName).filter((intent) => intent !== "unknown" || allowedIntentValues.includes("unknown"))
    : [...ALLOWED_INTENTS];
  const autoSwitchIntentValues = Array.isArray(value.autoSwitchIntents) ? value.autoSwitchIntents : undefined;
  const autoSwitchIntents = autoSwitchIntentValues
    ? autoSwitchIntentValues.map(modeName).filter((intent): intent is ModeName => Boolean(intent))
    : [...MODE_INTENTS];
  return {
    schema: "zob.intent-classifier.config.v1",
    enabled: booleanValue(value.enabled, DEFAULT_CONFIG.enabled),
    provider: providerName(value.provider),
    model: stringValue(value.model, DEFAULT_CONFIG.model).trim(),
    minConfidence: numberInRange(value.minConfidence, DEFAULT_CONFIG.minConfidence, 0, 1),
    timeoutMs: Math.trunc(numberInRange(value.timeoutMs, DEFAULT_CONFIG.timeoutMs, 250, 30_000)),
    fallback: fallbackName(value.fallback),
    sendUserTextToProvider: booleanValue(value.sendUserTextToProvider, DEFAULT_CONFIG.sendUserTextToProvider),
    providers: {
      "http-json": {
        endpoint: stringValue(httpJson.endpoint).trim(),
        apiKeyEnv: stringValue(httpJson.apiKeyEnv).trim(),
        requestFormat: requestFormat(httpJson.requestFormat),
      },
      "pi-provider": {
        enabled: booleanValue(piProvider.enabled, false),
        note: stringValue(piProvider.note, DEFAULT_CONFIG.providers["pi-provider"]?.note).trim(),
      },
    },
    allowedIntents: allowedIntents.length > 0 ? [...new Set(allowedIntents)] : [...ALLOWED_INTENTS],
    autoSwitchIntents: autoSwitchIntents.length > 0 ? [...new Set(autoSwitchIntents)] : [...MODE_INTENTS],
  };
}

export function loadIntentClassifierConfig(repoRoot: string): IntentClassifierConfig {
  const path = join(repoRoot, CONFIG_PATH);
  if (!existsSync(path)) return normalizeConfig(undefined);
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeConfig(undefined);
  }
}

export function writeIntentClassifierConfig(repoRoot: string, config: IntentClassifierConfig): IntentClassifierConfig {
  const normalized = normalizeConfig(config);
  const path = join(repoRoot, CONFIG_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function result(input: { text: string; config: IntentClassifierConfig; intent: IntentName; confidence: number; needsClarification?: boolean; provider: "regex" | "model" | "fallback"; reason: string; evidence?: string[]; fallbackReason?: string }): IntentClassifierResult {
  return {
    schema: "zob.intent-classifier.result.v1",
    intent: input.intent,
    confidence: numberInRange(input.confidence, 0, 0, 1),
    needsClarification: input.needsClarification ?? input.intent === "unknown",
    provider: input.provider,
    configuredProvider: input.config.provider,
    model: input.provider === "model" ? input.config.model : undefined,
    reason: input.reason.slice(0, 240),
    evidence: (input.evidence ?? []).slice(0, 8).map((item) => item.slice(0, 160)),
    fallbackReason: input.fallbackReason,
    inputHash: sha256(input.text),
    rawInputStored: false,
    safetyApproved: false,
    autoSwitch: Boolean(modeName(input.intent) && input.config.autoSwitchIntents.includes(input.intent as ModeName)),
  };
}

export function classifyIntentRegex(text: string, config: IntentClassifierConfig = DEFAULT_CONFIG): IntentClassifierResult {
  const normalized = text.trim().toLowerCase();
  if (!normalized || normalized.startsWith("/")) {
    return result({ text, config, intent: "unknown", confidence: 0, provider: "regex", reason: "empty or slash command input", evidence: [] });
  }
  if (/\b(vanilla|vania|pi\s+base|base\s+pi|codex|external\s+(?:command|tool|agent)|unrestricted|arbitrary\s+command|no\s+guardrails?)\b/i.test(normalized)) {
    return result({ text, config, intent: "vanilla", confidence: 0.92, provider: "regex", reason: "explicit vanilla or unrestricted execution wording", evidence: ["vanilla/external-command keyword"] });
  }
  if (/\b(orchestrator|orchestrat(?:e|ion|or)|multi[- ]?agent|lead(?:s)?|worker(?:s)?|chief vision|delegat(?:e|ion)|sub[- ]?agents?|subtasks?|work graph|todo graph)\b/i.test(normalized)) {
    return result({ text, config, intent: "orchestrator", confidence: 0.86, provider: "regex", reason: "orchestration or multi-agent wording", evidence: ["orchestrator/multi-agent keyword"] });
  }
  if (/\b(review|validate|validation|oracle|no[_-]?ship|verify|audit|qa|risks?|blocker)\b/i.test(normalized) && !/\b(update|modify|change|fix|patch|implement|edit|write|add|create|delete|remove|refactor)\b/i.test(normalized)) {
    return result({ text, config, intent: "oracle", confidence: 0.76, provider: "regex", reason: "review or validation wording without mutation wording", evidence: ["review/validation keyword"] });
  }
  if (/\b(plan|design|architecture|propose|roadmap|specify|how would|strategy)\b/i.test(normalized) && !/\b(update|modify|change|fix|patch|implement|edit|write|add|create|delete|remove|refactor)\b/i.test(normalized)) {
    return result({ text, config, intent: "plan", confidence: 0.74, provider: "regex", reason: "planning wording without mutation wording", evidence: ["plan/design keyword"] });
  }
  if (/\b(update|udpate|modify|change|correction|fix|patch|implement|edit|write|add|create|delete|remove|refactor|continue .*update)\b/i.test(normalized)) {
    const factoryIntent = /\b(factory|factory_run|pilot|batch|sentinel|manifest|quarantine|software factory)\b/i.test(normalized);
    return result({ text, config, intent: factoryIntent ? "factory" : "implement", confidence: factoryIntent ? 0.82 : 0.8, provider: "regex", reason: factoryIntent ? "mutation wording plus factory workflow wording" : "mutation wording", evidence: [factoryIntent ? "factory keyword" : "mutation keyword"] });
  }
  if (/\b(read|explore|inspect|analy[sz]e|understand|find|diagnostic)\b/i.test(normalized)) {
    return result({ text, config, intent: "explore", confidence: 0.68, provider: "regex", reason: "read-only exploration wording", evidence: ["explore/inspect keyword"] });
  }
  return result({ text, config, intent: "unknown", confidence: 0.2, provider: "regex", reason: "no intent pattern matched", evidence: [] });
}

function classifierPrompt(text: string, allowedIntents: IntentName[]): string {
  return [
    "Classify the user's ZOB harness intent. Choose exactly one primary intent.",
    "Return strict JSON only with keys: intent, confidence, needsClarification, reason, evidence.",
    `Allowed intents: ${allowedIntents.join(", ")}.`,
    "Mode selection guide:",
    "- explore: user wants read-only inspection, analysis, search, diagnosis, context gathering, or understanding; no code/repo mutation requested.",
    "- plan: user wants a plan, design, architecture, roadmap, specification, or strategy before doing work; no immediate implementation requested.",
    "- implement: user wants edits, fixes, creation, deletion, refactoring, code changes, docs changes, or other repo mutation.",
    "- oracle: user wants skeptical review, validation, QA, audit, evidence check, no-ship/blocker review, or final verification.",
    "- factory: user wants a repeatable software factory, manifest, smoke/pilot/batch workflow, sentinel/checkpoint, quarantine, or factory_run path.",
    "- orchestrator: user wants multi-agent coordination, workers, delegation, TODO/work graph, goal orchestration, lead/oracle/worker routing, or parallel lanes.",
    "- vanilla: user explicitly wants Pi base/unrestricted behavior, external tools/commands, or to bypass governed ZOB workflow mode.",
    "- unknown: intent is ambiguous, mixed without a primary direction, or not in the allowed set.",
    "Do not approve safety-sensitive actions. Do not decide whether secrets, commits, deploys, destructive commands, session reads, or no-ship status are allowed.",
    "If ambiguous, use unknown and needsClarification=true.",
    "User request:",
    text,
  ].join("\n");
}

function parseModelJson(text: string): ModelResponseShape | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  try {
    const parsed = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeModelResult(text: string, config: IntentClassifierConfig, parsed: ModelResponseShape): IntentClassifierResult {
  const intent = config.allowedIntents.includes(intentName(parsed.intent)) ? intentName(parsed.intent) : "unknown";
  const confidence = numberInRange(parsed.confidence, 0, 0, 1);
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence.filter((item): item is string => typeof item === "string") : [];
  return result({
    text,
    config,
    intent,
    confidence,
    needsClarification: booleanValue(parsed.needsClarification, intent === "unknown"),
    provider: "model",
    reason: stringValue(parsed.reason, "model classifier result"),
    evidence,
  });
}

async function callHttpJsonClassifier(text: string, config: IntentClassifierConfig): Promise<IntentClassifierResult> {
  const provider = config.providers["http-json"] ?? {};
  const endpoint = provider.endpoint?.trim();
  if (!endpoint) throw new Error("http-json endpoint is not configured");
  const apiKeyEnv = provider.apiKeyEnv?.trim();
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  if (apiKeyEnv && !apiKey) throw new Error(`${apiKeyEnv} is not set`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const prompt = classifierPrompt(text, config.allowedIntents);
  const messages = [{ role: "user", content: prompt }];
  const body = provider.requestFormat === "generic-chat"
    ? { model: config.model || undefined, messages, stream: false, temperature: 0 }
    : { model: config.model || undefined, messages, temperature: 0, response_format: { type: "json_object" } };
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http-json classifier request failed: ${response.status}`);
    const payload = await response.json() as unknown;
    const content = isRecord(payload)
      ? typeof payload.message === "object" && payload.message && "content" in payload.message && typeof payload.message.content === "string"
        ? payload.message.content
        : Array.isArray(payload.choices) && isRecord(payload.choices[0]) && isRecord(payload.choices[0].message) && typeof payload.choices[0].message.content === "string"
          ? payload.choices[0].message.content
          : typeof payload.response === "string"
            ? payload.response
            : ""
      : "";
    const parsed = parseModelJson(content);
    if (!parsed) throw new Error("model classifier returned invalid JSON");
    return normalizeModelResult(text, config, parsed);
  } finally {
    clearTimeout(timeout);
  }
}

function textFromAssistantMessage(message: AssistantMessage): string {
  return message.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function resolvePiModel(config: IntentClassifierConfig, runtime?: IntentClassifierPiRuntime): Model<Api> | undefined {
  const configured = config.model.trim();
  if (!configured) return runtime?.model;
  const slash = configured.indexOf("/");
  if (slash <= 0) return runtime?.modelRegistry?.getAvailable().find((model) => model.id === configured || model.name === configured) ?? runtime?.model;
  const provider = configured.slice(0, slash);
  const modelId = configured.slice(slash + 1);
  return runtime?.modelRegistry?.find(provider, modelId) ?? runtime?.modelRegistry?.getAvailable().find((model) => model.provider === provider && model.id === modelId);
}

async function callPiProviderClassifier(text: string, config: IntentClassifierConfig, runtime?: IntentClassifierPiRuntime): Promise<IntentClassifierResult> {
  if (!runtime?.modelRegistry) throw new Error("pi-provider model registry is unavailable");
  const model = resolvePiModel(config, runtime);
  if (!model) throw new Error("pi-provider model is not selected or available");
  const auth = await runtime.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const output = await completeSimple(model, {
    messages: [{ role: "user", content: classifierPrompt(text, config.allowedIntents), timestamp: Date.now() }],
  }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    signal: runtime.signal,
    temperature: 0,
    maxTokens: 512,
    timeoutMs: config.timeoutMs,
    maxRetries: 0,
  });
  if (output.stopReason === "error" || output.errorMessage) throw new Error(output.errorMessage ?? "pi-provider classifier failed");
  const content = textFromAssistantMessage(output);
  const parsed = parseModelJson(content);
  if (!parsed) throw new Error("pi-provider classifier returned invalid JSON");
  return normalizeModelResult(text, { ...config, model: `${model.provider}/${model.id}` }, parsed);
}

function fallbackResult(text: string, config: IntentClassifierConfig, reason: string): IntentClassifierResult {
  if (config.fallback === "unknown") {
    return result({ text, config, intent: "unknown", confidence: 0, needsClarification: true, provider: "fallback", reason: "model classifier unavailable", evidence: [], fallbackReason: reason });
  }
  const regex = classifyIntentRegex(text, config);
  return { ...regex, provider: "fallback", fallbackReason: reason };
}

export async function classifyIntent(text: string, repoRoot: string, overrideConfig?: IntentClassifierConfig, runtime?: IntentClassifierPiRuntime): Promise<IntentClassifierResult> {
  const config = overrideConfig ?? loadIntentClassifierConfig(repoRoot);
  if (!config.enabled || config.provider === "regex") return classifyIntentRegex(text, config);
  if (!config.sendUserTextToProvider) return fallbackResult(text, config, "sendUserTextToProvider=false");
  try {
    const model = config.provider === "http-json"
      ? await callHttpJsonClassifier(text, config)
      : config.provider === "pi-provider"
        ? await callPiProviderClassifier(text, config, runtime)
        : undefined;
    if (!model) return fallbackResult(text, config, "unsupported provider");
    if (model.confidence < config.minConfidence || model.intent === "unknown") return fallbackResult(text, config, `model confidence ${model.confidence} below minConfidence ${config.minConfidence} or unknown intent`);
    return model;
  } catch (error) {
    return fallbackResult(text, config, error instanceof Error ? error.message : String(error));
  }
}

export function classifyModeRegex(text: string): ModeName | undefined {
  const classified = classifyIntentRegex(text);
  return classified.intent === "unknown" || classified.intent === "explore" || classified.intent === "plan" || classified.intent === "oracle" ? undefined : classified.intent;
}

export async function classifyModeFromUserIntent(text: string, repoRoot: string): Promise<ModeName | undefined> {
  const classified = await classifyIntent(text, repoRoot);
  return classified.intent === "unknown" || classified.intent === "explore" || classified.intent === "plan" || classified.intent === "oracle" ? undefined : classified.intent;
}
