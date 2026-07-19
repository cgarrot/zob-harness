import assert from "node:assert/strict";
import test from "node:test";

import {
  DeterministicFakeWheelDispatchAdapter,
  DisabledWheelDispatchAdapter,
  buildWheelAttemptAndRequest,
  buildWheelSupervisorInitialState,
  createDisabledWheelSupervisorAuthority,
  sha256Text,
} from "../../packages/wheel-zob-pack/index.js";
import { supervisorAdmissionInput, supervisorStory } from "./supervisor-fixtures.js";

function requestFixture() {
  const input = supervisorAdmissionInput([supervisorStory("S-DISPATCH")]);
  const state = buildWheelSupervisorInitialState(input);
  const story = state.stories["S-DISPATCH"]!;
  return {
    input,
    ...buildWheelAttemptAndRequest({
      state,
      story,
      role: "development",
      candidateIndex: 0,
      qualityRung: "low",
      now: "2026-07-19T12:00:00.000Z",
    }),
  };
}

test("deterministic dispatch consumes the protected route while recording hashes only", async () => {
  const fixture = requestFixture();
  const adapter = new DeterministicFakeWheelDispatchAdapter();
  const result = await adapter.dispatch(fixture.request, fixture.input.authority);
  const recorded = adapter.recordedRequests[0];
  assert.equal(result.status, "accepted");
  assert.equal(result.providerCalled, false);
  assert.equal(result.networkAccessed, false);
  assert.equal(result.costUsd, 0);
  assert.equal(result.bodyStored, false);
  assert.equal(recorded?.routeId, fixture.attempt.routeId);
  assert.equal(recorded?.provider, fixture.attempt.provider);
  assert.equal(recorded?.family, fixture.attempt.family);
  assert.equal(recorded?.promptHash, sha256Text(fixture.request.transientPromptBody));
  assert.equal(recorded?.bodyStored, false);
  assert.equal("transientPromptBody" in (recorded ?? {}), false);
});

test("deterministic dispatch applies typed model-quality outcomes without provider effects", async () => {
  const fixture = requestFixture();
  const adapter = new DeterministicFakeWheelDispatchAdapter([
    { storyId: "S-DISPATCH", role: "development", candidateIndex: 0, qualityRung: "low", outcome: "model-quality" },
  ]);
  const result = await adapter.dispatch(fixture.request, fixture.input.authority);
  assert.equal(result.status, "rejected");
  assert.equal(result.failureClass, "model-quality");
  assert.equal(result.providerCalled, false);
  assert.equal(result.outputHash?.length, 64);
});

test("dispatch adapters fail closed on mode or prompt binding drift", async () => {
  const fixture = requestFixture();
  const fake = new DeterministicFakeWheelDispatchAdapter();
  await assert.rejects(
    () => fake.dispatch({ ...fixture.request, promptHash: "f".repeat(64) }, fixture.input.authority),
    /promptHash mismatch/,
  );
  await assert.rejects(
    () => fake.dispatch(fixture.request, createDisabledWheelSupervisorAuthority()),
    /requires deterministic-fake authority/,
  );
  const disabled = new DisabledWheelDispatchAdapter();
  const blocked = await disabled.dispatch(fixture.request, createDisabledWheelSupervisorAuthority());
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.failureClass, "policy-blocked");
  assert.equal(blocked.providerCalled, false);
});
