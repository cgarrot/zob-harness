import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { buildDaemonRuntimeState } from "../../domains/autonomy/daemon-runtime.js";
import { sha256 } from "../../core/utils/hashing.js";
import type { HarnessRuntimeState } from "../state.js";
import { asInteractiveAutonomyMode, formatInteractiveAutonomyStatus, formatMissionReadinessForUi, readInteractiveAutonomyPolicy, scoreMissionReadiness, toAutonomyStateLedgerEntry, toMissionReadinessLedgerEntry } from "../../domains/autonomy/interactive-autonomy.js";
import { renderHarnessWidget } from "../widget.js";
import { daemonInputFromState, daemonRuntimeLedgerEntry, formatDaemonStatusForUi, formatDaemonPlanForUi, stopDaemonLoop, parseDaemonMaxTicks, recordDaemonTick, scheduleDaemonLoop } from "./daemon.js";

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

export function registerAutonomyCommand(pi: ExtensionAPI, state: HarnessRuntimeState): void {
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
}
