import { sha256Canonical } from "./canonical.js";
import { validateWheelPrCloseTerminal } from "./pr-close.js";
import { wheelStoryDependenciesSatisfied } from "./scheduler.js";
import { FileWheelSupervisorStore } from "./store.js";
import type {
  WheelStoryEffectResult,
  WheelSupervisorCheckpoint,
  WheelSupervisorEventKind,
  WheelSupervisorRole,
} from "./types.js";

const REQUIRED_TERMINAL_ROLES: WheelSupervisorRole[] = [
  "development",
  "qa",
  "internal-review",
  "formal-blind-review",
  "repository-assurance",
  "pr-close-source-audit",
  "pr-close-evidence-audit",
  "pr-close",
];

export interface WheelSupervisorStateValidation {
  schema: "wheel.zob.supervisor-state-validation.v1";
  valid: boolean;
  missionId?: string;
  bundleHash?: string;
  sourceSha?: string;
  status?: string;
  storyCount: number;
  completedStoryCount: number;
  needsHumanStoryCount: number;
  dependencyBlockedStoryCount: number;
  completedStoryIds: string[];
  needsHumanStoryIds: string[];
  dependencyBlockedStoryIds: string[];
  noShipReasons: string[];
  journalSequence: number;
  journalHeadHash?: string;
  projectionHash?: string;
  checkpoint?: {
    sequence: number;
    journalHeadHash: string;
    projectionHash: string;
    ownershipEpoch: number;
    bodyStored: false;
  };
  journalEventKindCounts: Partial<Record<WheelSupervisorEventKind, number>>;
  settledCostUsd: number;
  issueCodes: string[];
  providerCallsPerformed: false;
  externalEffectsPerformed: false;
  bodyStored: false;
}

export function validateWheelSupervisorPersistedState(store: FileWheelSupervisorStore): WheelSupervisorStateValidation {
  const issueCodes: string[] = [];
  let state;
  let events;
  let checkpoint: WheelSupervisorCheckpoint | undefined;
  try {
    state = store.load();
    events = store.loadEvents();
    checkpoint = store.loadCheckpoint();
  } catch {
    return {
      schema: "wheel.zob.supervisor-state-validation.v1",
      valid: false,
      storyCount: 0,
      completedStoryCount: 0,
      needsHumanStoryCount: 0,
      dependencyBlockedStoryCount: 0,
      completedStoryIds: [],
      needsHumanStoryIds: [],
      dependencyBlockedStoryIds: [],
      noShipReasons: [],
      journalSequence: 0,
      journalEventKindCounts: {},
      settledCostUsd: 0,
      issueCodes: ["state-or-journal-invalid"],
      providerCallsPerformed: false,
      externalEffectsPerformed: false,
      bodyStored: false,
    };
  }
  if (!state) {
    return {
      schema: "wheel.zob.supervisor-state-validation.v1",
      valid: false,
      storyCount: 0,
      completedStoryCount: 0,
      needsHumanStoryCount: 0,
      dependencyBlockedStoryCount: 0,
      completedStoryIds: [],
      needsHumanStoryIds: [],
      dependencyBlockedStoryIds: [],
      noShipReasons: [],
      journalSequence: 0,
      journalEventKindCounts: {},
      settledCostUsd: 0,
      issueCodes: ["state-missing"],
      providerCallsPerformed: false,
      externalEffectsPerformed: false,
      bodyStored: false,
    };
  }
  const stories = Object.values(state.stories);
  const completed = stories.filter((story) => story.stage === "needs-review");
  const needsHuman = stories.filter((story) => story.stage === "needs-human");
  const dependencyBlocked = stories.filter((story) => state.noShipReasons.includes(`story:${story.storyId}:dependency-blocked`));
  const completedStoryIds = completed.map((story) => story.storyId).sort();
  const needsHumanStoryIds = needsHuman.map((story) => story.storyId).sort();
  const dependencyBlockedStoryIds = dependencyBlocked.map((story) => story.storyId).sort();
  const journalEventKindCounts = events.reduce<Partial<Record<WheelSupervisorEventKind, number>>>((counts, event) => {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    return counts;
  }, {});
  if (state.mode === "live") issueCodes.push("live-mode-not-validation-safe");
  if (state.budgetLedger.settledCostUsd !== 0 || state.budgetLedger.reservedCostUsd !== 0) issueCodes.push("nonzero-cost-ledger");
  if (state.pendingEffectRequestIds.length > 0) issueCodes.push("pending-effect-requests");
  if (events.length !== state.journalSequence) issueCodes.push("journal-sequence-mismatch");
  const attemptIds = new Set<string>();
  for (const story of stories) {
    for (const attempt of story.attempts) {
      if (attemptIds.has(attempt.attemptId)) issueCodes.push("duplicate-attempt-id");
      attemptIds.add(attempt.attemptId);
      if (attempt.bodyStored !== false) issueCodes.push("attempt-body-stored");
      if (attempt.costUsd !== 0) issueCodes.push("attempt-cost-nonzero");
    }
    if (story.externalSnapshot?.networkAccessed) issueCodes.push("snapshot-network-accessed");
    if (story.stage === "needs-review") {
      for (const role of REQUIRED_TERMINAL_ROLES) {
        const accepted = story.attempts.some((attempt) => {
          if (attempt.role !== role || attempt.status !== "accepted") return false;
          if (role !== "development") return attempt.headSha === story.workspace?.headSha;
          return story.evidence.some((evidence) =>
            evidence.kind === "build"
            && evidence.status === "current"
            && evidence.headSha === story.workspace?.headSha
            && evidence.artifactHash === attempt.outputHash);
        });
        if (!accepted) issueCodes.push(`terminal-role-missing:${role}`);
      }
      if (validateWheelPrCloseTerminal(state, story).length > 0) issueCodes.push("pr-close-terminal-invalid");
    }
  }
  for (const event of events) {
    if (event.kind !== "effect-completed") continue;
    const result = event.payload.result as WheelStoryEffectResult | undefined;
    if (!result) {
      issueCodes.push("effect-result-missing");
      continue;
    }
    if (result.externalEffectPerformed || result.localRepositoryWritePerformed || result.networkAccessed || result.credentialsAccessed) {
      issueCodes.push("effect-posture-unsafe");
    }
  }
  if (new Set(state.noShipReasons).size !== state.noShipReasons.length) issueCodes.push("duplicate-no-ship-reason");
  if (state.status === "complete") {
    if (completed.length !== stories.length) issueCodes.push("complete-status-with-unfinished-stories");
    if (state.noShipReasons.length > 0) issueCodes.push("complete-status-with-no-ship-reasons");
  }
  if (state.status === "failed" && state.noShipReasons.length === 0) issueCodes.push("failed-status-without-no-ship-reasons");
  if (state.status === "needs-human") {
    const dispositionCount = completed.length + needsHuman.length + dependencyBlocked.length;
    if (dispositionCount !== stories.length) issueCodes.push("undispositioned-stories");
    if (state.noShipReasons.length === 0) issueCodes.push("needs-human-status-without-no-ship-reasons");
    for (const story of needsHuman) {
      if (!state.noShipReasons.includes(`story:${story.storyId}:needs-human`)) issueCodes.push("needs-human-story-reason-missing");
    }
    for (const story of dependencyBlocked) {
      if (wheelStoryDependenciesSatisfied(state, story)) issueCodes.push("stale-dependency-blocked-reason");
    }
    const knownReasons = new Set([
      ...needsHuman.map((story) => `story:${story.storyId}:needs-human`),
      ...dependencyBlocked.map((story) => `story:${story.storyId}:dependency-blocked`),
    ]);
    if (state.noShipReasons.some((reason) => !knownReasons.has(reason))) issueCodes.push("needs-human-status-with-unknown-no-ship-reason");
  }
  return {
    schema: "wheel.zob.supervisor-state-validation.v1",
    valid: issueCodes.length === 0,
    missionId: state.missionId,
    bundleHash: state.bundleHash,
    sourceSha: state.sourceSha,
    status: state.status,
    storyCount: stories.length,
    completedStoryCount: completed.length,
    needsHumanStoryCount: needsHuman.length,
    dependencyBlockedStoryCount: dependencyBlocked.length,
    completedStoryIds,
    needsHumanStoryIds,
    dependencyBlockedStoryIds,
    noShipReasons: [...state.noShipReasons],
    journalSequence: state.journalSequence,
    journalHeadHash: state.journalHeadHash,
    projectionHash: sha256Canonical(state),
    checkpoint: checkpoint ? {
      sequence: checkpoint.sequence,
      journalHeadHash: checkpoint.journalHeadHash,
      projectionHash: checkpoint.projectionHash,
      ownershipEpoch: checkpoint.ownershipEpoch,
      bodyStored: false,
    } : undefined,
    journalEventKindCounts,
    settledCostUsd: state.budgetLedger.settledCostUsd,
    issueCodes: [...new Set(issueCodes)].sort(),
    providerCallsPerformed: false,
    externalEffectsPerformed: false,
    bodyStored: false,
  };
}
