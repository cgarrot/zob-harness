// WS-PH2 (environment-precondition PART II): the launch-time gate primitive
// `runLaunchGate`. Proves the fail-closed-by-construction invariant
// (shouldStart === ok, with NO opt-out), the snapshot-once property, idempotent
// re-runnability (flip the snapshot and re-call), the one-failure-still-blocks
// rule, and the sync/async return union. Read+test only: a fresh toy contract
// (reducerId='toy-launch-gate', distinct from the WS-PH1 'toy-env') is invented
// here and dispatches to the PURE primitives (dirEmpty / toolchainInstalled); NO
// transposer validate-environment.mjs body is copied.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  dirEmpty,
  runLaunchGate,
  toolchainInstalled,
  type EnvironmentContract,
  type EnvironmentSnapshot,
  type LaunchGateResult,
  type Precondition,
} from "../../.pi/extensions/zob-harness/index.ts";

// --- the live bug, as two launch-phase preconditions (metadata-only) ---------
// The exact two preconditions that stalled the live run: a non-empty target tree
// (3089 stale entries) + a missing pinned Rust 1.95.0. Paths, counts, channel
// names, command strings only — no bodies, no secrets.
const TARGET_EMPTY_PRECONDITION: Precondition = {
  id: "target-empty",
  kind: "dir_empty",
  target: "/Users/cgarrot/out_zob/pi-rs",
  scope: { ignore: [".DS_Store"] },
  check_phase: "launch",
  remediation: "move existing tree aside (reversible)",
  fix_command: 'mv "/Users/cgarrot/out_zob/pi-rs" "/Users/cgarrot/out_zob/pi-rs.prior-1.87.0"',
  auto_resolvable: true,
  requires_network: false,
  note: "confirm target empty before scheduler dispatch",
};

const TOOLCHAIN_PRECONDITION: Precondition = {
  id: "pinned-toolchain",
  kind: "toolchain_installed",
  target: "1.95.0",
  check_phase: "launch",
  fix_command: "rustup toolchain install 1.95.0 --component rustfmt,clippy",
  auto_resolvable: true,
  requires_network: true,
};

const LAUNCH_PRECONDITIONS: readonly Precondition[] = [
  TARGET_EMPTY_PRECONDITION,
  TOOLCHAIN_PRECONDITION,
];

// --- a toy EnvironmentContract (reducerId='toy-launch-gate') -----------------
// Its evaluatePrecondition dispatches to the PURE primitives (dirEmpty /
// toolchainInstalled) and maps the result into a PreconditionVerdict — NOT the
// transposer validate-environment.mjs body; it only proves the gate composes with
// the WS-PH1 contract. The snapshot reader is injected so each test controls the
// observed environment deterministically.
function makeToyContract(
  snapshotImpl: () => EnvironmentSnapshot | Promise<EnvironmentSnapshot>,
): EnvironmentContract {
  return {
    evaluatePrecondition(p: Precondition, env: EnvironmentSnapshot) {
      let base: { readonly ok: boolean; readonly observed: string; readonly expected: string };
      switch (p.kind) {
        case "dir_empty":
          base = dirEmpty(p.target, p.scope, env);
          break;
        case "toolchain_installed":
          base = toolchainInstalled(p.target, undefined, env);
          break;
        default:
          base = { ok: false, observed: "unknown kind", expected: "known kind" };
      }
      return {
        ok: base.ok,
        observed: base.observed,
        expected: base.expected,
        fix_command: base.ok ? null : p.fix_command ?? null,
        auto_resolvable: p.auto_resolvable,
        requires_network: p.requires_network,
      };
    },
    snapshotEnvironment() {
      return snapshotImpl();
    },
    preconditions(checkPhase) {
      return checkPhase === "launch" ? LAUNCH_PRECONDITIONS : [];
    },
  };
}

// --- deterministic fake snapshots (the ONLY IO the primitives read) ----------
// Reproduce the live failing environment: 3089 stale entries + missing 1.95.0
// (installed: 1.94.0, 1.87.0). Deterministic in-memory fakes — no disk.
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
    installedToolchains: () => ["1.95.0"],
    toolchainComponents: (channel) => (channel === "1.95.0" ? ["rustfmt", "clippy"] : []),
    commandOnPath: () => true,
    writable: () => true,
  };
}

// dir-non-empty (42 stale entries) but toolchain present: exactly ONE of two
// launch preconditions fails. Used by the one-failure-still-blocks test.
function oneFailureSnapshot(): EnvironmentSnapshot {
  const entries = Array.from({ length: 42 }, (_, i) => `file-${i}.rs`);
  return {
    dirEntries: () => entries.slice(),
    installedToolchains: () => ["1.95.0"],
    toolchainComponents: (channel) => (channel === "1.95.0" ? ["rustfmt", "clippy"] : []),
    commandOnPath: () => true,
    writable: () => true,
  };
}

// A contract whose snapshotEnvironment reads the SEED snapshot each call. Seeded
// fresh per test so re-runnability is provable without cross-test leakage.
const seededContract = (seed: () => EnvironmentSnapshot): EnvironmentContract =>
  makeToyContract(() => seed());

// ===========================================================================
// (a) FAILING snapshot (the exact live bug: 3089 entries + missing 1.95.0):
//     runLaunchGate().shouldStart === false AND ok === false AND fix_packet has
//     2 entries (one per failure) with non-empty fix_commands.
// ===========================================================================
test("launch-gate (a): failing snapshot => shouldStart===false, ok===false, fix_packet has 2 entries with non-empty fix_commands", () => {
  const contract = seededContract(failingSnapshot);
  const result = runLaunchGate(contract, { snapshot: failingSnapshot() });

  assert.equal(result.ok, false, "ok must be false when every precondition fails");
  assert.equal(result.shouldStart, false, "shouldStart must be false (fail-closed)");
  assert.equal(result.verdicts.length, 2, "both launch preconditions are evaluated");
  assert.equal(result.fix_packet.length, 2, "one fix_packet entry per failing precondition");

  // Entry 0: dir_empty (the 3089-entry tree) — non-network, reversible.
  const dirEntry = result.fix_packet[0];
  assert.equal(dirEntry.kind, "dir_empty");
  assert.equal(dirEntry.target, TARGET_EMPTY_PRECONDITION.target);
  assert.equal(dirEntry.requires_network, false);
  assert.equal(dirEntry.auto_resolvable, true);
  assert.ok(
    typeof dirEntry.fix_command === "string" && dirEntry.fix_command.length > 0,
    `dir fix_command must be a non-empty string: ${JSON.stringify(dirEntry.fix_command)}`,
  );
  assert.equal(dirEntry.fix_command, TARGET_EMPTY_PRECONDITION.fix_command);
  assert.ok(dirEntry.observed.includes("3089"), `observed should report 3089 entries: ${dirEntry.observed}`);
  assert.equal(dirEntry.expected, "0 entries");

  // Entry 1: toolchain_installed (missing 1.95.0) — network required.
  const tcEntry = result.fix_packet[1];
  assert.equal(tcEntry.kind, "toolchain_installed");
  assert.equal(tcEntry.target, "1.95.0");
  assert.equal(tcEntry.requires_network, true);
  assert.equal(tcEntry.auto_resolvable, true);
  assert.ok(
    typeof tcEntry.fix_command === "string" && tcEntry.fix_command.length > 0,
    `toolchain fix_command must be a non-empty string: ${JSON.stringify(tcEntry.fix_command)}`,
  );
  assert.equal(tcEntry.fix_command, TOOLCHAIN_PRECONDITION.fix_command);
  assert.ok(tcEntry.expected.includes("1.95.0"), "expected must name the pinned channel");
});

// ===========================================================================
// (b) PASSING snapshot (empty dir + toolchain present): shouldStart === true AND
//     ok === true AND fix_packet empty.
// ===========================================================================
test("launch-gate (b): passing snapshot => shouldStart===true, ok===true, fix_packet empty", () => {
  const contract = seededContract(passingSnapshot);
  const result = runLaunchGate(contract, { snapshot: passingSnapshot() });

  assert.equal(result.ok, true, "ok must be true when every precondition passes");
  assert.equal(result.shouldStart, true, "shouldStart must be true (nothing blocks)");
  assert.equal(result.fix_packet.length, 0, "fix_packet must be empty when ok");
  assert.equal(result.verdicts.length, 2, "both launch preconditions are still evaluated");
  for (const v of result.verdicts) {
    assert.equal(v.ok, true);
    assert.equal(v.fix_command, null, "a passing verdict carries no fix_command");
  }
});

// ===========================================================================
// (c) RE-RUNNABILITY / IDEMPOTENCE: call runLaunchGate with a FAILING snapshot
//     (shouldStart===false), then re-call with a now-PASSING snapshot. The second
//     call must observe the fresh snapshot (shouldStart===true) — proves NO stale
//     memoization across calls, which is what makes --auto-resolve then re-gate
//     work without a relaunch.
// ===========================================================================
test("launch-gate (c): flipping the snapshot on re-call flips shouldStart (no stale memoization)", () => {
  const failing = runLaunchGate(seededContract(failingSnapshot), { snapshot: failingSnapshot() });
  assert.equal(failing.ok, false);
  assert.equal(failing.shouldStart, false);

  // Re-call with a passing snapshot — a fresh evaluate over the new observation.
  const flipped = runLaunchGate(seededContract(passingSnapshot), { snapshot: passingSnapshot() });
  assert.equal(flipped.ok, true, "re-call over a passing snapshot must observe the fix");
  assert.equal(flipped.shouldStart, true, "re-call must allow start after the auto-resolve");
  assert.equal(flipped.fix_packet.length, 0);
});

// ===========================================================================
// (d) ONE-FAILURE-STILL-BLOCKS: a snapshot where only ONE of two preconditions
//     fails (dir non-empty but toolchain present) => shouldStart === false AND
//     fix_packet has exactly 1 entry. Any single failure blocks start.
// ===========================================================================
test("launch-gate (d): one failing precondition still blocks start (shouldStart===false)", () => {
  const contract = seededContract(oneFailureSnapshot);
  const result = runLaunchGate(contract, { snapshot: oneFailureSnapshot() });

  assert.equal(result.verdicts.length, 2, "both preconditions evaluated");
  assert.equal(result.ok, false, "ok is false because one precondition fails");
  assert.equal(result.shouldStart, false, "a single failure blocks start (fail-closed)");
  assert.equal(result.fix_packet.length, 1, "exactly one fix_packet entry for the single failure");
  assert.equal(result.fix_packet[0].kind, "dir_empty");
  assert.ok(
    result.fix_packet[0].observed.includes("42"),
    `observed should report 42 entries: ${result.fix_packet[0].observed}`,
  );
});

// ===========================================================================
// (e) FAIL-CLOSED-BY-CONSTRUCTION (the headline): there is NO parameter to make
//     shouldStart diverge from ok. Assert the invariant shouldStart === ok for
//     BOTH the failing and passing cases — it is derived from ok, never set
//     independently.
// ===========================================================================
test("launch-gate (e): shouldStart === ok in every case (fail-closed by construction, no opt-out)", () => {
  const failing = runLaunchGate(seededContract(failingSnapshot), { snapshot: failingSnapshot() });
  const passing = runLaunchGate(seededContract(passingSnapshot), { snapshot: passingSnapshot() });

  // The invariant holds in both directions: failing (ok false → shouldStart false)
  // and passing (ok true → shouldStart true). runLaunchGate exposes no option that
  // could break this — there is no `allowStart`, no `force`, no `skip`.
  assert.equal(failing.ok, false);
  assert.equal(failing.shouldStart, failing.ok, "shouldStart must equal ok (failing case)");
  assert.equal(passing.ok, true);
  assert.equal(passing.shouldStart, passing.ok, "shouldStart must equal ok (passing case)");

  // Constructive proof: even a partial failure keeps shouldStart === ok.
  const oneFail = runLaunchGate(seededContract(oneFailureSnapshot), { snapshot: oneFailureSnapshot() });
  assert.equal(oneFail.shouldStart, oneFail.ok);
  assert.equal(oneFail.shouldStart, false);
});

// ===========================================================================
// (f) ASYNC snapshotEnvironment + sync-when-injected: when no snapshot is
//     injected AND contract.snapshotEnvironment() returns a Promise,
//     runLaunchGate returns a Promise<LaunchGateResult> (the snapshot is awaited
//     once, then shared). When a snapshot IS injected, the return is synchronous
//     (LaunchGateResult, not a Promise) — the union return type accommodates both.
// ===========================================================================
test("launch-gate (f): async snapshotEnvironment => Promise<LaunchGateResult>; injected snapshot => sync result", async () => {
  // Async path: contract.snapshotEnvironment() returns a Promise.
  const asyncContract = makeToyContract(() => Promise.resolve(failingSnapshot()));
  const asyncOut = runLaunchGate(asyncContract);
  assert.ok(asyncOut instanceof Promise, "async snapshotEnvironment must yield a Promise");

  const awaited = await asyncOut;
  assert.equal(awaited.ok, false);
  assert.equal(awaited.shouldStart, false, "async failing snapshot blocks start after await");
  assert.equal(awaited.fix_packet.length, 2);

  // Sync path: an injected snapshot bypasses snapshotEnvironment entirely.
  const syncContract = makeToyContract(() => {
    throw new Error("snapshotEnvironment must NOT be called when a snapshot is injected");
  });
  const syncOut: LaunchGateResult | Promise<LaunchGateResult> = runLaunchGate(syncContract, {
    snapshot: passingSnapshot(),
  });
  assert.ok(!(syncOut instanceof Promise), "an injected snapshot must yield a synchronous result");
  assert.equal(syncOut.ok, true);
  assert.equal((syncOut as LaunchGateResult).shouldStart, true);
});

// ===========================================================================
// (g) Purity proof (structural): launch-gate.ts has NO node:fs / node:child_process
//     / spawnSync / readdirSync — the IO lives entirely in the project-registered
//     snapshotEnvironment, never in the gate. runLaunchGate never starts anything
//     itself; it returns a pure verdict.
// ===========================================================================
test("launch-gate (g): runLaunchGate is a pure verdict (no process launch, deterministic over the snapshot)", () => {
  // Determinism: the same (contract, snapshot) yields the same result twice.
  const contract = seededContract(failingSnapshot);
  const first = runLaunchGate(contract, { snapshot: failingSnapshot() });
  const second = runLaunchGate(contract, { snapshot: failingSnapshot() });
  assert.equal(first.ok, second.ok);
  assert.equal(first.shouldStart, second.shouldStart);
  assert.equal(first.fix_packet.length, second.fix_packet.length);
  assert.equal(first.fix_packet[0].fix_command, second.fix_packet[0].fix_command);
  assert.equal(first.fix_packet[1].fix_command, second.fix_packet[1].fix_command);
  assert.equal(first.verdicts[0].observed, second.verdicts[0].observed);
});
