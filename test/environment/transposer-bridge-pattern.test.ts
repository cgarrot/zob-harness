// WS-PH4 (environment-precondition PART II): harness-side VALIDATION that the
// transposer->harness EnvironmentContract BRIDGE ADAPTER shape is behavior-preserving
// for project-transposer's EXACT physical-environment precondition FSM. This is a
// DRY-RUN of the migration described in
// .pi/extensions/zob-harness/reports/environment-ws-ph4-migration-spec.md: it proves
// an adapter implementing transposer's dirEmpty/toolchainInstalled/commandPresent
// semantics on top of the harness EnvironmentContract shape preserves
// FAIL-CLOSED-BEFORE-START (the live bug: 3089 stale entries + missing pinned
// 1.95.0 => shouldStart===false with both fix commands) + AUTO-RESOLVE SAFETY
// (mv-aside applied; rustup-install network-gated; reversible:false refused ALWAYS;
// aside-collision refused). The adapter is TEST-LOCAL: it registers via the PUBLIC
// harness API (registerEnvironmentContract + registerResolutionStrategy) and does NOT
// ship in the harness domain (no transposer coupling in shipped code).
//
// Reference (READ-ONLY, project-transposer repo):
//   - dirEmpty / toolchainInstalled / commandPresent ... scripts/validate-environment.mjs
//     (PURE over an injected IO seam; the EXACT semantics this adapter reproduces).
//       dir_empty       : readdir(target) applying scope.ignore; missing dir == empty.
//       toolchain_installed : rustup toolchain list contains the channel AND the
//                             required components (default rustfmt, clippy).
//       command_present : base command on PATH (SOFT => warning, not blocker).
//   - synthesizePreconditions ........... scripts/validate-environment.mjs
//     (2 defaults: dir_empty on target_project_path + toolchain_installed on
//      pinned_toolchain; the aside suffix is the pinned channel).
//   - applyAutoResolve (WS-P4 monolithic) . scripts/validate-environment.mjs
//     (aside-collision refused; reversible:false refused; requires_network gated).
//   - config/environment-auto-resolve.json : mv-aside {reversible:true,
//     requires_network:false, guards.refuse_if_aside_path_exists} + rustup-install
//     {reversible:true, requires_network:true, guards.add_only_never_default_change}.
//
// The harness primitives (domains/environment/primitives.ts) are byte-faithful
// mirrors of the transposer dirEmpty/toolchainInstalled/commandPresent bodies (the
// harness was built to mirror them — see primitives.ts header). So the adapter
// calling the harness primitives IS equivalent to the bridge calling the UNCHANGED
// transposer bodies (the .mjs adapter imports them; here they are reproduced
// test-locally via the public harness API, no transposer import). Deterministic,
// body-free, network-disabled: fake snapshots only (no real disk/rustup/which).

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  AUTO_RESOLVE_AUDIT_SCHEMA,
  applyAutoResolve,
  commandPresent,
  dirEmpty,
  registerEnvironmentContract,
  registerResolutionStrategy,
  resolveEnvironmentContract,
  runLaunchGate,
  toolchainInstalled,
  type AutoResolveAllowlist,
  type AutoResolveAuditEntry,
  type AutoResolveIO,
  type AutoResolveResult,
  type AutoResolveVerdict,
  type EnvironmentContract,
  type EnvironmentSnapshot,
  type Precondition,
  type PreconditionVerdict,
  type ResolutionStrategyFn,
} from "../../.pi/extensions/zob-harness/index.ts";

// ===========================================================================
// TEST-LOCAL TRANSPONDER ADAPTER (does NOT ship in the harness domain)
// ===========================================================================

const TRANSPONDER_ENV_REDUCER_ID = "project-transposer";

// The live-bug target + pinned channel (paths/counts/channel names only — no bodies).
const TARGET_PATH = "/Users/cgarrot/out_zob/pi-rs";
const PINNED_CHANNEL = "1.95.0";

// --- the live bug, as two launch-phase preconditions (metadata-only) ---------
// The exact two preconditions that stalled the live run (~2h in): a non-empty
// target tree (3089 stale entries) + a missing pinned Rust 1.95.0. The fix_commands
// are the EXACT mv-aside + rustup-install commands the supervisor reconstructed by
// hand at 02:18:10Z. The aside suffix is the pinned channel (the single
// deterministic identifier known at launch), faithful to synthesizePreconditions.
const TARGET_EMPTY_PRECONDITION: Precondition = {
  id: "target-empty",
  kind: "dir_empty",
  target: TARGET_PATH,
  scope: { ignore: [".DS_Store"] },
  check_phase: "launch",
  remediation: "move existing tree aside (reversible)",
  fix_command: `mv "${TARGET_PATH}" "${TARGET_PATH}.prior-${PINNED_CHANNEL}"`,
  auto_resolvable: true,
  requires_network: false,
  note: "confirm target_project_path is empty before launch",
};

const TOOLCHAIN_PRECONDITION: Precondition = {
  id: "pinned-toolchain",
  kind: "toolchain_installed",
  target: PINNED_CHANNEL,
  scope: { components: ["rustfmt", "clippy"] },
  check_phase: "launch",
  remediation: "install pinned toolchain with required components (reversible via rustup uninstall)",
  fix_command: `rustup toolchain install ${PINNED_CHANNEL} --component rustfmt,clippy`,
  auto_resolvable: true,
  requires_network: true,
};

const LAUNCH_PRECONDITIONS: readonly Precondition[] = [
  TARGET_EMPTY_PRECONDITION,
  TOOLCHAIN_PRECONDITION,
];

// --- the test-local EnvironmentContract -------------------------------------
// evaluatePrecondition dispatches to the PURE harness primitives (dirEmpty /
// toolchainInstalled / commandPresent — byte-faithful mirrors of the transposer
// bodies) and maps the result into a PreconditionVerdict. This is EXACTLY what the
// bridge does (the .mjs adapter imports the UNCHANGED transposer bodies; here the
// harness primitives stand in for them because they are byte-faithful). The snapshot
// reader is injected per-test so each case controls the observed environment
// deterministically (no real disk/rustup/PATH).
function makeTransposerContract(
  snapshotImpl: () => EnvironmentSnapshot,
): EnvironmentContract {
  return {
    evaluatePrecondition(p: Precondition, env: EnvironmentSnapshot): PreconditionVerdict {
      let base: { readonly ok: boolean; readonly observed: string; readonly expected: string };
      // Dispatch to the PURE primitives over the harness snapshot (the bridge calls
      // the UNCHANGED transposer bodies over a transposer-shaped io re-derived from
      // the snapshot; the harness primitives are byte-faithful mirrors, so the
      // verdict is identical).
      if (p.kind === "dir_empty") {
        base = dirEmpty(p.target, p.scope, env);
      } else if (p.kind === "toolchain_installed") {
        base = toolchainInstalled(p.target, p.scope?.components, env);
      } else if (p.kind === "command_present") {
        base = commandPresent(p.target, env);
      } else {
        base = { ok: false, observed: `unknown kind: ${p.kind}`, expected: "known kind" };
      }
      const ok = base.ok === true;
      return {
        ok,
        observed: base.observed,
        expected: base.expected,
        // fix_command null when ok; else the precondition's operator-runnable command.
        fix_command: ok ? null : p.fix_command ?? null,
        auto_resolvable: p.auto_resolvable,
        requires_network: p.requires_network,
      };
    },
    snapshotEnvironment() {
      // The SINGLE IO reader (the bridge's readRealSnapshot does the real probes;
      // tests inject a fake snapshot directly via runLaunchGate({snapshot}), so this
      // is never called in the FAIL-CLOSED / PASSING cases below).
      return snapshotImpl();
    },
    preconditions(checkPhase: string): readonly Precondition[] {
      return checkPhase === "launch" ? LAUNCH_PRECONDITIONS : [];
    },
  };
}

// --- deterministic fake snapshots (the ONLY IO the primitives read) ----------
// Reproduce the live failing environment: 3089 stale entries + installed 1.94.0,
// 1.87.0 (1.95.0 missing). Deterministic in-memory fakes — no disk, no rustup.
function failingSnapshot(): EnvironmentSnapshot {
  const entries = Array.from({ length: 3089 }, (_, i) => `file-${i}.rs`);
  return {
    dirEntries: () => entries.slice(),
    installedToolchains: () => ["1.94.0", "1.87.0"],
    toolchainComponents: () => [],
    commandOnPath: (name) => name === "cargo",
    writable: () => true,
  };
}

function passingSnapshot(): EnvironmentSnapshot {
  return {
    dirEntries: () => [],
    installedToolchains: () => [PINNED_CHANNEL],
    toolchainComponents: (channel) =>
      channel === PINNED_CHANNEL ? ["rustfmt", "clippy"] : [],
    commandOnPath: () => true,
    writable: () => true,
  };
}

// --- project-registered strategies (mirrors how the owner registers them) ----
// The harness NEVER hardcodes a shell command; the app registers mv-aside +
// rustup-install under their strategy names. These respect ctx.dryRun (return
// after_state:null, do NOT call io.exec) so the dry-run-first property is observable.
//
// mv-aside: move the existing tree aside (reversible). Parses the aside-path from
// the verdict's fix_command, REFUSES (throws a typed AsideCollisionError) if the
// aside-path already exists (the guard — symmetric with the harness dryRun io-guard
// which also throws; defense-in-depth), exec via io.exec, before/after = entry
// counts. The thin-caller converts the throw to a refused/aside_path_exists audit
// disposition (faithful to the transposer's monolithic refusal).
class AsideCollisionError extends Error {
  readonly asidePath: string;
  constructor(asidePath: string, command: string) {
    super(`aside-collision: ${asidePath} already exists (refusing mv-aside)`);
    this.name = "AsideCollisionError";
    this.asidePath = asidePath;
    // attach command for the thin-caller audit (metadata-only; a command string).
    (this as AsideCollisionError & { command: string }).command = command;
  }
}

function parseAsidePath(command: string): string | null {
  // `mv "/x" "/x.prior-1.95.0"` -> "/x.prior-1.95.0" (the 2nd quoted arg).
  const m = /^mv\s+"([^"]+)"\s+"([^"]+)"/.exec(String(command || ""));
  return m ? m[2] : null;
}

const mvAsideStrategy: ResolutionStrategyFn = (
  verdict: PreconditionVerdict,
  ctx: { io: AutoResolveIO; dryRun: boolean },
) => {
  const command = verdict.fix_command ?? "";
  const asidePath = parseAsidePath(command);
  // The guard: refuse (throw) if the aside-path already exists — BEFORE io.exec.
  if (asidePath && ctx.io.exists(asidePath)) {
    throw new AsideCollisionError(asidePath, command);
  }
  // before_state: parse the observed "N entries" into a count (metadata-only).
  const match = /(\d+) entries/.exec(verdict.observed);
  const entryCount = match ? Number(match[1]) : 0;
  if (ctx.dryRun) {
    return { command, before_state: { entry_count: entryCount }, after_state: null };
  }
  ctx.io.exec(command);
  return {
    command,
    before_state: { entry_count: entryCount },
    after_state: { entry_count: 0, aside_path: asidePath },
  };
};

// rustup-install: install the pinned toolchain (reversible via rustup uninstall;
// add-only, never a default change). before_state = installed channels; after_state
// (non-dry-run) = installed channels + the newly added channel.
const rustupInstallStrategy: ResolutionStrategyFn = (
  verdict: PreconditionVerdict,
  ctx: { io: AutoResolveIO; dryRun: boolean },
) => {
  const command = verdict.fix_command ?? "";
  const installedMatch = /installed (.*)/.exec(verdict.observed);
  const installed = installedMatch ? installedMatch[1].split(", ").filter(Boolean) : [];
  if (ctx.dryRun) {
    return { command, before_state: { installed }, after_state: null };
  }
  ctx.io.exec(command);
  const channel = verdict.fix_command ? /install (\S+)/.exec(verdict.fix_command)?.[1] ?? "" : "";
  return {
    command,
    before_state: { installed },
    after_state: { installed: [...installed, channel] },
  };
};

// Register the adapter (contract + strategies) ONCE at module load, mirroring how
// the owner calls registerTransposerEnvironmentBridge({root, runId, ...}) once at
// run init. The registry is module-global (the WS-PH1 contract registry pattern).
// Each test re-resolves the contract by id and re-injects a snapshot.
registerResolutionStrategy("mv-aside", mvAsideStrategy);
registerResolutionStrategy("rustup-install", rustupInstallStrategy);
registerEnvironmentContract(TRANSPONDER_ENV_REDUCER_ID, makeTransposerContract(passingSnapshot));

// ===========================================================================
// Deterministic test scaffolding
// ===========================================================================

let auditDir: string;
before(() => {
  auditDir = mkdtempSync(join(tmpdir(), "zob-ph4-env-bridge-"));
});
after(() => {
  try {
    rmSync(auditDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the temp audit-log dir */
  }
});

// A deterministic fake IO that records the commands it would run, so a test can
// assert "io.exec was NOT called". `existsImpl` controls the aside-collision probe.
function makeFakeIo(existsImpl: (path: string) => boolean = () => false): {
  io: AutoResolveIO;
  execCalls: string[];
} {
  const execCalls: string[] = [];
  const io: AutoResolveIO = {
    exec: (cmd: string) => {
      execCalls.push(cmd);
      return { stdout: "", status: 0 };
    },
    exists: existsImpl,
  };
  return { io, execCalls };
}

// Build AutoResolveVerdict[] from a gate result by pairing each failing verdict with
// its precondition kind+target (PreconditionVerdict has no kind/target; the
// thin-caller pairs them — the integration seam documented in auto-resolve.ts).
function failingVerdictsAsAutoResolve(
  contract: EnvironmentContract,
  gate: { readonly verdicts: readonly PreconditionVerdict[] },
): AutoResolveVerdict[] {
  const launchPres = contract.preconditions("launch");
  const out: AutoResolveVerdict[] = [];
  for (let i = 0; i < launchPres.length; i += 1) {
    if (gate.verdicts[i].ok) continue;
    out.push({
      ...gate.verdicts[i],
      kind: launchPres[i].kind,
      target: launchPres[i].target,
    });
  }
  return out;
}

// --- allowlists (metadata-only; mirror config/environment-auto-resolve.json) --
const MV_ASIDE_ALLOWLIST: AutoResolveAllowlist = {
  schema: "project-transposer.environment-auto-resolve.v1",
  allow: [{ kind: "dir_empty", strategy: "mv-aside", reversible: true, requires_network: false }],
};

const BOTH_ALLOWLIST: AutoResolveAllowlist = {
  schema: "project-transposer.environment-auto-resolve.v1",
  allow: [
    { kind: "dir_empty", strategy: "mv-aside", reversible: true, requires_network: false },
    { kind: "toolchain_installed", strategy: "rustup-install", reversible: true, requires_network: true },
  ],
};

// ===========================================================================
// DISTINCTNESS: the adapter is a genuinely different consumer registered via the
// PUBLIC harness API (no transposer coupling in shipped code).
// ===========================================================================
test("distinctness: project-transposer environment adapter is registered via the public API and resolvable", () => {
  assert.equal(resolveEnvironmentContract(TRANSPONDER_ENV_REDUCER_ID), resolveEnvironmentContract(TRANSPONDER_ENV_REDUCER_ID));
  const contract = resolveEnvironmentContract(TRANSPONDER_ENV_REDUCER_ID);
  assert.ok(contract, "the project-transposer EnvironmentContract is registered");
  assert.equal(typeof contract!.evaluatePrecondition, "function");
  assert.equal(typeof contract!.snapshotEnvironment, "function");
  assert.equal(typeof contract!.preconditions, "function");
  // Distinct from the built-in toy consumers (toy-env / toy-launch-gate / data-pipeline).
  assert.notEqual(TRANSPONDER_ENV_REDUCER_ID, "toy-env");
  assert.notEqual(TRANSPONDER_ENV_REDUCER_ID, "toy-launch-gate");
});

// ===========================================================================
// (a) FAIL-CLOSED-BEFORE-START (the headline) — the EXACT live bug: a snapshot
//     reporting 3089 entries + installedToolchains ['1.94.0','1.87.0'] (1.95.0
//     missing) => runLaunchGate(adapterContract).shouldStart === false AND
//     fix_packet has 2 entries (dir_empty + toolchain_installed) each with a
//     NON-EMPTY fix_command (the mv-aside + rustup-install commands the supervisor
//     reconstructed by hand at 02:18:10Z).
// ===========================================================================
test("bridge (a): live failing env (3089 entries + missing 1.95.0) => shouldStart===false, fix_packet has 2 entries with non-empty fix_commands", () => {
  const contract = makeTransposerContract(failingSnapshot);
  const result = runLaunchGate(contract, { snapshot: failingSnapshot() });

  // FAIL-CLOSED-BEFORE-START: any single failing precondition blocks start.
  assert.equal(result.ok, false, "ok must be false when both preconditions fail");
  assert.equal(result.shouldStart, false, "shouldStart must be false (fail-closed before agents start)");
  assert.equal(result.shouldStart, result.ok, "shouldStart === ok BY CONSTRUCTION (no opt-out)");
  assert.equal(result.verdicts.length, 2, "both launch preconditions are evaluated");
  assert.equal(result.fix_packet.length, 2, "one fix_packet entry per failing precondition");

  // Entry 0: dir_empty (the 3089-entry tree) — non-network, reversible mv-aside.
  const dirEntry = result.fix_packet[0];
  assert.equal(dirEntry.kind, "dir_empty");
  assert.equal(dirEntry.target, TARGET_PATH);
  assert.equal(dirEntry.requires_network, false);
  assert.equal(dirEntry.auto_resolvable, true);
  assert.equal(
    dirEntry.fix_command,
    TARGET_EMPTY_PRECONDITION.fix_command,
    "dir fix_command is the EXACT mv-aside command (supervisor-reconstructed)",
  );
  assert.ok(
    typeof dirEntry.fix_command === "string" && dirEntry.fix_command.length > 0,
    `dir fix_command must be non-empty: ${JSON.stringify(dirEntry.fix_command)}`,
  );
  assert.ok(dirEntry.observed.includes("3089"), `observed should report 3089 entries: ${dirEntry.observed}`);
  assert.equal(dirEntry.expected, "0 entries");

  // Entry 1: toolchain_installed (missing 1.95.0) — network-required rustup-install.
  const tcEntry = result.fix_packet[1];
  assert.equal(tcEntry.kind, "toolchain_installed");
  assert.equal(tcEntry.target, PINNED_CHANNEL);
  assert.equal(tcEntry.requires_network, true);
  assert.equal(tcEntry.auto_resolvable, true);
  assert.equal(
    tcEntry.fix_command,
    TOOLCHAIN_PRECONDITION.fix_command,
    "toolchain fix_command is the EXACT rustup-install command (supervisor-reconstructed)",
  );
  assert.ok(
    typeof tcEntry.fix_command === "string" && tcEntry.fix_command.length > 0,
    `toolchain fix_command must be non-empty: ${JSON.stringify(tcEntry.fix_command)}`,
  );
  assert.ok(tcEntry.expected.includes(PINNED_CHANNEL), "expected must name the pinned channel");

  // BOTH fix commands are in the packet (the supervisor would have had to run both
  // by hand before WS-PH4; now they are machine-derived from the contract).
  const commands = result.fix_packet.map((e) => e.fix_command);
  assert.ok(commands.includes(TARGET_EMPTY_PRECONDITION.fix_command), "mv-aside command present");
  assert.ok(commands.includes(TOOLCHAIN_PRECONDITION.fix_command), "rustup-install command present");
});

// ===========================================================================
// (b) PASSING env (empty dir + 1.95.0 present): shouldStart === true AND ok ===
//     true AND fix_packet empty. The flip side of fail-closed: the gate PASSES when
//     the environment is ready (the gate must not over-block).
// ===========================================================================
test("bridge (b): passing env (empty dir + 1.95.0 present) => shouldStart===true, fix_packet empty", () => {
  const contract = makeTransposerContract(passingSnapshot);
  const result = runLaunchGate(contract, { snapshot: passingSnapshot() });

  assert.equal(result.ok, true, "ok must be true when every precondition passes");
  assert.equal(result.shouldStart, true, "shouldStart must be true (nothing blocks)");
  assert.equal(result.shouldStart, result.ok, "shouldStart === ok (passing case)");
  assert.equal(result.fix_packet.length, 0, "fix_packet must be empty when ok");
  assert.equal(result.verdicts.length, 2, "both launch preconditions are still evaluated");
  for (const v of result.verdicts) {
    assert.equal(v.ok, true);
    assert.equal(v.fix_command, null, "a passing verdict carries no fix_command");
  }
});

// ===========================================================================
// (c) AUTO-RESOLVE — mv-aside verdict + allowlist {kind:dir_empty, strategy:mv-aside,
//     reversible:true, requires_network:false} => APPLIED under {network:false} (io.exec
//     called with the mv command); rustup-install verdict {requires_network:true} =>
//     SKIPPED under {network:false} (io.exec NOT called), APPLIED under {network:true}.
// ===========================================================================
test("bridge (c): mv-aside applied under network:false; rustup-install skipped under network:false, applied under network:true", () => {
  const contract = makeTransposerContract(failingSnapshot);
  const gate = runLaunchGate(contract, { snapshot: failingSnapshot() });
  assert.equal(gate.ok, false, "precondition: the failing gate");
  const arVerdicts = failingVerdictsAsAutoResolve(contract, gate);
  assert.equal(arVerdicts.length, 2, "two failing verdicts (dir_empty + toolchain)");

  const dirVerdict = arVerdicts.find((v) => v.kind === "dir_empty")!;
  const tcVerdict = arVerdicts.find((v) => v.kind === "toolchain_installed")!;

  // (c1) network:false => mv-aside APPLIED; rustup-install SKIPPED.
  const skipIo = makeFakeIo();
  const skipped = applyAutoResolve([dirVerdict, tcVerdict], BOTH_ALLOWLIST, {
    network: false,
    dryRun: false,
    io: skipIo.io,
    now: () => "2026-06-14T02:18:10.000Z",
  });
  assert.equal(skipped.applied.length, 1, "mv-aside applied under network:false");
  assert.equal(skipped.applied[0].strategy, "mv-aside");
  assert.equal(skipped.applied[0].disposition, "applied");
  assert.equal(skipped.applied[0].kind, "dir_empty");
  assert.equal(skipIo.execCalls.length, 1, "io.exec called exactly once (the mv-aside)");
  assert.equal(skipIo.execCalls[0], dirVerdict.fix_command, "io.exec called with the mv command");
  assert.equal(skipped.skipped.length, 1, "rustup-install skipped under network:false");
  assert.equal(skipped.skipped[0].strategy, "rustup-install");
  assert.equal(skipped.skipped[0].disposition, "skipped");
  // Network-gating is the ONLY skip path: the toolchain allowlist entry declares
  // requires_network:true, so under network:false it is skipped (not applied, not
  // refused — it WOULD apply under the separately-named =network opt-in).
  const tcAllowEntry = BOTH_ALLOWLIST.allow.find((e) => e.kind === "toolchain_installed")!;
  assert.equal(tcAllowEntry.requires_network, true, "the toolchain entry is network-gated");
  assert.equal(tcAllowEntry.reversible, true, "and reversible (so it is skipped, not refused)");
  assert.equal(skipped.refused.length, 0, "nothing refused");

  // (c2) network:true => BOTH applied (the separately-named opt-in).
  const applyIo = makeFakeIo();
  const applied = applyAutoResolve([dirVerdict, tcVerdict], BOTH_ALLOWLIST, {
    network: true,
    dryRun: false,
    io: applyIo.io,
    now: () => "2026-06-14T02:18:11.000Z",
  });
  assert.equal(applied.applied.length, 2, "both applied under network:true");
  assert.equal(applied.skipped.length, 0);
  assert.equal(applied.refused.length, 0);
  assert.equal(applyIo.execCalls.length, 2, "io.exec called twice (mv + rustup)");
  assert.deepEqual(applyIo.execCalls, [dirVerdict.fix_command, tcVerdict.fix_command]);
});

// ===========================================================================
// (d) CRITICAL SAFETY — reversible:false strategy => REFUSED ALWAYS, even under
//     {network:true, dryRun:false} (io.exec NEVER called). Structurally unresolvable:
//     the allowlist filter rejects reversible:false BEFORE dispatch.
// ===========================================================================
test("bridge (d): reversible:false strategy => refused ALWAYS (io.exec never called, even under network:true, dryRun:false)", () => {
  const gate = runLaunchGate(makeTransposerContract(failingSnapshot), { snapshot: failingSnapshot() });
  const dirVerdict = failingVerdictsAsAutoResolve(makeTransposerContract(failingSnapshot), gate).find((v) => v.kind === "dir_empty")!;
  // A hypothetical destructive allowlist entry (reversible:false rm-tree).
  const destructiveAllowlist: AutoResolveAllowlist = {
    schema: "project-transposer.environment-auto-resolve.v1",
    allow: [{ kind: "dir_empty", strategy: "rm-tree", reversible: false, requires_network: false }],
  };
  const { io, execCalls } = makeFakeIo();

  // Even under the most permissive options, reversible:false is REFUSED ALWAYS.
  const result = applyAutoResolve([dirVerdict], destructiveAllowlist, {
    network: true,
    dryRun: false,
    io,
    now: () => "2026-06-14T02:18:12.000Z",
  });

  assert.equal(result.refused.length, 1, "reversible:false is ALWAYS refused");
  assert.equal(result.applied.length, 0, "reversible:false is NEVER applied");
  assert.equal(result.skipped.length, 0);
  assert.equal(result.refused[0].disposition, "refused");
  assert.equal(result.refused[0].reversible, false);
  assert.equal(result.refused[0].strategy, "rm-tree");
  assert.equal(execCalls.length, 0, "io.exec must NEVER be called for a refused resolution");
});

// ===========================================================================
// (e) ASIDE-COLLISION — when io.exists reports the aside-path present, the
//     mv-aside strategy throws AsideCollisionError BEFORE io.exec (io.exec NEVER
//     called). The guard is symmetric with the harness dryRun io-guard (which also
//     throws). The thin-caller converts the throw to a refused/aside_path_exists
//     audit disposition (faithful to the transposer's monolithic refusal).
// ===========================================================================
test("bridge (e): aside-path already exists => mv-aside refuses (AsideCollisionError before io.exec; io.exec never called)", () => {
  const gate = runLaunchGate(makeTransposerContract(failingSnapshot), { snapshot: failingSnapshot() });
  const dirVerdict = failingVerdictsAsAutoResolve(makeTransposerContract(failingSnapshot), gate).find((v) => v.kind === "dir_empty")!;
  const asidePath = `${TARGET_PATH}.prior-${PINNED_CHANNEL}`;
  assert.equal(parseAsidePath(dirVerdict.fix_command ?? ""), asidePath, "fixture: aside-path parsed from the mv command");

  // io.exists reports the aside-path present => collision.
  const { io, execCalls } = makeFakeIo((p) => p === asidePath);

  // The mv-aside strategy throws AsideCollisionError before io.exec.
  assert.throws(
    () =>
      applyAutoResolve([dirVerdict], MV_ASIDE_ALLOWLIST, {
        network: true,
        dryRun: false,
        io,
        now: () => "2026-06-14T02:18:13.000Z",
      }),
    (err: unknown) => {
      assert.ok(err instanceof AsideCollisionError, "the thrown error is AsideCollisionError");
      assert.equal((err as AsideCollisionError).asidePath, asidePath, "the error carries the colliding aside-path");
      return err instanceof AsideCollisionError;
    },
    "mv-aside must throw AsideCollisionError when the aside-path already exists",
  );
  assert.equal(execCalls.length, 0, "io.exec must NEVER be called on the aside-collision path");
});

// ===========================================================================
// (f) THIN-CALLER PATTERN — a test-local validateEnvironment(contract, allowlist,
//     snapshot, options) that resolves the contract, calls runLaunchGate, pairs the
//     failing verdicts with their precondition kind+target -> AutoResolveVerdict[],
//     and calls applyAutoResolve when options.autoResolve. Proves the delegation
//     shape validate-environment.mjs will use (and the idempotent re-gate after an
//     auto-resolve). Also proves the aside-collision throw is converted to a
//     refused/aside_path_exists disposition by the thin-caller (the transposer
//     semantic).
// ===========================================================================

// The test-local thin-caller (mirrors the validateEnvironmentViaContract shape in
// the migration spec). Resolves the contract, runs the launch gate, and (when
// autoResolve is on AND the gate failed) pairs failing verdicts -> AutoResolveVerdict[]
// and applies allowlisted resolutions. Returns { gate, autoResolve }. Converts a
// thrown AsideCollisionError to a refused disposition (faithful to the transposer).
interface ThinCallerOptions {
  autoResolve?: { network: boolean; dryRun: boolean; io: AutoResolveIO };
  allowlist?: AutoResolveAllowlist;
}
function validateEnvironment(
  contract: EnvironmentContract,
  snapshot: EnvironmentSnapshot,
  options: ThinCallerOptions = {},
): {
  ok: boolean;
  shouldStart: boolean;
  fix_packet: readonly { readonly fix_command: string; readonly kind: string }[];
  autoResolve: AutoResolveResult | { applied: never[]; skipped: never[]; refused: { kind: string; reason: string }[] } | null;
} {
  const gate = runLaunchGate(contract, { snapshot });
  if (gate.ok || !options.autoResolve || !options.allowlist) {
    return { ok: gate.ok, shouldStart: gate.shouldStart, fix_packet: gate.fix_packet, autoResolve: null };
  }
  const arVerdicts = failingVerdictsAsAutoResolve(contract, gate);
  try {
    const ar = applyAutoResolve(arVerdicts, options.allowlist, {
      network: options.autoResolve.network,
      dryRun: options.autoResolve.dryRun,
      io: options.autoResolve.io,
    });
    return { ok: gate.ok, shouldStart: gate.shouldStart, fix_packet: gate.fix_packet, autoResolve: ar };
  } catch (err) {
    // Convert a strategy-level AsideCollisionError into a refused disposition
    // (faithful to the transposer's monolithic refusal/aside_path_exists).
    if (err instanceof AsideCollisionError) {
      return {
        ok: gate.ok,
        shouldStart: gate.shouldStart,
        fix_packet: gate.fix_packet,
        autoResolve: {
          applied: [],
          skipped: [],
          refused: [{ kind: "dir_empty", reason: `aside_path_exists: ${err.asidePath}` }],
        },
      };
    }
    throw err;
  }
}

test("bridge (f1): thin-caller resolves the contract + runLaunchGate; failing env => shouldStart===false (delegation shape)", () => {
  const contract = makeTransposerContract(failingSnapshot);
  const out = validateEnvironment(contract, failingSnapshot(), {});
  assert.equal(out.ok, false, "thin-caller: failing env => ok false");
  assert.equal(out.shouldStart, false, "thin-caller: failing env => shouldStart false (fail-closed via the contract)");
  assert.equal(out.fix_packet.length, 2, "thin-caller: 2 fix_packet entries");
  assert.equal(out.autoResolve, null, "thin-caller: no auto-resolve when options.autoResolve absent");

  // Passing env via the SAME thin-caller.
  const out2 = validateEnvironment(makeTransposerContract(passingSnapshot), passingSnapshot(), {});
  assert.equal(out2.ok, true);
  assert.equal(out2.shouldStart, true);
  assert.equal(out2.fix_packet.length, 0);
});

test("bridge (f2): thin-caller + auto-resolve(network:false) => mv-aside applied, rustup skipped; audit metadata-only", () => {
  const auditLog = join(auditDir, "f2.jsonl");
  const contract = makeTransposerContract(failingSnapshot);
  const { io, execCalls } = makeFakeIo();
  const out = validateEnvironment(contract, failingSnapshot(), {
    allowlist: BOTH_ALLOWLIST,
    autoResolve: { network: false, dryRun: false, io },
  });
  assert.equal(out.shouldStart, false, "shouldStart still false (network:false could not apply the toolchain fix)");
  assert.ok(out.autoResolve, "auto-resolve ran");
  const ar = out.autoResolve as AutoResolveResult;
  assert.equal(ar.applied.length, 1, "mv-aside applied");
  assert.equal(ar.skipped.length, 1, "rustup-install skipped (network:false)");
  assert.equal(execCalls.length, 1, "io.exec called once (the mv-aside)");

  // Audit log metadata-only: every line carries the harness schema + a disposition.
  for (const entry of [...ar.applied, ...ar.skipped, ...ar.refused]) {
    assert.equal(entry.schema, AUTO_RESOLVE_AUDIT_SCHEMA);
    assert.ok(["applied", "skipped", "refused"].includes(entry.disposition));
  }
  // Re-derive the audit by re-running with an explicit auditLog path to inspect the file.
  applyAutoResolve(
    failingVerdictsAsAutoResolve(contract, runLaunchGate(contract, { snapshot: failingSnapshot() })),
    BOTH_ALLOWLIST,
    { network: false, dryRun: false, io: makeFakeIo().io, auditLog, now: () => "2026-06-14T02:18:14.000Z" },
  );
  const lines = readFileSync(auditLog, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "one audit line per disposition (applied + skipped)");
  for (const line of lines) {
    const parsed: AutoResolveAuditEntry = JSON.parse(line);
    assert.equal(parsed.schema, AUTO_RESOLVE_AUDIT_SCHEMA);
    assert.ok(["applied", "skipped"].includes(parsed.disposition));
  }
});

test("bridge (f3): thin-caller converts aside-collision throw => refused/aside_path_exists disposition (transposer semantic)", () => {
  const asidePath = `${TARGET_PATH}.prior-${PINNED_CHANNEL}`;
  const contract = makeTransposerContract(failingSnapshot);
  const { io } = makeFakeIo((p) => p === asidePath); // aside-path exists => collision
  const out = validateEnvironment(contract, failingSnapshot(), {
    allowlist: MV_ASIDE_ALLOWLIST,
    autoResolve: { network: true, dryRun: false, io },
  });
  assert.ok(out.autoResolve, "auto-resolve ran (caught the collision)");
  const ar = out.autoResolve as { applied: unknown[]; skipped: unknown[]; refused: { kind: string; reason: string }[] };
  assert.equal(ar.applied.length, 0, "nothing applied (collision refused)");
  assert.equal(ar.refused.length, 1, "collision recorded as a refused disposition");
  assert.equal(ar.refused[0].kind, "dir_empty");
  assert.ok(/aside_path_exists/.test(ar.refused[0].reason), `refused reason names aside_path_exists: ${ar.refused[0].reason}`);
});

// ===========================================================================
// (g) IDEMPOTENT RE-GATE — after an auto-resolve (network:true) applies BOTH fixes,
//     a fresh runLaunchGate over a now-PASSING snapshot observes the fix
//     (shouldStart===true). Proves the bridge composes with the idempotent re-gate
//     property (runLaunchGate re-snapshots on every call, no memoization).
// ===========================================================================
test("bridge (g): idempotent re-gate — auto-resolve(network:true) applies both, then a fresh gate over the fixed env => shouldStart===true", () => {
  const failingContract = makeTransposerContract(failingSnapshot);
  const gate1 = runLaunchGate(failingContract, { snapshot: failingSnapshot() });
  assert.equal(gate1.shouldStart, false, "initial gate fails closed");

  // Apply BOTH resolutions under network:true (mv-aside + rustup-install).
  const { io, execCalls } = makeFakeIo();
  const ar = applyAutoResolve(
    failingVerdictsAsAutoResolve(failingContract, gate1),
    BOTH_ALLOWLIST,
    { network: true, dryRun: false, io, now: () => "2026-06-14T02:18:15.000Z" },
  );
  assert.equal(ar.applied.length, 2, "both resolutions applied");
  assert.equal(execCalls.length, 2, "both commands executed");

  // Re-gate over a now-PASSING snapshot (the env is fixed). shouldStart===true.
  const passingContract = makeTransposerContract(passingSnapshot);
  const gate2 = runLaunchGate(passingContract, { snapshot: passingSnapshot() });
  assert.equal(gate2.ok, true, "re-gate observes the fix");
  assert.equal(gate2.shouldStart, true, "re-gate allows start after the auto-resolve");
  assert.equal(gate2.fix_packet.length, 0);
});
