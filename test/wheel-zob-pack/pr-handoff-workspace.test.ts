import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileWheelLocalMachineLaunchStore,
  authorizeWheelPrHandoffFromWorkspace,
  computeWheelFleetV5MachineBundleHash,
  persistWheelLocalMachineLaunchPlan,
  prepareWheelLocalMachineLaunch,
  prepareWheelPrHandoffCandidateFromWorkspace,
  inspectWheelPrHandoffStatus,
  inspectWheelPrHandoffWorkspace,
  recordWheelPrHandoffCommitReceiptFromWorkspace,
  sha256Canonical,
  sha256Text,
  validateWheelPrHandoffAuthority,
  wheelLocalMachineStartConfirmation,
  wheelPrHandoffConfirmation,
  type WheelFleetV5MachineBundle,
  type WheelLocalWorkspaceInspection,
} from "../../packages/wheel-zob-pack/index.js";
import { parseWheelGitNulPaths } from "../../packages/wheel-zob-pack/launch/workspace-snapshot.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("PR handoff schemas reject Windows-shaped secret and session refs", () => {
  const candidateSchema = JSON.parse(readFileSync(join(process.cwd(), "docs/zob/schemas/fleet-v5-pr-handoff-candidate.schema.json"), "utf8")) as { $defs: { repoRef: { pattern: string }; sourceRef: { pattern: string } } };
  const receiptSchema = JSON.parse(readFileSync(join(process.cwd(), "docs/zob/schemas/fleet-v5-pr-handoff-commit-receipt.schema.json"), "utf8")) as { $defs: { repoRef: { pattern: string } } };
  const candidateRef = new RegExp(candidateSchema.$defs.repoRef.pattern);
  const sourceRef = new RegExp(candidateSchema.$defs.sourceRef.pattern);
  const receiptRef = new RegExp(receiptSchema.$defs.repoRef.pattern);
  assert.equal(candidateRef.test(".pi\\sessions\\private.json"), false);
  assert.equal(candidateRef.test("credentials\\token.json"), false);
  assert.equal(sourceRef.test("reports\\wheel-zob\\local-launches\\private.json"), false);
  assert.equal(sourceRef.test(".git\\config"), false);
  assert.equal(receiptRef.test("secrets\\commit.json"), false);
  assert.equal(candidateRef.test("reports\\wheel-zob\\evidence\\safe.json"), true);
});

test("pre-commit and post-commit PR handoffs bind one story workspace, exact diff/head, and separate action scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "wheel-pr-handoff-"));
  const controlRoot = join(root, "control");
  const gitRoot = join(root, "git-primary");
  const storyWorktree = join(root, "story-worktree");
  mkdirSync(controlRoot, { recursive: true });
  mkdirSync(gitRoot, { recursive: true });
  const time = Date.now();
  const iso = (offsetMs: number) => new Date(time + offsetMs).toISOString();
  try {
    const story = JSON.parse(readFileSync("docs/zob/examples/story-execution.example.json", "utf8")) as Record<string, unknown>;
    story.storyId = "PR-STORY-1";
    story.title = "PR handoff story";
    story.dependencies = [];
    story.humanGateRefs = [];
    story.branchContract = { branchName: "feature/pr-story-1", prTarget: "develop-staging", draftRequired: true };
    const storyRaw = `${JSON.stringify(story, null, 2)}\n`;
    writeFileSync(join(controlRoot, "PR-STORY-1.json"), storyRaw, "utf8");
    const allocationRaw = "{\"plan\":\"pr-handoff\"}\n";
    const signalsRaw = "{\"stories\":{}}\n";
    writeFileSync(join(controlRoot, "allocation.json"), allocationRaw, "utf8");
    writeFileSync(join(controlRoot, "signals.json"), signalsRaw, "utf8");
    git(gitRoot, ["init", "-b", "main"]);
    git(gitRoot, ["config", "user.email", "wheel-test@example.invalid"]);
    git(gitRoot, ["config", "user.name", "Wheel Test"]);
    writeFileSync(join(gitRoot, "src.txt"), "before\n", "utf8");
    mkdirSync(join(gitRoot, "nested"), { recursive: true });
    writeFileSync(join(gitRoot, "nested", "file.txt"), "inside\n", "utf8");
    writeFileSync(join(gitRoot, ".gitignore"), ".pi/logs/\nnested\n", "utf8");
    git(gitRoot, ["add", "src.txt", ".gitignore"]);
    git(gitRoot, ["add", "-f", "nested/file.txt"]);
    git(gitRoot, ["commit", "-m", "base"]);
    const sourceSha = git(gitRoot, ["rev-parse", "HEAD"]);
    const withoutHash: Omit<WheelFleetV5MachineBundle, "bundleHash"> = {
      schema: "wheel.zob.fleet-v5-machine-bundle.v1",
      bundleId: "pr-handoff-bundle",
      revision: 1,
      source: {
        repositoryId: "example/repository",
        sourceSha,
        allocationRef: "allocation.json",
        allocationSha256: sha256(allocationRaw),
        signalsRef: "signals.json",
        signalsSha256: sha256(signalsRaw),
      },
      machines: [{ machineId: "machine-pr", theme: "PR", allocationUnitIds: ["PR-STORY-1"], storyIds: ["PR-STORY-1"], storyPaths: ["PR-STORY-1.json"] }],
    };
    const bundle: WheelFleetV5MachineBundle = {
      ...withoutHash,
      bundleHash: computeWheelFleetV5MachineBundleHash(withoutHash, { "PR-STORY-1.json": sha256(storyRaw) }),
    };
    writeFileSync(join(controlRoot, "machine-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    const prepared = prepareWheelLocalMachineLaunch(controlRoot, {
      launchId: "launch-pr-handoff",
      missionId: "mission-pr-handoff",
      bundlePath: "machine-bundle.json",
      machineIds: ["machine-pr"],
      preparedAt: iso(0),
    });
    assert.equal(prepared.prepared, true, prepared.errors.join("\n"));
    persistWheelLocalMachineLaunchPlan(controlRoot, prepared.plan!);

    const controlWorkspace: WheelLocalWorkspaceInspection = {
      schema: "wheel.zob.local-workspace-inspection.v1",
      repositoryRoot: join(root, "control-worktree"),
      workspaceRootHash: sha256Text(join(root, "control-worktree")),
      headSha: "b".repeat(40),
      branchName: "wheel-machine-control",
      linkedWorktree: true,
      clean: true,
      bodyStored: false,
    };
    const machineStore = new FileWheelLocalMachineLaunchStore(controlRoot, "launch-pr-handoff", "machine-pr");
    const claimed = machineStore.claim({
      planHash: prepared.plan!.planHash,
      machineId: "machine-pr",
      confirmationPhrase: wheelLocalMachineStartConfirmation(prepared.plan!, "machine-pr"),
      ownerId: "owner-pr",
      sessionId: "session-pr",
      workspace: controlWorkspace,
      now: iso(1_000),
      leaseMs: 10_000,
    }).claim;
    machineStore.transition({ ownerId: "owner-pr", sessionId: "session-pr", ownershipEpoch: claimed.ownershipEpoch, mutationId: "pr-start", status: "started", occurredAt: iso(2_000) });
    machineStore.transition({ ownerId: "owner-pr", sessionId: "session-pr", ownershipEpoch: claimed.ownershipEpoch, mutationId: "pr-running", status: "running", occurredAt: iso(3_000) });

    git(gitRoot, ["worktree", "add", "-b", "feature/pr-story-1", storyWorktree]);
    const baseSha = git(storyWorktree, ["rev-parse", "HEAD"]);
    writeFileSync(join(storyWorktree, "src.txt"), "after local review\n", "utf8");
    if (process.platform !== "win32") {
      const literalBackslashPath = join(storyWorktree, "safe\\name.bin");
      writeFileSync(literalBackslashPath, Buffer.from([0, 1, 2, 3]));
      assert.throws(
        () => inspectWheelPrHandoffWorkspace(storyWorktree, { phase: "pre-commit", sourceSha }),
        /unsupported literal backslash/,
      );
      unlinkSync(literalBackslashPath);

      assert.throws(
        () => parseWheelGitNulPaths(Buffer.from([0x6d, 0x61, 0x6c, 0x66, 0x6f, 0x72, 0x6d, 0x65, 0x64, 0x2d, 0xff, 0x00])),
        /not valid round-trip UTF-8/,
      );

      const outsideDirectory = join(root, "outside-directory");
      mkdirSync(outsideDirectory, { recursive: true });
      writeFileSync(join(outsideDirectory, "file.txt"), "outside\n", "utf8");
      rmSync(join(storyWorktree, "nested"), { recursive: true, force: true });
      symlinkSync(outsideDirectory, join(storyWorktree, "nested"), "dir");
      assert.throws(
        () => inspectWheelPrHandoffWorkspace(storyWorktree, { phase: "pre-commit", sourceSha }),
        /traverses a symlink component/,
      );
      unlinkSync(join(storyWorktree, "nested"));
      mkdirSync(join(storyWorktree, "nested"), { recursive: true });
      writeFileSync(join(storyWorktree, "nested", "file.txt"), "inside\n", "utf8");
    }

    const ordinaryBinaryPath = join(storyWorktree, "ordinary.bin");
    writeFileSync(ordinaryBinaryPath, Buffer.from([0, 1, 2, 3]));
    const ordinaryBefore = inspectWheelPrHandoffWorkspace(storyWorktree, { phase: "pre-commit", sourceSha });
    writeFileSync(ordinaryBinaryPath, Buffer.from([9, 8, 7, 6]));
    const ordinaryAfter = inspectWheelPrHandoffWorkspace(storyWorktree, { phase: "pre-commit", sourceSha });
    assert.notEqual(ordinaryAfter.contentHash, ordinaryBefore.contentHash);
    assert.notEqual(ordinaryAfter.diffHash, ordinaryBefore.diffHash);
    assert.notEqual(ordinaryAfter.treeHash, ordinaryBefore.treeHash);
    unlinkSync(ordinaryBinaryPath);

    assert.throws(() => inspectWheelPrHandoffWorkspace(storyWorktree, { phase: "pre-commit", sourceSha: "f".repeat(40) }), /source sha is missing/);

    const staleMachineCandidate = prepareWheelPrHandoffCandidateFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      machineId: "machine-pr",
      candidateId: "candidate-stale-machine",
      phase: "pre-commit",
      storyIds: ["PR-STORY-1"],
      storyWorkspaceRoot: storyWorktree,
      baseRef: "develop-staging",
      evidenceRefs: ["evidence/pr-story-1-local-review.json"],
      evidenceHashes: ["c".repeat(64)],
      requestedActions: ["commit"],
      preparedAt: iso(3_500),
    });
    machineStore.transition({
      ownerId: "owner-pr",
      sessionId: "session-pr",
      ownershipEpoch: claimed.ownershipEpoch,
      mutationId: "pr-local-ready",
      status: "local-ready",
      occurredAt: iso(3_750),
      evidenceRefs: ["evidence/machine-ready.json"],
      evidenceHashes: ["b".repeat(64)],
    });
    assert.throws(() => authorizeWheelPrHandoffFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      candidateId: "candidate-stale-machine",
      authorityId: "authority-stale-machine",
      actorId: "owner-pr",
      allowedActions: ["commit"],
      confirmationPhrase: wheelPrHandoffConfirmation(staleMachineCandidate.candidate, ["commit"]),
      candidateHash: staleMachineCandidate.candidate.candidateHash,
      expectedHeadSha: staleMachineCandidate.candidate.headSha,
      storyWorkspaceRoot: storyWorktree,
      issuedAt: iso(3_900),
    }), /machine claim, journal, epoch, or control workspace does not match candidate/);

    const pre = prepareWheelPrHandoffCandidateFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      machineId: "machine-pr",
      candidateId: "candidate-pre",
      phase: "pre-commit",
      storyIds: ["PR-STORY-1"],
      storyWorkspaceRoot: storyWorktree,
      baseRef: "develop-staging",
      evidenceRefs: ["evidence/pr-story-1-local-review.json"],
      evidenceHashes: ["c".repeat(64)],
      requestedActions: ["commit"],
      preparedAt: iso(4_000),
    });
    assert.equal(pre.candidate.baseSha, baseSha);
    assert.equal(pre.candidate.headSha, baseSha);
    assert.deepEqual(pre.candidate.storyIds, ["PR-STORY-1"]);
    assert.equal(pre.candidate.storyWorkspaceRootHash, pre.snapshot.workspaceRootHash);
    assert.equal(pre.candidate.authorityGranted, false);
    assert.equal(pre.candidate.commitEnabled, false);

    git(storyWorktree, ["branch", "-m", "feature/wrong-branch"]);
    assert.throws(() => authorizeWheelPrHandoffFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      candidateId: "candidate-pre",
      authorityId: "authority-wrong-branch",
      actorId: "owner-pr",
      allowedActions: ["commit"],
      confirmationPhrase: wheelPrHandoffConfirmation(pre.candidate, ["commit"]),
      candidateHash: pre.candidate.candidateHash,
      expectedHeadSha: pre.candidate.headSha,
      storyWorkspaceRoot: storyWorktree,
      issuedAt: iso(4_250),
    }), /current branch does not match candidate/);
    git(storyWorktree, ["branch", "-m", "feature/pr-story-1"]);

    execFileSync("chmod", ["755", join(storyWorktree, "src.txt")]);
    assert.throws(() => authorizeWheelPrHandoffFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      candidateId: "candidate-pre",
      authorityId: "authority-mode-drift",
      actorId: "owner-pr",
      allowedActions: ["commit"],
      confirmationPhrase: wheelPrHandoffConfirmation(pre.candidate, ["commit"]),
      candidateHash: pre.candidate.candidateHash,
      expectedHeadSha: pre.candidate.headSha,
      storyWorkspaceRoot: storyWorktree,
      issuedAt: iso(4_500),
    }), /current (?:content|diff) hash does not match candidate/);
    execFileSync("chmod", ["644", join(storyWorktree, "src.txt")]);

    const preAuthority = authorizeWheelPrHandoffFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      candidateId: "candidate-pre",
      authorityId: "authority-pre",
      actorId: "owner-pr",
      allowedActions: ["commit"],
      confirmationPhrase: wheelPrHandoffConfirmation(pre.candidate, ["commit"]),
      candidateHash: pre.candidate.candidateHash,
      expectedHeadSha: pre.candidate.headSha,
      storyWorkspaceRoot: storyWorktree,
      issuedAt: iso(5_000),
    });
    assert.equal(preAuthority.validation.valid, true, preAuthority.validation.errors.join("\n"));
    assert.deepEqual(preAuthority.authority.allowedActions, ["commit"]);
    assert.equal(preAuthority.authority.mergeEnabled, false);
    const livePreStatus = inspectWheelPrHandoffStatus(controlRoot, {
      launchId: "launch-pr-handoff",
      candidateId: "candidate-pre",
      authorityId: "authority-pre",
      storyWorkspaceRoot: storyWorktree,
      now: new Date(iso(5_100)),
    });
    assert.equal(livePreStatus.authorityValid, true);
    assert.deepEqual(livePreStatus.allowedActions, ["commit"]);
    const staleMachineStatus = inspectWheelPrHandoffStatus(controlRoot, {
      launchId: "launch-pr-handoff",
      candidateId: "candidate-pre",
      authorityId: "authority-pre",
      storyWorkspaceRoot: storyWorktree,
      now: new Date(iso(12_100)),
    });
    assert.equal(staleMachineStatus.authorityValid, false);
    assert.deepEqual(staleMachineStatus.allowedActions, []);
    assert.ok(staleMachineStatus.errors.includes("machine-ownership-not-live"));

    writeFileSync(join(storyWorktree, "src.txt"), "stale after candidate\n", "utf8");
    assert.throws(() => authorizeWheelPrHandoffFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      candidateId: "candidate-pre",
      authorityId: "authority-pre-stale",
      actorId: "owner-pr",
      allowedActions: ["commit"],
      confirmationPhrase: wheelPrHandoffConfirmation(pre.candidate, ["commit"]),
      candidateHash: pre.candidate.candidateHash,
      expectedHeadSha: pre.candidate.headSha,
      storyWorkspaceRoot: storyWorktree,
      issuedAt: iso(6_000),
    }), /current diff hash does not match candidate/);
    writeFileSync(join(storyWorktree, "src.txt"), "after local review\n", "utf8");

    git(storyWorktree, ["add", "src.txt"]);
    git(storyWorktree, ["commit", "-m", "feat: reviewed story"]);
    const committedHead = git(storyWorktree, ["rev-parse", "HEAD"]);
    assert.notEqual(committedHead, baseSha);
    assert.throws(() => prepareWheelPrHandoffCandidateFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      machineId: "machine-pr",
      candidateId: "candidate-post-without-receipt",
      phase: "post-commit",
      storyIds: ["PR-STORY-1"],
      storyWorkspaceRoot: storyWorktree,
      baseRef: "develop-staging",
      evidenceRefs: ["evidence/pr-story-1-post-commit.json"],
      evidenceHashes: ["d".repeat(64)],
      requestedActions: ["push"],
      preparedAt: iso(6_250),
    }), /requires an exact governed commit receipt/);
    assert.throws(() => recordWheelPrHandoffCommitReceiptFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      receiptId: "receipt-self-asserted",
      preCommitCandidateId: "candidate-pre",
      commitAuthorityId: "authority-pre",
      storyWorkspaceRoot: storyWorktree,
      governedCommitEvidenceRef: "evidence/fake-zcommit.json",
      governedCommitEvidenceHash: "e".repeat(64),
      recordedAt: iso(6_400),
    }), /must be a \.pi\/logs\/zcommit-receipts/);
    const committedTree = git(storyWorktree, ["rev-parse", `${committedHead}^{tree}`]);
    const zcommitReceiptPayload = {
      schema: "zob.zcommit-receipt.v1",
      action: "commit",
      status: "ok",
      repositoryRootHash: sha256Text(git(storyWorktree, ["rev-parse", "--show-toplevel"])),
      baseHeadSha: pre.candidate.headSha,
      committedHeadSha: committedHead,
      treeHash: committedTree,
      branchHash: sha256Text(pre.candidate.branchName),
      eligiblePathHashes: pre.candidate.changedPaths.map((path) => sha256Text(path)).sort(),
      handoffCandidateHash: pre.candidate.candidateHash,
      handoffAuthorityHash: sha256Canonical(preAuthority.authority),
      handoffExpectedBaseSha: pre.candidate.headSha,
      userRequested: true,
      validationOk: true,
      actualGitCommitRun: true,
      actualGitPushRun: false,
      generatedAt: iso(6_000),
      bodyStored: false,
    } as const;
    const zcommitReceipt = { ...zcommitReceiptPayload, receiptHash: sha256Canonical(zcommitReceiptPayload) };
    const zcommitReceiptRef = `.pi/logs/zcommit-receipts/${committedHead}.json`;
    mkdirSync(join(storyWorktree, ".pi/logs/zcommit-receipts"), { recursive: true });
    const zcommitReceiptRaw = `${JSON.stringify(zcommitReceipt, null, 2)}\n`;
    const outsideReceipt = join(root, "forged-zcommit-receipt.json");
    writeFileSync(outsideReceipt, zcommitReceiptRaw, "utf8");
    symlinkSync(outsideReceipt, join(storyWorktree, zcommitReceiptRef));
    assert.throws(() => recordWheelPrHandoffCommitReceiptFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      receiptId: "receipt-symlink",
      preCommitCandidateId: "candidate-pre",
      commitAuthorityId: "authority-pre",
      storyWorkspaceRoot: storyWorktree,
      governedCommitEvidenceRef: zcommitReceiptRef,
      governedCommitEvidenceHash: sha256(zcommitReceiptRaw),
      recordedAt: iso(6_450),
    }), /must not traverse symlinks/);
    unlinkSync(join(storyWorktree, zcommitReceiptRef));
    writeFileSync(join(storyWorktree, zcommitReceiptRef), zcommitReceiptRaw, "utf8");
    const commitReceipt = recordWheelPrHandoffCommitReceiptFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      receiptId: "receipt-commit",
      preCommitCandidateId: "candidate-pre",
      commitAuthorityId: "authority-pre",
      storyWorkspaceRoot: storyWorktree,
      governedCommitEvidenceRef: zcommitReceiptRef,
      governedCommitEvidenceHash: sha256(zcommitReceiptRaw),
      recordedAt: iso(6_500),
    });
    assert.equal(commitReceipt.receipt.committedHeadSha, committedHead);
    assert.equal(commitReceipt.receipt.contentHash, pre.candidate.contentHash);
    assert.equal(commitReceipt.receipt.pushEnabled, false);
    const post = prepareWheelPrHandoffCandidateFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      machineId: "machine-pr",
      candidateId: "candidate-post",
      phase: "post-commit",
      storyIds: ["PR-STORY-1"],
      storyWorkspaceRoot: storyWorktree,
      baseRef: "develop-staging",
      commitReceiptId: "receipt-commit",
      evidenceRefs: ["evidence/pr-story-1-post-commit.json"],
      evidenceHashes: ["d".repeat(64)],
      requestedActions: ["push", "create-draft-pr", "observe-ci", "pr-close"],
      preparedAt: iso(7_000),
    });
    assert.equal(post.candidate.headSha, committedHead);
    assert.equal(post.candidate.baseSha, baseSha);
    assert.equal(post.snapshot.clean, true);
    const postActions = ["push", "create-draft-pr"] as const;
    const postAuthority = authorizeWheelPrHandoffFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      candidateId: "candidate-post",
      authorityId: "authority-post",
      actorId: "owner-pr",
      allowedActions: [...postActions],
      confirmationPhrase: wheelPrHandoffConfirmation(post.candidate, postActions),
      candidateHash: post.candidate.candidateHash,
      expectedHeadSha: post.candidate.headSha,
      storyWorkspaceRoot: storyWorktree,
      issuedAt: iso(8_000),
    });
    assert.equal(postAuthority.validation.valid, true, postAuthority.validation.errors.join("\n"));
    assert.deepEqual(postAuthority.validation.allowedActions, postActions);
    assert.equal(validateWheelPrHandoffAuthority(post.candidate, postAuthority.authority, {
      now: iso(9_000),
      currentBaseSha: baseSha,
      currentHeadSha: committedHead,
      currentContentHash: post.candidate.contentHash,
      currentDiffHash: post.candidate.diffHash,
      currentBranchName: post.candidate.branchName,
      currentStoryWorkspaceRootHash: post.snapshot.workspaceRootHash,
      currentMachineClaimId: post.candidate.workspaceClaimId,
      currentMachineJournalHeadHash: post.candidate.machineJournalHeadHash,
      currentMachineOwnershipEpoch: post.candidate.machineOwnershipEpoch,
      currentMachineControlWorkspaceRootHash: post.candidate.machineControlWorkspaceRootHash,
    }).valid, true);
    assert.throws(() => authorizeWheelPrHandoffFromWorkspace(controlRoot, {
      launchId: "launch-pr-handoff",
      candidateId: "candidate-post",
      authorityId: "authority-expired-machine",
      actorId: "owner-pr",
      allowedActions: ["push"],
      confirmationPhrase: wheelPrHandoffConfirmation(post.candidate, ["push"]),
      candidateHash: post.candidate.candidateHash,
      expectedHeadSha: post.candidate.headSha,
      storyWorkspaceRoot: storyWorktree,
      issuedAt: iso(12_000),
    }), /machine state is not valid, checkpointed, live, and claimed/);
    assert.equal(git(storyWorktree, ["status", "--porcelain"]), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
