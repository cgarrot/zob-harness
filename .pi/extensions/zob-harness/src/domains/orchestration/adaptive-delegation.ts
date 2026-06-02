import { existsSync } from "node:fs";
import { join } from "node:path";

import { discoverAgents } from "../delegation/agents.js";
import { DEFAULT_RULES, SUPERVISED_READONLY_CHILD_TOOLS } from "../../core/constants.js";
import { validateOutputContractId } from "../delegation/output-contracts.js";
import { validateAllowedPathPolicy } from "../governance/safety.js";
import type {
  AdaptiveDelegationGovernorState,
  AdaptiveDelegationPolicy,
  AdaptiveDelegationPolicyInput,
  AdaptiveDelegationSandboxGate,
  AdaptiveDelegationSandboxGateInput,
  AdaptiveDelegationScaleApproval,
  AdaptiveDelegationScaleApprovalInput,
  DelegationRequestProposal,
  DelegationScore,
  GovernorDecision,
  ParentDispatchContract,
} from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { pathMatches } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

const ADAPTIVE_DELEGATION_SCHEMA = "zob.adaptive-delegation-policy.v1" as const;
const GOVERNOR_STATE_SCHEMA = "zob.adaptive-delegation-governor-state.v1" as const;
const GOVERNOR_DECISION_SCHEMA = "zob.governor-decision.v1" as const;
const DELEGATION_SCORE_SCHEMA = "zob.delegation-score.v1" as const;

const FORBIDDEN_BODY_KEYS = new Set(["body", "prompt", "output", "task", "content", "patch", "diff", "rawRationale", "rawContext", "messages", "transcript"]);
const WRITE_OR_DELEGATION_TOOLS = new Set(["bash", "edit", "write", "delegate_agent", "delegate_task", "orchestrate_run", "factory_run"]);
const READONLY_TOOL_ALLOWLIST = new Set<string>(SUPERVISED_READONLY_CHILD_TOOLS);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export const ADAPTIVE_DELEGATION_HARD_MAX_DEPTH = 4;
export const ADAPTIVE_DELEGATION_DEFAULT_MAX_TOTAL_AGENTS = 20;
export const ADAPTIVE_DELEGATION_HARD_MAX_TOTAL_AGENTS_WITH_ORACLE = 30;

function asPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeAdaptiveDelegationSandboxGate(input?: AdaptiveDelegationSandboxGateInput): AdaptiveDelegationSandboxGate | undefined {
  if (!input) return undefined;
  const sandboxRunId = typeof input.sandboxRunId === "string" ? input.sandboxRunId.trim() : "";
  return {
    schema: "zob.adaptive-delegation-sandbox-gate.v1",
    enabled: input.enabled === true,
    mode: input.enabled === true ? (input.mode ?? "proposal_only") : "off",
    sandboxRunIdHash: sandboxRunId ? sha256(sandboxRunId) : undefined,
    diffReviewGateHash: typeof input.diffReviewGateHash === "string" ? input.diffReviewGateHash : undefined,
    applyReadinessHash: typeof input.applyReadinessHash === "string" ? input.applyReadinessHash : undefined,
    approvalHash: typeof input.approvalHash === "string" ? input.approvalHash : undefined,
    liveWriteDispatchEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function normalizeAdaptiveDelegationScaleApproval(input?: AdaptiveDelegationScaleApprovalInput): AdaptiveDelegationScaleApproval | undefined {
  if (!input) return undefined;
  const approvedBy = typeof input.approvedBy === "string" ? input.approvedBy.trim() : "";
  const approvalId = typeof input.approvalId === "string" ? input.approvalId.trim() : "";
  const scope = typeof input.scope === "string" ? input.scope.trim() : "";
  return {
    schema: "zob.adaptive-delegation-scale-approval.v1",
    approvedByHash: approvedBy ? sha256(approvedBy) : undefined,
    approvedAt: typeof input.approvedAt === "string" && input.approvedAt.trim().length > 0 ? input.approvedAt.trim() : undefined,
    approvalIdHash: approvalId ? sha256(approvalId) : undefined,
    scopeHash: scope ? sha256(scope) : undefined,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function canonicalizeAdaptiveRequestedAgent(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase().replace(/_/g, "-");
  const aliases: Record<string, string> = {
    "explore-agent": "explore",
    "explore-worker": "explore",
    "explorer-agent": "explore",
    "read-only-explore-agent": "explore",
    "readonly-explore-agent": "explore",
    "read-only-explorer-agent": "explore",
    "qa-agent": "qa",
    "oracle-agent": "oracle",
    "planner-agent": "planner",
  };
  return aliases[normalized] ?? trimmed;
}

export function normalizeAdaptiveDelegationPolicy(input?: AdaptiveDelegationPolicyInput): AdaptiveDelegationPolicy {
  const enabled = input?.enabled === true;
  const mode = enabled ? (input?.mode ?? "advisory_only") : "off";
  const dispatch = enabled && input?.dispatch === true;
  return {
    schema: ADAPTIVE_DELEGATION_SCHEMA,
    enabled,
    mode,
    dispatch,
    recordDecisionsOnly: input?.recordDecisionsOnly ?? !dispatch,
    configuredMaxDepth: asPositiveInteger(input?.configuredMaxDepth, ADAPTIVE_DELEGATION_HARD_MAX_DEPTH),
    runtimeMaxDepth: asPositiveInteger(input?.runtimeMaxDepth, 1),
    rootFanoutMax: asPositiveInteger(input?.rootFanoutMax, 6),
    nodeFanoutMax: asPositiveInteger(input?.nodeFanoutMax, 4),
    globalParallelMax: asPositiveInteger(input?.globalParallelMax, 4),
    maxTotalAgents: asPositiveInteger(input?.maxTotalAgents, ADAPTIVE_DELEGATION_DEFAULT_MAX_TOTAL_AGENTS),
    maxTotalAgentsWithOracle: asPositiveInteger(input?.maxTotalAgentsWithOracle, ADAPTIVE_DELEGATION_DEFAULT_MAX_TOTAL_AGENTS),
    ttlPerRequest: asPositiveInteger(input?.ttlPerRequest, 3),
    minApprovalScore: asFiniteNumber(input?.minApprovalScore, 0.7),
    oracle: input?.oracle ?? "conditional",
    strictBudgetRequired: input?.strictBudgetRequired ?? true,
    sandboxGate: normalizeAdaptiveDelegationSandboxGate(input?.sandboxGate),
    scaleApproval: normalizeAdaptiveDelegationScaleApproval(input?.scaleApproval),
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function validateAdaptiveDelegationPolicy(policy: AdaptiveDelegationPolicy): string[] {
  const errors: string[] = [];
  if (!policy.enabled && policy.mode !== "off") errors.push("adaptive_delegation mode must be off when enabled=false");
  if (!policy.enabled && policy.dispatch) errors.push("adaptive_delegation dispatch cannot be true when enabled=false");
  if (policy.enabled && policy.mode === "off") errors.push("adaptive_delegation enabled=true requires mode advisory_only or when_pertinent");
  if (policy.mode === "advisory_only" && policy.dispatch) errors.push("adaptive_delegation advisory_only mode cannot dispatch live children");
  if (policy.dispatch && policy.mode !== "when_pertinent") errors.push("adaptive_delegation dispatch=true requires mode=when_pertinent");

  const integerFields: Array<[keyof AdaptiveDelegationPolicy, number]> = [
    ["configuredMaxDepth", policy.configuredMaxDepth],
    ["runtimeMaxDepth", policy.runtimeMaxDepth],
    ["rootFanoutMax", policy.rootFanoutMax],
    ["nodeFanoutMax", policy.nodeFanoutMax],
    ["globalParallelMax", policy.globalParallelMax],
    ["maxTotalAgents", policy.maxTotalAgents],
    ["maxTotalAgentsWithOracle", policy.maxTotalAgentsWithOracle],
    ["ttlPerRequest", policy.ttlPerRequest],
  ];
  for (const [field, value] of integerFields) {
    if (!Number.isInteger(value) || value < 1) errors.push(`adaptive_delegation ${String(field)} must be a positive integer`);
  }

  if (policy.configuredMaxDepth > ADAPTIVE_DELEGATION_HARD_MAX_DEPTH) errors.push(`adaptive_delegation configuredMaxDepth must be <= ${ADAPTIVE_DELEGATION_HARD_MAX_DEPTH}`);
  if (policy.runtimeMaxDepth > policy.configuredMaxDepth) errors.push("adaptive_delegation runtimeMaxDepth must be <= configuredMaxDepth");
  if (policy.maxTotalAgents > policy.maxTotalAgentsWithOracle) errors.push("adaptive_delegation maxTotalAgents must be <= maxTotalAgentsWithOracle");
  if (policy.maxTotalAgentsWithOracle > ADAPTIVE_DELEGATION_HARD_MAX_TOTAL_AGENTS_WITH_ORACLE) errors.push(`adaptive_delegation maxTotalAgentsWithOracle must be <= ${ADAPTIVE_DELEGATION_HARD_MAX_TOTAL_AGENTS_WITH_ORACLE}`);
  if (policy.minApprovalScore < 0 || policy.minApprovalScore > 1) errors.push("adaptive_delegation minApprovalScore must be between 0 and 1");
  if (policy.parentOwnedDispatch !== true) errors.push("adaptive_delegation parentOwnedDispatch must be true");
  if (policy.childDirectDispatch !== false) errors.push("adaptive_delegation childDirectDispatch must be false");
  const highScaleRequested = policy.maxTotalAgents > ADAPTIVE_DELEGATION_DEFAULT_MAX_TOTAL_AGENTS || policy.maxTotalAgentsWithOracle > ADAPTIVE_DELEGATION_DEFAULT_MAX_TOTAL_AGENTS;
  if (highScaleRequested && policy.oracle === "off") errors.push("adaptive_delegation 20/30-agent scale requires oracle=conditional or oracle=always");
  if (policy.sandboxGate) {
    if (policy.sandboxGate.enabled === true && policy.sandboxGate.mode !== "proposal_only") errors.push("adaptive_delegation sandboxGate P9 supports only mode=proposal_only");
    if (policy.sandboxGate.enabled === false && policy.sandboxGate.mode !== "off") errors.push("adaptive_delegation sandboxGate mode must be off when enabled=false");
    if (policy.sandboxGate.diffReviewGateHash !== undefined && !isSha256Hex(policy.sandboxGate.diffReviewGateHash)) errors.push("adaptive_delegation sandboxGate.diffReviewGateHash must be lowercase sha256 hex");
    if (policy.sandboxGate.applyReadinessHash !== undefined && !isSha256Hex(policy.sandboxGate.applyReadinessHash)) errors.push("adaptive_delegation sandboxGate.applyReadinessHash must be lowercase sha256 hex");
    if (policy.sandboxGate.approvalHash !== undefined && !isSha256Hex(policy.sandboxGate.approvalHash)) errors.push("adaptive_delegation sandboxGate.approvalHash must be lowercase sha256 hex");
    if (policy.sandboxGate.liveWriteDispatchEnabled !== false || policy.sandboxGate.productionWritesPerformed !== false || policy.sandboxGate.autoApply !== false) errors.push("adaptive_delegation sandboxGate must keep live writes and auto-apply disabled");
    if (policy.sandboxGate.bodyStored !== false || policy.sandboxGate.promptBodiesStored !== false || policy.sandboxGate.outputBodiesStored !== false) errors.push("adaptive_delegation sandboxGate must be hash-only with body flags false");
  }
  if (policy.scaleApproval) {
    if (!isSha256Hex(policy.scaleApproval.approvedByHash)) errors.push("adaptive_delegation scaleApproval.approvedBy is required and stored as approvedByHash");
    if (!isSha256Hex(policy.scaleApproval.approvalIdHash)) errors.push("adaptive_delegation scaleApproval.approvalId is required and stored as approvalIdHash");
    if (typeof policy.scaleApproval.approvedAt !== "string" || policy.scaleApproval.approvedAt.trim().length === 0) errors.push("adaptive_delegation scaleApproval.approvedAt is required");
    if (policy.scaleApproval.scopeHash !== undefined && !isSha256Hex(policy.scaleApproval.scopeHash)) errors.push("adaptive_delegation scaleApproval.scopeHash must be lowercase sha256 hex");
    if (policy.scaleApproval.bodyStored !== false || policy.scaleApproval.promptBodiesStored !== false || policy.scaleApproval.outputBodiesStored !== false) errors.push("adaptive_delegation scaleApproval must be hash-only with body flags false");
  }
  if (policy.dispatch && policy.strictBudgetRequired !== true) errors.push("adaptive_delegation dispatch=true requires strictBudgetRequired=true");
  if (highScaleRequested && !policy.scaleApproval) errors.push("adaptive_delegation 20/30-agent scale requires scaleApproval metadata");
  if (policy.dispatch && policy.runtimeMaxDepth === ADAPTIVE_DELEGATION_HARD_MAX_DEPTH) {
    if (policy.oracle === "off") errors.push("adaptive_delegation runtimeMaxDepth=4 requires oracle=conditional or oracle=always");
    if (policy.minApprovalScore < 0.85) errors.push("adaptive_delegation runtimeMaxDepth=4 requires minApprovalScore >= 0.85");
    if (policy.maxTotalAgentsWithOracle > ADAPTIVE_DELEGATION_DEFAULT_MAX_TOTAL_AGENTS && !policy.scaleApproval) errors.push("adaptive_delegation runtimeMaxDepth=4 with 20/30-agent scale requires scaleApproval metadata");
  }
  return errors;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

function optionalHashError(field: string, value: unknown): string | undefined {
  return value === undefined || isSha256Hex(value) ? undefined : `adaptive_delegation ${field} must be a lowercase sha256 hex string`;
}

function hasForbiddenBodyKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((child) => hasForbiddenBodyKeys(child));
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKeys(child));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedTaskShape(request: DelegationRequestProposal): Record<string, unknown> {
  return {
    requesterRole: request.requesterRole,
    referentRole: request.referentRole,
    requestedAgent: request.requestedAgent,
    requestedOutputContract: request.requestedOutputContract,
    requiredTools: [...request.requiredTools].sort(),
    evidenceRefs: [...request.evidenceRefs].sort(),
    targetFileSet: [...(request.targetFileSet ?? [])].sort(),
    targetDepth: request.targetDepth,
    proposedTaskHash: request.proposedTaskHash,
    proposedContextHash: request.proposedContextHash,
  };
}

export function computeAdaptiveDelegationNormalizedTaskHash(request: DelegationRequestProposal): string {
  return sha256(stableJson(normalizedTaskShape(request)));
}

export function computeAdaptiveDelegationRequestId(input: { runId: string; parentTaskId: string; request: DelegationRequestProposal }): string {
  return `adreq_${sha256(stableJson({ runId: input.runId, parentTaskId: input.parentTaskId, normalizedTaskHash: computeAdaptiveDelegationNormalizedTaskHash(input.request) })).slice(0, 24)}`;
}

export function computeAdaptiveDelegationLineageHash(input: { rootGoalHash: string; parentTaskId: string; request: DelegationRequestProposal }): string {
  return sha256(stableJson({ rootGoalHash: input.rootGoalHash, parentTaskId: input.parentTaskId, normalizedTaskHash: computeAdaptiveDelegationNormalizedTaskHash(input.request), requesterRole: input.request.requesterRole, targetDepth: input.request.targetDepth }));
}

export function computeAdaptiveDelegationDuplicateSignature(request: DelegationRequestProposal, rootGoalHash = ""): string {
  return sha256(stableJson({
    rootGoalHash,
    requesterRole: request.requesterRole,
    referentRole: request.referentRole,
    targetDepth: request.targetDepth,
    requestedAgent: request.requestedAgent,
    requestedOutputContract: request.requestedOutputContract,
    requiredTools: [...request.requiredTools].sort(),
    evidenceRefs: [...request.evidenceRefs].sort(),
    targetFileSet: [...(request.targetFileSet ?? [])].sort(),
    normalizedTaskHash: computeAdaptiveDelegationNormalizedTaskHash(request),
  }));
}

export function validateAdaptiveDelegationEvidenceRefs(repoRoot: string, evidenceRefs: string[]): string[] {
  const errors: string[] = [];
  if (evidenceRefs.length === 0) errors.push("adaptive_delegation request requires at least one evidenceRef");
  for (const ref of evidenceRefs) {
    if (typeof ref !== "string" || ref.trim().length === 0) {
      errors.push("adaptive_delegation evidenceRef must be a non-empty string");
      continue;
    }
    if (ref.includes("\0")) errors.push(`adaptive_delegation evidenceRef contains NUL byte: ${ref}`);
    if (ref.startsWith("/") || ref === "~" || ref.startsWith("~/")) errors.push(`adaptive_delegation evidenceRef must be repo-relative: ${ref}`);
    if (ref === "." || ref === "./" || ref === ".." || ref.startsWith("../")) errors.push(`adaptive_delegation evidenceRef is too broad or escapes repo: ${ref}`);
    if (!ref.startsWith("/") && ref !== "~" && !ref.startsWith("~/") && !ref.includes("\0") && !existsSync(join(repoRoot, ref))) errors.push(`adaptive_delegation evidenceRef does not exist: ${ref}`);
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(ref, protectedPattern, repoRoot, repoRoot)) errors.push(`adaptive_delegation evidenceRef references zero-access path: ${protectedPattern}`);
    }
    for (const readonlyGenerated of ["node_modules/", "dist/", "build/"]) {
      if (pathMatches(ref, readonlyGenerated, repoRoot, repoRoot)) errors.push(`adaptive_delegation evidenceRef references generated/vendor path: ${readonlyGenerated}`);
    }
  }
  return errors;
}

export function validateDelegationRequestHardGates(input: {
  repoRoot: string;
  request: DelegationRequestProposal;
  policy: AdaptiveDelegationPolicy;
  rootGoalHash: string;
  parentTaskId: string;
  seenLineageHashes?: Set<string>;
  totalDispatched?: number;
  fanoutForRequester?: number;
}): string[] {
  const { request, policy } = input;
  const errors: string[] = [];
  if (hasForbiddenBodyKeys(request)) errors.push("adaptive_delegation request must not contain plaintext body/prompt/output/task/content fields");
  if (request.bodyStored !== false || request.promptBodiesStored !== false || request.outputBodiesStored !== false) errors.push("adaptive_delegation request must declare bodyStored=false, promptBodiesStored=false, outputBodiesStored=false");
  if (request.targetDepth !== request.requesterDepth + 1) errors.push("adaptive_delegation targetDepth must equal requesterDepth + 1");
  if (request.targetDepth > policy.configuredMaxDepth) errors.push("adaptive_delegation targetDepth exceeds configuredMaxDepth");
  if (request.targetDepth > policy.runtimeMaxDepth) errors.push("adaptive_delegation targetDepth exceeds runtimeMaxDepth");
  if ((request.ttlRequested ?? policy.ttlPerRequest) <= 0) errors.push("adaptive_delegation ttlRemaining must be positive");
  if (input.seenLineageHashes?.has(computeAdaptiveDelegationLineageHash({ rootGoalHash: input.rootGoalHash, parentTaskId: input.parentTaskId, request }))) errors.push("adaptive_delegation duplicate lineage detected");
  if ((input.totalDispatched ?? 0) >= policy.maxTotalAgentsWithOracle) errors.push("adaptive_delegation maxTotalAgentsWithOracle cap exceeded");
  if ((input.totalDispatched ?? 0) >= policy.maxTotalAgents && policy.oracle === "off") errors.push("adaptive_delegation maxTotalAgents cap exceeded and oracle is off");
  const fanoutCap = request.requesterDepth === 0 ? policy.rootFanoutMax : policy.nodeFanoutMax;
  if ((input.fanoutForRequester ?? 0) >= fanoutCap) errors.push("adaptive_delegation fanout cap exceeded for requester");
  if (request.requiredTools.length === 0) errors.push("adaptive_delegation request requires requiredTools");
  for (const tool of request.requiredTools) {
    if (WRITE_OR_DELEGATION_TOOLS.has(tool)) {
      if (tool === "bash" || tool === "edit" || tool === "write") errors.push(`adaptive_delegation sandbox/write dispatch is not enabled in P9; blocked requested tool: ${tool}`);
      else errors.push(`adaptive_delegation request forbids write/delegation tool: ${tool}`);
    }
    if (!READONLY_TOOL_ALLOWLIST.has(tool)) errors.push(`adaptive_delegation tool is not in supervised_readonly allowlist: ${tool}`);
  }
  errors.push(...validateOutputContractId(request.requestedOutputContract).map((error) => `adaptive_delegation output contract: ${error}`));
  const knownAgents = new Set(discoverAgents(input.repoRoot, "project").map((agent) => agent.name.toLowerCase()));
  if (request.requestedAgent && !knownAgents.has(request.requestedAgent.toLowerCase())) errors.push(`adaptive_delegation requestedAgent is not a known project agent: ${request.requestedAgent}`);
  errors.push(...validateAdaptiveDelegationEvidenceRefs(input.repoRoot, request.evidenceRefs));
  errors.push(...validateAllowedPathPolicy(request.targetFileSet, "adaptive_delegation targetFileSet", input.repoRoot));
  for (const [field, value] of [["proposedTaskHash", request.proposedTaskHash], ["proposedContextHash", request.proposedContextHash], ["rationaleHash", request.rationaleHash]] as const) {
    const error = optionalHashError(field, value);
    if (error) errors.push(error);
  }
  if (!request.requesterRole || !request.referentRole || !request.requestedAgent) errors.push("adaptive_delegation requesterRole, referentRole, and requestedAgent are required");
  return errors;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function scoreDelegationRequest(input: { request: DelegationRequestProposal; hardGateErrors: string[]; policy: AdaptiveDelegationPolicy }): DelegationScore {
  const { request, hardGateErrors, policy } = input;
  const evidenceQuality = clampScore(request.evidenceRefs.length / 3);
  const successDelta = typeof request.estimatedSuccessIfAlone === "number" && typeof request.estimatedSuccessWithDelegation === "number"
    ? request.estimatedSuccessWithDelegation - request.estimatedSuccessIfAlone
    : 0;
  const tokenBenefit = typeof request.estimatedTokensIfAlone === "number" && typeof request.estimatedTokensWithDelegation === "number" && request.estimatedTokensIfAlone > 0
    ? (request.estimatedTokensIfAlone - request.estimatedTokensWithDelegation) / request.estimatedTokensIfAlone
    : 0;
  const costBenefit = clampScore(Math.max(successDelta, tokenBenefit, 0));
  const safety = hardGateErrors.length === 0 ? (request.risk === "low" ? 1 : request.risk === "medium" ? 0.75 : 0.35) : 0;
  const relevance = request.proposedTaskHash || request.targetFileSet?.length ? 0.8 : 0.55;
  const novelty = request.targetFileSet && request.targetFileSet.length > 0 ? 0.75 : 0.5;
  const urgency = request.targetDepth >= policy.runtimeMaxDepth ? 0.4 : 0.55;
  const total = clampScore((0.25 * relevance) + (0.25 * evidenceQuality) + (0.20 * costBenefit) + (0.15 * safety) + (0.10 * novelty) + (0.05 * urgency));
  const greyZone = total >= 0.45 && total < policy.minApprovalScore;
  const decisionHint = hardGateErrors.length > 0 ? "deny" : request.risk === "high" || greyZone || request.targetDepth === ADAPTIVE_DELEGATION_HARD_MAX_DEPTH ? "oracle_required" : total >= policy.minApprovalScore ? "approve" : "deny";
  return {
    schema: DELEGATION_SCORE_SCHEMA,
    relevance,
    evidenceQuality,
    costBenefit,
    safety,
    novelty,
    urgency,
    total,
    decisionHint,
    reasons: [
      ...(hardGateErrors.length > 0 ? ["hard_gates_failed"] : []),
      ...(greyZone ? ["score_grey_zone"] : []),
      ...(request.risk === "high" ? ["high_risk_requires_oracle"] : []),
      ...(request.targetDepth === ADAPTIVE_DELEGATION_HARD_MAX_DEPTH ? ["target_depth_4_requires_oracle"] : []),
    ],
  };
}

export function decideDelegationRequest(input: {
  repoRoot: string;
  runId: string;
  rootGoalHash: string;
  parentTaskId: string;
  request: DelegationRequestProposal;
  policy: AdaptiveDelegationPolicy;
  seenLineageHashes?: Set<string>;
  totalDispatched?: number;
  fanoutForRequester?: number;
}): GovernorDecision {
  const hardGateErrors = validateDelegationRequestHardGates(input);
  const score = scoreDelegationRequest({ request: input.request, hardGateErrors, policy: input.policy });
  const requestId = computeAdaptiveDelegationRequestId(input);
  const lineageHash = computeAdaptiveDelegationLineageHash(input);
  const normalizedTaskHash = computeAdaptiveDelegationNormalizedTaskHash(input.request);
  const oracleRequired = score.decisionHint === "oracle_required" || input.request.targetDepth === ADAPTIVE_DELEGATION_HARD_MAX_DEPTH || input.request.risk === "high";
  const approvedByScore = score.total >= input.policy.minApprovalScore;
  const dispatchAllowed = hardGateErrors.length === 0 && approvedByScore && !oracleRequired && input.policy.dispatch === true && input.policy.mode === "when_pertinent";
  const status: GovernorDecision["status"] = hardGateErrors.length > 0
    ? "blocked"
    : oracleRequired
      ? "oracle_required"
      : approvedByScore
        ? (input.policy.dispatch ? "approved" : "deferred")
        : "denied";
  return {
    schema: GOVERNOR_DECISION_SCHEMA,
    parentAssignedRequestId: requestId,
    parentComputedLineageHash: lineageHash,
    parentComputedNormalizedTaskHash: normalizedTaskHash,
    requesterRole: input.request.requesterRole,
    referentRole: input.request.referentRole,
    requesterDepth: input.request.requesterDepth,
    targetDepth: input.request.targetDepth,
    ttlRemaining: input.request.ttlRequested ?? input.policy.ttlPerRequest,
    hardGateStatus: hardGateErrors.length === 0 ? "passed" : "blocked",
    hardGateErrors,
    score,
    status,
    dispatchAllowed,
    noShip: status === "blocked" || status === "oracle_required" || (input.request.targetDepth > 1 && input.policy.dispatch !== true),
    reasons: [...hardGateErrors, ...score.reasons, ...(input.policy.dispatch ? [] : ["dispatch_disabled_or_advisory_only"])],
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildParentDispatchContractForDecision(input: { runId: string; parentTaskId: string; request: DelegationRequestProposal; decision: GovernorDecision; dispatchGate?: string }): ParentDispatchContract | undefined {
  const { request, decision } = input;
  if (decision.hardGateStatus !== "passed") return undefined;
  if (decision.status !== "deferred" && decision.status !== "approved") return undefined;
  return {
    schema: "zob.parent-dispatch-contract.v1",
    requestId: decision.parentAssignedRequestId,
    runId: input.runId,
    parentTaskId: input.parentTaskId,
    agent: request.requestedAgent,
    taskHash: isSha256Hex(request.proposedTaskHash) ? request.proposedTaskHash : decision.parentComputedNormalizedTaskHash,
    contextHash: isSha256Hex(request.proposedContextHash) ? request.proposedContextHash : undefined,
    rationaleHash: isSha256Hex(request.rationaleHash) ? request.rationaleHash : undefined,
    outputContract: request.requestedOutputContract,
    requiredTools: [...request.requiredTools],
    allowedPaths: request.targetFileSet ? [...request.targetFileSet] : undefined,
    forbiddenPaths: [...DEFAULT_RULES.zeroAccessPaths],
    requesterDepth: request.requesterDepth,
    targetDepth: request.targetDepth,
    referentRole: request.referentRole,
    dispatcher: "parent",
    status: "queued_not_dispatched",
    dispatchGate: input.dispatchGate ?? (decision.dispatchAllowed ? "p4_parent_dispatch_pending" : "dispatch_disabled_or_advisory_only"),
    liveDispatched: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildInitialAdaptiveDelegationGovernorState(input: { runId: string; rootGoalHash: string; policy: AdaptiveDelegationPolicy }): AdaptiveDelegationGovernorState {
  return {
    schema: GOVERNOR_STATE_SCHEMA,
    runId: input.runId,
    rootGoalHash: input.rootGoalHash,
    policyHash: sha256(stableJson(input.policy)),
    totalRequested: 0,
    totalApproved: 0,
    totalDispatched: 0,
    totalDenied: 0,
    totalDeferred: 0,
    totalOracleRequired: 0,
    maxDepthObserved: 0,
    fanoutByRequester: {},
    requestIds: [],
    lineageHashes: [],
    paused: false,
    stopped: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function updateGovernorState(state: AdaptiveDelegationGovernorState, decision: GovernorDecision): AdaptiveDelegationGovernorState {
  const nextFanout = { ...state.fanoutByRequester };
  nextFanout[decision.requesterRole] = (nextFanout[decision.requesterRole] ?? 0) + 1;
  return {
    ...state,
    totalRequested: state.totalRequested + 1,
    totalApproved: state.totalApproved + (decision.status === "approved" ? 1 : 0),
    totalDispatched: state.totalDispatched + (decision.dispatchAllowed ? 1 : 0),
    totalDenied: state.totalDenied + (decision.status === "denied" || decision.status === "blocked" ? 1 : 0),
    totalDeferred: state.totalDeferred + (decision.status === "deferred" ? 1 : 0),
    totalOracleRequired: state.totalOracleRequired + (decision.status === "oracle_required" ? 1 : 0),
    maxDepthObserved: Math.max(state.maxDepthObserved, decision.targetDepth),
    fanoutByRequester: nextFanout,
    requestIds: state.requestIds.includes(decision.parentAssignedRequestId) ? state.requestIds : [...state.requestIds, decision.parentAssignedRequestId],
    lineageHashes: state.lineageHashes.includes(decision.parentComputedLineageHash) ? state.lineageHashes : [...state.lineageHashes, decision.parentComputedLineageHash],
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function extractDelegationRequestsFromText(text: string): { requests: DelegationRequestProposal[]; errors: string[] } {
  const errors: string[] = [];
  const requests: DelegationRequestProposal[] = [];
  for (const match of text.matchAll(/<delegation_requests>\s*([\s\S]*?)\s*<\/delegation_requests>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const root = isRecord(parsed) && Array.isArray(parsed.requests) ? parsed.requests : Array.isArray(parsed) ? parsed : undefined;
      if (!root) {
        errors.push("delegation_requests block must contain an array or { requests: [...] }");
        continue;
      }
      for (const item of root) {
        if (!isRecord(item)) {
          errors.push("delegation request entry must be an object");
          continue;
        }
        if (hasForbiddenBodyKeys(item)) {
          errors.push("delegation request entry must not include plaintext body/prompt/output/task/content fields");
          continue;
        }
        const hashFieldErrors = [
          optionalHashError("proposedTaskHash", item.proposedTaskHash),
          optionalHashError("proposedContextHash", item.proposedContextHash),
          optionalHashError("rationaleHash", item.rationaleHash),
        ].filter((error): error is string => typeof error === "string");
        if (hashFieldErrors.length > 0) {
          errors.push(...hashFieldErrors.map((error) => `delegation request entry ${error}`));
          continue;
        }
        const requiredTools = Array.isArray(item.requiredTools) ? item.requiredTools.filter((tool): tool is string => typeof tool === "string") : [];
        const evidenceRefs = Array.isArray(item.evidenceRefs) ? item.evidenceRefs.filter((ref): ref is string => typeof ref === "string") : [];
        requests.push({
          schema: "zob.delegation-request.v1",
          requesterRole: typeof item.requesterRole === "string" ? item.requesterRole : "",
          referentRole: typeof item.referentRole === "string" ? item.referentRole : "",
          requestedAgent: typeof item.requestedAgent === "string" ? canonicalizeAdaptiveRequestedAgent(item.requestedAgent) : "",
          requestedOutputContract: typeof item.requestedOutputContract === "string" ? item.requestedOutputContract : "",
          requiredTools,
          requesterDepth: typeof item.requesterDepth === "number" ? item.requesterDepth : 0,
          targetDepth: typeof item.targetDepth === "number" ? item.targetDepth : 1,
          ttlRequested: typeof item.ttlRequested === "number" ? item.ttlRequested : undefined,
          evidenceRefs,
          targetFileSet: Array.isArray(item.targetFileSet) ? item.targetFileSet.filter((ref): ref is string => typeof ref === "string") : undefined,
          estimatedTokensIfAlone: typeof item.estimatedTokensIfAlone === "number" ? item.estimatedTokensIfAlone : undefined,
          estimatedTokensWithDelegation: typeof item.estimatedTokensWithDelegation === "number" ? item.estimatedTokensWithDelegation : undefined,
          estimatedCostUsd: typeof item.estimatedCostUsd === "number" ? item.estimatedCostUsd : undefined,
          estimatedDurationMs: typeof item.estimatedDurationMs === "number" ? item.estimatedDurationMs : undefined,
          estimatedSuccessIfAlone: typeof item.estimatedSuccessIfAlone === "number" ? item.estimatedSuccessIfAlone : undefined,
          estimatedSuccessWithDelegation: typeof item.estimatedSuccessWithDelegation === "number" ? item.estimatedSuccessWithDelegation : undefined,
          risk: item.risk === "high" || item.risk === "medium" || item.risk === "low" ? item.risk : "medium",
          proposedTaskHash: typeof item.proposedTaskHash === "string" ? item.proposedTaskHash : undefined,
          proposedContextHash: typeof item.proposedContextHash === "string" ? item.proposedContextHash : undefined,
          rationaleHash: typeof item.rationaleHash === "string" ? item.rationaleHash : undefined,
          bodyStored: false,
          promptBodiesStored: false,
          outputBodiesStored: false,
        });
      }
    } catch (error) {
      errors.push(`Could not parse delegation_requests JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { requests, errors };
}
