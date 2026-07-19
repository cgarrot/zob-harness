import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  FileWheelSupervisorStore,
  buildWheelSupervisorInitialState,
  sha256Text,
} from "../../packages/wheel-zob-pack/index.js";
import { supervisorAdmissionInput, supervisorStory } from "./supervisor-fixtures.js";

function withStore(run: (store: FileWheelSupervisorStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "wheel-supervisor-store-"));
  try {
    run(new FileWheelSupervisorStore(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function initialize(store: FileWheelSupervisorStore) {
  const ownerId = "supervisor-test-owner";
  const ownerIdHash = sha256Text(ownerId);
  const ownership = store.acquireOwnership({
    missionId: "supervisor-test",
    ownerIdHash,
    now: "2026-07-19T12:00:00.000Z",
    leaseMs: 60_000,
  });
  const initialState = buildWheelSupervisorInitialState(supervisorAdmissionInput([supervisorStory("S-001")]));
  initialState.ownershipEpoch = ownership.ownershipEpoch;
  initialState.ownerIdHash = ownerIdHash;
  const initialized = store.initialize(initialState, {
    mutationId: "admit-supervisor-test",
    occurredAt: "2026-07-19T12:00:00.000Z",
  });
  return { ownership, state: initialized.state, ownerIdHash };
}

test("persists a hash-chained journal and matching atomic checkpoint", () => withStore((store) => {
  const { ownership } = initialize(store);
  const started = store.commit({
    mutationId: "start-supervisor-test",
    kind: "mission-started",
    payload: {},
    occurredAt: "2026-07-19T12:00:01.000Z",
    ownershipEpoch: ownership.ownershipEpoch,
  });
  assert.equal(started.state.status, "running");
  assert.equal(started.state.journalSequence, 2);
  assert.equal(store.loadEvents().length, 2);
  const checkpoint = store.loadCheckpoint();
  assert.equal(checkpoint?.sequence, 2);
  assert.equal(checkpoint?.journalHeadHash, started.event.eventHash);
  assert.equal(store.load()?.journalHeadHash, started.event.eventHash);
}));

test("recovers an event appended immediately before a simulated checkpoint crash", () => withStore((store) => {
  const { ownership } = initialize(store);
  assert.throws(() => store.commit({
    mutationId: "plan-story-after-crash",
    kind: "story-stage-changed",
    storyId: "S-001",
    payload: { to: "planned", blockerCodes: [] },
    occurredAt: "2026-07-19T12:00:02.000Z",
    ownershipEpoch: ownership.ownershipEpoch,
  }, { crashAfterJournalAppend: true }), /simulated_crash/);

  const recovered = store.load();
  assert.equal(recovered?.stories["S-001"]?.stage, "planned");
  assert.equal(recovered?.journalSequence, 2);
  assert.equal(store.loadCheckpoint()?.sequence, 1);

  const replay = store.commit({
    mutationId: "plan-story-after-crash",
    kind: "story-stage-changed",
    storyId: "S-001",
    payload: { to: "planned", blockerCodes: [] },
    occurredAt: "2026-07-19T12:00:02.000Z",
    ownershipEpoch: ownership.ownershipEpoch,
  });
  assert.equal(replay.replayed, true);
  assert.equal(store.loadEvents().length, 2);
}));

test("mutation replay is exact and conflicting reuse fails closed", () => withStore((store) => {
  const { ownership } = initialize(store);
  const input = {
    mutationId: "plan-story-once",
    kind: "story-stage-changed" as const,
    storyId: "S-001",
    payload: { to: "planned", blockerCodes: [] },
    occurredAt: "2026-07-19T12:00:02.000Z",
    ownershipEpoch: ownership.ownershipEpoch,
  };
  const first = store.commit(input);
  const replay = store.commit(input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(store.loadEvents().length, 2);
  assert.throws(() => store.commit({ ...input, payload: { to: "failed", blockerCodes: ["changed"] } }), /payload conflict/);
}));

test("ownership lease blocks live peers and fences an expired owner with a newer epoch", () => withStore((store) => {
  const first = initialize(store);
  assert.throws(() => store.acquireOwnership({
    missionId: "supervisor-test",
    ownerIdHash: "c".repeat(64),
    now: "2026-07-19T12:00:30.000Z",
    leaseMs: 60_000,
  }), /held by another live owner/);

  const secondOwner = "c".repeat(64);
  const takeover = store.acquireOwnership({
    missionId: "supervisor-test",
    ownerIdHash: secondOwner,
    now: "2026-07-19T12:01:01.000Z",
    leaseMs: 60_000,
  });
  assert.equal(takeover.ownershipEpoch, first.ownership.ownershipEpoch + 1);
  assert.equal(takeover.recoveredExpiredOwner, true);
  store.commit({
    mutationId: "take-over-supervisor-test",
    kind: "ownership-taken",
    payload: { ownerIdHash: secondOwner },
    occurredAt: "2026-07-19T12:01:01.000Z",
    ownershipEpoch: takeover.ownershipEpoch,
  });
  assert.equal(store.load()?.ownershipEpoch, takeover.ownershipEpoch);
  assert.throws(() => store.commit({
    mutationId: "stale-owner-write",
    kind: "mission-started",
    payload: {},
    ownershipEpoch: first.ownership.ownershipEpoch,
  }), /does not match current epoch/);
}));

test("truncated or corrupt journal tails fail closed", () => withStore((store) => {
  initialize(store);
  appendFileSync(store.journalPath, "{\"truncated\":", "utf8");
  assert.throws(() => store.load(), /truncated tail/);
}));
