#!/usr/bin/env node
import {
  createWheelFactoryPipeline,
  FileWheelLocalMachineLaunchStore,
  previewWheelMachineMissionFromFile,
  previewWheelMissionFromFiles,
  prepareWheelSupervisorFromMachineBundle,
  initializeWheelSupervisorFromMachineBundle,
  runWheelSupervisorFakeFromMachineBundle,
  resolveWheelSupervisorStateDirectory,
  FileWheelSupervisorStore,
  WheelFleetSupervisor,
  DeterministicFakeWheelDispatchAdapter,
  DeterministicFakeWheelStoryEffectBroker,
  createDeterministicFakeWheelSupervisorAuthority,
  loadWheelLocalMachineLaunchPlan,
  persistWheelLocalMachineLaunchPlan,
  prepareWheelLocalMachineLaunch,
  prepareWheelPrHandoffCandidateFromWorkspace,
  recordWheelPrHandoffCommitReceiptFromWorkspace,
  authorizeWheelPrHandoffFromWorkspace,
  inspectWheelPrHandoffStatus,
  loadWheelPrHandoffCandidate,
  validateWheelLocalMachineLaunchPlan,
  wheelPrHandoffConfirmation,
  type WheelPrHandoffAction,
  validateWheelSupervisorPersistedState,
  simulateWheelFactoryHappyPath,
  validateWheelModelRegistry,
  validateWheelStoryFile,
  WHEEL_RANDOMIZED_ROLE_POOLS,
} from "../../packages/wheel-zob-pack/index.js";

const [action, ...args] = process.argv.slice(2);
const cwd = process.cwd();

if (action === "validate") {
  const path = args[0];
  if (!path) throw new Error("Usage: wheel-zob validate <story.json>");
  const result = validateWheelStoryFile(cwd, path);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid ? 0 : 1;
} else if (action === "plan") {
  const missionId = args.shift();
  if (!missionId || args.length === 0) throw new Error("Usage: wheel-zob plan <mission-id> <story.json...>");
  const preview = previewWheelMissionFromFiles(cwd, { missionId, storyPaths: args });
  if (preview.result?.planned === true) console.log(JSON.stringify(preview.result.publicPlan, null, 2));
  else console.error(JSON.stringify({ schema: preview.schema, planned: false, errors: preview.errors, bodyStored: false }, null, 2));
  process.exitCode = preview.planned ? 0 : 1;
} else if (action === "plan-machine") {
  const missionId = args.shift();
  const machineId = args.shift();
  const bundlePath = args.shift();
  if (!missionId || !machineId || !bundlePath || args.length > 0) {
    throw new Error("Usage: wheel-zob plan-machine <mission-id> <machine-id> <machine-bundle.json>");
  }
  const preview = previewWheelMachineMissionFromFile(cwd, { missionId, machineId, bundlePath });
  if (preview.result?.planned === true) {
    console.log(JSON.stringify({
      schema: preview.schema,
      planned: true,
      bundleId: preview.bundleId,
      bundleHash: preview.bundleHash,
      machineId: preview.machineId,
      allocationUnitIds: preview.allocationUnitIds,
      storyIds: preview.storyIds,
      humanGateStoryIds: preview.humanGateStoryIds,
      publicPlan: preview.result.publicPlan,
      bodyStored: false,
    }, null, 2));
  } else {
    console.error(JSON.stringify({ schema: preview.schema, planned: false, errors: preview.errors, bodyStored: false }, null, 2));
  }
  process.exitCode = preview.planned ? 0 : 1;
} else if (action === "supervisor-plan") {
  const missionId = args.shift();
  const bundlePath = args.shift();
  if (!missionId || !bundlePath || args.length > 0) throw new Error("Usage: wheel-zob supervisor-plan <mission-id> <machine-bundle.json>");
  const prepared = prepareWheelSupervisorFromMachineBundle(cwd, { missionId, bundlePath, mode: "disabled" });
  console.log(JSON.stringify(prepared.summary, null, 2));
  process.exitCode = prepared.summary.prepared ? 0 : 1;
} else if (action === "supervisor-init") {
  const missionId = args.shift();
  const bundlePath = args.shift();
  const stateDirectory = args.shift();
  const mode = args.shift() ?? "disabled";
  if (!missionId || !bundlePath || !stateDirectory || args.length > 0 || (mode !== "disabled" && mode !== "deterministic-fake")) {
    throw new Error("Usage: wheel-zob supervisor-init <mission-id> <machine-bundle.json> <reports/wheel-zob/supervisor/...> [disabled|deterministic-fake]");
  }
  const initialized = initializeWheelSupervisorFromMachineBundle(cwd, { missionId, bundlePath, stateDirectory, mode });
  console.log(JSON.stringify({
    ...initialized.summary,
    stateDirectory: initialized.stateDirectory,
    status: initialized.state?.status,
    journalSequence: initialized.state?.journalSequence,
  }, null, 2));
  process.exitCode = initialized.state ? 0 : 1;
} else if (action === "supervisor-run-fake") {
  const missionId = args.shift();
  const bundlePath = args.shift();
  const stateDirectory = args.shift();
  const maxTicksRaw = args.shift();
  if (!missionId || !bundlePath || !stateDirectory || args.length > 0) {
    throw new Error("Usage: wheel-zob supervisor-run-fake <mission-id> <machine-bundle.json> <reports/wheel-zob/supervisor/...> [max-ticks]");
  }
  const maxTicks = maxTicksRaw === undefined ? undefined : Number(maxTicksRaw);
  if (maxTicks !== undefined && (!Number.isSafeInteger(maxTicks) || maxTicks <= 0)) throw new Error("max-ticks must be a positive safe integer");
  const executed = await runWheelSupervisorFakeFromMachineBundle(cwd, { missionId, bundlePath, stateDirectory, maxTicks });
  const validation = validateWheelSupervisorPersistedState(new FileWheelSupervisorStore(executed.stateDirectory));
  console.log(JSON.stringify({
    ...executed.summary,
    stateDirectory: executed.stateDirectory,
    status: executed.run?.status,
    eventCount: executed.run?.eventCount,
    completedStoryIds: executed.run?.completedStoryIds ?? [],
    blockedStoryIds: executed.run?.blockedStoryIds ?? [],
    pendingStoryIds: executed.run?.pendingStoryIds ?? [],
    noShipReasons: executed.state?.noShipReasons ?? [],
    externalEffectsPerformed: executed.run?.externalEffectsPerformed ?? false,
    providerCallsPerformed: executed.run?.providerCallsPerformed ?? false,
    settledCostUsd: executed.state?.budgetLedger.settledCostUsd,
    validation,
  }, null, 2));
  process.exitCode = executed.run
    && validation.valid
    && (executed.run.status === "complete" || executed.run.status === "needs-human") ? 0 : 1;
} else if (action === "supervisor-resolve-human") {
  const stateDirectory = args.shift();
  const storyId = args.shift();
  const receiptHash = args.shift();
  const ownerId = args.shift();
  if (!stateDirectory || !storyId || !receiptHash || args.length > 0) {
    throw new Error("Usage: wheel-zob supervisor-resolve-human <reports/wheel-zob/supervisor/...> <story-id> <receipt-sha256> [owner-id]");
  }
  const resolved = resolveWheelSupervisorStateDirectory(cwd, stateDirectory);
  const authority = createDeterministicFakeWheelSupervisorAuthority();
  const supervisor = new WheelFleetSupervisor(
    new FileWheelSupervisorStore(resolved, { checkpointEvery: 25 }),
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
  console.log(JSON.stringify({
    schema: "wheel.zob.supervisor-human-gate-resolution.v1",
    missionId: state.missionId,
    storyId,
    status: state.status,
    storyStage: state.stories[storyId]?.stage,
    journalSequence: state.journalSequence,
    noShipReasons: state.noShipReasons,
    validation: { valid: validation.valid, issueCodes: validation.issueCodes },
    receiptStoredAsHashOnly: true,
    externalEffectsPerformed: false,
    providerCallsPerformed: false,
    bodyStored: false,
  }, null, 2));
  process.exitCode = validation.valid ? 0 : 1;
} else if (action === "supervisor-validate") {
  const stateDirectory = args.shift();
  if (!stateDirectory || args.length > 0) throw new Error("Usage: wheel-zob supervisor-validate <reports/wheel-zob/supervisor/...>");
  const resolved = resolveWheelSupervisorStateDirectory(cwd, stateDirectory);
  const validation = validateWheelSupervisorPersistedState(new FileWheelSupervisorStore(resolved));
  console.log(JSON.stringify(validation, null, 2));
  process.exitCode = validation.valid ? 0 : 1;
} else if (action === "supervisor-status") {
  const stateDirectory = args.shift();
  if (!stateDirectory || args.length > 0) throw new Error("Usage: wheel-zob supervisor-status <reports/wheel-zob/supervisor/...>");
  const resolved = resolveWheelSupervisorStateDirectory(cwd, stateDirectory);
  const store = new FileWheelSupervisorStore(resolved);
  const state = store.load();
  if (!state) throw new Error("supervisor state is not initialized");
  const validation = validateWheelSupervisorPersistedState(store);
  const stories = Object.values(state.stories);
  console.log(JSON.stringify({
    schema: "wheel.zob.supervisor-status.v1",
    missionId: state.missionId,
    bundleId: state.bundleId,
    bundleHash: state.bundleHash,
    sourceSha: state.sourceSha,
    status: state.status,
    mode: state.mode,
    journalSequence: state.journalSequence,
    journalHeadHash: state.journalHeadHash,
    storyCount: stories.length,
    completedStoryIds: stories.filter((story) => story.stage === "needs-review").map((story) => story.storyId),
    needsHumanStoryIds: stories.filter((story) => story.stage === "needs-human").map((story) => story.storyId),
    dependencyBlockedStoryIds: validation.dependencyBlockedStoryIds,
    pendingStoryIds: stories.filter((story) => !["needs-review", "needs-human", "failed"].includes(story.stage)).map((story) => story.storyId),
    noShipReasons: state.noShipReasons,
    settledCostUsd: state.budgetLedger.settledCostUsd,
    validation: { valid: validation.valid, issueCodes: validation.issueCodes },
    bodyStored: false,
  }, null, 2));
  process.exitCode = validation.valid ? 0 : 1;
} else if (action === "prepare-local-launch") {
  const launchId = args.shift();
  const missionId = args.shift();
  const bundlePath = args.shift();
  if (!launchId || !missionId || !bundlePath || args.length === 0) {
    throw new Error("Usage: wheel-zob prepare-local-launch <launch-id> <mission-id> <machine-bundle.json> <machine-id...>");
  }
  const prepared = prepareWheelLocalMachineLaunch(cwd, {
    launchId,
    missionId,
    bundlePath,
    machineIds: args,
  });
  if (!prepared.prepared || !prepared.plan) {
    console.error(JSON.stringify(prepared, null, 2));
    process.exitCode = 1;
  } else {
    const persisted = persistWheelLocalMachineLaunchPlan(cwd, prepared.plan);
    console.log(JSON.stringify({
      schema: prepared.schema,
      prepared: true,
      launchId,
      missionId,
      planRef: persisted.planRef,
      planHash: prepared.plan.planHash,
      bundleId: prepared.plan.bundleId,
      bundleHash: prepared.plan.bundleHash,
      sourceSha: prepared.plan.sourceSha,
      selectedMachineIds: prepared.plan.selectedMachineIds,
      storyIds: prepared.plan.storyIds,
      expiresAt: prepared.plan.expiresAt,
      confirmationPhrases: prepared.confirmationPhrases,
      replay: persisted.replay,
      processSpawned: false,
      providerCallsMade: false,
      sourceMutationsMade: false,
      gitMutationsMade: false,
      reportArtifactsWritten: true,
      githubEffectsMade: false,
      spendIncurred: false,
      bodyStored: false,
    }, null, 2));
  }
} else if (action === "local-launch-status" || action === "local-launch-validate") {
  const launchId = args.shift();
  if (!launchId || args.length > 0) throw new Error(`Usage: wheel-zob ${action} <launch-id>`);
  try {
    const plan = loadWheelLocalMachineLaunchPlan(cwd, launchId, { allowExpired: true });
    const validation = validateWheelLocalMachineLaunchPlan(plan);
    const machineStatuses = plan.selectedMachineIds.map((machineId) => new FileWheelLocalMachineLaunchStore(cwd, launchId, machineId).status());
    console.log(JSON.stringify({
      schema: "wheel.zob.local-launch-status.v1",
      launchId: plan.launchId,
      missionId: plan.missionId,
      planHash: plan.planHash,
      bundleId: plan.bundleId,
      bundleHash: plan.bundleHash,
      sourceSha: plan.sourceSha,
      selectedMachineIds: plan.selectedMachineIds,
      storyIds: plan.storyIds,
      preparedAt: plan.preparedAt,
      expiresAt: plan.expiresAt,
      valid: validation.valid && machineStatuses.every((status) => status.valid),
      errors: [...validation.errors, ...machineStatuses.flatMap((status) => status.issueCodes.map((issue) => `${status.machineId}:${issue}`))],
      machineStatuses,
      processSpawned: false,
      activationEnabled: false,
      commitEnabled: false,
      githubEffectsEnabled: false,
      bodyStored: false,
    }, null, 2));
    process.exitCode = validation.valid && machineStatuses.every((status) => status.valid) ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({
      schema: "wheel.zob.local-machine-launch-status.v1",
      launchId,
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      processSpawned: false,
      activationEnabled: false,
      commitEnabled: false,
      githubEffectsEnabled: false,
      bodyStored: false,
    }, null, 2));
    process.exitCode = 1;
  }
} else if (action === "local-machine-status") {
  const launchId = args.shift();
  const machineId = args.shift();
  if (!launchId || !machineId || args.length > 0) throw new Error("Usage: wheel-zob local-machine-status <launch-id> <machine-id>");
  const status = new FileWheelLocalMachineLaunchStore(cwd, launchId, machineId).status();
  console.log(JSON.stringify(status, null, 2));
  process.exitCode = status.valid ? 0 : 1;
} else if (action === "local-machine-repair-checkpoint") {
  const launchId = args.shift();
  const machineId = args.shift();
  if (!launchId || !machineId || args.length > 0) throw new Error("Usage: wheel-zob local-machine-repair-checkpoint <launch-id> <machine-id>");
  const status = new FileWheelLocalMachineLaunchStore(cwd, launchId, machineId).repairCheckpoint();
  console.log(JSON.stringify(status, null, 2));
  process.exitCode = status.valid && status.checkpointCurrent ? 0 : 1;
} else if (action === "prepare-pr-handoff") {
  const launchId = args.shift();
  const machineId = args.shift();
  const storyId = args.shift();
  const candidateId = args.shift();
  const phase = args.shift();
  const storyWorkspaceRoot = args.shift();
  const baseRef = args.shift();
  const commitReceiptRaw = args.shift();
  const evidenceRef = args.shift();
  const evidenceHash = args.shift();
  const actionsRaw = args.shift();
  if (!launchId || !machineId || !storyId || !candidateId || (phase !== "pre-commit" && phase !== "post-commit") || !storyWorkspaceRoot || !baseRef || !commitReceiptRaw || !evidenceRef || !evidenceHash || !actionsRaw || args.length > 0) {
    throw new Error("Usage: wheel-zob prepare-pr-handoff <launch-id> <machine-id> <story-id> <candidate-id> <pre-commit|post-commit> <story-worktree-path> <base-ref> <commit-receipt-id|NONE> <evidence-ref> <evidence-sha256> <actions-csv>");
  }
  const requestedActions = actionsRaw.split(",").filter(Boolean) as WheelPrHandoffAction[];
  const prepared = prepareWheelPrHandoffCandidateFromWorkspace(cwd, {
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
  console.log(JSON.stringify({
    schema: "wheel.zob.pr-handoff-preparation.v1",
    prepared: true,
    candidateRef: prepared.candidateRef,
    candidateId: prepared.candidate.candidateId,
    candidateHash: prepared.candidate.candidateHash,
    phase: prepared.candidate.phase,
    launchId: prepared.candidate.launchId,
    machineId: prepared.candidate.machineId,
    storyIds: prepared.candidate.storyIds,
    machineJournalHeadHash: prepared.candidate.machineJournalHeadHash,
    machineOwnershipEpoch: prepared.candidate.machineOwnershipEpoch,
    storyWorkspaceRootHash: prepared.candidate.storyWorkspaceRootHash,
    commitReceiptId: prepared.candidate.commitReceiptId,
    commitReceiptHash: prepared.candidate.commitReceiptHash,
    baseRef: prepared.candidate.baseRef,
    baseSha: prepared.candidate.baseSha,
    headSha: prepared.candidate.headSha,
    treeHash: prepared.candidate.treeHash,
    contentHash: prepared.candidate.contentHash,
    diffHash: prepared.candidate.diffHash,
    changedPaths: prepared.candidate.changedPaths,
    requestedActions: prepared.candidate.requestedActions,
    fullScopeConfirmationPhrase: wheelPrHandoffConfirmation(prepared.candidate, prepared.candidate.requestedActions),
    replay: prepared.replay,
    authorityGranted: false,
    externalEffectsPerformed: false,
    mergeEnabled: false,
    promotionEnabled: false,
    deploymentEnabled: false,
    bodyStored: false,
  }, null, 2));
} else if (action === "record-pr-commit") {
  const launchId = args.shift();
  const preCommitCandidateId = args.shift();
  const commitAuthorityId = args.shift();
  const receiptId = args.shift();
  const storyWorkspaceRoot = args.shift();
  const governedCommitEvidenceRef = args.shift();
  const governedCommitEvidenceHash = args.shift();
  if (!launchId || !preCommitCandidateId || !commitAuthorityId || !receiptId || !storyWorkspaceRoot || !governedCommitEvidenceRef || !governedCommitEvidenceHash || args.length > 0) {
    throw new Error("Usage: wheel-zob record-pr-commit <launch-id> <pre-commit-candidate-id> <commit-authority-id> <receipt-id> <story-worktree-path> <governed-zcommit-evidence-ref> <evidence-sha256>");
  }
  const recorded = recordWheelPrHandoffCommitReceiptFromWorkspace(cwd, {
    launchId,
    receiptId,
    preCommitCandidateId,
    commitAuthorityId,
    storyWorkspaceRoot,
    governedCommitEvidenceRef,
    governedCommitEvidenceHash,
  });
  console.log(JSON.stringify({
    schema: "wheel.zob.pr-handoff-commit-receipt-result.v1",
    recorded: true,
    receiptRef: recorded.receiptRef,
    receiptId: recorded.receipt.receiptId,
    receiptHash: recorded.receipt.receiptHash,
    preCommitCandidateId: recorded.receipt.preCommitCandidateId,
    commitAuthorityId: recorded.receipt.commitAuthorityId,
    baseSha: recorded.receipt.baseSha,
    committedHeadSha: recorded.receipt.committedHeadSha,
    contentHash: recorded.receipt.contentHash,
    diffHash: recorded.receipt.diffHash,
    replay: recorded.replay,
    commitPerformedByThisCommand: false,
    pushEnabled: false,
    githubEffectsEnabled: false,
    mergeEnabled: false,
    deploymentEnabled: false,
    bodyStored: false,
  }, null, 2));
} else if (action === "authorize-pr-handoff") {
  const launchId = args.shift();
  const candidateId = args.shift();
  const authorityId = args.shift();
  const storyWorkspaceRoot = args.shift();
  const candidateHash = args.shift();
  const expectedHeadSha = args.shift();
  const actionsRaw = args.shift();
  const actorId = args.shift();
  if (!launchId || !candidateId || !authorityId || !storyWorkspaceRoot || !candidateHash || !expectedHeadSha || !actionsRaw || !actorId || args.length > 0) {
    throw new Error("Usage: wheel-zob authorize-pr-handoff <launch-id> <candidate-id> <authority-id> <story-worktree-path> <candidate-sha256> <expected-head-sha> <actions-csv> <actor-id>");
  }
  const candidate = loadWheelPrHandoffCandidate(cwd, launchId, candidateId);
  const allowedActions = actionsRaw.split(",").filter(Boolean) as WheelPrHandoffAction[];
  const authorized = authorizeWheelPrHandoffFromWorkspace(cwd, {
    launchId,
    candidateId,
    authorityId,
    actorId,
    allowedActions,
    confirmationPhrase: wheelPrHandoffConfirmation(candidate, allowedActions),
    candidateHash,
    expectedHeadSha,
    storyWorkspaceRoot,
  });
  console.log(JSON.stringify({
    schema: "wheel.zob.pr-handoff-authorization-result.v1",
    authorized: true,
    authorityRef: authorized.authorityRef,
    authorityId: authorized.authority.authorityId,
    authorityHash: authorized.validation.authorityHash,
    candidateId: authorized.authority.candidateId,
    candidateHash: authorized.authority.candidateHash,
    headSha: authorized.authority.headSha,
    contentHash: authorized.authority.contentHash,
    diffHash: authorized.authority.diffHash,
    allowedActions: authorized.authority.allowedActions,
    expiresAt: authorized.authority.expiresAt,
    replay: authorized.replay,
    externalEffectsPerformed: false,
    nextStep: "consume only through the separately governed commit/push/application GitHub adapter matching this authority",
    mergeEnabled: false,
    promotionEnabled: false,
    deploymentEnabled: false,
    bodyStored: false,
  }, null, 2));
} else if (action === "pr-handoff-status") {
  const launchId = args.shift();
  const candidateId = args.shift();
  const storyWorkspaceRoot = args.shift();
  const authorityId = args.shift();
  if (!launchId || !candidateId || !storyWorkspaceRoot || args.length > 0) {
    throw new Error("Usage: wheel-zob pr-handoff-status <launch-id> <candidate-id> <story-worktree-path> [authority-id]");
  }
  const status = inspectWheelPrHandoffStatus(cwd, { launchId, candidateId, storyWorkspaceRoot, authorityId });
  console.log(JSON.stringify({
    ...status,
    externalEffectsPerformed: false,
    mergeEnabled: false,
    promotionEnabled: false,
    deploymentEnabled: false,
  }, null, 2));
  process.exitCode = authorityId ? (status.authorityValid ? 0 : 1) : (status.candidateCurrent && status.machineCurrent ? 0 : 1);
} else if (action === "simulate") {
  const missionId = args[0];
  if (!missionId) throw new Error("Usage: wheel-zob simulate <mission-id>");
  const result = simulateWheelFactoryHappyPath(createWheelFactoryPipeline({ missionId, storyId: "preview-story", pullRequestId: "preview-pr", candidateId: "preview-candidate", windowId: "preview-window", simulation: true }));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.completed ? 0 : 1;
} else if (action === "pools") {
  const validation = validateWheelModelRegistry();
  console.log(JSON.stringify({ schema: "wheel.zob.pool-status.v1", valid: validation.valid, pools: Object.fromEntries(Object.entries(WHEEL_RANDOMIZED_ROLE_POOLS).map(([name, routes]) => [name, routes.length])), fixedOrchestrator: { family: "OpenAI-GPT-5.6", thinking: "high" }, routeIdentitiesStored: false, bodyStored: false }, null, 2));
  process.exitCode = validation.valid ? 0 : 1;
} else {
  console.error("Usage: wheel-zob validate <story.json> | plan <mission-id> <story.json...> | plan-machine <mission-id> <machine-id> <machine-bundle.json> | supervisor-plan <mission-id> <machine-bundle.json> | supervisor-init <mission-id> <machine-bundle.json> <state-dir> [disabled|deterministic-fake] | supervisor-run-fake <mission-id> <machine-bundle.json> <state-dir> [max-ticks] | supervisor-status <state-dir> | supervisor-validate <state-dir> | supervisor-resolve-human <state-dir> <story-id> <receipt-sha256> [owner-id] | prepare-local-launch <launch-id> <mission-id> <machine-bundle.json> <machine-id...> | local-launch-status <launch-id> | local-launch-validate <launch-id> | local-machine-status <launch-id> <machine-id> | local-machine-repair-checkpoint <launch-id> <machine-id> | prepare-pr-handoff <launch-id> <machine-id> <story-id> <candidate-id> <phase> <story-worktree-path> <base-ref> <commit-receipt-id|NONE> <evidence-ref> <evidence-sha256> <actions-csv> | record-pr-commit <launch-id> <pre-commit-candidate-id> <commit-authority-id> <receipt-id> <story-worktree-path> <governed-zcommit-evidence-ref> <evidence-sha256> | authorize-pr-handoff <launch-id> <candidate-id> <authority-id> <story-worktree-path> <candidate-sha256> <expected-head-sha> <actions-csv> <actor-id> | pr-handoff-status <launch-id> <candidate-id> <story-worktree-path> [authority-id] | simulate <mission-id> | pools");
  process.exitCode = 1;
}
