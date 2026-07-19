import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import {
  computeWheelFleetV5MachineBundleHash,
  createWheelPrHandoffAuthority,
  hashWheelLocalMachineLaunchPlan,
  loadWheelLocalMachineLaunchPlan,
  persistWheelLocalMachineLaunchPlan,
  persistWheelPrHandoffAuthority,
  persistWheelPrHandoffCandidate,
  prepareWheelLocalMachineLaunch,
  prepareWheelPrHandoffCandidate,
  sha256Canonical,
  validateWheelLocalMachineLaunchPlan,
  validateWheelPrHandoffAuthority,
  validateWheelPrHandoffCandidate,
  wheelPrHandoffConfirmation,
  type WheelFleetV5MachineBundle,
  type WheelLocalMachineLaunchClaim,
} from "../../packages/wheel-zob-pack/index.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function localLaunchFixture(): { root: string; bundlePath: string; secondStoryPath: string } {
  const root = mkdtempSync(join(process.cwd(), "wheel-local-launch-"));
  const sourceStory = JSON.parse(readFileSync("docs/zob/examples/story-execution.example.json", "utf8")) as Record<string, unknown>;
  const first = structuredClone(sourceStory);
  first.storyId = "GEN-1";
  first.title = "Generic first story";
  first.dependencies = [];
  first.humanGateRefs = [];
  first.branchContract = { branchName: "feature/gen-1", prTarget: "develop-staging", draftRequired: true };
  const second = structuredClone(sourceStory);
  second.storyId = "GEN-2";
  second.title = "Generic second story";
  second.dependencies = [{ storyId: "GEN-1", type: "artifact", prBaseRef: "machine:alpha" }];
  second.humanGateRefs = ["docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md"];
  second.branchContract = { branchName: "feature/gen-2", prTarget: "develop-staging", draftRequired: true };
  const firstRaw = `${JSON.stringify(first, null, 2)}\n`;
  const secondRaw = `${JSON.stringify(second, null, 2)}\n`;
  writeFileSync(join(root, "GEN-1.json"), firstRaw, "utf8");
  const secondStoryPath = join(root, "GEN-2.json");
  writeFileSync(secondStoryPath, secondRaw, "utf8");
  const allocationRaw = "{\"plan\":\"generic-local-launch\"}\n";
  const signalsRaw = "{\"stories\":{}}\n";
  writeFileSync(join(root, "allocation.json"), allocationRaw, "utf8");
  writeFileSync(join(root, "signals.json"), signalsRaw, "utf8");
  const withoutHash: Omit<WheelFleetV5MachineBundle, "bundleHash"> = {
    schema: "wheel.zob.fleet-v5-machine-bundle.v1",
    bundleId: "generic-local-launch-bundle",
    revision: 1,
    source: {
      repositoryId: "example/repository",
      sourceSha: "a".repeat(40),
      allocationRef: "allocation.json",
      allocationSha256: sha256(allocationRaw),
      signalsRef: "signals.json",
      signalsSha256: sha256(signalsRaw),
    },
    machines: [
      { machineId: "alpha", theme: "First lane", allocationUnitIds: ["GEN-1"], storyIds: ["GEN-1"], storyPaths: ["GEN-1.json"] },
      { machineId: "beta", theme: "Second lane", allocationUnitIds: ["GEN-2"], storyIds: ["GEN-2"], storyPaths: ["GEN-2.json"] },
    ],
  };
  const bundle: WheelFleetV5MachineBundle = {
    ...withoutHash,
    bundleHash: computeWheelFleetV5MachineBundleHash(withoutHash, {
      "GEN-1.json": sha256(firstRaw),
      "GEN-2.json": sha256(secondRaw),
    }),
  };
  const bundlePath = join(root, "machine-bundle.json");
  writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { root, bundlePath: relative(root, bundlePath), secondStoryPath };
}

function localReadyClaim(planHash: string, assignmentHash: string): WheelLocalMachineLaunchClaim {
  return {
    schema: "wheel.zob.local-machine-launch-claim.v1",
    claimId: "claim-beta-1",
    launchId: "launch-generic-1",
    planHash,
    machineId: "beta",
    assignmentHash,
    ownerIdHash: "1".repeat(64),
    sessionIdHash: "2".repeat(64),
    workspaceRootHash: "3".repeat(64),
    workspaceHeadSha: "b".repeat(40),
    workspaceBranch: "feature/gen-2",
    linkedWorktree: true,
    cleanAtInitialClaim: true,
    ownershipEpoch: 1,
    claimedAt: "2026-07-20T12:01:00.000Z",
    updatedAt: "2026-07-20T12:04:00.000Z",
    leaseExpiresAt: "2026-07-20T16:01:00.000Z",
    status: "local-ready",
    confirmationHash: "4".repeat(64),
    evidenceRefs: ["reports/wheel-zob/local-launches/launch-generic-1/validation.json"],
    evidenceHashes: ["5".repeat(64)],
    commitEnabled: false,
    pushEnabled: false,
    githubEffectsEnabled: false,
    bodyStored: false,
  };
}

test("prepares and persists an arbitrary selected-machine local launch without activating effects", () => {
  const fixture = localLaunchFixture();
  try {
    const prepared = prepareWheelLocalMachineLaunch(fixture.root, {
      launchId: "launch-generic-1",
      missionId: "mission-generic-1",
      bundlePath: fixture.bundlePath,
      machineIds: ["beta"],
      preparedAt: "2026-07-20T12:00:00.000Z",
    });
    assert.equal(prepared.prepared, true, prepared.errors.join("\n"));
    assert.deepEqual(prepared.plan?.selectedMachineIds, ["beta"]);
    assert.deepEqual(prepared.plan?.storyIds, ["GEN-2"]);
    assert.deepEqual(prepared.plan?.assignments[0]?.dependencyStoryIds, ["GEN-1"]);
    assert.deepEqual(prepared.plan?.assignments[0]?.humanGateStoryIds, ["GEN-2"]);
    assert.equal(prepared.plan?.authorityBoundary.localSourceEditsAllowedAfterExplicitStart, true);
    assert.equal(prepared.plan?.authorityBoundary.activationEnabled, false);
    assert.equal(prepared.plan?.authorityBoundary.commitEnabled, false);
    assert.equal(prepared.plan?.authorityBoundary.githubEffectsEnabled, false);
    assert.equal(prepared.processSpawned, false);
    assert.equal(prepared.sourceMutationsMade, false);
    assert.equal(prepared.gitMutationsMade, false);
    assert.equal(prepared.reportArtifactsWritten, false);
    assert.equal(prepared.providerCallsMade, false);
    assert.equal(prepared.githubEffectsMade, false);
    assert.match(prepared.confirmationPhrases[0]?.phrase ?? "", new RegExp(prepared.plan?.planHash ?? "missing"));

    const firstWrite = persistWheelLocalMachineLaunchPlan(fixture.root, prepared.plan!);
    const replay = persistWheelLocalMachineLaunchPlan(fixture.root, prepared.plan!);
    assert.equal(firstWrite.replay, false);
    assert.equal(replay.replay, true);
    assert.equal(existsSync(join(fixture.root, firstWrite.planRef)), true);
    assert.equal(loadWheelLocalMachineLaunchPlan(fixture.root, "launch-generic-1", { now: "2026-07-20T12:02:00.000Z" }).planHash, prepared.plan?.planHash);

    const tampered = structuredClone(prepared.plan!);
    tampered.storyIds = ["GEN-9"];
    const validation = validateWheelLocalMachineLaunchPlan(tampered, { now: "2026-07-20T12:02:00.000Z" });
    assert.equal(validation.valid, false);
    assert.equal(validation.errors.includes("launch plan hash mismatch"), true);

    const unsafeRehashed = structuredClone(prepared.plan!);
    unsafeRehashed.launchMechanism.processSpawned = true;
    unsafeRehashed.launchMechanism.kind = "invalid" as typeof unsafeRehashed.launchMechanism.kind;
    unsafeRehashed.authorityBoundary.explicitMachineStartRequired = false;
    unsafeRehashed.authorityBoundary.arbitraryNetworkAccessEnabled = true;
    unsafeRehashed.planHash = hashWheelLocalMachineLaunchPlan(unsafeRehashed);
    const unsafeValidation = validateWheelLocalMachineLaunchPlan(unsafeRehashed, { now: "2026-07-20T12:02:00.000Z" });
    assert.equal(unsafeValidation.valid, false);
    assert.equal(unsafeValidation.errors.some((error) => error.includes("launchMechanism")), true);
    assert.equal(unsafeValidation.errors.some((error) => error.includes("explicitMachineStartRequired")), true);
    assert.equal(unsafeValidation.errors.some((error) => error.includes("arbitraryNetworkAccessEnabled")), true);

    const malformed = structuredClone(prepared.plan!) as unknown as Record<string, unknown>;
    const malformedAssignments = malformed.assignments as Array<Record<string, unknown>>;
    malformedAssignments[0]!.storyPaths = [42];
    malformed.planHash = hashWheelLocalMachineLaunchPlan(malformed as unknown as typeof prepared.plan);
    assert.doesNotThrow(() => validateWheelLocalMachineLaunchPlan(malformed, { now: "2026-07-20T12:02:00.000Z" }));
    assert.equal(validateWheelLocalMachineLaunchPlan(malformed, { now: "2026-07-20T12:02:00.000Z" }).valid, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("selected-machine preparation still fails closed when an unselected peer story is stale", () => {
  const fixture = localLaunchFixture();
  try {
    writeFileSync(fixture.secondStoryPath, "{}\n", "utf8");
    const prepared = prepareWheelLocalMachineLaunch(fixture.root, {
      launchId: "launch-stale-peer",
      missionId: "mission-stale-peer",
      bundlePath: fixture.bundlePath,
      machineIds: ["alpha"],
      preparedAt: "2026-07-20T12:00:00.000Z",
    });
    assert.equal(prepared.prepared, false);
    assert.equal(prepared.errors.some((error) => error.includes("bundle hash") || error.includes("expected storyId")), true);
    assert.equal(prepared.processSpawned, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("published PR handoff schemas preserve phase and forbidden-path gates", () => {
  const candidateSchema = JSON.parse(readFileSync("docs/zob/schemas/fleet-v5-pr-handoff-candidate.schema.json", "utf8")) as Record<string, unknown>;
  const authoritySchema = JSON.parse(readFileSync("docs/zob/schemas/fleet-v5-pr-handoff-authority.schema.json", "utf8")) as Record<string, unknown>;
  const receiptSchema = JSON.parse(readFileSync("docs/zob/schemas/fleet-v5-pr-handoff-commit-receipt.schema.json", "utf8")) as Record<string, unknown>;
  assert.equal(Array.isArray(candidateSchema.allOf), true);
  assert.equal(Array.isArray(authoritySchema.allOf), true);
  assert.equal(JSON.stringify(candidateSchema).includes("post-commit candidate requires"), false);
  assert.equal(JSON.stringify(candidateSchema).includes("priorPreCommitCandidateId"), true);
  assert.equal(JSON.stringify(candidateSchema).includes("local-launches"), true);
  assert.equal(JSON.stringify(candidateSchema).includes("agent-sessions"), true);
  assert.equal(JSON.stringify(authoritySchema).includes("contains"), true);
  assert.equal(JSON.stringify(receiptSchema).includes("governedCommitEvidenceHash"), true);
  assert.equal(JSON.stringify(receiptSchema).includes("deploymentEnabled"), true);
});

test("PR handoff requires an exact candidate, exact head, scoped actions, and a matching human receipt", () => {
  const fixture = localLaunchFixture();
  try {
    const prepared = prepareWheelLocalMachineLaunch(fixture.root, {
      launchId: "launch-generic-1",
      missionId: "mission-generic-1",
      bundlePath: fixture.bundlePath,
      machineIds: ["beta"],
      preparedAt: "2026-07-20T12:00:00.000Z",
    });
    assert.equal(prepared.prepared, true, prepared.errors.join("\n"));
    const plan = prepared.plan!;
    persistWheelLocalMachineLaunchPlan(fixture.root, plan);
    const claim = localReadyClaim(plan.planHash, plan.assignments[0]!.assignmentHash);
    const candidate = prepareWheelPrHandoffCandidate(plan, claim, {
      candidateId: "candidate-beta-1",
      phase: "post-commit",
      machineJournalHeadHash: "7".repeat(64),
      machineOwnershipEpoch: 1,
      storyWorkspaceRootHash: "6".repeat(64),
      priorPreCommitCandidateId: "candidate-beta-pre",
      priorPreCommitCandidateHash: "8".repeat(64),
      commitAuthorityId: "authority-beta-commit",
      commitAuthorityHash: "9".repeat(64),
      commitReceiptId: "receipt-beta-commit",
      commitReceiptHash: "a".repeat(64),
      branchName: "feature/gen-2",
      baseRef: "develop-staging",
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      treeHash: "d".repeat(40),
      contentHash: "1".repeat(64),
      diffHash: "e".repeat(64),
      changedPaths: ["src/generic.ts"],
      evidenceRefs: ["reports/wheel-zob/local-launches/launch-generic-1/validation.json"],
      evidenceHashes: ["f".repeat(64)],
      requestedActions: ["push", "create-draft-pr", "observe-ci", "pr-close"],
      preparedAt: "2026-07-20T12:05:00.000Z",
    });
    assert.equal(validateWheelPrHandoffCandidate(candidate, { now: "2026-07-20T12:06:00.000Z" }).valid, true);
    assert.equal(candidate.authorityGranted, false);
    assert.equal(candidate.commitEnabled, false);
    assert.equal(candidate.githubEffectsEnabled, false);
    assert.equal(candidate.mergeEnabled, false);
    const candidateWrite = persistWheelPrHandoffCandidate(fixture.root, candidate);
    assert.equal(candidateWrite.replay, false);
    assert.equal(persistWheelPrHandoffCandidate(fixture.root, candidate).replay, true);

    const actions = ["push", "create-draft-pr"] as const;
    assert.throws(() => createWheelPrHandoffAuthority(candidate, {
      authorityId: "authority-beta-bad",
      actorId: "owner",
      allowedActions: [...actions],
      confirmationPhrase: "AUTHORIZE SOMETHING ELSE",
      issuedAt: "2026-07-20T12:07:00.000Z",
    }), /does not match/);
    const authority = createWheelPrHandoffAuthority(candidate, {
      authorityId: "authority-beta-1",
      actorId: "owner",
      allowedActions: [...actions],
      confirmationPhrase: wheelPrHandoffConfirmation(candidate, actions),
      issuedAt: "2026-07-20T12:07:00.000Z",
    });
    assert.equal(authority.mergeEnabled, false);
    assert.equal(authority.promotionEnabled, false);
    assert.equal(authority.deploymentEnabled, false);
    assert.equal(persistWheelPrHandoffAuthority(fixture.root, authority).replay, false);
    assert.equal(persistWheelPrHandoffAuthority(fixture.root, authority).replay, true);
    const valid = validateWheelPrHandoffAuthority(candidate, authority, {
      now: "2026-07-20T12:08:00.000Z",
      currentBaseSha: candidate.baseSha,
      currentHeadSha: candidate.headSha,
      currentDiffHash: candidate.diffHash,
    });
    assert.equal(valid.valid, true, valid.errors.join("\n"));
    assert.deepEqual(valid.allowedActions, actions);
    const staleHead = validateWheelPrHandoffAuthority(candidate, authority, {
      now: "2026-07-20T12:08:00.000Z",
      currentHeadSha: "9".repeat(40),
    });
    assert.equal(staleHead.valid, false);
    assert.equal(staleHead.allowedActions.length, 0);
    assert.equal(staleHead.errors.includes("current head sha does not match candidate"), true);

    const preCommit = prepareWheelPrHandoffCandidate(plan, claim, {
      candidateId: "candidate-beta-precommit",
      phase: "pre-commit",
      machineJournalHeadHash: "7".repeat(64),
      machineOwnershipEpoch: 1,
      storyWorkspaceRootHash: "6".repeat(64),
      branchName: "feature/gen-2",
      baseRef: "develop-staging",
      baseSha: "b".repeat(40),
      headSha: "b".repeat(40),
      treeHash: "d".repeat(40),
      contentHash: "1".repeat(64),
      diffHash: "e".repeat(64),
      changedPaths: ["src/generic.ts"],
      evidenceRefs: ["reports/wheel-zob/local-launches/launch-generic-1/validation.json"],
      evidenceHashes: ["f".repeat(64)],
      requestedActions: ["commit"],
      preparedAt: "2026-07-20T12:05:00.000Z",
    });
    assert.equal(validateWheelPrHandoffCandidate(preCommit, { now: "2026-07-20T12:06:00.000Z" }).valid, true);
    assert.throws(() => prepareWheelPrHandoffCandidate(plan, claim, {
      candidateId: "candidate-same-control-workspace",
      phase: "pre-commit",
      machineJournalHeadHash: "7".repeat(64),
      machineOwnershipEpoch: 1,
      storyWorkspaceRootHash: claim.workspaceRootHash,
      branchName: "feature/gen-2",
      baseRef: "develop-staging",
      baseSha: "b".repeat(40),
      headSha: "b".repeat(40),
      treeHash: "d".repeat(40),
      contentHash: "1".repeat(64),
      diffHash: "e".repeat(64),
      changedPaths: ["src/generic.ts"],
      evidenceRefs: ["evidence/local-review.json"],
      evidenceHashes: ["f".repeat(64)],
      requestedActions: ["commit"],
      preparedAt: "2026-07-20T12:05:00.000Z",
    }), /story workspace must differ from the machine control workspace/);
    assert.throws(() => prepareWheelPrHandoffCandidate(plan, claim, {
      candidateId: "candidate-invalid-phase",
      phase: "pre-commit",
      machineJournalHeadHash: "7".repeat(64),
      machineOwnershipEpoch: 1,
      storyWorkspaceRootHash: "6".repeat(64),
      branchName: "feature/gen-2",
      baseRef: "develop-staging",
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      treeHash: "d".repeat(40),
      contentHash: "1".repeat(64),
      diffHash: "e".repeat(64),
      changedPaths: ["src/generic.ts"],
      evidenceRefs: [],
      evidenceHashes: [],
      requestedActions: ["commit", "push"],
      preparedAt: "2026-07-20T12:05:00.000Z",
    }), /pre-commit candidate/);

    const mutated = structuredClone(candidate);
    mutated.diffHash = sha256Canonical("different-diff");
    const mutatedValidation = validateWheelPrHandoffCandidate(mutated, { now: "2026-07-20T12:08:00.000Z" });
    assert.equal(mutatedValidation.valid, false);
    assert.equal(mutatedValidation.errors.includes("candidate hash mismatch"), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
