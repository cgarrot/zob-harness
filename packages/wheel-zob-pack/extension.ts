import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { readZobLiveRegistryAllProjectsSnapshot } from "../../.pi/extensions/zob-harness/src/domains/coms/coms-v2/registry.js";

import {
  previewWheelMachineMissionFromFile,
  previewWheelMissionFromFiles,
  validateWheelStoryFile,
} from "./adapters/file-intake.js";
import {
  FileWheelSupervisorStore,
  WheelFleetSupervisor,
  DeterministicFakeWheelDispatchAdapter,
  DeterministicFakeWheelStoryEffectBroker,
  createDeterministicFakeWheelSupervisorAuthority,
  initializeWheelSupervisorFromMachineBundle,
  prepareWheelSupervisorFromMachineBundle,
  resolveWheelSupervisorStateDirectory,
  runWheelSupervisorFakeFromMachineBundle,
  sha256Canonical,
  sha256Text,
  validateWheelSupervisorPersistedState,
} from "./supervisor/index.js";
import { createWheelFactoryPipeline, simulateWheelFactoryHappyPath } from "./factories/pipeline.js";
import {
  FileWheelLocalMachineLaunchStore,
  authorizeWheelPrHandoffFromWorkspace,
  inspectWheelLocalWorkspace,
  inspectWheelPrHandoffStatus,
  loadWheelLocalMachineLaunchPlan,
  loadWheelPrHandoffCandidate,
  persistWheelLocalMachineLaunchPlan,
  prepareWheelLocalMachineLaunch,
  prepareWheelPrHandoffCandidateFromWorkspace,
  recordWheelPrHandoffCommitReceiptFromWorkspace,
  validateWheelLocalMachineLaunchPlan,
  wheelLocalMachineRecoveryConfirmation,
  wheelLocalMachineStartConfirmation,
  wheelPrHandoffConfirmation,
  type WheelLocalMachineLaunchClaim,
  type WheelLocalMachineLaunchPlan,
  type WheelPrHandoffAction,
} from "./launch/index.js";
import { WHEEL_FIXED_ROLE_ROUTES, WHEEL_RANDOMIZED_ROLE_POOLS, validateWheelModelRegistry } from "./model-policy/model-registry.js";

const StoryPathParams = Type.Object({
  story_path: Type.String({ description: "Repo-relative Fleet v5 story-execution JSON path." }),
}, { additionalProperties: false });

const MissionPreviewParams = Type.Object({
  mission_id: Type.String({ description: "Path-safe mission identifier.", pattern: "^[A-Za-z0-9._-]+$" }),
  story_paths: Type.Array(Type.String({ description: "Repo-relative Fleet v5 story-execution JSON path." }), { minItems: 1, maxItems: 100 }),
  max_output_price_usd_per_million: Type.Optional(Type.Number({ minimum: 0, description: "Optional hard eligibility cap on model output price per million tokens." })),
}, { additionalProperties: false });

const PipelineSimulationParams = Type.Object({
  mission_id: Type.String({ pattern: "^[A-Za-z0-9._-]+$" }),
  story_id: Type.String({ pattern: "^[A-Za-z0-9._-]+$" }),
  pull_request_id: Type.String({ pattern: "^[A-Za-z0-9._-]+$" }),
  candidate_id: Type.String({ pattern: "^[A-Za-z0-9._-]+$" }),
  window_id: Type.String({ pattern: "^[A-Za-z0-9._-]+$" }),
}, { additionalProperties: false });

const WHEEL_COMMAND_USAGE = "/wheel-zob prepare-local-launch <launch-id> <mission-id> <machine-bundle.json> <machine-id...> | start-local-machine <launch-id> <machine-id> <plan-sha256> | recover-local-machine <launch-id> <machine-id> <plan-sha256> <next-epoch> | local-machine-status <launch-id> <machine-id> | local-machine-ready <launch-id> <machine-id> <epoch> <evidence-ref> <evidence-sha256> | prepare-pr-handoff <launch-id> <machine-id> <story-id> <candidate-id> <phase> <story-worktree-path> <base-ref> <commit-receipt-id|NONE> <evidence-ref> <evidence-sha256> <actions-csv> | record-pr-commit <launch-id> <pre-commit-candidate-id> <commit-authority-id> <receipt-id> <story-worktree-path> <governed-zcommit-evidence-ref> <evidence-sha256> | authorize-pr-handoff <launch-id> <candidate-id> <authority-id> <story-worktree-path> <candidate-sha256> <expected-head-sha> <actions-csv> | pr-handoff-status <launch-id> <candidate-id> <story-worktree-path> [authority-id] | local-launch-status <launch-id> | run-machine <mission-id> <machine-id> <machine-bundle.json> | supervisor-plan <mission-id> <machine-bundle.json> | supervisor-init <mission-id> <machine-bundle.json> <state-dir> [disabled|deterministic-fake] | supervisor-run-fake <mission-id> <machine-bundle.json> <state-dir> | supervisor-status <state-dir> | supervisor-resolve-human <state-dir> <story-id> <receipt-sha256> [owner-id] | run <mission-id> <story.json...> | validate <story.json> | plan <mission-id> <story.json...> | simulate <mission-id> | pools";

function buildWheelRunPrompt(input: {
  missionId: string;
  storyPaths: string[];
  seedCommitment: string;
  stories: Array<{ storyId: string; revision: number }>;
}): string {
  const storyPaths = input.storyPaths.map((path) => `- ${path}`).join("\n");
  const storyPlan = input.stories.map((story) => `- ${story.storyId} revision ${story.revision}`).join("\n");
  return [
    "WHEEL_ZOB_RUN.v1",
    "",
    `Execute Wheel mission ${input.missionId} now inside this trusted Pi checkout.`,
    "",
    "Story manifests:",
    storyPaths,
    "",
    "Validated public plan:",
    storyPlan,
    `Seed commitment: ${input.seedCommitment}`,
    "",
    "Execution authority:",
    "- The user explicitly requested implementation of these story manifests in the current checkout.",
    "- Source edits and repository-local validation are authorized for the accepted story scope.",
    "- Do not commit, push, create or modify GitHub resources, merge, deploy, activate providers, or access secrets.",
    "",
    "Required workflow:",
    "1. Re-run wheel_zob_validate_story for each manifest and wheel_zob_preview_mission for this exact mission as visible evidence.",
    "2. Read each manifest plus its repo-local acceptance, non-goal, gate, and bundle references. Stop and ask one focused question if required references are missing or contradictory.",
    "3. Build the dependency DAG. Execute hard/stack dependencies first; parallelize only independent stories marked parallelizable.",
    "4. Use bounded context discovery before unfamiliar edits. Use the existing ZOB delegation/worker machinery when useful, with explicit allowed and forbidden paths. If an unrelated runtime /goal is active, do not mutate it; track this mission locally instead.",
    "5. Implement each story completely, including tests and documentation required by its profile and acceptance criteria. Keep changes small and reversible.",
    "6. Validate each story independently, then run the affected integrated checks. Do not treat the mission preview or factory simulation as implementation evidence.",
    "7. Perform independent review/oracle checks for security, scope, regressions, and acceptance criteria. Repair findings before claiming completion.",
    "8. Finish with per-story results, changed paths, exact validation commands/results, remaining risks, and an explicit statement that no commit/GitHub/merge/deploy effect occurred.",
    "",
    "Begin execution now. Do not call /wheel-zob run again for this prepared mission.",
  ].join("\n");
}

function buildWheelMachineRunPrompt(input: {
  missionId: string;
  machineId: string;
  bundlePath: string;
  bundleHash: string;
  allocationUnitIds: string[];
  storyPaths: string[];
  seedCommitment: string;
  stories: Array<{ storyId: string; revision: number }>;
  humanGateStoryIds: string[];
}): string {
  const storyPaths = input.storyPaths.map((path) => `- ${path}`).join("\n");
  const storyPlan = input.stories.map((story) => `- ${story.storyId} revision ${story.revision}`).join("\n");
  return [
    "WHEEL_ZOB_RUN_MACHINE.v1",
    "",
    `Execute assigned Wheel machine ${input.machineId} for mission ${input.missionId} inside this trusted Pi checkout.`,
    `Machine bundle: ${input.bundlePath}`,
    `Bundle hash: ${input.bundleHash}`,
    `Allocation units: ${input.allocationUnitIds.join(", ")}`,
    `Human-gated stories: ${input.humanGateStoryIds.length > 0 ? input.humanGateStoryIds.join(", ") : "none"}`,
    "",
    "Assigned story manifests, in intended queue order:",
    storyPaths,
    "",
    "Validated public plan:",
    storyPlan,
    `Seed commitment: ${input.seedCommitment}`,
    "",
    "Execution authority:",
    `- The user explicitly requested local implementation of machine ${input.machineId}'s assigned story set in the current checkout.`,
    "- Source edits and repository-local validation are authorized only for the listed story manifests and their accepted integration points.",
    "- Do not implement stories owned by another machine. Cross-machine artifact dependencies are prerequisites to verify, not permission to take over peer scope.",
    "- Do not commit, push, create or modify GitHub resources, merge, deploy, activate providers, access secrets, or satisfy human checkpoints by assumption.",
    "",
    "Required workflow:",
    "1. Read the machine bundle and re-run wheel_zob_validate_story for every assigned manifest plus wheel_zob_preview_mission for this exact selected story set.",
    "2. Read every manifest and its repo-local acceptance, non-goal, gate, bundle, and human-gate references. If required material is stale, missing, or contradictory, block only the affected story and continue independent ready work.",
    "3. Create a visible parent-owned TODO per assigned story when no unrelated runtime goal is active. Preserve queue order, but always execute hard/stack dependencies before dependents.",
    "4. Verify artifact dependencies from current repo evidence. Never edit another machine's story to make a dependency appear complete.",
    "5. For each ready story: discover current integration points, implement the complete accepted scope, add required tests/docs, run targeted validation, and perform independent review before moving to the next story.",
    "6. Parallelize only explicitly independent stories when write ownership cannot overlap; otherwise work sequentially. Keep every change small and reversible.",
    "7. Run affected integrated checks after the queue, without treating mission preview or factory simulation as implementation evidence.",
    "8. Finish with a per-story table of done/blocked/needs-human, changed paths, exact validation results, unresolved dependencies, and an explicit no-commit/no-GitHub/no-merge/no-deploy statement.",
    "",
    "Begin this machine queue now. Do not call /wheel-zob run-machine again for this prepared mission.",
  ].join("\n");
}

interface WheelCommandSessionContext {
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getSessionId?: () => string;
  };
}

function wheelCommandSessionIdentity(ctx: WheelCommandSessionContext, machineId: string): string {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  const sessionId = ctx.sessionManager?.getSessionId?.();
  return sessionFile ?? sessionId ?? `wheel-local-session:${machineId}`;
}

function wheelCommandOwnerIdentity(machineId: string): string {
  const zagentId = process.env.ZOB_ZAGENT_ID;
  const zteamId = process.env.ZOB_ZTEAM_ID;
  return zagentId ? `zagent:${zteamId ?? "local"}:${zagentId}` : `pi-local-owner:${machineId}`;
}

function wheelCurrentZagentPresenceReceipt(repoRoot: string): string | undefined {
  const zagentId = process.env.ZOB_ZAGENT_ID;
  if (!zagentId) return undefined;
  const zteamId = process.env.ZOB_ZTEAM_ID;
  if (!zteamId) throw new Error("ZAgent local machine start requires ZOB_ZTEAM_ID");
  const snapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot, zteamId);
  const peer = snapshot.peers.find((item) => item.team === zteamId && item.roleId === zagentId);
  if (!peer || peer.status !== "online") throw new Error(`ZAgent local presence is not online for ${zteamId}/${zagentId}`);
  return sha256Canonical({
    schema: "wheel.zob.zagent-presence-receipt.v1",
    teamIdHash: sha256Text(zteamId),
    agentIdHash: sha256Text(zagentId),
    sessionHash: peer.sessionHash,
    endpointHash: peer.endpointHash,
    status: peer.status,
    heartbeatAt: peer.heartbeatAt,
    socketVerifiedAt: peer.socketVerifiedAt,
    transport: peer.transport,
    bodyStored: false,
  });
}

function buildWheelLocalMachineSessionPrompt(input: {
  plan: WheelLocalMachineLaunchPlan;
  claim: WheelLocalMachineLaunchClaim;
  recovery: boolean;
}): string {
  const assignment = input.plan.assignments.find((item) => item.machineId === input.claim.machineId);
  if (!assignment) throw new Error(`machine ${input.claim.machineId} is not selected in local launch ${input.plan.launchId}`);
  const storyQueue = assignment.storyIds.map((storyId, index) => `- ${storyId} · ${assignment.storyPaths[index]}`).join("\n");
  return [
    "WHEEL_ZOB_LOCAL_MACHINE_SESSION.v1",
    "",
    `${input.recovery ? "Recover" : "Start"} selected machine ${input.claim.machineId} for mission ${input.plan.missionId}.`,
    `Launch: ${input.plan.launchId}`,
    `Launch plan: ${input.claim.planHash}`,
    `Assignment: ${input.claim.assignmentHash}`,
    `Ownership epoch: ${input.claim.ownershipEpoch}`,
    `Workspace branch: ${input.claim.workspaceBranch}`,
    `Workspace HEAD at claim: ${input.claim.workspaceHeadSha}`,
    `Bundle: ${input.plan.bundlePath}`,
    `Bundle hash: ${input.plan.bundleHash}`,
    `Source SHA: ${input.plan.sourceSha}`,
    "",
    "Selected story queue:",
    storyQueue,
    "",
    "Local execution authority:",
    "- You may edit source, run repository-local tests, and perform local review only for this assignment and its accepted integration points.",
    "- Work only in this claimed isolated worktree. Preserve the current branch and pre-authority HEAD.",
    "- Do not commit, push, fetch remote state, create or modify GitHub resources, dispatch workflows, merge, promote, deploy, activate providers, or access secrets.",
    "- Do not take over another machine's stories. Treat cross-machine dependencies as evidence prerequisites.",
    "- Human gates remain blockers until exact external receipts exist.",
    "",
    "Required workflow:",
    "1. Revalidate the launch plan, machine bundle, and every selected story before editing. Fail closed on any hash, source, assignment, or dependency drift.",
    "2. Build a parent-owned per-story queue. Continue independent ready work when one story is blocked; never invent dependency or human approval.",
    "3. Discover current integration points, implement accepted scope, add required tests/docs, and run targeted then integrated checks.",
    "4. Perform independent local review and repair findings. Persist only hashes, IDs, statuses, counts, and safe evidence refs in Wheel launch state.",
    `5. When local work is fully reviewed, ask the owner to run: /wheel-zob local-machine-ready ${input.plan.launchId} ${input.claim.machineId} ${input.claim.ownershipEpoch} <evidence-ref> <evidence-sha256>.`,
    "6. Stop before commit. A pre-commit candidate must bind the unchanged HEAD plus exact diff evidence; post-commit push/PR authority is a separate candidate after an explicitly authorized commit.",
    "",
    "Begin or resume the queue now. If this body is delivered more than once for the same claim and epoch, resume existing work rather than duplicating it.",
  ].join("\n");
}

export default function wheelZobPackExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wheel_zob_validate_story",
    label: "Wheel ZOB Validate Story",
    description: "Validate one repo-local Wheel Fleet v5 story-execution manifest. Read-only; returns typed issues and never stores the story body.",
    promptSnippet: "Validate a Wheel Fleet v5 story-execution manifest without dispatch or external effects.",
    promptGuidelines: ["Use wheel_zob_validate_story before previewing a Wheel mission when the user supplies a Fleet v5 story manifest path."],
    parameters: StoryPathParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = validateWheelStoryFile(ctx.cwd, params.story_path);
      pi.appendEntry("wheel-zob-pack", { event: "story_validation", valid: result.valid, storyId: result.storyId, issueCount: result.issues.length, bodyStored: false, dispatchEnabled: false, externalEffects: false });
      return {
        content: [{ type: "text", text: result.valid ? `wheel_zob_validate_story: PASS story=${result.storyId} revision=${result.revision}` : `wheel_zob_validate_story: FAIL issues=${result.issues.length}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "wheel_zob_preview_mission",
    label: "Wheel ZOB Preview Mission",
    description: "Validate Fleet v5 story files and build a deterministic hash-only public mission plan. Preview-only: no model dispatch, GitHub write, merge, workflow dispatch, provider activation, or deployment.",
    promptSnippet: "Preview a deterministic Wheel mission from Fleet v5 story files with model identities kept private.",
    promptGuidelines: ["Use wheel_zob_preview_mission to show what ZOB would plan from Fleet v5 story files; never describe a preview as factory activation or dispatch."],
    parameters: MissionPreviewParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const preview = previewWheelMissionFromFiles(ctx.cwd, { missionId: params.mission_id, storyPaths: params.story_paths, maxOutputPriceUsdPerMillion: params.max_output_price_usd_per_million });
      const publicPlan = preview.result?.planned === true ? preview.result.publicPlan : undefined;
      pi.appendEntry("wheel-zob-pack", { event: "mission_preview", missionId: params.mission_id, planned: preview.planned, storyCount: publicPlan?.storyCount ?? 0, seedCommitment: publicPlan?.seedCommitment, bodyStored: false, modelIdentityStored: false, dispatchEnabled: false, externalEffects: false });
      return {
        content: [{ type: "text", text: preview.planned ? `wheel_zob_preview_mission: PASS mission=${params.mission_id} stories=${publicPlan?.storyCount ?? 0} dispatch=false` : `wheel_zob_preview_mission: FAIL errors=${preview.errors.length}` }],
        details: {
          schema: preview.schema,
          planned: preview.planned,
          errors: [...preview.errors],
          publicPlan,
          bodyStored: false,
          modelIdentityStored: false,
          protectedPlanReturned: false,
        },
      };
    },
  });

  pi.registerTool({
    name: "wheel_zob_simulate_pipeline",
    label: "Wheel ZOB Simulate Pipeline",
    description: "Run the complete Wheel Story to Promotion factory state pipeline in memory. Simulation-only; every external effect and activation flag remains false.",
    promptSnippet: "Simulate the complete Wheel factory lifecycle without GitHub, merge, workflow, provider, or deployment effects.",
    promptGuidelines: ["Use wheel_zob_simulate_pipeline only for deterministic lifecycle validation; never describe it as live factory execution or activation."],
    parameters: PipelineSimulationParams,
    async execute(_toolCallId, params) {
      const result = simulateWheelFactoryHappyPath(createWheelFactoryPipeline({
        missionId: params.mission_id,
        storyId: params.story_id,
        pullRequestId: params.pull_request_id,
        candidateId: params.candidate_id,
        windowId: params.window_id,
        simulation: true,
      }));
      pi.appendEntry("wheel-zob-pack", { event: "pipeline_simulation", missionId: params.mission_id, completed: result.completed, blockedAt: result.blockedAt, bodyStored: false, dispatchEnabled: false, externalEffects: false });
      return {
        content: [{ type: "text", text: result.completed ? `wheel_zob_simulate_pipeline: PASS mission=${params.mission_id} external_effects=false` : `wheel_zob_simulate_pipeline: BLOCKED stage=${result.blockedAt} reason=${result.reason}` }],
        details: result,
      };
    },
  });

  pi.registerCommand("wheel-zob", {
    description: `Wheel pack: ${WHEEL_COMMAND_USAGE}`,
    getArgumentCompletions: (prefix) => {
      const choices = [
        { value: "prepare-local-launch ", label: "prepare-local-launch", description: "persist a disabled exact-hash launch plan for selected machines" },
        { value: "start-local-machine ", label: "start-local-machine", description: "claim this clean linked worktree and start one selected local queue" },
        { value: "recover-local-machine ", label: "recover-local-machine", description: "recover an expired machine lease with an exact next epoch" },
        { value: "local-machine-status ", label: "local-machine-status", description: "show one machine claim, journal, lease, and recovery posture" },
        { value: "local-machine-ready ", label: "local-machine-ready", description: "bind reviewed local work to hash-only validation evidence" },
        { value: "prepare-pr-handoff ", label: "prepare-pr-handoff", description: "snapshot one story worktree into a disabled exact-hash candidate" },
        { value: "record-pr-commit ", label: "record-pr-commit", description: "bind an already governed commit result to its pre-commit authority" },
        { value: "authorize-pr-handoff ", label: "authorize-pr-handoff", description: "grant bounded actions for one unchanged candidate without executing them" },
        { value: "pr-handoff-status ", label: "pr-handoff-status", description: "validate current story-worktree and authority bindings" },
        { value: "local-launch-status ", label: "local-launch-status", description: "validate a persisted selected-machine launch plan" },
        { value: "run-machine ", label: "run-machine", description: "execute one validated Fleet v5 machine queue inside Pi" },
        { value: "supervisor-plan ", label: "supervisor-plan", description: "validate a full machine bundle for the durable disabled supervisor" },
        { value: "supervisor-init ", label: "supervisor-init", description: "initialize body-free durable supervisor state without external effects" },
        { value: "supervisor-run-fake ", label: "supervisor-run-fake", description: "run the full supervisor through deterministic zero-effect fakes" },
        { value: "supervisor-status ", label: "supervisor-status", description: "show body-free durable supervisor status" },
        { value: "supervisor-resolve-human ", label: "supervisor-resolve-human", description: "record one explicit hash-only fake-run human-gate receipt" },
        { value: "run ", label: "run", description: "execute one or more validated Fleet v5 stories inside Pi" },
        { value: "validate ", label: "validate", description: "validate one Fleet v5 story manifest" },
        { value: "plan ", label: "plan", description: "preview a deterministic mission from story files" },
        { value: "simulate ", label: "simulate", description: "simulate the complete disabled factory lifecycle" },
        { value: "pools", label: "pools", description: "show verified pool counts and fixed orchestrator posture" },
      ];
      const query = prefix.trim().toLowerCase();
      return choices.filter((item) => item.value.trim().startsWith(query) || item.label.includes(query)).slice(0, 10);
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts.shift()?.toLowerCase();
      if (action === "prepare-local-launch") {
        const launchId = parts.shift();
        const missionId = parts.shift();
        const bundlePath = parts.shift();
        if (!launchId || !missionId || !bundlePath || parts.length === 0) {
          return ctx.ui.notify("Usage: /wheel-zob prepare-local-launch <launch-id> <mission-id> <machine-bundle.json> <machine-id...>", "warning");
        }
        const prepared = prepareWheelLocalMachineLaunch(ctx.cwd, {
          launchId,
          missionId,
          bundlePath,
          machineIds: parts,
        });
        if (!prepared.prepared || !prepared.plan) return ctx.ui.notify(`Wheel local launch blocked: ${prepared.errors.join("; ")}`, "error");
        try {
          const persisted = persistWheelLocalMachineLaunchPlan(ctx.cwd, prepared.plan);
          pi.appendEntry("wheel-zob-pack", {
            event: "local_launch_prepared",
            launchId,
            missionId,
            planHash: prepared.plan.planHash,
            bundleHash: prepared.plan.bundleHash,
            sourceSha: prepared.plan.sourceSha,
            machineCount: prepared.plan.selectedMachineIds.length,
            storyCount: prepared.plan.storyIds.length,
            replay: persisted.replay,
            bodyStored: false,
            processSpawned: false,
            providerCallsMade: false,
            sourceMutationsMade: false,
            gitMutationsMade: false,
            reportArtifactsWritten: true,
            githubEffectsMade: false,
          });
          ctx.ui.notify(
            `Wheel local launch prepared: ${launchId} · machines=${prepared.plan.selectedMachineIds.join(",")} · stories=${prepared.plan.storyIds.length} · plan=${prepared.plan.planHash} · no sessions/effects started`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(`Wheel local launch persistence blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "local-launch-status") {
        const launchId = parts.shift();
        if (!launchId || parts.length > 0) return ctx.ui.notify("Usage: /wheel-zob local-launch-status <launch-id>", "warning");
        try {
          const plan = loadWheelLocalMachineLaunchPlan(ctx.cwd, launchId, { allowExpired: true });
          const validation = validateWheelLocalMachineLaunchPlan(plan);
          const machineStatuses = plan.selectedMachineIds.map((machineId) => new FileWheelLocalMachineLaunchStore(ctx.cwd, launchId, machineId).status());
          const invalidMachines = machineStatuses.filter((status) => !status.valid).map((status) => status.machineId);
          const runningMachines = machineStatuses.filter((status) => status.claim?.status === "running").map((status) => status.machineId);
          const readyMachines = machineStatuses.filter((status) => status.claim?.status === "local-ready" || status.claim?.status === "handoff-candidate").map((status) => status.machineId);
          const recoveryMachines = machineStatuses.filter((status) => status.recoveryRequired && status.claim !== undefined).map((status) => status.machineId);
          ctx.ui.notify(
            `Wheel local launch ${launchId}: machines=${plan.selectedMachineIds.join(",")} stories=${plan.storyIds.length} plan=${plan.planHash} plan-validation=${validation.valid ? "pass" : `fail(${validation.errors.join(",")})`} running=${runningMachines.join(",") || "none"} local-ready=${readyMachines.join(",") || "none"} recovery=${recoveryMachines.join(",") || "none"} invalid=${invalidMachines.join(",") || "none"} activation=false`,
            validation.valid && invalidMachines.length === 0 ? "info" : "error",
          );
        } catch (error) {
          ctx.ui.notify(`Wheel local launch status blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "start-local-machine") {
        const launchId = parts.shift();
        const machineId = parts.shift();
        const planHash = parts.shift();
        if (!launchId || !machineId || !planHash || parts.length > 0) {
          return ctx.ui.notify("Usage: /wheel-zob start-local-machine <launch-id> <machine-id> <plan-sha256>", "warning");
        }
        if (!ctx.isIdle()) return ctx.ui.notify("Wait for the current agent turn to finish, then start the local machine.", "warning");
        try {
          const plan = loadWheelLocalMachineLaunchPlan(ctx.cwd, launchId);
          if (plan.planHash !== planHash) return ctx.ui.notify("Wheel local machine start blocked: plan hash is stale or incorrect.", "error");
          if (!pi.getSessionName()) pi.setSessionName(`Wheel ${machineId} · ${launchId}`);
          const ownerId = wheelCommandOwnerIdentity(machineId);
          const sessionId = wheelCommandSessionIdentity(ctx as unknown as WheelCommandSessionContext, machineId);
          const workspace = inspectWheelLocalWorkspace(ctx.cwd);
          const zagentPresenceReceiptHash = wheelCurrentZagentPresenceReceipt(ctx.cwd);
          const store = new FileWheelLocalMachineLaunchStore(ctx.cwd, launchId, machineId);
          const claimed = store.claim({
            planHash,
            machineId,
            confirmationPhrase: wheelLocalMachineStartConfirmation(plan, machineId),
            ownerId,
            sessionId,
            workspace,
            zagentPresenceReceiptHash,
          });
          if (["running", "local-ready", "handoff-candidate", "blocked"].includes(claimed.claim.status)) {
            const status = store.status();
            return ctx.ui.notify(
              `Wheel local machine ${machineId} already ${claimed.claim.status}: epoch=${claimed.claim.ownershipEpoch} events=${status.eventCount} recovery=${status.recoveryRequired ? status.recoveryReasons.join(",") : "none"}`,
              claimed.claim.status === "blocked" ? "warning" : "info",
            );
          }
          const started = claimed.claim.status === "claimed"
            ? store.transition({
              ownerId,
              sessionId,
              ownershipEpoch: claimed.claim.ownershipEpoch,
              mutationId: `start-${claimed.claim.claimId}`,
              status: "started",
            }).claim
            : claimed.claim;
          try {
            pi.sendUserMessage(buildWheelLocalMachineSessionPrompt({ plan, claim: started, recovery: false }));
          } catch (error) {
            const blockerHash = sha256Text(error instanceof Error ? error.message : String(error));
            store.transition({
              ownerId,
              sessionId,
              ownershipEpoch: started.ownershipEpoch,
              mutationId: `dispatch-blocked-${started.claimId}`,
              status: "blocked",
              blockerHash,
            });
            throw error;
          }
          const running = store.transition({
            ownerId,
            sessionId,
            ownershipEpoch: started.ownershipEpoch,
            mutationId: `running-${started.claimId}`,
            status: "running",
          }).claim;
          pi.appendEntry("wheel-zob-pack", {
            event: "local_machine_started",
            launchId,
            machineId,
            planHash,
            assignmentHash: running.assignmentHash,
            claimId: running.claimId,
            ownershipEpoch: running.ownershipEpoch,
            workspaceRootHash: running.workspaceRootHash,
            workspaceHeadSha: running.workspaceHeadSha,
            localSessionReceiptHash: sha256Text(`${sessionId}:${running.claimId}:${running.ownershipEpoch}`),
            zagentPresenceReceiptHash: running.zagentPresenceReceiptHash,
            zagentIdHash: process.env.ZOB_ZAGENT_ID ? sha256Text(process.env.ZOB_ZAGENT_ID) : undefined,
            zteamIdHash: process.env.ZOB_ZTEAM_ID ? sha256Text(process.env.ZOB_ZTEAM_ID) : undefined,
            bodyStored: false,
            processSpawned: false,
            commitEnabled: false,
            githubEffectsEnabled: false,
          });
          ctx.ui.notify(`Wheel local machine ${machineId} started in this claimed worktree: epoch=${running.ownershipEpoch} claim=${running.claimId}; commit/GitHub disabled`, "info");
        } catch (error) {
          ctx.ui.notify(`Wheel local machine start blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "recover-local-machine") {
        const launchId = parts.shift();
        const machineId = parts.shift();
        const planHash = parts.shift();
        const nextEpochRaw = parts.shift();
        const nextEpoch = Number(nextEpochRaw);
        if (!launchId || !machineId || !planHash || !Number.isSafeInteger(nextEpoch) || nextEpoch < 2 || parts.length > 0) {
          return ctx.ui.notify("Usage: /wheel-zob recover-local-machine <launch-id> <machine-id> <plan-sha256> <next-epoch>", "warning");
        }
        if (!ctx.isIdle()) return ctx.ui.notify("Wait for the current agent turn to finish, then recover the local machine.", "warning");
        try {
          const plan = loadWheelLocalMachineLaunchPlan(ctx.cwd, launchId);
          if (plan.planHash !== planHash) return ctx.ui.notify("Wheel local machine recovery blocked: plan hash is stale or incorrect.", "error");
          const ownerId = wheelCommandOwnerIdentity(machineId);
          const sessionId = wheelCommandSessionIdentity(ctx as unknown as WheelCommandSessionContext, machineId);
          const workspace = inspectWheelLocalWorkspace(ctx.cwd);
          const zagentPresenceReceiptHash = wheelCurrentZagentPresenceReceipt(ctx.cwd);
          const store = new FileWheelLocalMachineLaunchStore(ctx.cwd, launchId, machineId);
          const recovered = store.recover({
            ownerId,
            sessionId,
            confirmationPhrase: wheelLocalMachineRecoveryConfirmation({ launchId, machineId, planHash, ownershipEpoch: nextEpoch }),
            workspace,
            zagentPresenceReceiptHash,
          });
          if (recovered.claim.ownershipEpoch !== nextEpoch) throw new Error("recovered ownership epoch does not match requested next epoch");
          if (recovered.claim.status === "started") {
            try {
              pi.sendUserMessage(buildWheelLocalMachineSessionPrompt({ plan, claim: recovered.claim, recovery: true }));
            } catch (error) {
              store.transition({
                ownerId,
                sessionId,
                ownershipEpoch: recovered.claim.ownershipEpoch,
                mutationId: `recovery-dispatch-blocked-${recovered.claim.claimId}-${nextEpoch}`,
                status: "blocked",
                blockerHash: sha256Text(error instanceof Error ? error.message : String(error)),
              });
              throw error;
            }
            store.transition({
              ownerId,
              sessionId,
              ownershipEpoch: recovered.claim.ownershipEpoch,
              mutationId: `recovery-running-${recovered.claim.claimId}-${nextEpoch}`,
              status: "running",
            });
          }
          pi.appendEntry("wheel-zob-pack", {
            event: "local_machine_recovered",
            launchId,
            machineId,
            planHash,
            claimId: recovered.claim.claimId,
            ownershipEpoch: recovered.claim.ownershipEpoch,
            replay: recovered.replayed,
            localSessionReceiptHash: sha256Text(`${sessionId}:${recovered.claim.claimId}:${recovered.claim.ownershipEpoch}`),
            zagentPresenceReceiptHash: recovered.claim.zagentPresenceReceiptHash,
            bodyStored: false,
            processSpawned: false,
            commitEnabled: false,
            githubEffectsEnabled: false,
          });
          ctx.ui.notify(`Wheel local machine ${machineId} recovered at epoch ${recovered.claim.ownershipEpoch}; commit/GitHub remain disabled`, "info");
        } catch (error) {
          ctx.ui.notify(`Wheel local machine recovery blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "local-machine-status") {
        const launchId = parts.shift();
        const machineId = parts.shift();
        if (!launchId || !machineId || parts.length > 0) return ctx.ui.notify("Usage: /wheel-zob local-machine-status <launch-id> <machine-id>", "warning");
        try {
          const status = new FileWheelLocalMachineLaunchStore(ctx.cwd, launchId, machineId).status();
          ctx.ui.notify(
            `Wheel local machine ${machineId}: status=${status.claim?.status ?? "unclaimed"} epoch=${status.claim?.ownershipEpoch ?? 0} events=${status.eventCount} journal=${status.journalHeadHash} integrity=${status.valid ? "pass" : `fail(${status.issueCodes.join(",")})`} ownership=${status.ownershipLive ? "live" : "not-live"} recovery=${status.recoveryRequired ? status.recoveryReasons.join(",") : "none"} commit/GitHub=false`,
            status.valid ? "info" : "error",
          );
        } catch (error) {
          ctx.ui.notify(`Wheel local machine status blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "local-machine-ready") {
        const launchId = parts.shift();
        const machineId = parts.shift();
        const epochRaw = parts.shift();
        const evidenceRef = parts.shift();
        const evidenceHash = parts.shift();
        const ownershipEpoch = Number(epochRaw);
        if (!launchId || !machineId || !Number.isSafeInteger(ownershipEpoch) || ownershipEpoch < 1 || !evidenceRef || !evidenceHash || parts.length > 0) {
          return ctx.ui.notify("Usage: /wheel-zob local-machine-ready <launch-id> <machine-id> <epoch> <evidence-ref> <evidence-sha256>", "warning");
        }
        try {
          const ownerId = wheelCommandOwnerIdentity(machineId);
          const sessionId = wheelCommandSessionIdentity(ctx as unknown as WheelCommandSessionContext, machineId);
          const store = new FileWheelLocalMachineLaunchStore(ctx.cwd, launchId, machineId);
          const claim = store.transition({
            ownerId,
            sessionId,
            ownershipEpoch,
            mutationId: `local-ready-${sha256Text(`${launchId}:${machineId}:${ownershipEpoch}:${evidenceRef}:${evidenceHash}`).slice(0, 24)}`,
            status: "local-ready",
            evidenceRefs: [evidenceRef],
            evidenceHashes: [evidenceHash],
          }).claim;
          pi.appendEntry("wheel-zob-pack", {
            event: "local_machine_ready",
            launchId,
            machineId,
            planHash: claim.planHash,
            assignmentHash: claim.assignmentHash,
            claimId: claim.claimId,
            ownershipEpoch: claim.ownershipEpoch,
            evidenceRefCount: claim.evidenceRefs.length,
            evidenceHash: sha256Text(claim.evidenceHashes.join(":")),
            bodyStored: false,
            commitEnabled: false,
            githubEffectsEnabled: false,
          });
          ctx.ui.notify(`Wheel local machine ${machineId} is local-ready with hash-bound evidence; commit/GitHub still require separate PR handoff authority`, "info");
        } catch (error) {
          ctx.ui.notify(`Wheel local-ready transition blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "prepare-pr-handoff") {
        const launchId = parts.shift();
        const machineId = parts.shift();
        const storyId = parts.shift();
        const candidateId = parts.shift();
        const phase = parts.shift();
        const storyWorkspaceRoot = parts.shift();
        const baseRef = parts.shift();
        const commitReceiptRaw = parts.shift();
        const evidenceRef = parts.shift();
        const evidenceHash = parts.shift();
        const actionsRaw = parts.shift();
        if (!launchId || !machineId || !storyId || !candidateId || (phase !== "pre-commit" && phase !== "post-commit") || !storyWorkspaceRoot || !baseRef || !commitReceiptRaw || !evidenceRef || !evidenceHash || !actionsRaw || parts.length > 0) {
          return ctx.ui.notify("Usage: /wheel-zob prepare-pr-handoff <launch-id> <machine-id> <story-id> <candidate-id> <pre-commit|post-commit> <story-worktree-path> <base-ref> <commit-receipt-id|NONE> <evidence-ref> <evidence-sha256> <actions-csv>", "warning");
        }
        try {
          const requestedActions = actionsRaw.split(",").filter(Boolean) as WheelPrHandoffAction[];
          const prepared = prepareWheelPrHandoffCandidateFromWorkspace(ctx.cwd, {
            launchId,
            machineId,
            candidateId,
            phase,
            storyIds: [storyId],
            storyWorkspaceRoot,
            baseRef,
            commitReceiptId: phase === "post-commit" ? commitReceiptRaw : undefined,
            evidenceRefs: [evidenceRef],
            evidenceHashes: [evidenceHash],
            requestedActions,
          });
          pi.appendEntry("wheel-zob-pack", {
            event: "pr_handoff_candidate_prepared",
            launchId,
            machineId,
            candidateId,
            candidateHash: prepared.candidate.candidateHash,
            phase,
            storyId,
            machineJournalHeadHash: prepared.candidate.machineJournalHeadHash,
            machineOwnershipEpoch: prepared.candidate.machineOwnershipEpoch,
            storyWorkspaceRootHash: prepared.candidate.storyWorkspaceRootHash,
            commitReceiptId: prepared.candidate.commitReceiptId,
            commitReceiptHash: prepared.candidate.commitReceiptHash,
            baseSha: prepared.candidate.baseSha,
            headSha: prepared.candidate.headSha,
            contentHash: prepared.candidate.contentHash,
            diffHash: prepared.candidate.diffHash,
            requestedActions,
            replay: prepared.replay,
            bodyStored: false,
            authorityGranted: false,
            externalEffectsPerformed: false,
            mergeEnabled: false,
            deploymentEnabled: false,
          });
          ctx.ui.notify(`Wheel PR handoff candidate ready: ${candidateId} phase=${phase} candidate=${prepared.candidate.candidateHash} head=${prepared.candidate.headSha} actions=${requestedActions.join(",")} · no commit/GitHub effect`, "info");
        } catch (error) {
          ctx.ui.notify(`Wheel PR handoff preparation blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "record-pr-commit") {
        const launchId = parts.shift();
        const preCommitCandidateId = parts.shift();
        const commitAuthorityId = parts.shift();
        const receiptId = parts.shift();
        const storyWorkspaceRoot = parts.shift();
        const governedCommitEvidenceRef = parts.shift();
        const governedCommitEvidenceHash = parts.shift();
        if (!launchId || !preCommitCandidateId || !commitAuthorityId || !receiptId || !storyWorkspaceRoot || !governedCommitEvidenceRef || !governedCommitEvidenceHash || parts.length > 0) {
          return ctx.ui.notify("Usage: /wheel-zob record-pr-commit <launch-id> <pre-commit-candidate-id> <commit-authority-id> <receipt-id> <story-worktree-path> <governed-zcommit-evidence-ref> <evidence-sha256>", "warning");
        }
        try {
          const recorded = recordWheelPrHandoffCommitReceiptFromWorkspace(ctx.cwd, {
            launchId,
            receiptId,
            preCommitCandidateId,
            commitAuthorityId,
            storyWorkspaceRoot,
            governedCommitEvidenceRef,
            governedCommitEvidenceHash,
          });
          pi.appendEntry("wheel-zob-pack", {
            event: "pr_handoff_commit_recorded",
            launchId,
            receiptId,
            receiptHash: recorded.receipt.receiptHash,
            preCommitCandidateId,
            preCommitCandidateHash: recorded.receipt.preCommitCandidateHash,
            commitAuthorityId,
            commitAuthorityHash: recorded.receipt.commitAuthorityHash,
            baseSha: recorded.receipt.baseSha,
            committedHeadSha: recorded.receipt.committedHeadSha,
            contentHash: recorded.receipt.contentHash,
            diffHash: recorded.receipt.diffHash,
            replay: recorded.replay,
            bodyStored: false,
            commitPerformedByThisCommand: false,
            pushEnabled: false,
            githubEffectsEnabled: false,
            mergeEnabled: false,
            deploymentEnabled: false,
          });
          ctx.ui.notify(`Wheel governed commit receipt recorded: ${receiptId} head=${recorded.receipt.committedHeadSha}; this command did not commit or enable push/GitHub`, "info");
        } catch (error) {
          ctx.ui.notify(`Wheel governed commit receipt blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "authorize-pr-handoff") {
        const launchId = parts.shift();
        const candidateId = parts.shift();
        const authorityId = parts.shift();
        const storyWorkspaceRoot = parts.shift();
        const candidateHash = parts.shift();
        const expectedHeadSha = parts.shift();
        const actionsRaw = parts.shift();
        if (!launchId || !candidateId || !authorityId || !storyWorkspaceRoot || !candidateHash || !expectedHeadSha || !actionsRaw || parts.length > 0) {
          return ctx.ui.notify("Usage: /wheel-zob authorize-pr-handoff <launch-id> <candidate-id> <authority-id> <story-worktree-path> <candidate-sha256> <expected-head-sha> <actions-csv>", "warning");
        }
        try {
          const candidate = loadWheelPrHandoffCandidate(ctx.cwd, launchId, candidateId);
          const allowedActions = actionsRaw.split(",").filter(Boolean) as WheelPrHandoffAction[];
          const authorized = authorizeWheelPrHandoffFromWorkspace(ctx.cwd, {
            launchId,
            candidateId,
            authorityId,
            actorId: wheelCommandOwnerIdentity(candidate.machineId),
            allowedActions,
            confirmationPhrase: wheelPrHandoffConfirmation(candidate, allowedActions),
            candidateHash,
            expectedHeadSha,
            storyWorkspaceRoot,
          });
          pi.appendEntry("wheel-zob-pack", {
            event: "pr_handoff_authorized",
            launchId,
            machineId: candidate.machineId,
            candidateId,
            candidateHash,
            authorityId,
            authorityHash: authorized.validation.authorityHash,
            headSha: authorized.authority.headSha,
            contentHash: authorized.authority.contentHash,
            diffHash: authorized.authority.diffHash,
            allowedActions,
            expiresAt: authorized.authority.expiresAt,
            replay: authorized.replay,
            bodyStored: false,
            externalEffectsPerformed: false,
            mergeEnabled: false,
            promotionEnabled: false,
            deploymentEnabled: false,
          });
          ctx.ui.notify(`Wheel PR handoff authorized: ${authorityId} authority=${authorized.validation.authorityHash} actions=${allowedActions.join(",")} head=${authorized.authority.headSha}; no effect executed—consume only through the matching governed adapter`, "warning");
        } catch (error) {
          ctx.ui.notify(`Wheel PR handoff authorization blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "pr-handoff-status") {
        const launchId = parts.shift();
        const candidateId = parts.shift();
        const storyWorkspaceRoot = parts.shift();
        const authorityId = parts.shift();
        if (!launchId || !candidateId || !storyWorkspaceRoot || parts.length > 0) return ctx.ui.notify("Usage: /wheel-zob pr-handoff-status <launch-id> <candidate-id> <story-worktree-path> [authority-id]", "warning");
        try {
          const status = inspectWheelPrHandoffStatus(ctx.cwd, { launchId, candidateId, storyWorkspaceRoot, authorityId });
          if (!authorityId) {
            const current = status.candidateCurrent && status.machineCurrent;
            ctx.ui.notify(`Wheel PR candidate ${candidateId}: phase=${status.phase} head=${status.headSha} current=${current} authority=none effects=false${status.errors.length ? ` errors=${status.errors.join(",")}` : ""}`, current ? "info" : "error");
            return;
          }
          ctx.ui.notify(`Wheel PR authority ${authorityId}: valid=${status.authorityValid} actions=${status.allowedActions.join(",") || "none"} head=${status.headSha} effects=false${status.errors.length ? ` errors=${status.errors.join(",")}` : ""}`, status.authorityValid ? "info" : "error");
        } catch (error) {
          ctx.ui.notify(`Wheel PR handoff status blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "run-machine") {
        const missionId = parts.shift();
        const machineId = parts.shift();
        const bundlePath = parts.shift();
        if (!missionId || !machineId || !bundlePath || parts.length > 0) {
          return ctx.ui.notify("Usage: /wheel-zob run-machine <mission-id> <machine-id> <machine-bundle.json>", "warning");
        }
        if (!ctx.isIdle()) return ctx.ui.notify("Wait for the current agent turn to finish, then run the machine again.", "warning");
        const preview = previewWheelMachineMissionFromFile(ctx.cwd, { missionId, machineId, bundlePath });
        const publicPlan = preview.result?.planned === true ? preview.result.publicPlan : undefined;
        if (!preview.planned || !publicPlan || !preview.bundleHash || !preview.machineId) {
          return ctx.ui.notify(`Wheel machine blocked: ${preview.errors.join("; ")}`, "error");
        }
        pi.appendEntry("wheel-zob-pack", {
          event: "machine_run_requested",
          missionId,
          machineId: preview.machineId,
          allocationUnitCount: preview.allocationUnitIds.length,
          storyCount: publicPlan.storyCount,
          bundleHash: preview.bundleHash,
          seedCommitment: publicPlan.seedCommitment,
          humanGateStoryCount: preview.humanGateStoryIds.length,
          bodyStored: false,
          githubEffectsEnabled: false,
          deploymentEnabled: false,
        });
        if (!pi.getSessionName()) pi.setSessionName(`Wheel ${preview.machineId} · ${missionId}`);
        ctx.ui.notify(`Starting Wheel ${preview.machineId}: ${publicPlan.storyCount} assigned story(s) in Pi; GitHub/deploy disabled`, "info");
        pi.sendUserMessage(buildWheelMachineRunPrompt({
          missionId,
          machineId: preview.machineId,
          bundlePath,
          bundleHash: preview.bundleHash,
          allocationUnitIds: preview.allocationUnitIds,
          storyPaths: preview.storyPaths,
          seedCommitment: publicPlan.seedCommitment,
          stories: publicPlan.stories.map((story) => ({ storyId: story.storyId, revision: story.revision })),
          humanGateStoryIds: preview.humanGateStoryIds,
        }));
        return;
      }
      if (action === "supervisor-plan") {
        const missionId = parts.shift();
        const bundlePath = parts.shift();
        if (!missionId || !bundlePath || parts.length > 0) return ctx.ui.notify("Usage: /wheel-zob supervisor-plan <mission-id> <machine-bundle.json>", "warning");
        const prepared = prepareWheelSupervisorFromMachineBundle(ctx.cwd, { missionId, bundlePath, mode: "disabled" });
        pi.appendEntry("wheel-zob-pack", {
          event: "supervisor_plan",
          missionId,
          prepared: prepared.summary.prepared,
          bundleHash: prepared.summary.bundleHash,
          machineCount: prepared.summary.machineIds.length,
          storyCount: prepared.summary.storyIds.length,
          humanGateStoryCount: prepared.summary.humanGateStoryIds.length,
          bodyStored: false,
          dispatchEnabled: false,
          externalEffects: false,
        });
        ctx.ui.notify(
          prepared.summary.prepared
            ? `Wheel supervisor plan ready: ${prepared.summary.machineIds.length} machine(s), ${prepared.summary.storyIds.length} story(s), activation disabled`
            : `Wheel supervisor plan blocked: ${prepared.summary.errors.join("; ")}`,
          prepared.summary.prepared ? "info" : "error",
        );
        return;
      }
      if (action === "supervisor-init") {
        const missionId = parts.shift();
        const bundlePath = parts.shift();
        const stateDirectory = parts.shift();
        const mode = parts.shift() ?? "disabled";
        if (!missionId || !bundlePath || !stateDirectory || parts.length > 0 || (mode !== "disabled" && mode !== "deterministic-fake")) {
          return ctx.ui.notify("Usage: /wheel-zob supervisor-init <mission-id> <machine-bundle.json> <reports/wheel-zob/supervisor/...> [disabled|deterministic-fake]", "warning");
        }
        const initialized = initializeWheelSupervisorFromMachineBundle(ctx.cwd, { missionId, bundlePath, stateDirectory, mode });
        pi.appendEntry("wheel-zob-pack", {
          event: "supervisor_initialized",
          missionId,
          prepared: initialized.summary.prepared,
          mode,
          bundleHash: initialized.summary.bundleHash,
          storyCount: initialized.summary.storyIds.length,
          journalSequence: initialized.state?.journalSequence,
          bodyStored: false,
          providerCallsEnabled: false,
          githubEffectsEnabled: false,
        });
        ctx.ui.notify(
          initialized.state
            ? `Wheel supervisor initialized: ${initialized.summary.storyIds.length} story(s), mode=${mode}, external effects disabled`
            : `Wheel supervisor initialization blocked: ${initialized.summary.errors.join("; ")}`,
          initialized.state ? "info" : "error",
        );
        return;
      }
      if (action === "supervisor-run-fake") {
        const missionId = parts.shift();
        const bundlePath = parts.shift();
        const stateDirectory = parts.shift();
        if (!missionId || !bundlePath || !stateDirectory || parts.length > 0) return ctx.ui.notify("Usage: /wheel-zob supervisor-run-fake <mission-id> <machine-bundle.json> <reports/wheel-zob/supervisor/...>", "warning");
        if (!ctx.isIdle()) return ctx.ui.notify("Wait for the current agent turn to finish, then run the fake supervisor.", "warning");
        const executed = await runWheelSupervisorFakeFromMachineBundle(ctx.cwd, { missionId, bundlePath, stateDirectory });
        const validation = validateWheelSupervisorPersistedState(new FileWheelSupervisorStore(executed.stateDirectory));
        const noShipReasonCount = executed.state?.noShipReasons.length ?? 0;
        pi.appendEntry("wheel-zob-pack", {
          event: "supervisor_fake_run",
          missionId,
          status: executed.run?.status,
          bundleHash: executed.summary.bundleHash,
          completedStoryCount: executed.run?.completedStoryIds.length ?? 0,
          blockedStoryCount: executed.run?.blockedStoryIds.length ?? 0,
          pendingStoryCount: executed.run?.pendingStoryIds.length ?? 0,
          noShipReasonCount,
          validationValid: validation.valid,
          validationIssueCount: validation.issueCodes.length,
          eventCount: executed.run?.eventCount ?? 0,
          settledCostUsd: executed.state?.budgetLedger.settledCostUsd ?? 0,
          bodyStored: false,
          providerCallsPerformed: false,
          externalEffectsPerformed: false,
        });
        ctx.ui.notify(
          executed.run
            ? `Wheel fake supervisor ${executed.run.status}: complete=${executed.run.completedStoryIds.length} blocked=${executed.run.blockedStoryIds.length} pending=${executed.run.pendingStoryIds.length} no-ship=${noShipReasonCount} validation=${validation.valid ? "pass" : `fail(${validation.issueCodes.join(",")})`}; effects=false`
            : `Wheel fake supervisor blocked: ${executed.summary.errors.join("; ")}`,
          executed.run && validation.valid && (executed.run.status === "complete" || executed.run.status === "needs-human") ? "info" : "error",
        );
        return;
      }
      if (action === "supervisor-resolve-human") {
        const stateDirectory = parts.shift();
        const storyId = parts.shift();
        const receiptHash = parts.shift();
        const ownerId = parts.shift();
        if (!stateDirectory || !storyId || !receiptHash || parts.length > 0) return ctx.ui.notify("Usage: /wheel-zob supervisor-resolve-human <reports/wheel-zob/supervisor/...> <story-id> <receipt-sha256> [owner-id]", "warning");
        try {
          const authority = createDeterministicFakeWheelSupervisorAuthority();
          const supervisor = new WheelFleetSupervisor(
            new FileWheelSupervisorStore(resolveWheelSupervisorStateDirectory(ctx.cwd, stateDirectory), { checkpointEvery: 25 }),
            authority,
            {
              dispatch: new DeterministicFakeWheelDispatchAdapter(),
              effects: new DeterministicFakeWheelStoryEffectBroker(),
            },
          );
          const before = supervisor.load();
          supervisor.takeOwnership(ownerId ?? `wheel-supervisor-${before.missionId}`);
          const state = supervisor.resolveHumanGate(storyId, receiptHash);
          const validation = validateWheelSupervisorPersistedState(supervisor.store);
          pi.appendEntry("wheel-zob-pack", {
            event: "supervisor_human_gate_resolved",
            missionId: state.missionId,
            storyId,
            journalSequence: state.journalSequence,
            noShipReasonCount: state.noShipReasons.length,
            validationValid: validation.valid,
            validationIssueCount: validation.issueCodes.length,
            receiptStoredAsHashOnly: true,
            bodyStored: false,
            providerCallsPerformed: false,
            externalEffectsPerformed: false,
          });
          ctx.ui.notify(
            `Wheel fake supervisor gate resolved for ${storyId}; no-ship=${state.noShipReasons.length} validation=${validation.valid ? "pass" : `fail(${validation.issueCodes.join(",")})`}; rerun supervisor-run-fake to continue.`,
            validation.valid ? "info" : "error",
          );
        } catch (error) {
          ctx.ui.notify(`Wheel supervisor gate resolution blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "supervisor-status") {
        const stateDirectory = parts.shift();
        if (!stateDirectory || parts.length > 0) return ctx.ui.notify("Usage: /wheel-zob supervisor-status <reports/wheel-zob/supervisor/...>", "warning");
        try {
          const store = new FileWheelSupervisorStore(resolveWheelSupervisorStateDirectory(ctx.cwd, stateDirectory));
          const state = store.load();
          if (!state) return ctx.ui.notify("Wheel supervisor state is not initialized.", "warning");
          const validation = validateWheelSupervisorPersistedState(store);
          const stories = Object.values(state.stories);
          ctx.ui.notify(
            `Wheel supervisor ${state.status}: complete=${stories.filter((story) => story.stage === "needs-review").length} needs-human=${stories.filter((story) => story.stage === "needs-human").length} dependency-blocked=${validation.dependencyBlockedStoryCount} total=${stories.length} no-ship=${state.noShipReasons.length} validation=${validation.valid ? "pass" : `fail(${validation.issueCodes.join(",")})`}`,
            validation.valid ? "info" : "error",
          );
        } catch (error) {
          ctx.ui.notify(`Wheel supervisor status blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "run") {
        const missionId = parts.shift();
        if (!missionId || parts.length === 0) return ctx.ui.notify("Usage: /wheel-zob run <mission-id> <story.json...>", "warning");
        if (!ctx.isIdle()) return ctx.ui.notify("Wait for the current agent turn to finish, then run the mission again.", "warning");
        const preview = previewWheelMissionFromFiles(ctx.cwd, { missionId, storyPaths: parts });
        const publicPlan = preview.result?.planned === true ? preview.result.publicPlan : undefined;
        if (!preview.planned || !publicPlan) return ctx.ui.notify(`Wheel mission blocked: ${preview.errors.join("; ")}`, "error");
        pi.appendEntry("wheel-zob-pack", {
          event: "mission_run_requested",
          missionId,
          storyCount: publicPlan.storyCount,
          seedCommitment: publicPlan.seedCommitment,
          bodyStored: false,
          githubEffectsEnabled: false,
          deploymentEnabled: false,
        });
        if (!pi.getSessionName()) pi.setSessionName(`Wheel mission ${missionId}`);
        ctx.ui.notify(`Starting Wheel mission ${missionId}: ${publicPlan.storyCount} story(s) in Pi; GitHub/deploy disabled`, "info");
        pi.sendUserMessage(buildWheelRunPrompt({
          missionId,
          storyPaths: parts,
          seedCommitment: publicPlan.seedCommitment,
          stories: publicPlan.stories.map((story) => ({ storyId: story.storyId, revision: story.revision })),
        }));
        return;
      }
      if (action === "validate") {
        const storyPath = parts[0];
        if (!storyPath) return ctx.ui.notify("Usage: /wheel-zob validate <story.json>", "warning");
        const result = validateWheelStoryFile(ctx.cwd, storyPath);
        ctx.ui.notify(result.valid ? `Wheel story valid: ${result.storyId} r${result.revision}` : `Wheel story invalid: ${result.issues.length} issue(s)`, result.valid ? "info" : "error");
        return;
      }
      if (action === "plan") {
        const missionId = parts.shift();
        if (!missionId || parts.length === 0) return ctx.ui.notify("Usage: /wheel-zob plan <mission-id> <story.json...>", "warning");
        const preview = previewWheelMissionFromFiles(ctx.cwd, { missionId, storyPaths: parts });
        const publicPlan = preview.result?.planned === true ? preview.result.publicPlan : undefined;
        ctx.ui.notify(preview.planned ? `Wheel mission preview ready: ${publicPlan?.storyCount ?? 0} story(s), dispatch disabled` : `Wheel mission preview blocked: ${preview.errors.join("; ")}`, preview.planned ? "info" : "error");
        return;
      }
      if (action === "simulate") {
        const missionId = parts[0];
        if (!missionId) return ctx.ui.notify("Usage: /wheel-zob simulate <mission-id>", "warning");
        const result = simulateWheelFactoryHappyPath(createWheelFactoryPipeline({ missionId, storyId: "preview-story", pullRequestId: "preview-pr", candidateId: "preview-candidate", windowId: "preview-window", simulation: true }));
        ctx.ui.notify(result.completed ? `Wheel pipeline simulation complete: ${missionId}; external effects disabled` : `Wheel pipeline simulation blocked at ${result.blockedAt}: ${result.reason}`, result.completed ? "info" : "error");
        return;
      }
      if (action === "pools") {
        const validation = validateWheelModelRegistry();
        const pools = Object.entries(WHEEL_RANDOMIZED_ROLE_POOLS).map(([name, routes]) => `${name}=${routes.length}`).join(" · ");
        ctx.ui.notify(`Wheel pools ${validation.valid ? "verified" : "invalid"} · orchestrator=Sol/high · ${pools}`, validation.valid ? "info" : "error");
        return;
      }
      ctx.ui.notify(`Usage: ${WHEEL_COMMAND_USAGE}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const validation = validateWheelModelRegistry();
    ctx.ui.setStatus("wheel-zob-pack", validation.valid ? `Wheel pack · ${Object.keys(WHEEL_RANDOMIZED_ROLE_POOLS).length} pools · Sol orchestrator` : "Wheel pack invalid");
  });

  void WHEEL_FIXED_ROLE_ROUTES;
}
