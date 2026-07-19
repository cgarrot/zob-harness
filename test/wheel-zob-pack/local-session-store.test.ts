import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import {
  FileWheelLocalMachineLaunchStore,
  computeWheelFleetV5MachineBundleHash,
  persistWheelLocalMachineLaunchPlan,
  prepareWheelLocalMachineLaunch,
  sha256Text,
  wheelLocalMachineRecoveryConfirmation,
  wheelLocalMachineStartConfirmation,
  type WheelFleetV5MachineBundle,
  type WheelLocalMachineLaunchPlan,
  type WheelLocalWorkspaceInspection,
} from "../../packages/wheel-zob-pack/index.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionFixture(launchId: string): { root: string; plan: WheelLocalMachineLaunchPlan; workspace: WheelLocalWorkspaceInspection } {
  const root = mkdtempSync(join(process.cwd(), "wheel-local-session-"));
  const story = JSON.parse(readFileSync("docs/zob/examples/story-execution.example.json", "utf8")) as Record<string, unknown>;
  story.storyId = "SESSION-1";
  story.title = "Local session story";
  story.dependencies = [];
  story.humanGateRefs = [];
  story.branchContract = { branchName: "feature/session-1", prTarget: "develop-staging", draftRequired: true };
  const storyRaw = `${JSON.stringify(story, null, 2)}\n`;
  writeFileSync(join(root, "SESSION-1.json"), storyRaw, "utf8");
  const allocationRaw = "{\"plan\":\"session\"}\n";
  const signalsRaw = "{\"stories\":{}}\n";
  writeFileSync(join(root, "allocation.json"), allocationRaw, "utf8");
  writeFileSync(join(root, "signals.json"), signalsRaw, "utf8");
  const withoutHash: Omit<WheelFleetV5MachineBundle, "bundleHash"> = {
    schema: "wheel.zob.fleet-v5-machine-bundle.v1",
    bundleId: "session-bundle",
    revision: 1,
    source: {
      repositoryId: "example/repository",
      sourceSha: "a".repeat(40),
      allocationRef: "allocation.json",
      allocationSha256: sha256(allocationRaw),
      signalsRef: "signals.json",
      signalsSha256: sha256(signalsRaw),
    },
    machines: [{ machineId: "machine-a", theme: "Local", allocationUnitIds: ["SESSION-1"], storyIds: ["SESSION-1"], storyPaths: ["SESSION-1.json"] }],
  };
  const bundle: WheelFleetV5MachineBundle = {
    ...withoutHash,
    bundleHash: computeWheelFleetV5MachineBundleHash(withoutHash, { "SESSION-1.json": sha256(storyRaw) }),
  };
  writeFileSync(join(root, "machine-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  const prepared = prepareWheelLocalMachineLaunch(root, {
    launchId,
    missionId: `mission-${launchId}`,
    bundlePath: "machine-bundle.json",
    machineIds: ["machine-a"],
    preparedAt: "2026-07-20T12:00:00.000Z",
  });
  if (!prepared.prepared || !prepared.plan) throw new Error(prepared.errors.join("\n"));
  persistWheelLocalMachineLaunchPlan(root, prepared.plan);
  return {
    root,
    plan: prepared.plan,
    workspace: {
      schema: "wheel.zob.local-workspace-inspection.v1",
      repositoryRoot: join(root, "linked-worktree"),
      workspaceRootHash: sha256Text(join(root, "linked-worktree")),
      headSha: "b".repeat(40),
      branchName: "feature/session-1",
      linkedWorktree: true,
      clean: true,
      bodyStored: false,
    },
  };
}

test("claims one clean linked worktree, fences duplicate owners, and persists body-free status transitions", () => {
  const fixture = sessionFixture("launch-session-state");
  try {
    const store = new FileWheelLocalMachineLaunchStore(fixture.root, fixture.plan.launchId, "machine-a");
    const confirmationPhrase = wheelLocalMachineStartConfirmation(fixture.plan, "machine-a");
    assert.throws(() => store.claim({
      planHash: fixture.plan.planHash,
      machineId: "machine-a",
      confirmationPhrase: "START SOMETHING ELSE",
      ownerId: "owner-a",
      sessionId: "session-a",
      workspace: fixture.workspace,
      now: "2026-07-20T12:01:00.000Z",
    }), /does not bind/);
    const claimed = store.claim({
      planHash: fixture.plan.planHash,
      machineId: "machine-a",
      confirmationPhrase,
      ownerId: "owner-a",
      sessionId: "session-a",
      workspace: fixture.workspace,
      now: "2026-07-20T12:01:00.000Z",
    });
    assert.equal(claimed.replayed, false);
    assert.equal(claimed.claim.status, "claimed");
    assert.equal(claimed.claim.commitEnabled, false);
    assert.equal(claimed.claim.githubEffectsEnabled, false);
    assert.equal(store.claim({
      planHash: fixture.plan.planHash,
      machineId: "machine-a",
      confirmationPhrase,
      ownerId: "owner-a",
      sessionId: "session-a",
      workspace: fixture.workspace,
      now: "2026-07-20T12:01:01.000Z",
    }).replayed, true);
    assert.throws(() => store.claim({
      planHash: fixture.plan.planHash,
      machineId: "machine-a",
      confirmationPhrase,
      ownerId: "owner-b",
      sessionId: "session-b",
      workspace: fixture.workspace,
      now: "2026-07-20T12:01:01.000Z",
    }), /durable state/);

    const started = store.transition({
      ownerId: "owner-a",
      sessionId: "session-a",
      ownershipEpoch: 1,
      mutationId: "start-1",
      status: "started",
      occurredAt: "2026-07-20T12:01:02.000Z",
    });
    assert.equal(started.claim.status, "started");
    assert.equal(store.transition({
      ownerId: "owner-a",
      sessionId: "session-a",
      ownershipEpoch: 1,
      mutationId: "start-1",
      status: "started",
      occurredAt: "2026-07-20T12:01:02.000Z",
    }).replayed, true);
    store.transition({
      ownerId: "owner-a",
      sessionId: "session-a",
      ownershipEpoch: 1,
      mutationId: "running-1",
      status: "running",
      occurredAt: "2026-07-20T12:01:03.000Z",
    });
    assert.throws(() => store.transition({
      ownerId: "owner-a",
      sessionId: "session-a",
      ownershipEpoch: 1,
      mutationId: "start-1",
      status: "started",
      occurredAt: "2026-07-20T12:01:03.100Z",
    }), /stale historical replay/);
    const ready = store.transition({
      ownerId: "owner-a",
      sessionId: "session-a",
      ownershipEpoch: 1,
      mutationId: "ready-1",
      status: "local-ready",
      occurredAt: "2026-07-20T12:01:04.000Z",
      evidenceRefs: ["reports/wheel-zob/local-launches/launch-session-state/validation.json"],
      evidenceHashes: ["c".repeat(64)],
    });
    assert.equal(ready.claim.status, "local-ready");
    const status = store.status("2026-07-20T12:01:05.000Z");
    assert.equal(status.valid, true, status.issueCodes.join("\n"));
    assert.equal(status.eventCount, 4);
    assert.equal(status.checkpointCurrent, true);
    assert.equal(status.ownershipLive, true);
    assert.equal(status.recoveryRequired, false);
    assert.equal(status.claim?.status, "local-ready");
    const journal = readFileSync(store.journalPath, "utf8");
    assert.equal(journal.includes("owner-a"), false);
    assert.equal(journal.includes("session-a"), false);
    assert.equal(journal.includes(fixture.workspace.repositoryRoot), false);
    assert.equal(journal.includes("prompt"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("recovers an expired session with an exact next epoch while preserving dirty local work and unchanged HEAD", () => {
  const fixture = sessionFixture("launch-session-recovery");
  try {
    const store = new FileWheelLocalMachineLaunchStore(fixture.root, fixture.plan.launchId, "machine-a");
    store.claim({
      planHash: fixture.plan.planHash,
      machineId: "machine-a",
      confirmationPhrase: wheelLocalMachineStartConfirmation(fixture.plan, "machine-a"),
      ownerId: "owner-old",
      sessionId: "session-old",
      workspace: fixture.workspace,
      now: "2026-07-20T12:01:00.000Z",
      leaseMs: 1_000,
    });
    store.transition({
      ownerId: "owner-old",
      sessionId: "session-old",
      ownershipEpoch: 1,
      mutationId: "recovery-started",
      status: "started",
      occurredAt: "2026-07-20T12:01:00.100Z",
    });
    store.transition({
      ownerId: "owner-old",
      sessionId: "session-old",
      ownershipEpoch: 1,
      mutationId: "recovery-running",
      status: "running",
      occurredAt: "2026-07-20T12:01:00.200Z",
    });
    const dirtyWorkspace = { ...fixture.workspace, clean: false };
    const confirmation = wheelLocalMachineRecoveryConfirmation({
      launchId: fixture.plan.launchId,
      machineId: "machine-a",
      planHash: fixture.plan.planHash,
      ownershipEpoch: 2,
    });
    const recovered = store.recover({
      ownerId: "owner-new",
      sessionId: "session-new",
      confirmationPhrase: confirmation,
      workspace: dirtyWorkspace,
      now: "2026-07-20T12:01:02.000Z",
      leaseMs: 1_000,
    });
    assert.equal(recovered.claim.ownershipEpoch, 2);
    assert.equal(recovered.claim.status, "started");
    assert.equal(recovered.recoveredExpiredOwner, true);
    store.transition({
      ownerId: "owner-new",
      sessionId: "session-new",
      ownershipEpoch: 2,
      mutationId: "recovery-running-2",
      status: "running",
      occurredAt: "2026-07-20T12:01:02.100Z",
    });
    assert.equal(store.recover({
      ownerId: "owner-new",
      sessionId: "session-new",
      confirmationPhrase: confirmation,
      workspace: dirtyWorkspace,
      now: "2026-07-20T12:01:02.500Z",
    }).replayed, true);

    const confirmation3 = wheelLocalMachineRecoveryConfirmation({
      launchId: fixture.plan.launchId,
      machineId: "machine-a",
      planHash: fixture.plan.planHash,
      ownershipEpoch: 3,
    });
    const recovered3 = store.recover({
      ownerId: "owner-third",
      sessionId: "session-third",
      confirmationPhrase: confirmation3,
      workspace: dirtyWorkspace,
      now: "2026-07-20T12:01:04.000Z",
    });
    assert.equal(recovered3.claim.ownershipEpoch, 3);
    store.transition({
      ownerId: "owner-third",
      sessionId: "session-third",
      ownershipEpoch: 3,
      mutationId: "recovery-running-3",
      status: "running",
      occurredAt: "2026-07-20T12:01:04.100Z",
    });
    assert.throws(() => store.recover({
      ownerId: "owner-new",
      sessionId: "session-new",
      confirmationPhrase: confirmation,
      workspace: dirtyWorkspace,
      now: "2026-07-20T12:01:04.200Z",
    }), /stale relative to current epoch 3/);
    const status = store.status("2026-07-20T12:01:04.300Z");
    assert.equal(status.valid, true);
    assert.equal(status.recoveredExpiredOwnerCount, 2);
    assert.equal(status.ownershipLive, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("replays journal state after a checkpoint crash and fails closed on corruption", () => {
  const fixture = sessionFixture("launch-session-crash");
  try {
    const store = new FileWheelLocalMachineLaunchStore(fixture.root, fixture.plan.launchId, "machine-a");
    store.claim({
      planHash: fixture.plan.planHash,
      machineId: "machine-a",
      confirmationPhrase: wheelLocalMachineStartConfirmation(fixture.plan, "machine-a"),
      ownerId: "owner-crash",
      sessionId: "session-crash",
      workspace: fixture.workspace,
      now: "2026-07-20T12:01:00.000Z",
    });
    assert.throws(() => store.transition({
      ownerId: "owner-crash",
      sessionId: "session-crash",
      ownershipEpoch: 1,
      mutationId: "crash-after-start",
      status: "started",
      occurredAt: "2026-07-20T12:01:01.000Z",
      crashAfterJournalAppend: true,
    }), /simulated_local_launch_crash/);
    const afterCrash = store.status("2026-07-20T12:01:02.000Z");
    assert.equal(afterCrash.valid, true);
    assert.equal(afterCrash.claim?.status, "started");
    assert.equal(afterCrash.checkpointCurrent, false);
    assert.equal(afterCrash.recoveryRequired, true);
    assert.throws(() => store.transition({
      ownerId: "owner-crash",
      sessionId: "session-crash",
      ownershipEpoch: 1,
      mutationId: "must-not-overwrite-checkpoint",
      status: "running",
      occurredAt: "2026-07-20T12:01:02.500Z",
    }), /checkpoint is stale or corrupted/);
    const repaired = store.repairCheckpoint("2026-07-20T12:01:03.000Z");
    assert.equal(repaired.checkpointCurrent, true);
    assert.equal(repaired.recoveryRequired, false);

    appendFileSync(store.journalPath, "{corrupt\n", "utf8");
    const corrupted = store.status("2026-07-20T12:01:04.000Z");
    assert.equal(corrupted.valid, false);
    assert.equal(corrupted.recoveryRequired, true);
    assert.equal(corrupted.issueCodes.some((issue) => issue.includes("invalid JSON")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
