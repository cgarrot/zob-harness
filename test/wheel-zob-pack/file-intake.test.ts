import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import {
  computeWheelFleetV5MachineBundleHash,
  previewWheelMachineMissionFromFile,
  previewWheelMissionFromFiles,
  validateWheelStoryFile,
  type WheelFleetV5MachineBundle,
} from "../../packages/wheel-zob-pack/index.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("validates a repo-local Fleet v5 story file", () => {
  const result = validateWheelStoryFile(process.cwd(), "docs/zob/examples/story-execution.example.json");
  assert.equal(result.valid, true, result.issues.map((item) => item.message).join("\n"));
  assert.equal(result.storyId, "H31");
  assert.equal(result.bodyStored, false);
});

test("previews a file-backed mission without identities or dispatch", () => {
  const preview = previewWheelMissionFromFiles(process.cwd(), { missionId: "file-preview", storyPaths: ["docs/zob/examples/story-execution.example.json"] });
  assert.equal(preview.planned, true, preview.errors.join("\n"));
  if (preview.result?.planned !== true) return;
  assert.equal(preview.result.publicPlan.dispatchEnabled, false);
  assert.equal(preview.result.publicPlan.modelIdentityStored, false);
  assert.equal(JSON.stringify(preview.result.publicPlan).includes("accounts/fireworks"), false);
});

test("bounds file-backed missions to 100 story paths before file reads", () => {
  const preview = previewWheelMissionFromFiles(process.cwd(), {
    missionId: "too-many-stories",
    storyPaths: Array.from({ length: 101 }, () => "docs/zob/examples/story-execution.example.json"),
  });
  assert.equal(preview.planned, false);
  assert.deepEqual(preview.errors, ["at most 100 story paths are allowed"]);
});

test("blocks traversal, sessions, secrets, credentials, and key files", () => {
  for (const path of [
    "../outside.json",
    ".env",
    "node_modules/fake.json",
    ".pi/sessions/session.json",
    ".pi/agent-sessions/session.json",
    "fixtures/api-secret.json",
    "fixtures/provider-credentials.json",
    "fixtures/private-key.pem",
    "/tmp/story.json",
  ]) {
    const result = validateWheelStoryFile(process.cwd(), path);
    assert.equal(result.valid, false, path);
  }
});

test("blocks innocently named in-repository symlinks into forbidden targets", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "wheel-intake-forbidden-link-"));
  try {
    const targetPaths = [
      join(repoRoot, ".pi", "sessions", "story.json"),
      join(repoRoot, ".env"),
      join(repoRoot, "safe", "provider-credentials.json"),
      join(repoRoot, "safe", "private-key.pem"),
    ];
    targetPaths.forEach((targetPath, index) => {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, "{}", "utf8");
      const alias = `story-alias-${index}.json`;
      symlinkSync(targetPath, join(repoRoot, alias));
      const result = validateWheelStoryFile(repoRoot, alias);
      assert.equal(result.valid, false, targetPath);
      assert.match(result.issues[0]?.message ?? "", /resolved path is forbidden by Wheel pack policy/);
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("blocks symlinks that resolve outside the repository root", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "wheel-intake-root-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "wheel-intake-outside-"));
  try {
    const outsideFile = join(outsideRoot, "story.json");
    writeFileSync(outsideFile, "{}", "utf8");
    symlinkSync(outsideFile, join(repoRoot, "story-link.json"));
    const result = validateWheelStoryFile(repoRoot, "story-link.json");
    assert.equal(result.valid, false);
    assert.match(result.issues[0]?.message ?? "", /resolved path must stay inside repository root/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("previews one validated machine assignment from a source-bound machine bundle", () => {
  const tempRoot = mkdtempSync(join(process.cwd(), "wheel-machine-preview-"));
  try {
    const storyOneRaw = readFileSync("docs/zob/examples/story-execution.example.json", "utf8");
    const storyOne = JSON.parse(storyOneRaw) as Record<string, unknown>;
    storyOne.storyId = "M1-A";
    storyOne.title = "Machine one story";
    storyOne.dependencies = [];
    storyOne.branchContract = { branchName: "feature/M1-A", prTarget: "develop-staging", draftRequired: true };
    const storyTwo = structuredClone(storyOne);
    storyTwo.storyId = "M2-A";
    storyTwo.title = "Machine two story";
    storyTwo.dependencies = [{ storyId: "M1-A", type: "artifact", prBaseRef: "machine:W1" }];
    storyTwo.branchContract = { branchName: "feature/M2-A", prTarget: "develop-staging", draftRequired: true };
    storyTwo.humanGateRefs = ["docs/zob/03-STORY_TO_PR_CLOSE_FACTORY.md"];

    const storyOnePath = join(tempRoot, "M1-A.json");
    const storyTwoPath = join(tempRoot, "M2-A.json");
    const storyOneOutput = `${JSON.stringify(storyOne, null, 2)}\n`;
    const storyTwoOutput = `${JSON.stringify(storyTwo, null, 2)}\n`;
    writeFileSync(storyOnePath, storyOneOutput, "utf8");
    writeFileSync(storyTwoPath, storyTwoOutput, "utf8");
    const allocationRaw = "{\"plan\":\"test\"}\n";
    const signalsRaw = "{\"stories\":{}}\n";
    const allocationPath = join(tempRoot, "allocation.json");
    const signalsPath = join(tempRoot, "signals.json");
    writeFileSync(allocationPath, allocationRaw, "utf8");
    writeFileSync(signalsPath, signalsRaw, "utf8");

    const relativeStoryOne = relative(process.cwd(), storyOnePath);
    const relativeStoryTwo = relative(process.cwd(), storyTwoPath);
    const relativeAllocation = relative(process.cwd(), allocationPath);
    const relativeSignals = relative(process.cwd(), signalsPath);
    const bundle = {
      schema: "wheel.zob.fleet-v5-machine-bundle.v1",
      bundleId: "machine-preview",
      revision: 1,
      source: {
        repositoryId: "example/repository",
        sourceSha: "a".repeat(40),
        allocationRef: relativeAllocation,
        allocationSha256: sha256(allocationRaw),
        signalsRef: relativeSignals,
        signalsSha256: sha256(signalsRaw),
      },
      machines: [
        { machineId: "W1", theme: "One", allocationUnitIds: ["M1-A"], storyIds: ["M1-A"], storyPaths: [relativeStoryOne] },
        { machineId: "W2", theme: "Two", allocationUnitIds: ["M2-A"], storyIds: ["M2-A"], storyPaths: [relativeStoryTwo] },
      ],
    } as Omit<WheelFleetV5MachineBundle, "bundleHash">;
    const storyHashes = { [relativeStoryOne]: sha256(storyOneOutput), [relativeStoryTwo]: sha256(storyTwoOutput) };
    const completeBundle: WheelFleetV5MachineBundle = {
      ...bundle,
      bundleHash: computeWheelFleetV5MachineBundleHash(bundle, storyHashes),
    };
    const bundlePath = join(tempRoot, "machine-bundle.json");
    writeFileSync(bundlePath, `${JSON.stringify(completeBundle, null, 2)}\n`, "utf8");

    const preview = previewWheelMachineMissionFromFile(process.cwd(), {
      missionId: "machine-preview",
      machineId: "W2",
      bundlePath: relative(process.cwd(), bundlePath),
    });
    assert.equal(preview.planned, true, preview.errors.join("\n"));
    assert.deepEqual(preview.storyIds, ["M2-A"]);
    assert.deepEqual(preview.storyPaths, [relativeStoryTwo]);
    assert.deepEqual(preview.humanGateStoryIds, ["M2-A"]);
    assert.equal(preview.result?.planned, true);

    const missing = previewWheelMachineMissionFromFile(process.cwd(), {
      missionId: "machine-preview",
      machineId: "W9",
      bundlePath: relative(process.cwd(), bundlePath),
    });
    assert.equal(missing.planned, false);
    assert.match(missing.errors[0] ?? "", /machine W9 is not assigned/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
