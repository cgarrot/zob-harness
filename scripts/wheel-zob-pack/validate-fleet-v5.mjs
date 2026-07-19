import { readFileSync } from "node:fs";

import { ingestFleetV5StoryBundle } from "../../packages/wheel-zob-pack/index.ts";

const storyPath = process.argv[2] ?? "docs/zob/examples/story-execution.example.json";
const story = JSON.parse(readFileSync(storyPath, "utf8"));
const result = ingestFleetV5StoryBundle({
  schema: "wheel.zob.fleet-v5-bundle.v1",
  bundleId: "wheel-zob-validation",
  missionSeed: "wheel-zob-validation-seed",
  stories: [story],
});

if (!result.accepted) {
  console.error("WHEEL_FLEET_V5_FAIL");
  for (const item of result.issues) console.error(`- ${item.path} [${item.code}] ${item.message}`);
  process.exitCode = 1;
} else {
  console.log(`WHEEL_FLEET_V5_PASS stories=${result.storyIds.length} signals=17 body_stored=${result.bodyStored}`);
}
