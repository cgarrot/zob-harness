export type WheelProviderId = "fireworks" | "openai-codex";
export type WheelModelFamily = "OpenAI-GPT-5.6" | "DeepSeek" | "GLM" | "GPT-OSS" | "Kimi" | "MiniMax" | "Qwen" | "Nemotron";
export type WheelThinkingFormat = "pi-level" | "reasoning_effort" | "budget_tokens";
export type WheelThinkingLevel = "low" | "high";
export type WheelRandomizedRolePool = "development" | "qa" | "documentation" | "internal-review" | "formal-blind-review" | "repository-assurance";
export type WheelFixedRole = "orchestrator" | "pr-close" | "formal-review-adjudicator" | "assurance-adjudicator" | "promotion-blocker-analyst";
export type WheelMessageRoleFormat = "system-developer-user" | "system-user";
export type WheelCapabilityVerification = "verified" | "unverified";

export interface WheelModelRoute {
  id: string;
  provider: WheelProviderId;
  family: WheelModelFamily;
  displayName: string;
  /** Route identity, bounded inference, and the configured thinking path were observed successfully. */
  verified: true;
  capabilityAuditDate: "2026-07-18";
  contextTokens: number;
  maxOutputTokens: number;
  vision: boolean;
  toolCallingDeclared: true;
  messageRoleFormat: WheelMessageRoleFormat;
  capabilityVerification: Readonly<{
    inference: "verified";
    thinking: "verified";
    qualityFixture: "verified";
    messageRoles: WheelCapabilityVerification;
    jsonMode: WheelCapabilityVerification;
    toolCalling: WheelCapabilityVerification;
    streaming: WheelCapabilityVerification;
  }>;
  thinking: {
    format: WheelThinkingFormat;
    verifiedLevels: readonly WheelThinkingLevel[];
    advisory: boolean;
  };
  pricingUsdPerMillion: {
    input: number | null;
    output: number | null;
    basis: "serverless" | "subscription" | "preview";
  };
  observedAverageLatencySeconds: number | null;
  reserveAlias: boolean;
}

type WheelModelRouteInput = Omit<WheelModelRoute, "toolCallingDeclared" | "capabilityVerification"> & { toolCalling: true };

const route = (value: WheelModelRouteInput): WheelModelRoute => {
  const { toolCalling, ...rest } = value;
  const extendedBatteryVerified = value.provider === "fireworks";
  return Object.freeze({
    ...rest,
    toolCallingDeclared: toolCalling,
    capabilityVerification: Object.freeze({
      inference: "verified",
      thinking: "verified",
      qualityFixture: "verified",
      messageRoles: extendedBatteryVerified ? "verified" : "unverified",
      jsonMode: extendedBatteryVerified ? "verified" : "unverified",
      toolCalling: extendedBatteryVerified ? "verified" : "unverified",
      streaming: extendedBatteryVerified ? "verified" : "unverified",
    }),
  });
};

export const WHEEL_MODEL_ROUTES = Object.freeze({
  "openai-codex/gpt-5.6-sol": route({ id: "openai-codex/gpt-5.6-sol", provider: "openai-codex", family: "OpenAI-GPT-5.6", displayName: "GPT-5.6 Sol", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 372000, maxOutputTokens: 128000, vision: true, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "pi-level", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: null, output: null, basis: "subscription" }, observedAverageLatencySeconds: null, reserveAlias: false }),
  "openai-codex/gpt-5.6-terra": route({ id: "openai-codex/gpt-5.6-terra", provider: "openai-codex", family: "OpenAI-GPT-5.6", displayName: "GPT-5.6 Terra", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 372000, maxOutputTokens: 128000, vision: true, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "pi-level", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: null, output: null, basis: "subscription" }, observedAverageLatencySeconds: null, reserveAlias: false }),
  "openai-codex/gpt-5.6-luna": route({ id: "openai-codex/gpt-5.6-luna", provider: "openai-codex", family: "OpenAI-GPT-5.6", displayName: "GPT-5.6 Luna", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 372000, maxOutputTokens: 128000, vision: true, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "pi-level", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: null, output: null, basis: "subscription" }, observedAverageLatencySeconds: null, reserveAlias: false }),
  "accounts/fireworks/models/deepseek-v4-flash": route({ id: "accounts/fireworks/models/deepseek-v4-flash", provider: "fireworks", family: "DeepSeek", displayName: "DeepSeek V4 Flash", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 1000000, maxOutputTokens: 384000, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: 0.14, output: 0.28, basis: "serverless" }, observedAverageLatencySeconds: 2.26, reserveAlias: false }),
  "accounts/fireworks/models/deepseek-v4-pro": route({ id: "accounts/fireworks/models/deepseek-v4-pro", provider: "fireworks", family: "DeepSeek", displayName: "DeepSeek V4 Pro", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 1000000, maxOutputTokens: 384000, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: 1.74, output: 3.48, basis: "serverless" }, observedAverageLatencySeconds: 3.46, reserveAlias: false }),
  "accounts/fireworks/models/glm-5p2": route({ id: "accounts/fireworks/models/glm-5p2", provider: "fireworks", family: "GLM", displayName: "GLM 5.2", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 1048575, maxOutputTokens: 131072, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: true }, pricingUsdPerMillion: { input: 1.4, output: 4.4, basis: "serverless" }, observedAverageLatencySeconds: 6.15, reserveAlias: false }),
  "accounts/fireworks/models/glm-5p1": route({ id: "accounts/fireworks/models/glm-5p1", provider: "fireworks", family: "GLM", displayName: "GLM 5.1", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 202800, maxOutputTokens: 131072, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: true }, pricingUsdPerMillion: { input: 1.4, output: 4.4, basis: "serverless" }, observedAverageLatencySeconds: 4.59, reserveAlias: false }),
  "accounts/fireworks/models/gpt-oss-120b": route({ id: "accounts/fireworks/models/gpt-oss-120b", provider: "fireworks", family: "GPT-OSS", displayName: "GPT-OSS 120B", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 131072, maxOutputTokens: 32768, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "reasoning_effort", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: 0.15, output: 0.6, basis: "serverless" }, observedAverageLatencySeconds: 1.71, reserveAlias: false }),
  "accounts/fireworks/models/kimi-k2p7-code": route({ id: "accounts/fireworks/models/kimi-k2p7-code", provider: "fireworks", family: "Kimi", displayName: "Kimi K2.7 Code", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 262000, maxOutputTokens: 262000, vision: true, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: 0.95, output: 4, basis: "serverless" }, observedAverageLatencySeconds: 1.55, reserveAlias: false }),
  "accounts/fireworks/models/kimi-k2p6": route({ id: "accounts/fireworks/models/kimi-k2p6", provider: "fireworks", family: "Kimi", displayName: "Kimi K2.6", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 262000, maxOutputTokens: 262000, vision: true, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: 0.95, output: 4, basis: "serverless" }, observedAverageLatencySeconds: 2.56, reserveAlias: false }),
  "accounts/fireworks/models/minimax-m3": route({ id: "accounts/fireworks/models/minimax-m3", provider: "fireworks", family: "MiniMax", displayName: "MiniMax M3", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 512000, maxOutputTokens: 512000, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: 0.3, output: 1.2, basis: "serverless" }, observedAverageLatencySeconds: 2.4, reserveAlias: false }),
  "accounts/fireworks/models/minimax-m2p7": route({ id: "accounts/fireworks/models/minimax-m2p7", provider: "fireworks", family: "MiniMax", displayName: "MiniMax M2.7", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 196600, maxOutputTokens: 196600, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "reasoning_effort", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: 0.3, output: 1.2, basis: "serverless" }, observedAverageLatencySeconds: 1.42, reserveAlias: false }),
  "accounts/fireworks/models/qwen3p7-plus": route({ id: "accounts/fireworks/models/qwen3p7-plus", provider: "fireworks", family: "Qwen", displayName: "Qwen 3.7 Plus", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 262100, maxOutputTokens: 65500, vision: true, toolCalling: true, messageRoleFormat: "system-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: true }, pricingUsdPerMillion: { input: 0.4, output: 1.6, basis: "serverless" }, observedAverageLatencySeconds: 1.33, reserveAlias: false }),
  "accounts/fireworks/models/nemotron-3-ultra-nvfp4": route({ id: "accounts/fireworks/models/nemotron-3-ultra-nvfp4", provider: "fireworks", family: "Nemotron", displayName: "Nemotron 3 Ultra NVFP4", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 262144, maxOutputTokens: 32768, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: null, output: null, basis: "preview" }, observedAverageLatencySeconds: 20, reserveAlias: false }),
  "accounts/fireworks/routers/glm-5p2-fast": route({ id: "accounts/fireworks/routers/glm-5p2-fast", provider: "fireworks", family: "GLM", displayName: "GLM 5.2 Fast", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 1048575, maxOutputTokens: 131072, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: true }, pricingUsdPerMillion: { input: 2.1, output: 6.6, basis: "serverless" }, observedAverageLatencySeconds: 1.31, reserveAlias: true }),
  "accounts/fireworks/routers/glm-fast-latest": route({ id: "accounts/fireworks/routers/glm-fast-latest", provider: "fireworks", family: "GLM", displayName: "GLM Fast Latest", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 1048575, maxOutputTokens: 131072, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: true }, pricingUsdPerMillion: { input: 2.1, output: 6.6, basis: "serverless" }, observedAverageLatencySeconds: 1.28, reserveAlias: true }),
  "accounts/fireworks/routers/glm-latest": route({ id: "accounts/fireworks/routers/glm-latest", provider: "fireworks", family: "GLM", displayName: "GLM Latest", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 1048575, maxOutputTokens: 131072, vision: false, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: true }, pricingUsdPerMillion: { input: 1.4, output: 4.4, basis: "serverless" }, observedAverageLatencySeconds: 4.63, reserveAlias: true }),
  "accounts/fireworks/routers/kimi-k2p7-code-fast": route({ id: "accounts/fireworks/routers/kimi-k2p7-code-fast", provider: "fireworks", family: "Kimi", displayName: "Kimi K2.7 Code Fast", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 262000, maxOutputTokens: 262000, vision: true, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: 1.9, output: 8, basis: "serverless" }, observedAverageLatencySeconds: 1.18, reserveAlias: true }),
  "accounts/fireworks/routers/kimi-latest": route({ id: "accounts/fireworks/routers/kimi-latest", provider: "fireworks", family: "Kimi", displayName: "Kimi Latest", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 262000, maxOutputTokens: 262000, vision: true, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: 0.95, output: 4, basis: "serverless" }, observedAverageLatencySeconds: 1.37, reserveAlias: true }),
  "accounts/fireworks/routers/kimi-k2p6-turbo": route({ id: "accounts/fireworks/routers/kimi-k2p6-turbo", provider: "fireworks", family: "Kimi", displayName: "Kimi K2.6 Turbo", verified: true, capabilityAuditDate: "2026-07-18", contextTokens: 262000, maxOutputTokens: 262000, vision: true, toolCalling: true, messageRoleFormat: "system-developer-user", thinking: { format: "budget_tokens", verifiedLevels: ["low", "high"], advisory: false }, pricingUsdPerMillion: { input: 2, output: 8, basis: "serverless" }, observedAverageLatencySeconds: 1.61, reserveAlias: true }),
} satisfies Record<string, WheelModelRoute>);

export type WheelModelRouteId = keyof typeof WHEEL_MODEL_ROUTES;

export const WHEEL_FIXED_ROLE_ROUTES: Readonly<Record<WheelFixedRole, Readonly<{ routeId: WheelModelRouteId; thinking: WheelThinkingLevel }>>> = Object.freeze({
  orchestrator: { routeId: "openai-codex/gpt-5.6-sol", thinking: "high" },
  "pr-close": { routeId: "openai-codex/gpt-5.6-sol", thinking: "high" },
  "formal-review-adjudicator": { routeId: "openai-codex/gpt-5.6-sol", thinking: "high" },
  "assurance-adjudicator": { routeId: "openai-codex/gpt-5.6-sol", thinking: "high" },
  "promotion-blocker-analyst": { routeId: "openai-codex/gpt-5.6-sol", thinking: "high" },
});

export const WHEEL_RANDOMIZED_ROLE_POOLS: Readonly<Record<WheelRandomizedRolePool, readonly WheelModelRouteId[]>> = Object.freeze({
  development: ["accounts/fireworks/models/kimi-k2p7-code", "accounts/fireworks/models/deepseek-v4-pro", "accounts/fireworks/models/gpt-oss-120b", "accounts/fireworks/models/kimi-k2p6", "accounts/fireworks/models/minimax-m3", "accounts/fireworks/models/deepseek-v4-flash", "accounts/fireworks/models/glm-5p2", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-luna"],
  qa: ["accounts/fireworks/models/qwen3p7-plus", "accounts/fireworks/models/minimax-m2p7", "accounts/fireworks/models/nemotron-3-ultra-nvfp4", "accounts/fireworks/models/glm-5p1", "accounts/fireworks/models/deepseek-v4-flash", "accounts/fireworks/models/gpt-oss-120b"],
  documentation: ["accounts/fireworks/models/kimi-k2p7-code", "accounts/fireworks/models/deepseek-v4-pro", "accounts/fireworks/models/glm-5p2", "accounts/fireworks/models/minimax-m3", "accounts/fireworks/models/qwen3p7-plus", "openai-codex/gpt-5.6-terra"],
  "internal-review": ["accounts/fireworks/models/deepseek-v4-pro", "accounts/fireworks/models/glm-5p2", "accounts/fireworks/models/kimi-k2p6", "accounts/fireworks/models/minimax-m3", "accounts/fireworks/models/qwen3p7-plus", "accounts/fireworks/models/nemotron-3-ultra-nvfp4"],
  "formal-blind-review": ["accounts/fireworks/models/deepseek-v4-pro", "accounts/fireworks/models/glm-5p2", "accounts/fireworks/models/qwen3p7-plus", "accounts/fireworks/models/minimax-m3", "accounts/fireworks/models/nemotron-3-ultra-nvfp4", "openai-codex/gpt-5.6-terra"],
  "repository-assurance": ["accounts/fireworks/models/deepseek-v4-pro", "accounts/fireworks/models/glm-5p2", "accounts/fireworks/models/kimi-k2p7-code", "accounts/fireworks/models/qwen3p7-plus", "accounts/fireworks/models/minimax-m3", "accounts/fireworks/models/nemotron-3-ultra-nvfp4"],
});

export const WHEEL_MODEL_AUDIT = Object.freeze({
  schema: "wheel.zob.model-capability-audit.v1",
  auditedAt: "2026-07-18",
  callCount: 297,
  approvedSpendCapUsd: 5,
  observedMeteredSpendUsd: 0.13,
  evidenceRef: "reports/fireconnect-capability-tests/MATRIX.md",
  bodyStored: false,
});

export interface WheelRegistryValidation {
  valid: boolean;
  errors: string[];
  routeCount: number;
  randomizedPoolCount: number;
  minimumPoolSize: number;
}

export function getWheelModelRoute(routeId: string): WheelModelRoute | undefined {
  return WHEEL_MODEL_ROUTES[routeId as WheelModelRouteId];
}

export function listWheelPoolRoutes(pool: WheelRandomizedRolePool): WheelModelRoute[] {
  return WHEEL_RANDOMIZED_ROLE_POOLS[pool].map((routeId) => WHEEL_MODEL_ROUTES[routeId]);
}

export function validateWheelModelRegistry(): WheelRegistryValidation {
  const errors: string[] = [];
  const routeIds = new Set(Object.keys(WHEEL_MODEL_ROUTES));
  const minimumPoolSize = Math.min(...Object.values(WHEEL_RANDOMIZED_ROLE_POOLS).map((routes) => routes.length));

  for (const [pool, routes] of Object.entries(WHEEL_RANDOMIZED_ROLE_POOLS)) {
    if (routes.length < 5) errors.push(`${pool} pool must contain at least 5 routes`);
    if (new Set(routes).size !== routes.length) errors.push(`${pool} pool contains duplicate routes`);
    for (const routeId of routes) {
      if (!routeIds.has(routeId)) errors.push(`${pool} references unknown route ${routeId}`);
    }
  }

  for (const [role, assignment] of Object.entries(WHEEL_FIXED_ROLE_ROUTES)) {
    if (!routeIds.has(assignment.routeId)) errors.push(`${role} references unknown route ${assignment.routeId}`);
  }
  if (WHEEL_FIXED_ROLE_ROUTES.orchestrator.routeId !== "openai-codex/gpt-5.6-sol") errors.push("orchestrator must be fixed to GPT-5.6 Sol");
  if (WHEEL_MODEL_ROUTES["accounts/fireworks/models/gpt-oss-120b"].thinking.format !== "reasoning_effort") errors.push("gpt-oss-120b must use reasoning_effort");
  if (WHEEL_MODEL_ROUTES["accounts/fireworks/models/qwen3p7-plus"].messageRoleFormat !== "system-user") errors.push("qwen3p7-plus must use system-user roles");
  for (const routeValue of Object.values(WHEEL_MODEL_ROUTES)) {
    const extended = routeValue.capabilityVerification;
    if (routeValue.provider === "openai-codex" && [extended.messageRoles, extended.jsonMode, extended.toolCalling, extended.streaming].some((value) => value !== "unverified")) {
      errors.push(`${routeValue.id} must not overclaim reduced-battery capabilities`);
    }
    if (routeValue.provider === "fireworks" && [extended.messageRoles, extended.jsonMode, extended.toolCalling, extended.streaming].some((value) => value !== "verified")) {
      errors.push(`${routeValue.id} must preserve full-battery verification`);
    }
  }

  const formalFamilies = new Set(listWheelPoolRoutes("formal-blind-review").map((routeValue) => routeValue.family));
  if (formalFamilies.size < 5) errors.push("formal blind review requires at least 5 model families");
  const assuranceFamilies = new Set(listWheelPoolRoutes("repository-assurance").map((routeValue) => routeValue.family));
  if (assuranceFamilies.size < 3) errors.push("repository assurance requires at least 3 model families");

  return {
    valid: errors.length === 0,
    errors,
    routeCount: routeIds.size,
    randomizedPoolCount: Object.keys(WHEEL_RANDOMIZED_ROLE_POOLS).length,
    minimumPoolSize,
  };
}
