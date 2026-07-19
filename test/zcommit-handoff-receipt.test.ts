import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createZcommitRuntimeState, runGovernedZcommitCommit } from "../.pi/extensions/zob-harness/src/domains/git/git-ops.js";
import { writeZcommitReceipt } from "../.pi/extensions/zob-harness/src/runtime/tools-zcommit.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("governed zcommit emits an exact candidate/authority/base-bound no-push receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "zcommit-handoff-receipt-"));
  try {
    git(root, ["init", "-b", "feature/zcommit-receipt"]);
    git(root, ["config", "user.email", "wheel-test@example.invalid"]);
    git(root, ["config", "user.name", "Wheel Test"]);
    mkdirSync(join(root, ".pi"), { recursive: true });
    const policy = JSON.parse(readFileSync(join(process.cwd(), ".pi/git-policy.json"), "utf8")) as Record<string, unknown>;
    (policy.validation as Record<string, unknown>).mode = "off";
    (policy.validation as Record<string, unknown>).runBeforeCommit = false;
    writeFileSync(join(root, ".pi/git-policy.json"), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    writeFileSync(join(root, ".gitignore"), ".pi/logs/\n", "utf8");
    writeFileSync(join(root, "src.txt"), "before\n", "utf8");
    git(root, ["add", ".gitignore", ".pi/git-policy.json", "src.txt"]);
    git(root, ["commit", "-m", "test: initialize receipt fixture"]);
    const baseHeadSha = git(root, ["rev-parse", "HEAD"]);

    writeFileSync(join(root, "src.txt"), "after\n", "utf8");
    const runtime = createZcommitRuntimeState();
    const result = runGovernedZcommitCommit(root, runtime, {
      pathspecs: ["src.txt"],
      message: "test(zcommit): bind handoff receipt",
    });
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.baseHeadSha, baseHeadSha);
    assert.equal(result.actualGitCommitRun, true);
    assert.equal(result.actualGitPushRun, false);
    assert.equal(result.validation?.ok, true);

    const candidateHash = "c".repeat(64);
    const authorityHash = "a".repeat(64);
    const written = writeZcommitReceipt(root, {
      user_requested: true,
      handoff_candidate_hash: candidateHash,
      handoff_authority_hash: authorityHash,
      handoff_expected_base_sha: baseHeadSha,
    }, result);
    const raw = readFileSync(join(root, written.receiptRef), "utf8");
    const receipt = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(written.receiptFileHash, sha256(raw));
    assert.equal(receipt.schema, "zob.zcommit-receipt.v1");
    assert.equal(receipt.baseHeadSha, baseHeadSha);
    assert.equal(receipt.committedHeadSha, result.commit?.hash);
    assert.equal(receipt.handoffCandidateHash, candidateHash);
    assert.equal(receipt.handoffAuthorityHash, authorityHash);
    assert.equal(receipt.userRequested, true);
    assert.equal(receipt.validationOk, true);
    assert.equal(receipt.actualGitCommitRun, true);
    assert.equal(receipt.actualGitPushRun, false);
    assert.equal(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
