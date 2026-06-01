import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "./utils/hashing.js";
import { isRecord } from "./utils/records.js";

export const INTERACTIVE_AUTONOMY_MODES = ["off", "open", "controlled", "adaptive"] as const;
export type InteractiveAutonomyMode = typeof INTERACTIVE_AUTONOMY_MODES[number];
export type MissionReadinessDecision = "auto_launch" | "clarify" | "block" | "stopped";
export type MissionReadinessVerdict = "READY" | "NEEDS_CLARIFICATION" | "BLOCKED" | "STOPPED";
export type MissionRiskLevel = "low" | "medium" | "high";

export interface InteractiveAutonomyThresholds {
  adaptiveAutoLaunch: number;
  adaptiveClarifyBelow: number;
  controlledAutoLaunch: number;
  controlledMinimumSignals: number;
}

export interface InteractiveAutonomySafetyPolicy {
  blockSecretAccess: boolean;
  blockDestructiveCommands: boolean;
  blockProductionApply: boolean;
  forbiddenPathPatterns: string[];
  destructivePatterns: string[];
  secretPatterns: string[];
}

export interface InteractiveAutonomyLaunchPolicy {
  defaultAllowedActions: string[];
  defaultAllowedPaths: string[];
  stopConditions: string[];
  manualPerActionApprovalWhenLaunched: boolean;
  requireValidationEvidence: boolean;
  requireOracleForCompletion: boolean;
}

export interface InteractiveAutonomyPolicy {
  schema: "zob.interactive-autonomy-policy.v1";
  defaultMode: InteractiveAutonomyMode;
  thresholds: InteractiveAutonomyThresholds;
  safety: InteractiveAutonomySafetyPolicy;
  launch: InteractiveAutonomyLaunchPolicy;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  source: string;
}

export interface MissionReadinessSignals {
  clarity: number;
  acceptanceCriteria: number;
  targetPaths: number;
  testability: number;
  safety: number;
}

export interface InteractiveLaunchAuthorization {
  schema: "zob.launch-authorization.v1";
  userInputHash: string;
  missionReadinessHash: string;
  specLocked: boolean;
  userLaunchConfirmed: boolean;
  autonomyMode: Exclude<InteractiveAutonomyMode, "off">;
  allowedActions: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  applyPolicy: {
    mode: "interactive_in_scope";
    manualPerActionApprovalRequired: boolean;
    validationRequired: boolean;
    oracleRequiredForCompletion: boolean;
    productionApplyAllowed: false;
  };
  stopConditions: string[];
  launchAuthorizesInScopeActions: boolean;
  actionExecutionBlockedUntilLaunch: false;
  exceptionApprovalRequiredOnlyForOutOfScope: true;
  globalProductionClaimAllowed: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface MissionReadinessReport {
  schema: "zob.mission-readiness.v1";
  mode: InteractiveAutonomyMode;
  decision: MissionReadinessDecision;
  verdict: MissionReadinessVerdict;
  score: number;
  risk: MissionRiskLevel;
  signals: MissionReadinessSignals;
  blockerCodes: string[];
  clarificationCodes: string[];
  safetyGateCodes: string[];
  userInputHash: string;
  rawInputStored: false;
  targetPathRefs: string[];
  targetPathHashes: string[];
  manualPerActionApprovalRequired: boolean;
  inScopeAutonomousActionsAuthorized: boolean;
  safetyGatesStillEnabled: true;
  noShip: boolean;
  globalProductionClaimAllowed: false;
  launchAuthorization?: InteractiveLaunchAuthorization;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  generatedAt: string;
}

export interface InteractiveAutonomyRuntimeState {
  mode: InteractiveAutonomyMode;
  enabled: boolean;
  policy: InteractiveAutonomyPolicy;
  policyHash: string;
  updatedAt?: string;
  lastReadiness?: MissionReadinessReport;
  lastLaunchAuthorization?: InteractiveLaunchAuthorization;
}

const DEFAULT_POLICY_SOURCE = "builtin-default";

export const DEFAULT_INTERACTIVE_AUTONOMY_POLICY: InteractiveAutonomyPolicy = {
  schema: "zob.interactive-autonomy-policy.v1",
  defaultMode: "adaptive",
  thresholds: {
    adaptiveAutoLaunch: 0.72,
    adaptiveClarifyBelow: 0.45,
    controlledAutoLaunch: 0.86,
    controlledMinimumSignals: 3,
  },
  safety: {
    blockSecretAccess: true,
    blockDestructiveCommands: true,
    blockProductionApply: true,
    forbiddenPathPatterns: [".env", "**/.env*", "**/*secret*", "**/*private-key*", "~/.ssh", "~/.aws"],
    destructivePatterns: ["rm\\s+-rf", "git\\s+reset\\s+--hard", "git\\s+clean\\b", "pkill\\s+-9", "killall\\b", "drop\\s+database", "truncate\\s+table"],
    secretPatterns: ["\\.env", "api[_ -]?key", "private\\s+key", "ssh\\s+key", "aws\\s+credential", "secret\\s+token"],
  },
  launch: {
    defaultAllowedActions: ["read_repo", "plan", "edit_in_scope", "delegate_in_scope", "validate", "oracle_review"],
    defaultAllowedPaths: ["."],
    stopConditions: ["scope_drift", "secret_required", "destructive_action_requested", "validation_failure", "oracle_no_ship", "user_stop"],
    manualPerActionApprovalWhenLaunched: false,
    requireValidationEvidence: true,
    requireOracleForCompletion: true,
  },
  bodyStored: false,
  promptBodiesStored: false,
  outputBodiesStored: false,
  source: DEFAULT_POLICY_SOURCE,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(clamp01(value) * 100) / 100;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const result = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  return result.length > 0 ? result : [...fallback];
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : fallback;
}

export function asInteractiveAutonomyMode(value: unknown): InteractiveAutonomyMode | undefined {
  return typeof value === "string" && INTERACTIVE_AUTONOMY_MODES.includes(value as InteractiveAutonomyMode) ? value as InteractiveAutonomyMode : undefined;
}

function normalizePolicy(value: unknown, source: string): InteractiveAutonomyPolicy {
  if (!isRecord(value)) return { ...DEFAULT_INTERACTIVE_AUTONOMY_POLICY, source };
  const defaultMode = asInteractiveAutonomyMode(value.defaultMode) ?? DEFAULT_INTERACTIVE_AUTONOMY_POLICY.defaultMode;
  const thresholdsValue = isRecord(value.thresholds) ? value.thresholds : {};
  const safetyValue = isRecord(value.safety) ? value.safety : {};
  const launchValue = isRecord(value.launch) ? value.launch : {};
  return {
    schema: "zob.interactive-autonomy-policy.v1",
    defaultMode,
    thresholds: {
      adaptiveAutoLaunch: numberField(thresholdsValue.adaptiveAutoLaunch, DEFAULT_INTERACTIVE_AUTONOMY_POLICY.thresholds.adaptiveAutoLaunch),
      adaptiveClarifyBelow: numberField(thresholdsValue.adaptiveClarifyBelow, DEFAULT_INTERACTIVE_AUTONOMY_POLICY.thresholds.adaptiveClarifyBelow),
      controlledAutoLaunch: numberField(thresholdsValue.controlledAutoLaunch, DEFAULT_INTERACTIVE_AUTONOMY_POLICY.thresholds.controlledAutoLaunch),
      controlledMinimumSignals: typeof thresholdsValue.controlledMinimumSignals === "number" && Number.isFinite(thresholdsValue.controlledMinimumSignals)
        ? Math.max(1, Math.min(5, Math.round(thresholdsValue.controlledMinimumSignals)))
        : DEFAULT_INTERACTIVE_AUTONOMY_POLICY.thresholds.controlledMinimumSignals,
    },
    safety: {
      blockSecretAccess: safetyValue.blockSecretAccess !== false,
      blockDestructiveCommands: safetyValue.blockDestructiveCommands !== false,
      blockProductionApply: safetyValue.blockProductionApply !== false,
      forbiddenPathPatterns: stringArray(safetyValue.forbiddenPathPatterns, DEFAULT_INTERACTIVE_AUTONOMY_POLICY.safety.forbiddenPathPatterns),
      destructivePatterns: stringArray(safetyValue.destructivePatterns, DEFAULT_INTERACTIVE_AUTONOMY_POLICY.safety.destructivePatterns),
      secretPatterns: stringArray(safetyValue.secretPatterns, DEFAULT_INTERACTIVE_AUTONOMY_POLICY.safety.secretPatterns),
    },
    launch: {
      defaultAllowedActions: stringArray(launchValue.defaultAllowedActions, DEFAULT_INTERACTIVE_AUTONOMY_POLICY.launch.defaultAllowedActions),
      defaultAllowedPaths: stringArray(launchValue.defaultAllowedPaths, DEFAULT_INTERACTIVE_AUTONOMY_POLICY.launch.defaultAllowedPaths),
      stopConditions: stringArray(launchValue.stopConditions, DEFAULT_INTERACTIVE_AUTONOMY_POLICY.launch.stopConditions),
      manualPerActionApprovalWhenLaunched: launchValue.manualPerActionApprovalWhenLaunched === true,
      requireValidationEvidence: launchValue.requireValidationEvidence !== false,
      requireOracleForCompletion: launchValue.requireOracleForCompletion !== false,
    },
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    source,
  };
}

export function readInteractiveAutonomyPolicy(repoRoot?: string): InteractiveAutonomyPolicy {
  if (!repoRoot) return { ...DEFAULT_INTERACTIVE_AUTONOMY_POLICY };
  const policyPath = join(repoRoot, ".pi", "autonomy-policy.json");
  if (!existsSync(policyPath)) return { ...DEFAULT_INTERACTIVE_AUTONOMY_POLICY };
  try {
    return normalizePolicy(JSON.parse(readFileSync(policyPath, "utf8")) as unknown, ".pi/autonomy-policy.json");
  } catch {
    return { ...DEFAULT_INTERACTIVE_AUTONOMY_POLICY, source: `${DEFAULT_POLICY_SOURCE}:parse-error` };
  }
}

export function hashInteractiveAutonomyPolicy(policy: InteractiveAutonomyPolicy): string {
  return sha256(JSON.stringify({ ...policy, source: undefined }));
}

export function createInteractiveAutonomyRuntimeState(policy: InteractiveAutonomyPolicy = DEFAULT_INTERACTIVE_AUTONOMY_POLICY): InteractiveAutonomyRuntimeState {
  return {
    mode: policy.defaultMode,
    enabled: policy.defaultMode !== "off",
    policy,
    policyHash: hashInteractiveAutonomyPolicy(policy),
  };
}

function patternMatchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(text);
    } catch {
      return text.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

const SECRET_ACCESS_VERB_PATTERN = /\b(read|cat|open|inspect|print|show|copy|extract|use|lire|ouvrir|affiche|imprime|copie|extrais|utilise)\b/i;
const SECRET_ACCESS_CONTEXT_PATTERN = /\b(secret|token|api[_ -]?key|private\s+key|ssh\s+key|credential|identifiant)\b.{0,80}\b(read|show|print|copy|use|lire|affiche|copie|utilise)\b/i;
const NEGATIVE_SAFETY_DIRECTIVE_PATTERN = /\b(do not|don't|dont|never|must not|mustn't|avoid|forbidden|denylist|deny list|blocked|without|no\s+secrets?|ne\s+pas|ne\s+jamais|n'ouvre\s+pas|ne\s+lis\s+pas|interdit|sans)\b/i;
const CONTRAST_OR_EXCEPTION_PATTERN = /\b(but|however|except|unless|sauf|mais|pourtant)\b/i;

function isNegativeSecretSafetyLine(line: string, policy: InteractiveAutonomyPolicy): boolean {
  const trimmed = line.trim();
  if (!trimmed || !patternMatchesAny(trimmed, policy.safety.secretPatterns)) return false;
  if (CONTRAST_OR_EXCEPTION_PATTERN.test(trimmed)) return false;
  return NEGATIVE_SAFETY_DIRECTIVE_PATTERN.test(trimmed)
    || /^\s*(must\s+not|forbidden[_ -]?paths?|forbidden|denylist|deny[_ -]?list|do\s+not)\s*[:\-]/i.test(trimmed);
}

function secretAccessDetectionText(text: string, policy: InteractiveAutonomyPolicy): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isNegativeSecretSafetyLine(line, policy))
    .join("\n");
}

function secretAccessRequested(text: string, policy: InteractiveAutonomyPolicy): boolean {
  const detectionText = secretAccessDetectionText(text, policy);
  const secretMention = patternMatchesAny(detectionText, policy.safety.secretPatterns);
  if (!secretMention) return false;
  return SECRET_ACCESS_VERB_PATTERN.test(detectionText)
    || SECRET_ACCESS_CONTEXT_PATTERN.test(detectionText);
}

function productionApplyRequested(text: string): boolean {
  return /\b(deploy|release|ship|apply|write|push|publish|déploie|deploie|publie|livre|applique)\b.{0,80}\b(prod|production|live)\b/i.test(text)
    || /\b(prod|production|live)\b.{0,80}\b(deploy|release|ship|apply|write|push|publish|déploie|deploie|publie|livre|applique)\b/i.test(text);
}

function extractTargetPaths(text: string): string[] {
  const matches = text.match(/(?:^|[\s`'"(:])((?:\.?\.?\/?[\w@.-]+\/)*[\w@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|toml|py|rs|go|java|kt|css|scss|html|sh|sql))(?:$|[\s`'"),.:;])/gi) ?? [];
  const normalized = matches
    .map((match) => match.replace(/^[\s`'"(:]+|[\s`'"),.:;]+$/g, ""))
    .filter((item) => item.length > 0 && !item.startsWith("/home/") && !item.startsWith("~"));
  return [...new Set(normalized)].slice(0, 12);
}

function countPositiveSignals(signals: MissionReadinessSignals): number {
  return [signals.clarity, signals.acceptanceCriteria, signals.targetPaths, signals.testability, signals.safety].filter((value) => value >= 0.5).length;
}

function missionReadinessHash(base: Omit<MissionReadinessReport, "launchAuthorization">): string {
  return sha256(JSON.stringify({
    schema: base.schema,
    mode: base.mode,
    decision: base.decision,
    verdict: base.verdict,
    score: base.score,
    risk: base.risk,
    signals: base.signals,
    blockerCodes: base.blockerCodes,
    clarificationCodes: base.clarificationCodes,
    safetyGateCodes: base.safetyGateCodes,
    userInputHash: base.userInputHash,
    targetPathHashes: base.targetPathHashes,
    generatedAt: base.generatedAt,
  }));
}

export function buildInteractiveLaunchAuthorization(input: {
  readiness: Omit<MissionReadinessReport, "launchAuthorization">;
  policy: InteractiveAutonomyPolicy;
  mode: Exclude<InteractiveAutonomyMode, "off">;
}): InteractiveLaunchAuthorization {
  const allowedPaths = input.readiness.targetPathRefs.length > 0 ? input.readiness.targetPathRefs : input.policy.launch.defaultAllowedPaths;
  return {
    schema: "zob.launch-authorization.v1",
    userInputHash: input.readiness.userInputHash,
    missionReadinessHash: missionReadinessHash(input.readiness),
    specLocked: true,
    userLaunchConfirmed: true,
    autonomyMode: input.mode,
    allowedActions: input.policy.launch.defaultAllowedActions,
    allowedPaths,
    forbiddenPaths: input.policy.safety.forbiddenPathPatterns,
    applyPolicy: {
      mode: "interactive_in_scope",
      manualPerActionApprovalRequired: input.policy.launch.manualPerActionApprovalWhenLaunched,
      validationRequired: input.policy.launch.requireValidationEvidence,
      oracleRequiredForCompletion: input.policy.launch.requireOracleForCompletion,
      productionApplyAllowed: false,
    },
    stopConditions: input.policy.launch.stopConditions,
    launchAuthorizesInScopeActions: true,
    actionExecutionBlockedUntilLaunch: false,
    exceptionApprovalRequiredOnlyForOutOfScope: true,
    globalProductionClaimAllowed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function scoreMissionReadiness(text: string, options: { mode: InteractiveAutonomyMode; policy: InteractiveAutonomyPolicy; generatedAt?: string | Date }): MissionReadinessReport {
  const policy = options.policy;
  const mode = options.mode;
  const raw = text.trim();
  const normalized = raw.toLowerCase();
  const userInputHash = sha256(raw);
  const generatedAt = options.generatedAt instanceof Date ? options.generatedAt.toISOString() : options.generatedAt ?? new Date().toISOString();
  const targetPathRefs = extractTargetPaths(raw);
  const targetPathHashes = targetPathRefs.map((item) => sha256(item));

  const blockerCodes: string[] = [];
  const clarificationCodes: string[] = [];
  const safetyGateCodes = ["no_secrets", "no_destructive_commands", "no_production_apply", "no_global_production_claim", "validation_required"];

  const hasActionVerb = /\b(implement|impl[eé]mente|build|cr[eé]e|create|add|ajoute|fix|corrige|modify|modifie|change|update|mets?|refactor|refactorise|wire|branche|brancher|validate|test|smoke|audit|review|documente|write|edit|fais|make)\b/i.test(raw);
  const hasAcceptanceLanguage = /\b(acceptance|criteria|crit[eè]res?|must|must not|doit|ne doit pas|validation|validate|test|smoke|preuve|evidence|oracle|done when|definition of done)\b/i.test(raw);
  const hasTestabilityLanguage = /\b(test|tests|smoke|npm run|check|typecheck|validation|validate|oracle|proof|preuve|assert|v[eé]rifie|verify)\b/i.test(raw);
  const asksClarificationOnly = /\b(explain|explique|pourquoi|question|aide|help|status|statut|montre|show)\b/i.test(raw) && !hasActionVerb;
  const destructiveRequested = policy.safety.blockDestructiveCommands && patternMatchesAny(raw, policy.safety.destructivePatterns);
  const secretRequested = policy.safety.blockSecretAccess && secretAccessRequested(raw, policy);
  const productionRequested = policy.safety.blockProductionApply && productionApplyRequested(raw);
  const globalClaimRequested = /\b(100%|global|production[- ]?wide|full production|prod)\b.{0,80}\b(claim|declare|prouve|prove|certifie|certify|ready|autonomous|autonomie)\b/i.test(raw);

  if (!raw) blockerCodes.push("user_input_missing");
  if (destructiveRequested) blockerCodes.push("destructive_action_requested");
  if (secretRequested) blockerCodes.push("secret_access_requested");
  if (productionRequested) blockerCodes.push("production_apply_requires_explicit_gate");
  if (globalClaimRequested) clarificationCodes.push("global_production_claim_requires_fresh_oracle_proof");

  const clarity = raw.length >= 80 && hasActionVerb ? 0.9 : raw.length >= 35 && hasActionVerb ? 0.72 : hasActionVerb ? 0.55 : asksClarificationOnly ? 0.35 : raw.length > 0 ? 0.25 : 0;
  const acceptanceCriteria = hasAcceptanceLanguage ? 0.8 : /\b(done|fini|termin[eé]|livrable|deliverable)\b/i.test(raw) ? 0.5 : 0.15;
  const targetPaths = targetPathRefs.length > 0 ? 0.85 : /\b(repo|project|harness|pi|extension|codebase|projet)\b/i.test(raw) ? 0.45 : 0.15;
  const testability = hasTestabilityLanguage ? 0.85 : /\b(works|fonctionne|ready|ok)\b/i.test(raw) ? 0.35 : 0.15;
  const risk: MissionRiskLevel = blockerCodes.length > 0 || productionRequested ? "high" : /\b(network|browser|cloud|api|deploy|publish|commit|database|db|payment|auth)\b/i.test(normalized) ? "medium" : "low";
  const safety = risk === "high" ? 0 : risk === "medium" ? 0.55 : 1;
  const signals: MissionReadinessSignals = {
    clarity: round2(clarity),
    acceptanceCriteria: round2(acceptanceCriteria),
    targetPaths: round2(targetPaths),
    testability: round2(testability),
    safety: round2(safety),
  };
  const score = round2((signals.clarity * 0.3) + (signals.acceptanceCriteria * 0.22) + (signals.targetPaths * 0.18) + (signals.testability * 0.18) + (signals.safety * 0.12));

  if (signals.clarity < 0.5) clarificationCodes.push("mission_intent_unclear");
  if (signals.targetPaths < 0.5) clarificationCodes.push("target_paths_or_scope_missing");
  if (signals.testability < 0.5) clarificationCodes.push("validation_evidence_missing");
  if (signals.acceptanceCriteria < 0.5) clarificationCodes.push("acceptance_criteria_missing");
  if (risk === "medium") clarificationCodes.push("medium_risk_requires_scope_confirmation");

  let decision: MissionReadinessDecision;
  if (mode === "off") decision = "stopped";
  else if (blockerCodes.length > 0) decision = "block";
  else if (mode === "open") decision = raw.length > 0 ? "auto_launch" : "clarify";
  else if (mode === "controlled") {
    decision = score >= policy.thresholds.controlledAutoLaunch && countPositiveSignals(signals) >= policy.thresholds.controlledMinimumSignals ? "auto_launch" : "clarify";
  } else {
    decision = score >= policy.thresholds.adaptiveAutoLaunch && signals.clarity >= 0.5 && risk !== "medium" ? "auto_launch" : "clarify";
    if (score < policy.thresholds.adaptiveClarifyBelow) decision = "clarify";
  }

  const verdict: MissionReadinessVerdict = decision === "auto_launch" ? "READY" : decision === "block" ? "BLOCKED" : decision === "stopped" ? "STOPPED" : "NEEDS_CLARIFICATION";
  const base: Omit<MissionReadinessReport, "launchAuthorization"> = {
    schema: "zob.mission-readiness.v1",
    mode,
    decision,
    verdict,
    score,
    risk,
    signals,
    blockerCodes: [...new Set(blockerCodes)],
    clarificationCodes: [...new Set(clarificationCodes)],
    safetyGateCodes,
    userInputHash,
    rawInputStored: false,
    targetPathRefs,
    targetPathHashes,
    manualPerActionApprovalRequired: decision !== "auto_launch" || policy.launch.manualPerActionApprovalWhenLaunched,
    inScopeAutonomousActionsAuthorized: decision === "auto_launch",
    safetyGatesStillEnabled: true,
    noShip: decision === "block",
    globalProductionClaimAllowed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt,
  };
  return decision === "auto_launch" && mode !== "off"
    ? { ...base, launchAuthorization: buildInteractiveLaunchAuthorization({ readiness: base, policy, mode }) }
    : base;
}

export function toAutonomyStateLedgerEntry(state: InteractiveAutonomyRuntimeState): Record<string, unknown> {
  return {
    schema: "zob.interactive-autonomy-state.v1",
    mode: state.mode,
    enabled: state.enabled,
    policyHash: state.policyHash,
    policySource: state.policy.source,
    manualPerActionApprovalWhenLaunched: state.policy.launch.manualPerActionApprovalWhenLaunched,
    safetyGatesStillEnabled: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };
}

export function toMissionReadinessLedgerEntry(readiness: MissionReadinessReport): Record<string, unknown> {
  return {
    schema: readiness.schema,
    mode: readiness.mode,
    decision: readiness.decision,
    verdict: readiness.verdict,
    score: readiness.score,
    risk: readiness.risk,
    signals: readiness.signals,
    blockerCodes: readiness.blockerCodes,
    clarificationCodes: readiness.clarificationCodes,
    safetyGateCodes: readiness.safetyGateCodes,
    userInputHash: readiness.userInputHash,
    rawInputStored: false,
    targetPathHashes: readiness.targetPathHashes,
    targetPathRefsStored: false,
    manualPerActionApprovalRequired: readiness.manualPerActionApprovalRequired,
    inScopeAutonomousActionsAuthorized: readiness.inScopeAutonomousActionsAuthorized,
    launchAuthorizationHash: readiness.launchAuthorization ? sha256(JSON.stringify(readiness.launchAuthorization)) : undefined,
    launchAuthorizationSchema: readiness.launchAuthorization?.schema,
    noShip: readiness.noShip,
    globalProductionClaimAllowed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: readiness.generatedAt,
  };
}

export function restoreInteractiveAutonomyState(repoRoot: string | undefined, branch: unknown[], previous?: InteractiveAutonomyRuntimeState): InteractiveAutonomyRuntimeState {
  const policy = readInteractiveAutonomyPolicy(repoRoot);
  const restored = previous ?? createInteractiveAutonomyRuntimeState(policy);
  restored.policy = policy;
  restored.policyHash = hashInteractiveAutonomyPolicy(policy);
  restored.mode = policy.defaultMode;
  restored.enabled = policy.defaultMode !== "off";
  for (const entry of branch) {
    if (!isRecord(entry)) continue;
    const customType = typeof entry.customType === "string" ? entry.customType : "";
    const data = isRecord(entry.data) ? entry.data : undefined;
    if (customType === "zob-autonomy-state" && data) {
      const mode = asInteractiveAutonomyMode(data.mode);
      if (mode) {
        restored.mode = mode;
        restored.enabled = mode !== "off" && data.enabled !== false;
        restored.updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : restored.updatedAt;
      }
    }
    if (customType === "zob-mission-readiness" && data && data.schema === "zob.mission-readiness.v1") {
      const mode = asInteractiveAutonomyMode(data.mode) ?? restored.mode;
      const decision = typeof data.decision === "string" && ["auto_launch", "clarify", "block", "stopped"].includes(data.decision) ? data.decision as MissionReadinessDecision : undefined;
      const verdict = typeof data.verdict === "string" && ["READY", "NEEDS_CLARIFICATION", "BLOCKED", "STOPPED"].includes(data.verdict) ? data.verdict as MissionReadinessVerdict : undefined;
      if (decision && verdict && typeof data.userInputHash === "string") {
        const signals = isRecord(data.signals) ? data.signals : {};
        restored.lastReadiness = {
          schema: "zob.mission-readiness.v1",
          mode,
          decision,
          verdict,
          score: typeof data.score === "number" ? data.score : 0,
          risk: data.risk === "medium" || data.risk === "high" ? data.risk : "low",
          signals: {
            clarity: typeof signals.clarity === "number" ? signals.clarity : 0,
            acceptanceCriteria: typeof signals.acceptanceCriteria === "number" ? signals.acceptanceCriteria : 0,
            targetPaths: typeof signals.targetPaths === "number" ? signals.targetPaths : 0,
            testability: typeof signals.testability === "number" ? signals.testability : 0,
            safety: typeof signals.safety === "number" ? signals.safety : 0,
          },
          blockerCodes: stringArray(data.blockerCodes, []),
          clarificationCodes: stringArray(data.clarificationCodes, []),
          safetyGateCodes: stringArray(data.safetyGateCodes, []),
          userInputHash: data.userInputHash,
          rawInputStored: false,
          targetPathRefs: stringArray(data.targetPathRefs, []),
          targetPathHashes: stringArray(data.targetPathHashes, []),
          manualPerActionApprovalRequired: data.manualPerActionApprovalRequired !== false,
          inScopeAutonomousActionsAuthorized: data.inScopeAutonomousActionsAuthorized === true,
          safetyGatesStillEnabled: true,
          noShip: data.noShip === true,
          globalProductionClaimAllowed: false,
          bodyStored: false,
          promptBodiesStored: false,
          outputBodiesStored: false,
          generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : new Date().toISOString(),
        };
      }
    }
  }
  restored.lastLaunchAuthorization = restored.lastReadiness?.launchAuthorization;
  return restored;
}

export function formatMissionReadinessForUi(readiness: MissionReadinessReport | undefined): string {
  if (!readiness) return "mission-readiness: none";
  const codes = readiness.decision === "block" ? readiness.blockerCodes : readiness.clarificationCodes;
  const suffix = codes.length > 0 ? ` · ${codes.slice(0, 3).join(",")}` : "";
  return `mission-readiness ${readiness.mode}/${readiness.decision} · score=${readiness.score.toFixed(2)} · risk=${readiness.risk}${suffix}`;
}

export function formatInteractiveAutonomyStatus(state: InteractiveAutonomyRuntimeState): string {
  const launch = state.lastLaunchAuthorization ? "launch=authorized" : "launch=none";
  return [
    `autonomy mode=${state.mode} enabled=${state.enabled}`,
    `policy=${state.policy.source} hash=${state.policyHash.slice(0, 12)}`,
    `manual_per_action_when_launched=${state.policy.launch.manualPerActionApprovalWhenLaunched}`,
    `safety=no-secrets,no-destructive,no-production-apply,on`,
    `${formatMissionReadinessForUi(state.lastReadiness)} · ${launch}`,
    `globalProductionClaimAllowed=false bodyStored=false`,
  ].join("\n");
}

export function formatInteractiveAutonomyPromptHint(state: InteractiveAutonomyRuntimeState): string {
  const readiness = state.lastReadiness;
  const launch = readiness?.launchAuthorization;
  const modeLine = `- mode: ${state.mode} (${state.enabled ? "enabled" : "disabled"}); policy=${state.policy.source}; policy_hash=${state.policyHash.slice(0, 12)}`;
  const readinessLine = readiness
    ? `- mission-readiness.v1: decision=${readiness.decision}; verdict=${readiness.verdict}; score=${readiness.score.toFixed(2)}; risk=${readiness.risk}; input_hash=${readiness.userInputHash.slice(0, 12)}; raw_input_stored=false`
    : "- mission-readiness.v1: none for this branch yet";
  const launchLine = launch
    ? `- launch-authorization.v1: spec_locked=true; user_launch_confirmed=true; manual_per_action_approval_required=${launch.applyPolicy.manualPerActionApprovalRequired}; allowed_actions=${launch.allowedActions.join(",")}; production_apply_allowed=false`
    : "- launch-authorization.v1: none; if decision is clarify/block do not proceed as launched";
  const behavior = readiness?.decision === "auto_launch" && launch
    ? "- Behavior: proceed autonomously for in-scope, policy-compliant work without per-action approval; still use Explore→Plan→Implement→Oracle, concrete validation, TODO/goal gates when appropriate."
    : readiness?.decision === "auto_launch" && !launch
      ? "- Behavior: prior auto-launch readiness was restored hash-only without path scope; do not treat it as active launch authorization. Ask for re-confirmation or re-score the current user request."
      : readiness?.decision === "block"
      ? "- Behavior: do not execute the requested risky action; explain the blocker and request a safe, in-scope revision."
      : readiness?.decision === "stopped" || state.mode === "off"
        ? "- Behavior: autonomy stopped; operate in normal supervised harness mode."
        : "- Behavior: ask the minimum clarifying/challenge questions needed before launching; do not claim launch authorization yet.";
  return [
    "ZOB INTERACTIVE AUTONOMY",
    modeLine,
    readinessLine,
    launchLine,
    behavior,
    "- Non-negotiable gates remain active: no secrets, no destructive commands, no commits unless requested, no out-of-scope writes, no global production autonomy claim without fresh proof and oracle PASS/no_ship=false.",
  ].join("\n");
}
