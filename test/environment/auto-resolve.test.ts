// WS-PH3 (environment-precondition PART II — SAFETY-CRITICAL slice): the auto-resolve
// framework `applyAutoResolve`. Proves ALL FOUR safety invariants (reversible:false
// refused ALWAYS; requires_network gated behind options.network===true;
// missing-strategy refused; no-allowlist-match refused), the dry-run-first property
// (after_state===null + io.exec NOT invoked), the project-registered strategy
// dispatch (the harness never hardcodes a command), the metadata-only audit log
// (environmentBodyFreeViolations holds), and the apply/skip/refuse branches.
// Read+test only: a fresh mv-aside + rustup-install strategy are invented HERE
// (project-registered via registerResolutionStrategy, mirroring how WS-PH4 will
// register them); NO transposer validate-environment.mjs body is copied.

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  AUTO_RESOLVE_AUDIT_SCHEMA,
  applyAutoResolve,
  environmentBodyFreeViolations,
  registerResolutionStrategy,
  type AutoResolveAllowlist,
  type AutoResolveAuditEntry,
  type AutoResolveIO,
  type AutoResolveVerdict,
  type PreconditionVerdict,
} from "../../.pi/extensions/zob-harness/index.ts";

// --- deterministic verdicts (the ONLY input applyAutoResolve reads) ----------
// Reproduce the live failing pair: a non-empty target (dir_empty) + a missing
// pinned toolchain (toolchain_installed, networked). Metadata-only — paths,
// counts, channel names, command strings; no bodies.
function dirEmptyVerdict(target: string, entryCount: number): AutoResolveVerdict {
  const base: PreconditionVerdict = {
    ok: false,
    observed: `${entryCount} entries`,
    expected: "0 entries",
    fix_command: `mv "${target}" "${target}.prior-1.87.0"`,
    auto_resolvable: true,
    requires_network: false,
  };
  return { ...base, kind: "dir_empty", target };
}

function toolchainVerdict(channel: string, installed: string[]): AutoResolveVerdict {
  const base: PreconditionVerdict = {
    ok: false,
    observed: `installed ${installed.join(", ")}`,
    expected: `${channel} + rustfmt,clippy`,
    fix_command: `rustup toolchain install ${channel} --component rustfmt,clippy`,
    auto_resolvable: true,
    requires_network: true,
  };
  return { ...base, kind: "toolchain_installed", target: channel };
}

// --- a deterministic fake IO (records the commands it would run) -------------
// The harness NEVER spawns directly: it dispatches via the injected io.exec seam.
// The fake increments execCalls[] so a test can assert "io.exec was NOT called".
function makeFakeIo(existingAside = false): { io: AutoResolveIO; execCalls: string[] } {
  const execCalls: string[] = [];
  const io: AutoResolveIO = {
    exec: (cmd: string) => {
      execCalls.push(cmd);
      return { stdout: "", status: 0 };
    },
    exists: () => existingAside,
  };
  return { io, execCalls };
}

// --- project-registered strategies (mirrors how WS-PH4 will register them) ---
// The harness NEVER hardcodes a shell command; the app registers mv-aside +
// rustup-install under their strategy names. These are invented HERE for the test;
// they respect ctx.dryRun (return after_state:null, do NOT call io.exec) so the
// dry-run-first property is observable. Real before/after state summaries
// (metadata-only: counts / channel lists — never file bodies).

// mv-aside: move the existing tree aside (reversible). before_state = entry count;
// after_state (non-dry-run) = entry count 0 + the aside path. NOTE: the strategy
// computes the command from the verdict's fix_command (operator-provided); the
// harness does not synthesize it.
function mvAsideStrategy(
  verdict: PreconditionVerdict,
  ctx: { io: AutoResolveIO; dryRun: boolean },
) {
  const command = verdict.fix_command ?? "";
  // before_state: parse the observed "N entries" into a count (metadata-only).
  const match = /(\d+) entries/.exec(verdict.observed);
  const entryCount = match ? Number(match[1]) : 0;
  if (ctx.dryRun) {
    return { command, before_state: { entry_count: entryCount }, after_state: null };
  }
  // Real exec: run the move-aside via the injected io.exec seam.
  ctx.io.exec(command);
  return {
    command,
    before_state: { entry_count: entryCount },
    after_state: { entry_count: 0, aside_path: `${command.split(" ").pop()}` },
  };
}

// rustup-install: install the pinned toolchain (reversible via rustup uninstall;
// add-only, never a default change). before_state = installed channels; after_state
// (non-dry-run) = installed channels + the newly added channel.
function rustupInstallStrategy(
  verdict: PreconditionVerdict,
  ctx: { io: AutoResolveIO; dryRun: boolean },
) {
  const command = verdict.fix_command ?? "";
  const installedMatch = /installed (.*)/.exec(verdict.observed);
  const installed = installedMatch ? installedMatch[1].split(", ") : [];
  if (ctx.dryRun) {
    return { command, before_state: { installed }, after_state: null };
  }
  ctx.io.exec(command);
  const channel = verdict.expected.split(" +")[0];
  return {
    command,
    before_state: { installed },
    after_state: { installed: [...installed, channel] },
  };
}

// Register once for the whole file (the registry is module-global, mirroring the
// WS-PH1 EnvironmentContract registry). before/after bracket so re-runs are clean.
before(() => {
  registerResolutionStrategy("mv-aside", mvAsideStrategy);
  registerResolutionStrategy("rustup-install", rustupInstallStrategy);
});

// --- a tmp audit-log dir per test (auto-cleaned) ----------------------------
let auditDir: string;
before(() => {
  auditDir = mkdtempSync(join(tmpdir(), "zob-auto-resolve-"));
});
after(() => {
  try {
    rmSync(auditDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// --- allowlists (metadata-only) ---------------------------------------------
const DIR_EMPTY_ALLOWLIST: AutoResolveAllowlist = {
  schema: "toy.environment-auto-resolve.v1",
  allow: [{ kind: "dir_empty", strategy: "mv-aside", reversible: true, requires_network: false }],
};

const BOTH_ALLOWLIST: AutoResolveAllowlist = {
  schema: "toy.environment-auto-resolve.v1",
  allow: [
    { kind: "dir_empty", strategy: "mv-aside", reversible: true, requires_network: false },
    { kind: "toolchain_installed", strategy: "rustup-install", reversible: true, requires_network: true },
  ],
};

// ===========================================================================
// (a) APPLY (non-dry-run, non-network): a dir_empty verdict + mv-aside strategy
//     {reversible:true, requires_network:false}; applyAutoResolve(...,
//     {network:false, dryRun:false}) => APPLIED; io.exec called with the mv
//     command; audit entry written with before_state/after_state populated.
// ===========================================================================
test("auto-resolve (a): dir_empty + mv-aside (reversible, non-network) => applied; io.exec called; audit before/after populated", () => {
  const verdict = dirEmptyVerdict("/Users/cgarrot/out_zob/pi-rs", 3089);
  const { io, execCalls } = makeFakeIo();
  const auditLog = join(auditDir, "a.jsonl");

  const result = applyAutoResolve([verdict], DIR_EMPTY_ALLOWLIST, {
    network: false,
    dryRun: false,
    io,
    auditLog,
    now: () => "2026-06-14T00:00:00.000Z",
  });

  assert.equal(result.applied.length, 1, "exactly one applied");
  assert.equal(result.skipped.length, 0, "nothing skipped");
  assert.equal(result.refused.length, 0, "nothing refused");

  const entry = result.applied[0];
  assert.equal(entry.disposition, "applied");
  assert.equal(entry.kind, "dir_empty");
  assert.equal(entry.strategy, "mv-aside");
  assert.equal(entry.reversible, true);
  assert.equal(entry.schema, AUTO_RESOLVE_AUDIT_SCHEMA);
  assert.equal(entry.at, "2026-06-14T00:00:00.000Z");

  // before_state / after_state populated (non-dry-run): the live 3089-entry tree.
  assert.deepEqual(entry.before_state, { entry_count: 3089 });
  assert.ok(entry.after_state !== null, "after_state must be populated under non-dry-run");
  assert.deepEqual((entry.after_state as { entry_count: number }).entry_count, 0);

  // io.exec called with the exact mv command (the operator-provided fix_command).
  assert.equal(execCalls.length, 1, "io.exec must be called exactly once under non-dry-run");
  assert.equal(execCalls[0], verdict.fix_command);

  // Audit log written: one line, metadata-only.
  const log = readFileSync(auditLog, "utf8").trim().split("\n");
  assert.equal(log.length, 1, "one audit line per disposition");
  const parsed: AutoResolveAuditEntry = JSON.parse(log[0]);
  assert.equal(parsed.disposition, "applied");
  assert.equal(parsed.kind, "dir_empty");
  assert.deepEqual(parsed.before_state, { entry_count: 3089 });
});

// ===========================================================================
// (b) NETWORK GATING: a toolchain_installed verdict (network) + rustup-install
//     {reversible:true, requires_network:true}. Under {network:false} => SKIPPED
//     (io.exec NOT called); under {network:true} => APPLIED (io.exec called).
// ===========================================================================
test("auto-resolve (b): requires_network gated — skipped under network:false, applied under network:true", () => {
  const verdict = toolchainVerdict("1.95.0", ["1.94.0", "1.87.0"]);

  // (b1) network:false => SKIPPED. No flag silently applies a networked resolution.
  const skipIo = makeFakeIo();
  const skipped = applyAutoResolve([verdict], BOTH_ALLOWLIST, {
    network: false,
    dryRun: false,
    io: skipIo.io,
    now: () => "2026-06-14T00:00:01.000Z",
  });
  assert.equal(skipped.skipped.length, 1, "networked resolution is skipped under network:false");
  assert.equal(skipped.applied.length, 0, "nothing applied under network:false");
  assert.equal(skipped.refused.length, 0, "skipped is NOT refused (it would apply under =network)");
  assert.equal(skipped.skipped[0].disposition, "skipped");
  assert.equal(skipped.skipped[0].kind, "toolchain_installed");
  assert.equal(skipIo.execCalls.length, 0, "io.exec must NOT be called for a skipped resolution");

  // (b2) network:true => APPLIED. The separately-named opt-in enables networked.
  const applyIo = makeFakeIo();
  const applied = applyAutoResolve([verdict], BOTH_ALLOWLIST, {
    network: true,
    dryRun: false,
    io: applyIo.io,
    now: () => "2026-06-14T00:00:02.000Z",
  });
  assert.equal(applied.applied.length, 1, "networked resolution is applied under network:true");
  assert.equal(applied.skipped.length, 0);
  assert.equal(applied.applied[0].disposition, "applied");
  assert.equal(applyIo.execCalls.length, 1, "io.exec IS called for an applied networked resolution");
  assert.equal(applyIo.execCalls[0], verdict.fix_command);
});

// ===========================================================================
// (c) CRITICAL SAFETY — reversible:false => REFUSED ALWAYS, under ANY options.
//     A hypothetical reversible:false entry in the allowlist is refused even
//     under network:true + non-dry-run; io.exec is NEVER called. Structurally
//     unresolvable: the filter rejects reversible:false BEFORE dispatch.
// ===========================================================================
test("auto-resolve (c): reversible:false => refused ALWAYS (io.exec never called, even under network:true)", () => {
  const verdict = dirEmptyVerdict("/Users/cgarrot/out_zob/pi-rs", 3089);
  const destructiveAllowlist: AutoResolveAllowlist = {
    schema: "toy.environment-auto-resolve.v1",
    allow: [
      { kind: "dir_empty", strategy: "rm-tree", reversible: false, requires_network: false },
    ],
  };
  const { io, execCalls } = makeFakeIo();

  // Even under the most permissive options, reversible:false is refused.
  const result = applyAutoResolve([verdict], destructiveAllowlist, {
    network: true,
    dryRun: false,
    io,
    now: () => "2026-06-14T00:00:03.000Z",
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
// (d) DRY-RUN-FIRST: dryRun:true => disposition 'applied' (it WOULD apply) BUT
//     after_state===null AND io.exec NOT called. Records intent without executing.
// ===========================================================================
test("auto-resolve (d): dryRun => applied disposition, after_state===null, io.exec NOT called", () => {
  const verdict = dirEmptyVerdict("/Users/cgarrot/out_zob/pi-rs", 3089);
  const { io, execCalls } = makeFakeIo();

  const result = applyAutoResolve([verdict], DIR_EMPTY_ALLOWLIST, {
    network: false,
    dryRun: true,
    io,
    now: () => "2026-06-14T00:00:04.000Z",
  });

  assert.equal(result.applied.length, 1, "dry-run records disposition 'applied' (it WOULD apply)");
  assert.equal(result.skipped.length, 0);
  assert.equal(result.refused.length, 0);

  const entry = result.applied[0];
  assert.equal(entry.disposition, "applied");
  assert.equal(entry.after_state, null, "after_state must be null under dryRun (nothing executed)");
  // before_state is still populated (the strategy computes it without exec).
  assert.deepEqual(entry.before_state, { entry_count: 3089 });
  assert.equal(execCalls.length, 0, "io.exec must NOT be called under dryRun");

  // Defense-in-depth: even a strategy that ignored ctx.dryRun could not exec —
  // the harness wraps io with a guard that throws. Register a BAD strategy that
  // tries to exec under dryRun and confirm it throws (io still not called).
  registerResolutionStrategy("bad-dry-run", (v, ctx) => {
    ctx.io.exec(v.fix_command ?? "boom"); // ignored ctx.dryRun — must throw
    return { command: v.fix_command ?? "", before_state: {}, after_state: null };
  });
  const badAllowlist: AutoResolveAllowlist = {
    schema: "toy.environment-auto-resolve.v1",
    allow: [{ kind: "dir_empty", strategy: "bad-dry-run", reversible: true, requires_network: false }],
  };
  assert.throws(
    () =>
      applyAutoResolve([verdict], badAllowlist, {
        network: false,
        dryRun: true,
        io,
        now: () => "2026-06-14T00:00:04.000Z",
      }),
    /must not be invoked under dryRun/,
    "the dry-run io guard must throw when a buggy strategy ignores ctx.dryRun",
  );
  assert.equal(execCalls.length, 0, "the guard prevented the real io.exec from firing under dryRun");
});

// ===========================================================================
// (e) MISSING STRATEGY: an allowlist entry references a strategy that was never
//     registerResolutionStrategy'd => refused (fail-safe). The harness never
//     hardcodes a command; a missing strategy is NOT silently skipped.
// ===========================================================================
test("auto-resolve (e): allowlist references an unregistered strategy => refused (fail-safe)", () => {
  const verdict = dirEmptyVerdict("/Users/cgarrot/out_zob/pi-rs", 3089);
  const missingStrategyAllowlist: AutoResolveAllowlist = {
    schema: "toy.environment-auto-resolve.v1",
    allow: [
      { kind: "dir_empty", strategy: "never-registered", reversible: true, requires_network: false },
    ],
  };
  const { io, execCalls } = makeFakeIo();

  const result = applyAutoResolve([verdict], missingStrategyAllowlist, {
    network: false,
    dryRun: false,
    io,
    now: () => "2026-06-14T00:00:05.000Z",
  });

  assert.equal(result.refused.length, 1, "a missing strategy is refused (fail-safe)");
  assert.equal(result.applied.length, 0);
  assert.equal(result.refused[0].disposition, "refused");
  assert.equal(result.refused[0].strategy, "never-registered");
  assert.equal(execCalls.length, 0, "io.exec not called for a missing strategy");
});

// ===========================================================================
// (f) NO-ALLOWLIST-MATCH: a verdict whose kind has NO entry in allowlist.allow =>
//     refused. The harness invents NO resolution for an unmatched kind.
// ===========================================================================
test("auto-resolve (f): verdict kind absent from allowlist => refused (nothing ad-hoc invented)", () => {
  // command_present verdict, but the allowlist only knows dir_empty + toolchain.
  const verdict: AutoResolveVerdict = {
    ok: false,
    observed: "not on PATH",
    expected: "on PATH",
    fix_command: "apt-get install -y some-tool",
    auto_resolvable: true,
    requires_network: false,
    kind: "command_present",
    target: "some-tool",
  };
  const { io, execCalls } = makeFakeIo();

  const result = applyAutoResolve([verdict], BOTH_ALLOWLIST, {
    network: true,
    dryRun: false,
    io,
    now: () => "2026-06-14T00:00:06.000Z",
  });

  assert.equal(result.refused.length, 1, "an unmatched kind is refused");
  assert.equal(result.applied.length, 0);
  assert.equal(result.refused[0].disposition, "refused");
  assert.equal(result.refused[0].kind, "command_present");
  assert.equal(result.refused[0].strategy, "(no-allowlist-match)");
  assert.equal(execCalls.length, 0, "io.exec not called for an unmatched kind");
});

// ===========================================================================
// (g) METADATA-ONLY AUDIT: the audit log entries pass environmentBodyFreeViolations
//     (no forbidden keys: body/task/prompt/output/content/message/text/rationale/
//     diff/patch). Verified by reading the log back + scanning each line.
// ===========================================================================
test("auto-resolve (g): audit log is metadata-only (environmentBodyFreeViolations holds on every entry)", () => {
  const dirVerdict = dirEmptyVerdict("/Users/cgarrot/out_zob/pi-rs", 3089);
  const tcVerdict = toolchainVerdict("1.95.0", ["1.94.0", "1.87.0"]);
  const auditLog = join(auditDir, "g.jsonl");
  const { io } = makeFakeIo();

  // Drive a mixed run: dir_empty applied + toolchain skipped (network:false).
  applyAutoResolve([dirVerdict, tcVerdict], BOTH_ALLOWLIST, {
    network: false,
    dryRun: false,
    io,
    auditLog,
    now: () => "2026-06-14T00:00:07.000Z",
  });

  const lines = readFileSync(auditLog, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "one audit line per disposition (applied + skipped)");

  for (const line of lines) {
    const parsed = JSON.parse(line);
    // (g1) schema is the harness-defined audit-log schema.
    assert.equal(parsed.schema, AUTO_RESOLVE_AUDIT_SCHEMA);
    // (g2) body-free enforcement: NO forbidden plaintext key anywhere.
    const violations = environmentBodyFreeViolations(parsed);
    assert.deepEqual(
      violations,
      [],
      `audit entry must be metadata-only (no forbidden keys); got: ${violations.join(", ")}`,
    );
    // (g3) disposition is one of the three documented values.
    assert.ok(
      ["applied", "skipped", "refused"].includes(parsed.disposition),
      `unexpected disposition: ${parsed.disposition}`,
    );
    // (g4) no raw file body / secret-ish payload sneaks in: command is a string,
    //      before/after are STATE SUMMARIES (plain metadata objects or null).
    assert.equal(typeof parsed.command, "string");
    assert.equal(typeof parsed.kind, "string");
    assert.equal(typeof parsed.target, "string");
  }

  // The first line is the applied mv-aside; the second is the skipped toolchain.
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.equal(first.disposition, "applied");
  assert.equal(first.kind, "dir_empty");
  assert.equal(second.disposition, "skipped");
  assert.equal(second.kind, "toolchain_installed");
  assert.equal(second.after_state, null, "skipped entries carry null after_state");
});

// ===========================================================================
// (h) COMPOSITION + ordering: a multi-verdict run partitions cleanly into
//     applied/skipped/refused and the iteration order is preserved in the log.
//     Proves the framework composes the three dispositions in one pass.
// ===========================================================================
test("auto-resolve (h): multi-verdict run partitions into applied/skipped/refused in iteration order", () => {
  const auditLog = join(auditDir, "h.jsonl");
  const { io, execCalls } = makeFakeIo();

  // Three verdicts: dir_empty (applied), toolchain (skipped under network:false),
  // command_present (refused — no allowlist entry).
  const verdicts = [
    dirEmptyVerdict("/tmp/target-a", 5),
    toolchainVerdict("1.95.0", ["1.94.0"]),
    {
      ok: false,
      observed: "not on PATH",
      expected: "on PATH",
      fix_command: "install-some-tool",
      auto_resolvable: false,
      requires_network: false,
      kind: "command_present" as const,
      target: "some-tool",
    } as AutoResolveVerdict,
  ];

  const result = applyAutoResolve(verdicts, BOTH_ALLOWLIST, {
    network: false,
    dryRun: false,
    io,
    auditLog,
    now: () => "2026-06-14T00:00:08.000Z",
  });

  assert.equal(result.applied.length, 1, "dir_empty applied");
  assert.equal(result.skipped.length, 1, "toolchain skipped (network:false)");
  assert.equal(result.refused.length, 1, "command_present refused (no allowlist entry)");
  assert.equal(execCalls.length, 1, "exactly one exec (the applied mv-aside)");

  // Iteration order preserved in the audit log: applied, skipped, refused.
  const lines = readFileSync(auditLog, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).disposition, "applied");
  assert.equal(JSON.parse(lines[1]).disposition, "skipped");
  assert.equal(JSON.parse(lines[2]).disposition, "refused");
});
