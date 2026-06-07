import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { sha256 } from "../../core/utils/hashing.js";
import { buildZcommitPlan, formatZcommitPlan, formatZcommitStatus, readZcommitPolicy, runGovernedZcommitAdopt, runGovernedZcommitCommit, runGovernedZcommitPush, type ZcommitAdoptResult, type ZcommitCommandResult, type ZcommitOwnedPathRef, type ZcommitToggleState } from "../../domains/git/git-ops.js";
import type { HarnessRuntimeState } from "../state.js";
import { renderHarnessWidget } from "../widget.js";

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

export function registerZcommitCommand(pi: ExtensionAPI, state: HarnessRuntimeState): void {
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
}
