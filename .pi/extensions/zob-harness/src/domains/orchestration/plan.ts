import { SUPERVISED_READONLY_CHILD_TOOLS, SUPERVISED_SMOKE_CHILD_TOOLS } from "../../core/constants.js";
import type { OrchestrateExecutionMode, OrchestrateRunInput, TeamDefinition } from "../../types.js";
import { normalizeAdaptiveDelegationPolicy } from "./adaptive-delegation.js";
import { sha256 } from "../../core/utils/hashing.js";
import { safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

function renderOrchestrationTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, key: string) => values[key] ?? match);
}

const RAW_PERSISTENCE_KEYS = new Set(["goal", "originalUserAsk", "original_user_ask", "task", "expected_outcome", "context", "taskTemplate", "prompt", "output", "body", "content", "diff", "patch"]);
const RAW_PERSISTENCE_ARRAY_KEYS = new Set(["must_do", "must_not_do"]);

function redactRawPersistenceFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRawPersistenceFields);
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (RAW_PERSISTENCE_KEYS.has(key)) {
      if (typeof child === "string") redacted[`${key}Hash`] = sha256(child);
      else if (child !== undefined && child !== null) redacted[`${key}Hash`] = sha256(JSON.stringify(child));
      continue;
    }
    if (RAW_PERSISTENCE_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      redacted[`${key}Hashes`] = child.map((item) => sha256(typeof item === "string" ? item : JSON.stringify(item)));
      continue;
    }
    redacted[key] = redactRawPersistenceFields(child);
  }
  return redacted;
}

export function redactBodyLikeFieldsForPersistence(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactRawPersistenceFields(value);
  return isRecord(redacted) ? { ...redacted, redactedForPersistence: true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false } : { redactedForPersistence: true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false };
}

function redactOrchestrationPlanForPersistence(plan: Record<string, unknown>): Record<string, unknown> {
  const tasks = Array.isArray(plan.tasks) ? plan.tasks.map((task) => {
    if (!isRecord(task)) return task;
    const redacted: Record<string, unknown> = { ...task };
    for (const field of ["task", "expected_outcome", "context"] as const) {
      const value = redacted[field];
      if (typeof value === "string") redacted[`${field}Hash`] = sha256(value);
      delete redacted[field];
    }
    for (const field of ["must_do", "must_not_do"] as const) {
      const value = redacted[field];
      if (Array.isArray(value)) redacted[`${field}Hashes`] = value.filter((item): item is string => typeof item === "string").map((item) => sha256(item));
      delete redacted[field];
    }
    return redacted;
  }) : plan.tasks;
  return redactBodyLikeFieldsForPersistence({ ...plan, tasks });
}

function buildOrchestrationPlan(
  definition: TeamDefinition,
  input: OrchestrateRunInput,
  run: { runId: string; runDir: string; execution: OrchestrateExecutionMode },
): Record<string, unknown> {
  const workerLimit = input.max_workers ?? definition.workers.length;
  const selectedWorkers = definition.workers.slice(0, workerLimit);
  const selectedWorkerIds = new Set(selectedWorkers.map((worker) => worker.id));
  const tasks: Array<Record<string, unknown>> = [];
  const goal = input.goal.trim();
  const originalUserAsk = input.original_user_ask ?? goal;
  const adaptiveDelegation = normalizeAdaptiveDelegationPolicy(input.adaptive_delegation);

  for (const lead of definition.leads) {
    const leadWorkerIds = (lead.workerIds ?? selectedWorkers.filter((worker) => worker.leadId === lead.id).map((worker) => worker.id)).filter((workerId) => selectedWorkerIds.has(workerId));
    tasks.push({
      id: `${safeFileStem(lead.id)}-lead-plan`,
      type: "lead_plan",
      goalId: input.goal_id,
      todoId: input.todo_id,
      todoRef: input.todo_id ? { rootTodoId: input.todo_id, attachmentKind: "lead_plan" } : undefined,
      role: "lead",
      leadId: lead.id,
      agent: lead.agent,
      parent: definition.orchestrator.id,
      task: `Plan lead lane '${lead.id}' for goal: ${goal}. Propose worker task contracts for: ${leadWorkerIds.join(", ") || "no selected workers"}. Do not execute workers. Return machine-readable worker contracts inside <worker_contracts>{\"worker_contracts\":[...]}</worker_contracts>. Each contract object must include worker_id, lead_id, agent, task, expected_outcome, required_tools, output_contract, must_do, must_not_do, context, and optional allowed_paths, forbidden_paths, model_class. allowed_paths must be repo-relative only; do not include absolute paths, home paths, or '~' paths. forbidden_paths are deny-only patterns and may be repo-local, absolute, or home-relative; broad roots are rejected. The final lead-plan response must include literal fields: lead_id, phase, worker_contracts, required_tools, allowed_paths, forbidden_paths, output_contract, model_class, evidence_needed, no_ship_criteria, evidence, risks/blockers, compliance.`,
      expected_outcome: `Lead '${lead.id}' produces scoped worker contracts and risk notes in extractable lead-plan.v1 format`,
      required_tools: lead.requiredTools,
      must_do: ["Stay in planning mode", "Return worker task contracts only", "Return worker_contracts as parseable JSON inside <worker_contracts> tags", "Use only repo-relative allowed_paths; forbidden_paths are deny-only patterns and may be repo-local, absolute, or home-relative", "Include literal evidence_needed and no_ship_criteria fields", "Cite required evidence and gaps", "Respect parent orchestrator preflight"],
      must_not_do: ["Do not execute worker tasks", "No edits", "No secrets", "No destructive commands", "No worker-spawns-worker"],
      context: `Orchestration run ${run.runId}; team ${definition.name}; original ask: ${originalUserAsk}`,
      output_contract: lead.outputContract,
      run_in_background: false,
    });
  }

  for (const worker of selectedWorkers) {
    const values = {
      "goal": goal,
      "original_user_ask": originalUserAsk,
      "run.id": run.runId,
      "run.dir": run.runDir,
      "team.name": definition.name,
      "worker.id": worker.id,
      "lead.id": worker.leadId,
    };
    tasks.push({
      id: `${safeFileStem(worker.leadId)}-${safeFileStem(worker.id)}-worker-contract`,
      type: "worker_contract",
      goalId: input.goal_id,
      todoId: input.todo_id,
      todoRef: input.todo_id ? { rootTodoId: input.todo_id, attachmentKind: "worker_contract", proposedBy: worker.leadId } : undefined,
      role: "worker",
      leadId: worker.leadId,
      workerId: worker.id,
      agent: worker.agent,
      parent: definition.orchestrator.id,
      proposedBy: worker.leadId,
      task: renderOrchestrationTemplate(worker.taskTemplate ?? `Execute the bounded worker slice for {goal}. Return evidence, blockers, and next steps.`, values),
      expected_outcome: `Worker '${worker.id}' returns its contract-compliant deliverable`,
      required_tools: worker.requiredTools,
      must_do: ["Use the assigned output contract", "Cite evidence", "Report blockers", "Return deliverable_delivered: yes/no"],
      must_not_do: ["No secrets", "No destructive commands", "No commits", "No worker-spawns-worker"],
      context: `Orchestration run ${run.runId}; team ${definition.name}; lead ${worker.leadId}; worker ${worker.id}; original ask: ${originalUserAsk}`,
      output_contract: worker.outputContract,
      run_in_background: false,
    });
  }

  return {
    schema: "zob.orchestration-plan.v1",
    team: definition.name,
    runId: run.runId,
    runDir: run.runDir,
    execution: run.execution,
    goal,
    originalUserAsk,
    goalId: input.goal_id,
    rootTodoId: input.todo_id,
    todoGraphBinding: input.todo_id ? { goalId: input.goal_id, rootTodoId: input.todo_id, attachmentPolicy: "messages_delegations_blockers_claims_evidence_attach_to_todo" } : undefined,
    topology: {
      orchestrator: definition.orchestrator,
      leads: definition.leads.map((lead) => ({ ...lead, workerIds: (lead.workerIds ?? selectedWorkers.filter((worker) => worker.leadId === lead.id).map((worker) => worker.id)).filter((workerId) => selectedWorkerIds.has(workerId)) })),
      workers: selectedWorkers,
    },
    invariants: {
      parentPreflightRequired: true,
      parentDispatchOnly: true,
      workerSpawnsWorker: false,
      freeFormPeerChat: false,
      networkedComs: false,
      noExecutionInPlanOnly: true,
      supervisedSmokeReadOnly: run.execution === "supervised_smoke" ? true : undefined,
      supervisedSmokeAllowedTools: run.execution === "supervised_smoke" ? [...SUPERVISED_SMOKE_CHILD_TOOLS] : undefined,
      supervisedReadonly: run.execution === "supervised_readonly" ? true : undefined,
      supervisedReadonlyAllowedTools: run.execution === "supervised_readonly" ? [...SUPERVISED_READONLY_CHILD_TOOLS] : undefined,
      supervisedReadonlyDispatcherBoundary: run.execution === "supervised_readonly" ? true : undefined,
      liveChildExecution: false,
      adaptiveDelegationDefaultOff: adaptiveDelegation.enabled === false,
      adaptiveDelegationParentOwned: adaptiveDelegation.enabled ? adaptiveDelegation.parentOwnedDispatch === true : undefined,
      adaptiveDelegationChildDirectDispatch: adaptiveDelegation.enabled ? adaptiveDelegation.childDirectDispatch : undefined,
      adaptiveDelegationConfiguredMaxDepth: adaptiveDelegation.enabled ? adaptiveDelegation.configuredMaxDepth : undefined,
      adaptiveDelegationRuntimeMaxDepth: adaptiveDelegation.enabled ? adaptiveDelegation.runtimeMaxDepth : undefined,
      adaptiveDelegationDispatch: adaptiveDelegation.enabled ? adaptiveDelegation.dispatch : undefined,
    },
    ...(adaptiveDelegation.enabled ? { adaptiveDelegation } : {}),
    tasks,
  };
}

export { buildOrchestrationPlan, redactOrchestrationPlanForPersistence };
