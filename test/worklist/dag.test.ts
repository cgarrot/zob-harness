import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  buildDag,
  buildDagOrThrow,
  butterflySeedNext,
  computeDownstreamImpact,
  dagBodyFreeViolations,
  detectCycle,
  isCrossScopeRef,
  parseCrossScopeRef,
  readDagState,
  readyNodes,
  resolveCrossScopeDependency,
  writeDagState,
  type CrossScopeResolver,
  type DagGraph,
  type DagNodeInput,
} from "../../.pi/extensions/zob-harness/index.ts";

let repo = "";

before(() => {
  repo = mkdtempSync(join(tmpdir(), "zob-worklist-dag-"));
});

after(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the temp repo */
  }
});

function graph(nodes: DagNodeInput[], scope?: string): DagGraph {
  return buildDagOrThrow(nodes, scope ? { scope } : undefined);
}

// (1) CYCLE DETECTION — a cyclic graph is rejected with the offending cycle.
test("dag: cycle detection rejects a cyclic graph", () => {
  // detectCycle operates on normalized DagNode[] (dependsOn). Build them inline so
  // the low-level helper is exercised directly, independent of buildDag.
  const cyclic = [
    { id: "a", scope: "default", dependsOn: ["c"], unblocks: [], status: "pending", owner: null },
    { id: "b", scope: "default", dependsOn: ["a"], unblocks: [], status: "pending", owner: null },
    { id: "c", scope: "default", dependsOn: ["b"], unblocks: [], status: "pending", owner: null },
  ];
  // detectCycle returns the offending path.
  const cycle = detectCycle(cyclic);
  assert.ok(cycle !== null, "detectCycle should find the cycle");
  assert.ok(cycle!.length >= 3, `cycle path should include the loop: ${cycle!.join(" -> ")}`);
  // The cycle's first and last node match (closed loop).
  assert.equal(cycle![0], cycle![cycle!.length - 1]);

  // buildDag rejects the cyclic graph WITHOUT throwing (result union).
  const result = buildDag([
    { id: "a", depends_on: ["c"] },
    { id: "b", depends_on: ["a"] },
    { id: "c", depends_on: ["b"] },
  ]);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; error: string }).error, /cycle/i);
  assert.ok((result as { ok: false; cycle: string[] | null }).cycle !== null);

  // buildDagOrThrow DOES throw on the cyclic graph.
  assert.throws(
    () =>
      buildDagOrThrow([
        { id: "a", depends_on: ["c"] },
        { id: "b", depends_on: ["a"] },
        { id: "c", depends_on: ["b"] },
      ]),
    /cycle/i,
  );

  // The acyclic form of the same nodes builds cleanly.
  const acyclic = buildDag([
    { id: "a" },
    { id: "b", depends_on: ["a"] },
    { id: "c", depends_on: ["b"] },
  ]);
  assert.equal(acyclic.ok, true);
});

// (2) DOWNSTREAM IMPACT — node -> done unblocks dependents whose deps are all
// satisfied (the generalized butterfly: A done -> B ready -> ... one layer).
test("dag: node->done unblocks dependents whose deps are all satisfied (generalized butterfly)", () => {
  // Linear chain A -> B -> C (B depends on A; C depends on B). All pending.
  const g = graph([
    { id: "a" },
    { id: "b", depends_on: ["a"] },
    { id: "c", depends_on: ["b"] },
  ]);

  // A becomes done -> B's single dep (A) is satisfied -> B unblocked.
  // C still waits on B (not done) -> C NOT unblocked.
  const impact = computeDownstreamImpact(g, "a", "done");
  assert.deepEqual(impact.unblocked, ["b"]);
  assert.deepEqual(impact.invalidated, []);
  assert.deepEqual(impact.reprioritized, []);

  // Diamond: A -> {B, C} -> D. Marking A done unblocks BOTH B and C (each has
  // only A as a direct dep). D depends on B and C, NOT directly on A, so D is
  // neither unblocked nor reprioritized by THIS impact (it is a transitive dep).
  const diamond = graph([
    { id: "a" },
    { id: "b", depends_on: ["a"] },
    { id: "c", depends_on: ["a"] },
    { id: "d", depends_on: ["b", "c"] },
  ]);
  const diamondImpact = computeDownstreamImpact(diamond, "a", "done");
  assert.deepEqual(diamondImpact.unblocked.sort(), ["b", "c"]);
  assert.deepEqual(diamondImpact.reprioritized, []);

  // REPRIORITIZED: node M depends on [P, Q]. Marking P done leaves Q pending, so M
  // is NOT unblocked but is one step closer -> reprioritized.
  const multi = graph([
    { id: "p" },
    { id: "q" },
    { id: "m", depends_on: ["p", "q"] },
  ]);
  const multiImpact = computeDownstreamImpact(multi, "p", "done");
  assert.deepEqual(multiImpact.unblocked, []);
  assert.deepEqual(multiImpact.reprioritized, ["m"]);
});

// (3) INVALIDATION CASCADE — node -> invalidated cascades invalidation to
// downstream dependents (transitively, through non-done nodes).
test("dag: node->invalidated cascades invalidation to dependents", () => {
  // Linear chain A -> B -> C. Invalidating A poisons B and C transitively.
  const g = graph([
    { id: "a" },
    { id: "b", depends_on: ["a"] },
    { id: "c", depends_on: ["b"] },
  ]);

  const impact = computeDownstreamImpact(g, "a", "invalidated");
  assert.deepEqual(impact.unblocked, []);
  assert.deepEqual(impact.reprioritized, []);
  assert.deepEqual(impact.invalidated.sort(), ["b", "c"]);

  // Done is terminal: invalidation does NOT cascade through a completed node.
  //   A(done) -> B(done) -> C(pending). Invalidating A does not poison C because
  //   B is done (the absorbant-lattice rule: completed work is not regressed).
  const terminal = graph([
    { id: "a", status: "done" },
    { id: "b", status: "done", depends_on: ["a"] },
    { id: "c", depends_on: ["b"] },
  ]);
  const terminalImpact = computeDownstreamImpact(terminal, "a", "invalidated");
  assert.deepEqual(terminalImpact.invalidated, []);
});

// (4) CROSS-SCOPE FEDERATION — a node in scope A with depends_on=['scopeB:nodeX']
// resolves via the injected resolver when scopeB's nodeX is done -> node A becomes
// unblocked. No P2P messaging: the pure core consults the resolver callback.
test("dag: cross-scope depends_on resolves via the injected resolver -> node unblocked", () => {
  // Node A depends on a LOCAL node `trigger` AND a cross-scope ref `scopeB:nodeX`.
  const nodes: DagNodeInput[] = [
    { id: "trigger", scope: "scopeA" },
    { id: "a", scope: "scopeA", depends_on: ["trigger", "scopeB:nodeX"] },
  ];
  const g = graph(nodes, "scopeA");

  // The cross-scope ref is parsed and recognized as cross-scope.
  assert.equal(isCrossScopeRef("scopeB:nodeX"), true);
  assert.deepEqual(parseCrossScopeRef("scopeB:nodeX"), { scope: "scopeB", nodeId: "nodeX" });
  assert.equal(isCrossScopeRef("trigger"), false);

  // WITHOUT a resolver: marking `trigger` done leaves A's cross-scope dep unsatisfied
  // -> A is NOT unblocked (it is reprioritized: one more local dep cleared).
  const noResolver = computeDownstreamImpact(g, "trigger", "done");
  assert.deepEqual(noResolver.unblocked, []);
  assert.deepEqual(noResolver.reprioritized, ["a"]);

  // WITH a resolver that reports scopeB:nodeX as done: A's deps are all satisfied
  // -> A becomes unblocked.
  const resolver: CrossScopeResolver = (ref) => (ref === "scopeB:nodeX" ? "done" : null);
  const withResolver = computeDownstreamImpact(g, "trigger", "done", resolver);
  assert.deepEqual(withResolver.unblocked, ["a"]);

  // readyNodes also honors the resolver: A is ready only when its cross-scope dep
  // is satisfied. `trigger` (no deps) is itself ready, so we assert specifically
  // about node A.
  assert.equal(readyNodes(g).some((node) => node.id === "a"), false); // A blocked on cross-scope
  const gTriggerDone = graph(
    [
      { id: "trigger", scope: "scopeA", status: "done" },
      { id: "a", scope: "scopeA", depends_on: ["trigger", "scopeB:nodeX"] },
    ],
    "scopeA",
  );
  assert.equal(readyNodes(gTriggerDone).length, 0); // still needs cross-scope dep
  assert.deepEqual(readyNodes(gTriggerDone, resolver).map((node) => node.id), ["a"]);
});

// (5) BUTTERFLY SEED NEXT — after an accept (done), returns the correct next
// node(s) to seed (generalizes nonCompletePhaseAfter over a non-linear DAG).
test("dag: butterflySeedNext returns the correct next node(s) to seed after an accept", () => {
  // Linear roadmap A -> B -> C (the transposer shape). After A is accepted, B is
  // the next seedable node; after B is accepted, C is.
  const linear = graph([
    { id: "a", owner: "team-1" },
    { id: "b", depends_on: ["a"], owner: "team-2" },
    { id: "c", depends_on: ["b"], owner: "team-3" },
  ]);

  let seed = butterflySeedNext(linear, "a");
  assert.deepEqual(seed.map((node) => node.id), ["b"]);
  assert.equal(seed[0].owner, "team-2"); // owner carried for the seed assignment

  // Mark B done (accepted), then seed next -> C.
  const linearBdone = graph([
    { id: "a", status: "done", owner: "team-1" },
    { id: "b", status: "done", depends_on: ["a"], owner: "team-2" },
    { id: "c", depends_on: ["b"], owner: "team-3" },
  ]);
  seed = butterflySeedNext(linearBdone, "b");
  assert.deepEqual(seed.map((node) => node.id), ["c"]);

  // Fan-out: A accepted -> seed BOTH B and C (deterministic order by id).
  const fanOut = graph([
    { id: "a" },
    { id: "c", depends_on: ["a"] },
    { id: "b", depends_on: ["a"] },
  ]);
  seed = butterflySeedNext(fanOut, "a");
  assert.deepEqual(seed.map((node) => node.id), ["b", "c"]);

  // Convergence: D depends on B and C. After BOTH B and C are done, seeding the
  // last-done one (C) unblocks D.
  const converge = graph([
    { id: "a", status: "done" },
    { id: "b", status: "done", depends_on: ["a"] },
    { id: "c", status: "done", depends_on: ["a"] },
    { id: "d", depends_on: ["b", "c"] },
  ]);
  seed = butterflySeedNext(converge, "c");
  assert.deepEqual(seed.map((node) => node.id), ["d"]);

  // A node already in_progress / done / invalidated is not re-seeded.
  const inFlight = graph([
    { id: "a", status: "done" },
    { id: "b", status: "in_progress", depends_on: ["a"] },
    { id: "c", status: "invalidated", depends_on: ["a"] },
  ]);
  seed = butterflySeedNext(inFlight, "a");
  assert.deepEqual(seed, []);
});

// (6) FEDERATION IO + BODY-FREE STATE — resolveCrossScopeDependency reads the
// other scope's persisted dag.json (a read, NOT a message); dag state is
// metadata-only/body-free/network-disabled.
test("dag: cross-scope federation reads the other scope's dag.json projection; state is body-free", () => {
  // Persist scopeB's DAG with nodeX = done.
  const scopeB = graph([{ id: "nodeX", status: "done", owner: "team-b" }], "scopeB");
  const state = writeDagState(repo, "scopeB", scopeB);

  // Metadata-only posture.
  assert.equal(state.bodyStored, false);
  assert.equal(state.promptBodiesStored, false);
  assert.equal(state.outputBodiesStored, false);
  assert.equal(state.localOnly, true);
  assert.equal(state.networkEnabled, false);
  assert.ok(state.fingerprint.length === 64);
  assert.ok(existsSync(join(repo, ".pi", "worklist", "scopeB", "dag.json")));

  // The persisted file is body-free.
  const persisted = JSON.parse(readFileSync(join(repo, ".pi", "worklist", "scopeB", "dag.json"), "utf8")) as unknown;
  assert.deepEqual(dagBodyFreeViolations(persisted), []);

  // resolveCrossScopeDependency READS scopeB's projection -> nodeX is done.
  assert.equal(resolveCrossScopeDependency(repo, "scopeB:nodeX"), "done");
  // Unknown node / unknown scope -> null (no fabricated status).
  assert.equal(resolveCrossScopeDependency(repo, "scopeB:missing"), null);
  assert.equal(resolveCrossScopeDependency(repo, "scopeUnknown:nodeX"), null);

  // Round-trip readDagState.
  const reloaded = readDagState(repo, "scopeB");
  assert.ok(reloaded);
  assert.equal(reloaded!.nodeCount, 1);
  assert.equal(reloaded!.nodes[0].id, "nodeX");
  assert.equal(reloaded!.nodes[0].status, "done");

  // The store-backed resolver composed from resolveCrossScopeDependency makes a
  // cross-scope-only node in scopeA unblock when scopeB:nodeX is done.
  const resolver: CrossScopeResolver = (ref) => resolveCrossScopeDependency(repo, ref);
  const scopeA = graph([{ id: "a", depends_on: ["scopeB:nodeX"] }], "scopeA");
  // No local trigger exists; readyNodes still honors the cross-scope resolver.
  assert.deepEqual(readyNodes(scopeA, resolver).map((node) => node.id), ["a"]);
});
