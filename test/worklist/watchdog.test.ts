import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  DECISION_TIMEOUT_DEFAULT_MS,
  ESCALATE_TO_HUMAN_DEFAULT_MS,
  ESCALATE_TO_LLM_DEFAULT_MS,
  ESCALATION_LEVEL_ACT_NOW,
  ESCALATION_LEVEL_AUTO,
  ESCALATION_LEVEL_HUMAN_BLOCK,
  ESCALATION_LEVEL_NUDGE_LLM,
  ESCALATION_LEVEL_WAIT,
  GENERIC_WORKLIST_REDUCER_ID,
  buildDirective,
  computeWatchdogEscalation,
  directiveHash,
  evaluateEvidenceForDirective,
  evaluateWorklistWatchdog,
  listWatchdogEscalations,
  openWorklistStore,
  registerEvidenceContract,
  registerWorklistReducer,
  runWorklistWatchdogTick,
  type Directive,
  type EvidenceContract,
  type WorklistReducer,
} from "../../.pi/extensions/zob-harness/index.ts";

const MIN = 60 * 1000;

// A test-only reducer that projects EVERY OPEN event as a directive regardless of
// its deadline (the generic reducer only projects DUE / past-deadline work). This
// lets the 'wait' branch seed a directive that is open but NOT yet past its
// decision_timeout (a future deadline), exactly mirroring the transposer 'wait'
// window. Registered once; the scope reducer_id selects it.
const ALWAYS_PROJECT_REDUCER_ID = "watchdog-test-always-project";
const alwaysProjectReducer: WorklistReducer = {
  reducerId: ALWAYS_PROJECT_REDUCER_ID,
  computeDirectives(events) {
    const directives = [];
    for (const event of events) {
      if (String(event.kind ?? "").toUpperCase() !== "OPEN") continue;
      directives.push(
        buildDirective({
          action: "ACT",
          ref: event.ref,
          owner: event.owner ?? "unassigned",
          reasonRef: event.reasonRef,
          unblockPath: event.unblockPath,
          evidenceRequired: event.evidenceRefs,
          evidencePresent: false,
          deadline: event.deadline,
        }),
      );
    }
    return directives;
  },
};
registerWorklistReducer(alwaysProjectReducer);

// WS-EH3 test fixture: a toy EvidenceContract + reducer (the EH2 pattern) that
// projects Directive.evidenceKind so the watchdog's evidence-aware escalation can
// be exercised end-to-end through the store. The verdict is selected by the
// event's `owner` field (the only free-form, non-path-validated event field —
// ref/reason_ref/unblock_path/evidence_refs are all path-validated at append).
// The store resolves the contract by reducer_id (buildWorklistDeps ->
// resolveEvidenceContract), so the reducer's deps.evidenceContract is set and
// evaluateEvidenceForDirective annotates each directive. Registered once.
const EH3_REDUCER_ID = "watchdog-test-eh3-evidence";
const eh3EvidenceContract: EvidenceContract = {
  evidenceId: EH3_REDUCER_ID,
  evaluateEvidence(task) {
    // task.status carries the intended verdict tag (from event.owner). Pure over
    // (task, evidence); the empty evidence passed by the watchdog path is fine.
    const tag = String(task.status ?? "").toLowerCase();
    switch (tag) {
      case "accept":
        return { satisfied: true, kind: "accept", awaitedKinds: [], gateRef: null, depRef: null };
      case "reassign":
        return { satisfied: true, kind: "reassign", awaitedKinds: [], gateRef: "reports/ws-eh3/gate.json", depRef: null };
      case "rollback":
        return { satisfied: true, kind: "rollback", awaitedKinds: [], gateRef: null, depRef: "reports/ws-eh3/dep.json" };
      case "await":
        return { satisfied: false, kind: "await", awaitedKinds: ["accept"], gateRef: null, depRef: null };
      case "reject":
        return { satisfied: false, kind: "reject", awaitedKinds: ["accept"], gateRef: null, depRef: null };
      case "noop":
        return { satisfied: false, kind: "noop", awaitedKinds: [], gateRef: null, depRef: null };
      default:
        return { satisfied: false, kind: "noop", awaitedKinds: [], gateRef: null, depRef: null };
    }
  },
};
registerEvidenceContract(eh3EvidenceContract);

const eh3EvidenceReducer: WorklistReducer = {
  reducerId: EH3_REDUCER_ID,
  computeDirectives(events, deps) {
    const directives: Directive[] = [];
    for (const event of events) {
      if (String(event.kind ?? "").toUpperCase() !== "OPEN") continue;
      const directive = buildDirective({
        action: "ACT",
        ref: event.ref,
        owner: event.owner ?? "unassigned",
        reasonRef: event.reasonRef,
        unblockPath: event.unblockPath,
        evidenceRequired: event.evidenceRefs,
        evidencePresent: false,
        deadline: event.deadline,
      });
      // EH2 annotation pipeline: consult the registered contract (resolved by
      // the store via reducer_id) to derive the projected evidenceKind. The
      // task.status tag carries the intended verdict from event.owner. The
      // watchdog reads this annotation via the store projection.
      const taskView = { ref: event.ref ?? null, status: event.owner ?? "open" };
      const annotation = evaluateEvidenceForDirective(deps.evidenceContract, taskView, deps.evidence);
      if (annotation) {
        directive.evidenceKind = annotation.evidenceKind;
        directive.evidencePresent = annotation.evidencePresent;
      }
      directives.push(directive);
    }
    return directives;
  },
};
registerWorklistReducer(eh3EvidenceReducer);

let repo = "";

before(() => {
  repo = mkdtempSync(join(tmpdir(), "zob-watchdog-"));
});

after(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the temp repo */
  }
});

function readJsonl(rel: string): unknown[] {
  const path = join(repo, rel);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// decisionPending mirrors transposer-smoke.mjs checkpoint(): a directive is
// pending exactly when at least one open directive exists. The HARD RULE is
// observe === !decisionPending (observe ONLY when directives == []).
function decisionPending(evaluation: { directivesOpen: number }): boolean {
  return evaluation.directivesOpen > 0;
}

// ===========================================================================
// (1) HARD RULE branch A: ONE open directive PAST its deadline -> ESCALATE,
//     NEVER observe. This is the exact rule that would have prevented the
//     original transposer supervisor-check stall (observe emitted on a
//     rejected-stalled epoch).
// ===========================================================================
test("watchdog HARD RULE: one open directive past its deadline escalates, NEVER observes", () => {
  const scope = "ws-h3-overdue";
  const store = openWorklistStore(repo, scope);
  const now = Date.now();
  // 20 min overdue -> openMs = 20min + 5min(decision_timeout) = 25min >= 15min(human).
  const pastDeadline = new Date(now - 20 * MIN).toISOString();

  store.appendEvent({
    scope,
    reducer_id: GENERIC_WORKLIST_REDUCER_ID,
    kind: "OPEN",
    ref: "reports/ws-h3-overdue/task-1.json",
    owner: "worker-a",
    deadline: pastDeadline,
  });

  const evaluation = evaluateWorklistWatchdog(repo, scope, now);

  // HARD RULE: a directive is open -> observe MUST be false.
  assert.equal(evaluation.observe, false);
  assert.equal(evaluation.directivesOpen, 1);
  // Escalation is non-empty (escalate, NEVER observe).
  assert.equal(evaluation.escalation.length, 1);
  assert.equal(evaluation.escalation[0].level, ESCALATION_LEVEL_HUMAN_BLOCK);
  assert.equal(evaluation.escalation[0].directive_hash, store.listDirectives(now)[0].hash);
  // Mirrors transposer-smoke.mjs checkpoint(): observe === !decisionPending.
  assert.equal(evaluation.observe, !decisionPending(evaluation));
  // Metadata-only posture.
  assert.equal(evaluation.bodyStored, false);
  assert.equal(evaluation.localOnly, true);
  assert.equal(evaluation.networkEnabled, false);

  // The bounded runner persists a governed no_ship escalation event for human_block.
  const tick = runWorklistWatchdogTick(repo, scope, {}, { now });
  assert.equal(tick.observe, false);
  assert.equal(tick.emitted.length, 1);
  assert.equal(tick.emitted[0].level, ESCALATION_LEVEL_HUMAN_BLOCK);
  assert.equal(tick.emitted[0].noShip, true);
  assert.equal(tick.emitted[0].bodyStored, false);
  assert.equal(tick.emitted[0].networkEnabled, false);

  // Append-only, hash-only watchdog.jsonl was written.
  const log = readJsonl(`.pi/worklist/${scope}/watchdog.jsonl`);
  assert.equal(log.length, 1);
  const persisted = log[0] as Record<string, unknown>;
  assert.equal(persisted.bodyStored, false);
  assert.equal(persisted.promptBodiesStored, false);
  assert.equal(persisted.outputBodiesStored, false);
  assert.equal(persisted.localOnly, true);
  assert.equal(persisted.networkEnabled, false);
  assert.equal(persisted.noShip, true);

  // listWatchdogEscalations reads it back body-free.
  const back = listWatchdogEscalations(repo, scope);
  assert.equal(back.length, 1);
  assert.equal(back[0].level, ESCALATION_LEVEL_HUMAN_BLOCK);
});

// ===========================================================================
// (2) HARD RULE branch B: EMPTY worklist (no directives) -> observe is CORRECT.
// ===========================================================================
test("watchdog HARD RULE: empty worklist (no directives) observes", () => {
  const scope = "ws-h3-empty";
  const now = Date.now();

  const evaluation = evaluateWorklistWatchdog(repo, scope, now);

  // HARD RULE: no directive open -> observe is true.
  assert.equal(evaluation.observe, true);
  assert.equal(evaluation.directivesOpen, 0);
  assert.equal(evaluation.escalation.length, 0);
  // Mirrors transposer-smoke.mjs checkpoint(): observe === !decisionPending.
  assert.equal(evaluation.observe, !decisionPending(evaluation));

  // The runner persists nothing (nothing to escalate).
  const tick = runWorklistWatchdogTick(repo, scope, {}, { now });
  assert.equal(tick.observe, true);
  assert.equal(tick.emitted.length, 0);
  assert.equal(tick.emitted.length, 0);
  assert.equal(existsSync(join(repo, ".pi", "worklist", scope, "watchdog.jsonl")), false);
});

// ===========================================================================
// (3) Wait branch: an open directive NOT yet past its decision_timeout -> level
//     'wait'. It is STILL observe===false because a directive IS open (the HARD
//     RULE does not care about the ramp level — any open directive blocks observe).
//     Mirrors the transposer-smoke.mjs 'after-reopen' decision-pending negation:
//     observe is correct ONLY when the worklist is empty.
// ===========================================================================
test("watchdog: open directive not yet past decision_timeout is 'wait' but still blocks observe", () => {
  const scope = "ws-h3-wait";
  const store = openWorklistStore(repo, scope);
  const now = Date.now();
  // Future deadline (1 min ahead). anchor = deadline - decision_timeout(5min)
  // = now - 4min -> openMs = 4min < 5min(decision_timeout) -> 'wait'.
  const futureDeadline = new Date(now + MIN).toISOString();

  store.appendEvent({
    scope,
    reducer_id: ALWAYS_PROJECT_REDUCER_ID,
    kind: "OPEN",
    ref: "reports/ws-h3-wait/task.json",
    owner: "worker-w",
    deadline: futureDeadline,
  });

  const evaluation = evaluateWorklistWatchdog(repo, scope, now);

  // A directive IS open -> observe MUST be false even though it is only 'wait'.
  assert.equal(evaluation.observe, false);
  assert.equal(evaluation.directivesOpen, 1);
  assert.equal(evaluation.escalation.length, 1);
  assert.equal(evaluation.escalation[0].level, ESCALATION_LEVEL_WAIT);
  assert.equal(evaluation.observe, !decisionPending(evaluation));

  // 'wait' needs no escalation action -> the runner persists nothing.
  const tick = runWorklistWatchdogTick(repo, scope, {}, { now });
  assert.equal(tick.observe, false);
  assert.equal(tick.emitted.length, 0);
});

// ===========================================================================
// (4) Ramp SHAPE mirrors transposer computeEscalation EXACTLY: three open
//     directives at distinct deadlines land on auto / nudge_llm / human_block,
//     and the open_ms + anchor_at follow the transposer budget boundaries.
// ===========================================================================
test("watchdog: escalation ramp shape mirrors transposer (auto / nudge_llm / human_block)", () => {
  const scope = "ws-h3-ramp";
  const store = openWorklistStore(repo, scope);
  const now = Date.now();
  const timeout = DECISION_TIMEOUT_DEFAULT_MS; // 5min
  const llm = ESCALATE_TO_LLM_DEFAULT_MS; // 10min
  const human = ESCALATE_TO_HUMAN_DEFAULT_MS; // 15min

  // openMs = now - anchor = now - (deadline - timeout) = (now - deadline) + timeout.
  //   deadline=now-2min  -> openMs = 2min + 5min = 7min  -> auto      (5<=7<10)
  //   deadline=now-7min  -> openMs = 7min + 5min = 12min -> nudge_llm (10<=12<15)
  //   deadline=now-16min -> openMs = 16min + 5min = 21min -> human_block(>=15)
  const cases = [
    { ref: "reports/ws-h3-ramp/auto.json", agoMin: 2, level: ESCALATION_LEVEL_AUTO },
    { ref: "reports/ws-h3-ramp/nudge.json", agoMin: 7, level: ESCALATION_LEVEL_NUDGE_LLM },
    { ref: "reports/ws-h3-ramp/human.json", agoMin: 16, level: ESCALATION_LEVEL_HUMAN_BLOCK },
  ] as const;

  for (const item of cases) {
    store.appendEvent({
      scope,
      reducer_id: GENERIC_WORKLIST_REDUCER_ID,
      kind: "OPEN",
      ref: item.ref,
      owner: "worker-r",
      deadline: new Date(now - item.agoMin * MIN).toISOString(),
    });
  }

  const evaluation = evaluateWorklistWatchdog(repo, scope, now);
  assert.equal(evaluation.directivesOpen, 3);
  assert.equal(evaluation.observe, false); // 3 directives open -> NEVER observe
  assert.equal(evaluation.observe, !decisionPending(evaluation));

  const byRef = new Map(store.listDirectives(now).map((d) => [d.ref, d.hash]));
  for (const item of cases) {
    const hash = byRef.get(item.ref);
    const entry = evaluation.escalation.find((e) => e.directive_hash === hash);
    assert.ok(entry, `escalation entry for ${item.ref}`);
    assert.equal(entry?.level, item.level, `level for ${item.ref}`);
  }

  // computeWatchdogEscalation mirrors transposer byte-for-byte at the boundaries.
  const anchor = (offsetMin: number) => new Date(now - offsetMin * MIN).toISOString();
  assert.equal(computeWatchdogEscalation(anchor(0), now).level, ESCALATION_LEVEL_WAIT); // open 0 < timeout
  assert.equal(computeWatchdogEscalation(anchor(4), now).level, ESCALATION_LEVEL_WAIT); // 4 < 5
  assert.equal(computeWatchdogEscalation(anchor(5), now).level, ESCALATION_LEVEL_AUTO); // 5 == timeout boundary
  assert.equal(computeWatchdogEscalation(anchor(9), now).level, ESCALATION_LEVEL_AUTO); // 5<=9<10
  assert.equal(computeWatchdogEscalation(anchor(10), now).level, ESCALATION_LEVEL_NUDGE_LLM); // 10 == llm boundary
  assert.equal(computeWatchdogEscalation(anchor(14), now).level, ESCALATION_LEVEL_NUDGE_LLM); // 10<=14<15
  assert.equal(computeWatchdogEscalation(anchor(15), now).level, ESCALATION_LEVEL_HUMAN_BLOCK); // 15 == human boundary
  // null anchor -> fail-safe human_block (never silently observe).
  assert.equal(computeWatchdogEscalation(null, now).level, ESCALATION_LEVEL_HUMAN_BLOCK);
  assert.equal(computeWatchdogEscalation(null, now).open_ms, Number.POSITIVE_INFINITY);
  // Budgets are configurable per call.
  assert.equal(
    computeWatchdogEscalation(anchor(1), now, { decision_timeout_ms: timeout, escalate_to_llm_ms: llm, escalate_to_human_ms: human }).decision_timeout_ms,
    timeout,
  );

  // Runner persists an event for auto / nudge_llm / human_block (NOT for wait),
  // and human_block carries noShip:true while the others carry noShip:false.
  const tick = runWorklistWatchdogTick(repo, scope, {}, { now });
  assert.equal(tick.emitted.length, 3);
  const noShipByLevel = new Map(tick.emitted.map((e) => [e.level, e.noShip]));
  assert.equal(noShipByLevel.get(ESCALATION_LEVEL_AUTO), false);
  assert.equal(noShipByLevel.get(ESCALATION_LEVEL_NUDGE_LLM), false);
  assert.equal(noShipByLevel.get(ESCALATION_LEVEL_HUMAN_BLOCK), true);

  // Directives remain un-mutated: the watchdog did not append worklist events/leases.
  assert.equal(store.listEvents().length, 3);
  assert.equal(store.listLeases().length, 0);
});

// ===========================================================================
// (5) A satisfied directive is DONE: it does not count as open and does not
//     block observe. (Mirrors transposer watch view: a closed task emits no
//     directive.) This proves the observe rule keys on GENUINELY-open work.
// ===========================================================================
test("watchdog: a satisfied directive is done and no longer blocks observe", () => {
  const scope = "ws-h3-satisfied";
  const store = openWorklistStore(repo, scope);
  const now = Date.now();
  const pastDeadline = new Date(now - 20 * MIN).toISOString();

  store.appendEvent({
    scope,
    reducer_id: GENERIC_WORKLIST_REDUCER_ID,
    kind: "OPEN",
    ref: "reports/ws-h3-satisfied/task.json",
    owner: "worker-s",
    deadline: pastDeadline,
  });
  const hash = store.listDirectives(now)[0].hash;
  store.claim(hash, "worker-s");
  store.satisfy(hash, "worker-s");

  // Pre-satisfy: would escalate. Post-satisfy: the directive is done -> observe.
  const evaluation = evaluateWorklistWatchdog(repo, scope, now);
  assert.equal(evaluation.directivesOpen, 0);
  assert.equal(evaluation.observe, true);
  assert.equal(evaluation.escalation.length, 0);
  assert.equal(evaluation.observe, !decisionPending(evaluation));

  // contentHash stability sanity (mirrors transposer directiveHash).
  const expected = directiveHash("ACT", "worker-s", [], pastDeadline);
  assert.equal(hash, expected);
});

// ===========================================================================
// (6) WS-EH3: a satisfiable-now directive (evidenceKind='accept') PAST its
//     deadline is flagged act_now and NEVER escalated. It is still OPEN (not
//     satisfied), so observe stays false (HARD RULE preserved) — the watchdog
//     just refuses to escalate a closable epoch. This is the exact fix for the
//     tickets stall class (the old watchdog mis-escalated a satisfiable claim to
//     human_block). The same holds for the other satisfiable-now kinds
//     ('reassign'/'rollback'); 'accept' is the canonical case.
// ===========================================================================
test("WS-EH3 watchdog: satisfiable-now (accept) directive past deadline is act_now, NEVER escalates", () => {
  const scope = "ws-eh3-accept";
  const store = openWorklistStore(repo, scope);
  const now = Date.now();
  // 20 min overdue -> openMs = 25min >= 15min(human). Under the OLD watchdog
  // this lands on human_block; under WS-EH3 the accept verdict short-circuits to
  // act_now and NEVER escalates.
  const pastDeadline = new Date(now - 20 * MIN).toISOString();

  store.appendEvent({
    scope,
    reducer_id: EH3_REDUCER_ID,
    kind: "OPEN",
    ref: "reports/ws-eh3-accept/task.json",
    owner: "accept", // the EH3 contract maps owner -> evidenceKind='accept'
    deadline: pastDeadline,
  });

  const projected = store.listDirectives(now)[0];
  // Sanity: the EH2 annotation pipeline populated evidenceKind='accept'.
  assert.equal(projected.evidenceKind, "accept");

  const evaluation = evaluateWorklistWatchdog(repo, scope, now);

  // HARD RULE preserved: the directive is still OPEN (not satisfied) -> observe
  // MUST be false. WS-EH3 does NOT change the openDirectives filter (still
  // !directive.satisfied).
  assert.equal(evaluation.observe, false);
  assert.equal(evaluation.directivesOpen, 1);
  assert.equal(evaluation.observe, !decisionPending(evaluation));

  // The directive is flagged act_now (closable NOW), NOT human_block/nudge_llm.
  assert.equal(evaluation.escalation.length, 1);
  assert.equal(evaluation.escalation[0].level, ESCALATION_LEVEL_ACT_NOW);
  assert.notEqual(evaluation.escalation[0].level, ESCALATION_LEVEL_HUMAN_BLOCK);
  assert.notEqual(evaluation.escalation[0].level, ESCALATION_LEVEL_NUDGE_LLM);
  assert.equal(evaluation.escalation[0].directive_hash, projected.hash);
  assert.equal(
    evaluation.escalation[0].reason,
    "watchdog:directive_satisfiable_now_act_immediately",
  );
  // Metadata-only posture preserved.
  assert.equal(evaluation.bodyStored, false);
  assert.equal(evaluation.localOnly, true);
  assert.equal(evaluation.networkEnabled, false);

  // The runner does NOT persist an escalation event for act_now (it is surfaced
  // in the escalation array only, never written to watchdog.jsonl as a
  // human_block — that would reintroduce the stall class).
  const tick = runWorklistWatchdogTick(repo, scope, {}, { now });
  assert.equal(tick.observe, false);
  assert.equal(tick.escalation.length, 1);
  assert.equal(tick.escalation[0].level, ESCALATION_LEVEL_ACT_NOW);
  assert.equal(tick.emitted.length, 0);
  // No watchdog.jsonl was written (act_now is not an escalation event).
  assert.equal(existsSync(join(repo, ".pi", "worklist", scope, "watchdog.jsonl")), false);
  assert.equal(listWatchdogEscalations(repo, scope).length, 0);

  // The watchdog did not mutate the append-only worklist state.
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.listLeases().length, 0);
});

// ===========================================================================
// (7) WS-EH3: an AWAITING directive (evidenceKind='await') PAST its deadline
//     escalates to human_block — the old behavior, now correctly scoped to
//     awaiting directives only. observe stays false (HARD RULE). This proves the
//     ramp is intact for directives that are genuinely waiting on evidence.
// ===========================================================================
test("WS-EH3 watchdog: awaiting (await) directive past deadline escalates to human_block", () => {
  const scope = "ws-eh3-await";
  const store = openWorklistStore(repo, scope);
  const now = Date.now();
  const pastDeadline = new Date(now - 20 * MIN).toISOString();

  store.appendEvent({
    scope,
    reducer_id: EH3_REDUCER_ID,
    kind: "OPEN",
    ref: "reports/ws-eh3-await/task.json",
    owner: "await", // the EH3 contract maps owner -> evidenceKind='await'
    deadline: pastDeadline,
  });

  const projected = store.listDirectives(now)[0];
  assert.equal(projected.evidenceKind, "await");

  const evaluation = evaluateWorklistWatchdog(repo, scope, now);

  // HARD RULE: open directive -> observe false.
  assert.equal(evaluation.observe, false);
  assert.equal(evaluation.directivesOpen, 1);
  assert.equal(evaluation.observe, !decisionPending(evaluation));

  // 'await' escalates the ramp as before -> human_block at 20min overdue.
  assert.equal(evaluation.escalation.length, 1);
  assert.equal(evaluation.escalation[0].level, ESCALATION_LEVEL_HUMAN_BLOCK);
  assert.notEqual(evaluation.escalation[0].level, ESCALATION_LEVEL_ACT_NOW);

  // The runner persists a governed no_ship escalation event (the old behavior,
  // now correctly scoped to awaiting directives).
  const tick = runWorklistWatchdogTick(repo, scope, {}, { now });
  assert.equal(tick.observe, false);
  assert.equal(tick.emitted.length, 1);
  assert.equal(tick.emitted[0].level, ESCALATION_LEVEL_HUMAN_BLOCK);
  assert.equal(tick.emitted[0].noShip, true);

  const log = readJsonl(`.pi/worklist/${scope}/watchdog.jsonl`);
  assert.equal(log.length, 1);
  assert.equal(listWatchdogEscalations(repo, scope).length, 1);
});

// ===========================================================================
// (8) WS-EH3 backward compat: a directive with NO evidenceKind (null/undefined —
//     the generic reducer with no contract) PAST its deadline escalates to
//     human_block exactly as before. WS-EH3 is additive: a directive the reducer
//     did not annotate is treated as await-eligible and escalates on deadline.
//     This guarantees the existing WS-H3 behavior is unchanged for scopes with
//     no EvidenceContract.
// ===========================================================================
test("WS-EH3 watchdog: null-evidenceKind directive past deadline escalates as before (backward compat)", () => {
  const scope = "ws-eh3-null";
  const store = openWorklistStore(repo, scope);
  const now = Date.now();
  const pastDeadline = new Date(now - 20 * MIN).toISOString();

  store.appendEvent({
    scope,
    reducer_id: GENERIC_WORKLIST_REDUCER_ID, // no contract -> evidenceKind stays undefined
    kind: "OPEN",
    ref: "reports/ws-eh3-null/task.json",
    owner: "worker-n",
    deadline: pastDeadline,
  });

  const projected = store.listDirectives(now)[0];
  // Backward compat: the generic reducer with no contract leaves evidenceKind
  // undefined (the directive is not annotated).
  assert.equal(projected.evidenceKind, undefined);

  const evaluation = evaluateWorklistWatchdog(repo, scope, now);

  // HARD RULE: open directive -> observe false.
  assert.equal(evaluation.observe, false);
  assert.equal(evaluation.directivesOpen, 1);
  assert.equal(evaluation.observe, !decisionPending(evaluation));

  // No evidenceKind -> await-eligible -> escalates to human_block as before.
  assert.equal(evaluation.escalation.length, 1);
  assert.equal(evaluation.escalation[0].level, ESCALATION_LEVEL_HUMAN_BLOCK);
  assert.notEqual(evaluation.escalation[0].level, ESCALATION_LEVEL_ACT_NOW);

  const tick = runWorklistWatchdogTick(repo, scope, {}, { now });
  assert.equal(tick.emitted.length, 1);
  assert.equal(tick.emitted[0].level, ESCALATION_LEVEL_HUMAN_BLOCK);
  assert.equal(tick.emitted[0].noShip, true);
});
