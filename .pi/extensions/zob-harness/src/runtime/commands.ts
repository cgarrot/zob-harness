import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { MODE_PROMPTS } from "../core/constants.js";
import type { ModeName, QueueTickResult } from "../types.js";
import { classifyIntent, loadIntentClassifierConfig, writeIntentClassifierConfig, type IntentClassifierConfig, type IntentClassifierFallback, type IntentClassifierProvider } from "../domains/intent/intent-classifier.js";
import { discoverAgents, formatAgentList } from "../domains/delegation/agents.js";
import { buildComputePreview, resolveComputeProfile, type ComputeRequestedProfile } from "../domains/compute/compute-profile.js";
import { buildComputeWorkflowShape } from "../domains/compute/compute-workflow-shape.js";
import { buildDaemonRuntimeState, buildDaemonTickPlan, type DaemonRuntimeState, type DaemonTickPlan } from "../domains/autonomy/daemon-runtime.js";
import { runQueueDaemonTick } from "../domains/telemetry/queue.js";
import { buildProjectDnaAgenticPlan, buildProjectDnaQueryResult, buildProjectDnaReadinessAudit } from "../domains/project-dna/project-dna.js";
import { formatZagentList, formatZteamList, listZagentManifests, listZteamManifests, loadZagentManifest, loadZteamManifest, loadZteamModePack, normalizeZagentRoomBindings, readZagentPrompt, resolveZagentRuntimeRoomBindings, resolveZteamScopedMode, safeZagentId, type ZAgentManifest, type ZAgentRoomBinding, type ZTeamAgentManifest, type ZTeamManifest, type ZTeamMemberManifest } from "../domains/coms/zagents.js";
import { resolveAdaptiveZmodeEntrypoint, renderAdaptiveZmodeTemplate } from "./adaptive-zmode.js";
import { handleZcompactCommand } from "./auto-compaction.js";
import { sha256 } from "../core/utils/hashing.js";
import { buildZcommitPlan, formatZcommitPlan, formatZcommitStatus, readZcommitPolicy, runGovernedZcommitAdopt, runGovernedZcommitCommit, runGovernedZcommitPush, type ZcommitAdoptResult, type ZcommitCommandResult, type ZcommitOwnedPathRef, type ZcommitToggleState } from "../domains/git/git-ops.js";
import { clearZpeerNewCarryoverProfile, writeZpeerLocalProfileFromPeer } from "../domains/coms/coms-v2/zpeer-profile.js";
import { buildZpeerRoomSummary, changeZpeerAlias, changeZpeerRoom, clearZpeerRoom, joinZpeerRoom, leaveZpeerRoom, peerAliasInRoom, refreshZpeerSelf, sendZpeerPrompt, useZpeerRoom, zpeerMembershipsForPeer, type ZpeerSendMode } from "../domains/coms/coms-v2/zpeer.js";
import { loadActiveZagentScopedMode, markZpeerNewHardResetPending } from "./events.js";
import { parseBillableJobIntake, validateBillableJobIntake } from "../domains/goal/goal.js";
import { handleGoalCommand, handleGoalGateCommand, pauseRuntimeGoalForStop } from "./goal-runtime.js";
import { formatRuleResolution, resolveRuleProfile } from "../domains/governance/rules.js";
import { formatContractTemplate } from "../domains/governance/safety.js";
import { showDelegationOverlay } from "./delegation-overlay.js";
import { finishDelegationRun } from "./delegation-monitor.js";
import { showGoalTodoOverlay } from "./goal-todo-overlay.js";
import type { HarnessRuntimeState } from "./state.js";
import { registerZobIntroCommand } from "./zob-intro.js";
import {
  asInteractiveAutonomyMode,
  formatInteractiveAutonomyStatus,
  formatMissionReadinessForUi,
  readInteractiveAutonomyPolicy,
  scoreMissionReadiness,
  toAutonomyStateLedgerEntry,
  toMissionReadinessLedgerEntry,
} from "../domains/autonomy/interactive-autonomy.js";
import { applyMode, renderHarnessWidget } from "./widget.js";

const COMPUTE_PROFILES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
const COMPUTE_DOMAINS = ["generic", "project-dna", "factory", "orchestration"] as const;

function zpeerCommandProfileId(ctx: ExtensionCommandContext): string {
  const sessionIdentity = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
  return `session-${sha256(sessionIdentity).slice(0, 24)}`;
}

function zcommitArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [
    { value: "status", label: "status [paths/globs...]", description: "show governed commit state without staging" },
    { value: "plan", label: "plan [paths/globs...]", description: "plan safe workspace dirty files or explicit pathspecs" },
    { value: "adopt ", label: "adopt <paths...>", description: "advanced: explicitly mark exact dirty paths as owned without staging" },
    { value: "autocommit on", label: "autocommit on", description: "enable easy autocommit at assistant message end" },
    { value: "autocommit off", label: "autocommit off", description: "turn off session autocommit metadata" },
    { value: "autopush on", label: "autopush on", description: "enable gated autopush metadata only when autocommit is on" },
    { value: "autopush off", label: "autopush off", description: "turn off session autopush metadata" },
    { value: "commit", label: "commit [paths/globs...]", description: "commit safe workspace changes or explicit pathspecs with a Conventional Commit" },
    { value: "push", label: "push", description: "push last /zcommit commit to allowed remote/branch only" },
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function zcommitOwnedPathLedgerRefs(state: HarnessRuntimeState): Array<Pick<ZcommitOwnedPathRef, "path" | "source" | "pathHash" | "lastOwnedAt">> {
  return Object.values(state.zcommit.ownedPathRefs ?? {}).map((ref) => ({ path: ref.path, source: ref.source, pathHash: ref.pathHash, lastOwnedAt: ref.lastOwnedAt })).sort((a, b) => a.path.localeCompare(b.path));
}

function zcommitLedgerEntry(action: string, state: HarnessRuntimeState, plan: ReturnType<typeof buildZcommitPlan>, result?: ZcommitCommandResult | ZcommitAdoptResult): Record<string, unknown> {
  return {
    schema: "zob.zcommit-command.v1",
    action,
    status: result ? (result.ok ? "ok" : "blocked_or_failed") : undefined,
    autocommit: state.zcommit.autocommit,
    autopush: state.zcommit.autopush,
    policyLoaded: plan.policyLoaded,
    selectionMode: plan.selectionMode,
    validationMode: plan.validationMode,
    selectionPathspecHashes: plan.selectionPathspecs.map((pathspec) => sha256(pathspec)),
    dirtyCount: plan.dirtyFiles.length,
    touchedCount: plan.touchedFiles.length,
    eligibleCount: plan.eligible.length,
    excludedCount: plan.excluded.length,
    forbiddenCount: plan.forbidden.length,
    unexpectedStagedCount: plan.unexpectedStaged.length,
    eligiblePathHashes: plan.eligible.map((file) => sha256(file.path)),
    excludedPathHashes: plan.excluded.map((file) => sha256(file.path)),
    ownedPathRefs: zcommitOwnedPathLedgerRefs(state),
    noShip: plan.noShip,
    commitEnabled: plan.commitEnabled,
    pushEnabled: plan.pushEnabled,
    lastCommitHash: state.zcommit.lastCommit?.hash,
    lastCommitShortHash: state.zcommit.lastCommit?.shortHash,
    validationOk: result && result.action !== "adopt" ? result.validation?.ok : undefined,
    validationCommand: result && result.action !== "adopt" ? result.validation?.command : undefined,
    adoptedPathHashes: result?.action === "adopt" ? result.adopted.map((path) => sha256(path)) : undefined,
    adoptExcludedPathHashes: result?.action === "adopt" ? result.excluded.map((entry) => sha256(entry.path)) : undefined,
    adoptExcludedReasons: result?.action === "adopt" ? result.excluded.map((entry) => entry.reason) : undefined,
    errorHashes: result?.errors.map((error) => sha256(error)),
    actualGitCommitRun: result?.actualGitCommitRun ?? false,
    actualGitPushRun: result?.actualGitPushRun ?? false,
    bodyStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function setZcommitToggle(state: HarnessRuntimeState, key: "autocommit" | "autopush", value: ZcommitToggleState): void {
  state.zcommit[key] = value;
  state.zcommit.updatedAt = new Date().toISOString();
}

function computeArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [
    { value: "auto", label: "auto", description: "preview then choose low/medium/high/xhigh/max" },
    { value: "low", label: "low", description: "fast single-agent/deterministic effort" },
    { value: "medium", label: "medium", description: "balanced default effort" },
    { value: "high", label: "high", description: "multi-lane + stronger validation" },
    { value: "xhigh", label: "xhigh", description: "extra-high quality + adversarial checks" },
    { value: "max", label: "max", description: "approval-gated maximum effort" },
    { value: "--domain project-dna", label: "--domain project-dna", description: "score as ProjectDNA/reference-project work" },
    { value: "--domain factory", label: "--domain factory", description: "score as factory workflow work" },
    { value: "--domain orchestration", label: "--domain orchestration", description: "score as orchestration work" },
    { value: "help", label: "help", description: "show compute command template" },
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function parseComputeCommandArgs(args: string): { requestedProfile: ComputeRequestedProfile; domain: string; targetPath: string; maxProfile?: string; riskHints: string[]; help: boolean } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let requestedProfile: ComputeRequestedProfile = "auto";
  let domain = "generic";
  let targetPath = ".";
  let maxProfile: string | undefined;
  const riskHints: string[] = [];
  let positionalTargetSeen = false;
  let help = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "help" || part === "--help" || part === "-h") {
      help = true;
      continue;
    }
    if (part === "--domain" && parts[index + 1]) {
      const next = parts[++index];
      domain = COMPUTE_DOMAINS.includes(next as typeof COMPUTE_DOMAINS[number]) ? next : "generic";
      continue;
    }
    if ((part === "--max" || part === "--max-profile") && parts[index + 1]) {
      maxProfile = parts[++index];
      continue;
    }
    if ((part === "--risk" || part === "--risk-hint") && parts[index + 1]) {
      riskHints.push(parts[++index]);
      continue;
    }
    if (COMPUTE_PROFILES.includes(part as ComputeRequestedProfile)) {
      requestedProfile = part as ComputeRequestedProfile;
      continue;
    }
    if (!positionalTargetSeen) {
      targetPath = part;
      positionalTargetSeen = true;
    }
  }
  return { requestedProfile, domain, targetPath, maxProfile, riskHints, help };
}

function computeHelpTemplate(): string {
  return [
    "# ZOB compute profile",
    "",
    "Usage examples:",
    "/compute auto .",
    "/compute high . --domain generic",
    "/compute xhigh . --risk durable --max-profile xhigh",
    "/effort medium .",
    "",
    "Profiles: auto | low | medium | high | xhigh | max",
    "Domains: generic | project-dna | factory | orchestration",
    "",
    "Notes:",
    "- preview/resolve only; no child dispatch",
    "- max remains approval-gated",
    "- childDirectDispatch=false",
  ].join("\n");
}

function projectDnaArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [
    { value: "readiness", label: "readiness", description: "audit ProjectDNA repo-local readiness" },
    { value: "plan .pi/factories/project-dna/example-project-dna-manifest-v2.json reports/project-dna-scans/project-dna-factory-smoke", label: "plan workflow", description: "metadata-only agentic workflow plan from manifest v2" },
    { value: "query reports/project-dna-scans/project-dna-factory-smoke factory schema validation", label: "query smoke", description: "bounded cited query against smoke scan artifacts" },
    { value: "query reports/project-dna-scans/pi-real-20260529-v1 register tool extension command runtime", label: "query pi-real", description: "bounded cited query against existing real Pi scan artifacts" },
    { value: "help", label: "help", description: "show ProjectDNA command template" },
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function projectDnaHelpTemplate(): string {
  return [
    "# ZOB ProjectDNA",
    "",
    "Usage examples:",
    "/project-dna readiness",
    "/project-dna plan .pi/factories/project-dna/example-project-dna-manifest-v2.json reports/project-dna-scans/project-dna-factory-smoke",
    "/project-dna query reports/project-dna-scans/project-dna-factory-smoke factory schema validation",
    "/project-dna query reports/project-dna-scans/pi-real-20260529-v1 register tool extension command runtime",
    "",
    "Notes:",
    "- plan builds metadata-only agentic workflow shape from manifest v2",
    "- query reads repo-local ProjectDNA scan artifacts only",
    "- returns bounded cited context packs",
    "- raw query text is hashed in outputs and not persisted",
    "- no source scan, no backend write, no child dispatch",
  ].join("\n");
}

function parseProjectDnaCommandArgs(args: string): { mode: "help" | "readiness" | "plan" | "query"; manifestPath?: string; scanDir?: string; query?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0] === "help" || parts[0] === "--help" || parts[0] === "-h") return { mode: "help" };
  if (parts[0] === "readiness") return { mode: "readiness", scanDir: parts[1] };
  if (parts[0] === "plan") {
    const manifestPath = parts[1];
    const scanDir = parts[2]?.startsWith("reports/project-dna-scans/") ? parts[2] : undefined;
    return manifestPath ? { mode: "plan", manifestPath, scanDir } : { mode: "help" };
  }
  if (parts[0] === "query") {
    const maybeScanDir = parts[1];
    const hasScanDir = typeof maybeScanDir === "string" && maybeScanDir.startsWith("reports/project-dna-scans/");
    const scanDir = hasScanDir ? maybeScanDir : undefined;
    const queryText = parts.slice(hasScanDir ? 2 : 1).join(" ").trim();
    return { mode: queryText ? "query" : "help", scanDir, query: queryText };
  }
  return { mode: "query", query: parts.join(" ") };
}

function autonomyArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [
    { value: "status", label: "status", description: "show current autonomy policy/readiness" },
    { value: "daemon status", label: "daemon status", description: "show scoped plan-only daemon state; no execution" },
    { value: "daemon tick", label: "daemon tick", description: "record one scoped plan-only daemon tick" },
    { value: "daemon tick --queue-readonly", label: "daemon tick --queue-readonly", description: "explicit one-shot read-only queue bridge" },
    { value: "daemon start --max-ticks 3", label: "daemon start --max-ticks 3", description: "start bounded supervised plan-only session loop" },
    { value: "daemon stop", label: "daemon stop", description: "stop supervised daemon session loop" },
    { value: "daemon plan-tick", label: "daemon plan-tick", description: "preview next daemon action only; no execution" },
    { value: "adaptive", label: "adaptive", description: "score request then auto-launch, clarify, or block" },
    { value: "controlled", label: "controlled", description: "challenge-first until readiness is high" },
    { value: "open", label: "open", description: "launch directly when safety gates pass" },
    { value: "stop", label: "stop", description: "disable interactive autonomy" },
    { value: "score", label: "score <text>", description: "hash-only score a mission draft without launching" },
    { value: "help", label: "help", description: "insert autonomy command help" },
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function autonomyHelpTemplate(): string {
  return [
    "# ZOB interactive autonomy",
    "",
    "Commands:",
    "/autonomy adaptive   # default: score launch vs clarify vs block",
    "/autonomy controlled # challenge-first until enough info",
    "/autonomy open       # launch direct when safety gates pass",
    "/autonomy status     # show mode, policy, latest readiness",
    "/autonomy daemon status    # show scoped daemon metadata and bounded loop state",
    "/autonomy daemon tick      # record one scoped plan-only daemon tick",
    "/autonomy daemon tick --queue-readonly # explicit one-shot safe read-only queue bridge",
    "/autonomy daemon start --max-ticks 3 # bounded supervised session-local plan-only loop",
    "/autonomy daemon stop      # stop supervised daemon loop",
    "/autonomy daemon plan-tick # compatibility alias for tick without queue bridge",
    "/autonomy stop       # disable interactive autonomy",
    "",
    "Semantics:",
    "- spec understood + launch decision = no per-action approval for in-scope safe work",
    "- safety gates stay on: no secrets, no destructive commands, no production apply/global claim",
    "- persisted entries are hash/body-free (mission-readiness.v1)",
    "- daemon commands are default-off, scoped to active goal, plan-only, and never auto-start",
    "- daemon start is session-local, supervised, bounded by --max-ticks, and cleared on shutdown",
  ].join("\n");
}

function daemonInputFromState(state: HarnessRuntimeState) {
  return {
    policy: state.daemon.policy,
    runtimeGoal: state.runtimeGoal,
    goalTodos: state.goalTodos,
    autonomy: {
      mode: state.autonomy.mode,
      enabled: state.autonomy.enabled,
      lastReadiness: state.autonomy.lastReadiness,
      lastLaunchAuthorization: state.autonomy.lastLaunchAuthorization,
    },
    loop: state.daemon.loop,
  };
}

function daemonRuntimeLedgerEntry(daemonState: DaemonRuntimeState): Record<string, unknown> {
  return {
    schema: daemonState.schema,
    status: daemonState.status,
    reasonCodes: daemonState.reasonCodes,
    enabled: daemonState.policy.enabled,
    planOnly: true,
    scopedToActiveGoal: true,
    goalId: daemonState.goal?.goalId,
    goalStatus: daemonState.goal?.status,
    oracleStatus: daemonState.goal?.oracleStatus,
    launchAuthorized: daemonState.launchAuthorized,
    selectedTodoId: daemonState.selectedTodo?.id,
    selectedTodoPath: daemonState.selectedTodo?.path,
    selectedTodoStatus: daemonState.selectedTodo?.status,
    todoCounts: daemonState.todoCounts,
    loop: daemonState.loop,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
    childDispatchAllowed: false,
    queueClaimed: false,
    todoMutated: false,
    productionApplyAllowed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function daemonPlanLedgerEntry(plan: DaemonTickPlan, daemonState: DaemonRuntimeState): Record<string, unknown> {
  return {
    schema: plan.schema,
    status: plan.status,
    action: plan.action,
    reasonCodes: plan.reasonCodes,
    enabled: daemonState.policy.enabled,
    planOnly: true,
    goalId: plan.goalId,
    selectedTodoId: plan.todo?.id,
    selectedTodoPath: plan.todo?.path,
    selectedTodoStatus: plan.todo?.status,
    loop: daemonState.loop,
    stop: { stop: plan.stop.stop, status: plan.stop.status, reasonCodes: plan.stop.reasonCodes },
    writesPlanned: false,
    todoMutationPlanned: false,
    queueClaimPlanned: false,
    childDispatchPlanned: false,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
    productionApplyAllowed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function formatDaemonStatusForUi(daemonState: DaemonRuntimeState): string {
  const todo = daemonState.selectedTodo ? ` · todo=${daemonState.selectedTodo.path}/${daemonState.selectedTodo.status}` : "";
  const loop = daemonState.loop;
  const loopText = loop ? ` · loop=${loop.status} ticks=${loop.tickCount}${loop.maxTicks ? `/${loop.maxTicks}` : ""}${loop.blocker ? ` blocker=${loop.blocker}` : ""}` : "";
  return `daemon ${daemonState.policy.enabled ? "plan-only" : "off"}/${daemonState.status}${todo}${loopText} · reasons=${daemonState.reasonCodes.slice(0, 3).join(",") || "none"} · autoStart=false globalLoop=false execution=false`;
}

function formatDaemonPlanForUi(plan: DaemonTickPlan, queueTick?: QueueTickResult): string {
  const todo = plan.todo ? ` · todo=${plan.todo.path}/${plan.todo.status}` : "";
  const queue = queueTick ? ` · queue=${queueTick.status}/claimed=${queueTick.claimed}` : "";
  return `daemon tick action=${plan.action} status=${plan.status}${todo}${queue} · stop=${plan.stop.stop} · writes=false todo_mutation=false child_dispatch=false`;
}

const DAEMON_SESSION_TICK_INTERVAL_MS = 1_000;

type HarnessCommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

function clearDaemonLoopTimer(state: HarnessRuntimeState): void {
  if (state.daemon.loopTimer) clearTimeout(state.daemon.loopTimer);
  state.daemon.loopTimer = undefined;
}

function stopDaemonLoop(state: HarnessRuntimeState, blocker?: string): void {
  clearDaemonLoopTimer(state);
  state.daemon.loop = {
    ...state.daemon.loop,
    status: "stopped",
    stoppedAt: new Date().toISOString(),
    blocker: blocker ?? state.daemon.loop.blocker,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
  };
  state.daemon.updatedAt = state.daemon.loop.stoppedAt;
}

function parseDaemonMaxTicks(parts: string[]): number | undefined {
  const index = parts.findIndex((part) => part === "--max-ticks" || part === "--max_ticks");
  if (index < 0 || !parts[index + 1]) return undefined;
  const parsed = Number.parseInt(parts[index + 1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.trunc(parsed), 100) : undefined;
}

function daemonQueueTickLedgerEntry(result: QueueTickResult): Record<string, unknown> {
  return {
    schema: result.schema,
    claimed: result.claimed,
    jobId: result.jobId,
    jobType: result.jobType,
    status: result.status,
    stopCondition: result.stopCondition,
    errors: result.errors,
    staleRecovered: result.staleRecovered,
    maxWorkers: result.maxWorkers,
    budgetEnforced: result.budgetEnforced,
    promptBodiesStored: false,
    outputBodiesStored: false,
    bodyStored: false,
    explicitManualReadOnlyBridge: true,
    productionApplyAllowed: false,
    childDispatchAllowed: false,
    generatedAt: new Date().toISOString(),
  };
}

function recordDaemonTick(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: HarnessCommandContext, options: { queueReadonly?: boolean } = {}): { daemonState: DaemonRuntimeState; plan: DaemonTickPlan; queueTick?: QueueTickResult } {
  const now = new Date().toISOString();
  state.daemon.loop = {
    ...state.daemon.loop,
    tickCount: state.daemon.loop.tickCount + 1,
    lastTickAt: now,
    blocker: undefined,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
  };
  const daemonInput = daemonInputFromState(state);
  const daemonState = buildDaemonRuntimeState({ ...daemonInput, policy: { ...state.daemon.policy, enabled: true } });
  const plan = buildDaemonTickPlan(daemonState);
  let queueTick: QueueTickResult | undefined;
  if (options.queueReadonly === true) {
    queueTick = runQueueDaemonTick(ctx.cwd);
    state.daemon.lastQueueTick = queueTick;
    pi.appendEntry("zob-daemon-queue-tick", daemonQueueTickLedgerEntry(queueTick));
  }
  state.daemon.lastStatus = daemonState;
  state.daemon.lastPlan = plan;
  state.daemon.updatedAt = now;
  pi.appendEntry("zob-daemon-runtime", daemonRuntimeLedgerEntry(daemonState));
  pi.appendEntry("zob-daemon-plan", daemonPlanLedgerEntry(plan, daemonState));
  return { daemonState, plan, queueTick };
}

function scheduleDaemonLoop(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: HarnessCommandContext): void {
  if (state.daemon.loop.status !== "running") return;
  if (state.daemon.loop.maxTicks !== undefined && state.daemon.loop.tickCount >= state.daemon.loop.maxTicks) {
    stopDaemonLoop(state, "max_ticks_reached");
    renderHarnessWidget(pi, state, ctx);
    return;
  }
  clearDaemonLoopTimer(state);
  const timer = setTimeout(() => {
    if (state.daemon.loop.status !== "running") return;
    const { plan } = recordDaemonTick(pi, state, ctx);
    if (plan.stop.stop) stopDaemonLoop(state, `stop_condition_${plan.status}`);
    if (state.daemon.loop.maxTicks !== undefined && state.daemon.loop.tickCount >= state.daemon.loop.maxTicks) stopDaemonLoop(state, "max_ticks_reached");
    renderHarnessWidget(pi, state, ctx);
    if (state.daemon.loop.status === "running") scheduleDaemonLoop(pi, state, ctx);
  }, DAEMON_SESSION_TICK_INTERVAL_MS);
  timer.unref?.();
  state.daemon.loopTimer = timer;
}

function abortForegroundWork(ctx: HarnessCommandContext): boolean {
  const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
  if (idle) return false;
  if (typeof ctx.abort !== "function") return false;
  ctx.abort();
  return true;
}

function abortBackgroundDelegations(state: HarnessRuntimeState): { abortedCount: number; runIds: string[] } {
  const runIds: string[] = [];
  for (const [runId, run] of state.backgroundDelegations.entries()) {
    if (run.result || run.error || run.abortController.signal.aborted) continue;
    run.abortController.abort();
    runIds.push(runId);
    finishDelegationRun(state.delegations, runId, {
      status: "aborted",
      endedAtMs: Date.now(),
      gatePassed: false,
      failureKind: "aborted",
      stopReason: "aborted",
      stopCondition: "slash_stop",
      errorMessage: "aborted by /stop",
    });
  }
  return { abortedCount: runIds.length, runIds };
}

function stopCommandLedgerEntry(input: {
  foregroundAbortRequested: boolean;
  idleBeforeStop: boolean;
  pendingMessagesBeforeStop: boolean;
  backgroundAbortedCount: number;
  backgroundRunIds: string[];
  daemonWasRunning: boolean;
  runtimeGoalPaused: boolean;
  runtimeGoalId?: string;
}): Record<string, unknown> {
  return {
    schema: "zob.stop-command.v1",
    foregroundAbortRequested: input.foregroundAbortRequested,
    idleBeforeStop: input.idleBeforeStop,
    pendingMessagesBeforeStop: input.pendingMessagesBeforeStop,
    backgroundAbortedCount: input.backgroundAbortedCount,
    backgroundRunIds: input.backgroundRunIds,
    daemonWasRunning: input.daemonWasRunning,
    runtimeGoalPaused: input.runtimeGoalPaused,
    runtimeGoalId: input.runtimeGoalId,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function zagentArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const ids = listZagentManifests(process.cwd()).map((agent) => agent.manifest.id).filter(Boolean);
  const items: AutocompleteItem[] = [
    { value: "list", label: "list", description: "list project-local ZAgents" },
    ...ids.flatMap((id) => [
      { value: `show ${id}`, label: `show ${id}`, description: "show manifest metadata" },
      { value: `use ${id}`, label: `use ${id}`, description: "load ZAgent and apply ZPeer profile" },
    ]),
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function zteamArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const ids = listZteamManifests(process.cwd()).map((team) => team.manifest.id).filter(Boolean);
  const items: AutocompleteItem[] = [
    { value: "list", label: "list", description: "list project-local ZTeams" },
    ...ids.flatMap((id) => [
      { value: `show ${id}`, label: `show ${id}`, description: "show team manifest metadata" },
      { value: `launch-plan ${id}`, label: `launch-plan ${id}`, description: "print full-session launch commands" },
      { value: `reset ${id}`, label: `reset ${id}`, description: "send Pi /new to every existing team tmux agent window" },
      { value: `reset ${id} --dry-run`, label: `reset ${id} --dry-run`, description: "preview the /new fanout plan without tmux/spawn" },
      { value: `reset-plan ${id}`, label: `reset-plan ${id}`, description: "alias for reset --dry-run" },
    ]),
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function zagentLedgerEntry(action: string, input: { id?: string; teamId?: string; status: "ok" | "blocked"; roomIds?: string[]; alias?: string; path?: string; promptRef?: string; promptBody?: string; errors?: string[] }): Record<string, unknown> {
  return {
    schema: "zob.zagent-command.v1",
    action,
    status: input.status,
    idHash: input.id ? sha256(input.id) : undefined,
    teamIdHash: input.teamId ? sha256(input.teamId) : undefined,
    aliasHash: input.alias ? sha256(input.alias) : undefined,
    roomIdHashes: (input.roomIds ?? []).map((roomId) => sha256(roomId)),
    pathHash: input.path ? sha256(input.path) : undefined,
    promptRefHash: input.promptRef ? sha256(input.promptRef) : undefined,
    promptHash: input.promptBody ? sha256(input.promptBody) : undefined,
    errorHashes: (input.errors ?? []).map((error) => sha256(error)),
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function formatZagentShow(loaded: ReturnType<typeof loadZagentManifest>): string {
  const rooms = normalizeZagentRoomBindings(loaded.manifest.rooms, loaded.manifest.defaultRoom, loaded.manifest.activeRoom);
  return [
    `ZAgent ${loaded.manifest.id}`,
    `path: ${loaded.path}`,
    `status: ${loaded.errors.length === 0 ? "ok" : `blocked (${loaded.errors.length} error${loaded.errors.length === 1 ? "" : "s"})`}`,
    loaded.manifest.description ? `description: ${loaded.manifest.description}` : undefined,
    loaded.manifest.team ? `team: ${loaded.manifest.team}` : undefined,
    loaded.manifest.role ? `role: ${loaded.manifest.role}` : undefined,
    loaded.manifest.alias ? `alias: @${loaded.manifest.alias}` : undefined,
    loaded.manifest.defaultMode ? `defaultMode: ${loaded.manifest.defaultMode}` : undefined,
    rooms.length ? `rooms: ${rooms.map((room) => `${room.id}${room.alias ? `@${room.alias}` : ""}${room.active ? "*" : ""}`).join(", ")}` : "rooms: none",
    loaded.manifest.promptRef ? `promptRef: ${loaded.manifest.promptRef}` : "promptRef: none",
    loaded.promptPath ? `promptPath: ${loaded.promptPath}` : undefined,
    loaded.errors.length ? `errors:\n- ${loaded.errors.join("\n- ")}` : undefined,
    "safety: project-local, localOnly=true, networkEnabled=false, bodyStored=false",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function formatZteamShow(loaded: ReturnType<typeof loadZteamManifest>): string {
  const rooms = normalizeZagentRoomBindings(loaded.manifest.rooms, loaded.manifest.defaultRoom, loaded.manifest.activeRoom);
  const members = zteamMembers(loaded.manifest);
  return [
    `ZTeam ${loaded.manifest.id}`,
    `path: ${loaded.path}`,
    `status: ${loaded.errors.length === 0 ? "ok" : `blocked (${loaded.errors.length} error${loaded.errors.length === 1 ? "" : "s"})`}`,
    loaded.manifest.description ? `description: ${loaded.manifest.description}` : undefined,
    rooms.length ? `rooms: ${rooms.map((room) => `${room.id}${room.active ? "*" : ""}`).join(", ")}` : "rooms: none",
    `agents: ${members.map((member) => member.id).join(", ") || "none"}`,
    loaded.errors.length ? `errors:\n- ${loaded.errors.join("\n- ")}` : undefined,
    "safety: launch-plan only; commands are printed, not spawned",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function normalizeZpeerRole(role: string | undefined): "member" | "bridge" | "observer" {
  return role === "bridge" || role === "observer" ? role : "member";
}

async function applyZagentToZpeer(repoRoot: string, peer: NonNullable<HarnessRuntimeState["zobLive"]["peerCard"]>, manifest: ZAgentManifest): Promise<{ ok: true; peer: NonNullable<HarnessRuntimeState["zobLive"]["peerCard"]> } | { ok: false; reason: string; peer: NonNullable<HarnessRuntimeState["zobLive"]["peerCard"]> }> {
  let current = refreshZpeerSelf(repoRoot, peer);
  const rooms = resolveZagentRuntimeRoomBindings(repoRoot, manifest).rooms;
  if (rooms.length === 0 && manifest.alias) {
    const changed = await changeZpeerAlias(repoRoot, current, manifest.alias);
    if (!changed.ok) return { ok: false, reason: changed.reason, peer: current };
    current = changed.peer;
  }
  for (const room of rooms) {
    const joined = await joinZpeerRoom(repoRoot, current, room.id, room.alias ?? manifest.alias, normalizeZpeerRole(room.role));
    if (!joined.ok) return { ok: false, reason: joined.reason, peer: current };
    current = joined.peer;
  }
  const activeRoom = rooms.find((room) => room.active)?.id ?? manifest.activeRoom ?? manifest.defaultRoom;
  if (activeRoom) {
    const used = useZpeerRoom(repoRoot, current, activeRoom);
    if (!used.ok) return { ok: false, reason: used.reason, peer: current };
    current = used.peer;
  }
  return { ok: true, peer: current };
}

function zteamMemberId(member: ZTeamMemberManifest | ZTeamAgentManifest): string {
  return "zagentId" in member ? member.zagentId : member.id;
}

function zteamMembers(team: ZTeamManifest): Array<{ id: string; alias?: string; room?: string; rooms?: ZAgentRoomBinding[]; role?: string; active?: boolean }> {
  const rawMembers = [...(team.members ?? []), ...(team.agents ?? [])];
  return rawMembers.map((member) => ({
    id: zteamMemberId(member),
    alias: member.alias,
    room: member.room,
    rooms: normalizeZagentRoomBindings(member.rooms ?? (member.room ? [member.room] : undefined), team.defaultRoom, member.active ? (member.room ?? team.activeRoom) : undefined),
    role: member.role,
    active: member.active,
  }));
}

function safeLaunchPlanModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 160) return undefined;
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r") || trimmed.includes("..")) return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return undefined;
  return /^[a-zA-Z0-9._:/+@-]+$/.test(trimmed) ? trimmed : undefined;
}

function zteamModePackModes(modePack: unknown): Array<{ id: string; baseMode: string }> {
  if (!modePack || typeof modePack !== "object") return [];
  const modes = (modePack as { modes?: unknown }).modes;
  if (!Array.isArray(modes)) return [];
  return modes.flatMap((mode) => {
    if (!mode || typeof mode !== "object") return [];
    const candidate = mode as { id?: unknown; baseMode?: unknown };
    return typeof candidate.id === "string" && typeof candidate.baseMode === "string" ? [{ id: candidate.id, baseMode: candidate.baseMode }] : [];
  });
}

function zteamLaunchPlanText(repoRoot: string, team: ZTeamManifest): { text: string; roomIds: string[]; agentIds: string[]; modelIds: string[]; defaultModes: string[]; scopedModeIds: string[]; modePackRef?: string } {
  const teamRooms = normalizeZagentRoomBindings(team.rooms, team.defaultRoom, team.activeRoom).map((room) => room.id);
  const members = zteamMembers(team);
  const roomIds = [...new Set([...teamRooms, ...members.flatMap((member) => (member.rooms ?? []).map((room) => room.id))])];
  const agentIds = members.map((member) => member.id);
  const loadedAgents = members.map((member) => ({ member, loaded: loadZagentManifest(repoRoot, member.id) }));
  const loadedModePack = loadZteamModePack(repoRoot, team);
  const scopedModes = zteamModePackModes(loadedModePack.modePack);
  const scopedModeIds = scopedModes.map((mode) => mode.id);
  const modelIds = [...new Set(loadedAgents.map(({ loaded }) => safeLaunchPlanModel(loaded.manifest.model)).filter((model): model is string => Boolean(model)))];
  const defaultModes = [...new Set(loadedAgents.map(({ loaded }) => loaded.manifest.defaultMode).filter((mode): mode is ModeName => Boolean(mode)))];
  const lines = [
    `# ZTeam launch-plan: ${team.id}`,
    "No processes spawned. spawn-count=0. Copy/paste each command in a separate terminal when approved.",
    `Team env: ZOB_ZTEAM_ID=${team.id}`,
    loadedModePack.ref ? `Mode pack: modePackRef=${loadedModePack.ref}${loadedModePack.errors.length ? ` blocked_errors=${loadedModePack.errors.length}` : ""}` : "Mode pack: none",
    scopedModes.length ? `Scoped modes available: ${scopedModes.map((mode) => `${mode.id}->baseMode=${mode.baseMode}`).join(", ")}` : "Scoped modes available: none",
    scopedModes.length ? "Scoped mode selection: set ZOB_ZTEAM_MODE_ID=<mode-id> or ZOB_ZTEAM_MODE=<mode-id> before manual launch; no sessions are spawned by this plan." : undefined,
    "",
    ...loadedAgents.map(({ member, loaded }) => {
      const rawModel = loaded.manifest.model;
      const model = safeLaunchPlanModel(rawModel);
      const defaultMode = loaded.manifest.defaultMode;
      const scoped = resolveZteamScopedMode({ repoRoot, zagent: loaded.manifest, team, modePack: loadedModePack.modePack });
      const effectiveScoped = scoped.teamId && scoped.modeId && scoped.baseMode ? `${scoped.modeId}@${scoped.teamId}` : "none";
      const effectiveBaseMode = scoped.baseMode ?? defaultMode;
      const rooms = (member.rooms ?? []).map((room) => `${room.id}${room.active ? "*" : ""}`).join(", ") || teamRooms.join(", ") || "default";
      const alias = member.alias ? ` alias=@${member.alias}` : "";
      const modelArg = model ? ` --model ${model}` : "";
      const modelNote = rawModel ? (model ? ` model=${model}` : " model=invalid_omitted") : "";
      const modeNote = defaultMode ? ` defaultMode=${defaultMode}` : "";
      const scopedNote = ` scopedMode=${effectiveScoped} baseMode=${effectiveBaseMode ?? "current"}`;
      return `ZOB_ZTEAM_ID=${team.id} ZOB_ZAGENT_ID=${member.id} pi${modelArg}    # expected_rooms=${rooms}${alias}${modelNote}${modeNote}${scopedNote}`;
    }),
    "",
    `Expected rooms: ${roomIds.join(", ") || "default"}`,
    modelIds.length ? `Models: ${modelIds.join(", ")}` : "Models: default Pi model unless each ZAgent manifest sets a safe model",
    defaultModes.length ? `Default modes: ${defaultModes.join(", ")}` : "Default modes: restored/current ZOB mode unless each ZAgent manifest sets defaultMode",
    loadedModePack.errors.length ? `Mode pack blockers:\n- ${loadedModePack.errors.join("\n- ")}` : undefined,
    "After each session starts, run /zagent use <id> to bind its ZPeer alias/rooms.",
  ].filter((line): line is string => Boolean(line));
  return { text: lines.join("\n"), roomIds, agentIds, modelIds, defaultModes, scopedModeIds, modePackRef: loadedModePack.ref };
}

type ZteamResetPlan = {
  teamId: string;
  launcherRef?: string;
  launcherPath?: string;
  session?: string;
  entryAgent?: string;
  agentIds: string[];
  roomIds: string[];
  errors: string[];
  execute: boolean;
  confirmMatched: boolean;
  spawnCount: number;
  closePlanned: boolean;
  leaseCleanupPlanned: boolean;
  leaseCleanupAgentIds: string[];
  startPlanned: boolean;
  startAction?: "start-detached" | "start";
  newPlanned: boolean;
  resetAction?: "new";
};

type ZteamResetOptions = { execute: boolean; confirm?: string };

function parseZteamResetArgs(parts: string[]): { id?: string; options: ZteamResetOptions; errors: string[] } {
  const errors: string[] = [];
  const id = parts[1];
  let execute = true;
  let confirm: string | undefined;
  for (let index = 2; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "--dry-run" || part === "--plan") {
      execute = false;
      continue;
    }
    if (part === "--execute") {
      execute = true;
      continue;
    }
    if (part === "--confirm") {
      const value = parts[index + 1];
      if (!value || value.startsWith("--")) errors.push("--confirm requires the exact team id when provided");
      else {
        confirm = value;
        index += 1;
      }
      continue;
    }
    errors.push(`unknown reset option: ${part}`);
  }
  return { id, options: { execute, confirm }, errors };
}

function safeZteamLauncher(repoRoot: string, team: ZTeamManifest): { ref?: string; path?: string; errors: string[] } {
  const raw = team.metadata?.tmuxLauncher;
  const errors: string[] = [];
  if (typeof raw !== "string" || !raw.trim()) return { errors: ["zteam.metadata.tmuxLauncher is required for reset"] };
  const ref = raw.trim();
  if (!ref.startsWith(".pi/zteams/") || !ref.endsWith(".tmux.sh")) errors.push("tmuxLauncher must be a project-local .pi/zteams/*.tmux.sh path");
  if (ref.includes("..") || /[\0\n\r]/.test(ref) || /(?:^|[\/])\.env(?:[\/]|$)|secret|key/i.test(ref)) errors.push("tmuxLauncher path is not safe");
  const zteamsDir = resolve(repoRoot, ".pi/zteams");
  const launcherPath = resolve(repoRoot, ref);
  if (!(launcherPath.startsWith(`${zteamsDir}${sep}`) && launcherPath.endsWith(".tmux.sh"))) errors.push("tmuxLauncher must resolve under .pi/zteams");
  if (!existsSync(launcherPath)) errors.push("tmuxLauncher file is missing");
  return { ref, path: launcherPath, errors };
}

function buildZteamResetPlan(repoRoot: string, team: ZTeamManifest, options: ZteamResetOptions, manifestErrors: string[] = []): ZteamResetPlan {
  const teamRooms = normalizeZagentRoomBindings(team.rooms, team.defaultRoom, team.activeRoom).map((room) => room.id);
  const members = zteamMembers(team);
  const agentIds = members.map((member) => member.id);
  const roomIds = [...new Set([...teamRooms, ...members.flatMap((member) => (member.rooms ?? []).map((room) => room.id))])];
  const launcher = safeZteamLauncher(repoRoot, team);
  const safeTeamId = safeZagentId(team.id) === team.id;
  const confirmMatched = options.confirm === undefined || options.confirm === team.id;
  const launcherBody = launcher.path && existsSync(launcher.path) ? readFileSync(launcher.path, "utf8") : "";
  const hasNewAction = /(^|\n)\s*new\)/.test(launcherBody) || launcherBody.includes("send_new_to_agents");
  const resetAction = hasNewAction ? "new" : undefined;
  const errors = [
    ...manifestErrors,
    ...(safeTeamId ? [] : [`invalid zteam id: ${team.id}`]),
    ...launcher.errors,
    ...(options.confirm !== undefined && !confirmMatched ? [`execute blocked: optional --confirm must exactly match ${team.id}`] : []),
    ...(options.execute && !resetAction ? ["execute blocked: launcher does not expose non-attaching new reset action"] : []),
  ];
  return {
    teamId: team.id,
    launcherRef: launcher.ref,
    launcherPath: launcher.path,
    session: typeof team.metadata?.tmuxSession === "string" ? team.metadata.tmuxSession : undefined,
    entryAgent: typeof team.metadata?.entryAgent === "string" ? team.metadata.entryAgent : agentIds[0],
    agentIds,
    roomIds,
    errors,
    execute: options.execute,
    confirmMatched,
    spawnCount: 0,
    closePlanned: false,
    leaseCleanupPlanned: false,
    leaseCleanupAgentIds: [],
    startPlanned: false,
    startAction: undefined,
    newPlanned: true,
    resetAction,
  };
}

function formatZteamResetPlan(plan: ZteamResetPlan): string {
  return [
    `# ZTeam reset plan: ${plan.teamId}`,
    `execute=${String(plan.execute)}`,
    `confirmMatched=${String(plan.confirmMatched)}`,
    `spawn-count=${plan.spawnCount}`,
    `team id: ${plan.teamId}`,
    `launcher: ${plan.launcherRef ?? "missing"}`,
    `session: ${plan.session ?? "not specified"}`,
    `entry agent: ${plan.entryAgent ?? "none"}`,
    `agents: ${plan.agentIds.join(", ") || "none"}`,
    `rooms: ${plan.roomIds.join(", ") || "default"}`,
    `close planned: ${String(plan.closePlanned)}`,
    `lease cleanup planned: ${String(plan.leaseCleanupPlanned)} (/new session lifecycle owns graceful release/reclaim)`,
    `start planned: ${String(plan.startPlanned)}${plan.startAction ? ` (${plan.startAction})` : ""}`,
    `new planned: ${String(plan.newPlanned)}${plan.resetAction ? ` (${plan.resetAction})` : ""}`,
    plan.execute ? "actions: status -> new (/new in each existing team tmux window)" : "dry-run only: no tmux and no /new sent",
    plan.errors.length ? `blocked/errors:\n- ${plan.errors.join("\n- ")}` : "status: ready",
    "safety: scoped launcher only; no tmux close/start, no lease cleanup, no global cleanup; reset is not completion evidence",
  ].join("\n");
}

function zteamResetLedgerEntry(action: string, plan: ZteamResetPlan, status: "ok" | "blocked", extraErrors: string[] = []): Record<string, unknown> {
  return {
    schema: "zob.zteam-reset-command.v1",
    action,
    status,
    teamIdHash: sha256(plan.teamId),
    launcherHash: plan.launcherRef ? sha256(plan.launcherRef) : undefined,
    sessionHash: plan.session ? sha256(plan.session) : undefined,
    entryAgentHash: plan.entryAgent ? sha256(plan.entryAgent) : undefined,
    agentIdHashes: plan.agentIds.map((agentId) => sha256(agentId)),
    roomIdHashes: plan.roomIds.map((roomId) => sha256(roomId)),
    dryRun: !plan.execute,
    execute: plan.execute,
    confirmMatched: plan.confirmMatched,
    spawnCount: plan.spawnCount,
    closePlanned: plan.closePlanned,
    leaseCleanupPlanned: plan.leaseCleanupPlanned,
    leaseCleanupAgentHashes: plan.leaseCleanupAgentIds.map((agentId) => sha256(agentId)),
    startPlanned: plan.startPlanned,
    startActionHash: plan.startAction ? sha256(plan.startAction) : undefined,
    newPlanned: plan.newPlanned,
    resetActionHash: plan.resetAction ? sha256(plan.resetAction) : undefined,
    errorHashes: [...plan.errors, ...extraErrors].map((error) => sha256(error)),
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

async function executeZteamResetPlan(_repoRoot: string, plan: ZteamResetPlan): Promise<{ ok: boolean; errors: string[]; actionStatuses: string[] }> {
  if (!plan.launcherPath) return { ok: false, errors: ["launcher path unavailable"], actionStatuses: [] };
  if (!plan.resetAction) return { ok: false, errors: ["new reset action unavailable"], actionStatuses: [] };
  const errors: string[] = [];
  const actionStatuses: string[] = [];

  const statusResult = spawnSync("bash", [plan.launcherPath, "status"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64_000 });
  actionStatuses.push(`status:${statusResult.status ?? "signal"}`);
  if (statusResult.error) errors.push(`status failed: ${statusResult.error.message}`);
  if (typeof statusResult.status === "number" && statusResult.status !== 0) errors.push(`status exited ${statusResult.status}`);
  if (statusResult.signal) errors.push(`status signaled ${statusResult.signal}`);
  if (errors.length > 0) return { ok: false, errors, actionStatuses };

  const newResult = spawnSync("bash", [plan.launcherPath, plan.resetAction], { encoding: "utf8", timeout: 30_000, maxBuffer: 64_000 });
  actionStatuses.push(`${plan.resetAction}:${newResult.status ?? "signal"}`);
  if (newResult.error) errors.push(`${plan.resetAction} failed: ${newResult.error.message}`);
  if (typeof newResult.status === "number" && newResult.status !== 0) errors.push(`${plan.resetAction} exited ${newResult.status}`);
  if (newResult.signal) errors.push(`${plan.resetAction} signaled ${newResult.signal}`);
  return { ok: errors.length === 0, errors, actionStatuses };
}

function delegationArgumentCompletions(state: HarnessRuntimeState, prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string, description?: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    items.push({ value, label, ...(description ? { description } : {}) });
  };
  const runs = [...state.delegations.runs].sort((a, b) => b.startedAtMs - a.startedAtMs);
  for (const run of runs) add(run.agent, run.agent, "agent");
  for (const run of runs.slice(0, 40)) add(run.id.slice(0, 8), run.id.slice(0, 8), `${run.agent} · ${run.status}`);
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

type IntentClassifierModelItem = { value: string; label: string; description?: string };

let cachedIntentClassifierModelItems: IntentClassifierModelItem[] = [];

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function modelLabel(model: { provider: string; id: string; name?: string }): string {
  return model.name && model.name !== model.id ? `${model.provider}/${model.id} · ${model.name}` : `${model.provider}/${model.id}`;
}

function refreshIntentClassifierModelCache(ctx: { modelRegistry: HarnessCommandContext["modelRegistry"]; model?: HarnessCommandContext["model"] }): void {
  const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
  cachedIntentClassifierModelItems = ctx.modelRegistry.getAvailable()
    .filter((model) => model.input.includes("text"))
    .map((model) => ({
      value: modelKey(model),
      label: modelLabel(model),
      description: modelKey(model) === currentKey ? "current model" : `${model.provider} · ${model.api}`,
    }))
    .sort((a, b) => (a.description === "current model" ? -1 : b.description === "current model" ? 1 : a.value.localeCompare(b.value)))
    .slice(0, 200);
}

function intentClassifierArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const commandItems: AutocompleteItem[] = [
    { value: "status", label: "status", description: "show current classifier posture" },
    { value: "regex", label: "regex", description: "local regex-only classifier; no model call" },
    { value: "model-strict", label: "model-strict", description: "use selected/current Pi model; failures/low-confidence become unknown, not regex" },
    { value: "model-fallback", label: "model-fallback", description: "use selected/current Pi model first; fallback to regex" },
    { value: "test ", label: "test <text>", description: "classify one prompt with the current config" },
    { value: "help", label: "help", description: "insert usage help" },
  ];
  const modelItems: AutocompleteItem[] = [];
  const modelMatch = /^(model-strict|model-fallback)\s+(.+)?$/i.exec(prefix);
  if (modelMatch) {
    const modelQuery = (modelMatch[2] ?? "").trim().toLowerCase();
    const command = modelMatch[1];
    for (const item of cachedIntentClassifierModelItems) {
      if (!modelQuery || item.value.toLowerCase().includes(modelQuery) || item.label.toLowerCase().includes(modelQuery) || item.description?.toLowerCase().includes(modelQuery)) {
        modelItems.push({ value: `${command} ${item.value}`, label: item.label, description: item.description });
      }
    }
    return modelItems.length > 0 ? modelItems.slice(0, 30) : null;
  }
  const filtered = query
    ? commandItems.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : commandItems;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

type IntentClassifierCommandAction = "status" | "help" | "regex" | "model" | "model-strict" | "model-fallback" | "test";

type IntentClassifierCommandOptions = {
  provider?: IntentClassifierProvider;
  model?: string;
  endpoint?: string;
  apiKeyEnv?: string;
  requestFormat?: "openai-chat" | "generic-chat";
  fallback?: IntentClassifierFallback;
  sendUserTextToProvider?: boolean;
  minConfidence?: number;
  timeoutMs?: number;
  errors: string[];
};

function parseIntentClassifierBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["on", "true", "yes", "1"].includes(normalized)) return true;
  if (["off", "false", "no", "0"].includes(normalized)) return false;
  return undefined;
}

function parseIntentClassifierOptions(raw: string): IntentClassifierCommandOptions {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const parsed: IntentClassifierCommandOptions = { errors: [] };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const readValue = (flag: string): string | undefined => {
      const value = parts[index + 1];
      if (!value || value.startsWith("--")) {
        parsed.errors.push(`${flag} requires a value`);
        return undefined;
      }
      index += 1;
      return value;
    };
    if (part === "--api-key" || part === "--apikey" || part === "--token") {
      parsed.errors.push("do not pass secrets to /intent-classifier; configure provider auth through Pi/login or environment-backed config");
      continue;
    }
    if (part === "--provider") {
      const value = readValue(part);
      if (value === "http-json" || value === "pi-provider") parsed.provider = value;
      else if (value) parsed.errors.push("--provider must be pi-provider or http-json");
      continue;
    }
    if (part === "--model") {
      const value = readValue(part);
      if (value) parsed.model = value;
      continue;
    }
    if (part === "--endpoint") {
      const value = readValue(part);
      if (value) parsed.endpoint = value;
      continue;
    }
    if (part === "--api-key-env") {
      const value = readValue(part);
      if (value) parsed.apiKeyEnv = value;
      continue;
    }
    if (part === "--format" || part === "--request-format") {
      const value = readValue(part);
      if (value === "openai-chat" || value === "generic-chat") parsed.requestFormat = value;
      else if (value) parsed.errors.push("--format must be openai-chat or generic-chat");
      continue;
    }
    if (part === "--fallback") {
      const value = readValue(part);
      if (value === "regex" || value === "unknown") parsed.fallback = value;
      else if (value) parsed.errors.push("--fallback must be regex or unknown");
      continue;
    }
    if (part === "--send" || part === "--send-user-text") {
      const value = parseIntentClassifierBoolean(readValue(part));
      if (typeof value === "boolean") parsed.sendUserTextToProvider = value;
      else parsed.errors.push(`${part} must be on|off|true|false`);
      continue;
    }
    if (part === "--min-confidence") {
      const value = Number(readValue(part));
      if (Number.isFinite(value) && value >= 0 && value <= 1) parsed.minConfidence = value;
      else parsed.errors.push("--min-confidence must be a number between 0 and 1");
      continue;
    }
    if (part === "--timeout-ms") {
      const value = Number(readValue(part));
      if (Number.isFinite(value) && value >= 250 && value <= 30_000) parsed.timeoutMs = Math.trunc(value);
      else parsed.errors.push("--timeout-ms must be between 250 and 30000");
      continue;
    }
    if (!part.startsWith("--") && !parsed.model) {
      parsed.model = part;
      continue;
    }
    parsed.errors.push(`unknown option: ${part}`);
  }
  return parsed;
}

function cloneIntentClassifierConfig(config: IntentClassifierConfig): IntentClassifierConfig {
  return {
    ...config,
    allowedIntents: [...config.allowedIntents],
    providers: {
      ...config.providers,
      "http-json": { ...(config.providers["http-json"] ?? {}) },
      "pi-provider": { ...(config.providers["pi-provider"] ?? {}) },
    },
  };
}

function applyIntentClassifierPreset(current: IntentClassifierConfig, action: Extract<IntentClassifierCommandAction, "regex" | "model" | "model-strict" | "model-fallback">, options: IntentClassifierCommandOptions, activeModel?: string): IntentClassifierConfig {
  const next = cloneIntentClassifierConfig(current);
  if (action === "regex") {
    next.enabled = false;
    next.provider = "regex";
    next.fallback = "regex";
    next.sendUserTextToProvider = false;
  } else {
    next.enabled = true;
    next.provider = options.provider ?? "pi-provider";
    next.fallback = options.fallback ?? (action === "model-fallback" ? "regex" : "unknown");
    next.sendUserTextToProvider = options.sendUserTextToProvider ?? true;
    next.model = options.model ?? activeModel ?? next.model;
  }
  if (options.model) next.model = options.model;
  if (typeof options.minConfidence === "number") next.minConfidence = options.minConfidence;
  if (typeof options.timeoutMs === "number") next.timeoutMs = options.timeoutMs;
  const httpProvider = next.providers["http-json"] ?? {};
  next.providers["http-json"] = {
    ...httpProvider,
    endpoint: options.endpoint ?? httpProvider.endpoint ?? "",
    apiKeyEnv: options.apiKeyEnv ?? httpProvider.apiKeyEnv ?? "",
    requestFormat: options.requestFormat ?? httpProvider.requestFormat ?? "openai-chat",
  };
  next.providers["pi-provider"] = {
    ...(next.providers["pi-provider"] ?? {}),
    enabled: next.provider === "pi-provider",
  };
  return next;
}

function intentClassifierPosture(config: IntentClassifierConfig): string {
  if (!config.enabled || config.provider === "regex") return "regex-only";
  if (!config.sendUserTextToProvider) return `model-configured-but-send-disabled → fallback:${config.fallback}`;
  return config.fallback === "unknown" ? "model-strict" : "model-with-regex-fallback";
}

function formatIntentClassifierStatus(config: IntentClassifierConfig): string {
  const httpProvider = config.providers["http-json"] ?? {};
  return [
    `posture=${intentClassifierPosture(config)}`,
    `enabled=${config.enabled}`,
    `provider=${config.provider}`,
    `model=${config.model || "active/default"}`,
    `fallback=${config.fallback}`,
    `autoSwitch=${config.autoSwitchIntents.join(",")}`,
    `sendUserTextToProvider=${config.sendUserTextToProvider}`,
    config.provider === "http-json" ? `endpoint=${httpProvider.endpoint ? "set" : "unset"}` : undefined,
    config.provider === "http-json" ? `apiKeyEnv=${httpProvider.apiKeyEnv || "unset"}` : undefined,
    config.provider === "http-json" ? `format=${httpProvider.requestFormat ?? "openai-chat"}` : undefined,
    `minConfidence=${config.minConfidence}`,
    `timeoutMs=${config.timeoutMs}`,
  ].filter(Boolean).join(" · ");
}

function intentClassifierHelpTemplate(): string {
  return [
    "# ZOB intent classifier",
    "",
    "Usage:",
    "/intent status",
    "/intent regex",
    "/intent model-strict [provider/model-id]",
    "/intent model-fallback [provider/model-id]",
    "/intent test <text to classify>",
    "",
    "Examples:",
    "/intent model-strict",
    "/intent model-strict anthropic/claude-sonnet-4-20250514",
    "/intent model-fallback openai/gpt-4o-mini",
    "",
    "Presets:",
    "- regex: local regex only; no provider call",
    "- model-strict: Pi provider model when available; failures/low-confidence become unknown, never regex",
    "- model-fallback: Pi provider model when available; otherwise regex fallback",
    "- auto-switch: configured intents switch mode directly; default config enables explore, plan, implement, oracle, factory, orchestrator, vanilla",
    "",
    "Model selection:",
    "- If no model is passed, the current Pi model is used.",
    "- Autocomplete after `model-strict ` or `model-fallback ` lists available Pi models.",
    "- Advanced direct HTTP testing remains possible with hidden flags: --provider http-json --endpoint <url> --model <id>.",
    "",
    "Safety:",
    "- The classifier only suggests intent/mode routing.",
    "- It never approves secrets, destructive commands, commits, deploys, no-ship, or session access.",
    "- /intent test stores only inputHash metadata, not raw test text.",
  ].join("\n");
}

export function registerHarnessCommands(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.on("session_start", (_event, ctx) => {
    refreshIntentClassifierModelCache(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    refreshIntentClassifierModelCache(ctx);
  });

  registerZobIntroCommand(pi);

  // Exact `/new` is handled by Pi before extension input/command hooks. Soft carryover
  // is therefore written from the `session_shutdown` reason="new" hook in events.ts.
  // Keep this registration only for `/new hard`, where users need an explicit clean reset.
  pi.registerCommand("new", {
    description: "Hard reset helper for ZPeer/ZAgent continuity. Exact /new soft carryover is handled on session_shutdown reason=new.",
    getArgumentCompletions: (prefix) => {
      const query = prefix.trim().toLowerCase();
      const items: AutocompleteItem[] = [
        { value: "hard", label: "hard", description: "clear ZPeer/ZAgent carryover before starting a clean new session" },
      ];
      const filtered = query ? items.filter((item) => item.value.startsWith(query) || item.label.includes(query)) : items;
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const hard = args.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() === "hard";
      if (hard) {
        markZpeerNewHardResetPending(ctx.cwd);
        clearZpeerNewCarryoverProfile(ctx.cwd);
      }
      pi.appendEntry("zob-znew", {
        schema: "zob.znew-command.v1",
        source: "registered_command",
        action: hard ? "new_hard" : "new_soft_deferred_to_session_shutdown",
        carryoverWritten: false,
        carryoverCleared: hard,
        carryoverDeferredToShutdown: !hard,
        localOnly: true,
        networkEnabled: false,
        bodyStored: false,
        generatedAt: new Date().toISOString(),
      });
      await ctx.newSession();
    },
  });

  pi.registerCommand("zmode", {
    description: "Switch ZOB harness mode: explore | plan | implement | oracle | factory | orchestrator | vanilla. Orchestrator routes to adaptive-chief-vision plan_only defaults; vanilla restores Pi base-style unrestricted tool access outside ZOB governance.",
    handler: async (args, ctx) => {
      const requestedText = args.trim();
      const adaptiveEntrypoint = resolveAdaptiveZmodeEntrypoint(requestedText);
      if (adaptiveEntrypoint) {
        applyMode(pi, state, ctx, adaptiveEntrypoint.appliedHarnessMode);
        state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
        pi.appendEntry("zob-adaptive-zmode-entrypoint", adaptiveEntrypoint);
        ctx.ui.setEditorText(renderAdaptiveZmodeTemplate(adaptiveEntrypoint));
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`ZOB ${adaptiveEntrypoint.requestedMode} routed to ${adaptiveEntrypoint.profile} (${adaptiveEntrypoint.executionDefault}); root remains non-coding and parent-owned.`, "info");
        return;
      }
      const requested = requestedText as ModeName;
      const modes = Object.keys(MODE_PROMPTS) as ModeName[];
      if (!requested) {
        const choice = await ctx.ui.select("ZOB mode", modes);
        if (choice) {
          applyMode(pi, state, ctx, choice as ModeName);
          state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
        }
        return;
      }
      if (!modes.includes(requested)) {
        ctx.ui.notify(`Unknown mode '${requested}'. Use: ${modes.join(", ")}`, "warning");
        return;
      }
      applyMode(pi, state, ctx, requested);
      state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
    },
  });

  const handleIntentClassifierCommand = async (args: string, ctx: HarnessCommandContext): Promise<void> => {
    const trimmed = args.trim();
    const actionToken = trimmed.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "status";
    const rest = actionToken ? trimmed.slice(actionToken.length).trim() : "";
    const action = actionToken as IntentClassifierCommandAction;
    if (action === "help") {
      ctx.ui.setEditorText(intentClassifierHelpTemplate());
      ctx.ui.notify("Intent classifier command help inserted. Use /intent status or /intent model-strict [model].", "info");
      return;
    }
    if (action === "status") {
      const config = loadIntentClassifierConfig(ctx.cwd);
      pi.appendEntry("zob-intent-classifier-command", {
        schema: "zob.intent-classifier-command.v1",
        action: "status",
        posture: intentClassifierPosture(config),
        enabled: config.enabled,
        provider: config.provider,
        fallback: config.fallback,
        autoSwitchIntents: config.autoSwitchIntents,
        sendUserTextToProvider: config.sendUserTextToProvider,
        endpointConfigured: Boolean(config.providers["http-json"]?.endpoint),
        apiKeyEnv: config.providers["http-json"]?.apiKeyEnv || undefined,
        rawInputStored: false,
        bodyStored: false,
        generatedAt: new Date().toISOString(),
      });
      ctx.ui.notify(`intent-classifier ${formatIntentClassifierStatus(config)}`, "info");
      return;
    }
    if (action === "test") {
      if (!rest) {
        ctx.ui.notify("Usage: /intent-classifier test <text to classify>", "warning");
        return;
      }
      const classified = await classifyIntent(rest, ctx.cwd, undefined, { model: ctx.model, modelRegistry: ctx.modelRegistry, signal: ctx.signal });
      pi.appendEntry("zob-intent-classifier-command", {
        schema: "zob.intent-classifier-command.v1",
        action: "test",
        intent: classified.intent,
        confidence: classified.confidence,
        provider: classified.provider,
        configuredProvider: classified.configuredProvider,
        model: classified.model,
        fallbackReason: classified.fallbackReason,
        inputHash: classified.inputHash,
        rawInputStored: false,
        safetyApproved: false,
        bodyStored: false,
        generatedAt: new Date().toISOString(),
      });
      ctx.ui.notify(`intent=${classified.intent} provider=${classified.provider} configured=${classified.configuredProvider} confidence=${classified.confidence.toFixed(2)}${classified.fallbackReason ? ` fallback=${classified.fallbackReason}` : ""} rawInputStored=false safetyApproved=false`, classified.provider === "fallback" ? "warning" : "info");
      return;
    }
    if (action !== "regex" && action !== "model" && action !== "model-strict" && action !== "model-fallback") {
      ctx.ui.notify("Unknown /intent-classifier command. Use status | regex | model-strict | model-fallback | test <text> | help", "warning");
      return;
    }
    const options = parseIntentClassifierOptions(rest);
    if (options.errors.length > 0) {
      ctx.ui.notify(`/intent-classifier blocked: ${options.errors.join(" | ")}`, "warning");
      return;
    }
    refreshIntentClassifierModelCache(ctx);
    if (action !== "regex" && options.provider !== "http-json") {
      const available = ctx.modelRegistry.getAvailable().filter((model) => model.input.includes("text"));
      const requestedModel = options.model;
      if (requestedModel) {
        const matched = available.find((model) => modelKey(model) === requestedModel || model.id === requestedModel || model.name === requestedModel);
        options.model = matched ? modelKey(matched) : requestedModel;
      } else if (ctx.model) {
        options.model = modelKey(ctx.model);
      } else if (ctx.hasUI && available.length > 0) {
        const choices = available.slice(0, 80).map(modelKey);
        const selected = await ctx.ui.select("Intent classifier model", choices);
        if (!selected) {
          ctx.ui.notify("/intent-classifier cancelled: no model selected", "warning");
          return;
        }
        options.model = selected;
      } else {
        ctx.ui.notify("/intent-classifier blocked: no current or available Pi model found", "warning");
        return;
      }
    }
    const current = loadIntentClassifierConfig(ctx.cwd);
    const activeModel = ctx.model ? modelKey(ctx.model) : undefined;
    const next = writeIntentClassifierConfig(ctx.cwd, applyIntentClassifierPreset(current, action, options, activeModel));
    pi.appendEntry("zob-intent-classifier-command", {
      schema: "zob.intent-classifier-command.v1",
      action,
      posture: intentClassifierPosture(next),
      enabled: next.enabled,
      provider: next.provider,
      model: next.model,
      fallback: next.fallback,
      autoSwitchIntents: next.autoSwitchIntents,
      sendUserTextToProvider: next.sendUserTextToProvider,
      endpointConfigured: Boolean(next.providers["http-json"]?.endpoint),
      apiKeyEnv: next.providers["http-json"]?.apiKeyEnv || undefined,
      rawInputStored: false,
      bodyStored: false,
      generatedAt: new Date().toISOString(),
    });
    const endpointWarning = next.enabled && next.provider === "http-json" && !next.providers["http-json"]?.endpoint ? " · endpoint unset: tests will fallback" : "";
    const sendWarning = next.enabled && next.provider !== "regex" && next.sendUserTextToProvider ? " · future classification text may be sent to selected provider" : "";
    ctx.ui.notify(`intent-classifier updated: ${formatIntentClassifierStatus(next)}${endpointWarning}${sendWarning}`, next.enabled && next.provider !== "regex" ? "warning" : "info");
  };

  pi.registerCommand("intent-classifier", {
    description: "Configure/test ZOB intent classifier: status | regex | model-strict | model-fallback | test <text>",
    getArgumentCompletions: intentClassifierArgumentCompletions,
    handler: handleIntentClassifierCommand,
  });

  pi.registerCommand("intent", {
    description: "Alias for /intent-classifier",
    getArgumentCompletions: intentClassifierArgumentCompletions,
    handler: handleIntentClassifierCommand,
  });

  pi.registerCommand("stop", {
    description: "Stop current foreground work, background delegate_task runs, daemon loop, and runtime-goal auto-continuation without shutting down Pi.",
    handler: async (_args, ctx) => {
      const idleBeforeStop = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
      const pendingMessagesBeforeStop = typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false;
      const daemonWasRunning = state.daemon.loop.status === "running";
      const runtimeGoalId = state.runtimeGoal?.goalId;
      const foregroundAbortRequested = abortForegroundWork(ctx);
      const background = abortBackgroundDelegations(state);
      stopDaemonLoop(state, "slash_stop");
      const pausedGoal = pauseRuntimeGoalForStop(pi, state, "stopped by /stop; use /goal resume to continue");
      const daemonState = buildDaemonRuntimeState(daemonInputFromState(state));
      state.daemon.lastStatus = daemonState;
      pi.appendEntry("zob-daemon-runtime", daemonRuntimeLedgerEntry(daemonState));
      pi.appendEntry("zob-stop", stopCommandLedgerEntry({
        foregroundAbortRequested,
        idleBeforeStop,
        pendingMessagesBeforeStop,
        backgroundAbortedCount: background.abortedCount,
        backgroundRunIds: background.runIds,
        daemonWasRunning,
        runtimeGoalPaused: Boolean(pausedGoal && pausedGoal.goalId === runtimeGoalId && pausedGoal.status === "paused"),
        runtimeGoalId,
      }));
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify(`ZOB stop: foreground=${foregroundAbortRequested ? "aborted" : "idle"} background_aborted=${background.abortedCount} daemon=${daemonWasRunning ? "stopped" : "already_stopped"} goal=${pausedGoal?.status ?? "none"}`, "warning");
    },
  });

  pi.registerShortcut("ctrl+alt+d", {
    description: "Open ZOB delegated-agent viewer",
    handler: async (ctx) => {
      await showDelegationOverlay(ctx, state);
    },
  });

  const openDelegatesCommand = async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): Promise<void> => {
    await showDelegationOverlay(ctx, state, args.trim().split(/\s+/).filter(Boolean)[0]);
  };

  pi.registerCommand("delegates", {
    description: "Open ZOB delegated-agent viewer. Optional: /delegates <id|agent>",
    getArgumentCompletions: (prefix) => delegationArgumentCompletions(state, prefix),
    handler: openDelegatesCommand,
  });

  pi.registerCommand("delegate", {
    description: "Alias for /delegates. Optional: /delegate <id|agent>",
    getArgumentCompletions: (prefix) => delegationArgumentCompletions(state, prefix),
    handler: openDelegatesCommand,
  });

  const rememberZpeerEvent = (event: { kind: NonNullable<typeof state.zobLive.lastEvent>["kind"]; roomId?: string; fromAlias?: string; toAlias?: string; status: string; reason?: string; msgId?: string; taskHash?: string; outputHash?: string }): void => {
    state.zobLive.lastEvent = { ...event, at: new Date().toISOString(), localOnly: true, networkEnabled: false, bodyStored: false };
  };

  const emitZpeerEvent = (event: Parameters<typeof rememberZpeerEvent>[0]): void => {
    rememberZpeerEvent(event);
    void pi.sendMessage({
      customType: "zob-zpeer-event",
      content: `ZPeer ${event.kind} ${event.fromAlias ? `@${event.fromAlias}` : "?"} → ${event.toAlias ? `@${event.toAlias}` : "?"} ${event.status}`,
      display: true,
      details: { ...state.zobLive.lastEvent },
    }, { triggerTurn: false });
  };

  pi.registerCommand("zagent", {
    description: "Project-local full-session ZAgents: /zagent list | show <id> | use <id>",
    getArgumentCompletions: zagentArgumentCompletions,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] ?? "list").toLowerCase();
      if (action === "list") {
        const agents = listZagentManifests(ctx.cwd);
        const roomIds = agents.flatMap((agent) => normalizeZagentRoomBindings(agent.manifest.rooms, agent.manifest.defaultRoom, agent.manifest.activeRoom).map((room) => room.id));
        pi.appendEntry("zob-zagent", zagentLedgerEntry("list", { status: "ok", roomIds }));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zagent-list", content: formatZagentList(agents), display: true, details: { bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zagent list: ${agents.length} project-local manifest${agents.length === 1 ? "" : "s"}`, "info");
        return;
      }
      if (action === "show") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /zagent show <id>", "warning");
          return;
        }
        const loaded = loadZagentManifest(ctx.cwd, id);
        const rooms = normalizeZagentRoomBindings(loaded.manifest.rooms, loaded.manifest.defaultRoom, loaded.manifest.activeRoom);
        pi.appendEntry("zob-zagent", zagentLedgerEntry("show", { id: loaded.manifest.id, status: loaded.errors.length === 0 ? "ok" : "blocked", roomIds: rooms.map((room) => room.id), alias: loaded.manifest.alias, path: loaded.path, promptRef: loaded.manifest.promptRef, errors: loaded.errors }));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zagent-show", content: formatZagentShow(loaded), display: true, details: { id: loaded.manifest.id, bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zagent ${loaded.manifest.id}: ${loaded.errors.length === 0 ? "ok" : `blocked (${loaded.errors.length})`}`, loaded.errors.length === 0 ? "info" : "warning");
        return;
      }
      if (action === "use") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /zagent use <id>", "warning");
          return;
        }
        const loaded = loadZagentManifest(ctx.cwd, id);
        const prompt = readZagentPrompt(ctx.cwd, loaded.manifest.promptRef);
        const resolved = resolveZagentRuntimeRoomBindings(ctx.cwd, loaded.manifest);
        const rooms = resolved.rooms;
        const errors = [...loaded.errors, ...prompt.errors];
        state.zagent = {
          id: loaded.manifest.id,
          team: loaded.manifest.team ?? resolved.teamIds[0],
          teams: resolved.teamIds,
          role: loaded.manifest.role,
          alias: loaded.manifest.alias,
          description: loaded.manifest.description,
          rooms,
          activeRoom: rooms.find((room) => room.active)?.id ?? loaded.manifest.activeRoom ?? loaded.manifest.defaultRoom,
          defaultMode: loaded.manifest.defaultMode,
          prompt: prompt.body,
          promptRef: loaded.manifest.promptRef,
          path: loaded.path,
          errors,
          loadedAt: new Date().toISOString(),
          communicationPolicy: loaded.manifest.communicationPolicy as Record<string, unknown> | undefined,
        };
        if (errors.length > 0) {
          pi.appendEntry("zob-zagent", zagentLedgerEntry("use_blocked", { id: loaded.manifest.id, teamId: loaded.manifest.team, status: "blocked", roomIds: rooms.map((room) => room.id), alias: loaded.manifest.alias, path: loaded.path, promptRef: loaded.manifest.promptRef, promptBody: prompt.body, errors }));
          renderHarnessWidget(pi, state, ctx);
          ctx.ui.notify(`/zagent use ${id} blocked: ${errors[0]}`, "warning");
          return;
        }
        loadActiveZagentScopedMode(state, ctx.cwd);
        const scopedMode = state.zagent.scopedMode;
        if ((scopedMode?.blockers.length ?? 0) > 0) {
          const scopedErrors = state.zagent.errors.length > 0 ? state.zagent.errors : scopedMode?.blockers ?? [];
          pi.appendEntry("zob-zagent", zagentLedgerEntry("use_blocked", { id: loaded.manifest.id, teamId: loaded.manifest.team, status: "blocked", roomIds: rooms.map((room) => room.id), alias: loaded.manifest.alias, path: loaded.path, promptRef: loaded.manifest.promptRef, promptBody: prompt.body, errors: scopedErrors }));
          renderHarnessWidget(pi, state, ctx);
          ctx.ui.notify(`/zagent use ${id} scoped mode blocked: ${scopedMode?.blockers[0] ?? "see zagent errors"}`, "warning");
          return;
        }
        if (scopedMode?.active && scopedMode.baseMode) {
          applyMode(pi, state, ctx, scopedMode.baseMode, false);
          state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
        }
        if (!state.zobLive.peerCard) {
          const peerErrors = ["current session has not registered a local ZPeer endpoint yet"];
          state.zagent.errors = peerErrors;
          pi.appendEntry("zob-zagent", zagentLedgerEntry("use_blocked", { id: loaded.manifest.id, teamId: loaded.manifest.team, status: "blocked", roomIds: rooms.map((room) => room.id), alias: loaded.manifest.alias, path: loaded.path, promptRef: loaded.manifest.promptRef, promptBody: prompt.body, errors: peerErrors }));
          renderHarnessWidget(pi, state, ctx);
          ctx.ui.notify(`/zagent use ${id} loaded manifest/prompt but ZPeer is unavailable: ${peerErrors[0]}`, "warning");
          return;
        }
        const applied = await applyZagentToZpeer(ctx.cwd, state.zobLive.peerCard, loaded.manifest);
        state.zobLive.peerCard = applied.peer;
        if (!applied.ok) {
          state.zagent.errors = [applied.reason];
          pi.appendEntry("zob-zagent", zagentLedgerEntry("use_blocked", { id: loaded.manifest.id, teamId: loaded.manifest.team, status: "blocked", roomIds: rooms.map((room) => room.id), alias: loaded.manifest.alias, path: loaded.path, promptRef: loaded.manifest.promptRef, promptBody: prompt.body, errors: [applied.reason] }));
          renderHarnessWidget(pi, state, ctx);
          ctx.ui.notify(`/zagent use ${id} ZPeer apply blocked: ${applied.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = refreshZpeerSelf(ctx.cwd, applied.peer);
        state.zobLive.peerCard = {
          ...state.zobLive.peerCard,
          team: loaded.manifest.team ?? state.zobLive.peerCard.team,
          roleId: loaded.manifest.id,
          agent: loaded.manifest.id,
        };
        writeZpeerLocalProfileFromPeer(ctx.cwd, state.zobLive.peerCard, zpeerCommandProfileId(ctx));
        pi.appendEntry("zob-zagent", zagentLedgerEntry("use", { id: loaded.manifest.id, teamId: loaded.manifest.team, status: "ok", roomIds: zpeerMembershipsForPeer(state.zobLive.peerCard).map((membership) => membership.roomId), alias: state.zobLive.peerCard.zpeerAlias, path: loaded.path, promptRef: loaded.manifest.promptRef, promptBody: prompt.body }));
        renderHarnessWidget(pi, state, ctx);
        const active = state.zobLive.peerCard.zpeerRoomId ?? state.zobLive.peerCard.zpeerActiveRoomId ?? "default";
        ctx.ui.notify(`zagent ${loaded.manifest.id} loaded; ZPeer @${state.zobLive.peerCard.zpeerAlias ?? "?"} active=${active} rooms=${zpeerMembershipsForPeer(state.zobLive.peerCard).length}; promptHash=${prompt.body ? sha256(prompt.body).slice(0, 12) : "none"}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /zagent list | /zagent show <id> | /zagent use <id>", "warning");
    },
  });

  pi.registerCommand("zteam", {
    description: "Project-local ZTeams: /zteam list | show <id> | launch-plan <id> | reset <id> [--dry-run] (send /new to team tmux agents)",
    getArgumentCompletions: zteamArgumentCompletions,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] ?? "list").toLowerCase();
      if (action === "list") {
        const teams = listZteamManifests(ctx.cwd);
        const roomIds = teams.flatMap((team) => normalizeZagentRoomBindings(team.manifest.rooms, team.manifest.defaultRoom, team.manifest.activeRoom).map((room) => room.id));
        pi.appendEntry("zob-zagent", zagentLedgerEntry("zteam_list", { status: "ok", roomIds }));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zteam-list", content: formatZteamList(teams), display: true, details: { bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zteam list: ${teams.length} project-local manifest${teams.length === 1 ? "" : "s"}`, "info");
        return;
      }
      if (action === "show") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /zteam show <id>", "warning");
          return;
        }
        const loaded = loadZteamManifest(ctx.cwd, id);
        const rooms = normalizeZagentRoomBindings(loaded.manifest.rooms, loaded.manifest.defaultRoom, loaded.manifest.activeRoom);
        pi.appendEntry("zob-zagent", zagentLedgerEntry("zteam_show", { teamId: loaded.manifest.id, status: loaded.errors.length === 0 ? "ok" : "blocked", roomIds: rooms.map((room) => room.id), path: loaded.path, errors: loaded.errors }));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zteam-show", content: formatZteamShow(loaded), display: true, details: { id: loaded.manifest.id, bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zteam ${loaded.manifest.id}: ${loaded.errors.length === 0 ? "ok" : `blocked (${loaded.errors.length})`}`, loaded.errors.length === 0 ? "info" : "warning");
        return;
      }
      if (action === "launch-plan") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /zteam launch-plan <id>", "warning");
          return;
        }
        const loaded = loadZteamManifest(ctx.cwd, id);
        const plan = zteamLaunchPlanText(ctx.cwd, loaded.manifest);
        pi.appendEntry("zob-zagent", zagentLedgerEntry("zteam_launch_plan", { teamId: loaded.manifest.id, status: loaded.errors.length === 0 ? "ok" : "blocked", roomIds: plan.roomIds, path: loaded.path, errors: loaded.errors }));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zteam-launch-plan", content: loaded.errors.length ? `${plan.text}\n\nBlocked manifest errors:\n- ${loaded.errors.join("\n- ")}` : plan.text, display: true, details: { id: loaded.manifest.id, agentIdHashes: plan.agentIds.map((agentId) => sha256(agentId)), roomIdHashes: plan.roomIds.map((roomId) => sha256(roomId)), modelIdHashes: plan.modelIds.map((modelId) => sha256(modelId)), defaultModeHashes: plan.defaultModes.map((mode) => sha256(mode)), bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zteam ${loaded.manifest.id} launch-plan printed; spawn count=0; expectedRooms=${plan.roomIds.join(",") || "default"}; models=${plan.modelIds.length || "default"}; defaultModes=${plan.defaultModes.length || "current"}`, loaded.errors.length === 0 ? "info" : "warning");
        return;
      }
      if (action === "reset" || action === "new" || action === "reset-plan") {
        const parsed = parseZteamResetArgs(parts);
        if (!parsed.id) {
          ctx.ui.notify(`Usage: /zteam ${action} <id> [--dry-run]`, "warning");
          return;
        }
        const options = action === "reset-plan" ? { ...parsed.options, execute: false } : parsed.options;
        const loaded = loadZteamManifest(ctx.cwd, parsed.id);
        const plan = buildZteamResetPlan(ctx.cwd, loaded.manifest, options, [...loaded.errors, ...parsed.errors]);
        if (!options.execute) {
          pi.appendEntry("zob-zagent", zteamResetLedgerEntry(`zteam_${action}_dry_run`, plan, plan.errors.length === 0 ? "ok" : "blocked"));
          renderHarnessWidget(pi, state, ctx);
          void pi.sendMessage({ customType: "zob-zteam-reset-plan", content: formatZteamResetPlan(plan), display: true, details: { teamIdHash: sha256(plan.teamId), agentIdHashes: plan.agentIds.map((agentId) => sha256(agentId)), roomIdHashes: plan.roomIds.map((roomId) => sha256(roomId)), execute: false, spawnCount: 0, bodyStored: false } }, { triggerTurn: false });
          ctx.ui.notify(`zteam ${plan.teamId} reset dry-run; execute=false; spawn count=0; /new planned; errors=${plan.errors.length}`, plan.errors.length === 0 ? "info" : "warning");
          return;
        }
        if (plan.errors.length > 0) {
          pi.appendEntry("zob-zagent", zteamResetLedgerEntry(`zteam_${action}_execute_blocked`, plan, "blocked"));
          renderHarnessWidget(pi, state, ctx);
          void pi.sendMessage({ customType: "zob-zteam-reset-plan", content: formatZteamResetPlan(plan), display: true, details: { teamIdHash: sha256(plan.teamId), execute: true, confirmMatched: plan.confirmMatched, spawnCount: 0, bodyStored: false } }, { triggerTurn: false });
          ctx.ui.notify(`zteam ${plan.teamId} reset execute blocked; errors=${plan.errors.length}`, "warning");
          return;
        }
        const result = await executeZteamResetPlan(ctx.cwd, plan);
        pi.appendEntry("zob-zagent", zteamResetLedgerEntry(result.ok ? `zteam_${action}_execute` : `zteam_${action}_execute_failed`, plan, result.ok ? "ok" : "blocked", result.errors));
        renderHarnessWidget(pi, state, ctx);
        const actionStatusText = result.actionStatuses.length ? `\naction-statuses: ${result.actionStatuses.join(", ")}` : "";
        const errorText = result.errors.length ? `\nexecute errors:\n- ${result.errors.join("\n- ")}` : "";
        void pi.sendMessage({ customType: "zob-zteam-reset-plan", content: `${formatZteamResetPlan(plan)}${actionStatusText}${errorText}`, display: true, details: { teamIdHash: sha256(plan.teamId), execute: true, confirmMatched: plan.confirmMatched, spawnCount: plan.spawnCount, actionStatusHashes: result.actionStatuses.map((item) => sha256(item)), bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zteam ${plan.teamId} reset execute ${result.ok ? "ok" : "failed"}; sent /new through scoped launcher; spawn count=${plan.spawnCount}`, result.ok ? "info" : "warning");
        return;
      }
      ctx.ui.notify("Usage: /zteam list | /zteam show <id> | /zteam launch-plan <id> | /zteam reset <id> [--dry-run]", "warning");
    },
  });

  pi.registerCommand("zpeer", {
    description: "Room-scoped local peer sessions: /zpeer, /zpeer name <alias>, /zpeer room <roomId>, /zpeer @alias <prompt>",
    handler: async (args, ctx) => {
      if (!state.zobLive.peerCard) {
        ctx.ui.notify("/zpeer unavailable: current session has not registered a local peer endpoint yet", "warning");
        return;
      }
      const self = refreshZpeerSelf(ctx.cwd, state.zobLive.peerCard);
      state.zobLive.peerCard = self;
      const trimmed = args.trim();
      if (!trimmed) {
        const summary = buildZpeerRoomSummary(ctx.cwd, self);
        pi.appendEntry("zob-zpeer", {
          schema: "zob.zpeer-command.v1",
          action: "status",
          roomIdHash: sha256(summary.roomId),
          aliasHash: sha256(summary.selfAlias ?? ""),
          peerCount: summary.peerCount,
          online: summary.online,
          stale: summary.stale,
          offline: summary.offline,
          duplicateAliasCount: summary.duplicateAliases.length,
          membershipCount: summary.membershipCount ?? zpeerMembershipsForPeer(self).length,
          localOnly: true,
          networkEnabled: false,
          bodyStored: false,
          promptBodiesStored: false,
          outputBodiesStored: false,
          generatedAt: new Date().toISOString(),
        });
        emitZpeerEvent({ kind: "status", roomId: summary.roomId, fromAlias: summary.selfAlias, status: `online=${summary.online}/${summary.peerCount}`, reason: `stale=${summary.stale} offline=${summary.offline}` });
        renderHarnessWidget(pi, state, ctx);
        const availableAliases = summary.onlineAliases.filter((alias) => alias !== summary.selfAlias).map((alias) => `@${alias}`).join(", ") || "none";
        const unavailable = summary.stale + summary.offline;
        ctx.ui.notify(`zpeer room=${summary.roomId} memberships=${summary.membershipCount ?? zpeerMembershipsForPeer(self).length} self=@${summary.selfAlias ?? "?"} onlinePeers=${Math.max(0, summary.online - 1)} unavailable=${unavailable} livePeers=${availableAliases} · usage: /zpeer @alias <prompt> | /zpeer in <room> @alias <prompt> · safety: local-only/hash-only/bodyStored=false`, "info");
        return;
      }
      const parts = trimmed.split(/\s+/);
      const verb = parts[0]?.toLowerCase();
      const zpeerProfileId = zpeerCommandProfileId(ctx);
      if (verb === "name") {
        const result = await changeZpeerAlias(ctx.cwd, self, parts[1] ?? "");
        if (!result.ok) {
          ctx.ui.notify(`/zpeer name blocked: ${result.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = result.peer;
        writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "name", aliasHash: sha256(result.peer.zpeerAlias ?? ""), roomIdHash: sha256(result.peer.zpeerRoomId ?? "default"), localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer alias set to @${result.peer.zpeerAlias}`, "info");
        return;
      }
      if (verb === "room") {
        const result = await changeZpeerRoom(ctx.cwd, self, parts[1] ?? "");
        if (!result.ok) {
          ctx.ui.notify(`/zpeer room blocked: ${result.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = result.peer;
        writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "room", aliasHash: sha256(result.peer.zpeerAlias ?? ""), roomIdHash: sha256(result.peer.zpeerRoomId ?? "default"), membershipCount: zpeerMembershipsForPeer(result.peer).length, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer room set to ${result.peer.zpeerRoomId} as @${result.peer.zpeerAlias}`, "info");
        return;
      }
      if (verb === "rooms") {
        const memberships = zpeerMembershipsForPeer(self);
        const summaries = memberships.map((membership) => buildZpeerRoomSummary(ctx.cwd, self, membership.roomId));
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "rooms", roomIdHash: sha256(self.zpeerRoomId ?? "default"), membershipCount: memberships.length, roomHashes: memberships.map((membership) => sha256(membership.roomId)), localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer active=${self.zpeerRoomId ?? "default"} rooms=${summaries.map((summary) => `${summary.roomId}(${summary.online}/${summary.peerCount})`).join(", ") || "none"}`, "info");
        return;
      }
      if (verb === "clear") {
        const result = clearZpeerRoom(ctx.cwd, self, parts[1] ?? self.zpeerRoomId ?? "default");
        if (!result.ok) {
          ctx.ui.notify(`/zpeer clear blocked: ${result.reason}`, "warning");
          return;
        }
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "clear", roomIdHash: sha256(result.roomId), clearedCount: result.cleared, preservedSelf: result.preservedSelf, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer room ${result.roomId} cleared: ${result.cleared} other peer${result.cleared === 1 ? "" : "s"} marked offline/removed; current session preserved`, "info");
        return;
      }
      if (verb === "join") {
        const asIndex = parts.indexOf("as");
        const alias = asIndex >= 0 ? parts[asIndex + 1] : undefined;
        const role = parts.includes("--bridge") ? "bridge" : parts.includes("--observer") ? "observer" : "member";
        const result = await joinZpeerRoom(ctx.cwd, self, parts[1] ?? "", alias, role);
        if (!result.ok) {
          ctx.ui.notify(`/zpeer join blocked: ${result.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = result.peer;
        writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "join", aliasHash: sha256(alias ?? result.peer.zpeerAlias ?? ""), roomIdHash: sha256(parts[1] ?? "default"), membershipCount: zpeerMembershipsForPeer(result.peer).length, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer joined ${parts[1]} (${role}); active=${result.peer.zpeerRoomId}`, "info");
        return;
      }
      if (verb === "use") {
        const result = useZpeerRoom(ctx.cwd, self, parts[1] ?? "");
        if (!result.ok) {
          ctx.ui.notify(`/zpeer use blocked: ${result.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = result.peer;
        writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "use", aliasHash: sha256(result.peer.zpeerAlias ?? ""), roomIdHash: sha256(result.peer.zpeerRoomId ?? "default"), membershipCount: zpeerMembershipsForPeer(result.peer).length, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer active room set to ${result.peer.zpeerRoomId} as @${result.peer.zpeerAlias}`, "info");
        return;
      }
      if (verb === "leave") {
        const result = leaveZpeerRoom(ctx.cwd, self, parts[1] ?? "");
        if (!result.ok) {
          ctx.ui.notify(`/zpeer leave blocked: ${result.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = result.peer;
        writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "leave", roomIdHash: sha256(parts[1] ?? "default"), membershipCount: zpeerMembershipsForPeer(result.peer).length, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer left ${parts[1]}; active=${result.peer.zpeerRoomId}`, "info");
        return;
      }
      const sendModeFromParts = (inputParts: string[]): { mode: ZpeerSendMode; aliasToken?: string; bodyStartIndex: number } => {
        const first = inputParts[0]?.toLowerCase();
        if (first === "async" || first === "await" || first === "long") return { mode: first, aliasToken: inputParts[1], bodyStartIndex: 2 };
        return { mode: inputParts.includes("--async") ? "async" : inputParts.includes("--long") ? "long" : "await", aliasToken: inputParts[0], bodyStartIndex: 1 };
      };
      const explicitRoomId = verb === "in" ? parts[1] : undefined;
      const sendParts = explicitRoomId ? parts.slice(2) : parts;
      const sendMode = sendModeFromParts(sendParts);
      if (sendMode.aliasToken?.startsWith("@")) {
        const targetAlias = sendMode.aliasToken.slice(1);
        const transientPrompt = sendParts.slice(sendMode.bodyStartIndex).filter((part) => part !== "--async" && part !== "--long").join(" ").trim();
        const replyTimeoutMs = sendMode.mode === "long" ? 30 * 60 * 1000 : 10 * 60 * 1000;
        const eventRoomId = explicitRoomId ?? state.zobLive.peerCard.zpeerRoomId ?? "default";
        const eventFromAlias = peerAliasInRoom(state.zobLive.peerCard, eventRoomId) ?? state.zobLive.peerCard.zpeerAlias;
        if (sendMode.mode !== "async") emitZpeerEvent({ kind: "attempt", roomId: eventRoomId, fromAlias: eventFromAlias, toAlias: targetAlias, status: "attempt", taskHash: transientPrompt.trim() ? sha256(transientPrompt) : undefined });
        let feedbackEmittedTerminal = false;
        const result = await sendZpeerPrompt(ctx.cwd, state.zobLive.peerCard, targetAlias, transientPrompt, (msgId) => state.zobLive.pendingReplies.wait(msgId, replyTimeoutMs), {
          mode: sendMode.mode,
          roomId: explicitRoomId,
          onFeedback: (feedback) => {
            feedbackEmittedTerminal = feedback.result.status === "waiting" || feedback.result.status === "reply" || feedback.result.status === "completed" || feedback.result.status === "blocked" || feedback.result.status === "error" || feedback.result.status === "timeout" || feedback.result.status === "expired";
            const feedbackRoomId = feedback.result.roomId ?? eventRoomId;
            emitZpeerEvent({ kind: feedback.kind, roomId: feedbackRoomId, fromAlias: state.zobLive.peerCard ? peerAliasInRoom(state.zobLive.peerCard, feedbackRoomId) ?? eventFromAlias : eventFromAlias, toAlias: feedback.result.targetAlias ?? targetAlias, status: feedback.result.status, reason: feedback.result.reason, msgId: feedback.result.msgId, taskHash: feedback.result.taskHash, outputHash: feedback.result.outputHash });
          },
        });
        const terminalKind = result.status === "reply" || result.status === "completed" ? "reply" : result.status === "blocked" ? "blocked" : result.status === "timeout" ? "timeout" : result.status === "expired" ? "expired" : result.status === "error" ? "error" : result.status === "waiting" ? "waiting" : "delivered";
        if (!feedbackEmittedTerminal) {
          const resultRoomId = result.roomId ?? eventRoomId;
          emitZpeerEvent({ kind: terminalKind, roomId: resultRoomId, fromAlias: peerAliasInRoom(state.zobLive.peerCard, resultRoomId) ?? eventFromAlias, toAlias: result.targetAlias ?? targetAlias, status: result.status, reason: result.reason, msgId: result.msgId, taskHash: result.taskHash, outputHash: result.outputHash });
        }
        pi.appendEntry("zob-zpeer", {
          schema: "zob.zpeer-command.v1",
          action: sendMode.mode === "async" ? "send_async" : sendMode.mode === "long" ? "send_long_await" : "send_await",
          status: result.status,
          reasonHash: result.reason ? sha256(result.reason) : undefined,
          msgId: result.msgId,
          targetAliasHash: result.targetAlias ? sha256(result.targetAlias) : undefined,
          roomIdHash: sha256(result.roomId ?? eventRoomId),
          taskHash: result.taskHash,
          outputHash: result.outputHash,
          localOnly: true,
          networkEnabled: false,
          bodyStored: false,
          promptBodiesStored: false,
          outputBodiesStored: false,
          generatedAt: new Date().toISOString(),
        });
        renderHarnessWidget(pi, state, ctx);
        if ((result.status === "reply" || result.status === "completed") && result.transientResponse) {
          void pi.sendMessage({
            customType: "zob-zpeer-response",
            content: result.transientResponse,
            display: true,
            details: { msgId: result.msgId, targetAlias, outputHash: result.outputHash, bodyStored: false },
          }, { triggerTurn: false });
          ctx.ui.notify(`zpeer ${result.roomId ?? eventRoomId} @${targetAlias} reply · response displayed transiently · outputHash=${result.outputHash ?? "present"}`, "info");
        } else {
          const ok = result.status === "reply" || result.status === "completed" || result.status === "waiting" || result.status === "delivered";
          const passiveWaitSuffix = result.status === "waiting" ? " · idle/passive wait; no follow-up turn queued" : "";
          ctx.ui.notify(ok ? `zpeer ${result.roomId ?? eventRoomId} @${targetAlias} ${result.status}${result.outputHash ? ` outputHash=${result.outputHash}` : ""}${passiveWaitSuffix}` : `zpeer ${result.roomId ?? eventRoomId} @${targetAlias} ${result.status}: ${result.reason ?? "see metadata"}`, ok ? "info" : "warning");
        }
        return;
      }
      ctx.ui.notify("Usage: /zpeer | /zpeer rooms | /zpeer clear <roomId> | /zpeer join <roomId> [as <alias>] | /zpeer use <roomId> | /zpeer leave <roomId> | /zpeer @alias <prompt> | /zpeer in <roomId> @alias <prompt>", "warning");
    },
  });

  pi.registerCommand("zstatus", {
    description: "Refresh the ZOB harness widget from latest reports and sentinels. Use 'delegations' to open child-agent run details.",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const requested = (parts[0] ?? "").toLowerCase();
      if (["delegations", "delegation", "delegate", "agents"].includes(requested)) {
        await showDelegationOverlay(ctx, state, parts[1]);
        return;
      }
      if (["todos", "todo", "goal-todos", "goal_todos"].includes(requested)) {
        await showGoalTodoOverlay(ctx, state, parts[1]);
        return;
      }
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify("ZOB status refreshed from reports/", "info");
    },
  });

  pi.registerCommand("zcompact", {
    description: "Configure/session-run proactive ZOB compaction: /zcompact observe|on|off|status|threshold 60|target 25|fraction 25|trigger",
    getArgumentCompletions: (prefix) => {
      const query = prefix.trim().toLowerCase();
      const items = [
        { value: "status", label: "status", description: "show context usage and zcompact settings" },
        { value: "observe", label: "observe", description: "report threshold hits without compacting" },
        { value: "on", label: "on", description: "enable auto-compaction at threshold" },
        { value: "off", label: "off", description: "disable proactive compaction" },
        { value: "threshold 60", label: "threshold 60", description: "trigger at 60% context" },
        { value: "target 25", label: "target 25", description: "compact enough to return near 25% context" },
        { value: "fraction 25", label: "fraction 25", description: "minimum oldest batch if target needs less" },
        { value: "trigger", label: "trigger", description: "compact now using current strategy" },
        { value: "help", label: "help", description: "insert command help" },
      ];
      const filtered = query
        ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
        : items;
      return filtered.length > 0 ? filtered.slice(0, 20) : null;
    },
    handler: async (args, ctx) => {
      await handleZcompactCommand(pi, state, args, ctx, () => renderHarnessWidget(pi, state, ctx));
    },
  });

  pi.registerCommand("zcommit", {
    description: "Easy governed ZOB commit workflow: /zcommit status [paths/globs...]|plan [paths/globs...]|adopt <paths...>|commit [paths/globs...]|push|autocommit on|off|autopush on|off (no aliases)",
    getArgumentCompletions: zcommitArgumentCompletions,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const requested = (parts[0] ?? "status").toLowerCase();
      const pathspecArgs = parts.slice(1).filter((part) => part !== "--");

      if (requested === "status") {
        const plan = buildZcommitPlan(ctx.cwd, state.zcommit, { pathspecs: pathspecArgs });
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry("status", state, plan));
        ctx.ui.notify(formatZcommitStatus(plan), plan.noShip ? "warning" : "info");
        return;
      }
      if (requested === "plan") {
        const plan = buildZcommitPlan(ctx.cwd, state.zcommit, { pathspecs: pathspecArgs });
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry("plan", state, plan));
        ctx.ui.notify(formatZcommitPlan(plan), plan.noShip ? "warning" : "info");
        return;
      }
      if (requested === "adopt") {
        const result = runGovernedZcommitAdopt(ctx.cwd, state.zcommit, parts.slice(1));
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry(result.ok ? "adopt_completed" : "adopt_blocked", state, result.plan, result));
        renderHarnessWidget(pi, state, ctx);
        const adopted = result.adopted.join(", ") || "none";
        const excluded = result.excluded.map((entry) => `${entry.path}(${entry.reason})`).join(", ") || "none";
        const errors = result.errors.join(" | ") || "none";
        ctx.ui.notify(`${result.message}; adopted=[${adopted}] excluded=[${excluded}] errors=[${errors}]; ${formatZcommitPlan(result.plan)}`, result.ok ? "info" : "warning");
        return;
      }
      if (requested === "autocommit" || requested === "autopush") {
        const value = parts[1]?.toLowerCase();
        if (value !== "on" && value !== "off") {
          ctx.ui.notify(`Usage: /zcommit ${requested} on|off`, "warning");
          return;
        }
        const policy = readZcommitPolicy(ctx.cwd);
        if (value === "on" && !policy.loaded) {
          ctx.ui.notify(`/zcommit ${requested} on blocked: .pi/git-policy.json must load first`, "warning");
          return;
        }
        if (requested === "autopush" && value === "on" && state.zcommit.autocommit !== "on") {
          ctx.ui.notify("/zcommit autopush on blocked: enable /zcommit autocommit on first; fail-closed", "warning");
          return;
        }
        setZcommitToggle(state, requested, value);
        if (requested === "autocommit" && value === "off") setZcommitToggle(state, "autopush", "off");
        const nextPlan = buildZcommitPlan(ctx.cwd, state.zcommit);
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry(`${requested}_${value}`, state, nextPlan));
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zcommit ${requested}=${value} (easy mode=${nextPlan.selectionMode}; commit=${nextPlan.commitEnabled ? "easy-ready" : "blocked"} push=${nextPlan.pushEnabled ? "gated" : "blocked"})`, value === "on" ? "warning" : "info");
        return;
      }
      if (requested === "commit") {
        const result = runGovernedZcommitCommit(ctx.cwd, state.zcommit, { pathspecs: pathspecArgs });
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry(result.ok ? "commit_created" : "commit_blocked", state, result.plan, result));
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
        return;
      }
      if (requested === "push") {
        const result = runGovernedZcommitPush(ctx.cwd, state.zcommit, { explicitPush: true });
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry(result.ok ? "push_completed" : "push_blocked", state, result.plan, result));
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
        return;
      }
      ctx.ui.notify("Unknown /zcommit command. Use status [paths/globs...]|plan [paths/globs...]|adopt <paths...>|autocommit on|off|autopush on|off|commit [paths/globs...]|push. No aliases are registered.", "warning");
    },
  });

  const handleAutonomyCommand = async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): Promise<void> => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const requested = (parts[0] ?? "status").toLowerCase();
    state.autonomy.policy = readInteractiveAutonomyPolicy(ctx.cwd);
    state.autonomy.policyHash = sha256(JSON.stringify({ ...state.autonomy.policy, source: undefined }));

    if (requested === "help" || requested === "--help" || requested === "-h") {
      ctx.ui.setEditorText(autonomyHelpTemplate());
      ctx.ui.notify("ZOB autonomy help inserted.", "info");
      return;
    }

    if (requested === "daemon") {
      const daemonSubcommand = (parts[1] ?? "status").toLowerCase();
      if (!["status", "plan-tick", "tick", "start", "stop"].includes(daemonSubcommand)) {
        ctx.ui.notify("Unsupported daemon command. Use /autonomy daemon status|tick|start --max-ticks N|stop.", "warning");
        return;
      }
      if (daemonSubcommand === "stop") {
        stopDaemonLoop(state, "manual_stop");
        const daemonState = buildDaemonRuntimeState(daemonInputFromState(state));
        state.daemon.lastStatus = daemonState;
        pi.appendEntry("zob-daemon-runtime", daemonRuntimeLedgerEntry(daemonState));
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(formatDaemonStatusForUi(daemonState), "warning");
        return;
      }
      if (daemonSubcommand === "start") {
        const maxTicks = parseDaemonMaxTicks(parts);
        if (!maxTicks) {
          ctx.ui.notify("Use /autonomy daemon start --max-ticks N with N>=1 for a bounded supervised session loop.", "warning");
          return;
        }
        if (state.daemon.loop.status === "running") {
          ctx.ui.notify(`daemon loop already running ticks=${state.daemon.loop.tickCount}/${state.daemon.loop.maxTicks ?? "?"}; use /autonomy daemon stop first`, "warning");
          return;
        }
        const startedAt = new Date().toISOString();
        state.daemon.loop = {
          schema: "zob.daemon-loop-snapshot.v1",
          status: "running",
          tickCount: 0,
          maxTicks,
          startedAt,
          supervised: true,
          bounded: true,
          sessionLocal: true,
          autoStartDaemon: false,
          continuousLoop: false,
          cronEnabled: false,
        };
        state.daemon.policy = { ...state.daemon.policy, enabled: true };
        const { daemonState, plan } = recordDaemonTick(pi, state, ctx);
        if (plan.stop.stop) stopDaemonLoop(state, `stop_condition_${plan.status}`);
        if (state.daemon.loop.tickCount >= maxTicks) stopDaemonLoop(state, "max_ticks_reached");
        if (state.daemon.loop.status === "running") scheduleDaemonLoop(pi, state, ctx);
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(formatDaemonStatusForUi(daemonState), plan.stop.stop ? "warning" : "info");
        return;
      }
      if (daemonSubcommand === "tick" || daemonSubcommand === "plan-tick") {
        const queueReadonly = parts.includes("--queue-readonly") || parts.includes("--queue_readonly");
        const unsupportedQueueFlag = parts.includes("--queue") && !queueReadonly;
        if (unsupportedQueueFlag) {
          ctx.ui.notify("Use explicit /autonomy daemon tick --queue-readonly for the safe read-only queue bridge.", "warning");
          return;
        }
        const { plan, queueTick } = recordDaemonTick(pi, state, ctx, { queueReadonly });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(formatDaemonPlanForUi(plan, queueTick), plan.stop.stop || queueTick?.status === "failed" ? "warning" : "info");
        return;
      }
      const daemonState = buildDaemonRuntimeState(daemonInputFromState(state));
      state.daemon.lastStatus = daemonState;
      state.daemon.updatedAt = new Date().toISOString();
      pi.appendEntry("zob-daemon-runtime", daemonRuntimeLedgerEntry(daemonState));
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify(formatDaemonStatusForUi(daemonState), daemonState.status === "blocked" || daemonState.status === "needs_user" || daemonState.status === "needs_oracle" ? "warning" : "info");
      return;
    }

    if (requested === "score") {
      const draft = parts.slice(1).join(" ");
      if (!draft) {
        ctx.ui.notify("Use /autonomy score <mission draft> to score without launching.", "warning");
        return;
      }
      const scored = scoreMissionReadiness(draft, { mode: state.autonomy.mode, policy: state.autonomy.policy });
      const readiness = scored.launchAuthorization
        ? { ...scored, launchAuthorization: undefined, inScopeAutonomousActionsAuthorized: false, manualPerActionApprovalRequired: true }
        : scored;
      state.autonomy.lastReadiness = readiness;
      state.autonomy.lastLaunchAuthorization = undefined;
      state.autonomy.updatedAt = readiness.generatedAt;
      pi.appendEntry("zob-mission-readiness", toMissionReadinessLedgerEntry(readiness));
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify(`${formatMissionReadinessForUi(readiness)} · score-only no launch`, readiness.decision === "block" ? "warning" : "info");
      return;
    }

    const requestedMode = requested === "stop" ? "off" : asInteractiveAutonomyMode(requested);
    if (requestedMode) {
      state.autonomy.mode = requestedMode;
      state.autonomy.enabled = requestedMode !== "off";
      state.autonomy.updatedAt = new Date().toISOString();
      if (requestedMode === "off") {
        state.autonomy.lastLaunchAuthorization = undefined;
      }
      pi.appendEntry("zob-autonomy-state", toAutonomyStateLedgerEntry(state.autonomy));
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify(`ZOB autonomy: ${requestedMode}${requestedMode === "off" ? " (stopped)" : ""}`, requestedMode === "off" ? "warning" : "info");
      return;
    }

    if (requested === "status" || requested.length === 0) {
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify(formatInteractiveAutonomyStatus(state.autonomy), "info");
      return;
    }

    ctx.ui.notify("Unknown autonomy command. Use /autonomy help or /autonomy open|controlled|adaptive|status|stop|daemon status|daemon plan-tick.", "warning");
  };

  pi.registerCommand("autonomy", {
    description: "Set/show ZOB interactive autonomy and scoped daemon plan-only status: /autonomy open|controlled|adaptive|status|stop|daemon status|daemon plan-tick",
    getArgumentCompletions: autonomyArgumentCompletions,
    handler: handleAutonomyCommand,
  });

  const handleComputeCommand = async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): Promise<void> => {
    const parsed = parseComputeCommandArgs(args);
    if (parsed.help || args.trim().length === 0) {
      ctx.ui.setEditorText(computeHelpTemplate());
      ctx.ui.notify("ZOB compute command template inserted. Use /compute auto . or /effort high .", "info");
      return;
    }
    const preview = buildComputePreview(ctx.cwd, {
      domain: parsed.domain,
      requestedProfile: parsed.requestedProfile,
      targetPath: parsed.targetPath,
      maxProfile: parsed.maxProfile,
      riskHints: parsed.riskHints,
    });
    const resolution = resolveComputeProfile(ctx.cwd, {
      domain: parsed.domain,
      requestedProfile: parsed.requestedProfile,
      targetPath: parsed.targetPath,
      maxProfile: parsed.maxProfile,
      riskHints: parsed.riskHints,
    });
    const workflow = buildComputeWorkflowShape(ctx.cwd, {
      domain: parsed.domain,
      requestedProfile: parsed.requestedProfile,
      targetPath: parsed.targetPath,
      maxProfile: parsed.maxProfile,
      riskHints: parsed.riskHints,
    });
    const caps = resolution.caps && typeof resolution.caps === "object" ? resolution.caps as Record<string, unknown> : {};
    const effectiveProfile = typeof resolution.effectiveProfile === "string" ? resolution.effectiveProfile : "unknown";
    const recommendedProfile = typeof preview.recommendedProfile === "string" ? preview.recommendedProfile : "unknown";
    const laneCount = Array.isArray(workflow.lanes) ? workflow.lanes.length : 0;
    pi.appendEntry("zob-compute-profile", {
      schema: "zob.compute-command-preview.v1",
      requestedProfile: parsed.requestedProfile,
      recommendedProfile,
      effectiveProfile,
      domain: parsed.domain,
      targetPathHash: sha256(parsed.targetPath),
      targetPathStored: false,
      maxProfile: parsed.maxProfile,
      riskHints: parsed.riskHints,
      caps,
      laneCount,
      noShip: resolution.noShip === true,
      parentOwnedDispatch: true,
      childDirectDispatch: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
      generatedAt: new Date().toISOString(),
    });
    renderHarnessWidget(pi, state, ctx);
    const maxAgents = typeof caps.maxAgents === "number" ? caps.maxAgents : "?";
    const maxDepth = typeof caps.maxDelegationDepth === "number" ? caps.maxDelegationDepth : "?";
    const maxParallel = typeof caps.maxParallel === "number" ? caps.maxParallel : "?";
    const oracleRequired = caps.oracleRequired === true ? "oracle required" : "oracle conditional/off";
    const noShip = resolution.noShip === true ? " · no_ship=true" : "";
    ctx.ui.notify(`ZOB compute ${parsed.requestedProfile}→${effectiveProfile} (recommended ${recommendedProfile}) · agents≤${maxAgents} depth≤${maxDepth} parallel≤${maxParallel} · lanes=${laneCount} · ${oracleRequired}${noShip}`, resolution.noShip === true ? "warning" : "info");
  };

  pi.registerCommand("compute", {
    description: "Preview/resolve ZOB compute effort: /compute auto|low|medium|high|xhigh|max [target_path]",
    getArgumentCompletions: computeArgumentCompletions,
    handler: handleComputeCommand,
  });

  pi.registerCommand("effort", {
    description: "Alias for /compute. Example: /effort auto .",
    getArgumentCompletions: computeArgumentCompletions,
    handler: handleComputeCommand,
  });

  const handleProjectDnaCommand = async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): Promise<void> => {
    const parsed = parseProjectDnaCommandArgs(args);
    if (parsed.mode === "help") {
      ctx.ui.setEditorText(projectDnaHelpTemplate());
      ctx.ui.notify("ZOB ProjectDNA command template inserted.", "info");
      return;
    }
    if (parsed.mode === "readiness") {
      const audit = buildProjectDnaReadinessAudit(ctx.cwd, { scanDir: parsed.scanDir });
      pi.appendEntry("zob-project-dna-command", {
        schema: "zob.project-dna-command-readiness.v1",
        scanDirHash: sha256(parsed.scanDir ?? "reports/project-dna-scans/project-dna-factory-smoke"),
        scanDirStored: false,
        verdict: audit.verdict,
        noShip: audit.no_ship === true,
        bodyStored: false,
        generatedAt: new Date().toISOString(),
      });
      ctx.ui.notify(`ZOB ProjectDNA readiness: ${String(audit.verdict)}${audit.no_ship === true ? " · no_ship=true" : ""}`, audit.no_ship === true ? "warning" : "info");
      return;
    }
    if (parsed.mode === "plan") {
      const plan = buildProjectDnaAgenticPlan(ctx.cwd, { manifestPath: parsed.manifestPath ?? "", scanDir: parsed.scanDir });
      const lanes = Array.isArray(plan.lanes) ? plan.lanes.length : 0;
      const effectiveProfile = typeof plan.effective_compute_profile === "string" ? plan.effective_compute_profile : "unknown";
      const effectiveCapture = typeof plan.effective_capture_mode === "string" ? plan.effective_capture_mode : "unknown";
      pi.appendEntry("zob-project-dna-command", {
        schema: "zob.project-dna-command-plan.v1",
        manifestPathHash: sha256(parsed.manifestPath ?? ""),
        manifestPathStored: false,
        scanDirHash: sha256(parsed.scanDir ?? ""),
        scanDirStored: false,
        effectiveProfile,
        effectiveCapture,
        laneCount: lanes,
        metadataOnly: true,
        childDispatchAllowed: false,
        knowledgeBackendWriteEnabled: false,
        bodyStored: false,
        generatedAt: new Date().toISOString(),
      });
      ctx.ui.notify(`ZOB ProjectDNA plan: profile=${effectiveProfile} capture=${effectiveCapture} lanes=${lanes}`, "info");
      return;
    }
    const result = buildProjectDnaQueryResult(ctx.cwd, { scanDir: parsed.scanDir, query: parsed.query ?? "project dna", maxFiles: 8 });
    const files = Array.isArray(result.files_to_read_first) ? result.files_to_read_first.length : 0;
    const citations = Array.isArray(result.citations) ? result.citations.length : 0;
    pi.appendEntry("zob-project-dna-command", {
      schema: "zob.project-dna-command-query.v1",
      sourceId: result.source_id,
      scanDirHash: sha256(String(result.scan_dir ?? parsed.scanDir ?? "")),
      scanDirStored: false,
      queryHash: result.query_hash,
      rawQueryStored: false,
      fileCount: files,
      citationCount: citations,
      childDispatchAllowed: false,
      knowledgeBackendWriteEnabled: false,
      bodyStored: false,
      generatedAt: new Date().toISOString(),
    });
    ctx.ui.notify(`ZOB ProjectDNA query: source=${String(result.source_id)} files=${files} citations=${citations}`, "info");
  };

  pi.registerCommand("project-dna", {
    description: "Plan/query/audit repo-local ProjectDNA context. Example: /project-dna plan .pi/factories/project-dna/example-project-dna-manifest-v2.json reports/project-dna-scans/project-dna-factory-smoke",
    getArgumentCompletions: projectDnaArgumentCompletions,
    handler: handleProjectDnaCommand,
  });

  pi.registerCommand("rules_status", {
    description: "Resolve active ZOB rule profile for optional paths and current mode",
    handler: async (args, ctx) => {
      const paths = args.trim().length > 0 ? args.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean) : undefined;
      const resolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode, paths });
      state.activeRuleResolution = resolution;
      pi.appendEntry("zob-rules-resolution", {
        profile: resolution.profile,
        rulePacks: resolution.rulePacks,
        allowedTools: resolution.allowedTools,
        requiredValidation: resolution.requiredValidation,
        oracleRequired: resolution.oracleRequired,
        noShipConditions: resolution.noShipConditions,
        enforcement: resolution.enforcement,
        errors: resolution.errors,
        promptBodiesStored: false,
        outputBodiesStored: false,
        timestamp: new Date().toISOString(),
      });
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify(formatRuleResolution(resolution), resolution.errors.length > 0 ? "warning" : "info");
    },
  });

  pi.registerCommand("contract", {
    description: "Insert the six-part delegation contract template",
    handler: async (args, ctx) => {
      ctx.ui.setEditorText(formatContractTemplate(args.trim() || "[atomic goal]"));
    },
  });

  pi.registerCommand("goal", {
    description: "Unified ZOB runtime goal: /goal <objective>, pause, resume, clear, status, gate, todo, oracle PASS|WARN|FAIL",
    handler: async (args, ctx) => {
      await handleGoalCommand(pi, state, args, ctx, () => renderHarnessWidget(pi, state, ctx));
    },
  });

  pi.registerCommand("todo", {
    description: "Alias for /goal todo. Manage goal-linked TODOs and subtodos.",
    handler: async (args, ctx) => {
      await handleGoalCommand(pi, state, `todo ${args}`.trim(), ctx, () => renderHarnessWidget(pi, state, ctx));
    },
  });

  pi.registerCommand("todos", {
    description: "Alias for /goal todo tree. Use /todos overlay to open the TODO overlay.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "overlay" || trimmed.startsWith("overlay ") || trimmed === "view" || trimmed.startsWith("view ")) {
        await showGoalTodoOverlay(ctx, state, trimmed.split(/\s+/)[1]);
        return;
      }
      await handleGoalCommand(pi, state, `todo ${trimmed || "tree"}`.trim(), ctx, () => renderHarnessWidget(pi, state, ctx));
    },
  });

  pi.registerCommand("goal_gate", {
    description: "Alias for /goal gate. Set or insert the active ZOB goal gate; --strict requires it before ZOB dispatch tools.",
    handler: async (args, ctx) => {
      handleGoalGateCommand(pi, state, args.trim(), ctx, () => renderHarnessWidget(pi, state, ctx));
    },
  });

  pi.registerCommand("job_intake", {
    description: "Parse billable job intake into active goal plus optional advisory budget sidecar",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.setEditorText([
          "ORIGINAL_USER_ASK: [paste the user's exact ask]",
          "ACTIVE_GOAL: [one bounded billable job goal]",
          "EXPECTED_OUTPUT: [observable paid deliverable]",
          "CONSTRAINTS: [must-do and must-not-do constraints]",
          "VALIDATION_EVIDENCE: [commands, files, sentinels, or oracle verdict required]",
          "BUDGET: [optional advisory sidecar; absence is allowed]",
        ].join("\n"));
        return;
      }
      const intake = parseBillableJobIntake(text);
      const errors = validateBillableJobIntake(intake);
      if (errors.length > 0) {
        ctx.ui.notify(`ZOB job intake rejected:\n- ${errors.join("\n- ")}`, "warning");
        return;
      }
      state.activeGoal = intake.goal;
      state.goalRequired = true;
      pi.appendEntry("zob-job-intake", intake);
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify(`ZOB job intake accepted: ${intake.goal.activeGoal.slice(0, 100)} (budget advisory only)`, "info");
    },
  });

  pi.registerCommand("agents", {
    description: "List ZOB project/user specialist agents",
    handler: async (_args, ctx) => {
      const agents = discoverAgents(ctx.cwd, "both");
      ctx.ui.notify(formatAgentList(agents), "info");
    },
  });
}
