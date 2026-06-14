// ZOB Harness — Environment auto-resolve framework (WS-PH3 keystone,
// environment-precondition PART II — SAFETY-CRITICAL slice).
//
// The auto-resolve framework on top of the WS-PH1 EnvironmentContract + WS-PH2
// launch gate. applyAutoResolve(verdicts, allowlist, options) applies ONLY
// allowlisted + REVERSIBLE strategies; REFUSES reversible:false ALWAYS
// (structurally unresolvable — no flag value auto-applies it); SKIPS
// requires_network resolutions unless options.network===true (no flag silently
// applies networked resolutions); dispatches via a PROJECT-REGISTERED
// ResolutionStrategyFn (the harness NEVER hardcodes a shell command — mv-aside /
// rustup-install are app-registered in WS-PH4); REFUSES missing-strategy +
// no-allowlist-match (fail-safe); and is DRY-RUN-FIRST (dryRun =>
// after_state:null AND io.exec is not invoked — it records what it WOULD apply).
//
// INCAPABLE-BY-CONSTRUCTION (the headline safety property): there is NO code path
// in this file that performs an irreversible filesystem mutation, changes a
// default, rewrites config, or runs a reversible:false strategy. A destructive /
// irreversible action structurally CANNOT be expressed as a registered
// ResolutionStrategy that applyAutoResolve would call, because the allowlist
// filter REJECTS reversible:false BEFORE dispatch. The command execution happens
// via the INJECTED options.io.exec seam (the test supplies a fake; the app
// supplies a real process spawn in WS-PH4) — this file performs NO direct process
// spawn and calls NO spawn/exec helpers directly. The ONE allowed node:fs use is
// appendFileSync to the audit log (the audit log IS the intended IO). (The purity
// grep over this file for irreversible-op markers + direct-spawn helpers returns
// NOTHING.)
//
// Purity contract: imports ONLY src/core/** + sibling ./types.js +
// ./environment-contract.js (type-only for the verdict + body-free enforcement),
// plus node:fs for the audit-log writer. Metadata-only / body-free /
// network-disabled: audit entries carry paths, channel names, commands, and state
// SUMMARIES (counts, channel lists) — NEVER file bodies, NEVER secrets.
// environmentBodyFreeViolations is enforced on EVERY audit entry BEFORE write.
import { appendFileSync } from "node:fs";
import type { PreconditionKind, PreconditionVerdict } from "./types.js";
import { environmentBodyFreeViolations } from "./environment-contract.js";

// --- The audit-log schema (harness-defined) ---------------------------------
// The audit ENTRY shape is harness-defined; the audit log PATH is app-owned
// (WS-PH4 writes it to reports/run/<run>/supervisor/env-auto-resolve-<stamp>.jsonl).
// The ALLOWLIST schema NAME is app-owned too (WS-PH4's
// config/environment-auto-resolve.json carries the project-specific name); the
// harness validates STRUCTURE, not a hardcoded project name, so pacman / toy
// consumers can register their own allowlist schema. The audit-log entries always
// carry this harness-defined schema string (zob. prefix per worklist convention).
export const AUTO_RESOLVE_AUDIT_SCHEMA = "zob.environment-auto-resolve.v1";

// --- The allowlist entry ----------------------------------------------------
// One allowlisted resolution per precondition kind. `strategy` names a
// project-registered ResolutionStrategyFn (mv-aside / rustup-install / ...).
// `reversible` MUST be true for an entry to ever be auto-applied — a
// reversible:false entry is REFUSED ALWAYS (structurally unresolvable; the safety
// core). `requires_network` marks fixes needing egress (gated behind
// options.network===true).
export interface AutoResolveEntry {
  readonly kind: PreconditionKind;
  readonly strategy: string;
  readonly reversible: boolean;
  readonly requires_network: boolean;
}

// --- The allowlist ----------------------------------------------------------
// `schema` is a non-empty APP-OWNED string (the harness validates structurally;
// it does NOT hardcode the transposer's schema name — see
// AUTO_RESOLVE_AUDIT_SCHEMA for the harness-defined audit-log schema). `allow` is
// the curated set; anything not present is REFUSED structurally (no ad-hoc
// resolution is ever invented by the harness).
export interface AutoResolveAllowlist {
  readonly schema: string;
  readonly allow: readonly AutoResolveEntry[];
}

// --- The verdict auto-resolve consumes --------------------------------------
// AutoResolveVerdict extends the WS-PH1 PreconditionVerdict with `kind` + `target`
// so the framework can (1) match the verdict to an allowlist entry by kind and
// (2) record kind/target in the audit log. PreconditionVerdict (WS-PH1) carries
// ok/observed/expected/fix_command/auto_resolvable/requires_network but NOT kind —
// the app pairs each failing verdict with its precondition's kind+target before
// passing to applyAutoResolve (it has the precondition array alongside the
// verdicts from runLaunchGate). This is an ADDITIVE type in THIS file: WS-PH1
// types.ts is NOT modified. An AutoResolveVerdict IS-A PreconditionVerdict
// (structural subtyping), so ResolutionStrategyFn (which takes PreconditionVerdict)
// accepts it unchanged.
export interface AutoResolveVerdict extends PreconditionVerdict {
  /** The precondition kind; matches AutoResolveEntry.kind for allowlist lookup. */
  readonly kind: PreconditionKind;
  /** The precondition target (path / channel / command); recorded in the audit log. */
  readonly target: string;
}

// --- The injected IO seam ---------------------------------------------------
// The harness NEVER spawns a process directly. `exec` runs a command (the app's
// WS-PH4 strategy supplies a real process spawn; tests supply a fake). `exists`
// is the aside-collision check (mv-aside refuses when the aside-path is present).
// The harness wraps this seam under dryRun so exec cannot fire (see dryRunGuardIo).
export interface AutoResolveIO {
  readonly exec: (cmd: string) => { readonly stdout: string; readonly status: number };
  readonly exists: (path: string) => boolean;
}

// --- The strategy outcome ---------------------------------------------------
// `command` is the exact command run (or that dry-run would run). `before_state`
// is a metadata-only state summary (counts, channel lists) captured BEFORE exec.
// `after_state` is null when dryRun (nothing was executed); otherwise the
// post-exec state summary. The harness FORCES after_state to null under dryRun
// regardless of what the strategy returns (defense-in-depth on the dry-run-first
// property).
export interface AutoResolveOutcome {
  readonly command: string;
  readonly before_state: object;
  readonly after_state: object | null;
}

// --- The audit entry (mirrors Appendix C) -----------------------------------
// One per disposition (applied / skipped / refused). Metadata-only: kind, target,
// strategy, command, before/after STATE SUMMARIES (counts / channel lists),
// reversible flag, disposition, ISO timestamp. NEVER file bodies.
export interface AutoResolveAuditEntry {
  readonly schema: typeof AUTO_RESOLVE_AUDIT_SCHEMA;
  readonly kind: PreconditionKind;
  readonly target: string;
  readonly strategy: string;
  readonly command: string;
  readonly before_state: object;
  readonly after_state: object | null;
  readonly reversible: boolean;
  readonly disposition: "applied" | "skipped" | "refused";
  readonly at: string;
}

// --- Project-registered resolution strategies -------------------------------
// The harness NEVER hardcodes a shell command. The app (WS-PH4) registers
// mv-aside and rustup-install (and any future strategy) under their strategy
// names; a MISSING strategy => refused (fail-safe). Mirrors the
// registerEnvironmentContract registry shape: Map<strategy, fn>.
export type ResolutionStrategyFn = (
  verdict: PreconditionVerdict,
  ctx: { readonly io: AutoResolveIO; readonly dryRun: boolean },
) => AutoResolveOutcome;

const RESOLUTION_STRATEGIES = new Map<string, ResolutionStrategyFn>();

export function registerResolutionStrategy(strategy: string, fn: ResolutionStrategyFn): void {
  if (!strategy || typeof strategy !== "string")
    throw new Error("registerResolutionStrategy: strategy is required");
  if (typeof fn !== "function")
    throw new Error(`registerResolutionStrategy('${strategy}'): fn is required`);
  RESOLUTION_STRATEGIES.set(strategy, fn);
}

// Internal helper: resolve a registered strategy by name. Returns undefined when
// none is registered — applyAutoResolve turns undefined into a 'refused'
// disposition (fail-safe). Not exported (internal to the auto-resolve module).
function resolveResolutionStrategy(strategy: string): ResolutionStrategyFn | undefined {
  return RESOLUTION_STRATEGIES.get(strategy);
}

// --- The options ------------------------------------------------------------
export interface AutoResolveOptions {
  /** Allow requires_network resolutions (the separately-named opt-in). */
  readonly network: boolean;
  /** Dry-run: record what WOULD be applied with after_state:null; do NOT exec. */
  readonly dryRun: boolean;
  /** The injected IO seam (exec + aside-collision exists check). */
  readonly io: AutoResolveIO;
  /** Optional jsonl audit-log path; one AutoResolveAuditEntry per disposition. */
  readonly auditLog?: string;
  /** Pluggable clock (deterministic in tests). Defaults to new Date().toISOString(). */
  readonly now?: () => string;
}

// --- The result -------------------------------------------------------------
export interface AutoResolveResult {
  readonly applied: readonly AutoResolveAuditEntry[];
  readonly skipped: readonly AutoResolveAuditEntry[];
  readonly refused: readonly AutoResolveAuditEntry[];
}

// --- Dry-run IO guard (defense-in-depth on dry-run-first) -------------------
// Under dryRun the harness passes a GUARDED io to the strategy: exists is passed
// through (the strategy may probe aside-collision without side effects), but exec
// THROWS. This makes "io.exec is not invoked under dryRun" structurally enforced —
// even a buggy strategy that ignored ctx.dryRun could not fire a command. The
// original options.io.exec is therefore unreachable under dryRun.
function dryRunGuardIo(io: AutoResolveIO): AutoResolveIO {
  return {
    exists: io.exists,
    exec: () => {
      throw new Error("applyAutoResolve: io.exec must not be invoked under dryRun");
    },
  };
}

// --- Audit-entry construction (single constructor; metadata-only) -----------
function makeAuditEntry(
  kind: PreconditionKind,
  target: string,
  strategy: string,
  command: string,
  beforeState: object,
  afterState: object | null,
  reversible: boolean,
  disposition: "applied" | "skipped" | "refused",
  at: string,
): AutoResolveAuditEntry {
  return {
    schema: AUTO_RESOLVE_AUDIT_SCHEMA,
    kind,
    target,
    strategy,
    command,
    before_state: beforeState,
    after_state: afterState,
    reversible,
    disposition,
    at,
  };
}

// --- Audit-entry write (the ONE allowed node:fs use) ------------------------
// Append one audit entry to the jsonl audit log (append-only, newline-delimited).
// Metadata-only: environmentBodyFreeViolations is enforced BEFORE write so no
// forbidden key (body/task/prompt/output/content/message/text/rationale/diff/patch)
// leaks into the log. This is the ONE allowed node:fs use in this file (the audit
// log IS the intended IO); everything else is pure or via the injected io.exec.
function appendAuditEntry(auditLog: string, entry: AutoResolveAuditEntry): void {
  const violations = environmentBodyFreeViolations(entry);
  if (violations.length > 0) {
    throw new Error(
      `applyAutoResolve: audit entry fails body-free enforcement (${violations.join(", ")}); refusing to write metadata-only audit log`,
    );
  }
  appendFileSync(auditLog, `${JSON.stringify(entry)}\n`);
}

// --- The primitive (the safety core) ----------------------------------------
// applyAutoResolve iterates verdicts and, for each, computes exactly one
// AutoResolveAuditEntry with disposition applied | skipped | refused. The safety
// invariants are evaluated IN ORDER and each short-circuits to a safe disposition
// BEFORE any dispatch:
//   (1) no-allowlist-match => refused (fail-safe; nothing ad-hoc is invented)
//   (2) reversible:false   => refused ALWAYS (structurally unresolvable; no flag
//                             auto-applies it — this runs BEFORE network gating
//                             and BEFORE dispatch)
//   (3) requires_network && options.network===false => skipped (no flag silently
//                             applies a networked resolution)
//   (4) missing strategy   => refused (the harness never hardcodes a command)
//   (5) dryRun             => after_state forced null + io.exec guarded; records
//                             what it WOULD apply (disposition 'applied')
// Only after ALL of (1)-(4) pass does the harness dispatch to the registered
// ResolutionStrategyFn, and only under non-dryRun does the real io.exec reach the
// strategy. A reversible:false strategy is rejected at (2) before dispatch, so an
// irreversible action CANNOT be expressed as a registered strategy this function
// would invoke.
export function applyAutoResolve(
  verdicts: readonly AutoResolveVerdict[],
  allowlist: AutoResolveAllowlist,
  options: AutoResolveOptions,
): AutoResolveResult {
  // Structural validation of the allowlist + options. The schema NAME is
  // app-owned (any non-empty string); only the structure is validated.
  if (!allowlist || typeof allowlist.schema !== "string" || allowlist.schema.length === 0) {
    throw new Error("applyAutoResolve: allowlist.schema must be a non-empty string");
  }
  if (!Array.isArray(allowlist.allow)) {
    throw new Error("applyAutoResolve: allowlist.allow must be an array");
  }
  if (
    !options ||
    typeof options.io?.exec !== "function" ||
    typeof options.io?.exists !== "function"
  ) {
    throw new Error("applyAutoResolve: options.io.{exec,exists} are required");
  }

  const applied: AutoResolveAuditEntry[] = [];
  const skipped: AutoResolveAuditEntry[] = [];
  const refused: AutoResolveAuditEntry[] = [];
  // Iteration-ordered log: one entry per verdict, in input order. Written to the
  // audit log (when supplied) in this same order so the log reads chronologically.
  const ordered: AutoResolveAuditEntry[] = [];
  const stamp = (): string => (options.now ? options.now() : new Date().toISOString());

  const record = (entry: AutoResolveAuditEntry): void => {
    ordered.push(entry);
    if (entry.disposition === "applied") applied.push(entry);
    else if (entry.disposition === "skipped") skipped.push(entry);
    else refused.push(entry);
  };

  for (const verdict of verdicts) {
    // (1) NO-ALLOWLIST-MATCH => refused (fail-safe). Find the entry by kind. The
    //     harness invents NO resolution for an unmatched kind.
    const entry = allowlist.allow.find((candidate) => candidate.kind === verdict.kind);
    if (!entry) {
      record(
        makeAuditEntry(
          verdict.kind,
          verdict.target,
          "(no-allowlist-match)",
          verdict.fix_command ?? "",
          {},
          null,
          false,
          "refused",
          stamp(),
        ),
      );
      continue;
    }

    // (2) SAFETY CORE — reversible:false => REFUSED ALWAYS. No flag auto-applies a
    //     non-reversible resolution; it is structurally unresolvable. This runs
    //     BEFORE network gating and BEFORE dispatch, so an irreversible action
    //     cannot be expressed as a registered strategy this function would call.
    if (entry.reversible === false) {
      record(
        makeAuditEntry(
          entry.kind,
          verdict.target,
          entry.strategy,
          verdict.fix_command ?? "",
          {},
          null,
          false,
          "refused",
          stamp(),
        ),
      );
      continue;
    }

    // (3) NETWORK GATING — requires_network && options.network===false => skipped.
    //     There is no flag value that silently applies a networked resolution
    //     without options.network===true. (Skipped, not refused: it WOULD apply
    //     under the separately-named --auto-resolve=network opt-in.)
    if (entry.requires_network === true && options.network === false) {
      record(
        makeAuditEntry(
          entry.kind,
          verdict.target,
          entry.strategy,
          verdict.fix_command ?? "",
          {},
          null,
          true,
          "skipped",
          stamp(),
        ),
      );
      continue;
    }

    // (4) STRATEGY DISPATCH — look up the project-registered ResolutionStrategyFn.
    //     The harness NEVER hardcodes a shell command; a MISSING strategy =>
    //     refused (fail-safe).
    const strategyFn = resolveResolutionStrategy(entry.strategy);
    if (!strategyFn) {
      record(
        makeAuditEntry(
          entry.kind,
          verdict.target,
          entry.strategy,
          verdict.fix_command ?? "",
          {},
          null,
          true,
          "refused",
          stamp(),
        ),
      );
      continue;
    }

    // (5) DRY-RUN-FIRST + DISPATCH. Under dryRun the harness passes a GUARDED io
    //     (exec throws) AND forces after_state:null in the audit entry, so the
    //     dry-run-first property holds regardless of strategy behavior. Under
    //     non-dryRun the real io.exec reaches the strategy; before/after state are
    //     captured by the strategy and recorded verbatim.
    const ioForStrategy = options.dryRun ? dryRunGuardIo(options.io) : options.io;
    const outcome = strategyFn(verdict, { io: ioForStrategy, dryRun: options.dryRun });
    const afterState = options.dryRun ? null : outcome.after_state;
    record(
      makeAuditEntry(
        entry.kind,
        verdict.target,
        entry.strategy,
        outcome.command,
        outcome.before_state,
        afterState,
        true,
        "applied",
        stamp(),
      ),
    );
  }

  // AUDIT LOG: append one entry per disposition (applied/skipped/refused) in
  // iteration order when options.auditLog is supplied. Append-only,
  // newline-delimited, metadata-only (body-free enforced per entry before write).
  if (options.auditLog) {
    for (const entry of ordered) {
      appendAuditEntry(options.auditLog, entry);
    }
  }

  return { applied, skipped, refused };
}
