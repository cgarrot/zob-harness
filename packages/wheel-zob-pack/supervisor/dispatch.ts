import { sha256Canonical, sha256Text } from "./canonical.js";
import { validateDispatchResultPosture, validateWheelSupervisorAuthority } from "./contracts.js";
import type {
  WheelDispatchAdapter,
  WheelDispatchRequest,
  WheelDispatchResult,
  WheelFailureClass,
  WheelSupervisorAuthority,
  WheelSupervisorRole,
} from "./types.js";

export type WheelFakeDispatchOutcome = "accepted" | "model-quality" | "validation" | "review-finding" | "provider-transient" | "human-blocked";

export interface WheelFakeDispatchRule {
  storyId?: string;
  role?: WheelSupervisorRole;
  candidateIndex?: number;
  attemptOrdinal?: number;
  qualityRung?: "low" | "high";
  outcome: WheelFakeDispatchOutcome;
  evidenceRefs?: string[];
}

export interface WheelRecordedDispatchRequest {
  missionId: string;
  storyId: string;
  attemptId: string;
  assignmentId: string;
  role: WheelSupervisorRole;
  routeId: string;
  provider: string;
  family: string;
  promptHash: string;
  requestHash: string;
  bodyStored: false;
}

function blockedDispatchResult(request: WheelDispatchRequest, failureClass: WheelFailureClass): WheelDispatchResult {
  return {
    schema: "wheel.zob.dispatch-result.v1",
    attemptId: request.attemptId,
    assignmentId: request.assignmentId,
    status: "blocked",
    failureClass,
    evidenceRefs: [],
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    mocked: false,
    networkAccessed: false,
    providerCalled: false,
    bodyStored: false,
  };
}

export class DisabledWheelDispatchAdapter implements WheelDispatchAdapter {
  readonly mode = "disabled" as const;

  async dispatch(request: WheelDispatchRequest, authority: WheelSupervisorAuthority): Promise<WheelDispatchResult> {
    const issues = validateWheelSupervisorAuthority(authority);
    if (issues.length > 0) throw new Error(`invalid dispatch authority: ${issues.join("; ")}`);
    if (authority.mode !== "disabled") throw new Error("disabled dispatch adapter requires disabled authority");
    return blockedDispatchResult(request, "policy-blocked");
  }
}

function matchesRule(rule: WheelFakeDispatchRule, request: WheelDispatchRequest): boolean {
  if (rule.storyId !== undefined && rule.storyId !== request.storyId) return false;
  if (rule.role !== undefined && rule.role !== request.role) return false;
  const candidateIndex = Number(request.sourceBindings.candidateIndex ?? "0");
  const qualityRung = request.sourceBindings.qualityRung ?? "low";
  const attemptOrdinal = Number(request.sourceBindings.attemptOrdinal ?? "1");
  if (rule.candidateIndex !== undefined && rule.candidateIndex !== candidateIndex) return false;
  if (rule.attemptOrdinal !== undefined && rule.attemptOrdinal !== attemptOrdinal) return false;
  if (rule.qualityRung !== undefined && rule.qualityRung !== qualityRung) return false;
  return true;
}

function outcomeResult(
  request: WheelDispatchRequest,
  outcome: WheelFakeDispatchOutcome,
  evidenceRefs: string[],
): WheelDispatchResult {
  const outputHash = sha256Text(`fake-output:${sha256Canonical({
    missionId: request.missionId,
    storyId: request.storyId,
    role: request.role,
    routeId: request.routeId,
    promptHash: request.promptHash,
    outcome,
  })}`);
  const accepted = outcome === "accepted";
  const failureClass: WheelFailureClass = outcome === "accepted" ? "none"
    : outcome === "model-quality" ? "model-quality"
      : outcome === "validation" ? "validation"
        : outcome === "review-finding" ? "review-finding"
          : outcome === "provider-transient" ? "provider-transient"
            : "human-blocked";
  return {
    schema: "wheel.zob.dispatch-result.v1",
    attemptId: request.attemptId,
    assignmentId: request.assignmentId,
    status: accepted ? "accepted" : outcome === "human-blocked" ? "blocked" : outcome === "provider-transient" ? "failed" : "rejected",
    failureClass,
    outputHash,
    claimHash: accepted ? sha256Text(`fake-claim:${outputHash}`) : undefined,
    evidenceRefs: accepted ? evidenceRefs : [],
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    mocked: true,
    networkAccessed: false,
    providerCalled: false,
    bodyStored: false,
  };
}

export class DeterministicFakeWheelDispatchAdapter implements WheelDispatchAdapter {
  readonly mode = "deterministic-fake" as const;
  readonly recordedRequests: WheelRecordedDispatchRequest[] = [];

  constructor(private readonly rules: readonly WheelFakeDispatchRule[] = []) {}

  async dispatch(request: WheelDispatchRequest, authority: WheelSupervisorAuthority): Promise<WheelDispatchResult> {
    const authorityIssues = validateWheelSupervisorAuthority(authority);
    if (authorityIssues.length > 0) throw new Error(`invalid dispatch authority: ${authorityIssues.join("; ")}`);
    if (authority.mode !== "deterministic-fake") throw new Error("fake dispatch adapter requires deterministic-fake authority");
    if (request.transientPromptBody.length === 0) throw new Error("dispatch prompt cannot be empty");
    if (sha256Text(request.transientPromptBody) !== request.promptHash) throw new Error("dispatch promptHash mismatch");
    const recorded: WheelRecordedDispatchRequest = {
      missionId: request.missionId,
      storyId: request.storyId,
      attemptId: request.attemptId,
      assignmentId: request.assignmentId,
      role: request.role,
      routeId: request.routeId,
      provider: request.provider,
      family: request.family,
      promptHash: request.promptHash,
      requestHash: sha256Canonical({
        missionId: request.missionId,
        storyId: request.storyId,
        attemptId: request.attemptId,
        assignmentId: request.assignmentId,
        role: request.role,
        routeId: request.routeId,
        thinkingControl: request.thinkingControl,
        promptHash: request.promptHash,
        sourceBindings: request.sourceBindings,
      }),
      bodyStored: false,
    };
    this.recordedRequests.push(recorded);
    const rule = this.rules.find((candidate) => matchesRule(candidate, request));
    const result = outcomeResult(request, rule?.outcome ?? "accepted", rule?.evidenceRefs ?? [`reports/wheel-zob/fake/${request.attemptId}.json`]);
    const postureIssues = validateDispatchResultPosture(result, authority);
    if (postureIssues.length > 0) throw new Error(`fake dispatch posture violation: ${postureIssues.join("; ")}`);
    return result;
  }
}
