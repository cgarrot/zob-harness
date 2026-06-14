import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  directiveHash,
  openWorklistStore,
  recoverStaleWorklistLeases,
  GENERIC_WORKLIST_REDUCER_ID,
  validateWorklist,
  type WorklistStore,
} from "../../.pi/extensions/zob-harness/index.ts";

let repo = "";
let stores: WorklistStore[] = [];

before(() => {
  repo = mkdtempSync(join(tmpdir(), "zob-worklist-"));
});

after(() => {
  for (const store of stores) {
    try {
      store.validate();
    } catch {
      /* best-effort */
    }
  }
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the temp repo */
  }
});

function readLines(rel: string): unknown[] {
  return readFileSync(join(repo, rel), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// (a) append -> project -> directive roundtrip; contentHash mirrors transposer.
test("worklist: append OPEN event projects a directive with a stable content hash", () => {
  const scope = "run-alpha";
  const store = openWorklistStore(repo, scope);
  stores.push(store);
  const past = new Date(Date.now() - 1000).toISOString();

  const event = store.appendEvent({
    scope,
    reducer_id: GENERIC_WORKLIST_REDUCER_ID,
    kind: "OPEN",
    ref: "reports/run-alpha/task-1.json",
    owner: "worker-a",
    reason_ref: "reports/run-alpha/reason-1.json",
    evidence_refs: ["reports/run-alpha/evidence-1.json"],
    deadline: past,
  });

  // Metadata-only posture on every persisted record.
  assert.equal(event.bodyStored, false);
  assert.equal(event.promptBodiesStored, false);
  assert.equal(event.outputBodiesStored, false);
  assert.equal(event.localOnly, true);
  assert.equal(event.networkEnabled, false);
  assert.equal(event.seq, 0);

  const directives = store.listDirectives();
  assert.equal(directives.length, 1);
  const directive = directives[0];
  assert.equal(directive.action, "ACT");
  assert.equal(directive.owner, "worker-a");
  assert.equal(directive.ref, "reports/run-alpha/task-1.json");
  assert.deepEqual(directive.evidenceRequired, ["reports/run-alpha/evidence-1.json"]);
  assert.equal(directive.claimed, false);
  assert.equal(directive.satisfied, false);

  // contentHash mirrors transposer directiveHash() over canonicalized
  // { action, owner, evidence_refs(sorted), deadline } — stable across re-derivation.
  const expectedHash = directiveHash("ACT", "worker-a", ["reports/run-alpha/evidence-1.json"], past);
  assert.equal(directive.hash, expectedHash);
  assert.equal(store.listDirectives()[0].hash, expectedHash);

  // The derived projection file was written and is body-free.
  assert.ok(existsSync(join(repo, ".pi", "worklist", scope, "directives.json")));
  assert.ok(existsSync(join(repo, ".pi", "worklist", scope, "events.jsonl")));
});

// (b) idempotent claim/satisfy by hash — double-satisfy is a noop.
test("worklist: claim and idempotent satisfy by directive hash (double-satisfy is a noop)", () => {
  const scope = "run-beta";
  const store = openWorklistStore(repo, scope, { leaseMs: 60_000 });
  stores.push(store);
  const past = new Date(Date.now() - 1000).toISOString();

  store.appendEvent({
    scope,
    reducer_id: GENERIC_WORKLIST_REDUCER_ID,
    kind: "OPEN",
    ref: "reports/run-beta/task.json",
    owner: "worker-b",
    deadline: past,
  });
  const hash = store.listDirectives()[0].hash;

  const lease = store.claim(hash, "worker-b");
  assert.equal(lease.status, "claimed");
  assert.equal(lease.directiveHash, hash);
  assert.ok(lease.leaseMs > 0);
  assert.equal(lease.bodyStored, false);
  assert.ok(Date.parse(lease.expiresAt) > Date.parse(lease.claimedAt));

  // The directive now projects as claimed by worker-b.
  const claimed = store.listDirectives().find((directive) => directive.hash === hash);
  assert.equal(claimed?.claimed, true);
  assert.equal(claimed?.claimant, "worker-b");

  // Satisfy, then satisfy again — double-satisfy is an idempotent noop.
  const satisfied = store.satisfy(hash, "worker-b");
  assert.equal(satisfied.status, "satisfied");
  assert.equal(satisfied.satisfiedAt !== null, true);

  const again = store.satisfy(hash, "worker-b");
  assert.equal(again.status, "satisfied");
  assert.equal(again.leaseId, satisfied.leaseId);

  // No extra satisfy snapshot was appended for the idempotent second satisfy.
  const leases = readLines(`.pi/worklist/${scope}/leases.jsonl`);
  const satisfiedSnapshots = leases.filter((entry) => (entry as { status?: string }).status === "satisfied");
  assert.equal(satisfiedSnapshots.length, 1);

  // The directive now projects as satisfied (not claimed).
  const afterSatisfy = store.listDirectives().find((directive) => directive.hash === hash);
  assert.equal(afterSatisfy?.satisfied, true);
  assert.equal(afterSatisfy?.claimed, false);

  // Scope stays internally consistent.
  const validation = validateWorklist(repo, scope);
  assert.equal(validation.healthy, true);
  assert.equal(validation.violations.length, 0);
});

// (c) stale-lease recovery re-queues an expired claimed directive to open.
test("worklist: stale-lease recovery re-queues an expired claimed directive to open", () => {
  const scope = "run-gamma";
  const baseNow = 1_700_000_000_000;
  const store = openWorklistStore(repo, scope, { leaseMs: 1_000, now: () => baseNow });
  stores.push(store);
  const past = new Date(baseNow - 1_000).toISOString();

  store.appendEvent({
    scope,
    reducer_id: GENERIC_WORKLIST_REDUCER_ID,
    kind: "OPEN",
    ref: "reports/run-gamma/task.json",
    owner: "worker-c",
    deadline: past,
  });
  const hash = store.listDirectives(baseNow)[0].hash;

  // Claim at baseNow (1s lease). Directive is claimed.
  const lease = store.claim(hash, "worker-c", { now: baseNow });
  assert.equal(lease.status, "claimed");
  assert.equal(store.listDirectives(baseNow).find((directive) => directive.hash === hash)?.claimed, true);

  // Advance the clock past the lease expiry.
  const later = baseNow + 5_000;
  const recovered = recoverStaleWorklistLeases(repo, scope, later);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "expired");
  assert.equal(recovered[0].leaseId, lease.leaseId);

  // The directive is re-queued to open: no active claim, not satisfied.
  const reopened = store.listDirectives(later).find((directive) => directive.hash === hash);
  assert.equal(reopened?.claimed, false);
  assert.equal(reopened?.satisfied, false);

  // The recovered directive can be claimed again by a fresh lease.
  const reClaimed = store.claim(hash, "worker-c", { now: later });
  assert.equal(reClaimed.status, "claimed");
  assert.notEqual(reClaimed.leaseId, lease.leaseId);
  assert.equal(store.listDirectives(later).find((directive) => directive.hash === hash)?.claimed, true);
});

// Bonus: append rejects forbidden plaintext keys and an unknown reducer_id.
test("worklist: append rejects forbidden plaintext keys and unknown reducer_id", () => {
  const scope = "run-delta";
  const store = openWorklistStore(repo, scope);
  stores.push(store);

  assert.throws(
    () =>
      store.appendEvent({
        scope,
        kind: "OPEN",
        // @ts-expect-error intentionally injecting a forbidden raw field
        prompt: "do the thing",
        owner: "worker-d",
      }),
    /forbidden plaintext/,
  );

  assert.throws(
    () =>
      store.appendEvent({
        scope,
        reducer_id: "does-not-exist",
        kind: "OPEN",
        owner: "worker-d",
      }),
    /Unknown worklist reducer_id/,
  );
});
