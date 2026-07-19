import { sha256Text } from "./canonical.js";
import type {
  WheelStoryEffectKind,
  WheelStoryEffectRequest,
  WheelStoryExternalSnapshot,
  WheelSupervisorPullRequest,
} from "./types.js";

export interface WheelFakeEffectMutableState {
  storyHeads: Map<string, string>;
  remoteHeads: Map<string, string>;
  branchOwners: Map<string, string>;
}

export interface WheelFakeEffectApplication {
  syntheticHeadSha: string;
  syntheticPullRequestId?: string;
  syntheticCheckId?: string;
}

function syntheticNumber(hash: string): number {
  return Number.parseInt(hash.slice(0, 8), 16) % 900_000 + 100_000;
}

export function applyDeterministicFakeWheelEffect(
  request: WheelStoryEffectRequest,
  snapshot: WheelStoryExternalSnapshot,
  state: WheelFakeEffectMutableState,
): WheelFakeEffectApplication {
  const generatedHeadSha = sha256Text(`fake-head:${request.requestHash}`).slice(0, 40);
  const syntheticHeadSha = request.kind === "create-workspace"
    ? request.expectedBaseSha
    : request.kind === "create-branch"
      ? request.expectedHeadSha ?? request.expectedBaseSha
      : request.kind === "bootstrap-commit" || request.kind === "commit-accepted-candidate"
        ? generatedHeadSha
        : request.expectedHeadSha ?? generatedHeadSha;
  const branchKey = `${request.repositoryId}:${request.branchName}`;
  let syntheticPullRequestId: string | undefined;
  let syntheticCheckId: string | undefined;
  const handlers: Record<WheelStoryEffectKind, () => void> = {
    "create-workspace": () => {
      state.storyHeads.set(request.storyId, syntheticHeadSha);
    },
    "create-branch": () => {
      state.branchOwners.set(branchKey, request.storyId);
      state.storyHeads.set(request.storyId, syntheticHeadSha);
    },
    "bootstrap-commit": () => {
      state.storyHeads.set(request.storyId, syntheticHeadSha);
    },
    "commit-accepted-candidate": () => {
      state.storyHeads.set(request.storyId, syntheticHeadSha);
    },
    "push-accepted-commit": () => {
      state.storyHeads.set(request.storyId, syntheticHeadSha);
      state.remoteHeads.set(request.storyId, syntheticHeadSha);
      if (snapshot.pullRequest) snapshot.pullRequest.headSha = syntheticHeadSha;
    },
    "create-draft-pr": () => {
      if (snapshot.pullRequest && snapshot.pullRequest.state === "open") throw new Error(`${request.storyId} already has an open fake pull request`);
      syntheticPullRequestId = `fake-pr-${request.requestHash.slice(0, 16)}`;
      const pullRequest: WheelSupervisorPullRequest = {
        pullRequestId: syntheticPullRequestId,
        number: syntheticNumber(request.requestHash),
        state: "open",
        isDraft: true,
        headRef: request.branchName,
        headSha: request.expectedHeadSha ?? syntheticHeadSha,
        baseRef: request.baseRef,
        baseSha: request.expectedBaseSha,
        checkIds: [],
        commentIds: [],
        labels: [],
        bodyStored: false,
      };
      snapshot.pullRequest = pullRequest;
    },
    "post-check": () => {
      if (!snapshot.pullRequest) throw new Error("post-check requires an open fake pull request");
      const checkName = request.metadata.checkName;
      const issuerHash = request.metadata.issuerHash;
      if (!checkName || !/^[a-f0-9]{64}$/.test(issuerHash ?? "")) throw new Error("post-check requires checkName and a full issuerHash");
      syntheticCheckId = `fake-check-${request.requestHash.slice(0, 16)}`;
      snapshot.checks = [...snapshot.checks, {
        checkId: syntheticCheckId,
        name: checkName,
        headSha: request.expectedHeadSha ?? snapshot.pullRequest.headSha,
        issuerHash,
        status: "completed",
        conclusion: "success",
      }];
      snapshot.pullRequest.checkIds = [...snapshot.pullRequest.checkIds, syntheticCheckId];
    },
    "post-comment": () => {
      if (!snapshot.pullRequest) throw new Error("post-comment requires an open fake pull request");
      snapshot.pullRequest.commentIds = [...snapshot.pullRequest.commentIds, `fake-comment-${request.requestHash.slice(0, 16)}`];
    },
    "project-label": () => {
      if (!snapshot.pullRequest) throw new Error("project-label requires an open fake pull request");
      const label = request.metadata.label;
      if (!label) throw new Error("project-label requires label metadata");
      snapshot.pullRequest.labels = [...new Set([...snapshot.pullRequest.labels, label])];
    },
    "observe-pr": () => undefined,
    "observe-ci": () => undefined,
  };
  const handler = handlers[request.kind];
  if (!handler) throw new Error(`unsupported fake story effect ${request.kind}`);
  handler();
  return { syntheticHeadSha, syntheticPullRequestId, syntheticCheckId };
}
