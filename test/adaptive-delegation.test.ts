import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  decideDelegationRequest,
  normalizeAdaptiveDelegationPolicy,
  scoreDelegationRequest,
  validateAdaptiveDelegationPolicy,
  validateDelegationRequestHardGates,
} from "../.pi/extensions/zob-harness/index.ts";
import type { AdaptiveDelegationPolicy, DelegationRequestProposal } from "../.pi/extensions/zob-harness/index.ts";

const REPO = process.cwd();

const POLICY: AdaptiveDelegationPolicy = normalizeAdaptiveDelegationPolicy({
  enabled: true,
  mode: "when_pertinent",
  dispatch: true,
});

function makeRequest(overrides: Record<string, unknown> = {}): DelegationRequestProposal {
  return {
    schema: "zob.delegation-request.v1",
    requesterRole: "lead",
    referentRole: "lead",
    requestedAgent: "explore",
    requestedOutputContract: "explore.v1",
    requiredTools: ["read"],
    requesterDepth: 0,
    targetDepth: 1,
    ttlRequested: 2,
    evidenceRefs: ["README.md"],
    targetFileSet: [],
    risk: "low",
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    ...overrides,
  } as unknown as DelegationRequestProposal;
}

function hardGates(request: DelegationRequestProposal): string[] {
  return validateDelegationRequestHardGates({
    repoRoot: REPO,
    request,
    policy: POLICY,
    rootGoalHash: "root-goal-hash",
    parentTaskId: "parent-task",
  });
}

test("validateDelegationRequestHardGates: blocks write and bash dispatch tools", () => {
  assert.ok(hardGates(makeRequest({ requiredTools: ["write"] })).some((error) => error.includes("blocked requested tool: write")));
  assert.ok(hardGates(makeRequest({ requiredTools: ["bash"] })).some((error) => error.includes("blocked requested tool: bash")));
  assert.ok(hardGates(makeRequest({ requiredTools: ["edit"] })).some((error) => error.includes("blocked requested tool: edit")));
});

test("validateDelegationRequestHardGates: blocks delegation and non-allowlisted tools", () => {
  assert.ok(hardGates(makeRequest({ requiredTools: ["delegate_agent"] })).some((error) => error.includes("forbids write/delegation tool: delegate_agent")));
  assert.ok(hardGates(makeRequest({ requiredTools: ["zob_coms_send"] })).some((error) => error.includes("not in supervised_readonly allowlist")));
  assert.ok(hardGates(makeRequest({ requiredTools: [] })).some((error) => error.includes("requires requiredTools")));
});

test("validateDelegationRequestHardGates: enforces depth, ttl and body-free invariants", () => {
  assert.ok(hardGates(makeRequest({ requesterDepth: 0, targetDepth: 2 })).some((error) => error.includes("targetDepth must equal requesterDepth + 1")));
  assert.ok(hardGates(makeRequest({ ttlRequested: 0 })).some((error) => error.includes("ttlRemaining must be positive")));
  assert.ok(hardGates(makeRequest({ bodyStored: true })).some((error) => error.includes("must declare bodyStored=false")));
});

test("validateDelegationRequestHardGates: rejects plaintext body keys and bad output contract", () => {
  assert.ok(hardGates(makeRequest({ prompt: "leaked prompt" })).some((error) => error.includes("must not contain plaintext body/prompt/output/task/content fields")));
  assert.ok(hardGates(makeRequest({ requestedOutputContract: "nope.v1" })).some((error) => error.includes("output contract") && error.includes("Unknown output contract")));
});

test("validateDelegationRequestHardGates: keeps targetFileSet inside the repo", () => {
  const errors = hardGates(makeRequest({ targetFileSet: ["../escape"] }));
  assert.ok(errors.some((error) => error.includes("adaptive_delegation targetFileSet")));
});

test("scoreDelegationRequest: hard gate failures force a deny hint and zero safety", () => {
  const request = makeRequest({ requiredTools: ["write"] });
  const score = scoreDelegationRequest({ request, hardGateErrors: hardGates(request), policy: POLICY });
  assert.equal(score.decisionHint, "deny");
  assert.equal(score.safety, 0);
  assert.ok(score.reasons.includes("hard_gates_failed"));
});

test("decideDelegationRequest: a request with hard-gate failures is blocked and not dispatchable", () => {
  const decision = decideDelegationRequest({
    repoRoot: REPO,
    runId: "run-1",
    rootGoalHash: "root-goal-hash",
    parentTaskId: "parent-task",
    request: makeRequest({ requiredTools: ["write"] }),
    policy: POLICY,
  });
  assert.equal(decision.status, "blocked");
  assert.equal(decision.dispatchAllowed, false);
  assert.equal(decision.hardGateStatus, "blocked");
  assert.ok(decision.hardGateErrors.length > 0);
});

test("normalizeAdaptiveDelegationPolicy: clamps mode and dispatch to enabled state", () => {
  const off = normalizeAdaptiveDelegationPolicy(undefined);
  assert.equal(off.enabled, false);
  assert.equal(off.mode, "off");
  assert.equal(off.dispatch, false);

  const advisory = normalizeAdaptiveDelegationPolicy({ enabled: true });
  assert.equal(advisory.mode, "advisory_only");
  assert.equal(advisory.dispatch, false);

  const forcedOff = normalizeAdaptiveDelegationPolicy({ enabled: false, dispatch: true, mode: "when_pertinent" });
  assert.equal(forcedOff.mode, "off");
  assert.equal(forcedOff.dispatch, false);

  const dispatching = normalizeAdaptiveDelegationPolicy({ enabled: true, mode: "when_pertinent", dispatch: true });
  assert.equal(dispatching.dispatch, true);
});

test("validateAdaptiveDelegationPolicy: accepts normalized defaults, rejects contradictory dispatch", () => {
  assert.deepEqual(validateAdaptiveDelegationPolicy(normalizeAdaptiveDelegationPolicy(undefined)), []);

  const contradictory: AdaptiveDelegationPolicy = {
    ...normalizeAdaptiveDelegationPolicy({ enabled: true, mode: "advisory_only" }),
    dispatch: true,
  };
  assert.ok(validateAdaptiveDelegationPolicy(contradictory).some((error) => error.includes("advisory_only mode cannot dispatch live children")));
});
