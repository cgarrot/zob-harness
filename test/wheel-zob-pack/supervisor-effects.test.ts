import assert from "node:assert/strict";
import test from "node:test";

import {
  DeterministicFakeWheelStoryEffectBroker,
  DisabledWheelStoryEffectBroker,
  buildWheelStoryEffectRequest,
  buildWheelSupervisorInitialState,
  computeWheelStoryEffectRequestHash,
  createDisabledWheelSupervisorAuthority,
  type WheelStoryEffectRequest,
} from "../../packages/wheel-zob-pack/index.js";
import { supervisorAdmissionInput, supervisorStory } from "./supervisor-fixtures.js";

function fixture() {
  const input = supervisorAdmissionInput([supervisorStory("S-EFFECT")]);
  const state = buildWheelSupervisorInitialState(input);
  const story = state.stories["S-EFFECT"]!;
  return { input, state, story };
}

function rehash(request: WheelStoryEffectRequest, changes: Partial<WheelStoryEffectRequest>): WheelStoryEffectRequest {
  const { requestHash: _oldHash, ...withoutHash } = { ...request, ...changes };
  return { ...withoutHash, requestHash: computeWheelStoryEffectRequestHash(withoutHash) };
}

test("fake workspace effects are deterministic, idempotent, isolated, and body-free", async () => {
  const { input, state, story } = fixture();
  const broker = new DeterministicFakeWheelStoryEffectBroker();
  const request = buildWheelStoryEffectRequest({ state, story, kind: "create-workspace", mutationKey: "stage-1" });
  const first = await broker.submit(request, input.authority);
  const replay = await broker.submit(request, input.authority);
  assert.equal(first.status, "simulated");
  assert.equal(first.syntheticHeadSha, state.sourceSha);
  assert.equal(replay.status, "replayed");
  assert.equal(first.externalEffectPerformed, false);
  assert.equal(first.localRepositoryWritePerformed, false);
  assert.equal(first.networkAccessed, false);
  assert.equal(first.credentialsAccessed, false);
  assert.equal(first.bodyStored, false);

  const conflicting = rehash(request, { metadata: { changed: "true" } });
  await assert.rejects(() => broker.submit(conflicting, input.authority), /idempotency conflict/);
});

test("fake broker denies branch ownership overlap between stories", async () => {
  const first = supervisorStory("S-BRANCH-1");
  const second = supervisorStory("S-BRANCH-2");
  const input = supervisorAdmissionInput([first, second]);
  const state = buildWheelSupervisorInitialState(input);
  const broker = new DeterministicFakeWheelStoryEffectBroker();
  const firstStory = state.stories[first.storyId]!;
  const secondStory = state.stories[second.storyId]!;
  await broker.submit(buildWheelStoryEffectRequest({ state, story: firstStory, kind: "create-workspace", mutationKey: "w1" }), input.authority);
  await broker.submit(buildWheelStoryEffectRequest({ state, story: firstStory, kind: "create-branch", mutationKey: "b1" }), input.authority);
  await broker.submit(buildWheelStoryEffectRequest({ state, story: secondStory, kind: "create-workspace", mutationKey: "w2" }), input.authority);
  const secondBranch = buildWheelStoryEffectRequest({ state, story: secondStory, kind: "create-branch", mutationKey: "b2" });
  const overlap = rehash(secondBranch, { branchName: firstStory.branchContract.branchName });
  const denied = await broker.submit(overlap, input.authority);
  assert.equal(denied.status, "policy-denied");
  assert.deepEqual(denied.reasonCodes, ["branch-owned-by-another-story"]);
});

test("fake effect broker rejects stale heads and unsupported destructive effects", async () => {
  const { input, state, story } = fixture();
  const broker = new DeterministicFakeWheelStoryEffectBroker();
  const workspace = buildWheelStoryEffectRequest({ state, story, kind: "create-workspace", mutationKey: "workspace" });
  await broker.submit(workspace, input.authority);
  const branch = buildWheelStoryEffectRequest({ state, story, kind: "create-branch", mutationKey: "branch" });
  const stale = rehash(branch, { expectedHeadSha: "c".repeat(40) });
  const staleResult = await broker.submit(stale, input.authority);
  assert.equal(staleResult.status, "precondition-failed");
  assert.deepEqual(staleResult.reasonCodes, ["stale-head"]);

  const unsupported = rehash(branch, {
    idempotencyKey: "unsupported-merge",
    requestId: "effect-unsupported-merge",
    kind: "merge" as WheelStoryEffectRequest["kind"],
  });
  await assert.rejects(() => broker.submit(unsupported, input.authority), /unsupported fake story effect/);
});

test("disabled effect broker never mutates repositories or observes a network", async () => {
  const { state, story } = fixture();
  const authority = createDisabledWheelSupervisorAuthority();
  const broker = new DisabledWheelStoryEffectBroker();
  const request = buildWheelStoryEffectRequest({ state: { ...state, mode: "disabled" }, story, kind: "create-workspace", mutationKey: "disabled" });
  const result = await broker.submit(request, authority);
  const snapshot = await broker.observe(story.storyId, authority);
  assert.equal(result.status, "blocked-disabled");
  assert.equal(result.externalEffectPerformed, false);
  assert.equal(result.localRepositoryWritePerformed, false);
  assert.equal(result.credentialsAccessed, false);
  assert.equal(snapshot.networkAccessed, false);
  assert.equal(snapshot.bodyStored, false);
});

test("effect request hash and base-target drift fail closed", async () => {
  const { input, state, story } = fixture();
  const broker = new DeterministicFakeWheelStoryEffectBroker();
  const request = buildWheelStoryEffectRequest({ state, story, kind: "create-workspace", mutationKey: "hash" });
  await assert.rejects(() => broker.submit({ ...request, requestHash: "f".repeat(64) }, input.authority), /requestHash mismatch/);
  const wrongBase = rehash(request, { baseRef: "main" as "develop-staging" });
  await assert.rejects(() => broker.submit(wrongBase, input.authority), /require[s]? develop-staging/);
});
