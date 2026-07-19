import { buildWheelSupervisorInitialState } from "./admission.js";
import { sha256Canonical } from "./canonical.js";
import { FileWheelSupervisorStore } from "./store.js";
import type { WheelSupervisorAdmissionInput, WheelSupervisorMissionState } from "./types.js";

function admissionMutationId(missionId: string, bundleHash: string): string {
  return `mission-admit-${sha256Canonical({ missionId, bundleHash }).slice(0, 24)}`;
}

export function admitWheelSupervisorMission(
  store: FileWheelSupervisorStore,
  input: WheelSupervisorAdmissionInput,
): WheelSupervisorMissionState {
  const existing = store.load();
  if (existing) {
    if (
      existing.missionId !== input.missionId
      || existing.bundleHash !== input.bundleHash
      || existing.sourceSha !== input.sourceSha
      || existing.repositoryId !== input.repositoryId
      || existing.authorityHash !== sha256Canonical(input.authority)
      || sha256Canonical(existing.checkPolicy) !== sha256Canonical(input.checkPolicy)
    ) {
      throw new Error("supervisor store already contains a different source-bound mission");
    }
    return existing;
  }
  const state = buildWheelSupervisorInitialState(input);
  const ownership = store.acquireOwnership({
    missionId: state.missionId,
    ownerIdHash: state.ownerIdHash,
    now: input.admittedAt,
    leaseMs: 5 * 60 * 1000,
  });
  state.ownershipEpoch = ownership.ownershipEpoch;
  return store.initialize(state, {
    mutationId: admissionMutationId(state.missionId, state.bundleHash),
    occurredAt: input.admittedAt,
  }).state;
}
