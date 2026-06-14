// WS-PH1 (environment-precondition PART II keystone): the typed EnvironmentContract
// in domains/environment. This proves the contract shapes, the registry (mirrors the
// EvidenceContract registry EXACTLY), the body-free enforcement, the typed-missing
// resolve contract, and the PURITY of the primitives over a fake snapshot (no real
// disk/rustup/PATH). Read+test only: no harness source is modified by this test
// beyond registering a toy contract; the toy contract is invented here (distinct
// reducerId='toy-env'), and NO transposer validate-environment.mjs body is copied
// (the transposer body does not exist yet — PART I is not shipped).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  commandPresent,
  dirEmpty,
  environmentBodyFreeViolations,
  listEnvironmentContractIds,
  pathWritable,
  registerEnvironmentContract,
  resolveEnvironmentContract,
  toolchainInstalled,
  type EnvironmentContract,
  type EnvironmentSnapshot,
  type Precondition,
} from "../../.pi/extensions/zob-harness/index.ts";

// --- the live bug, as structured preconditions (metadata-only) ---------------
// The exact two preconditions that stalled the live run: a non-empty target tree
// (3089 stale entries) + a missing pinned Rust 1.95.0. These carry paths, counts,
// channel names, command strings only — no bodies, no secrets.
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

// --- a toy EnvironmentContract (reducerId='toy-env') -------------------------
// Its evaluatePrecondition dispatches to the pure primitives (dirEmpty /
// toolchainInstalled / commandPresent / pathWritable) and maps the result into a
// PreconditionVerdict. It is NOT the transposer validate-environment.mjs body; it
// only proves the contract + registry + primitives shapes compose.
const TOY_ENV_ID = "toy-env";

const toyContract: EnvironmentContract = {
  evaluatePrecondition(p: Precondition, env: EnvironmentSnapshot) {
    let base: { readonly ok: boolean; readonly observed: string; readonly expected: string };
    switch (p.kind) {
      case "dir_empty":
        base = dirEmpty(p.target, p.scope, env);
        break;
      case "toolchain_installed":
        base = toolchainInstalled(p.target, undefined, env);
        break;
      case "command_present":
        base = commandPresent(p.target, env);
        break;
      case "path_writable":
        base = pathWritable(p.target, env);
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
    // Toy snapshot; the real reader is project-registered (WS-PH4).
    return {
      dirEntries: () => [],
      installedToolchains: () => [],
      toolchainComponents: () => [],
      commandOnPath: () => false,
      writable: () => true,
    };
  },
  preconditions(checkPhase) {
    return checkPhase === "launch"
      ? [TARGET_EMPTY_PRECONDITION, TOOLCHAIN_PRECONDITION]
      : [];
  },
};
registerEnvironmentContract(TOY_ENV_ID, toyContract);

// --- fake snapshots (the ONLY IO the primitives read) ------------------------
// Reproduce the live failing environment: 3089 stale entries + missing 1.95.0
// (installed: 1.94.0, 1.87.0). These are deterministic in-memory fakes — no disk.
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

// ===========================================================================
// (a) Failing precondition via fake snapshot: verdict ok===false + observed/
//     expected populated (the exact live bug: 3089 entries + missing 1.95.0).
// ===========================================================================
test("environment-contract (a): failing snapshot yields ok===false with populated observed/expected (the live bug)", () => {
  const contract = resolveEnvironmentContract(TOY_ENV_ID)!;
  const snapshot = failingSnapshot();

  // dir_empty on the 3089-entry tree -> fail.
  const dirVerdict = contract.evaluatePrecondition(TARGET_EMPTY_PRECONDITION, snapshot);
  assert.equal(dirVerdict.ok, false);
  assert.equal(dirVerdict.observed, "3089 entries");
  assert.equal(dirVerdict.expected, "0 entries");
  assert.equal(dirVerdict.fix_command, TARGET_EMPTY_PRECONDITION.fix_command);
  assert.equal(dirVerdict.auto_resolvable, true);
  assert.equal(dirVerdict.requires_network, false);

  // toolchain_installed on missing 1.95.0 -> fail.
  const tcVerdict = contract.evaluatePrecondition(TOOLCHAIN_PRECONDITION, snapshot);
  assert.equal(tcVerdict.ok, false);
  assert.ok(tcVerdict.observed.includes("1.94.0"), `observed should list installed channels: ${tcVerdict.observed}`);
  assert.ok(!tcVerdict.observed.includes("1.95.0"), "observed must not list the missing pinned channel");
  assert.ok(tcVerdict.expected.includes("1.95.0"), "expected must name the pinned channel");
  assert.equal(tcVerdict.requires_network, true);
});

// ===========================================================================
// (b) Passing snapshot: verdict ok===true + fix_command null.
// ===========================================================================
test("environment-contract (b): passing snapshot yields ok===true and a null fix_command", () => {
  const contract = resolveEnvironmentContract(TOY_ENV_ID)!;
  const snapshot = passingSnapshot();

  const dirVerdict = contract.evaluatePrecondition(TARGET_EMPTY_PRECONDITION, snapshot);
  assert.equal(dirVerdict.ok, true);
  assert.equal(dirVerdict.observed, "0 entries");
  assert.equal(dirVerdict.fix_command, null);

  const tcVerdict = contract.evaluatePrecondition(TOOLCHAIN_PRECONDITION, snapshot);
  assert.equal(tcVerdict.ok, true);
  assert.equal(tcVerdict.fix_command, null);
});

// ===========================================================================
// (c) Typed-missing resolve: unknown reducerId -> undefined (NOT a silent default;
//     NOT a throw — the WS-PH1 plan signature is EnvironmentContract | undefined).
// ===========================================================================
test("environment-contract (c): resolveEnvironmentContract('unknown') === undefined (typed-missing)", () => {
  assert.equal(resolveEnvironmentContract("does-not-exist"), undefined);
  // Registering a contract missing evaluatePrecondition is a typed runtime error.
  assert.throws(
    () =>
      // @ts-expect-error -- intentionally invalid contract shape for the runtime guard
      registerEnvironmentContract("broken-env", {
        snapshotEnvironment() {
          return {};
        },
        preconditions() {
          return [];
        },
      }),
    /missing evaluatePrecondition/,
  );
});

// ===========================================================================
// (d) Registry list includes the toy contract.
// ===========================================================================
test("environment-contract (d): listEnvironmentContractIds() includes the toy contract", () => {
  const ids = listEnvironmentContractIds();
  assert.ok(ids.includes(TOY_ENV_ID), "toy-env contract must be registered");
});

// ===========================================================================
// (e) environmentBodyFreeViolations: the body-free posture is enforced on every
//     Precondition / PreconditionVerdict. A forbidden key (prompt/body/task/
//     output/content/message/text/rationale/diff/patch) at ANY depth is rejected;
//     a clean Precondition passes (returns []).
// ===========================================================================
test("environment-contract (e): environmentBodyFreeViolations rejects forbidden keys and accepts clean preconditions", () => {
  // Clean Precondition -> no violations.
  assert.deepEqual(environmentBodyFreeViolations(TARGET_EMPTY_PRECONDITION), []);

  // Forbidden key at the top level -> rejected.
  const topForbidden = { ...TARGET_EMPTY_PRECONDITION, prompt: "do the thing" };
  assert.ok(environmentBodyFreeViolations(topForbidden).length > 0);

  // Forbidden key nested inside a verdict -> rejected (deep scan).
  const verdictForbidden = {
    ok: false,
    observed: "3089 entries",
    expected: "0 entries",
    fix_command: null,
    auto_resolvable: true,
    requires_network: false,
    output: "leaked prose",
  };
  const verdictViolations = environmentBodyFreeViolations(verdictForbidden);
  assert.ok(verdictViolations.length > 0, "a forbidden key nested in a verdict must be rejected");
  assert.ok(
    verdictViolations.some((v) => v.includes("output")),
    `violation path should name the forbidden key: ${verdictViolations.join(", ")}`,
  );
});

// ===========================================================================
// (f) Purity proof: the primitives are deterministic over the fake snapshot and
//     do NOT touch the real filesystem. They read ONLY the EnvironmentSnapshot.
//     (Structural purity is also proven by grep: primitives.ts has no node:fs /
//     node:child_process / spawnSync / readdirSync.)
// ===========================================================================
test("environment-contract (f): primitives are pure over the snapshot (deterministic, no disk IO)", () => {
  const snapshot = failingSnapshot();

  // dirEmpty reflects the FAKE snapshot (3089 entries), NOT the real filesystem at
  // an arbitrary path. The real disk does not have exactly 3089 entries here, so a
  // matching count proves the primitive reads only the snapshot.
  const de = dirEmpty("/this/path/does/not/matter/to/the/fake", TARGET_EMPTY_PRECONDITION.scope, snapshot);
  assert.equal(de.ok, false);
  assert.equal(de.entryCount, 3089);
  assert.equal(de.observed, "3089 entries");

  // scope.ignore is applied: a fake snapshot reporting only ignored names -> empty.
  const onlyIgnored: EnvironmentSnapshot = {
    dirEntries: () => [".DS_Store", ".DS_Store"],
    installedToolchains: () => ["1.95.0"],
    toolchainComponents: () => ["rustfmt", "clippy"],
    commandOnPath: () => true,
    writable: () => true,
  };
  const deIgnored = dirEmpty("/x", { ignore: [".DS_Store"] }, onlyIgnored);
  assert.equal(deIgnored.ok, true);
  assert.equal(deIgnored.entryCount, 0);

  // toolchainInstalled reflects the FAKE installed list + default components.
  const tc = toolchainInstalled("1.95.0", undefined, snapshot);
  assert.equal(tc.ok, false);
  assert.deepEqual([...tc.installed], ["1.94.0", "1.87.0"]);
  assert.equal(tc.expected, "1.95.0 + rustfmt,clippy");

  // commandPresent reflects the FAKE PATH.
  assert.equal(commandPresent("cargo", snapshot).ok, true);
  assert.equal(commandPresent("rustc", snapshot).ok, false);

  // pathWritable reflects the FAKE writable bit.
  assert.equal(pathWritable("/anywhere", snapshot).ok, true);
  const roSnapshot: EnvironmentSnapshot = {
    dirEntries: () => [],
    installedToolchains: () => [],
    toolchainComponents: () => [],
    commandOnPath: () => false,
    writable: () => false,
  };
  assert.equal(pathWritable("/anywhere", roSnapshot).ok, false);
});
