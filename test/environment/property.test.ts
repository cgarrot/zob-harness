// WS-PH DoD (environment-precondition PART II — the harness reusability proof):
// a harness-level PROPERTY test proving the fail-closed-before-agents-start
// invariant holds for ANY EnvironmentContract implementor, over a SECOND toy
// consumer (data-pipeline) whose DOMAIN is distinct from the WS-PH1/PH2/PH3 toy
// (dir_empty + toolchain_installed for the Rust pi-rs target) and from the
// transposer. Read+test only — NO source files are modified; the toy is invented
// here and registered via the PUBLIC API (registerEnvironmentContract +
// registerResolutionStrategy). NO transposer FSM is copied.
//
// Three invariants (the plan's D.4, over a SEEDED deterministic input space):
//   PROPERTY 1 — FAIL-CLOSED-BEFORE-START (headline): for any single failing
//     precondition, runLaunchGate().shouldStart === false regardless of how many
//     others pass. This is the EXACT class the live bug violated (environmental
//     preconditions discovered ~2h into a run = effectively no launch gate).
//   PROPERTY 2 — FIX-PACKET COMPLETENESS: fix_packet contains EXACTLY the failing
//     preconditions, each with a non-empty fix_command; every passing precondition
//     is absent.
//   PROPERTY 3 — AUTO-RESOLVE SAFETY: network:false never applies a
//     requires_network:true resolution (skipped); network:true applies them; a
//     reversible:false strategy is REFUSED ALWAYS (even under network:true +
//     dryRun:false); dryRun => after_state===null AND io.exec NOT called.
//
// DETERMINISM: the input space is generated from a fixed mulberry32 seed (no
// unconstrained Math.random). The case table is identical every run.

import { strict as assert } from "node:assert";
import { before, test } from "node:test";

import {
  applyAutoResolve,
  commandPresent,
  dirEmpty,
  listEnvironmentContractIds,
  pathWritable,
  registerEnvironmentContract,
  registerResolutionStrategy,
  resolveEnvironmentContract,
  runLaunchGate,
  type AutoResolveAllowlist,
  type AutoResolveIO,
  type AutoResolveVerdict,
  type EnvironmentContract,
  type EnvironmentSnapshot,
  type FixPacketEntry,
  type LaunchGateResult,
  type Precondition,
} from "../../.pi/extensions/zob-harness/index.ts";

// ============================================================================
// SECOND TOY CONSUMER — data-pipeline (DISTINCT domain from WS-PH1/PH2/PH3 toy)
// ============================================================================
// The WS-PH1/PH2/PH3 toy modeled the transposer live bug: dir_empty on a Rust
// target tree (/Users/cgarrot/out_zob/pi-rs) + toolchain_installed on a pinned
// Rust channel (1.95.0). This SECOND toy models a DATA PIPELINE launch: a staging
// dir that must be empty, a DB client that must be on PATH, and a secrets dir
// that must be writable. The DOMAIN/context is data-pipeline, NOT Rust phases;
// the targets are /var/data-pipeline/* and `psql`, NOT pi-rs / 1.95.0. It reuses
// the GENERIC harness kinds (dir_empty / command_present / path_writable are the
// pure building blocks every consumer composes) but composes them for a different
// purpose — proving the contract is genuinely reusable.

const DATA_PIPELINE_ID = "data-pipeline";

const DATA_PIPELINE_PRECONDITIONS: readonly Precondition[] = [
  {
    id: "staging-empty",
    kind: "dir_empty",
    target: "/var/data-pipeline/staging",
    scope: { ignore: [".DS_Store", "tmp"] },
    check_phase: "launch",
    remediation: "move stale extracts aside (reversible)",
    fix_command: "mv /var/data-pipeline/staging /var/data-pipeline/staging.prior",
    auto_resolvable: true,
    requires_network: false,
    note: "staging must be empty before a fresh extract run",
  },
  {
    id: "db-client-present",
    kind: "command_present",
    target: "psql",
    check_phase: "launch",
    remediation: "install the postgres client package",
    fix_command: "apt-get install -y postgresql-client",
    auto_resolvable: true,
    requires_network: true,
  },
  {
    id: "secrets-writable",
    kind: "path_writable",
    target: "/etc/data-pipeline/secrets.d",
    check_phase: "launch",
    remediation: "fix permissions on the secrets dir",
    fix_command: "chmod 0700 /etc/data-pipeline/secrets.d",
    auto_resolvable: true,
    requires_network: false,
  },
];

const PRECONDITION_IDS = DATA_PIPELINE_PRECONDITIONS.map((p) => p.id);

// --- deterministic fake snapshot (the ONLY IO the primitives read) -----------
// Built from a "fail set": a precondition fails iff its id is in the set. No real
// disk / PATH / rustup. Deterministic by construction.
function makeSnapshot(failingIds: ReadonlySet<string>): EnvironmentSnapshot {
  return {
    dirEntries: () =>
      failingIds.has("staging-empty")
        ? ["stale-extract-1.csv", "stale-extract-2.csv", "stale-extract-3.csv"]
        : [],
    installedToolchains: () => [],
    toolchainComponents: () => [],
    commandOnPath: (name) => (name === "psql" ? !failingIds.has("db-client-present") : true),
    writable: (path) =>
      path === "/etc/data-pipeline/secrets.d" ? !failingIds.has("secrets-writable") : true,
  };
}

// --- the data-pipeline EnvironmentContract (registered via the public API) ---
// evaluatePrecondition dispatches to the PURE harness primitives and maps each
// result into a PreconditionVerdict. This is the SAME shape every consumer
// implements; only the precondition SET + snapshot reader differ.
const dataPipelineContract: EnvironmentContract = {
  evaluatePrecondition(p: Precondition, env: EnvironmentSnapshot) {
    let base: { readonly ok: boolean; readonly observed: string; readonly expected: string };
    switch (p.kind) {
      case "dir_empty":
        base = dirEmpty(p.target, p.scope, env);
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
    // Default: all-pass. Tests inject a snapshot to control which preconditions fail.
    return makeSnapshot(new Set());
  },
  preconditions(checkPhase) {
    return checkPhase === "launch" ? DATA_PIPELINE_PRECONDITIONS : [];
  },
};
registerEnvironmentContract(DATA_PIPELINE_ID, dataPipelineContract);

// ============================================================================
// SEEDED DETERMINISTIC INPUT SPACE (no Math.random flakiness)
// ============================================================================
// mulberry32: a tiny deterministic PRNG. Fixed seed => identical case table every
// run, so the property test exercises a GENERATED input space without flakiness.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PropertyCase {
  readonly name: string;
  readonly failingIds: ReadonlySet<string>;
}

// The case table: all-pass, all-fail, one-fail-among-many-pass (rotated, the
// headline), plus 8 seeded randomized subsets. Each case is a (preconditions,
// snapshot) pair the properties are asserted over.
function buildPropertyCases(): PropertyCase[] {
  const cases: PropertyCase[] = [];
  cases.push({ name: "all-pass", failingIds: new Set<string>() });
  cases.push({ name: "all-fail", failingIds: new Set<string>(PRECONDITION_IDS) });
  for (const id of PRECONDITION_IDS) {
    cases.push({ name: `only-${id}-fails`, failingIds: new Set<string>([id]) });
  }
  const rng = mulberry32(0xc0ffee);
  for (let i = 0; i < 8; i += 1) {
    const subset = new Set<string>();
    for (const id of PRECONDITION_IDS) {
      if (rng() < 0.5) subset.add(id);
    }
    cases.push({ name: `seeded-subset-${i}`, failingIds: subset });
  }
  return cases;
}

const PROPERTY_CASES = buildPropertyCases();

// ============================================================================
// GENERICNESS — the data-pipeline consumer is registered under its OWN reducerId
// and is DISTINCT from transposer (not transposer-coupled).
// ============================================================================
test("genericness: the SECOND toy consumer is registered via the public API and is distinct from transposer", () => {
  // Registered under its own reducerId via the public registry.
  const resolved = resolveEnvironmentContract(DATA_PIPELINE_ID);
  assert.ok(resolved, `data-pipeline contract must be registered under its own reducerId`);
  assert.equal(resolved, dataPipelineContract);

  const ids = listEnvironmentContractIds();
  assert.ok(ids.includes(DATA_PIPELINE_ID), "data-pipeline must appear in the registry list");

  // Distinct from transposer's reducer_id + targets. The data-pipeline targets
  // are data-pipeline paths + a DB client, NOT the transposer's Rust target tree
  // or pinned Rust channel.
  const targets = DATA_PIPELINE_PRECONDITIONS.map((p) => p.target);
  const transposerTargets = ["/Users/cgarrot/out_zob/pi-rs", "1.95.0"];
  for (const t of transposerTargets) {
    assert.ok(
      !targets.includes(t),
      `data-pipeline must NOT reuse transposer target ${t} (distinct domain)`,
    );
  }

  // The contract is usable through the public runLaunchGate (no snapshot injected
  // => the contract's own snapshotEnvironment is called once, all-pass default).
  const result = runLaunchGate(dataPipelineContract);
  assert.equal(result.ok, true);
  assert.equal(result.shouldStart, true);
});

// ============================================================================
// PROPERTY 1 — FAIL-CLOSED-BEFORE-START (the headline invariant)
// ============================================================================
test("PROPERTY 1 — FAIL-CLOSED-BEFORE-START: any single failing precondition => shouldStart===false regardless of how many others pass", () => {
  // (1) Over the full seeded case table: shouldStart === (no precondition fails).
  for (const c of PROPERTY_CASES) {
    const snapshot = makeSnapshot(c.failingIds);
    const result = runLaunchGate(dataPipelineContract, { snapshot });
    const failingCount = PRECONDITION_IDS.filter((id) => c.failingIds.has(id)).length;
    const expectedOk = failingCount === 0;

    assert.equal(
      result.ok,
      expectedOk,
      `[${c.name}] ok must be ${expectedOk} when ${failingCount} precondition(s) fail`,
    );
    // FAIL-CLOSED BY CONSTRUCTION: shouldStart === ok always; no opt-out.
    assert.equal(
      result.shouldStart,
      result.ok,
      `[${c.name}] shouldStart must equal ok (fail-closed by construction, no opt-out)`,
    );
    assert.equal(
      result.shouldStart,
      expectedOk,
      `[${c.name}] shouldStart must be ${expectedOk}`,
    );
  }

  // (2) HEADLINE — one-fail-among-many-pass: for EVERY single-failure case,
  //     shouldStart===false even though ALL the other preconditions pass. This is
  //     the exact class the live bug violated: a precondition discovered late =
  //     effectively no launch gate = start happened with a failing environment.
  for (const id of PRECONDITION_IDS) {
    const snapshot = makeSnapshot(new Set([id]));
    const result = runLaunchGate(dataPipelineContract, { snapshot });
    const othersPassing = PRECONDITION_IDS.length - 1;
    assert.equal(
      result.shouldStart,
      false,
      `one failing precondition (${id}) among ${othersPassing} passing MUST block start (fail-closed-before-start)`,
    );
    // The other preconditions indeed pass (only the named one fails).
    assert.equal(result.fix_packet.length, 1, `exactly one failure for ${id}`);
    assert.equal(result.fix_packet[0].target, DATA_PIPELINE_PRECONDITIONS.find((p) => p.id === id)!.target);
  }

  // (3) Determinism: the same (contract, snapshot) yields the same verdict twice.
  const c = PROPERTY_CASES[PROPERTY_CASES.length - 1];
  const snap = makeSnapshot(c.failingIds);
  const first = runLaunchGate(dataPipelineContract, { snapshot: snap });
  const second = runLaunchGate(dataPipelineContract, { snapshot: makeSnapshot(c.failingIds) });
  assert.equal(first.ok, second.ok);
  assert.equal(first.shouldStart, second.shouldStart);
  assert.equal(first.fix_packet.length, second.fix_packet.length);
});

// ============================================================================
// PROPERTY 2 — FIX-PACKET COMPLETENESS
// ============================================================================
test("PROPERTY 2 — FIX-PACKET COMPLETENESS: fix_packet has exactly the failing preconditions, each with a non-empty fix_command; passing absent", () => {
  for (const c of PROPERTY_CASES) {
    const snapshot = makeSnapshot(c.failingIds);
    const result = runLaunchGate(dataPipelineContract, { snapshot });

    const failingPreconditions = DATA_PIPELINE_PRECONDITIONS.filter((p) =>
      c.failingIds.has(p.id),
    );
    const passingPreconditions = DATA_PIPELINE_PRECONDITIONS.filter(
      (p) => !c.failingIds.has(p.id),
    );

    // (2a) Exactly one entry per failing precondition (fix_packet is in
    //      precondition order, so the i-th entry maps to the i-th failing one).
    assert.equal(
      result.fix_packet.length,
      failingPreconditions.length,
      `[${c.name}] one fix_packet entry per failing precondition`,
    );
    for (let i = 0; i < failingPreconditions.length; i += 1) {
      const p = failingPreconditions[i];
      const entry: FixPacketEntry = result.fix_packet[i];
      assert.equal(entry.kind, p.kind, `[${c.name}] entry ${i} kind matches precondition`);
      assert.equal(entry.target, p.target, `[${c.name}] entry ${i} target matches precondition`);
      // (2b) NON-EMPTY fix_command on every failing entry.
      assert.ok(
        typeof entry.fix_command === "string" && entry.fix_command.length > 0,
        `[${c.name}] entry ${i} (kind=${entry.kind} target=${entry.target}) must have a NON-EMPTY fix_command`,
      );
    }

    // (2c) Passing preconditions are ABSENT from fix_packet (by target; all
    //      targets are distinct strings here).
    const failingTargets = new Set(failingPreconditions.map((p) => p.target));
    const passingTargets = new Set(passingPreconditions.map((p) => p.target));
    for (const entry of result.fix_packet) {
      assert.ok(
        failingTargets.has(entry.target),
        `[${c.name}] fix_packet target ${entry.target} must be a FAILING precondition`,
      );
      assert.ok(
        !passingTargets.has(entry.target),
        `[${c.name}] a PASSING precondition target (${entry.target}) must NOT appear in fix_packet`,
      );
    }

    // (2d) When all pass, fix_packet is empty (and ok===true).
    if (passingPreconditions.length === DATA_PIPELINE_PRECONDITIONS.length) {
      assert.equal(result.fix_packet.length, 0, `[${c.name}] fix_packet empty when all pass`);
      assert.equal(result.ok, true);
    }
  }
});

// ============================================================================
// PROPERTY 3 — AUTO-RESOLVE SAFETY (helpers + setup)
// ============================================================================
// Pair each failing verdict from runLaunchGate with its precondition's kind +
// target (the shape applyAutoResolve consumes). verdicts[i] maps to
// DATA_PIPELINE_PRECONDITIONS[i] (runLaunchGate preserves precondition order).
function dataPipelineFailingVerdicts(result: LaunchGateResult): AutoResolveVerdict[] {
  const out: AutoResolveVerdict[] = [];
  for (let i = 0; i < DATA_PIPELINE_PRECONDITIONS.length; i += 1) {
    const p = DATA_PIPELINE_PRECONDITIONS[i];
    const v = result.verdicts[i];
    if (!v.ok) {
      out.push({ ...v, kind: p.kind, target: p.target });
    }
  }
  return out;
}

// A deterministic fake IO: records every command io.exec would run so a test can
// assert "io.exec was NOT called". The harness NEVER spawns directly; it
// dispatches through this injected seam.
function makeFakeIo(): { io: AutoResolveIO; execCalls: string[] } {
  const execCalls: string[] = [];
  const io: AutoResolveIO = {
    exec: (cmd: string) => {
      execCalls.push(cmd);
      return { stdout: "", status: 0 };
    },
    exists: () => false,
  };
  return { io, execCalls };
}

// Project-registered strategies for the data-pipeline domain (mirrors how an app
// registers them via registerResolutionStrategy). Each respects ctx.dryRun
// (after_state:null, no io.exec) so the dry-run-first property is observable.
// The harness NEVER hardcodes a shell command; it dispatches to these.
function clearStagingStrategy(
  verdict: AutoResolveVerdict,
  ctx: { io: AutoResolveIO; dryRun: boolean },
) {
  const command = verdict.fix_command ?? "";
  const match = /(\d+) entries/.exec(verdict.observed);
  const entryCount = match ? Number(match[1]) : 0;
  if (ctx.dryRun) {
    return { command, before_state: { entry_count: entryCount }, after_state: null };
  }
  ctx.io.exec(command);
  return {
    command,
    before_state: { entry_count: entryCount },
    after_state: { entry_count: 0 },
  };
}

function installPsqlStrategy(
  verdict: AutoResolveVerdict,
  ctx: { io: AutoResolveIO; dryRun: boolean },
) {
  const command = verdict.fix_command ?? "";
  if (ctx.dryRun) {
    return { command, before_state: { psql_on_path: false }, after_state: null };
  }
  ctx.io.exec(command);
  return { command, before_state: { psql_on_path: false }, after_state: { psql_on_path: true } };
}

function chmodSecretsStrategy(
  verdict: AutoResolveVerdict,
  ctx: { io: AutoResolveIO; dryRun: boolean },
) {
  const command = verdict.fix_command ?? "";
  if (ctx.dryRun) {
    return { command, before_state: { writable: false }, after_state: null };
  }
  ctx.io.exec(command);
  return { command, before_state: { writable: false }, after_state: { writable: true } };
}

before(() => {
  // Registered ONCE for the whole file (the strategy registry is module-global).
  // Distinct names from the WS-PH3 test's mv-aside / rustup-install.
  registerResolutionStrategy("data-clear-staging", clearStagingStrategy);
  registerResolutionStrategy("data-install-psql", installPsqlStrategy);
  registerResolutionStrategy("data-chmod-secrets", chmodSecretsStrategy);
});

const DATA_PIPELINE_ALLOWLIST: AutoResolveAllowlist = {
  schema: "data-pipeline.environment-auto-resolve.v1",
  allow: [
    { kind: "dir_empty", strategy: "data-clear-staging", reversible: true, requires_network: false },
    { kind: "command_present", strategy: "data-install-psql", reversible: true, requires_network: true },
    { kind: "path_writable", strategy: "data-chmod-secrets", reversible: true, requires_network: false },
  ],
};

// --- PROPERTY 3 (network gating) -------------------------------------------
test("PROPERTY 3 (network gating): network:false NEVER applies a requires_network:true resolution (skipped); network:true applies it", () => {
  // Only db-client-present fails: a command_present, requires_network:true resolution.
  const result = runLaunchGate(dataPipelineContract, {
    snapshot: makeSnapshot(new Set(["db-client-present"])),
  });
  assert.equal(result.shouldStart, false, "the failing snapshot blocks start");
  const verdicts = dataPipelineFailingVerdicts(result);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].kind, "command_present");

  // (a) network:false => SKIPPED. No flag silently applies a networked resolution.
  const skipIo = makeFakeIo();
  const skipped = applyAutoResolve(verdicts, DATA_PIPELINE_ALLOWLIST, {
    network: false,
    dryRun: false,
    io: skipIo.io,
    now: () => "2026-06-14T00:00:00.000Z",
  });
  assert.equal(skipped.applied.length, 0, "networked resolution is NOT applied under network:false");
  assert.equal(skipped.skipped.length, 1, "networked resolution is SKIPPED under network:false");
  assert.equal(skipped.refused.length, 0, "skipped is not refused (it would apply under network:true)");
  assert.equal(
    skipIo.execCalls.length,
    0,
    "io.exec must NOT be called for a skipped networked resolution",
  );

  // (b) network:true => APPLIED. The separately-named opt-in enables it.
  const applyIo = makeFakeIo();
  const applied = applyAutoResolve(verdicts, DATA_PIPELINE_ALLOWLIST, {
    network: true,
    dryRun: false,
    io: applyIo.io,
    now: () => "2026-06-14T00:00:01.000Z",
  });
  assert.equal(applied.applied.length, 1, "networked resolution is applied under network:true");
  assert.equal(applied.skipped.length, 0);
  assert.equal(
    applyIo.execCalls.length,
    1,
    "io.exec IS called for an applied networked resolution",
  );
  assert.equal(applyIo.execCalls[0], verdicts[0].fix_command);
});

// --- PROPERTY 3 (reversible:false refused ALWAYS — the safety core) ---------
test("PROPERTY 3 (reversible:false refused ALWAYS): no flag auto-applies an irreversible resolution, even under network:true + dryRun:false", () => {
  // A staging failure (dir_empty) plus a DESTRUCTIVE allowlist variant that marks
  // the dir_empty resolution reversible:false (e.g. "rm -rf the staging tree").
  const result = runLaunchGate(dataPipelineContract, {
    snapshot: makeSnapshot(new Set(["staging-empty"])),
  });
  const verdicts = dataPipelineFailingVerdicts(result);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].kind, "dir_empty");

  const destructiveAllowlist: AutoResolveAllowlist = {
    schema: "data-pipeline.environment-auto-resolve.v1",
    allow: [
      { kind: "dir_empty", strategy: "data-nuke-staging", reversible: false, requires_network: false },
    ],
  };

  // CRITICAL — even under the MOST permissive options (network:true, dryRun:false),
  // a reversible:false strategy is REFUSED and io.exec is NEVER called. No flag
  // value auto-applies it; the filter rejects reversible:false BEFORE dispatch.
  const { io, execCalls } = makeFakeIo();
  const refused = applyAutoResolve(verdicts, destructiveAllowlist, {
    network: true,
    dryRun: false,
    io,
    now: () => "2026-06-14T00:00:02.000Z",
  });
  assert.equal(refused.refused.length, 1, "reversible:false is ALWAYS refused");
  assert.equal(refused.applied.length, 0, "reversible:false is NEVER applied");
  assert.equal(refused.skipped.length, 0);
  assert.equal(refused.refused[0].disposition, "refused");
  assert.equal(refused.refused[0].reversible, false);
  assert.equal(refused.refused[0].strategy, "data-nuke-staging");
  assert.equal(
    execCalls.length,
    0,
    "io.exec must NEVER be called for a reversible:false resolution",
  );
});

// --- PROPERTY 3 (dry-run-first) ---------------------------------------------
test("PROPERTY 3 (dry-run-first): dryRun => applied disposition with after_state===null AND io.exec NOT called", () => {
  // A staging failure (dir_empty, reversible, non-network) — eligible to apply.
  const result = runLaunchGate(dataPipelineContract, {
    snapshot: makeSnapshot(new Set(["staging-empty"])),
  });
  const verdicts = dataPipelineFailingVerdicts(result);

  const { io, execCalls } = makeFakeIo();
  const dry = applyAutoResolve(verdicts, DATA_PIPELINE_ALLOWLIST, {
    network: false,
    dryRun: true,
    io,
    now: () => "2026-06-14T00:00:03.000Z",
  });
  assert.equal(dry.applied.length, 1, "dry-run records disposition 'applied' (it WOULD apply)");
  assert.equal(dry.skipped.length, 0);
  assert.equal(dry.refused.length, 0);
  assert.equal(
    dry.applied[0].after_state,
    null,
    "after_state must be null under dryRun (nothing executed)",
  );
  // before_state is still populated (the strategy computes it without exec).
  assert.deepEqual(dry.applied[0].before_state, { entry_count: 3 });
  assert.equal(execCalls.length, 0, "io.exec must NOT be called under dryRun");
});

// --- PROPERTY 3 (composition: applied/skipped/refused partition cleanly) ----
test("PROPERTY 3 (composition): a multi-failure data-pipeline run partitions into applied/skipped/refused in iteration order", () => {
  // staging-empty (dir_empty, applied), db-client-present (command_present,
  // networked -> skipped under network:false), secrets-writable (path_writable,
  // applied) — three failing preconditions across three kinds.
  const result = runLaunchGate(dataPipelineContract, {
    snapshot: makeSnapshot(new Set(["staging-empty", "db-client-present", "secrets-writable"])),
  });
  assert.equal(result.shouldStart, false, "any failure blocks start");
  assert.equal(result.fix_packet.length, 3, "one fix_packet entry per failing precondition");
  const verdicts = dataPipelineFailingVerdicts(result);
  assert.equal(verdicts.length, 3);

  const { io, execCalls } = makeFakeIo();
  const out = applyAutoResolve(verdicts, DATA_PIPELINE_ALLOWLIST, {
    network: false,
    dryRun: false,
    io,
    now: () => "2026-06-14T00:00:04.000Z",
  });
  // staging-empty + secrets-writable applied (non-network); db-client skipped.
  assert.equal(out.applied.length, 2, "two non-network resolutions applied");
  assert.equal(out.skipped.length, 1, "one networked resolution skipped under network:false");
  assert.equal(out.refused.length, 0);
  assert.equal(
    execCalls.length,
    2,
    "io.exec called once per applied resolution (the two non-network fixes)",
  );
  // Iteration order preserved: applied entries are dir_empty + path_writable.
  assert.equal(out.applied[0].kind, "dir_empty");
  assert.equal(out.applied[1].kind, "path_writable");
  assert.equal(out.skipped[0].kind, "command_present");
});
