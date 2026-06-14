// ZOB Harness — Worklist liveness watchdog (WS-H3).
//
// The forcing function that prevents the original project-transposer
// supervisor-check stall: a directive the resolver cannot auto-close must not
// stall silently with all panes alive. This watchdog extracts ONLY the
// escalation-ramp + observe-rule primitives from the proven reference
// ~/zob/project-transposer/scripts/lib/handoff-state.mjs (computeEscalation +
// the ESCALATION_LEVEL_* constants + ESCALATE_TO_*_DEFAULT_MS budgets) and
// adapts them to the WS-H1 worklist keystone (store.projectWorklist /
// listWorklistDirectives). The transposer handoff FSM is NOT copied — only the
// pure ramp + the HEADLINE observe-rule.
//
// HEADLINE HARD RULE (the whole point of WS-H3):
//   observe === (openDirectives.length === 0)   // EXACTLY
// An open directive past its decision deadline escalates up the ramp
// (wait/auto/nudge_llm/human_block) and NEVER produces observe. This is the
// exact rule that would have prevented the original live stall where
// supervisor-check emitted `observe` on a rejected-stalled epoch while the
// canonical watch view was non-empty. Any implementation that can return
// observe=true while a directive is open is a DEFECT (reintroduces the stall).
//
// Metadata-only posture: every persisted watchdog record is hash-only with
// bodyStored:false / networkEnabled:false / localOnly:true and is asserted
// body-free against FORBIDDEN_PLAINTEXT_KEYS. The watchdog EMITS governed
// metadata-only escalation events; it does not itself mutate the append-only
// worklist state (events.jsonl / leases.jsonl) — it is a forcing function that
// surfaces overdue directives. Escalation events are appended to
// .pi/worklist/<scope>/watchdog.jsonl.
//
// Purity contract: imports ONLY from src/core/** + ./types.js + ./store.js
// (siblings). No runtime or @earendil-works/pi-coding-agent imports, so the
// domain stays reusable by projections (transposer, pacman, ...).

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { readJsonl } from "../../core/utils/json.js";
import { newRunId, safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";
import { FORBIDDEN_PLAINTEXT_KEYS, SHA256_HEX } from "./types.js";
import { listWorklistDirectives, worklistBodyFreeViolations } from "./store.js";
import type { ProjectedDirective } from "./types.js";

// --- Schemas -----------------------------------------------------------------

export const WATCHDOG_ESCALATION_SCHEMA = "zob.worklist-watchdog-escalation.v1";
export const WATCHDOG_TICK_RESULT_SCHEMA = "zob.worklist-watchdog-tick.v1";
export const WATCHDOG_EVALUATION_SCHEMA = "zob.worklist-watchdog-evaluation.v1";

// Ramp levels — mirror transposer ESCALATION_LEVEL_* EXACTLY (same strings,
// same boundaries). human_block corresponds to a no_ship alert.
export const ESCALATION_LEVEL_WAIT = "wait";
export const ESCALATION_LEVEL_AUTO = "auto";
export const ESCALATION_LEVEL_NUDGE_LLM = "nudge_llm";
export const ESCALATION_LEVEL_HUMAN_BLOCK = "human_block";

// WS-EH3: a NON-RAMP signal for an open directive whose evidenceKind is
// satisfiable-now (accept/reassign/rollback). Such a directive is ALREADY
// closable (hard evidence holds), so it is flagged act_now and NEVER escalated
// up the ramp (no auto/nudge_llm/human_block), regardless of how far past its
// deadline it is. This is the exact fix for the tickets stall class: a claim
// whose oracle arrived late on disk is already satisfiable
// (evidenceKind='accept') and must surface act-now instead of being
// mis-escalated to human_block. act_now is NOT part of the ramp progression —
// it short-circuits escalation while keeping the directive OPEN (observe stays
// false; the HARD RULE below is preserved).
export const ESCALATION_LEVEL_ACT_NOW = "act_now";

// Default budgets — mirror transposer DECISION_TIMEOUT_DEFAULT_MS /
// ESCALATE_TO_LLM_DEFAULT_MS / ESCALATE_TO_HUMAN_DEFAULT_MS (5min / 10min / 15min).
export const DECISION_TIMEOUT_DEFAULT_MS = 5 * 60 * 1000;
export const ESCALATE_TO_LLM_DEFAULT_MS = 10 * 60 * 1000;
export const ESCALATE_TO_HUMAN_DEFAULT_MS = 15 * 60 * 1000;

export interface WatchdogBudgets {
  /** Decision window before the resolver/watcher auto-acts. Default 5 min. */
  readonly decision_timeout_ms?: number;
  /** Elapsed since anchor at which an LLM nudge is sent. Default 10 min. */
  readonly escalate_to_llm_ms?: number;
  /** Elapsed since anchor at which a human no_ship block is raised. Default 15 min. */
  readonly escalate_to_human_ms?: number;
}

// --- Pure escalation ramp (EXACT transposer computeEscalation mirror) --------
//
// Pure over (anchorIso, nowMs, budgets). Measures elapsed since the anchor:
//   open < decisionTimeoutMs          -> 'wait'         (orchestrator still preferred)
//   decisionTimeoutMs <= open < llmMs -> 'auto'         (resolver auto-acts each tick)
//   llmMs <= open < humanMs           -> 'nudge_llm'    (ORACLE_REQUEST/goal-room nudge)
//   open >= humanMs                   -> 'human_block'  (NO_SHIP_ALERT + block)
// A null/unparseable anchor is fail-safe: openMs = Infinity -> human_block
// (never silently observe). This is byte-for-byte the transposer ramp shape.

export interface WatchdogEscalation {
  level: string;
  open_ms: number;
  anchor_at: string | null;
  decision_timeout_ms: number;
  escalate_to_llm_ms: number;
  escalate_to_human_ms: number;
}

function resolveBudgets(budgets: WatchdogBudgets = {}): {
  timeoutMs: number;
  llmMs: number;
  humanMs: number;
} {
  const timeoutMs =
    Number.isFinite(budgets.decision_timeout_ms) && (budgets.decision_timeout_ms as number) > 0
      ? (budgets.decision_timeout_ms as number)
      : DECISION_TIMEOUT_DEFAULT_MS;
  const llmMs =
    Number.isFinite(budgets.escalate_to_llm_ms) && (budgets.escalate_to_llm_ms as number) > 0
      ? (budgets.escalate_to_llm_ms as number)
      : ESCALATE_TO_LLM_DEFAULT_MS;
  const humanMs =
    Number.isFinite(budgets.escalate_to_human_ms) && (budgets.escalate_to_human_ms as number) > 0
      ? (budgets.escalate_to_human_ms as number)
      : ESCALATE_TO_HUMAN_DEFAULT_MS;
  return { timeoutMs, llmMs, humanMs };
}

export function computeWatchdogEscalation(
  anchorIso: string | null,
  nowMs: number,
  budgets: WatchdogBudgets = {},
): WatchdogEscalation {
  const anchorMs = anchorIso ? Date.parse(anchorIso) : Number.NaN;
  const openMs = Number.isFinite(anchorMs) ? Math.max(0, Number(nowMs) - anchorMs) : Number.POSITIVE_INFINITY;
  const { timeoutMs, llmMs, humanMs } = resolveBudgets(budgets);
  let level: string;
  if (openMs >= humanMs) level = ESCALATION_LEVEL_HUMAN_BLOCK;
  else if (openMs >= llmMs) level = ESCALATION_LEVEL_NUDGE_LLM;
  else if (openMs >= timeoutMs) level = ESCALATION_LEVEL_AUTO;
  else level = ESCALATION_LEVEL_WAIT;
  return {
    level,
    open_ms: openMs,
    anchor_at: Number.isFinite(anchorMs) ? new Date(anchorMs).toISOString() : null,
    decision_timeout_ms: timeoutMs,
    escalate_to_llm_ms: llmMs,
    escalate_to_human_ms: humanMs,
  };
}

// --- Escalation entry (one per OPEN directive; metadata-only) ----------------
//
// The in-memory ramp view. One entry per open (projected AND not-satisfied)
// directive, carrying its current level (a ramp level: wait/auto/nudge_llm/
// human_block; OR the WS-EH3 act_now signal for a satisfiable-now directive).
// The escalation array is empty exactly when no directive is open — which is
// exactly the observe condition.

// WS-EH3: evidence kinds that mean the epoch is ALREADY closable (hard evidence
// holds). The canonical EvidenceKind set is 'accept'|'reject'|'await'|'reassign'|
// 'rollback'|'noop'; of these, 'accept'/'reassign'/'rollback' are the
// satisfiable-now verdicts (the contract's EvidenceVerdict.satisfied === true).
// Everything else ('await' = evidence not yet arrived; 'reject' = genuinely
// missing; 'noop' = no verdict; null/undefined = no contract) escalates the ramp
// as before (backward compatible: treated as await-eligible).
const SATISFIABLE_NOW_EVIDENCE_KINDS = new Set(["accept", "reassign", "rollback"]);

// Is this projected evidenceKind a satisfiable-now verdict (closable NOW)? Used
// by the watchdog to decide whether to flag act_now (and never escalate) vs
// escalate the ramp. A null/undefined evidenceKind (no contract / generic
// reducer) is NOT satisfiable-now, so the directive escalates on deadline as
// before — this is the backward-compat path.
function isSatisfiableNowEvidenceKind(evidenceKind: string | null | undefined): boolean {
  return evidenceKind != null && SATISFIABLE_NOW_EVIDENCE_KINDS.has(evidenceKind);
}

export interface WatchdogEscalationEntry {
  directive_hash: string;
  level: string;
  open_ms: number;
  anchor_at: string | null;
  deadline: string | null;
  reason: string;
}

function reasonForLevel(level: string): string {
  switch (level) {
    case ESCALATION_LEVEL_WAIT:
      return "watchdog:directive_open_within_decision_window";
    case ESCALATION_LEVEL_AUTO:
      return "watchdog:directive_past_deadline_resolver_auto_acts";
    case ESCALATION_LEVEL_NUDGE_LLM:
      return "watchdog:directive_overdue_nudge_llm";
    case ESCALATION_LEVEL_HUMAN_BLOCK:
      return "watchdog:directive_overdue_human_block_no_ship";
    case ESCALATION_LEVEL_ACT_NOW:
      // WS-EH3: satisfiable-now (evidenceKind accept/reassign/rollback). The
      // epoch is already closable — act immediately, never escalate.
      return "watchdog:directive_satisfiable_now_act_immediately";
    default:
      return "watchdog:directive_open";
  }
}

// Recover the directive's decision-epoch anchor from its deadline. The transposer
// convention is deadline = anchor + decisionTimeoutMs (anchorDeadline), so the
// inverse anchor = deadline - decisionTimeoutMs. A directive AT its deadline has
// openMs = decisionTimeoutMs (the 'auto' boundary); past its deadline -> 'auto'+;
// before its deadline -> 'wait'. A null deadline yields a null anchor -> fail-safe
// human_block (computeWatchdogEscalation), never a silent observe.
function anchorFromDeadline(deadline: string | null, timeoutMs: number): string | null {
  if (!deadline) return null;
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) return null;
  return new Date(deadlineMs - timeoutMs).toISOString();
}

// --- THE HEADLINE FUNCTION ---------------------------------------------------
//
// Reads the projected directives (via store.projectWorklist) and returns the
// watchdog decision. THE HARD RULE IS ENFORCED HERE:
//   observe = (openDirectives.length === 0)   // EXACTLY
// A satisfied directive is done (not open). Every open directive produces an
// escalation entry, so escalation.length === directivesOpen and observe is true
// exactly when escalation is empty. An open directive past its deadline escalates
// (auto/nudge_llm/human_block) — it NEVER produces observe.
export interface WatchdogEvaluation {
  schema: typeof WATCHDOG_EVALUATION_SCHEMA;
  scope: string;
  observe: boolean;
  directivesOpen: number;
  escalation: WatchdogEscalationEntry[];
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  localOnly: true;
  networkEnabled: false;
}

function validateScope(scope: string): void {
  if (typeof scope !== "string" || scope.trim().length === 0 || safeFileStem(scope) !== scope) {
    throw new Error(`invalid worklist scope: ${scope}`);
  }
}

export function evaluateWorklistWatchdog(
  repoRoot: string,
  scope: string,
  now: number,
  budgets: WatchdogBudgets = {},
): WatchdogEvaluation {
  validateScope(scope);
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const { timeoutMs } = resolveBudgets(budgets);

  // Reads the projected directives via the WS-H1 keystone (store.projectWorklist).
  const directives = listWorklistDirectives(repoRoot, scope, nowMs);
  // A satisfied directive is done; only genuinely-open directives count toward
  // the hard rule. This mirrors the transposer watch view, whose directives are
  // genuinely-open work (a satisfied/closed task emits no directive).
  const openDirectives = directives.filter((directive: ProjectedDirective) => !directive.satisfied);

  const escalation: WatchdogEscalationEntry[] = [];
  for (const directive of openDirectives) {
    const anchorIso = anchorFromDeadline(directive.deadline, timeoutMs);
    const ramp = computeWatchdogEscalation(anchorIso, nowMs, budgets);
    // WS-EH3 evidence-aware escalation: a directive whose evidenceKind is
    // satisfiable-now (accept/reassign/rollback) is ALREADY closable — flag it
    // act_now and NEVER escalate it up the ramp (the fix for the tickets stall
    // class: a late-arriving oracle makes the epoch closable, so escalating it
    // to human_block would re-stall a healthy claim). It is still OPEN (not
    // satisfied), so it still blocks observe (the HARD RULE below is preserved)
    // — it just must not escalate to auto/nudge_llm/human_block. A directive
    // with evidenceKind 'await'/'reject'/'noop'/null/undefined escalates the
    // ramp as before (backward compatible: null/undefined treated as
    // await-eligible). open_ms/anchor_at are still computed for diagnostics
    // (how overdue the closable epoch is) even though the level is act_now.
    const level = isSatisfiableNowEvidenceKind(directive.evidenceKind)
      ? ESCALATION_LEVEL_ACT_NOW
      : ramp.level;
    escalation.push({
      directive_hash: directive.hash,
      level,
      open_ms: ramp.open_ms,
      anchor_at: ramp.anchor_at,
      deadline: directive.deadline,
      reason: reasonForLevel(level),
    });
  }

  // HEADLINE HARD RULE: observe ONLY when no directive is open. EXACTLY.
  const observe = openDirectives.length === 0;

  return {
    schema: WATCHDOG_EVALUATION_SCHEMA,
    scope,
    observe,
    directivesOpen: openDirectives.length,
    escalation,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    localOnly: true,
    networkEnabled: false,
  };
}

// --- Persisted escalation event (append-only, hash-only) ---------------------

export interface WatchdogEscalationEvent {
  schema: typeof WATCHDOG_ESCALATION_SCHEMA;
  kind: "watchdog_escalation";
  eventId: string;
  scope: string;
  directiveHash: string;
  level: string;
  noShip: boolean;
  openMs: number;
  anchorAt: string | null;
  deadline: string | null;
  reason: string;
  at: string;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  localOnly: true;
  networkEnabled: false;
}

function worklistScopeDir(repoRoot: string, scope: string): string {
  return join(repoRoot, ".pi", "worklist", scope);
}

function watchdogPath(repoRoot: string, scope: string): string {
  return join(worklistScopeDir(repoRoot, scope), "watchdog.jsonl");
}

function buildEscalationEvent(
  scope: string,
  entry: WatchdogEscalationEntry,
  nowMs: number,
): WatchdogEscalationEvent {
  const noShip = entry.level === ESCALATION_LEVEL_HUMAN_BLOCK;
  return {
    schema: WATCHDOG_ESCALATION_SCHEMA,
    kind: "watchdog_escalation",
    eventId: newRunId("wlwd"),
    scope,
    directiveHash: entry.directive_hash,
    level: entry.level,
    noShip,
    openMs: entry.open_ms,
    anchorAt: entry.anchor_at,
    deadline: entry.deadline,
    reason: entry.reason,
    at: new Date(nowMs).toISOString(),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    localOnly: true,
    networkEnabled: false,
  };
}

function appendWatchdogRecord(repoRoot: string, scope: string, record: unknown): void {
  mkdirSync(worklistScopeDir(repoRoot, scope), { recursive: true });
  appendFileSync(watchdogPath(repoRoot, scope), `${JSON.stringify(record)}\n`, "utf8");
}

// Read the raw append-only escalation log (defensive; metadata-only).
export function listWatchdogEscalations(repoRoot: string, scope: string): WatchdogEscalationEvent[] {
  validateScope(scope);
  const events: WatchdogEscalationEvent[] = [];
  for (const raw of readJsonl(watchdogPath(repoRoot, scope))) {
    if (!isRecord(raw)) continue;
    if (raw.schema !== WATCHDOG_ESCALATION_SCHEMA) continue;
    if (raw.kind !== "watchdog_escalation") continue;
    const directiveHash = typeof raw.directiveHash === "string" ? raw.directiveHash : null;
    if (!directiveHash || !SHA256_HEX.test(directiveHash)) continue;
    events.push({
      schema: WATCHDOG_ESCALATION_SCHEMA,
      kind: "watchdog_escalation",
      eventId: typeof raw.eventId === "string" ? raw.eventId : "",
      scope: typeof raw.scope === "string" ? raw.scope : scope,
      directiveHash,
      level: typeof raw.level === "string" ? raw.level : "",
      noShip: raw.noShip === true,
      openMs: typeof raw.openMs === "number" ? raw.openMs : 0,
      anchorAt: typeof raw.anchorAt === "string" ? raw.anchorAt : null,
      deadline: typeof raw.deadline === "string" ? raw.deadline : null,
      reason: typeof raw.reason === "string" ? raw.reason : "",
      at: typeof raw.at === "string" ? raw.at : "",
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
      localOnly: true,
      networkEnabled: false,
    });
  }
  return events;
}

// --- Bounded runner (one watchdog tick) --------------------------------------
//
// (a) calls evaluateWorklistWatchdog; (b) for each directive at level 'auto'
// attempts nothing destructive (the resolver acts, not the watchdog) but RECORDS
// the escalation; (c) for 'nudge_llm' records an escalation event; (d) for
// 'human_block' records a no_ship escalation. The watchdog EMITS governed
// metadata-only events; it does not itself mutate the worklist state. A 'wait'
// directive is open (so observe stays false) but needs no escalation action, so
// no event is persisted for it.

export interface WatchdogTickDeps {
  /** Injectable clock for deterministic tests. */
  readonly now?: number;
}

export interface WatchdogTickResult {
  schema: typeof WATCHDOG_TICK_RESULT_SCHEMA;
  scope: string;
  observe: boolean;
  directivesOpen: number;
  /** Full ramp view: one entry per open directive (level may be 'wait'). */
  escalation: WatchdogEscalationEntry[];
  /** Escalation events actually persisted this tick (non-wait levels only). */
  emitted: WatchdogEscalationEvent[];
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  localOnly: true;
  networkEnabled: false;
}

export function runWorklistWatchdogTick(
  repoRoot: string,
  scope: string,
  budgets: WatchdogBudgets = {},
  deps: WatchdogTickDeps = {},
): WatchdogTickResult {
  validateScope(scope);
  const nowMs = deps.now ?? Date.now();
  const evaluation = evaluateWorklistWatchdog(repoRoot, scope, nowMs, budgets);

  const emitted: WatchdogEscalationEvent[] = [];
  for (const entry of evaluation.escalation) {
    // 'wait' = open but inside the decision window; no escalation action yet.
    if (entry.level === ESCALATION_LEVEL_WAIT) continue;
    // 'act_now' = satisfiable-now (WS-EH3): surfaced in the escalation array as
    // a closable-now signal but NOT persisted as an escalation event — it is not
    // an escalation (the epoch is already closable, so there is nothing to
    // escalate, and writing a human_block/nudge_llm here would reintroduce the
    // tickets stall class). Only genuine ramp escalations (auto/nudge_llm/
    // human_block) are persisted to watchdog.jsonl.
    if (entry.level === ESCALATION_LEVEL_ACT_NOW) continue;
    const event = buildEscalationEvent(scope, entry, nowMs);
    const violations = worklistBodyFreeViolations(event);
    if (violations.length > 0) {
      throw new Error(`watchdog escalation event contains forbidden plaintext keys: ${violations.join(", ")}`);
    }
    appendWatchdogRecord(repoRoot, scope, event);
    emitted.push(event);
  }

  const result: WatchdogTickResult = {
    schema: WATCHDOG_TICK_RESULT_SCHEMA,
    scope,
    observe: evaluation.observe,
    directivesOpen: evaluation.directivesOpen,
    escalation: evaluation.escalation,
    emitted,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    localOnly: true,
    networkEnabled: false,
  };
  const resultViolations = worklistBodyFreeViolations(result);
  if (resultViolations.length > 0) {
    throw new Error(`watchdog tick result contains forbidden plaintext keys: ${resultViolations.join(", ")}`);
  }
  return result;
}
