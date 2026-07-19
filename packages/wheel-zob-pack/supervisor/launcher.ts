import { createDeterministicFakeWheelSupervisorAuthority } from "./contracts.js";
import { WheelFleetSupervisor, admitWheelSupervisorMission, type WheelSupervisorRunResult } from "./controller.js";
import { DeterministicFakeWheelDispatchAdapter } from "./dispatch.js";
import { DeterministicFakeWheelStoryEffectBroker } from "./effects.js";
import {
  prepareWheelSupervisorFromMachineBundle,
  resolveWheelSupervisorStateDirectory,
  type WheelSupervisorBundleSummary,
} from "./launcher-preparation.js";
import { FileWheelSupervisorStore } from "./store.js";
import type { WheelSupervisorMissionState } from "./types.js";

export {
  DEFAULT_WHEEL_FAKE_CHECK_POLICY,
  prepareWheelSupervisorFromMachineBundle,
  resolveWheelSupervisorStateDirectory,
} from "./launcher-preparation.js";
export type {
  WheelPreparedSupervisorMission,
  WheelSupervisorBundleSummary,
} from "./launcher-preparation.js";

export interface WheelSupervisorFakeRun {
  summary: WheelSupervisorBundleSummary;
  stateDirectory: string;
  state?: WheelSupervisorMissionState;
  run?: WheelSupervisorRunResult;
}

export function initializeWheelSupervisorFromMachineBundle(
  repoRoot: string,
  input: Parameters<typeof prepareWheelSupervisorFromMachineBundle>[1] & { stateDirectory: string; checkpointEvery?: number },
): WheelSupervisorFakeRun {
  const prepared = prepareWheelSupervisorFromMachineBundle(repoRoot, input);
  const stateDirectory = resolveWheelSupervisorStateDirectory(repoRoot, input.stateDirectory);
  if (!prepared.admission) return { summary: prepared.summary, stateDirectory };
  const store = new FileWheelSupervisorStore(stateDirectory, { checkpointEvery: input.checkpointEvery ?? 25 });
  const state = admitWheelSupervisorMission(store, prepared.admission);
  return { summary: prepared.summary, stateDirectory, state };
}

export async function runWheelSupervisorFakeFromMachineBundle(
  repoRoot: string,
  input: Omit<Parameters<typeof initializeWheelSupervisorFromMachineBundle>[1], "mode" | "authority"> & { maxTicks?: number },
): Promise<WheelSupervisorFakeRun> {
  const initialized = initializeWheelSupervisorFromMachineBundle(repoRoot, {
    ...input,
    mode: "deterministic-fake",
    authority: createDeterministicFakeWheelSupervisorAuthority(),
  });
  if (!initialized.state) return initialized;
  const supervisor = new WheelFleetSupervisor(
    new FileWheelSupervisorStore(initialized.stateDirectory, { checkpointEvery: input.checkpointEvery ?? 25 }),
    createDeterministicFakeWheelSupervisorAuthority(),
    {
      dispatch: new DeterministicFakeWheelDispatchAdapter(),
      effects: new DeterministicFakeWheelStoryEffectBroker(),
    },
  );
  if (!["complete", "failed", "needs-human"].includes(initialized.state.status)) {
    supervisor.takeOwnership(input.ownerId ?? `wheel-supervisor-${input.missionId}`);
  }
  const run = await supervisor.runUntilSettled(input.maxTicks ?? 10_000);
  return { ...initialized, state: supervisor.load(), run };
}
