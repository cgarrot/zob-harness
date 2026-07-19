import { buildWheelThinkingControl } from "../factories/story-pr-close/mission-planner.js";
import { getWheelModelRoute } from "../model-policy/model-registry.js";
import { sha256Canonical, sha256Text } from "./canonical.js";
import { computeWheelStoryEffectRequestHash } from "./effects.js";
import type {
  WheelDispatchRequest,
  WheelStoryEffectKind,
  WheelStoryEffectRequest,
  WheelSupervisorAttempt,
  WheelSupervisorMissionState,
  WheelSupervisorRole,
  WheelSupervisorStoryState,
} from "./types.js";

function dispatchPrompt(story: WheelSupervisorStoryState, role: WheelSupervisorRole, qualityRung: "low" | "high", missionId: string): string {
  return [
    "WHEEL_ZOB_SUPERVISOR_TASK.v1",
    `Mission: ${missionId}`,
    `Story: ${story.storyId} revision ${story.revision}`,
    `Role: ${role}`,
    `Manifest: ${story.storyPath}`,
    `Manifest hash: ${story.manifestHash}`,
    `Quality rung: ${qualityRung}`,
    "Return typed evidence only; do not commit, push, mutate GitHub, merge, deploy, activate providers, or access secrets without separately validated live authority.",
  ].join("\n");
}

export function buildWheelDispatchRequestForAttempt(
  state: WheelSupervisorMissionState,
  story: WheelSupervisorStoryState,
  attempt: WheelSupervisorAttempt,
): WheelDispatchRequest {
  const assignment = story.routeAssignments.find((candidate) => candidate.role === attempt.role);
  const candidate = assignment?.candidates[attempt.candidateIndex];
  if (!assignment || !candidate || candidate.routeId !== attempt.routeId) throw new Error(`${story.storyId}:${attempt.role} attempt route binding is invalid`);
  const prompt = dispatchPrompt(story, attempt.role, attempt.qualityRung, state.missionId);
  if (sha256Text(prompt) !== attempt.promptHash) throw new Error(`${attempt.attemptId}: prompt binding changed`);
  return {
    schema: "wheel.zob.dispatch-request.v1",
    missionId: state.missionId,
    storyId: story.storyId,
    taskId: `${story.storyId}-${attempt.role}`,
    attemptId: attempt.attemptId,
    assignmentId: attempt.assignmentId,
    role: attempt.role,
    routeId: candidate.routeId,
    provider: candidate.provider,
    family: candidate.family,
    thinkingControl: attempt.thinkingControl,
    messageRoleFormat: candidate.messageRoleFormat,
    transientPromptBody: prompt,
    promptHash: attempt.promptHash,
    sourceBindings: {
      bundleHash: state.bundleHash,
      sourceSha: state.sourceSha,
      manifestHash: story.manifestHash,
      storyRevision: String(story.revision),
      stage: story.stage,
      candidateIndex: String(attempt.candidateIndex),
      qualityRung: attempt.qualityRung,
      attemptOrdinal: String(attempt.attemptOrdinal),
    },
    requiredTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    allowedPaths: [story.storyPath],
    forbiddenPaths: [".env", ".pi/sessions", ".pi/agent-sessions", "node_modules", "dist", "build"],
    timeoutMs: 30 * 60 * 1000,
    estimatedCostUsd: 0,
    idempotencyKey: attempt.attemptId,
  };
}

export function buildWheelAttemptAndRequest(input: {
  state: WheelSupervisorMissionState;
  story: WheelSupervisorStoryState;
  role: WheelSupervisorRole;
  candidateIndex: number;
  qualityRung: "low" | "high";
  now: string;
}): { attempt: WheelSupervisorAttempt; request: WheelDispatchRequest } {
  const assignment = input.story.routeAssignments.find((candidate) => candidate.role === input.role);
  const candidate = assignment?.candidates[input.candidateIndex];
  if (!assignment || !candidate) throw new Error(`${input.story.storyId}:${input.role} route candidate ${input.candidateIndex} is missing`);
  const route = getWheelModelRoute(candidate.routeId);
  if (!route) throw new Error(`route ${candidate.routeId} is not registered`);
  const attemptOrdinal = input.story.attempts.filter((attempt) => attempt.role === input.role).length + 1;
  const assignmentId = `${input.story.storyId}-${input.role}`;
  const attemptId = `attempt-${sha256Canonical({
    missionId: input.state.missionId,
    storyId: input.story.storyId,
    role: input.role,
    candidateIndex: input.candidateIndex,
    qualityRung: input.qualityRung,
    attemptOrdinal,
  }).slice(0, 24)}`;
  const prompt = dispatchPrompt(input.story, input.role, input.qualityRung, input.state.missionId);
  const promptHash = sha256Text(prompt);
  const thinkingControl = buildWheelThinkingControl(route, input.qualityRung);
  const attempt: WheelSupervisorAttempt = {
    schema: "wheel.zob.supervisor-attempt.v1",
    attemptId,
    storyId: input.story.storyId,
    role: input.role,
    assignmentId,
    status: "reserved",
    routeId: candidate.routeId,
    provider: candidate.provider,
    family: candidate.family,
    thinkingControl,
    qualityRung: input.qualityRung,
    candidateIndex: input.candidateIndex,
    attemptOrdinal,
    ownershipEpoch: input.state.ownershipEpoch,
    promptHash,
    headSha: input.story.workspace?.headSha,
    failureClass: "none",
    startedAt: input.now,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    bodyStored: false,
  };
  return { attempt, request: buildWheelDispatchRequestForAttempt(input.state, input.story, attempt) };
}

export function buildWheelStoryEffectRequest(input: {
  state: WheelSupervisorMissionState;
  story: WheelSupervisorStoryState;
  kind: WheelStoryEffectKind;
  mutationKey: string;
  metadata?: Record<string, string>;
  payloadHash?: string;
}): WheelStoryEffectRequest {
  const baseRef = "develop-staging" as const;
  const branchName = input.story.workspace?.branchName ?? input.story.branchContract.branchName;
  const expectedBaseSha = input.story.workspace?.baseSha ?? input.state.sourceSha;
  const expectedHeadSha = input.story.workspace?.headSha ?? input.story.pullRequest?.headSha;
  const idempotencyKey = `${input.state.missionId}-${input.story.storyId}-${input.kind}-${input.mutationKey}`;
  const withoutHash: Omit<WheelStoryEffectRequest, "requestHash"> = {
    schema: "wheel.zob.story-effect-request.v1",
    requestId: `effect-${sha256Text(idempotencyKey).slice(0, 24)}`,
    idempotencyKey,
    missionId: input.state.missionId,
    storyId: input.story.storyId,
    repositoryId: input.state.repositoryId,
    kind: input.kind,
    branchName,
    baseRef,
    expectedBaseSha,
    expectedHeadSha,
    expectedRemoteHeadSha: input.story.pullRequest?.headSha ?? null,
    expectedPullRequestId: input.story.pullRequest?.pullRequestId,
    manifestHash: input.story.manifestHash,
    payloadHash: input.payloadHash ?? sha256Canonical({ kind: input.kind, storyId: input.story.storyId, metadata: input.metadata ?? {} }),
    metadata: input.metadata ?? {},
    evidenceRefs: input.story.evidence.map((evidence) => evidence.evidenceId),
    bodyStored: false,
  };
  return { ...withoutHash, requestHash: computeWheelStoryEffectRequestHash(withoutHash) };
}
