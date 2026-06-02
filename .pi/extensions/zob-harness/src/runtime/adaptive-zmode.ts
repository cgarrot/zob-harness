import type { ModeName } from "../types.js";
import { sha256 } from "../core/utils/hashing.js";
import { isRecord } from "../core/utils/records.js";

export type AdaptiveZmodeAlias = "orchestrator";

export interface AdaptiveZmodeEntrypoint {
  schema: "zob.adaptive-zmode-entrypoint.v1";
  requestedMode: AdaptiveZmodeAlias;
  accepted: true;
  appliedHarnessMode: Extract<ModeName, "orchestrator">;
  profile: "adaptive-chief-vision";
  executionDefault: "plan_only";
  allowedExecutions: ["plan_only", "supervised_readonly"];
  computeProfileDefault: "high";
  rootNonCoding: true;
  parentOwnedDispatch: true;
  childDirectDispatch: false;
  directWriteToolsBlocked: ["bash", "edit", "write"];
  sandboxRequiredForWrites: true;
  oracleRequiredForCompletion: true;
  tempAgentsProposalOnly: true;
  documentationWritebackPolicy: "human_approval_required";
  factoryPromotionPolicy: "smoke_pilot_oracle_human_approval_required";
  templateHash: string;
  templateBodyStored: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

const ADAPTIVE_ZMODE_ALIASES = new Set<string>(["orchestrator"]);

const ADAPTIVE_ZMODE_TEMPLATE_LINES = [
  "# ZOB orchestrator workflow entrypoint",
  "",
  "Use profile: adaptive-chief-vision",
  "Default execution: plan_only",
  "Allowed execution escalation: supervised_readonly only after parent/oracle gates",
  "Root role: Chief Vision non-coding orchestrator",
  "Root work: goal/TODO governance, routing, lightweight synthesis, evidence/blocker decisions",
  "Substantive work: always create/delegate bounded subtasks for exploration, implementation, QA, security, docs, and oracle judgment",
  "Dispatch policy: parent-owned; child-direct dispatch blocked",
  "Write policy: sandbox/manual/oracle/human gates required before writes",
  "Temp agents: run-scoped proposals only until promotion approval + smoke + oracle",
  "Documentation writeback: human_approval_required",
  "Completion: propose_goal_completion only after evidence + oracle PASS/no_ship=false",
];

export function isAdaptiveZmodeAlias(value: string | undefined): value is AdaptiveZmodeAlias {
  return ADAPTIVE_ZMODE_ALIASES.has((value ?? "").trim().toLowerCase());
}

export function renderAdaptiveZmodeTemplate(entry?: Pick<AdaptiveZmodeEntrypoint, "profile" | "executionDefault" | "computeProfileDefault">): string {
  const profile = entry?.profile ?? "adaptive-chief-vision";
  const execution = entry?.executionDefault ?? "plan_only";
  const computeProfile = entry?.computeProfileDefault ?? "high";
  return [
    ...ADAPTIVE_ZMODE_TEMPLATE_LINES,
    "",
    "Suggested tool call (parent-owned):",
    `orchestrate_run profile=${profile} execution=${execution} compute_profile=${computeProfile} goal_id=<active-goal-id> todo_id=<root-todo-id>`,
  ].join("\n");
}

export function resolveAdaptiveZmodeEntrypoint(requestedMode: string): AdaptiveZmodeEntrypoint | undefined {
  const normalized = requestedMode.trim().toLowerCase();
  if (!isAdaptiveZmodeAlias(normalized)) return undefined;
  const template = renderAdaptiveZmodeTemplate({ profile: "adaptive-chief-vision", executionDefault: "plan_only", computeProfileDefault: "high" });
  return {
    schema: "zob.adaptive-zmode-entrypoint.v1",
    requestedMode: normalized,
    accepted: true,
    appliedHarnessMode: "orchestrator",
    profile: "adaptive-chief-vision",
    executionDefault: "plan_only",
    allowedExecutions: ["plan_only", "supervised_readonly"],
    computeProfileDefault: "high",
    rootNonCoding: true,
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    directWriteToolsBlocked: ["bash", "edit", "write"],
    sandboxRequiredForWrites: true,
    oracleRequiredForCompletion: true,
    tempAgentsProposalOnly: true,
    documentationWritebackPolicy: "human_approval_required",
    factoryPromotionPolicy: "smoke_pilot_oracle_human_approval_required",
    templateHash: sha256(template),
    templateBodyStored: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function validateAdaptiveZmodeEntrypoint(entry: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(entry)) return ["entrypoint must be an object"];
  if (entry.schema !== "zob.adaptive-zmode-entrypoint.v1") errors.push("schema must be zob.adaptive-zmode-entrypoint.v1");
  if (!isAdaptiveZmodeAlias(String(entry.requestedMode ?? ""))) errors.push("requestedMode must be orchestrator");
  if (entry.appliedHarnessMode !== "orchestrator") errors.push("adaptive zmode must enter safe orchestrator mode by default");
  if (entry.profile !== "adaptive-chief-vision") errors.push("adaptive zmode must route to adaptive-chief-vision");
  if (entry.executionDefault !== "plan_only") errors.push("adaptive zmode default execution must be plan_only");
  if (!Array.isArray(entry.allowedExecutions) || entry.allowedExecutions.includes("supervised_write") || entry.allowedExecutions.includes("live_write")) errors.push("adaptive zmode allowed executions must not include write/live-write bypasses");
  if (entry.rootNonCoding !== true) errors.push("rootNonCoding must be true");
  if (entry.parentOwnedDispatch !== true || entry.childDirectDispatch !== false) errors.push("dispatch must remain parent-owned with childDirectDispatch=false");
  const directWriteToolsBlocked = Array.isArray(entry.directWriteToolsBlocked) ? entry.directWriteToolsBlocked : [];
  if (!["bash", "edit", "write"].every((tool) => directWriteToolsBlocked.includes(tool))) errors.push("direct write tools must be blocked for Chief Vision root");
  if (entry.sandboxRequiredForWrites !== true) errors.push("sandboxRequiredForWrites must be true");
  if (entry.oracleRequiredForCompletion !== true) errors.push("oracleRequiredForCompletion must be true");
  if (entry.tempAgentsProposalOnly !== true) errors.push("tempAgentsProposalOnly must be true");
  if (entry.documentationWritebackPolicy !== "human_approval_required") errors.push("documentation writeback must require human approval");
  if (typeof entry.templateHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.templateHash)) errors.push("templateHash must be sha256 hex");
  if (entry.templateBodyStored !== false || entry.bodyStored !== false || entry.promptBodiesStored !== false || entry.outputBodiesStored !== false) errors.push("adaptive zmode entrypoint must be body-free");
  return errors;
}
