import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../utils/hashing.js";
import { safeFileStem } from "../utils/paths.js";
import { parseJsonFile } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
import { advancePromotionCandidate, createPromotionCandidate, promotionCandidateDir, promotionCandidateRef, validatePromotionCandidate, writePromotionCandidate } from "./candidate.js";
import type { PromotionCandidateRecord } from "./types.js";

export interface TempAgentCardPromotionInput {
  candidateId?: string;
  runId: string;
  goalId?: string;
  todoId?: string;
  sourceRef: string;
  agentName: string;
  description: string;
  allowedTools: string[];
  outputContract: string;
  scope: string;
  mustDo: string[];
  mustNotDo: string[];
  writeToolsGate?: boolean;
}

const KNOWN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write", "delegate_agent", "delegate_task", "zob_coms_send", "zob_goal_room_send", "zob_governed_request_extract"]);
const WRITE_TOOLS = new Set(["bash", "edit", "write"]);

export function validateTempAgentCardForPromotion(repoRoot: string, input: TempAgentCardPromotionInput): string[] {
  const errors: string[] = [];
  if (safeFileStem(input.agentName) !== input.agentName) errors.push("temp agent name must be path-safe and equal to its safe stem");
  if (!input.description || input.description.trim().length < 10) errors.push("temp agent description is required");
  if (!Array.isArray(input.allowedTools) || input.allowedTools.length === 0) errors.push("temp agent allowedTools are required");
  for (const tool of input.allowedTools ?? []) {
    if (!KNOWN_TOOLS.has(tool)) errors.push(`unknown temp agent tool: ${tool}`);
    if (WRITE_TOOLS.has(tool) && input.writeToolsGate !== true) errors.push(`write-capable tool requires explicit writeToolsGate: ${tool}`);
  }
  if (!/^[a-z0-9._-]+\.v\d+$/i.test(input.outputContract)) errors.push("outputContract must be a safe contract id like name.v1");
  if (!existsSync(join(repoRoot, ".pi", "output-contracts", `${input.outputContract}.json`))) errors.push(`output contract not found: ${input.outputContract}`);
  if (!input.scope || input.scope.trim().length === 0) errors.push("temp agent scope is required");
  if (!Array.isArray(input.mustDo) || input.mustDo.length === 0) errors.push("mustDo is required");
  if (!Array.isArray(input.mustNotDo) || input.mustNotDo.length === 0) errors.push("mustNotDo is required");
  return errors;
}

function renderAgentDraft(input: TempAgentCardPromotionInput): string {
  return [
    `# ${input.agentName}`,
    "",
    input.description,
    "",
    "## Scope",
    input.scope,
    "",
    "## Tools",
    input.allowedTools.map((tool) => `- ${tool}`).join("\n"),
    "",
    "## Output contract",
    input.outputContract,
    "",
    "## MUST DO",
    input.mustDo.map((item) => `- ${item}`).join("\n"),
    "",
    "## MUST NOT",
    input.mustNotDo.map((item) => `- ${item}`).join("\n"),
    "",
    "## Persistence policy",
    "This draft is quarantined until promotion approval, smoke validation, and oracle PASS/no_ship=false.",
  ].join("\n");
}

export function prepareTempAgentPromotion(repoRoot: string, input: TempAgentCardPromotionInput): { candidate: PromotionCandidateRecord; preparedArtifactRef: string; draftRef: string; validationRef: string } {
  const cardErrors = validateTempAgentCardForPromotion(repoRoot, input);
  if (cardErrors.length > 0) throw new Error(cardErrors.join("; "));
  const candidate = createPromotionCandidate({
    candidateId: input.candidateId,
    kind: "temp_agent",
    runId: input.runId,
    goalId: input.goalId,
    todoId: input.todoId,
    sourceRef: input.sourceRef,
    allowedPaths: [".pi/agents"],
    changedPaths: [`.pi/agents/${input.agentName}.md`],
    comsThreadRef: input.candidateId ? promotionCandidateRef(input.candidateId, "promotion-coms-thread.json") : undefined,
    metadata: { lane: "temp_agent", agentName: input.agentName, outputContract: input.outputContract },
  });
  const candidateDir = promotionCandidateDir(repoRoot, candidate.candidateId);
  const draftText = renderAgentDraft(input);
  const draftRef = promotionCandidateRef(candidate.candidateId, `agents/${input.agentName}.md`);
  mkdirSync(join(candidateDir, "agents"), { recursive: true });
  writeFileSync(join(repoRoot, draftRef), draftText, "utf8");
  const preparedArtifact = {
    schema: "zob.temp-agent-promotion-prepared.v1",
    candidateId: candidate.candidateId,
    agentName: input.agentName,
    draftRef,
    draftHash: sha256(draftText),
    allowedTools: input.allowedTools,
    outputContract: input.outputContract,
    durableAgentWritePerformed: false,
    catalogSmokeRequired: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const preparedArtifactRef = promotionCandidateRef(candidate.candidateId, "temp-agent/prepared.json");
  mkdirSync(join(candidateDir, "temp-agent"), { recursive: true });
  writeFileSync(join(repoRoot, preparedArtifactRef), JSON.stringify(preparedArtifact, null, 2), "utf8");
  const validationErrors = validateTempAgentPromotionArtifact(preparedArtifact);
  const validationRef = promotionCandidateRef(candidate.candidateId, "temp-agent/validation.json");
  writeFileSync(join(repoRoot, validationRef), JSON.stringify({ schema: "zob.temp-agent-promotion-validation.v1", candidateId: candidate.candidateId, valid: validationErrors.length === 0, errors: validationErrors, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
  const prepared = advancePromotionCandidate(repoRoot, { ...candidate, comsThreadRef: promotionCandidateRef(candidate.candidateId, "promotion-coms-thread.json") }, { toStatus: "prepared", preparedArtifactRef, validationRefs: validationErrors.length === 0 ? [validationRef] : [] });
  writePromotionCandidate(repoRoot, prepared);
  return { candidate: prepared, preparedArtifactRef, draftRef, validationRef };
}

export function validateTempAgentPromotionArtifact(artifact: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(artifact)) return ["temp-agent promotion artifact must be an object"];
  if (artifact.schema !== "zob.temp-agent-promotion-prepared.v1") errors.push("temp-agent promotion artifact schema mismatch");
  if (typeof artifact.agentName !== "string" || safeFileStem(artifact.agentName) !== artifact.agentName) errors.push("agentName must be safe");
  if (artifact.durableAgentWritePerformed !== false) errors.push("temp-agent promotion must not perform durable agent write during preparation");
  if (artifact.bodyStored !== false || artifact.promptBodiesStored !== false || artifact.outputBodiesStored !== false) errors.push("temp-agent promotion artifact must keep body flags false");
  if (!Array.isArray(artifact.allowedTools) || artifact.allowedTools.some((tool) => typeof tool !== "string")) errors.push("allowedTools must be string array");
  return errors;
}

export function applyTempAgentPromotionInQuarantine(repoRoot: string, candidate: PromotionCandidateRecord): { candidate: PromotionCandidateRecord; appliedAgentRef: string; appliedMetadataRef: string } {
  if (candidate.kind !== "temp_agent") throw new Error("candidate kind must be temp_agent");
  if (candidate.status !== "approved") throw new Error("temp-agent quarantine apply requires approved candidate");
  if (!candidate.preparedArtifactRef) throw new Error("temp-agent quarantine apply requires preparedArtifactRef");
  const prepared = parseJsonFile(join(repoRoot, candidate.preparedArtifactRef));
  if (!isRecord(prepared) || typeof prepared.agentName !== "string" || typeof prepared.draftRef !== "string") throw new Error("temp-agent prepared artifact missing agentName/draftRef");
  const draftText = readFileSync(join(repoRoot, prepared.draftRef), "utf8");
  const appliedAgentRef = promotionCandidateRef(candidate.candidateId, `temp-agent/applied-test-workspace/.pi/agents/${safeFileStem(prepared.agentName)}.md`);
  mkdirSync(join(repoRoot, promotionCandidateRef(candidate.candidateId, "temp-agent/applied-test-workspace/.pi/agents")), { recursive: true });
  writeFileSync(join(repoRoot, appliedAgentRef), draftText, "utf8");
  const appliedMetadataRef = promotionCandidateRef(candidate.candidateId, "temp-agent/applied-test-workspace/apply-metadata.json");
  writeFileSync(join(repoRoot, appliedMetadataRef), JSON.stringify({ schema: "zob.temp-agent-quarantine-apply.v1", candidateId: candidate.candidateId, appliedAgentRef, productionWritesPerformed: false, autoApply: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
  const applied = advancePromotionCandidate(repoRoot, candidate, { toStatus: "applied", applyScope: "quarantine_test_directory", applyPerformed: true });
  writePromotionCandidate(repoRoot, applied);
  return { candidate: applied, appliedAgentRef, appliedMetadataRef };
}

export function validateTempAgentPromotionCandidate(repoRoot: string, candidate: PromotionCandidateRecord): string[] {
  const errors = validatePromotionCandidate(repoRoot, candidate);
  if (candidate.kind !== "temp_agent") errors.push("candidate kind must be temp_agent");
  if (candidate.productionWritesPerformed !== false || candidate.autoApply !== false) errors.push("temp-agent candidate must not auto-apply production writes");
  return errors;
}
