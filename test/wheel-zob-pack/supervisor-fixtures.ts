import { readFileSync } from "node:fs";

import {
  DEFAULT_WHEEL_SUPERVISOR_BUDGET_POLICY,
  createDeterministicFakeWheelSupervisorAuthority,
  ingestFleetV5StoryBundle,
  planWheelMission,
  sha256Canonical,
  type WheelStoryExecution,
  type WheelSupervisorAdmissionInput,
} from "../../packages/wheel-zob-pack/index.js";

export function supervisorStory(storyId: string, dependencies: WheelStoryExecution["dependencies"] = []): WheelStoryExecution {
  const story = JSON.parse(readFileSync("docs/zob/examples/story-execution.example.json", "utf8")) as WheelStoryExecution;
  story.storyId = storyId;
  story.title = `${storyId} supervisor fixture`;
  story.dependencies = structuredClone(dependencies);
  story.branchContract = { branchName: `feature/${storyId.toLowerCase()}`, prTarget: "develop-staging", draftRequired: true };
  story.humanGateRefs = [];
  story.signals = { ...story.signals, humanCheckpoint: null, parallelizable: true };
  return story;
}

export function supervisorAdmissionInput(
  stories: WheelStoryExecution[],
  overrides: Partial<WheelSupervisorAdmissionInput> = {},
): WheelSupervisorAdmissionInput {
  const intake = ingestFleetV5StoryBundle({
    schema: "wheel.zob.fleet-v5-bundle.v1",
    bundleId: "supervisor-test-bundle",
    missionSeed: "supervisor-test-seed",
    stories,
  });
  if (!intake.accepted) throw new Error(intake.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  const plan = planWheelMission({ missionId: "supervisor-test", intake });
  if (!plan.planned) throw new Error(plan.errors.join("\n"));
  return {
    missionId: "supervisor-test",
    bundleId: "supervisor-test-bundle",
    bundleHash: "b".repeat(64),
    sourceSha: "a".repeat(40),
    repositoryId: "fixture/repository",
    checkPolicy: {
      requiredCiChecks: [{ name: "CI / Required", issuerHash: sha256Canonical("fixture-ci-issuer") }],
      prCloseCheck: { name: "ZOB / PR Close", issuerHash: sha256Canonical("fixture-pr-close-issuer") },
      completionLabel: "needs-review",
      bodyStored: false,
    },
    stories: stories.map((manifest) => ({
      machineId: "W1",
      allocationUnitIds: [manifest.storyId],
      storyPath: `fixtures/${manifest.storyId}.json`,
      manifestHash: sha256Canonical(manifest),
      manifest,
    })),
    protectedPlan: plan.protectedPlan,
    authority: createDeterministicFakeWheelSupervisorAuthority(),
    budgetPolicy: DEFAULT_WHEEL_SUPERVISOR_BUDGET_POLICY,
    ownerId: "supervisor-test-owner",
    admittedAt: "2026-07-19T12:00:00.000Z",
    ...overrides,
  };
}
