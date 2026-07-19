import { sha256Canonical, sha256Text } from "./canonical.js";
import { validateEffectResultPosture, validateWheelSupervisorAuthority } from "./contracts.js";
import { settleWheelSupervisorMission } from "./mission-settlement.js";
export { admitWheelSupervisorMission } from "./mission-admission-store.js";
import { buildWheelPrCloseEvidence, validateWheelPrCloseEvidence, validateWheelPrCloseTerminal } from "./pr-close.js";
import { buildWheelStoryEffectRequest } from "./requests.js";
import { runWheelSupervisorRole, type WheelRoleRunResult } from "./role-runner.js";
import {
  selectWheelRunnableStories,
  wheelStoryCompletionSummary,
} from "./scheduler.js";
import { FileWheelSupervisorStore } from "./store.js";
import { advanceWheelStoryReadiness } from "./story-readiness.js";
import { runWheelStoryStage } from "./story-stage-router.js";
import type {
  WheelEvidenceKind,
  WheelStoryEffectKind,
  WheelStoryEffectResult,
  WheelStoryExternalSnapshot,
  WheelSupervisorAdapters,
  WheelSupervisorAuthority,
  WheelSupervisorEventKind,
  WheelSupervisorMissionState,
  WheelSupervisorPullRequest,
  WheelSupervisorRole,
  WheelSupervisorStoryStage,
  WheelSupervisorStoryState,
  WheelSupervisorTickResult,
  WheelSupervisorWorkspace,
} from "./types.js";

export interface WheelSupervisorRunResult extends WheelSupervisorTickResult {
  ticks: number;
  settled: boolean;
}

function mutationId(prefix: string, input: unknown): string {
  return `${prefix}-${sha256Canonical(input).slice(0, 24)}`;
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

function pullRequestFromStory(story: WheelSupervisorStoryState): WheelSupervisorPullRequest {
  if (!story.pullRequest) throw new Error(`${story.storyId}: pull request is missing`);
  return structuredClone(story.pullRequest);
}

type WheelRoleRunDisposition = "accepted" | "retry" | "blocked" | "no-progress";

function roleRunDisposition(run: WheelRoleRunResult): WheelRoleRunDisposition {
  if (!run.progressed) return "no-progress";
  if (run.accepted && run.result?.outputHash) return "accepted";
  if (run.blocked || run.exhausted) return "blocked";
  return "retry";
}

function mergeExternalSnapshot(
  prior: WheelStoryExternalSnapshot | undefined,
  observed: WheelStoryExternalSnapshot,
): WheelStoryExternalSnapshot {
  if (!prior) return observed;
  const checks = new Map([...prior.checks, ...observed.checks].map((check) => [check.checkId, check]));
  const reviews = new Map([...prior.latestReviews, ...observed.latestReviews].map((review) => [review.reviewId, review]));
  return {
    ...observed,
    pullRequest: observed.pullRequest ?? prior.pullRequest,
    checks: [...checks.values()],
    latestReviews: [...reviews.values()],
    bodyStored: false,
  };
}

export class WheelFleetSupervisor {
  constructor(
    readonly store: FileWheelSupervisorStore,
    readonly authority: WheelSupervisorAuthority,
    readonly adapters: WheelSupervisorAdapters,
    readonly clock: () => Date = () => new Date(),
  ) {
    const issues = validateWheelSupervisorAuthority(authority);
    if (issues.length > 0) throw new Error(`invalid supervisor authority: ${issues.join("; ")}`);
    if (authority.mode !== adapters.dispatch.mode || authority.mode !== adapters.effects.mode) {
      throw new Error("supervisor authority and adapter modes must match");
    }
    if (authority.mode === "live") throw new Error("live supervisor activation is not implemented; use disabled or deterministic-fake mode");
  }

  load(): WheelSupervisorMissionState {
    const state = this.store.load();
    if (!state) throw new Error("supervisor mission is not admitted");
    if (state.authorityHash !== sha256Canonical(this.authority)) throw new Error("supervisor authority hash changed after admission");
    return state;
  }

  takeOwnership(ownerId: string, leaseMs = 5 * 60 * 1000): WheelSupervisorMissionState {
    const before = this.load();
    const ownerIdHash = sha256Text(ownerId);
    const receipt = this.store.acquireOwnership({
      missionId: before.missionId,
      ownerIdHash,
      now: nowIso(this.clock),
      leaseMs,
    });
    if (receipt.ownershipEpoch === before.ownershipEpoch && before.ownerIdHash === ownerIdHash) return before;
    return this.commit("ownership-taken", { ownerIdHash }, undefined, receipt.ownershipEpoch).state;
  }

  start(): WheelSupervisorMissionState {
    const state = this.load();
    if (state.status === "running") return state;
    if (state.status === "complete" || state.status === "failed") throw new Error(`cannot start terminal mission ${state.status}`);
    const kind: WheelSupervisorEventKind = state.status === "admitted" ? "mission-started" : "mission-resumed";
    return this.commit(kind, {}, undefined, state.ownershipEpoch).state;
  }

  pause(reasonCode: string): WheelSupervisorMissionState {
    const state = this.load();
    if (state.status !== "running") return state;
    return this.commit("mission-paused", { reasonCode }, undefined, state.ownershipEpoch).state;
  }

  resolveHumanGate(storyId: string, receiptHash: string): WheelSupervisorMissionState {
    if (!/^[a-f0-9]{64}$/.test(receiptHash)) throw new Error("human gate receiptHash must be a full sha256");
    const state = this.load();
    const story = state.stories[storyId];
    if (!story || story.stage !== "needs-human") throw new Error(`${storyId}: story is not waiting for human resolution`);
    return this.commit("human-gate-resolved", { receiptHash }, storyId, state.ownershipEpoch).state;
  }

  async tick(): Promise<WheelSupervisorTickResult> {
    let state = this.load();
    if (this.authority.mode === "disabled") return this.tickResult(state, []);
    if (state.status === "admitted") state = this.start();
    if (state.status === "paused" || state.status === "complete" || state.status === "failed") return this.tickResult(state, []);

    const readiness = advanceWheelStoryReadiness(state, {
      block: (storyId, blockerCodes) => this.commit("story-blocked", { blockerCodes }, storyId, state.ownershipEpoch).state,
      changeStage: (storyId, stage) => this.changeStage(storyId, stage),
    });
    state = readiness.state;
    let progressed = readiness.progressed;
    const processedStoryIds = [...readiness.processedStoryIds];

    const runnableResult = await this.processRunnableStories(state);
    if (runnableResult.progressed) progressed = true;
    processedStoryIds.push(...runnableResult.processedStoryIds);

    const settlement = settleWheelSupervisorMission(this.load(), progressed, (kind, payload, ownershipEpoch) =>
      this.commit(kind, payload, undefined, ownershipEpoch).state);
    state = settlement.state;
    progressed = settlement.progressed;
    return this.tickResult(state, progressed ? [...new Set(processedStoryIds)] : []);
  }

  async runUntilSettled(maxTicks = 10_000): Promise<WheelSupervisorRunResult> {
    if (!Number.isSafeInteger(maxTicks) || maxTicks <= 0) throw new Error("maxTicks must be a positive safe integer");
    let result = await this.tick();
    let ticks = 1;
    while (ticks < maxTicks && result.progressedStoryIds.length > 0 && !["complete", "failed", "needs-human", "paused"].includes(result.status)) {
      result = await this.tick();
      ticks += 1;
    }
    return {
      ...result,
      ticks,
      settled: ["complete", "failed", "needs-human", "paused"].includes(result.status) || result.progressedStoryIds.length === 0,
    };
  }

  private async processRunnableStories(state: WheelSupervisorMissionState): Promise<{ progressed: boolean; processedStoryIds: string[] }> {
    let progressed = false;
    const processedStoryIds: string[] = [];
    for (const selected of selectWheelRunnableStories(state)) {
      const fresh = this.load().stories[selected.storyId];
      if (!fresh) continue;
      const didProgress = await this.processStory(fresh);
      if (didProgress) {
        progressed = true;
        processedStoryIds.push(fresh.storyId);
      }
    }
    return { progressed, processedStoryIds };
  }

  private tickResult(state: WheelSupervisorMissionState, progressedStoryIds: string[]): WheelSupervisorTickResult {
    const summary = wheelStoryCompletionSummary(state);
    const dependencyBlocked = summary.pending.filter((storyId) => state.noShipReasons.includes(`story:${storyId}:dependency-blocked`));
    return {
      schema: "wheel.zob.supervisor-tick-result.v1",
      missionId: state.missionId,
      progressedStoryIds,
      blockedStoryIds: [...summary.needsHuman, ...summary.failed, ...dependencyBlocked],
      completedStoryIds: summary.complete,
      pendingStoryIds: summary.pending.filter((storyId) => !dependencyBlocked.includes(storyId)),
      eventCount: state.journalSequence,
      status: state.status,
      externalEffectsPerformed: false,
      providerCallsPerformed: false,
      bodyStored: false,
    };
  }

  private commit(
    kind: WheelSupervisorEventKind,
    payload: Record<string, unknown>,
    storyId?: string,
    ownershipEpoch?: number,
  ) {
    const state = this.load();
    const mutation = mutationId(kind, {
      missionId: state.missionId,
      storyId,
      sequence: state.journalSequence + 1,
      kind,
      payload,
      ownershipEpoch: ownershipEpoch ?? state.ownershipEpoch,
    });
    return this.store.commit({
      mutationId: mutation,
      kind,
      storyId,
      payload,
      occurredAt: nowIso(this.clock),
      ownershipEpoch: ownershipEpoch ?? state.ownershipEpoch,
    });
  }

  private changeStage(storyId: string, to: WheelSupervisorStoryStage, blockerCodes: string[] = []): WheelSupervisorMissionState {
    return this.commit("story-stage-changed", { to, blockerCodes }, storyId).state;
  }

  private async processStory(story: WheelSupervisorStoryState): Promise<boolean> {
    return runWheelStoryStage(story, {
      changeStage: (storyId, to) => {
        this.changeStage(storyId, to);
      },
      provisionWorkspace: (target) => this.provisionWorkspace(target),
      bootstrapWorkspace: (target) => this.bootstrapWorkspace(target),
      openDraftPullRequest: (target) => this.openDraftPullRequest(target),
      runDevelopment: (target, repair) => this.runDevelopment(target, repair),
      runDocumentation: (target) => this.runDocumentation(target),
      runQa: (target) => this.runQa(target),
      runReviewRole: (target, role, nextStage) => this.runReviewRole(target, role, nextStage),
      runRepair: (target) => this.runRepair(target),
      runDraftCi: (target) => this.runDraftCi(target),
      runAudit: (target, role, nextStage, evidenceKind) => this.runAudit(target, role, nextStage, evidenceKind),
      finalizePrClose: (target) => this.finalizePrClose(target),
      publishPrCloseCheck: (target) => this.publishPrCloseCheck(target),
    });
  }

  private async provisionWorkspace(story: WheelSupervisorStoryState): Promise<boolean> {
    await this.effect(story, "create-workspace");
    const branch = await this.effect(this.load().stories[story.storyId] as WheelSupervisorStoryState, "create-branch");
    if (branch.status !== "simulated" && branch.status !== "performed" && branch.status !== "replayed") return this.blockStory(story.storyId, ["workspace-effect-blocked"]);
    const fresh = this.load();
    const current = fresh.stories[story.storyId] as WheelSupervisorStoryState;
    const headSha = branch.syntheticHeadSha ?? fresh.sourceSha;
    const workspace: WheelSupervisorWorkspace = {
      workspaceId: `workspace-${sha256Text(`${fresh.missionId}:${story.storyId}`).slice(0, 16)}`,
      workspacePathHash: sha256Text(`workspace-path:${fresh.missionId}:${story.storyId}`),
      branchName: current.branchContract.branchName,
      baseRef: "develop-staging",
      baseSha: fresh.sourceSha,
      headSha,
      rollbackRef: `reports/wheel-zob/supervisor/${fresh.missionId}/${story.storyId}/rollback.json`,
      claimId: `claim-${sha256Text(`${fresh.missionId}:${story.storyId}:workspace`).slice(0, 16)}`,
      clean: true,
      bodyStored: false,
    };
    this.commit("workspace-recorded", { workspace }, story.storyId);
    this.changeStage(story.storyId, "workspace-ready");
    return true;
  }

  private async bootstrapWorkspace(story: WheelSupervisorStoryState): Promise<boolean> {
    const result = await this.effect(story, "bootstrap-commit");
    if (!result.syntheticHeadSha) return this.blockStory(story.storyId, ["bootstrap-effect-blocked"]);
    this.commit("story-head-changed", { headSha: result.syntheticHeadSha, reasonCode: "bootstrap-commit" }, story.storyId);
    await this.effect(this.load().stories[story.storyId] as WheelSupervisorStoryState, "push-accepted-commit");
    this.changeStage(story.storyId, "bootstrap-ready");
    return true;
  }

  private async openDraftPullRequest(story: WheelSupervisorStoryState): Promise<boolean> {
    const current = this.load().stories[story.storyId] as WheelSupervisorStoryState;
    const result = await this.effect(current, "create-draft-pr");
    if (!result.syntheticPullRequestId || !current.workspace?.headSha) return this.blockStory(story.storyId, ["draft-pr-effect-blocked"]);
    const pullRequest: WheelSupervisorPullRequest = {
      pullRequestId: result.syntheticPullRequestId,
      state: "open",
      isDraft: true,
      headRef: current.workspace.branchName,
      headSha: current.workspace.headSha,
      baseRef: "develop-staging",
      baseSha: current.workspace.baseSha,
      checkIds: [],
      commentIds: [],
      labels: [],
      bodyStored: false,
    };
    this.commit("pull-request-recorded", { pullRequest }, story.storyId);
    this.changeStage(story.storyId, "draft-pr-open");
    return true;
  }

  private async runDevelopment(story: WheelSupervisorStoryState, repair: boolean): Promise<boolean> {
    const run = await this.runRole(story.storyId, "development");
    const disposition = roleRunDisposition(run);
    if (disposition === "no-progress") return this.blockStory(story.storyId, ["development-attempt-budget-exhausted"]);
    if (disposition === "blocked") return this.blockStory(story.storyId, ["development-needs-human"]);
    if (disposition === "retry") return true;
    return this.applyAcceptedDevelopment(story, repair, run);
  }

  private async applyAcceptedDevelopment(
    story: WheelSupervisorStoryState,
    repair: boolean,
    run: WheelRoleRunResult,
  ): Promise<boolean> {
    const outputHash = run.result?.outputHash as string;
    const current = this.load().stories[story.storyId] as WheelSupervisorStoryState;
    const commit = await this.effect(current, "commit-accepted-candidate", { outputHash });
    if (!commit.syntheticHeadSha) return this.blockStory(story.storyId, ["accepted-commit-effect-blocked"]);
    this.commit("story-head-changed", { headSha: commit.syntheticHeadSha, reasonCode: repair ? "repair-accepted" : "development-accepted" }, story.storyId);
    const afterHead = this.load().stories[story.storyId] as WheelSupervisorStoryState;
    const push = await this.effect(afterHead, "push-accepted-commit", { outputHash });
    if (!push.syntheticHeadSha) return this.blockStory(story.storyId, ["accepted-push-effect-blocked"]);
    this.recordPushedPullRequest(story.storyId, push.syntheticHeadSha);
    this.recordEvidence(story.storyId, "build", outputHash, run.result?.evidenceRefs ?? []);
    const docsRequired = afterHead.routeAssignments.find((assignment) => assignment.role === "documentation")?.required === true;
    this.changeStage(story.storyId, docsRequired ? "documentation" : "qa");
    return true;
  }

  private recordPushedPullRequest(storyId: string, headSha: string): void {
    const story = this.load().stories[storyId] as WheelSupervisorStoryState;
    if (!story.pullRequest) return;
    const pullRequest = pullRequestFromStory(story);
    pullRequest.headSha = headSha;
    this.commit("pull-request-recorded", { pullRequest }, storyId);
  }

  private async runDocumentation(story: WheelSupervisorStoryState): Promise<boolean> {
    const assignment = story.routeAssignments.find((candidate) => candidate.role === "documentation");
    if (!assignment?.required) {
      this.changeStage(story.storyId, "qa");
      return true;
    }
    const run = await this.runRole(story.storyId, "documentation");
    const disposition = roleRunDisposition(run);
    if (disposition === "accepted") {
      this.recordEvidence(story.storyId, "documentation", run.result?.outputHash as string, run.result?.evidenceRefs ?? []);
      this.changeStage(story.storyId, "qa");
      return true;
    }
    if (disposition === "blocked" || disposition === "no-progress") return this.blockStory(story.storyId, ["documentation-needs-human"]);
    return true;
  }

  private async runQa(story: WheelSupervisorStoryState): Promise<boolean> {
    const run = await this.runRole(story.storyId, "qa");
    if (run.accepted && run.result?.outputHash) {
      this.recordEvidence(story.storyId, "qa", run.result.outputHash, run.result.evidenceRefs);
      this.changeStage(story.storyId, "internal-review");
      return true;
    }
    if (run.blocked || run.exhausted || !run.progressed) return this.blockStory(story.storyId, ["qa-needs-human"]);
    this.changeStage(story.storyId, "repair");
    return true;
  }

  private async runReviewRole(
    story: WheelSupervisorStoryState,
    role: "internal-review" | "formal-blind-review" | "repository-assurance",
    nextStage: WheelSupervisorStoryStage,
  ): Promise<boolean> {
    const run = await this.runRole(story.storyId, role);
    if (run.accepted && run.result?.outputHash) {
      this.recordEvidence(story.storyId, "review", run.result.outputHash, run.result.evidenceRefs);
      this.changeStage(story.storyId, nextStage);
      return true;
    }
    if (run.blocked || run.exhausted || !run.progressed) return this.blockStory(story.storyId, [`${role}-needs-human`]);
    this.changeStage(story.storyId, "repair");
    return true;
  }

  private async runRepair(story: WheelSupervisorStoryState): Promise<boolean> {
    if (story.repairRound >= this.load().budgetPolicy.maxRepairRoundsPerStory) return this.blockStory(story.storyId, ["repair-round-budget-exhausted"]);
    this.commit("story-repair-round", { repairRound: story.repairRound + 1 }, story.storyId);
    return this.runDevelopment(this.load().stories[story.storyId] as WheelSupervisorStoryState, true);
  }

  private async runDraftCi(story: WheelSupervisorStoryState): Promise<boolean> {
    const checkIds: string[] = [];
    const observationRefs: string[] = [];
    for (const required of this.load().checkPolicy.requiredCiChecks) {
      const result = await this.effect(this.load().stories[story.storyId] as WheelSupervisorStoryState, "post-check", {
        checkName: required.name,
        issuerHash: required.issuerHash,
      });
      if (!result.syntheticCheckId) return this.blockStory(story.storyId, ["ci-observation-blocked"]);
      checkIds.push(result.syntheticCheckId);
      if (result.observationRef) observationRefs.push(result.observationRef);
    }
    const observed = await this.adapters.effects.observe(story.storyId, this.authority);
    const mergedSnapshot = mergeExternalSnapshot(this.load().stories[story.storyId]?.externalSnapshot, observed);
    this.commit("external-snapshot-recorded", { snapshot: mergedSnapshot }, story.storyId);
    const pullRequest = pullRequestFromStory(this.load().stories[story.storyId] as WheelSupervisorStoryState);
    pullRequest.checkIds = [...new Set([...pullRequest.checkIds, ...checkIds])];
    this.commit("pull-request-recorded", { pullRequest }, story.storyId);
    this.recordEvidence(story.storyId, "ci", sha256Canonical(checkIds), observationRefs);
    this.changeStage(story.storyId, "pr-close-source-audit");
    return true;
  }

  private async runAudit(
    story: WheelSupervisorStoryState,
    role: "pr-close-source-audit" | "pr-close-evidence-audit",
    nextStage: WheelSupervisorStoryStage,
    evidenceKind: WheelEvidenceKind,
  ): Promise<boolean> {
    const run = await this.runRole(story.storyId, role);
    if (run.accepted && run.result?.outputHash) {
      this.recordEvidence(story.storyId, evidenceKind, run.result.outputHash, run.result.evidenceRefs);
      this.changeStage(story.storyId, nextStage);
      return true;
    }
    if (run.blocked || run.exhausted || !run.progressed) return this.blockStory(story.storyId, [`${role}-needs-human`]);
    this.changeStage(story.storyId, "repair");
    return true;
  }

  private async finalizePrClose(story: WheelSupervisorStoryState): Promise<boolean> {
    const run = await this.runRole(story.storyId, "pr-close");
    if (!run.accepted || !run.result?.outputHash) {
      if (run.blocked || run.exhausted || !run.progressed) return this.blockStory(story.storyId, ["pr-close-finalizer-needs-human"]);
      this.changeStage(story.storyId, "repair");
      return true;
    }
    this.recordEvidence(story.storyId, "review", run.result.outputHash, run.result.evidenceRefs);
    const state = this.load();
    const current = state.stories[story.storyId] as WheelSupervisorStoryState;
    const evidence = buildWheelPrCloseEvidence(state, current);
    const issues = validateWheelPrCloseEvidence(evidence, state, current);
    if (issues.length > 0) return this.blockStory(story.storyId, ["pr-close-evidence-invalid", ...issues.map((issue) => `detail:${sha256Text(issue)}`)]);
    this.commit("pr-close-recorded", { prCloseEvidence: evidence }, story.storyId);
    this.changeStage(story.storyId, "pr-close-check");
    return true;
  }

  private async publishPrCloseCheck(story: WheelSupervisorStoryState): Promise<boolean> {
    const policy = this.load().checkPolicy;
    const check = await this.effect(story, "post-check", {
      checkName: policy.prCloseCheck.name,
      issuerHash: policy.prCloseCheck.issuerHash,
    }, story.prCloseEvidence?.evidenceHash);
    if (!check.syntheticCheckId) return this.blockStory(story.storyId, ["pr-close-check-blocked"]);
    const current = await this.recordPrCloseArtifacts(story, check.syntheticCheckId);
    const state = this.load();
    const terminalIssues = validateWheelPrCloseTerminal(state, current);
    if (terminalIssues.length > 0) return this.blockStory(story.storyId, ["pr-close-terminal-invalid", ...terminalIssues.map((issue) => `detail:${sha256Text(issue)}`)]);
    this.changeStage(story.storyId, "needs-review");
    return true;
  }

  private async recordPrCloseArtifacts(
    story: WheelSupervisorStoryState,
    checkId: string,
  ): Promise<WheelSupervisorStoryState> {
    const policy = this.load().checkPolicy;
    await this.effect(this.load().stories[story.storyId] as WheelSupervisorStoryState, "post-comment", {
      commentHash: story.prCloseEvidence?.evidenceHash ?? "",
    });
    await this.effect(this.load().stories[story.storyId] as WheelSupervisorStoryState, "project-label", {
      label: policy.completionLabel,
    });
    const observed = await this.adapters.effects.observe(story.storyId, this.authority);
    const mergedSnapshot = mergeExternalSnapshot(this.load().stories[story.storyId]?.externalSnapshot, observed);
    this.commit("external-snapshot-recorded", { snapshot: mergedSnapshot }, story.storyId);
    const pullRequest = pullRequestFromStory(this.load().stories[story.storyId] as WheelSupervisorStoryState);
    pullRequest.checkIds = [...new Set([...pullRequest.checkIds, checkId, ...(observed.pullRequest?.checkIds ?? [])])];
    pullRequest.commentIds = [...new Set([...pullRequest.commentIds, ...(observed.pullRequest?.commentIds ?? [])])];
    pullRequest.labels = [...new Set([...pullRequest.labels, ...(observed.pullRequest?.labels ?? [])])];
    this.commit("pull-request-recorded", { pullRequest }, story.storyId);
    return this.load().stories[story.storyId] as WheelSupervisorStoryState;
  }

  private async runRole(storyId: string, role: WheelSupervisorRole): Promise<WheelRoleRunResult> {
    return runWheelSupervisorRole({
      authority: this.authority,
      dispatch: this.adapters.dispatch,
      load: () => this.load(),
      commit: (kind, payload, targetStoryId) => {
        this.commit(kind, payload, targetStoryId);
      },
      now: () => nowIso(this.clock),
    }, storyId, role);
  }

  private async effect(
    story: WheelSupervisorStoryState,
    kind: WheelStoryEffectKind,
    metadata: Record<string, string> = {},
    payloadHash?: string,
  ): Promise<WheelStoryEffectResult> {
    const state = this.load();
    const current = state.stories[story.storyId] as WheelSupervisorStoryState;
    const request = buildWheelStoryEffectRequest({
      state,
      story: current,
      kind,
      mutationKey: `${current.stageRevision}-${sha256Canonical({ kind, metadata, payloadHash }).slice(0, 12)}`,
      metadata,
      payloadHash,
    });
    this.commit("effect-requested", { requestId: request.requestId }, story.storyId);
    const result = await this.adapters.effects.submit(request, this.authority);
    const postureIssues = validateEffectResultPosture(result, this.authority);
    if (postureIssues.length > 0) throw new Error(`effect result posture violation: ${postureIssues.join("; ")}`);
    this.commit("effect-completed", { requestId: request.requestId, result }, story.storyId);
    return result;
  }

  private recordEvidence(storyId: string, kind: WheelEvidenceKind, outputHash: string, refs: string[]): WheelSupervisorMissionState {
    const story = this.load().stories[storyId] as WheelSupervisorStoryState;
    const headSha = story.workspace?.headSha ?? this.load().sourceSha;
    const evidence = {
      evidenceId: `evidence-${sha256Canonical({ storyId, kind, headSha, outputHash }).slice(0, 24)}`,
      kind,
      headSha,
      status: "current" as const,
      artifactHash: outputHash,
      refs: [...new Set(refs.filter(Boolean))],
      bodyStored: false as const,
    };
    return this.commit("evidence-recorded", { evidence }, storyId).state;
  }

  private blockStory(storyId: string, blockerCodes: string[]): boolean {
    this.commit("story-blocked", { blockerCodes }, storyId);
    return true;
  }
}
