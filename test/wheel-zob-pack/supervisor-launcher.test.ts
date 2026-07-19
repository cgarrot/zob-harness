import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import {
  computeWheelFleetV5MachineBundleHash,
  initializeWheelSupervisorFromMachineBundle,
  prepareWheelSupervisorFromMachineBundle,
  resolveWheelSupervisorStateDirectory,
  runWheelSupervisorFakeFromMachineBundle,
  validateWheelSupervisorPersistedState,
  FileWheelSupervisorStore,
  type WheelFleetV5MachineBundle,
} from "../../packages/wheel-zob-pack/index.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function machineFixture(): { root: string; bundlePath: string; storyTwoPath: string } {
  const root = mkdtempSync(join(process.cwd(), "wheel-supervisor-launcher-"));
  const raw = readFileSync("docs/zob/examples/story-execution.example.json", "utf8");
  const first = JSON.parse(raw) as Record<string, unknown>;
  first.storyId = "W1-A";
  first.title = "First machine story";
  first.dependencies = [];
  first.humanGateRefs = [];
  first.branchContract = { branchName: "feature/W1-A", prTarget: "develop-staging", draftRequired: true };
  const second = structuredClone(first);
  second.storyId = "W2-A";
  second.title = "Second machine story";
  second.dependencies = [{ storyId: "W1-A", type: "artifact", prBaseRef: "machine:W1" }];
  second.humanGateRefs = ["docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md"];
  second.branchContract = { branchName: "feature/W2-A", prTarget: "develop-staging", draftRequired: true };
  const firstRaw = `${JSON.stringify(first, null, 2)}\n`;
  const secondRaw = `${JSON.stringify(second, null, 2)}\n`;
  const firstPath = join(root, "W1-A.json");
  const secondPath = join(root, "W2-A.json");
  writeFileSync(firstPath, firstRaw, "utf8");
  writeFileSync(secondPath, secondRaw, "utf8");
  const allocationRaw = "{\"plan\":\"launcher-test\"}\n";
  const signalsRaw = "{\"stories\":{}}\n";
  writeFileSync(join(root, "allocation.json"), allocationRaw, "utf8");
  writeFileSync(join(root, "signals.json"), signalsRaw, "utf8");
  const bundleWithoutHash: Omit<WheelFleetV5MachineBundle, "bundleHash"> = {
    schema: "wheel.zob.fleet-v5-machine-bundle.v1",
    bundleId: "launcher-test-bundle",
    revision: 1,
    source: {
      repositoryId: "fixture/repository",
      sourceSha: "a".repeat(40),
      allocationRef: "allocation.json",
      allocationSha256: sha256(allocationRaw),
      signalsRef: "signals.json",
      signalsSha256: sha256(signalsRaw),
    },
    machines: [
      { machineId: "W1", theme: "First", allocationUnitIds: ["W1-A"], storyIds: ["W1-A"], storyPaths: ["W1-A.json"] },
      { machineId: "W2", theme: "Second", allocationUnitIds: ["W2-A"], storyIds: ["W2-A"], storyPaths: ["W2-A.json"] },
    ],
  };
  const bundle: WheelFleetV5MachineBundle = {
    ...bundleWithoutHash,
    bundleHash: computeWheelFleetV5MachineBundleHash(bundleWithoutHash, {
      "W1-A.json": sha256(firstRaw),
      "W2-A.json": sha256(secondRaw),
    }),
  };
  const bundlePath = join(root, "machine-bundle.json");
  writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { root, bundlePath: relative(root, bundlePath), storyTwoPath: secondPath };
}

test("prepares every selected machine as one immutable source-bound supervisor mission", () => {
  const fixture = machineFixture();
  try {
    const prepared = prepareWheelSupervisorFromMachineBundle(fixture.root, {
      missionId: "launcher-test",
      bundlePath: fixture.bundlePath,
      mode: "disabled",
      admittedAt: "2026-07-19T12:00:00.000Z",
    });
    assert.equal(prepared.summary.prepared, true, prepared.summary.errors.join("\n"));
    assert.deepEqual(prepared.summary.machineIds, ["W1", "W2"]);
    assert.deepEqual(prepared.summary.storyIds, ["W1-A", "W2-A"]);
    assert.deepEqual(prepared.summary.humanGateStoryIds, ["W2-A"]);
    assert.equal(prepared.summary.dispatchEnabled, false);
    assert.equal(prepared.summary.githubEffectsEnabled, false);
    assert.equal(prepared.admission?.protectedPlan.stories.length, 2);
    assert.equal(prepared.admission?.stories.every((story) => story.manifestHash.length === 64), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("initializes disabled durable state and runs the full selected bundle only through deterministic fakes", async () => {
  const fixture = machineFixture();
  try {
    const disabled = initializeWheelSupervisorFromMachineBundle(fixture.root, {
      missionId: "launcher-disabled",
      bundlePath: fixture.bundlePath,
      stateDirectory: "reports/wheel-zob/supervisor/launcher-disabled",
      mode: "disabled",
      admittedAt: "2026-07-19T12:00:00.000Z",
    });
    assert.equal(disabled.state?.status, "admitted");
    assert.equal(disabled.state?.mode, "disabled");
    assert.equal(disabled.state?.journalSequence, 1);

    const fake = await runWheelSupervisorFakeFromMachineBundle(fixture.root, {
      missionId: "launcher-fake",
      bundlePath: fixture.bundlePath,
      stateDirectory: "reports/wheel-zob/supervisor/launcher-fake",
      admittedAt: "2026-07-19T12:00:00.000Z",
      maxTicks: 100,
    });
    assert.equal(fake.run?.status, "needs-human");
    assert.equal(fake.state?.stories["W1-A"]?.stage, "needs-review");
    assert.equal(fake.state?.stories["W2-A"]?.stage, "needs-human");
    assert.equal(fake.run?.externalEffectsPerformed, false);
    assert.equal(fake.run?.providerCallsPerformed, false);
    assert.equal(fake.state?.budgetLedger.settledCostUsd, 0);
    const validation = validateWheelSupervisorPersistedState(new FileWheelSupervisorStore(fake.stateDirectory));
    assert.equal(validation.valid, true, validation.issueCodes.join("\n"));
    assert.equal(validation.storyCount, 2);
    assert.deepEqual(validation.completedStoryIds, ["W1-A"]);
    assert.deepEqual(validation.needsHumanStoryIds, ["W2-A"]);
    assert.deepEqual(validation.dependencyBlockedStoryIds, []);
    assert.deepEqual(validation.noShipReasons, ["story:W2-A:needs-human"]);
    assert.equal(validation.journalHeadHash?.length, 64);
    assert.equal(validation.projectionHash?.length, 64);
    assert.equal(validation.checkpoint?.projectionHash.length, 64);
    assert.equal((validation.journalEventKindCounts["mission-needs-human"] ?? 0) > 0, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("supports one-machine selection while still validating the whole bundle", async () => {
  const fixture = machineFixture();
  try {
    const fake = await runWheelSupervisorFakeFromMachineBundle(fixture.root, {
      missionId: "launcher-w1",
      bundlePath: fixture.bundlePath,
      machineIds: ["W1"],
      stateDirectory: "reports/wheel-zob/supervisor/launcher-w1",
      admittedAt: "2026-07-19T12:00:00.000Z",
      maxTicks: 100,
    });
    assert.equal(fake.run?.status, "complete");
    assert.deepEqual(Object.keys(fake.state?.stories ?? {}), ["W1-A"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("launcher rejects unsafe state paths, stale files, and missing machines", () => {
  const fixture = machineFixture();
  try {
    assert.throws(() => resolveWheelSupervisorStateDirectory(fixture.root, "../outside"), /must stay under/);
    const missing = prepareWheelSupervisorFromMachineBundle(fixture.root, {
      missionId: "launcher-missing",
      bundlePath: fixture.bundlePath,
      machineIds: ["W9"],
    });
    assert.equal(missing.summary.prepared, false);
    assert.match(missing.summary.errors[0] ?? "", /machine W9 is not assigned/);
    writeFileSync(fixture.storyTwoPath, "{}\n", "utf8");
    const stale = prepareWheelSupervisorFromMachineBundle(fixture.root, {
      missionId: "launcher-stale",
      bundlePath: fixture.bundlePath,
    });
    assert.equal(stale.summary.prepared, false);
    assert.equal(stale.summary.errors.some((error) => error.includes("bundle hash") || error.includes("expected storyId")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
