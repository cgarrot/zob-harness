import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  buildDag,
  buildDagOrThrow,
  butterflySeedNext,
  computeDownstreamImpact,
  dagBodyFreeViolations,
  readDagState,
  resolveCrossScopeDependency,
  writeDagState,
  type DagNodeInput,
} from "../domains/worklist/dag.js";
import { deliverDirectiveNotification } from "../domains/worklist/delivery.js";
import { openWorklistStore, worklistBodyFreeViolations } from "../domains/worklist/store.js";
import { evaluateWorklistWatchdog, runWorklistWatchdogTick } from "../domains/worklist/watchdog.js";
import { ZobWorklistParams } from "./schemas.js";

// zob_worklist: append-only metadata-only blackboard. Subcommands:
//   append     -> append one event (gated by the reducer_id project validator;
//                 FORBIDDEN_PLAINTEXT_KEYS rejected)
//   directives -> read the derived worklist projection
//   claim      -> lease a directive by content hash
//   satisfy    -> satisfy a directive by content hash (idempotent: noop if done)
//   deliver    -> plan + emit an idempotent DIRECTIVE_READY notification for a
//                 directive hash (causal guard + dropped-notification tolerance)
//   validate   -> run the scope reducer + assert internal consistency
//   observe    -> (WS-H3) run the liveness watchdog evaluation: returns
//                 observe/directivesOpen/escalation WITHOUT persisting events.
//                 HARD RULE: observe is true ONLY when directives == [].
//   escalate   -> (WS-H3) run one watchdog tick and persist governed
//                 metadata-only escalation events for non-wait directives to
//                 .pi/worklist/<scope>/watchdog.jsonl (hash-only, body-free).
// Never stores raw bodies/prompts/diffs; never enables network.
export function registerWorklistTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_worklist",
    label: "ZOB Worklist Blackboard",
    description:
      "Drive the append-only metadata-only worklist blackboard: append events, read derived directives, lease/satisfy directives by content hash, deliver idempotent DIRECTIVE_READY notifications, run the liveness watchdog (observe/escalate), and build/query the dependency DAG. Hash-only and body-free; network is never enabled; observe is true only when no directive is open.",
    promptSnippet: "Drive the worklist blackboard (append / directives / claim / satisfy / deliver / validate / observe / escalate / dag).",
    parameters: ZobWorklistParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = String(params.action ?? "");
      try {
        const store = openWorklistStore(ctx.cwd, params.scope);

        if (action === "append") {
          const event = store.appendEvent({
            scope: params.scope,
            reducer_id: params.reducer_id,
            kind: params.kind ?? "",
            ref: params.ref,
            owner: params.owner,
            reason_ref: params.reason_ref,
            unblock_path: params.unblock_path,
            evidence_refs: params.evidence_refs,
            deadline: params.deadline,
          });
          pi.appendEntry("zob-worklist", {
            event: "appended",
            eventId: event.eventId,
            scope: event.scope,
            reducerId: event.reducerId,
            seq: event.seq,
            bodyStored: false,
            promptBodiesStored: false,
            outputBodiesStored: false,
          });
          return {
            content: [{ type: "text", text: `zob_worklist append: ${event.eventId} (seq ${event.seq})` }],
            details: { schema: "zob.worklist-append-result.v1", event, bodyFreeViolations: worklistBodyFreeViolations(event) },
          };
        }

        if (action === "directives") {
          const projection = store.project();
          return {
            content: [
              { type: "text", text: `zob_worklist directives: ${projection.directives.length} directive(s) for scope '${params.scope}'` },
            ],
            details: { schema: "zob.worklist-directives-result.v1", projection, bodyFreeViolations: worklistBodyFreeViolations(projection) },
          };
        }

        if (action === "claim") {
          const lease = store.claim(params.directive_hash ?? "", params.claimant ?? "", { leaseMs: params.lease_ms });
          pi.appendEntry("zob-worklist", {
            event: "claimed",
            leaseId: lease.leaseId,
            directiveHash: lease.directiveHash,
            claimant: lease.claimant,
            bodyStored: false,
            promptBodiesStored: false,
            outputBodiesStored: false,
          });
          return {
            content: [{ type: "text", text: `zob_worklist claim: ${lease.leaseId} (${lease.status})` }],
            details: { schema: "zob.worklist-claim-result.v1", lease, bodyFreeViolations: worklistBodyFreeViolations(lease) },
          };
        }

        if (action === "satisfy") {
          const lease = store.satisfy(params.directive_hash ?? "", params.claimant ?? "");
          pi.appendEntry("zob-worklist", {
            event: "satisfied",
            leaseId: lease.leaseId,
            directiveHash: lease.directiveHash,
            claimant: lease.claimant,
            bodyStored: false,
            promptBodiesStored: false,
            outputBodiesStored: false,
          });
          return {
            content: [{ type: "text", text: `zob_worklist satisfy: ${lease.leaseId} (${lease.status})` }],
            details: { schema: "zob.worklist-satisfy-result.v1", lease, bodyFreeViolations: worklistBodyFreeViolations(lease) },
          };
        }

        if (action === "validate") {
          const validation = store.validate();
          return {
            content: [
              {
                type: "text",
                text: validation.healthy
                  ? `zob_worklist validate: healthy (${validation.eventCount} event(s), ${validation.directiveCount} directive(s), ${validation.leaseCount} lease(s))`
                  : `zob_worklist validate: ${validation.violations.length} violation(s)`,
              },
            ],
            details: { schema: "zob.worklist-validate-result.v1", validation, bodyFreeViolations: worklistBodyFreeViolations(validation) },
          };
        }

        if (action === "deliver") {
          // resend_interval_ms IS declared in the shared ZobWorklistParams
          // schema (schemas.ts; WS-H2 parent fix). The action reads it
          // defensively here (finite-number guard, else default to the domain
          // constant). The action dispatch works because execute widens action to
          // `string`; the schema enum advertises the action to the model only.
          const maybeInterval = (params as { resend_interval_ms?: unknown }).resend_interval_ms;
          const result = deliverDirectiveNotification(ctx.cwd, params.scope, params.directive_hash ?? "", {
            resendIntervalMs: typeof maybeInterval === "number" && Number.isFinite(maybeInterval) ? maybeInterval : undefined,
          });
          pi.appendEntry("zob-worklist", {
            event: "delivered",
            deliveryId: result.notification?.deliveryId ?? null,
            directiveHash: result.directiveHash,
            reason: result.plan.reason,
            delivered: result.plan.deliver,
            cleared: result.cleared,
            bodyStored: false,
            promptBodiesStored: false,
            outputBodiesStored: false,
          });
          const text = result.notification
            ? `zob_worklist deliver: ${result.notification.deliveryId} (${result.plan.reason})`
            : `zob_worklist deliver: suppressed (${result.plan.reason})`;
          return {
            content: [{ type: "text", text }],
            details: { schema: "zob.worklist-deliver-result.v1", result, bodyFreeViolations: worklistBodyFreeViolations(result) },
          };
        }

        if (action === "observe") {
          // WS-H3 liveness watchdog evaluation. Reads the projected directives
          // and applies the HEADLINE HARD RULE: observe === (directives == []).
          // An open directive past its deadline escalates — it NEVER observes.
          // Read-only evaluation: no escalation events are persisted.
          const evaluation = evaluateWorklistWatchdog(ctx.cwd, params.scope, Date.now(), {
            decision_timeout_ms: params.decision_timeout_ms,
            escalate_to_llm_ms: params.escalate_to_llm_ms,
            escalate_to_human_ms: params.escalate_to_human_ms,
          });
          pi.appendEntry("zob-worklist", {
            event: "observed",
            scope: params.scope,
            observe: evaluation.observe,
            directivesOpen: evaluation.directivesOpen,
            escalationLevels: evaluation.escalation.map((entry) => entry.level),
            bodyStored: false,
            promptBodiesStored: false,
            outputBodiesStored: false,
          });
          return {
            content: [
              {
                type: "text",
                text: evaluation.observe
                  ? `zob_worklist observe: OBSERVE (worklist '${params.scope}' is empty; no open directives)`
                  : `zob_worklist observe: DO-NOT-OBSERVE (${evaluation.directivesOpen} open directive(s); HARD RULE blocks observe while a directive is open)`,
              },
            ],
            details: { schema: "zob.worklist-observe-result.v1", evaluation, bodyFreeViolations: worklistBodyFreeViolations(evaluation) },
          };
        }

        if (action === "escalate") {
          // WS-H3 bounded watchdog tick. Evaluates the watchdog and persists
          // governed metadata-only escalation events for non-wait directives
          // (auto/nudge_llm/human_block). The watchdog EMITS events; it does not
          // mutate the worklist state (events.jsonl/leases.jsonl). human_block
          // raises a no_ship escalation. Hash-only, body-free, network-disabled.
          const tick = runWorklistWatchdogTick(
            ctx.cwd,
            params.scope,
            {
              decision_timeout_ms: params.decision_timeout_ms,
              escalate_to_llm_ms: params.escalate_to_llm_ms,
              escalate_to_human_ms: params.escalate_to_human_ms,
            },
            { now: Date.now() },
          );
          pi.appendEntry("zob-worklist", {
            event: "escalated",
            scope: params.scope,
            observe: tick.observe,
            directivesOpen: tick.directivesOpen,
            emittedCount: tick.emitted.length,
            emittedLevels: tick.emitted.map((entry) => entry.level),
            noShipRaised: tick.emitted.some((entry) => entry.noShip),
            bodyStored: false,
            promptBodiesStored: false,
            outputBodiesStored: false,
          });
          return {
            content: [
              {
                type: "text",
                text: `zob_worklist escalate: ${tick.emitted.length} escalation event(s) persisted (observe=${tick.observe}, open=${tick.directivesOpen})`,
              },
            ],
            details: { schema: "zob.worklist-escalate-result.v1", tick, bodyFreeViolations: worklistBodyFreeViolations(tick) },
          };
        }

        if (action === "dag") {
          // WS-H4 generic dependency DAG. Additive subcommand generalizing the
          // transposer butterfly rule. Operations: build (validate + cycle check),
          // impact (computeDownstreamImpact), seed (butterflySeedNext), save
          // (write dag.json), load (read dag.json). Cross-scope federation reads
          // the OTHER scope's dag.json projection via resolveCrossScopeDependency
          // — a pure read, never a P2P message. All metadata-only/body-free.
          const dagOp = String(params.dag_op ?? "build");
          const dagNodes = Array.isArray(params.dag_nodes) ? (params.dag_nodes as DagNodeInput[]) : [];
          const resolver = (ref: string) => resolveCrossScopeDependency(ctx.cwd, ref);

          if (dagOp === "build") {
            const result = buildDag(dagNodes, { scope: params.scope });
            pi.appendEntry("zob-worklist", {
              event: "dag-build",
              scope: params.scope,
              ok: result.ok,
              nodeCount: result.ok ? result.graph.nodeIds.length : 0,
              bodyStored: false,
              promptBodiesStored: false,
              outputBodiesStored: false,
            });
            const text = result.ok
              ? `zob_worklist dag build: ok (${result.graph.nodeIds.length} node(s), scope '${params.scope}')`
              : `zob_worklist dag build: rejected (${result.error})`;
            return {
              content: [{ type: "text", text }],
              details: { schema: "zob.worklist-dag-build-result.v1", result, bodyFreeViolations: dagBodyFreeViolations(result) },
            };
          }

          if (dagOp === "impact") {
            const dagGraph = buildDagOrThrow(dagNodes, { scope: params.scope });
            const impact = computeDownstreamImpact(dagGraph, String(params.dag_node_id ?? ""), (params.dag_status ?? "pending") as "pending" | "in_progress" | "done" | "blocked" | "invalidated", resolver);
            pi.appendEntry("zob-worklist", {
              event: "dag-impact",
              scope: params.scope,
              nodeId: String(params.dag_node_id ?? ""),
              newStatus: params.dag_status ?? null,
              unblocked: impact.unblocked,
              invalidated: impact.invalidated,
              reprioritized: impact.reprioritized,
              bodyStored: false,
              promptBodiesStored: false,
              outputBodiesStored: false,
            });
            return {
              content: [
                { type: "text", text: `zob_worklist dag impact: ${impact.unblocked.length} unblocked, ${impact.invalidated.length} invalidated, ${impact.reprioritized.length} reprioritized` },
              ],
              details: { schema: "zob.worklist-dag-impact-result.v1", impact, bodyFreeViolations: dagBodyFreeViolations(impact) },
            };
          }

          if (dagOp === "seed") {
            const dagGraph = buildDagOrThrow(dagNodes, { scope: params.scope });
            const seed = butterflySeedNext(dagGraph, String(params.dag_accepted_node_id ?? ""), resolver);
            pi.appendEntry("zob-worklist", {
              event: "dag-seed",
              scope: params.scope,
              acceptedNodeId: String(params.dag_accepted_node_id ?? ""),
              seedNodeIds: seed.map((node) => node.id),
              bodyStored: false,
              promptBodiesStored: false,
              outputBodiesStored: false,
            });
            return {
              content: [{ type: "text", text: `zob_worklist dag seed: ${seed.length} node(s) to seed` }],
              details: { schema: "zob.worklist-dag-seed-result.v1", seed, bodyFreeViolations: dagBodyFreeViolations(seed) },
            };
          }

          if (dagOp === "save") {
            const dagGraph = buildDagOrThrow(dagNodes, { scope: params.scope });
            const state = writeDagState(ctx.cwd, params.scope, dagGraph);
            pi.appendEntry("zob-worklist", {
              event: "dag-save",
              scope: params.scope,
              nodeCount: state.nodeCount,
              fingerprint: state.fingerprint,
              bodyStored: false,
              promptBodiesStored: false,
              outputBodiesStored: false,
            });
            return {
              content: [{ type: "text", text: `zob_worklist dag save: ${state.nodeCount} node(s) (fingerprint ${state.fingerprint.slice(0, 12)})` }],
              details: { schema: "zob.worklist-dag-save-result.v1", state, bodyFreeViolations: dagBodyFreeViolations(state) },
            };
          }

          if (dagOp === "load") {
            const state = readDagState(ctx.cwd, params.scope);
            pi.appendEntry("zob-worklist", {
              event: "dag-load",
              scope: params.scope,
              found: Boolean(state),
              nodeCount: state?.nodeCount ?? 0,
              bodyStored: false,
              promptBodiesStored: false,
              outputBodiesStored: false,
            });
            return {
              content: [
                { type: "text", text: state ? `zob_worklist dag load: ${state.nodeCount} node(s) for scope '${params.scope}'` : `zob_worklist dag load: no dag state for scope '${params.scope}'` },
              ],
              details: { schema: "zob.worklist-dag-load-result.v1", state, bodyFreeViolations: state ? dagBodyFreeViolations(state) : [] },
            };
          }

          return {
            content: [{ type: "text", text: `zob_worklist dag blocked: unknown dag_op '${dagOp}'` }],
            details: { status: "blocked", errors: [`unknown dag_op: ${dagOp}`] },
          };
        }

        return {
          content: [{ type: "text", text: `zob_worklist blocked: unknown action '${action}'` }],
          details: { status: "blocked", errors: [`unknown action: ${action}`] },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `zob_worklist ${action || "(no-action)"} blocked: ${message}` }],
          details: { status: "blocked", errors: [message] },
        };
      }
    },
  });
}
