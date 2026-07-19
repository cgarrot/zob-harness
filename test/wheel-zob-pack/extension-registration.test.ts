import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import wheelZobPackExtension from "../../.pi/extensions/wheel-zob-pack/index.js";
import {
  DeterministicFakeWheelDispatchAdapter,
  DeterministicFakeWheelStoryEffectBroker,
  FileWheelSupervisorStore,
  WheelFleetSupervisor,
  admitWheelSupervisorMission,
  computeWheelFleetV5MachineBundleHash,
  type WheelFleetV5MachineBundle,
} from "../../packages/wheel-zob-pack/index.js";
import { supervisorAdmissionInput, supervisorStory } from "./supervisor-fixtures.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("registers bounded Wheel tools and in-Pi command", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const fakePi = {
    registerTool(definition: { name: string }) { tools.push(definition.name); },
    registerCommand(name: string) { commands.push(name); },
    on(name: string) { events.push(name); },
  } as unknown as ExtensionAPI;

  wheelZobPackExtension(fakePi);
  assert.deepEqual(tools.sort(), ["wheel_zob_preview_mission", "wheel_zob_simulate_pipeline", "wheel_zob_validate_story"]);
  assert.deepEqual(commands, ["wheel-zob"]);
  assert.ok(events.includes("session_start"));
});

test("mission preview tool returns public plan details only", async () => {
  const tools = new Map<string, Record<string, unknown>>();
  const fakePi = {
    registerTool(definition: Record<string, unknown>) { tools.set(String(definition.name), definition); },
    registerCommand() {},
    on() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;

  wheelZobPackExtension(fakePi);
  const definition = tools.get("wheel_zob_preview_mission");
  const execute = definition?.execute as ((...args: unknown[]) => Promise<{ details: Record<string, unknown> }>) | undefined;
  assert.equal(typeof execute, "function");
  const result = await execute?.("tool-call", { mission_id: "public-details", story_paths: ["docs/zob/examples/story-execution.example.json"] }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(result?.details.planned, true);
  assert.equal(result?.details.modelIdentityStored, false);
  assert.equal(result?.details.protectedPlanReturned, false);
  assert.equal("result" in (result?.details ?? {}), false);
  assert.equal(JSON.stringify(result?.details).includes("accounts/fireworks"), false);
  assert.equal(JSON.stringify(result?.details).includes("openai-codex"), false);
});

test("run command starts one dependency-aware Pi turn for a story set", async () => {
  const commands = new Map<string, Record<string, unknown>>();
  const entries: Array<{ customType: string; data: Record<string, unknown> }> = [];
  let sentMessage = "";
  let sessionName = "";
  const fakePi = {
    registerTool() {},
    registerCommand(name: string, definition: Record<string, unknown>) { commands.set(name, definition); },
    on() {},
    appendEntry(customType: string, data: Record<string, unknown>) { entries.push({ customType, data }); },
    getSessionName() { return undefined; },
    setSessionName(name: string) { sessionName = name; },
    sendUserMessage(message: string) { sentMessage = message; },
  } as unknown as ExtensionAPI;

  const tempRoot = mkdtempSync(join(process.cwd(), "wheel-run-command-"));
  try {
    const sourcePath = "docs/zob/examples/story-execution.example.json";
    const secondStory = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    secondStory.storyId = "H32";
    secondStory.title = "Dependent example story";
    secondStory.dependencies = [{ storyId: "H31", type: "hard" }];
    secondStory.gates = [{ gateId: "H32:G4", manifestRef: "execution/gates/H32-G4.json", manifestHash: "d".repeat(64), required: true }];
    secondStory.branchContract = { branchName: "feature/H32", prTarget: "develop-staging", draftRequired: true };
    const secondPath = join(tempRoot, "story-H32.json");
    writeFileSync(secondPath, JSON.stringify(secondStory), "utf8");
    const secondRelativePath = relative(process.cwd(), secondPath);

    wheelZobPackExtension(fakePi);
    const definition = commands.get("wheel-zob");
    const handler = definition?.handler as ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
    assert.equal(typeof handler, "function");
    const notices: string[] = [];
    await handler?.(`run story-set ${sourcePath} ${secondRelativePath}`, {
      cwd: process.cwd(),
      isIdle: () => true,
      ui: { notify(message: string) { notices.push(message); } },
    });

    assert.equal(sessionName, "Wheel mission story-set");
    assert.match(sentMessage, /^WHEEL_ZOB_RUN\.v1/m);
    assert.match(sentMessage, /H31 revision 2/);
    assert.match(sentMessage, /H32 revision 2/);
    assert.match(sentMessage, /hard\/stack dependencies first/);
    assert.equal(sentMessage.includes("accounts/fireworks"), false);
    assert.equal(sentMessage.includes("openai-codex/"), false);
    assert.equal(entries.at(-1)?.data.storyCount, 2);
    assert.equal(entries.at(-1)?.data.githubEffectsEnabled, false);
    assert.equal(entries.at(-1)?.data.deploymentEnabled, false);
    assert.match(notices.at(-1) ?? "", /2 story\(s\) in Pi/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("run-machine command selects one validated assignment and starts one bounded Pi turn", async () => {
  const commands = new Map<string, Record<string, unknown>>();
  const entries: Array<Record<string, unknown>> = [];
  const sentMessages: string[] = [];
  let sessionName = "";
  const fakePi = {
    registerTool() {},
    registerCommand(name: string, definition: Record<string, unknown>) { commands.set(name, definition); },
    on() {},
    appendEntry(_customType: string, data: Record<string, unknown>) { entries.push(data); },
    getSessionName() { return undefined; },
    setSessionName(name: string) { sessionName = name; },
    sendUserMessage(message: string) { sentMessages.push(message); },
  } as unknown as ExtensionAPI;

  const tempRoot = mkdtempSync(join(process.cwd(), "wheel-run-machine-command-"));
  try {
    const sourceStoryRaw = readFileSync("docs/zob/examples/story-execution.example.json", "utf8");
    const story = JSON.parse(sourceStoryRaw) as Record<string, unknown>;
    story.storyId = "W1-STORY";
    story.title = "W1 assigned story";
    story.dependencies = [];
    story.branchContract = { branchName: "feature/W1-STORY", prTarget: "develop-staging", draftRequired: true };
    const storyRaw = `${JSON.stringify(story, null, 2)}\n`;
    const storyPath = join(tempRoot, "W1-STORY.json");
    writeFileSync(storyPath, storyRaw, "utf8");
    const allocationRaw = "{\"plan\":\"machine-command\"}\n";
    const signalsRaw = "{\"stories\":{}}\n";
    const allocationPath = join(tempRoot, "allocation.json");
    const signalsPath = join(tempRoot, "signals.json");
    writeFileSync(allocationPath, allocationRaw, "utf8");
    writeFileSync(signalsPath, signalsRaw, "utf8");

    const storyRelative = relative(process.cwd(), storyPath);
    const bundleWithoutHash = {
      schema: "wheel.zob.fleet-v5-machine-bundle.v1",
      bundleId: "machine-command",
      revision: 1,
      source: {
        repositoryId: "example/repository",
        sourceSha: "a".repeat(40),
        allocationRef: relative(process.cwd(), allocationPath),
        allocationSha256: sha256(allocationRaw),
        signalsRef: relative(process.cwd(), signalsPath),
        signalsSha256: sha256(signalsRaw),
      },
      machines: [{
        machineId: "W1",
        theme: "Guardrails",
        allocationUnitIds: ["W1-STORY"],
        storyIds: ["W1-STORY"],
        storyPaths: [storyRelative],
      }],
    } as Omit<WheelFleetV5MachineBundle, "bundleHash">;
    const bundle: WheelFleetV5MachineBundle = {
      ...bundleWithoutHash,
      bundleHash: computeWheelFleetV5MachineBundleHash(bundleWithoutHash, { [storyRelative]: sha256(storyRaw) }),
    };
    const bundlePath = join(tempRoot, "machine-bundle.json");
    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    wheelZobPackExtension(fakePi);
    const handler = commands.get("wheel-zob")?.handler as ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
    const notices: string[] = [];
    const context = { cwd: process.cwd(), isIdle: () => true, ui: { notify(message: string) { notices.push(message); } } };
    await handler?.(`run-machine machine-command W1 ${relative(process.cwd(), bundlePath)}`, context);

    assert.equal(sessionName, "Wheel W1 · machine-command");
    assert.match(sentMessages[0] ?? "", /^WHEEL_ZOB_RUN_MACHINE\.v1/m);
    assert.match(sentMessages[0] ?? "", /W1-STORY revision 2/);
    assert.match(sentMessages[0] ?? "", /Do not implement stories owned by another machine/);
    assert.equal(sentMessages[0]?.includes("accounts/fireworks"), false);
    assert.equal(entries[0]?.event, "machine_run_requested");
    assert.equal(entries[0]?.machineId, "W1");
    assert.equal(entries[0]?.storyCount, 1);
    assert.equal(entries[0]?.githubEffectsEnabled, false);
    assert.match(notices.at(-1) ?? "", /Starting Wheel W1: 1 assigned story/);

    await handler?.(`run-machine machine-command W9 ${relative(process.cwd(), bundlePath)}`, context);
    assert.equal(sentMessages.length, 1);
    assert.match(notices.at(-1) ?? "", /machine W9 is not assigned/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("prepare-local-launch command persists an arbitrary disabled machine selection without starting a session", async () => {
  const commands = new Map<string, Record<string, unknown>>();
  const entries: Array<Record<string, unknown>> = [];
  const sentMessages: string[] = [];
  const fakePi = {
    registerTool() {},
    registerCommand(name: string, definition: Record<string, unknown>) { commands.set(name, definition); },
    on() {},
    appendEntry(_customType: string, data: Record<string, unknown>) { entries.push(data); },
    sendUserMessage(message: string) { sentMessages.push(message); },
  } as unknown as ExtensionAPI;

  const tempRoot = mkdtempSync(join(process.cwd(), "wheel-prepare-local-command-"));
  try {
    const sourceStory = JSON.parse(readFileSync("docs/zob/examples/story-execution.example.json", "utf8")) as Record<string, unknown>;
    sourceStory.storyId = "FUTURE-1";
    sourceStory.title = "Future reconciled story";
    sourceStory.dependencies = [];
    sourceStory.humanGateRefs = [];
    sourceStory.branchContract = { branchName: "feature/future-1", prTarget: "develop-staging", draftRequired: true };
    const storyRaw = `${JSON.stringify(sourceStory, null, 2)}\n`;
    writeFileSync(join(tempRoot, "FUTURE-1.json"), storyRaw, "utf8");
    const allocationRaw = "{\"plan\":\"future\"}\n";
    const signalsRaw = "{\"stories\":{}}\n";
    writeFileSync(join(tempRoot, "allocation.json"), allocationRaw, "utf8");
    writeFileSync(join(tempRoot, "signals.json"), signalsRaw, "utf8");
    const withoutHash = {
      schema: "wheel.zob.fleet-v5-machine-bundle.v1",
      bundleId: "future-bundle",
      revision: 1,
      source: {
        repositoryId: "example/repository",
        sourceSha: "a".repeat(40),
        allocationRef: "allocation.json",
        allocationSha256: sha256(allocationRaw),
        signalsRef: "signals.json",
        signalsSha256: sha256(signalsRaw),
      },
      machines: [{
        machineId: "future-machine",
        theme: "Future",
        allocationUnitIds: ["FUTURE-1"],
        storyIds: ["FUTURE-1"],
        storyPaths: ["FUTURE-1.json"],
      }],
    } as Omit<WheelFleetV5MachineBundle, "bundleHash">;
    const bundle: WheelFleetV5MachineBundle = {
      ...withoutHash,
      bundleHash: computeWheelFleetV5MachineBundleHash(withoutHash, { "FUTURE-1.json": sha256(storyRaw) }),
    };
    writeFileSync(join(tempRoot, "machine-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    wheelZobPackExtension(fakePi);
    const handler = commands.get("wheel-zob")?.handler as ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
    const notices: string[] = [];
    const context = { cwd: tempRoot, isIdle: () => true, ui: { notify(message: string) { notices.push(message); } } };
    await handler?.("prepare-local-launch launch-future mission-future machine-bundle.json future-machine", context);

    assert.equal(sentMessages.length, 0);
    assert.equal(entries.at(-1)?.event, "local_launch_prepared");
    assert.equal(entries.at(-1)?.machineCount, 1);
    assert.equal(entries.at(-1)?.processSpawned, false);
    assert.equal(entries.at(-1)?.sourceMutationsMade, false);
    assert.equal(entries.at(-1)?.gitMutationsMade, false);
    assert.equal(entries.at(-1)?.reportArtifactsWritten, true);
    assert.equal(entries.at(-1)?.githubEffectsMade, false);
    assert.match(notices.at(-1) ?? "", /no sessions\/effects started/);
    assert.equal(readFileSync(join(tempRoot, "reports/wheel-zob/local-launches/launch-future/launch-plan.json"), "utf8").includes("future-machine"), true);

    await handler?.("local-launch-status launch-future", context);
    assert.match(notices.at(-1) ?? "", /validation=pass/);
    assert.match(notices.at(-1) ?? "", /activation=false/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("start-local-machine claims a clean linked worktree, starts one bounded turn, and persists status without commit or GitHub", async () => {
  const root = mkdtempSync(join(tmpdir(), "wheel-local-pi-command-"));
  const primary = join(root, "primary");
  const machineWorktree = join(root, "machine");
  const storyWorktree = join(root, "story");
  mkdirSync(primary, { recursive: true });
  const commands = new Map<string, Record<string, unknown>>();
  const entries: Array<Record<string, unknown>> = [];
  const sentMessages: string[] = [];
  let sessionName: string | undefined;
  const fakePi = {
    registerTool() {},
    registerCommand(name: string, definition: Record<string, unknown>) { commands.set(name, definition); },
    on() {},
    appendEntry(_customType: string, data: Record<string, unknown>) { entries.push(data); },
    getSessionName() { return sessionName; },
    setSessionName(name: string) { sessionName = name; },
    sendUserMessage(message: string) { sentMessages.push(message); },
  } as unknown as ExtensionAPI;
  try {
    git(primary, ["init", "-b", "main"]);
    git(primary, ["config", "user.email", "wheel-test@example.invalid"]);
    git(primary, ["config", "user.name", "Wheel Test"]);
    const story = JSON.parse(readFileSync(join(process.cwd(), "docs/zob/examples/story-execution.example.json"), "utf8")) as Record<string, unknown>;
    story.storyId = "LOCAL-PI-1";
    story.title = "Local Pi selected story";
    story.dependencies = [];
    story.humanGateRefs = [];
    story.branchContract = { branchName: "feature/local-pi-1", prTarget: "develop-staging", draftRequired: true };
    const storyRaw = `${JSON.stringify(story, null, 2)}\n`;
    writeFileSync(join(primary, "LOCAL-PI-1.json"), storyRaw, "utf8");
    const allocationRaw = "{\"plan\":\"local-pi\"}\n";
    const signalsRaw = "{\"stories\":{}}\n";
    writeFileSync(join(primary, "allocation.json"), allocationRaw, "utf8");
    writeFileSync(join(primary, "signals.json"), signalsRaw, "utf8");
    writeFileSync(join(primary, ".gitignore"), "reports/wheel-zob/local-launches/*/machines/\n", "utf8");
    git(primary, ["add", ".gitignore", "LOCAL-PI-1.json", "allocation.json", "signals.json"]);
    git(primary, ["commit", "-m", "fixture source"]);
    const sourceSha = git(primary, ["rev-parse", "HEAD"]);
    const withoutHash = {
      schema: "wheel.zob.fleet-v5-machine-bundle.v1",
      bundleId: "local-pi-bundle",
      revision: 1,
      source: {
        repositoryId: "example/repository",
        sourceSha,
        allocationRef: "allocation.json",
        allocationSha256: sha256(allocationRaw),
        signalsRef: "signals.json",
        signalsSha256: sha256(signalsRaw),
      },
      machines: [{ machineId: "machine-local", theme: "Local", allocationUnitIds: ["LOCAL-PI-1"], storyIds: ["LOCAL-PI-1"], storyPaths: ["LOCAL-PI-1.json"] }],
    } as Omit<WheelFleetV5MachineBundle, "bundleHash">;
    const bundle: WheelFleetV5MachineBundle = {
      ...withoutHash,
      bundleHash: computeWheelFleetV5MachineBundleHash(withoutHash, { "LOCAL-PI-1.json": sha256(storyRaw) }),
    };
    writeFileSync(join(primary, "machine-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    git(primary, ["add", "machine-bundle.json"]);
    git(primary, ["commit", "-m", "bundle fixture"]);

    wheelZobPackExtension(fakePi);
    const handler = commands.get("wheel-zob")?.handler as ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
    const notices: string[] = [];
    const prepareContext = { cwd: primary, isIdle: () => true, ui: { notify(message: string) { notices.push(message); } } };
    await handler?.("prepare-local-launch launch-local-pi mission-local-pi machine-bundle.json machine-local", prepareContext);
    const planHash = String(entries.at(-1)?.planHash ?? "");
    assert.match(planHash, /^[a-f0-9]{64}$/);
    git(primary, ["add", "reports/wheel-zob/local-launches/launch-local-pi/launch-plan.json"]);
    git(primary, ["commit", "-m", "launch plan fixture"]);
    git(primary, ["worktree", "add", "-b", "machine-local-worktree", machineWorktree]);
    assert.equal(git(machineWorktree, ["status", "--porcelain"]), "");

    const sessionContext = {
      cwd: machineWorktree,
      isIdle: () => true,
      sessionManager: { getSessionFile: () => undefined, getSessionId: () => "pi-session-local-machine" },
      ui: { notify(message: string) { notices.push(message); } },
    };
    const priorZagentId = process.env.ZOB_ZAGENT_ID;
    const priorZteamId = process.env.ZOB_ZTEAM_ID;
    process.env.ZOB_ZAGENT_ID = "offline-wheel-agent";
    process.env.ZOB_ZTEAM_ID = "offline-wheel-team";
    try {
      await handler?.(`start-local-machine launch-local-pi machine-local ${planHash}`, sessionContext);
      assert.equal(sentMessages.length, 0);
      assert.match(notices.at(-1) ?? "", /ZAgent local presence is not online/);
    } finally {
      if (priorZagentId === undefined) delete process.env.ZOB_ZAGENT_ID;
      else process.env.ZOB_ZAGENT_ID = priorZagentId;
      if (priorZteamId === undefined) delete process.env.ZOB_ZTEAM_ID;
      else process.env.ZOB_ZTEAM_ID = priorZteamId;
    }

    await handler?.(`start-local-machine launch-local-pi machine-local ${planHash}`, sessionContext);
    assert.equal(sessionName, "Wheel machine-local · launch-local-pi");
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0] ?? "", /^WHEEL_ZOB_LOCAL_MACHINE_SESSION\.v1/m);
    assert.match(sentMessages[0] ?? "", /Do not commit, push, fetch remote state/);
    assert.match(sentMessages[0] ?? "", /Stop before commit/);
    assert.equal(entries.at(-1)?.event, "local_machine_started");
    assert.equal(entries.at(-1)?.processSpawned, false);
    assert.equal(entries.at(-1)?.commitEnabled, false);
    assert.equal(entries.at(-1)?.githubEffectsEnabled, false);
    assert.match(notices.at(-1) ?? "", /commit\/GitHub disabled/);

    await handler?.(`start-local-machine launch-local-pi machine-local ${planHash}`, sessionContext);
    assert.equal(sentMessages.length, 1);
    assert.match(notices.at(-1) ?? "", /already running/);
    await handler?.(`local-machine-ready launch-local-pi machine-local 1 reports/wheel-zob/local-launches/launch-local-pi/validation.json ${"e".repeat(64)}`, sessionContext);
    assert.equal(entries.at(-1)?.event, "local_machine_ready");
    assert.match(notices.at(-1) ?? "", /commit\/GitHub still require separate PR handoff authority/);
    await handler?.("local-machine-status launch-local-pi machine-local", sessionContext);
    assert.match(notices.at(-1) ?? "", /status=local-ready/);
    assert.match(notices.at(-1) ?? "", /integrity=pass/);

    git(primary, ["worktree", "add", "-b", "feature/local-pi-1", storyWorktree]);
    writeFileSync(join(storyWorktree, "implementation.txt"), "reviewed local change\n", "utf8");
    await handler?.(`prepare-pr-handoff launch-local-pi machine-local LOCAL-PI-1 candidate-local-pre pre-commit ${storyWorktree} develop-staging NONE evidence/local-pi-review.json ${"f".repeat(64)} commit`, sessionContext);
    assert.equal(entries.at(-1)?.event, "pr_handoff_candidate_prepared");
    assert.equal(entries.at(-1)?.phase, "pre-commit");
    assert.equal(entries.at(-1)?.authorityGranted, false);
    assert.equal(entries.at(-1)?.externalEffectsPerformed, false);
    const candidateHash = String(entries.at(-1)?.candidateHash ?? "");
    const candidateHead = String(entries.at(-1)?.headSha ?? "");
    assert.match(candidateHash, /^[a-f0-9]{64}$/);
    assert.match(candidateHead, /^[a-f0-9]{40}$/);
    assert.match(notices.at(-1) ?? "", /no commit\/GitHub effect/);

    await handler?.(`authorize-pr-handoff launch-local-pi candidate-local-pre authority-local-pre ${storyWorktree} ${candidateHash} ${candidateHead} commit`, sessionContext);
    assert.equal(entries.at(-1)?.event, "pr_handoff_authorized");
    assert.deepEqual(entries.at(-1)?.allowedActions, ["commit"]);
    assert.equal(entries.at(-1)?.externalEffectsPerformed, false);
    assert.equal(entries.at(-1)?.mergeEnabled, false);
    assert.match(notices.at(-1) ?? "", /no effect executed/);
    await handler?.(`pr-handoff-status launch-local-pi candidate-local-pre ${storyWorktree} authority-local-pre`, sessionContext);
    assert.match(notices.at(-1) ?? "", /valid=true/);
    assert.match(notices.at(-1) ?? "", /effects=false/);
    assert.equal(git(machineWorktree, ["log", "--oneline"]).split("\n").length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi supervisor status and gate resolution surface no-ship and validation posture", async () => {
  const commands = new Map<string, Record<string, unknown>>();
  const entries: Array<Record<string, unknown>> = [];
  const fakePi = {
    registerTool() {},
    registerCommand(name: string, definition: Record<string, unknown>) { commands.set(name, definition); },
    on() {},
    appendEntry(_customType: string, data: Record<string, unknown>) { entries.push(data); },
  } as unknown as ExtensionAPI;
  const tempRoot = mkdtempSync(join(process.cwd(), "wheel-supervisor-pi-command-"));
  try {
    const story = supervisorStory("S-PI-GATED");
    story.humanGateRefs = ["docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md"];
    const input = supervisorAdmissionInput([story]);
    const stateDirectory = join(tempRoot, "reports/wheel-zob/supervisor/pi-command");
    const store = new FileWheelSupervisorStore(stateDirectory);
    admitWheelSupervisorMission(store, input);
    const supervisor = new WheelFleetSupervisor(
      store,
      input.authority,
      { dispatch: new DeterministicFakeWheelDispatchAdapter(), effects: new DeterministicFakeWheelStoryEffectBroker() },
    );
    await supervisor.runUntilSettled(20);

    wheelZobPackExtension(fakePi);
    const handler = commands.get("wheel-zob")?.handler as ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
    const notices: string[] = [];
    const context = { cwd: tempRoot, isIdle: () => true, ui: { notify(message: string) { notices.push(message); } } };
    const relativeState = "reports/wheel-zob/supervisor/pi-command";
    await handler?.(`supervisor-status ${relativeState}`, context);
    assert.match(notices.at(-1) ?? "", /no-ship=1 validation=pass/);

    await handler?.(`supervisor-resolve-human ${relativeState} S-PI-GATED ${"f".repeat(64)} supervisor-test-owner`, context);
    assert.match(notices.at(-1) ?? "", /no-ship=0 validation=pass/);
    assert.equal(entries.at(-1)?.event, "supervisor_human_gate_resolved");
    assert.equal(entries.at(-1)?.noShipReasonCount, 0);
    assert.equal(entries.at(-1)?.validationValid, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("run command fails closed while busy and for invalid or cyclic sets", async () => {
  const commands = new Map<string, Record<string, unknown>>();
  const entries: Record<string, unknown>[] = [];
  const sentMessages: string[] = [];
  const fakePi = {
    registerTool() {},
    registerCommand(name: string, definition: Record<string, unknown>) { commands.set(name, definition); },
    on() {},
    appendEntry(_customType: string, data: Record<string, unknown>) { entries.push(data); },
    getSessionName() { return "existing session"; },
    setSessionName() {},
    sendUserMessage(message: string) { sentMessages.push(message); },
  } as unknown as ExtensionAPI;
  wheelZobPackExtension(fakePi);
  const handler = commands.get("wheel-zob")?.handler as ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
  const notices: string[] = [];
  const context = (idle: boolean) => ({ cwd: process.cwd(), isIdle: () => idle, ui: { notify(message: string) { notices.push(message); } } });
  const sourcePath = "docs/zob/examples/story-execution.example.json";

  await handler?.(`run busy ${sourcePath}`, context(false));
  await handler?.("run missing missing-story.json", context(true));
  assert.equal(sentMessages.length, 0);
  assert.equal(entries.length, 0);

  const tempRoot = mkdtempSync(join(process.cwd(), "wheel-run-cycle-"));
  try {
    const first = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    first.storyId = "H31";
    first.dependencies = [{ storyId: "H32", type: "hard" }];
    const second = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    second.storyId = "H32";
    second.dependencies = [{ storyId: "H31", type: "stack" }];
    const firstPath = join(tempRoot, "H31.json");
    const secondPath = join(tempRoot, "H32.json");
    writeFileSync(firstPath, JSON.stringify(first), "utf8");
    writeFileSync(secondPath, JSON.stringify(second), "utf8");
    await handler?.(`run cycle ${relative(process.cwd(), firstPath)} ${relative(process.cwd(), secondPath)}`, context(true));
    assert.equal(sentMessages.length, 0);
    assert.equal(entries.length, 0);
    assert.match(notices.at(-1) ?? "", /cycle detected/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  await handler?.(`run single ${sourcePath}`, context(true));
  assert.equal(sentMessages.length, 1);
  assert.equal(entries.length, 1);
  assert.match(sentMessages[0], /H31 revision 2/);
});
