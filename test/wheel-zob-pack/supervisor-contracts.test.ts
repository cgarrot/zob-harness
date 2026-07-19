import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WHEEL_SUPERVISOR_BUDGET_POLICY,
  createDeterministicFakeWheelSupervisorAuthority,
  createDisabledWheelSupervisorAuthority,
  validateDispatchResultPosture,
  validateEffectResultPosture,
  validateWheelSupervisorAuthority,
  validateWheelSupervisorBudgetPolicy,
  WheelFleetSupervisor,
  FileWheelSupervisorStore,
  type WheelDispatchResult,
  type WheelStoryEffectResult,
} from "../../packages/wheel-zob-pack/index.js";

test("disabled and deterministic-fake supervisor authorities hard-disable every effect", () => {
  for (const authority of [createDisabledWheelSupervisorAuthority(), createDeterministicFakeWheelSupervisorAuthority()]) {
    assert.deepEqual(validateWheelSupervisorAuthority(authority), []);
    assert.equal(authority.activationEnabled, false);
    assert.equal(authority.networkEnabled, false);
    assert.equal(authority.providerDispatchEnabled, false);
    assert.equal(authority.localGitEffectsEnabled, false);
    assert.equal(authority.githubEffectsEnabled, false);
    assert.equal(authority.commitEnabled, false);
    assert.equal(authority.pushEnabled, false);
    assert.equal(authority.mergeEnabled, false);
    assert.equal(authority.workflowDispatchEnabled, false);
    assert.equal(authority.deploymentEnabled, false);
  }
});

test("non-live authority refuses effect enablement and live authority requires exact receipts", () => {
  const unsafe = { ...createDisabledWheelSupervisorAuthority(), githubEffectsEnabled: true };
  assert.match(validateWheelSupervisorAuthority(unsafe)[0] ?? "", /cannot enable/);

  const live = { ...createDisabledWheelSupervisorAuthority(), mode: "live" as const };
  const issues = validateWheelSupervisorAuthority(live);
  assert.ok(issues.some((issue) => issue.includes("activationEnabled")));
  assert.ok(issues.some((issue) => issue.includes("activation receipt")));
  assert.ok(issues.some((issue) => issue.includes("oracle receipt")));
  assert.ok(issues.some((issue) => issue.includes("spend receipt")));
  assert.ok(issues.some((issue) => issue.includes("expiry")));
});

test("controller rejects even receipt-complete live authority until activation is implemented", () => {
  const live = {
    ...createDisabledWheelSupervisorAuthority(),
    mode: "live" as const,
    activationEnabled: true,
    activationReceiptHash: "a".repeat(64),
    oracleReceiptHash: "b".repeat(64),
    spendReceiptHash: "c".repeat(64),
    expiresAt: "2026-07-20T00:00:00.000Z",
  };
  assert.deepEqual(validateWheelSupervisorAuthority(live), []);
  const dispatch = { mode: "live" as const, dispatch: async () => { throw new Error("must not dispatch"); } };
  const effects = {
    mode: "live" as const,
    submit: async () => { throw new Error("must not submit"); },
    observe: async () => { throw new Error("must not observe"); },
  };
  assert.throws(
    () => new WheelFleetSupervisor(new FileWheelSupervisorStore("reports/wheel-zob/supervisor/live-constructor-test"), live, { dispatch, effects }),
    /live supervisor activation is not implemented/,
  );
});

test("default supervisor budget is strict, bounded, and zero-spend", () => {
  assert.deepEqual(validateWheelSupervisorBudgetPolicy(DEFAULT_WHEEL_SUPERVISOR_BUDGET_POLICY), []);
  assert.equal(DEFAULT_WHEEL_SUPERVISOR_BUDGET_POLICY.maxCostUsd, 0);
  assert.equal(DEFAULT_WHEEL_SUPERVISOR_BUDGET_POLICY.maxAttemptsPerTask, 3);
  assert.equal(DEFAULT_WHEEL_SUPERVISOR_BUDGET_POLICY.maxRepairRoundsPerStory, 3);
});

test("fake dispatch and effect results cannot conceal network, provider, cost, or repository writes", () => {
  const authority = createDeterministicFakeWheelSupervisorAuthority();
  const dispatch: WheelDispatchResult = {
    schema: "wheel.zob.dispatch-result.v1",
    attemptId: "attempt-1",
    assignmentId: "assignment-1",
    status: "accepted",
    failureClass: "none",
    outputHash: "a".repeat(64),
    claimHash: "b".repeat(64),
    evidenceRefs: ["reports/fake/evidence.json"],
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    mocked: true,
    networkAccessed: false,
    providerCalled: false,
    bodyStored: false,
  };
  const effect: WheelStoryEffectResult = {
    schema: "wheel.zob.story-effect-result.v1",
    requestId: "request-1",
    requestHash: "c".repeat(64),
    idempotencyKey: "effect-1",
    mode: "deterministic-fake",
    status: "simulated",
    reasonCodes: [],
    externalEffectPerformed: false,
    localRepositoryWritePerformed: false,
    networkAccessed: false,
    credentialsAccessed: false,
    bodyStored: false,
  };
  assert.deepEqual(validateDispatchResultPosture(dispatch, authority), []);
  assert.deepEqual(validateEffectResultPosture(effect, authority), []);

  assert.ok(validateDispatchResultPosture({ ...dispatch, providerCalled: true }, authority).length > 0);
  assert.ok(validateDispatchResultPosture({ ...dispatch, costUsd: 0.01 }, authority).length > 0);
  assert.ok(validateEffectResultPosture({ ...effect, localRepositoryWritePerformed: true }, authority).length > 0);
  assert.ok(validateEffectResultPosture({ ...effect, networkAccessed: true }, authority).length > 0);
});
