import type {
  WheelPrCloseEvidence,
  WheelSupervisorAttempt,
  WheelSupervisorEvent,
  WheelSupervisorEvidenceRef,
  WheelSupervisorMissionState,
  WheelSupervisorStoryStage,
} from "./types.js";

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`event payload ${key} must be a non-empty string`);
  return value;
}

function requiredNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`event payload ${key} must be a finite number`);
  return value;
}

function requiredStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`event payload ${key} must be a string array`);
  return [...value] as string[];
}

function requireStory(state: WheelSupervisorMissionState, storyId: string | undefined) {
  if (!storyId || !state.stories[storyId]) throw new Error(`event references unknown story ${storyId ?? "missing"}`);
  return state.stories[storyId];
}

function replaceAttempt(attempts: WheelSupervisorAttempt[], attempt: WheelSupervisorAttempt): WheelSupervisorAttempt[] {
  const index = attempts.findIndex((candidate) => candidate.attemptId === attempt.attemptId);
  if (index === -1) return [...attempts, attempt];
  return attempts.map((candidate, candidateIndex) => candidateIndex === index ? attempt : candidate);
}

function updateTimestamp(state: WheelSupervisorMissionState, event: WheelSupervisorEvent): WheelSupervisorMissionState {
  return {
    ...state,
    revision: state.revision + 1,
    journalSequence: event.sequence,
    journalHeadHash: event.eventHash,
    updatedAt: event.occurredAt,
    bodyStored: false,
  };
}

export function applyWheelSupervisorEvent(
  current: WheelSupervisorMissionState | undefined,
  event: WheelSupervisorEvent,
): WheelSupervisorMissionState {
  if (event.kind === "mission-admitted") {
    if (current) throw new Error("mission-admitted cannot be applied to an existing mission");
    const initialState = event.payload.initialState;
    if (!initialState || typeof initialState !== "object" || Array.isArray(initialState)) throw new Error("mission-admitted requires initialState");
    const state = structuredClone(initialState) as WheelSupervisorMissionState;
    if (state.missionId !== event.missionId) throw new Error("mission-admitted state missionId mismatch");
    return {
      ...state,
      revision: 1,
      journalSequence: event.sequence,
      journalHeadHash: event.eventHash,
      updatedAt: event.occurredAt,
      bodyStored: false,
    };
  }
  if (!current) throw new Error(`event ${event.kind} requires an admitted mission`);
  if (current.missionId !== event.missionId) throw new Error("event missionId does not match projection");
  if (event.sequence !== current.journalSequence + 1) throw new Error("event sequence is not contiguous with projection");
  if (event.ownershipEpoch < current.ownershipEpoch) throw new Error("event ownership epoch is stale");

  const state = structuredClone(current);
  switch (event.kind) {
    case "ownership-taken":
      state.ownershipEpoch = event.ownershipEpoch;
      state.ownerIdHash = requiredString(event.payload, "ownerIdHash");
      break;
    case "mission-started":
    case "mission-resumed":
      state.status = "running";
      break;
    case "mission-paused":
      state.status = "paused";
      break;
    case "mission-needs-human":
      state.status = "needs-human";
      state.noShipReasons = requiredStringArray(event.payload, "noShipReasons");
      break;
    case "mission-completed":
      state.status = "complete";
      state.noShipReasons = [];
      break;
    case "mission-failed":
      state.status = "failed";
      state.noShipReasons = requiredStringArray(event.payload, "noShipReasons");
      break;
    case "story-stage-changed": {
      const story = requireStory(state, event.storyId);
      story.stage = requiredString(event.payload, "to") as WheelSupervisorStoryStage;
      story.stageRevision += 1;
      story.lastEventSequence = event.sequence;
      story.blockerCodes = event.payload.blockerCodes === undefined ? [] : requiredStringArray(event.payload, "blockerCodes");
      break;
    }
    case "story-blocked": {
      const story = requireStory(state, event.storyId);
      story.stage = "needs-human";
      story.stageRevision += 1;
      story.lastEventSequence = event.sequence;
      story.blockerCodes = requiredStringArray(event.payload, "blockerCodes");
      break;
    }
    case "human-gate-resolved": {
      const story = requireStory(state, event.storyId);
      requiredString(event.payload, "receiptHash");
      story.stage = "admitted";
      story.stageRevision += 1;
      story.lastEventSequence = event.sequence;
      story.blockerCodes = [];
      if (state.status === "needs-human") state.status = "running";
      state.noShipReasons = state.noShipReasons.filter((reason) =>
        reason !== `story:${story.storyId}:needs-human`
        && !reason.endsWith(":dependency-blocked"));
      break;
    }
    case "story-repair-round": {
      const story = requireStory(state, event.storyId);
      story.repairRound = requiredNumber(event.payload, "repairRound");
      story.lastEventSequence = event.sequence;
      break;
    }
    case "workspace-recorded": {
      const story = requireStory(state, event.storyId);
      const workspace = event.payload.workspace as typeof story.workspace;
      if (!workspace || workspace.bodyStored !== false) throw new Error("workspace-recorded requires a body-free workspace");
      story.workspace = structuredClone(workspace);
      story.lastEventSequence = event.sequence;
      break;
    }
    case "pull-request-recorded": {
      const story = requireStory(state, event.storyId);
      const pullRequest = event.payload.pullRequest as typeof story.pullRequest;
      if (!pullRequest || pullRequest.bodyStored !== false) throw new Error("pull-request-recorded requires a body-free pull request");
      story.pullRequest = structuredClone(pullRequest);
      story.lastEventSequence = event.sequence;
      break;
    }
    case "external-snapshot-recorded": {
      const story = requireStory(state, event.storyId);
      const snapshot = event.payload.snapshot as typeof story.externalSnapshot;
      if (!snapshot || snapshot.storyId !== story.storyId || snapshot.bodyStored !== false || snapshot.networkAccessed) {
        throw new Error("external-snapshot-recorded requires a matching body-free local snapshot");
      }
      story.externalSnapshot = structuredClone(snapshot);
      story.lastEventSequence = event.sequence;
      break;
    }
    case "story-head-changed": {
      const story = requireStory(state, event.storyId);
      if (!story.workspace) throw new Error("story-head-changed requires a workspace");
      const headSha = requiredString(event.payload, "headSha");
      story.workspace.headSha = headSha;
      story.evidence = story.evidence.map((evidence) => evidence.headSha === headSha ? evidence : { ...evidence, status: "stale" });
      story.prCloseEvidence = undefined;
      story.lastEventSequence = event.sequence;
      break;
    }
    case "attempt-reserved":
    case "attempt-started":
    case "attempt-completed":
    case "attempt-failed": {
      const story = requireStory(state, event.storyId);
      const attempt = event.payload.attempt as WheelSupervisorAttempt | undefined;
      if (!attempt || attempt.storyId !== story.storyId) throw new Error(`${event.kind} requires a matching attempt`);
      story.attempts = replaceAttempt(story.attempts, structuredClone(attempt));
      story.lastEventSequence = event.sequence;
      if (event.kind === "attempt-reserved") state.budgetLedger.reservedAttempts += 1;
      if (event.kind === "attempt-completed" || event.kind === "attempt-failed") {
        state.budgetLedger.settledAttempts += 1;
        state.budgetLedger.settledCostUsd += attempt.costUsd;
      }
      break;
    }
    case "effect-requested": {
      const requestId = requiredString(event.payload, "requestId");
      if (!state.pendingEffectRequestIds.includes(requestId)) state.pendingEffectRequestIds.push(requestId);
      break;
    }
    case "effect-completed": {
      const requestId = requiredString(event.payload, "requestId");
      state.pendingEffectRequestIds = state.pendingEffectRequestIds.filter((candidate) => candidate !== requestId);
      break;
    }
    case "evidence-recorded": {
      const story = requireStory(state, event.storyId);
      const evidence = event.payload.evidence as WheelSupervisorEvidenceRef | undefined;
      if (!evidence) throw new Error("evidence-recorded requires evidence");
      story.evidence = [...story.evidence.filter((candidate) => candidate.evidenceId !== evidence.evidenceId), structuredClone(evidence)];
      story.lastEventSequence = event.sequence;
      break;
    }
    case "pr-close-recorded": {
      const story = requireStory(state, event.storyId);
      const evidence = event.payload.prCloseEvidence as WheelPrCloseEvidence | undefined;
      if (!evidence || evidence.storyId !== story.storyId) throw new Error("pr-close-recorded requires matching evidence");
      story.prCloseEvidence = structuredClone(evidence);
      story.lastEventSequence = event.sequence;
      break;
    }
    case "checkpoint-written":
      requiredNumber(event.payload, "sequence");
      break;
    default:
      throw new Error(`unsupported supervisor event kind ${event.kind satisfies never}`);
  }
  return updateTimestamp(state, event);
}
