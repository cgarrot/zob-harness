import { sha256Canonical, sha256Text } from "./canonical.js";
import { validateEffectResultPosture, validateWheelSupervisorAuthority } from "./contracts.js";
import { applyDeterministicFakeWheelEffect } from "./deterministic-fake-effect-application.js";
import type {
  WheelStoryEffectBroker,
  WheelStoryEffectRequest,
  WheelStoryEffectResult,
  WheelStoryExternalSnapshot,
  WheelSupervisorAuthority,
  WheelSupervisorPullRequest,
} from "./types.js";

function requestHashInput(request: Omit<WheelStoryEffectRequest, "requestHash"> | WheelStoryEffectRequest) {
  const { requestHash: _requestHash, ...input } = request as WheelStoryEffectRequest;
  return input;
}

export function computeWheelStoryEffectRequestHash(
  request: Omit<WheelStoryEffectRequest, "requestHash"> | WheelStoryEffectRequest,
): string {
  return sha256Canonical(requestHashInput(request));
}

function emptySnapshot(storyId: string): WheelStoryExternalSnapshot {
  return {
    schema: "wheel.zob.story-external-snapshot.v1",
    source: "fake",
    repositoryId: "disabled",
    storyId,
    checks: [],
    latestReviews: [],
    observedAt: "1970-01-01T00:00:00.000Z",
    networkAccessed: false,
    bodyStored: false,
  };
}

export class DisabledWheelStoryEffectBroker implements WheelStoryEffectBroker {
  readonly mode = "disabled" as const;

  async submit(request: WheelStoryEffectRequest, authority: WheelSupervisorAuthority): Promise<WheelStoryEffectResult> {
    const issues = validateWheelSupervisorAuthority(authority);
    if (issues.length > 0) throw new Error(`invalid effect authority: ${issues.join("; ")}`);
    if (authority.mode !== "disabled") throw new Error("disabled effect broker requires disabled authority");
    return {
      schema: "wheel.zob.story-effect-result.v1",
      requestId: request.requestId,
      requestHash: request.requestHash,
      idempotencyKey: request.idempotencyKey,
      mode: "disabled",
      status: "blocked-disabled",
      reasonCodes: ["effects-disabled"],
      externalEffectPerformed: false,
      localRepositoryWritePerformed: false,
      networkAccessed: false,
      credentialsAccessed: false,
      bodyStored: false,
    };
  }

  async observe(storyId: string, authority: WheelSupervisorAuthority): Promise<WheelStoryExternalSnapshot> {
    const issues = validateWheelSupervisorAuthority(authority);
    if (issues.length > 0 || authority.mode !== "disabled") throw new Error("disabled observation requires valid disabled authority");
    return emptySnapshot(storyId);
  }
}

interface FakeEffectRecord {
  requestHash: string;
  result: WheelStoryEffectResult;
}

export class DeterministicFakeWheelStoryEffectBroker implements WheelStoryEffectBroker {
  readonly mode = "deterministic-fake" as const;
  private readonly effects = new Map<string, FakeEffectRecord>();
  private readonly snapshots = new Map<string, WheelStoryExternalSnapshot>();
  private readonly storyHeads = new Map<string, string>();
  private readonly remoteHeads = new Map<string, string>();
  private readonly branchOwners = new Map<string, string>();

  private snapshot(request: WheelStoryEffectRequest): WheelStoryExternalSnapshot {
    const existing = this.snapshots.get(request.storyId);
    if (existing) return existing;
    const reconstructedPullRequest: WheelSupervisorPullRequest | undefined = request.expectedPullRequestId ? {
      pullRequestId: request.expectedPullRequestId,
      state: "open",
      isDraft: true,
      headRef: request.branchName,
      headSha: request.expectedHeadSha ?? sha256Text(`fake-restored-head:${request.requestHash}`).slice(0, 40),
      baseRef: request.baseRef,
      baseSha: request.expectedBaseSha,
      checkIds: [],
      commentIds: [],
      labels: [],
      bodyStored: false,
    } : undefined;
    const created: WheelStoryExternalSnapshot = {
      schema: "wheel.zob.story-external-snapshot.v1",
      source: "fake",
      repositoryId: request.repositoryId,
      storyId: request.storyId,
      pullRequest: reconstructedPullRequest,
      checks: [],
      latestReviews: [],
      observedAt: "2026-07-19T00:00:00.000Z",
      networkAccessed: false,
      bodyStored: false,
    };
    this.snapshots.set(request.storyId, created);
    return created;
  }

  async submit(request: WheelStoryEffectRequest, authority: WheelSupervisorAuthority): Promise<WheelStoryEffectResult> {
    this.assertRequest(request, authority);
    const replay = this.replayedResult(request);
    if (replay) return replay;

    const snapshot = this.snapshot(request);
    const precondition = this.preconditionOutcome(request, snapshot);
    if (precondition) return this.recordResult(request, precondition, authority);

    const { syntheticHeadSha, syntheticPullRequestId, syntheticCheckId } = applyDeterministicFakeWheelEffect(
      request,
      snapshot,
      {
        storyHeads: this.storyHeads,
        remoteHeads: this.remoteHeads,
        branchOwners: this.branchOwners,
      },
    );
    snapshot.observedAt = request.metadata.observedAt ?? "2026-07-19T00:00:00.000Z";
    this.snapshots.set(request.storyId, snapshot);
    const result: WheelStoryEffectResult = {
      schema: "wheel.zob.story-effect-result.v1",
      requestId: request.requestId,
      requestHash: request.requestHash,
      idempotencyKey: request.idempotencyKey,
      mode: "deterministic-fake",
      status: "simulated",
      observationRef: `fake://wheel-zob/${request.storyId}/${request.kind}/${request.requestHash.slice(0, 16)}`,
      syntheticHeadSha,
      syntheticPullRequestId,
      syntheticCheckId,
      reasonCodes: [],
      externalEffectPerformed: false,
      localRepositoryWritePerformed: false,
      networkAccessed: false,
      credentialsAccessed: false,
      bodyStored: false,
    };
    const postureIssues = validateEffectResultPosture(result, authority);
    if (postureIssues.length > 0) throw new Error(`fake effect posture violation: ${postureIssues.join("; ")}`);
    this.effects.set(request.idempotencyKey, { requestHash: request.requestHash, result: structuredClone(result) });
    return result;
  }

  private assertRequest(request: WheelStoryEffectRequest, authority: WheelSupervisorAuthority): void {
    this.assertAuthority(authority);
    this.assertRequestContract(request);
    this.assertRequestBase(request);
    this.assertRequestHash(request);
  }

  private assertAuthority(authority: WheelSupervisorAuthority): void {
    const authorityIssues = validateWheelSupervisorAuthority(authority);
    if (authorityIssues.length > 0) throw new Error(`invalid effect authority: ${authorityIssues.join("; ")}`);
    if (authority.mode !== "deterministic-fake") throw new Error("fake effect broker requires deterministic-fake authority");
  }

  private assertRequestContract(request: WheelStoryEffectRequest): void {
    if (request.schema !== "wheel.zob.story-effect-request.v1" || request.bodyStored !== false) throw new Error("effect request contract is invalid");
  }

  private assertRequestBase(request: WheelStoryEffectRequest): void {
    if (request.baseRef !== "develop-staging") throw new Error("story effects require develop-staging");
  }

  private assertRequestHash(request: WheelStoryEffectRequest): void {
    if (computeWheelStoryEffectRequestHash(request) !== request.requestHash) throw new Error("effect requestHash mismatch");
  }

  private replayedResult(request: WheelStoryEffectRequest): WheelStoryEffectResult | undefined {
    const prior = this.effects.get(request.idempotencyKey);
    if (!prior) return undefined;
    if (prior.requestHash !== request.requestHash) throw new Error(`effect idempotency conflict for ${request.idempotencyKey}`);
    return { ...structuredClone(prior.result), status: "replayed" };
  }

  private preconditionOutcome(
    request: WheelStoryEffectRequest,
    snapshot: WheelStoryExternalSnapshot,
  ): Pick<WheelStoryEffectResult, "status" | "reasonCodes"> | undefined {
    return this.headPrecondition(request)
      ?? this.pullRequestPrecondition(request, snapshot)
      ?? this.remoteHeadPrecondition(request)
      ?? this.branchPrecondition(request);
  }

  private headPrecondition(request: WheelStoryEffectRequest): Pick<WheelStoryEffectResult, "status" | "reasonCodes"> | undefined {
    const knownHead = this.storyHeads.get(request.storyId);
    if (knownHead && request.expectedHeadSha && knownHead !== request.expectedHeadSha) {
      return { status: "precondition-failed", reasonCodes: ["stale-head"] };
    }
    if (!knownHead && request.expectedHeadSha) this.storyHeads.set(request.storyId, request.expectedHeadSha);
    return undefined;
  }

  private pullRequestPrecondition(
    request: WheelStoryEffectRequest,
    snapshot: WheelStoryExternalSnapshot,
  ): Pick<WheelStoryEffectResult, "status" | "reasonCodes"> | undefined {
    if (request.expectedPullRequestId && snapshot.pullRequest?.pullRequestId !== request.expectedPullRequestId) {
      return { status: "precondition-failed", reasonCodes: ["pull-request-identity-mismatch"] };
    }
    return undefined;
  }

  private remoteHeadPrecondition(request: WheelStoryEffectRequest): Pick<WheelStoryEffectResult, "status" | "reasonCodes"> | undefined {
    const knownRemoteHead = this.remoteHeads.get(request.storyId);
    if (request.expectedRemoteHeadSha && knownRemoteHead && knownRemoteHead !== request.expectedRemoteHeadSha) {
      return { status: "precondition-failed", reasonCodes: ["remote-head-mismatch"] };
    }
    if (!knownRemoteHead && request.expectedRemoteHeadSha) this.remoteHeads.set(request.storyId, request.expectedRemoteHeadSha);
    return undefined;
  }

  private branchPrecondition(request: WheelStoryEffectRequest): Pick<WheelStoryEffectResult, "status" | "reasonCodes"> | undefined {
    const branchOwner = this.branchOwners.get(`${request.repositoryId}:${request.branchName}`);
    if (request.kind === "create-branch" && branchOwner && branchOwner !== request.storyId) {
      return { status: "policy-denied", reasonCodes: ["branch-owned-by-another-story"] };
    }
    return undefined;
  }

  private recordResult(
    request: WheelStoryEffectRequest,
    outcome: Pick<WheelStoryEffectResult, "status" | "reasonCodes">,
    authority: WheelSupervisorAuthority,
  ): WheelStoryEffectResult {
    const result: WheelStoryEffectResult = {
      schema: "wheel.zob.story-effect-result.v1",
      requestId: request.requestId,
      requestHash: request.requestHash,
      idempotencyKey: request.idempotencyKey,
      mode: "deterministic-fake",
      status: outcome.status,
      reasonCodes: outcome.reasonCodes,
      externalEffectPerformed: false,
      localRepositoryWritePerformed: false,
      networkAccessed: false,
      credentialsAccessed: false,
      bodyStored: false,
    };
    const postureIssues = validateEffectResultPosture(result, authority);
    if (postureIssues.length > 0) throw new Error(`fake effect posture violation: ${postureIssues.join("; ")}`);
    this.effects.set(request.idempotencyKey, { requestHash: request.requestHash, result: structuredClone(result) });
    return result;
  }

  async observe(storyId: string, authority: WheelSupervisorAuthority): Promise<WheelStoryExternalSnapshot> {
    const issues = validateWheelSupervisorAuthority(authority);
    if (issues.length > 0 || authority.mode !== "deterministic-fake") throw new Error("fake observation requires valid deterministic-fake authority");
    return structuredClone(this.snapshots.get(storyId) ?? emptySnapshot(storyId));
  }
}
