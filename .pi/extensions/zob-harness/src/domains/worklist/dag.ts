// ZOB Harness — Worklist generic dependency DAG (WS-H4).
//
// A GENERIC dependency-DAG primitive that generalizes the proven
// project-transposer "butterfly" rule. The transposer handoff-state.mjs rule is:
//   PHASE_ACCEPTED.v1 -> nonCompletePhaseAfter(roadmap, acceptedPhase) -> seed the
//   next non-complete phase's assignment (next_phase / next_owner /
//   expected_next_event). That is a LINEAR roadmap traversal: "after a phase is
//   accepted, find the next phase whose deps are satisfied and seed it".
//
// WS-H4 extracts the GRAPH GENERIC behind that rule. A node's dependencies are an
// arbitrary DAG (not a linear roadmap), and a dependency may live in ANOTHER
// worklist scope (cross-project federation). The three pure primitives are:
//   - buildDag(nodes)             -> validated graph (cycle detection -> error)
//   - computeDownstreamImpact(...) -> { unblocked, invalidated, reprioritized }
//   - butterflySeedNext(...)       -> the next seedable node(s) after an accept
//
// CROSS-PROJECT FEDERATION: a node's depends_on entry may be a content-addressed
// ref of the form `scope:nodeId` referencing ANOTHER worklist scope's DAG. The pure
// core is parameterized over an optional CrossScopeResolver callback so the harness
// can pass a store-backed resolver. resolveCrossScopeDependency(repoRoot, ref) is
// the concrete resolver: it reads the OTHER scope's persisted dag.json projection
// and returns that node's status. This is inter-project coordination WITHOUT P2P
// messaging — a node in scope A depending on scopeB:nodeX READS B's projection; no
// message is ever sent. (Mirrors the worklist's read-the-projection convention.)
//
// PURITY CONTRACT: this module imports ONLY from src/core/** + sibling ./types.js.
// No runtime or @earendil-works/pi-coding-agent imports, so projections can reuse
// the generic DAG without pulling the harness runtime. The IO helpers
// (writeDagState / readDagState / resolveCrossScopeDependency) use only core utils
// (readJsonObjectIfPresent) + node:fs/path; they never read/write bodies.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../../core/utils/hashing.js";
import { readJsonObjectIfPresent } from "../../core/utils/json.js";
import { isRecord } from "../../core/utils/records.js";
import { FORBIDDEN_PLAINTEXT_KEYS } from "./types.js";

export const WORKLIST_DAG_SCHEMA = "zob.worklist-dag.v1";
export const WORKLIST_DAG_STATE_SCHEMA = "zob.worklist-dag-state.v1";

export type DagNodeStatus = "pending" | "in_progress" | "done" | "blocked" | "invalidated";

export const DAG_STATUSES: readonly DagNodeStatus[] = ["pending", "in_progress", "done", "blocked", "invalidated"] as const;
const DAG_STATUS_SET = new Set<string>(DAG_STATUSES);

// Cross-scope ref: "scope:nodeId". A depends_on entry WITHOUT a colon is a LOCAL
// node id (must exist in this graph); WITH a colon it references another scope.
const CROSS_SCOPE_REF = /^([A-Za-z0-9._-]+):(.+)$/;
const SLUG = /^[A-Za-z0-9._-]+$/;

function isSlug(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && SLUG.test(value);
}

function isDagStatus(value: unknown): value is DagNodeStatus {
  return typeof value === "string" && DAG_STATUS_SET.has(value);
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text.length === 0) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

// --- Node types ---------------------------------------------------------------

export interface DagNodeInput {
  id: string;
  /** Node's scope. Defaults to the graph's primary scope. */
  scope?: string;
  /** Dependency refs: local node ids and/or cross-scope `scope:nodeId` refs. */
  depends_on?: string[];
  /** Optional explicit reverse-edge hints (canonical edge source is depends_on). */
  unblocks?: string[];
  /** Node status. Defaults to "pending". */
  status?: DagNodeStatus;
  /** Owner role id (nullable). */
  owner?: string | null;
}

export interface DagNode {
  id: string;
  scope: string;
  dependsOn: string[];
  unblocks: string[];
  status: DagNodeStatus;
  owner: string | null;
}

export interface DagGraph {
  schema: typeof WORKLIST_DAG_SCHEMA;
  /** Primary scope of this graph. */
  scope: string;
  /** Nodes keyed by local node id. */
  nodes: Record<string, DagNode>;
  /** Deterministic node-id order (sorted). */
  nodeIds: string[];
  /** Reverse adjacency: localNodeId -> local node ids that depend on it. */
  dependents: Record<string, string[]>;
}

export type DagBuildResult =
  | { ok: true; graph: DagGraph }
  | { ok: false; error: string; cycle: string[] | null };

/** A dep-ref resolver for cross-scope dependencies. Returns the referenced node's status, or null if unknown. */
export type CrossScopeResolver = (ref: string) => DagNodeStatus | null;

export interface DownstreamImpact {
  /** Node ids newly ready to seed: all deps now done, status was pending/blocked. */
  unblocked: string[];
  /** Node ids cascaded to invalidated by an upstream invalidation/block (transitive). */
  invalidated: string[];
  /** Node ids still not-ready but one step closer: a dep cleared but others remain pending. */
  reprioritized: string[];
}

// Persisted DAG state (metadata-only, body-free, network-disabled).
export interface DagState {
  schema: typeof WORKLIST_DAG_STATE_SCHEMA;
  scope: string;
  nodes: DagNode[];
  nodeCount: number;
  /** Content-addressed fingerprint over canonical node summaries. */
  fingerprint: string;
  updatedAt: string;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  localOnly: true;
  networkEnabled: false;
}

// --- Cross-scope ref helpers --------------------------------------------------

export function isCrossScopeRef(ref: string): boolean {
  return typeof ref === "string" && CROSS_SCOPE_REF.test(ref);
}

export function parseCrossScopeRef(ref: string): { scope: string; nodeId: string } | null {
  if (typeof ref !== "string") return null;
  const match = CROSS_SCOPE_REF.exec(ref);
  if (!match) return null;
  return { scope: match[1], nodeId: match[2] };
}

// --- Body-free guard (mirrors worklistBodyFreeViolations) ---------------------

export function dagBodyFreeViolations(value: unknown): string[] {
  const violations: string[] = [];
  const visit = (item: unknown, path: string): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) visit(item[index], `${path}[${index}]`);
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (FORBIDDEN_PLAINTEXT_KEYS.has(key)) violations.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "root");
  return violations;
}

// --- Normalization ------------------------------------------------------------

function normalizeNode(input: Record<string, unknown>, defaultScope: string): DagNode {
  const id = String(input.id ?? "").trim();
  const scopeValue = input.scope;
  const ownerValue = input.owner;
  return {
    id,
    scope: typeof scopeValue === "string" && scopeValue.length > 0 ? scopeValue : defaultScope,
    dependsOn: uniqueStrings(input.depends_on),
    unblocks: uniqueStrings(input.unblocks),
    status: isDagStatus(input.status) ? (input.status as DagNodeStatus) : "pending",
    owner: typeof ownerValue === "string" && ownerValue.length > 0 ? ownerValue : null,
  };
}

// --- Cycle detection ----------------------------------------------------------
//
// DFS over the LOCAL depends_on edges (cross-scope refs are not in this graph and
// cannot form a local cycle). Returns the offending cycle path (node ids, with the
// repeated start node at the end) or null when the graph is acyclic.
export function detectCycle(nodes: readonly DagNode[]): string[] | null {
  const ids = new Set(nodes.map((node) => node.id));
  const adj: Record<string, string[]> = {};
  for (const node of nodes) {
    adj[node.id] = node.dependsOn.filter((dep) => !isCrossScopeRef(dep) && ids.has(dep));
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color: Record<string, number> = {};
  const stack: string[] = [];
  let found: string[] | null = null;

  const dfs = (start: string): boolean => {
    color[start] = GRAY;
    stack.push(start);
    for (const next of adj[start] ?? []) {
      const nextColor = color[next] ?? WHITE;
      if (nextColor === GRAY) {
        const startIndex = stack.indexOf(next);
        found = stack.slice(startIndex).concat(next);
        return true;
      }
      if (nextColor === WHITE) {
        if (dfs(next)) return true;
      }
    }
    stack.pop();
    color[start] = BLACK;
    return false;
  };

  for (const node of nodes) {
    if ((color[node.id] ?? WHITE) === WHITE) {
      if (dfs(node.id)) return found;
    }
  }
  return null;
}

// --- buildDag -----------------------------------------------------------------

export function buildDag(inputs: readonly DagNodeInput[], options: { scope?: string } = {}): DagBuildResult {
  const rawNodes = Array.isArray(inputs) ? inputs : [];
  const errors: string[] = [];

  const explicitScope = typeof options.scope === "string" && options.scope.length > 0 ? options.scope : undefined;
  const defaultScope = explicitScope ?? rawNodes.find((node) => typeof node?.scope === "string" && node.scope.length > 0)?.scope ?? "default";
  if (!isSlug(defaultScope)) errors.push(`dag scope must be slug-safe: ${defaultScope}`);

  const nodes: DagNode[] = [];
  const seenIds = new Set<string>();
  for (const input of rawNodes) {
    if (!isRecord(input)) {
      errors.push("dag node must be an object");
      continue;
    }
    const node = normalizeNode(input, defaultScope);
    if (!isSlug(node.id)) errors.push(`dag node id must be slug-safe (no colons/slashes): ${JSON.stringify(node.id)}`);
    if (seenIds.has(node.id)) errors.push(`duplicate dag node id: ${node.id}`);
    seenIds.add(node.id);
    nodes.push(node);
  }

  // Validate local depends_on refs exist; cross-scope refs are deferred to the resolver.
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (isCrossScopeRef(dep)) continue;
      if (!seenIds.has(dep)) errors.push(`dag node '${node.id}' depends_on unknown local node '${dep}'`);
    }
    for (const bodyViolation of dagBodyFreeViolations(node)) errors.push(`dag node '${node.id}' forbidden plaintext: ${bodyViolation}`);
  }

  if (errors.length > 0) return { ok: false, error: errors.join("; "), cycle: null };

  const cycle = detectCycle(nodes);
  if (cycle) return { ok: false, error: `dag cycle detected: ${cycle.join(" -> ")}`, cycle };

  const nodesRecord: Record<string, DagNode> = {};
  for (const node of nodes) nodesRecord[node.id] = node;

  // Reverse adjacency (dependents) from depends_on; sorted deterministically.
  const dependents: Record<string, string[]> = {};
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (isCrossScopeRef(dep)) continue;
      (dependents[dep] ??= []).push(node.id);
    }
  }
  for (const key of Object.keys(dependents)) dependents[key] = [...new Set(dependents[key])].sort();

  const nodeIds = nodes.map((node) => node.id).sort((a, b) => a.localeCompare(b));

  return {
    ok: true,
    graph: { schema: WORKLIST_DAG_SCHEMA, scope: defaultScope, nodes: nodesRecord, nodeIds, dependents },
  };
}

export function buildDagOrThrow(inputs: readonly DagNodeInput[], options?: { scope?: string }): DagGraph {
  const result = buildDag(inputs, options);
  if (!result.ok) throw new Error(result.error);
  return result.graph;
}

// --- Dependency satisfaction (the resolver seam) ------------------------------

export function dependencySatisfied(graph: DagGraph, ref: string, resolver?: CrossScopeResolver): boolean {
  if (isCrossScopeRef(ref)) {
    if (!resolver) return false;
    return resolver(ref) === "done";
  }
  return graph.nodes[ref]?.status === "done";
}

export function nodeDepsSatisfied(graph: DagGraph, nodeId: string, resolver?: CrossScopeResolver): boolean {
  const node = graph.nodes[nodeId];
  if (!node) return false;
  return node.dependsOn.every((dep) => dependencySatisfied(graph, dep, resolver));
}

/** Nodes that are pending and whose deps are ALL satisfied (ready to seed). */
export function readyNodes(graph: DagGraph, resolver?: CrossScopeResolver): DagNode[] {
  return graph.nodeIds
    .map((id) => graph.nodes[id])
    .filter((node) => node.status === "pending" && nodeDepsSatisfied(graph, node.id, resolver));
}

// --- computeDownstreamImpact --------------------------------------------------
//
// Generalized butterfly impact of a single node status change:
//   - node -> "done": direct dependents whose deps are ALL now satisfied become
//     `unblocked`; dependents that got closer (this dep cleared, others pending)
//     become `reprioritized`. This is the generalized
//     nonCompletePhaseAfter: "after X is done, its dependents whose deps are all
//     satisfied become ready".
//   - node -> "invalidated" | "blocked": transitive downstream (non-done)
//     dependents become `invalidated`. (Done is terminal: invalidation does not
//     cascade through already-completed work — mirrors the absorbant lattice.)
//   - node -> "pending" | "in_progress": no structural downstream change.
//
// Pure over (graph, nodeId, newStatus, resolver). Does NOT mutate the input graph.
export function computeDownstreamImpact(
  graph: DagGraph,
  nodeId: string,
  newStatus: DagNodeStatus,
  resolver?: CrossScopeResolver,
): DownstreamImpact {
  const node = graph.nodes[nodeId];
  if (!node) return { unblocked: [], invalidated: [], reprioritized: [] };

  // Working graph reflects the change so nodeDepsSatisfied sees the new status.
  const workingGraph: DagGraph = {
    ...graph,
    nodes: { ...graph.nodes, [nodeId]: { ...node, status: newStatus } },
  };

  if (newStatus === "done") {
    const unblocked: string[] = [];
    const reprioritized: string[] = [];
    for (const dependentId of graph.dependents[nodeId] ?? []) {
      const dependent = graph.nodes[dependentId];
      if (!dependent) continue;
      // Skip terminal/non-seedable dependents.
      if (dependent.status === "done" || dependent.status === "invalidated") continue;
      const nowReady = nodeDepsSatisfied(workingGraph, dependentId, resolver);
      if (nowReady) unblocked.push(dependentId);
      else reprioritized.push(dependentId);
    }
    return { unblocked: unblocked.sort((a, b) => a.localeCompare(b)), invalidated: [], reprioritized: reprioritized.sort((a, b) => a.localeCompare(b)) };
  }

  if (newStatus === "invalidated" || newStatus === "blocked") {
    // Transitive cascade through non-done dependents (BFS).
    const invalidated: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [...(graph.dependents[nodeId] ?? [])];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (visited.has(current)) continue;
      visited.add(current);
      const currentNode = graph.nodes[current];
      if (!currentNode) continue;
      if (currentNode.status === "done") continue; // terminal: do not invalidate completed work
      invalidated.push(current);
      for (const next of graph.dependents[current] ?? []) queue.push(next);
    }
    return { unblocked: [], invalidated: invalidated.sort((a, b) => a.localeCompare(b)), reprioritized: [] };
  }

  // pending / in_progress: no downstream structural change.
  return { unblocked: [], invalidated: [], reprioritized: [] };
}

// --- butterflySeedNext --------------------------------------------------------
//
// Generalized nonCompletePhaseAfter(roadmap, acceptedPhase): after a node is
// ACCEPTED (done), return the next node(s) to SEED — its direct dependents whose
// deps are ALL satisfied (local done or cross-scope resolver=done) and that are
// themselves seedable (status pending). A DAG is non-linear, so this can return
// multiple candidates; they are sorted deterministically by id. Each returned node
// carries its owner for the seed assignment (mirrors next_owner seeding).
export function butterflySeedNext(graph: DagGraph, acceptedNodeId: string, resolver?: CrossScopeResolver): DagNode[] {
  const accepted = graph.nodes[acceptedNodeId];
  if (!accepted) return [];
  // Treat the accepted node as done for the satisfaction check.
  const workingGraph: DagGraph = {
    ...graph,
    nodes: { ...graph.nodes, [acceptedNodeId]: { ...accepted, status: "done" } },
  };
  const seed: DagNode[] = [];
  for (const dependentId of graph.dependents[acceptedNodeId] ?? []) {
    const dependent = graph.nodes[dependentId];
    if (!dependent) continue;
    if (dependent.status !== "pending") continue; // already seeded / done / invalidated / blocked
    if (nodeDepsSatisfied(workingGraph, dependentId, resolver)) seed.push(dependent);
  }
  return seed.sort((a, b) => a.id.localeCompare(b.id));
}

// --- Content-addressed fingerprint -------------------------------------------

export function dagFingerprint(nodes: readonly DagNode[]): string {
  const summaries = nodes
    .map((node) => ({
      id: node.id,
      scope: node.scope,
      status: node.status,
      depends_on: [...node.dependsOn].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(JSON.stringify(summaries));
}

// --- Persisted DAG state (metadata-only, body-free) ---------------------------

function dagStatePath(repoRoot: string, scope: string): string {
  return join(repoRoot, ".pi", "worklist", scope, "dag.json");
}

function validateScope(scope: string): string[] {
  const errors: string[] = [];
  if (!isSlug(scope)) errors.push(`scope must be slug-safe: ${scope}`);
  return errors;
}

export function writeDagState(repoRoot: string, scope: string, graph: DagGraph): DagState {
  const errors = validateScope(scope);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const nodes = graph.nodeIds.map((id) => graph.nodes[id]);
  const state: DagState = {
    schema: WORKLIST_DAG_STATE_SCHEMA,
    scope,
    nodes,
    nodeCount: nodes.length,
    fingerprint: dagFingerprint(nodes),
    updatedAt: new Date().toISOString(),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    localOnly: true,
    networkEnabled: false,
  };
  const violations = dagBodyFreeViolations(state);
  if (violations.length > 0) throw new Error(`dag state contains forbidden plaintext: ${violations.join(", ")}`);
  mkdirSync(join(repoRoot, ".pi", "worklist", scope), { recursive: true });
  writeFileSync(dagStatePath(repoRoot, scope), JSON.stringify(state, null, 2), "utf8");
  return state;
}

export function readDagState(repoRoot: string, scope: string): DagState | undefined {
  const errors = validateScope(scope);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const raw = readJsonObjectIfPresent(dagStatePath(repoRoot, scope));
  if (!raw) return undefined;
  if (raw.schema !== WORKLIST_DAG_STATE_SCHEMA) return undefined;
  if (!Array.isArray(raw.nodes)) return undefined;
  if (raw.bodyStored !== false || raw.localOnly !== true || raw.networkEnabled !== false) return undefined;
  return raw as unknown as DagState;
}

// --- Cross-project federation (read the other scope's projection) -------------
//
// resolveCrossScopeDependency(repoRoot, "scopeB:nodeX") reads scope B's persisted
// dag.json and returns nodeX's status (or null if absent/unknown). This is how a
// node in scope A coordinates with scope B: it READS B's projection. There is NO
// P2P messaging — federation is a pure read of the other scope's metadata-only DAG
// state. The pure core takes this as an injected CrossScopeResolver callback so it
// stays pure over (nodes, resolver).
export function resolveCrossScopeDependency(repoRoot: string, ref: string): DagNodeStatus | null {
  const parsed = parseCrossScopeRef(ref);
  if (!parsed) return null;
  const state = readDagState(repoRoot, parsed.scope);
  if (!state || !Array.isArray(state.nodes)) return null;
  const node = state.nodes.find((entry) => isRecord(entry) && (entry as { id?: unknown }).id === parsed.nodeId);
  if (!node) return null;
  const status = (node as { status?: unknown }).status;
  return isDagStatus(status) ? status : null;
}
