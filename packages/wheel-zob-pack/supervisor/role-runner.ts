import { validateDispatchResultPosture } from "./contracts.js";
import { buildWheelAttemptAndRequest, buildWheelDispatchRequestForAttempt } from "./requests.js";
import { selectWheelAttempt } from "./scheduler.js";
import type {
  WheelDispatchAdapter,
  WheelDispatchResult,
  WheelSupervisorAttempt,
  WheelSupervisorAuthority,
  WheelSupervisorEventKind,
  WheelSupervisorMissionState,
  WheelSupervisorRole,
  WheelSupervisorStoryState,
} from "./types.js";

export interface WheelRoleRunResult {
  progressed: boolean;
  accepted: boolean;
  blocked: boolean;
  exhausted: boolean;
  attempt?: WheelSupervisorAttempt;
  result?: WheelDispatchResult;
}

export interface WheelRoleRunnerContext {
  authority: WheelSupervisorAuthority;
  dispatch: WheelDispatchAdapter;
  load: () => WheelSupervisorMissionState;
  commit: (
    kind: WheelSupervisorEventKind,
    payload: Record<string, unknown>,
    storyId: string,
  ) => void;
  now: () => string;
}

export async function runWheelSupervisorRole(
  context: WheelRoleRunnerContext,
  storyId: string,
  role: WheelSupervisorRole,
): Promise<WheelRoleRunResult> {
  let state = context.load();
  let story = state.stories[storyId] as WheelSupervisorStoryState;
  const currentHead = story.workspace?.headSha;
  let attempt = [...story.attempts].reverse().find((candidate) =>
    candidate.role === role && candidate.headSha === currentHead && ["reserved", "launching", "running"].includes(candidate.status));
  let request;
  if (attempt) {
    if (context.authority.mode !== "deterministic-fake") return { progressed: false, accepted: false, blocked: true, exhausted: false, attempt };
    request = buildWheelDispatchRequestForAttempt(state, story, attempt);
  } else {
    const selection = selectWheelAttempt(story, role);
    if (!selection || selection.priorAttempts.length >= state.budgetPolicy.maxAttemptsPerTask) {
      return { progressed: false, accepted: false, blocked: false, exhausted: true };
    }
    ({ attempt, request } = buildWheelAttemptAndRequest({
      state,
      story,
      role,
      candidateIndex: selection.candidateIndex,
      qualityRung: selection.qualityRung,
      now: context.now(),
    }));
    context.commit("attempt-reserved", { attempt }, storyId);
    state = context.load();
    story = state.stories[storyId] as WheelSupervisorStoryState;
    attempt = story.attempts.find((candidate) => candidate.attemptId === attempt?.attemptId) as WheelSupervisorAttempt;
  }
  if (attempt.status !== "running") {
    attempt = { ...attempt, status: "running" };
    context.commit("attempt-started", { attempt }, storyId);
  }
  const result = await context.dispatch.dispatch(request, context.authority);
  const postureIssues = validateDispatchResultPosture(result, context.authority);
  if (postureIssues.length > 0) throw new Error(`dispatch result posture violation: ${postureIssues.join("; ")}`);
  const fresh = context.load().stories[storyId] as WheelSupervisorStoryState;
  if (fresh.workspace?.headSha !== attempt.headSha) return { progressed: false, accepted: false, blocked: true, exhausted: false, attempt, result };
  const finalAttempt: WheelSupervisorAttempt = {
    ...attempt,
    status: result.status === "accepted" ? "accepted" : result.status === "rejected" ? "rejected" : result.status === "blocked" ? "blocked" : "failed",
    outputHash: result.outputHash,
    claimHash: result.claimHash,
    failureClass: result.failureClass,
    completedAt: context.now(),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  };
  context.commit(result.status === "accepted" ? "attempt-completed" : "attempt-failed", { attempt: finalAttempt }, storyId);
  return {
    progressed: true,
    accepted: result.status === "accepted",
    blocked: result.status === "blocked",
    exhausted: false,
    attempt: finalAttempt,
    result,
  };
}
