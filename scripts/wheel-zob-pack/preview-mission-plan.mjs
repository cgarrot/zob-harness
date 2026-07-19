import { readFileSync } from "node:fs";

import { ingestFleetV5StoryBundle, planWheelMission } from "../../packages/wheel-zob-pack/index.ts";

const storyPath = process.argv[2] ?? "docs/zob/examples/story-execution.example.json";
const story = JSON.parse(readFileSync(storyPath, "utf8"));
const intake = ingestFleetV5StoryBundle({
  schema: "wheel.zob.fleet-v5-bundle.v1",
  bundleId: "wheel-zob-preview",
  missionSeed: "wheel-zob-preview-seed",
  stories: [story],
});
const result = planWheelMission({ missionId: "wheel-zob-preview", intake });
if (!result.planned) {
  console.error("WHEEL_MISSION_PLAN_FAIL");
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result.publicPlan, null, 2));
  console.error(`WHEEL_MISSION_PLAN_PASS stories=${result.publicPlan.storyCount} dispatch=${result.publicPlan.dispatchEnabled} identities=${result.publicPlan.modelIdentityStored}`);
}
