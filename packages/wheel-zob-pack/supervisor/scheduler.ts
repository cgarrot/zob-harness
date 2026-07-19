import type {
  WheelFailureClass,
  WheelSupervisorAttempt,
  WheelSupervisorMissionState,
  WheelSupervisorRole,
  WheelSupervisorStoryStage,
  WheelSupervisorStoryState,
} from "./types.js";

export const WHEEL_SUPERVISOR_TERMINAL_STORY_STAGES = new Set<WheelSupervisorStoryStage>([
  "needs-review",
  "needs-human",
  "failed",
]);

export function wheelStoryDependenciesSatisfied(
  state: WheelSupervisorMissionState,
  story: WheelSupervisorStoryState,
): boolean {
  for (const dependency of story.dependencies) {
    if (dependency.type === "soft") continue;
    const local = state.stories[dependency.storyId];
    if (local) {
      if (local.stage !== "needs-review") return false;
      continue;
    }
    if (dependency.type === "hard" || dependency.type === "stack") return false;
    if (dependency.type === "artifact" && state.mode !== "deterministic-fake") return false;
  }
  return true;
}

export function selectWheelRunnableStories(state: WheelSupervisorMissionState): WheelSupervisorStoryState[] {
  if (state.status !== "running" && state.status !== "admitted" && state.status !== "needs-human") return [];
  return Object.values(state.stories)
    .filter((story) => !WHEEL_SUPERVISOR_TERMINAL_STORY_STAGES.has(story.stage))
    .filter((story) => story.blockerCodes.length === 0)
    .filter((story) => wheelStoryDependenciesSatisfied(state, story))
    .slice(0, state.budgetPolicy.maxParallelStories);
}

export function roleForWheelStoryStage(stage: WheelSupervisorStoryStage): WheelSupervisorRole | undefined {
  if (stage === "development" || stage === "repair") return "development";
  if (stage === "documentation") return "documentation";
  if (stage === "qa") return "qa";
  if (stage === "internal-review") return "internal-review";
  if (stage === "formal-blind-review") return "formal-blind-review";
  if (stage === "repository-assurance") return "repository-assurance";
  if (stage === "pr-close-source-audit") return "pr-close-source-audit";
  if (stage === "pr-close-evidence-audit") return "pr-close-evidence-audit";
  if (stage === "pr-close-finalizing") return "pr-close";
  return undefined;
}

export interface WheelAttemptSelection {
  candidateIndex: number;
  qualityRung: "low" | "high";
  priorAttempts: WheelSupervisorAttempt[];
}

function retrySameAttemptClass(failureClass: WheelFailureClass): boolean {
  return failureClass === "provider-transient" || failureClass === "provider-unavailable" || failureClass === "rate-limit";
}

export function selectWheelAttempt(
  story: WheelSupervisorStoryState,
  role: WheelSupervisorRole,
): WheelAttemptSelection | undefined {
  const assignment = story.routeAssignments.find((candidate) => candidate.role === role);
  if (!assignment || (!assignment.required && role === "documentation")) return undefined;
  const currentHead = story.workspace?.headSha;
  const priorAttempts = story.attempts.filter((attempt) => attempt.role === role && attempt.headSha === currentHead);
  const last = priorAttempts.at(-1);
  if (!last) return { candidateIndex: 0, qualityRung: "low", priorAttempts };
  if (last.status === "accepted") return undefined;
  if (retrySameAttemptClass(last.failureClass)) {
    return { candidateIndex: last.candidateIndex, qualityRung: last.qualityRung, priorAttempts };
  }
  if (last.failureClass === "capability-mismatch") {
    const nextCandidate = last.candidateIndex + 1;
    return nextCandidate < assignment.candidates.length ? { candidateIndex: nextCandidate, qualityRung: "low", priorAttempts } : undefined;
  }
  if (last.qualityRung === "low") return { candidateIndex: last.candidateIndex, qualityRung: "high", priorAttempts };
  const nextCandidate = last.candidateIndex + 1;
  return nextCandidate < assignment.candidates.length ? { candidateIndex: nextCandidate, qualityRung: "low", priorAttempts } : undefined;
}

export function wheelStoryCompletionSummary(state: WheelSupervisorMissionState): {
  complete: string[];
  needsHuman: string[];
  failed: string[];
  pending: string[];
} {
  const complete: string[] = [];
  const needsHuman: string[] = [];
  const failed: string[] = [];
  const pending: string[] = [];
  for (const story of Object.values(state.stories)) {
    if (story.stage === "needs-review") complete.push(story.storyId);
    else if (story.stage === "needs-human") needsHuman.push(story.storyId);
    else if (story.stage === "failed") failed.push(story.storyId);
    else pending.push(story.storyId);
  }
  return { complete, needsHuman, failed, pending };
}
