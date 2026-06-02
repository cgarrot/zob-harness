import { DEFAULT_RULES } from "../../core/constants.js";
import { appendGoalRoomMessage } from "../goal/goal-room.js";
import type { TeamDefinition } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { pathMatches } from "../../core/utils/paths.js";
import { resolveRepoPath, safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

export type GovernedRequestKind = "DELEGATION_REQUEST" | "ORACLE_REQUEST" | "CONTEXT_REQUEST" | "OWNER_CHANGE_REQUEST";
export type GovernedRequestPriority = "low" | "normal" | "high" | "critical";
export type GovernedRequestRisk = "low" | "medium" | "high";

export interface GovernedRequestRecord {
  schema: "zob.governed-request.v1";
  contract: "delegation-request.v1" | "oracle-request.v1" | "context-request.v1" | "owner-change-request.v1";
  kind: GovernedRequestKind;
  requestId: string;
  goalId: string | null;
  todoId: string | null;
  requestedBy: string;
  requestedAction: string;
  priority: GovernedRequestPriority;
  riskLevel: GovernedRequestRisk;
  bodyHash: string;
  requestHash: string;
  sourceOutputHash: string;
  agent: string | null;
  outputContract: string | null;
  requiredTools: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  contextScopeId: string | null;
  ownerWorker: string | null;
  requestedPaths: string[];
  changeHash: string | null;
  reasonHash: string | null;
  validationPlanHash: string | null;
  evidenceRefs: string[];
  artifactRefs: string[];
  noShip: boolean;
  finalMarker: string;
  parentVisible: true;
  requiresParentAction: true;
  parentOwnedActions: true;
  childDirectDispatch: false;
  canonicalTodoMutation: false;
  dispatchExecuted: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface GovernedRequestExtractionResult {
  schema: "zob.governed-request-extraction.v1";
  sourceOutputHash: string;
  requests: GovernedRequestRecord[];
  extractionErrors: string[];
  goalRoomMessageIds: string[];
  parentOwnedActions: true;
  childDirectDispatch: false;
  dispatchExecuted: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const REQUEST_TYPES = new Set<GovernedRequestKind>(["DELEGATION_REQUEST", "ORACLE_REQUEST", "CONTEXT_REQUEST", "OWNER_CHANGE_REQUEST"]);
const PRIORITIES = new Set<GovernedRequestPriority>(["low", "normal", "high", "critical"]);
const RISKS = new Set<GovernedRequestRisk>(["low", "medium", "high"]);
const FORBIDDEN_PLAINTEXT_LABELS = new Set(["body", "task", "prompt", "output", "content", "message", "text", "rationale", "diff", "patch"]);
const KNOWN_LABELS = new Set([
  "deliverabledelivered",
  "requesttype",
  "requestid",
  "goalid",
  "todoid",
  "requestedby",
  "requestedaction",
  "priority",
  "risklevel",
  "bodyhash",
  "agent",
  "outputcontract",
  "requiredtools",
  "allowedpaths",
  "forbiddenpaths",
  "contextscopeid",
  "ownerworker",
  "requestedpaths",
  "changehash",
  "reasonhash",
  "validationplanhash",
  "evidencerefs",
  "artifactrefs",
  "noship",
  "compliance",
  "finalmarker",
]);

function knownRoleIds(definition: TeamDefinition): Set<string> {
  return new Set([definition.orchestrator.id, ...definition.leads.map((lead) => lead.id), ...definition.workers.map((worker) => worker.id), "parent", "mission-control"]);
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stripBullet(line: string): string {
  return line.trim().replace(/^[-*•]\s+/, "").trim();
}

function splitLabel(line: string): { label: string; value: string } | undefined {
  const stripped = stripBullet(line);
  const match = stripped.match(/^([A-Za-z0-9 _.-]+)\s*[:=]\s*(.*)$/);
  if (!match) return undefined;
  return { label: normalizeLabel(match[1] ?? ""), value: (match[2] ?? "").trim() };
}

function scalar(lines: string[], labels: string[]): string | undefined {
  const wanted = new Set(labels.map(normalizeLabel));
  for (const line of lines) {
    const parsed = splitLabel(line);
    if (parsed && wanted.has(parsed.label)) return parsed.value;
  }
  return undefined;
}

function listValue(lines: string[], labels: string[]): string[] {
  const wanted = new Set(labels.map(normalizeLabel));
  const values: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = splitLabel(lines[index] ?? "");
    if (!parsed || !wanted.has(parsed.label)) continue;
    if (parsed.value) values.push(...splitInlineList(parsed.value));
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor] ?? "";
      const nextParsed = splitLabel(next);
      if (nextParsed && KNOWN_LABELS.has(nextParsed.label)) break;
      const stripped = stripBullet(next);
      if (!stripped) continue;
      if (/^FINAL_MARKER\s*:/i.test(stripped)) break;
      values.push(...splitInlineList(stripped));
    }
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }
  return [];
}

function splitInlineList(value: string): string[] {
  return value
    .split(/[,;]\s*|\s+\|\s+/)
    .map((item) => item.trim().replace(/^[-*•]\s+/, ""))
    .filter(Boolean)
    .filter((item) => item.toLowerCase() !== "none" && item !== "-");
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(normalized)) return true;
  if (["false", "no", "n", "0"].includes(normalized)) return false;
  return undefined;
}

function parseKind(value: string | undefined): GovernedRequestKind | undefined {
  const normalized = value?.trim().replace(/\.v1$/i, "").toUpperCase();
  return REQUEST_TYPES.has(normalized as GovernedRequestKind) ? normalized as GovernedRequestKind : undefined;
}

function contractForKind(kind: GovernedRequestKind): GovernedRequestRecord["contract"] {
  if (kind === "ORACLE_REQUEST") return "oracle-request.v1";
  if (kind === "CONTEXT_REQUEST") return "context-request.v1";
  if (kind === "OWNER_CHANGE_REQUEST") return "owner-change-request.v1";
  return "delegation-request.v1";
}

function finalMarkerForKind(kind: GovernedRequestKind): string {
  return `${kind}_END`;
}

function chunksFromText(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const starts = lines.map((line, index) => ({ index, parsed: splitLabel(line) })).filter((item) => item.parsed?.label === "requesttype");
  if (starts.length === 0) return [];
  return starts.map((start, startIndex) => lines.slice(startIndex === 0 ? 0 : start.index, starts[startIndex + 1]?.index ?? lines.length).join("\n"));
}

function plaintextLabelErrors(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const parsed = splitLabel(line);
    return parsed && FORBIDDEN_PLAINTEXT_LABELS.has(parsed.label) ? [`governed request must not include raw '${parsed.label}' field`] : [];
  });
}

function safeOptionalId(value: string | null, label: string): string[] {
  if (!value) return [];
  return safeFileStem(value) === value ? [] : [`${label} must be path-safe: ${value}`];
}

function validateRefs(repoRoot: string, refs: string[], label: string): string[] {
  const errors: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== "string" || ref.trim().length === 0) {
      errors.push(`${label} contains an empty ref`);
      continue;
    }
    if (ref.includes("\0")) errors.push(`${label} contains NUL byte: ${ref}`);
    const resolved = resolveRepoPath(repoRoot, ref);
    errors.push(...resolved.errors.map((error) => `${label}: ${error}`));
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(ref, protectedPattern, repoRoot, repoRoot)) errors.push(`${label} references zero-access path: ${protectedPattern}`);
    }
  }
  return errors;
}

function validatePathList(repoRoot: string, paths: string[], label: string): string[] {
  return paths.flatMap((path) => validateRefs(repoRoot, [path], label));
}

function validateForbiddenPathList(paths: string[], label: string): string[] {
  const errors: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || path.trim().length === 0) errors.push(`${label} contains an empty path`);
    if (path.includes("\0")) errors.push(`${label} contains NUL byte: ${path}`);
    if (["/", "~", "*", "**"].includes(path.trim())) errors.push(`${label} rejects broad deny-only path: ${path}`);
  }
  return errors;
}

function recordFromChunk(text: string, chunk: string): { request?: GovernedRequestRecord; errors: string[] } {
  const lines = chunk.split(/\r?\n/);
  const errors = plaintextLabelErrors(lines);
  const deliverable = scalar(lines, ["deliverable_delivered", "deliverable delivered"]);
  if (deliverable?.toLowerCase() !== "yes") errors.push("governed request deliverable_delivered must be yes");
  const kind = parseKind(scalar(lines, ["request_type", "request type"]));
  if (!kind) errors.push("governed request missing valid request_type");
  const requestId = scalar(lines, ["request_id", "request id"]);
  if (!requestId) errors.push("governed request missing request_id");
  const requestedBy = scalar(lines, ["requested_by", "requested by"]);
  if (!requestedBy) errors.push("governed request missing requested_by");
  const requestedAction = scalar(lines, ["requested_action", "requested action"]);
  if (!requestedAction) errors.push("governed request missing requested_action");
  const priority = (scalar(lines, ["priority"]) || "normal").toLowerCase() as GovernedRequestPriority;
  if (!PRIORITIES.has(priority)) errors.push("governed request priority must be low|normal|high|critical");
  const riskLevel = (scalar(lines, ["risk_level", "risk level"]) || "medium").toLowerCase() as GovernedRequestRisk;
  if (!RISKS.has(riskLevel)) errors.push("governed request risk_level must be low|medium|high");
  const bodyHash = scalar(lines, ["body_hash", "body hash"]);
  if (!bodyHash || !SHA256_HEX.test(bodyHash)) errors.push("governed request body_hash must be sha256 hex");
  const noShip = parseBoolean(scalar(lines, ["no_ship", "no ship"]));
  if (noShip === undefined) errors.push("governed request no_ship must be true/false");
  const ownerWorker = scalar(lines, ["owner_worker", "owner worker"]) || null;
  const requestedPaths = listValue(lines, ["requested_paths", "requested paths"]);
  const changeHash = scalar(lines, ["change_hash", "change hash"]) || null;
  const reasonHash = scalar(lines, ["reason_hash", "reason hash"]) || null;
  const validationPlanHash = scalar(lines, ["validation_plan_hash", "validation plan hash"]) || null;
  if (kind === "OWNER_CHANGE_REQUEST") {
    if (!ownerWorker) errors.push("owner change request missing owner_worker");
    if (requestedPaths.length === 0) errors.push("owner change request missing requested_paths");
    if (!changeHash || !SHA256_HEX.test(changeHash)) errors.push("owner change request change_hash must be sha256 hex");
    if (!reasonHash || !SHA256_HEX.test(reasonHash)) errors.push("owner change request reason_hash must be sha256 hex");
    if (validationPlanHash && !SHA256_HEX.test(validationPlanHash)) errors.push("owner change request validation_plan_hash must be sha256 hex");
  }
  const finalMarker = scalar(lines, ["FINAL_MARKER", "final marker"]) ?? "";
  if (kind && finalMarker !== finalMarkerForKind(kind)) errors.push(`governed request final marker must be ${finalMarkerForKind(kind)}`);
  if (errors.length > 0 || !kind || !requestId || !requestedBy || !requestedAction || !bodyHash || noShip === undefined) return { errors };
  const goalId = scalar(lines, ["goal_id", "goal id"]) || null;
  const todoId = scalar(lines, ["todo_id", "todo id"]) || null;
  const sourceOutputHash = sha256(text);
  const stable = {
    contract: contractForKind(kind),
    kind,
    requestId,
    goalId,
    todoId,
    requestedBy,
    requestedAction,
    priority,
    riskLevel,
    bodyHash,
    agent: scalar(lines, ["agent"]) || null,
    outputContract: scalar(lines, ["output_contract", "output contract"]) || null,
    requiredTools: listValue(lines, ["required_tools", "required tools"]),
    allowedPaths: listValue(lines, ["allowed_paths", "allowed paths"]),
    forbiddenPaths: listValue(lines, ["forbidden_paths", "forbidden paths"]),
    contextScopeId: scalar(lines, ["context_scope_id", "context scope id"]) || null,
    ownerWorker,
    requestedPaths,
    changeHash,
    reasonHash,
    validationPlanHash,
    evidenceRefs: listValue(lines, ["evidence_refs", "evidence refs"]),
    artifactRefs: listValue(lines, ["artifact_refs", "artifact refs"]),
    noShip,
    finalMarker,
  };
  return {
    request: {
      schema: "zob.governed-request.v1",
      ...stable,
      requestHash: sha256(JSON.stringify(stable)),
      sourceOutputHash,
      parentVisible: true,
      requiresParentAction: true,
      parentOwnedActions: true,
      childDirectDispatch: false,
      canonicalTodoMutation: false,
      dispatchExecuted: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    },
    errors: [],
  };
}

export function extractGovernedRequestsFromText(text: string): GovernedRequestExtractionResult {
  const sourceOutputHash = sha256(text);
  const requests: GovernedRequestRecord[] = [];
  const extractionErrors: string[] = [];
  for (const chunk of chunksFromText(text)) {
    const result = recordFromChunk(text, chunk);
    if (result.request) requests.push(result.request);
    extractionErrors.push(...result.errors);
  }
  if (requests.length === 0 && extractionErrors.length === 0) extractionErrors.push("no governed request blocks found");
  return {
    schema: "zob.governed-request-extraction.v1",
    sourceOutputHash,
    requests,
    extractionErrors,
    goalRoomMessageIds: [],
    parentOwnedActions: true,
    childDirectDispatch: false,
    dispatchExecuted: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function validateGovernedRequest(repoRoot: string, definition: TeamDefinition, request: GovernedRequestRecord): string[] {
  const errors: string[] = [];
  if (request.schema !== "zob.governed-request.v1") errors.push("governed request schema must be zob.governed-request.v1");
  if (!REQUEST_TYPES.has(request.kind)) errors.push("governed request kind is invalid");
  if (request.contract !== contractForKind(request.kind)) errors.push("governed request contract does not match request kind");
  if (!request.requestId || safeFileStem(request.requestId) !== request.requestId) errors.push(`requestId must be path-safe: ${request.requestId}`);
  errors.push(...safeOptionalId(request.goalId, "goalId"));
  errors.push(...safeOptionalId(request.todoId, "todoId"));
  if (!knownRoleIds(definition).has(request.requestedBy)) errors.push(`Unknown governed request requester '${request.requestedBy}'`);
  if (request.kind === "OWNER_CHANGE_REQUEST") {
    if (!request.ownerWorker || !knownRoleIds(definition).has(request.ownerWorker)) errors.push(`Unknown owner change request ownerWorker '${request.ownerWorker}'`);
    if (request.requestedPaths.length === 0) errors.push("owner change request requestedPaths are required");
    if (!request.changeHash || !SHA256_HEX.test(request.changeHash)) errors.push("owner change request changeHash must be sha256 hex");
    if (!request.reasonHash || !SHA256_HEX.test(request.reasonHash)) errors.push("owner change request reasonHash must be sha256 hex");
    if (request.validationPlanHash && !SHA256_HEX.test(request.validationPlanHash)) errors.push("owner change request validationPlanHash must be sha256 hex");
    errors.push(...validatePathList(repoRoot, request.requestedPaths, "requestedPaths"));
  }
  if (!PRIORITIES.has(request.priority)) errors.push("governed request priority is invalid");
  if (!RISKS.has(request.riskLevel)) errors.push("governed request riskLevel is invalid");
  if (!SHA256_HEX.test(request.bodyHash)) errors.push("governed request bodyHash must be sha256 hex");
  if (!SHA256_HEX.test(request.requestHash)) errors.push("governed request requestHash must be sha256 hex");
  if (!SHA256_HEX.test(request.sourceOutputHash)) errors.push("governed request sourceOutputHash must be sha256 hex");
  if (request.finalMarker !== finalMarkerForKind(request.kind)) errors.push(`governed request finalMarker must be ${finalMarkerForKind(request.kind)}`);
  if (request.parentVisible !== true || request.requiresParentAction !== true || request.parentOwnedActions !== true || request.childDirectDispatch !== false || request.canonicalTodoMutation !== false || request.dispatchExecuted !== false) errors.push("governed request must be parent-visible, parent-owned, non-mutating, and non-dispatching");
  if (request.bodyStored !== false || request.promptBodiesStored !== false || request.outputBodiesStored !== false) errors.push("governed request must be body-free");
  errors.push(...validatePathList(repoRoot, request.allowedPaths, "allowedPaths"));
  errors.push(...validateForbiddenPathList(request.forbiddenPaths, "forbiddenPaths"));
  errors.push(...validateRefs(repoRoot, request.evidenceRefs, "evidenceRefs"));
  errors.push(...validateRefs(repoRoot, request.artifactRefs, "artifactRefs"));
  return errors;
}

export function appendGovernedRequestsToGoalRoom(repoRoot: string, definition: TeamDefinition, goalId: string, extraction: GovernedRequestExtractionResult): GovernedRequestExtractionResult {
  const goalRoomMessageIds: string[] = [];
  const extractionErrors = [...extraction.extractionErrors];
  for (const request of extraction.requests) {
    const errors = validateGovernedRequest(repoRoot, definition, { ...request, goalId: request.goalId ?? goalId });
    if (errors.length > 0) {
      extractionErrors.push(...errors.map((error) => `${request.requestId}: ${error}`));
      continue;
    }
    const message = appendGoalRoomMessage(repoRoot, definition, {
      goal_id: request.goalId ?? goalId,
      todo_id: request.todoId ?? undefined,
      sender: request.requestedBy,
      audience: "parent",
      kind: request.kind,
      priority: request.priority,
      body_hash: request.bodyHash,
      task_id: request.requestId,
      evidence_refs: request.evidenceRefs,
      artifact_refs: request.artifactRefs,
      requires_parent_action: true,
      metadata: {
        governed_request_hash: request.requestHash,
        governed_request_contract: request.contract,
        owner_worker: request.ownerWorker,
        requested_path_hashes: request.requestedPaths.map((path) => sha256(path)),
        change_hash: request.changeHash,
        reason_hash: request.reasonHash,
        validation_plan_hash: request.validationPlanHash,
        requested_action_hash: sha256(request.requestedAction),
        risk_level_hash: sha256(request.riskLevel),
        source_output_hash: request.sourceOutputHash,
        child_direct_dispatch: false,
        canonical_todo_mutation: false,
        dispatch_executed: false,
      },
    });
    if (typeof message.msgId === "string") goalRoomMessageIds.push(message.msgId);
  }
  return { ...extraction, extractionErrors, goalRoomMessageIds };
}

export function governedRequestBodyFreeViolations(value: unknown): string[] {
  const violations: string[] = [];
  const visit = (item: unknown, path: string): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (FORBIDDEN_PLAINTEXT_LABELS.has(key)) violations.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "root");
  return violations;
}

export function isGovernedRequest(value: unknown): value is GovernedRequestRecord {
  return isRecord(value) && value.schema === "zob.governed-request.v1";
}
