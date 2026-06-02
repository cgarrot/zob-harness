import type { BillableJobIntake, BudgetSidecar, GoalState } from "../../types.js";

export type StrictGoalSpecAnchorKind = "active_goal" | "orchestrate_run" | "factory_run" | "delegate_write" | "quarantine";

export interface StrictGoalSpecAnchor {
  kind: StrictGoalSpecAnchorKind;
  activeGoal?: GoalState;
  originalUserAsk?: string;
  goal?: string;
  expectedOutput?: string;
  constraints?: string;
  validationEvidence?: string;
  factoryName?: string;
  factoryDescription?: string;
  inputManifest?: string;
  manifestFactory?: string;
  manifestDescription?: string;
  manifestItems?: number;
  taskText?: string;
  requiredTools?: string[];
  operation?: string;
  runId?: string;
}

function extractGoalField(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^\\n]+(?:\\n(?!\\s*[A-Z_]+\\s*:).+)*)`, "i");
  return regex.exec(text)?.[1]?.trim();
}

export function parseGoalState(text: string): GoalState {
  return {
    originalUserAsk: extractGoalField(text, "ORIGINAL_USER_ASK") ?? text,
    activeGoal: extractGoalField(text, "ACTIVE_GOAL") ?? text,
    expectedOutput: extractGoalField(text, "EXPECTED_OUTPUT") ?? "Not specified",
    constraints: extractGoalField(text, "CONSTRAINTS") ?? "Not specified",
    validationEvidence: extractGoalField(text, "VALIDATION_EVIDENCE") ?? "Not specified",
    setAt: new Date().toISOString(),
  };
}

function isPlaceholderValue(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  return !trimmed || /^\[.*\]$/.test(trimmed) || /^(not set|not specified|todo|tbd)$/i.test(trimmed);
}

export function validateGoalState(goal: GoalState | undefined): string[] {
  const errors: string[] = [];
  if (!goal) return ["Active ZOB goal is required. Set /goal_gate or /job_intake before dispatch."];
  if (isPlaceholderValue(goal.originalUserAsk)) errors.push("ORIGINAL_USER_ASK is required and must not be a placeholder");
  if (isPlaceholderValue(goal.activeGoal)) errors.push("ACTIVE_GOAL is required and must not be a placeholder");
  if (isPlaceholderValue(goal.expectedOutput)) errors.push("EXPECTED_OUTPUT is required and must not be a placeholder");
  if (isPlaceholderValue(goal.constraints)) errors.push("CONSTRAINTS is required and must not be a placeholder");
  if (isPlaceholderValue(goal.validationEvidence)) errors.push("VALIDATION_EVIDENCE is required and must not be a placeholder");
  return errors;
}

function validateOptionalGoalText(value: string | undefined, label: string): string[] {
  return isPlaceholderValue(value) ? [`${label} is required and must not be a placeholder`] : [];
}

function extractInlineOriginalUserAsk(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return extractGoalField(text, "ORIGINAL_USER_ASK");
}

function hasWriteTool(tools: string[] | undefined): boolean {
  return (tools ?? []).some((tool) => tool === "edit" || tool === "write");
}

export function validateStrictGoalSpecAnchor(anchor: StrictGoalSpecAnchor | undefined): string[] {
  if (!anchor) return ["Strict goal/spec anchor is required for autonomous/write/factory/orchestrate dispatch"];
  const activeGoalErrors = validateGoalState(anchor.activeGoal);
  if (activeGoalErrors.length === 0) return [];

  const errors: string[] = [];
  if (anchor.kind === "orchestrate_run") {
    errors.push(...validateOptionalGoalText(anchor.originalUserAsk, "original_user_ask"));
    errors.push(...validateOptionalGoalText(anchor.goal, "goal"));
    return errors.map((error) => `orchestrate_run strict goal/spec gate: ${error}`);
  }

  if (anchor.kind === "factory_run") {
    if (isPlaceholderValue(anchor.factoryName)) errors.push("factory name is required");
    if (isPlaceholderValue(anchor.factoryDescription)) errors.push("factory definition description is required");
    if (isPlaceholderValue(anchor.inputManifest)) errors.push("input_manifest is required");
    if (anchor.manifestFactory !== anchor.factoryName) errors.push("input_manifest factory must match requested factory");
    if (typeof anchor.manifestItems !== "number" || anchor.manifestItems < 1) errors.push("input_manifest must contain at least one item");
    return errors.map((error) => `factory_run strict goal/spec gate: ${error}`);
  }

  if (anchor.kind === "delegate_write") {
    if (!hasWriteTool(anchor.requiredTools)) return [];
    const originalUserAsk = anchor.originalUserAsk ?? extractInlineOriginalUserAsk(anchor.taskText);
    errors.push(...validateOptionalGoalText(originalUserAsk, "ORIGINAL_USER_ASK/original_user_ask"));
    errors.push(...validateOptionalGoalText(anchor.taskText, "delegation task contract"));
    return errors.map((error) => `delegate write strict goal/spec gate: ${error}`);
  }

  if (anchor.kind === "quarantine") {
    if (isPlaceholderValue(anchor.operation)) errors.push("quarantine operation is required");
    if (isPlaceholderValue(anchor.runId)) errors.push("quarantine run_id is required");
    return errors.map((error) => `factory quarantine strict goal/spec gate: ${error}`);
  }

  return activeGoalErrors;
}

function numberFromGoalField(text: string, label: string): number | undefined {
  const raw = extractGoalField(text, label);
  if (!raw) return undefined;
  const match = raw.match(/\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function parseBudgetSidecar(text: string): BudgetSidecar | undefined {
  const raw = extractGoalField(text, "BUDGET") ?? extractGoalField(text, "BUDGET_SIDECAR");
  const strictRequested = /\b(strict|enforce|enforced|hard gate)\b/i.test(raw ?? extractGoalField(text, "BUDGET_MODE") ?? extractGoalField(text, "BUDGET_STRICT") ?? "");
  const sidecar: BudgetSidecar = {
    mode: "advisory",
    advisory: true,
    budgetEnforced: false,
    strictRequested,
    strictEnabled: false,
    raw,
    maxCostUsd: numberFromGoalField(text, "BUDGET_MAX_USD") ?? numberFromGoalField(text, "MAX_COST_USD"),
    maxRuns: numberFromGoalField(text, "BUDGET_MAX_RUNS") ?? numberFromGoalField(text, "MAX_RUNS"),
    maxDurationMs: numberFromGoalField(text, "BUDGET_MAX_DURATION_MS") ?? numberFromGoalField(text, "MAX_DURATION_MS"),
    maxParallelChildren: numberFromGoalField(text, "BUDGET_MAX_PARALLEL_CHILDREN") ?? numberFromGoalField(text, "MAX_PARALLEL_CHILDREN"),
  };
  const hasBudget = raw !== undefined || sidecar.maxCostUsd !== undefined || sidecar.maxRuns !== undefined || sidecar.maxDurationMs !== undefined || sidecar.maxParallelChildren !== undefined;
  return hasBudget ? sidecar : undefined;
}

export function parseBillableJobIntake(text: string): BillableJobIntake {
  return {
    schema: "zob.billable-job-intake.v1",
    goal: parseGoalState(text),
    budget: parseBudgetSidecar(text),
    budgetEnforced: false,
    parsedAt: new Date().toISOString(),
  };
}

export function validateBillableJobIntake(intake: BillableJobIntake): string[] {
  const errors = validateGoalState(intake.goal);
  if (intake.budgetEnforced !== false) errors.push("budgetEnforced must remain false for advisory billable intake");
  if (intake.budget && intake.budget.budgetEnforced !== false) errors.push("budget sidecar must be advisory and budgetEnforced=false");
  return errors;
}
