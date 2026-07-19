import assert from "node:assert/strict";
import test from "node:test";

import {
  computeWheelFleetV5MachineBundleHash,
  validateWheelFleetV5MachineBundle,
  type WheelFleetV5MachineBundle,
} from "../../packages/wheel-zob-pack/index.js";

function exampleBundle(): WheelFleetV5MachineBundle {
  return {
    schema: "wheel.zob.fleet-v5-machine-bundle.v1",
    bundleId: "pr3853-fleet-v5",
    revision: 1,
    bundleHash: "f".repeat(64),
    source: {
      repositoryId: "Join-The-Wheel/jointhewheel",
      sourceSha: "a".repeat(40),
      allocationRef: "scripts/model-bakeoff/routing/allocation-plan-v5.json",
      allocationSha256: "b".repeat(64),
      signalsRef: "scripts/model-bakeoff/routing/story-signals-v5.json",
      signalsSha256: "c".repeat(64),
    },
    machines: [
      {
        machineId: "W1",
        theme: "Guardrails",
        allocationUnitIds: ["SR-002"],
        storyIds: ["SR-002"],
        storyPaths: ["docs/operations/fleet-v5/zob/stories/SR-002.json"],
      },
      {
        machineId: "W5",
        theme: "Widgets",
        allocationUnitIds: ["W4-B/W4-C"],
        storyIds: ["W4-B", "W4-C"],
        storyPaths: [
          "docs/operations/fleet-v5/zob/stories/W4-B.json",
          "docs/operations/fleet-v5/zob/stories/W4-C.json",
        ],
      },
    ],
  };
}

test("accepts explicit machine assignments including one composite allocation unit with two stories", () => {
  const result = validateWheelFleetV5MachineBundle(exampleBundle());
  assert.equal(result.accepted, true, result.issues.map((item) => `${item.path}: ${item.message}`).join("\n"));
  assert.deepEqual(result.value?.machines[1]?.allocationUnitIds, ["W4-B/W4-C"]);
  assert.deepEqual(result.value?.machines[1]?.storyIds, ["W4-B", "W4-C"]);
});

test("rejects duplicate machines, stories, allocation units, and unsafe paths", () => {
  const bundle = exampleBundle();
  bundle.machines.push({
    machineId: "W1",
    theme: "Duplicate",
    allocationUnitIds: ["SR-002"],
    storyIds: ["SR-002"],
    storyPaths: ["../outside.json"],
  });
  const result = validateWheelFleetV5MachineBundle(bundle);
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some((item) => item.code === "duplicate" && item.message.includes("machineId W1")));
  assert.ok(result.issues.some((item) => item.code === "duplicate" && item.message.includes("storyId SR-002")));
  assert.ok(result.issues.some((item) => item.code === "duplicate" && item.message.includes("allocation unit SR-002")));
  assert.ok(result.issues.some((item) => item.path.endsWith("storyPaths[0]") && item.code === "pattern"));
});

test("canonical structured hashing separates delimiter-shaped schema-valid assignments", () => {
  const firstBundle = exampleBundle();
  firstBundle.machines = [{
    ...firstBundle.machines[0]!,
    theme: "t\nallocation:x",
    allocationUnitIds: ["y"],
  }];
  const secondBundle = structuredClone(firstBundle);
  secondBundle.machines[0]!.theme = "t";
  secondBundle.machines[0]!.allocationUnitIds = ["x\nallocation:y"];
  const firstValidation = validateWheelFleetV5MachineBundle(firstBundle);
  const secondValidation = validateWheelFleetV5MachineBundle(secondBundle);
  assert.equal(firstValidation.accepted, true, firstValidation.issues.map((item) => item.message).join("\n"));
  assert.equal(secondValidation.accepted, true, secondValidation.issues.map((item) => item.message).join("\n"));
  assert.notDeepEqual(firstBundle.machines, secondBundle.machines);
  const storyFileHashes = { [firstBundle.machines[0]!.storyPaths[0]!]: "1".repeat(64) };
  assert.notEqual(
    computeWheelFleetV5MachineBundleHash(firstBundle, storyFileHashes),
    computeWheelFleetV5MachineBundleHash(secondBundle, storyFileHashes),
  );
});

test("computes a deterministic hash over source, assignments, and story file hashes", () => {
  const bundle = exampleBundle();
  const storyFileHashes = Object.fromEntries(
    bundle.machines.flatMap((machine) => machine.storyPaths).map((path, index) => [path, String(index + 1).repeat(64)]),
  );
  const first = computeWheelFleetV5MachineBundleHash(bundle, storyFileHashes);
  const second = computeWheelFleetV5MachineBundleHash(bundle, storyFileHashes);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  storyFileHashes[bundle.machines[0]?.storyPaths[0] as string] = "9".repeat(64);
  assert.notEqual(computeWheelFleetV5MachineBundleHash(bundle, storyFileHashes), first);
});
