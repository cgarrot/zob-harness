import type { CompactionResult } from "@earendil-works/pi-coding-agent";

import { goalTodoCompletionDiagnostics, summarizeGoalTodos } from "../goal-todos.js";
import { sha256 } from "../utils/hashing.js";
import type { HarnessRuntimeState } from "./state.js";

export const ZOB_COMPACTION_ENTRY_TYPE = "zob-compaction";
export const ZOB_COMPACTION_SUMMARY_SCHEMA = "zob.compaction-summary.v1";
export const ZOB_COMPACTION_DETAILS_SCHEMA = "zob.compaction-details.v1";
export const ZOB_COMPACTION_LEDGER_SCHEMA = "zob.compaction-ledger.v1";
export const ZOB_COMPACTION_TARGET_TOKENS = 5_000;
export const ZOB_COMPACTION_HARD_CAP_TOKENS = 8_000;
const INSTRUCTION_CHAR_LIMIT = ZOB_COMPACTION_HARD_CAP_TOKENS * 4;
const MAX_REF_COUNT = 24;
const MAX_TODO_COUNT = 12;
const MAX_DELEGATION_COUNT = 10;
const MAX_BLOCKER_COUNT = 8;

const CRITICAL_SKILL_REFS = [
  ".pi/skills/zob-compaction-policy/SKILL.md",
  ".pi/skills/zob-tool-router/SKILL.md",
  ".pi/skills/zob-harness/SKILL.md",
  ".pi/skills/zob-goal-todo-tree/SKILL.md",
  ".pi/skills/zob-delegation-routing/SKILL.md",
  ".pi/skills/zob-oracle/SKILL.md",
];

const CRITICAL_DOC_REFS = [
  "docs/ZOB_COMPACTION_POLICY.md",
  "@earendil-works/pi-coding-agent/docs/compaction.md",
];

const ZERO_ACCESS_REF_PATTERN = /(^|\/)(\.env(?:\..*)?|[^/]+\.(?:pem|key))$|^~\/\.(?:ssh|aws)(?:\/|$)/i;
const BODY_LIKE_KEYS = new Set(["task", "prompt", "output", "body", "content", "patch", "diff", "transcript", "rawPrompt", "rawOutput", "rawDiff"]);

export interface ZobCompactionFileRefsInput {
  readFiles?: string[];
  modifiedFiles?: string[];
  fileOps?: { read?: Iterable<string>; written?: Iterable<string>; edited?: Iterable<string> };
}

export interface ZobCompactionInstructionInput extends ZobCompactionFileRefsInput {
  reason?: "manual" | "threshold" | "overflow" | "goal_continuation" | "branch_summary" | "smoke" | string;
  customInstructions?: string;
  additionalCriticalRefs?: string[];
}

interface ZobTodoThreadItem {
  id: string;
  path: string;
  title: string;
  status: string;
  owner: string;
  required: boolean;
  priority: string;
  evidenceRefs: string[];
  validationCommands: string[];
  blocker?: string;
  reviewNoShip?: boolean;
}

export interface ZobCompactionStateCapsule {
  schema: "zob.compaction-capsule.v1";
  generatedAt: string;
  reason: string;
  activeMode: string;
  originalUserAsk?: string;
  activeGoal?: {
    activeGoal: string;
    expectedOutput: string;
    constraints: string;
    validationEvidence: string;
  };
  runtimeGoal?: {
    goalId: string;
    objective: string;
    status: string;
    oracleStatus: string;
    oracleVerdict?: string;
    oracleNoShip?: boolean;
    completionProposalNoShip?: boolean;
    evidenceRefs: string[];
    validationCommands: string[];
  };
  todoThread?: {
    total: number;
    done: number;
    skipped: number;
    open: number;
    active: number;
    blocked: number;
    delegated: number;
    claimReturned: number;
    completionReady: boolean;
    hardNoShip: boolean;
    reviewNoShip: boolean;
    effectiveNoShip: boolean;
    completionBlockers: string[];
    nextAgent?: string;
    nextUser?: string;
    activeOrOpenTodos: ZobTodoThreadItem[];
  };
  ruleProfile?: {
    profile: string;
    rulePacks: string[];
    requiredValidation: string[];
    oracleRequired: boolean | string;
    noShipConditions: string[];
  };
  delegations: Array<{
    runId: string;
    source: string;
    mode: string;
    agent: string;
    status: string;
    gatePassed?: boolean;
    failureKind?: string;
    stopCondition?: string;
    sessionPath?: string;
    cost?: number;
    contextTokens?: number;
  }>;
  fileRefs: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  criticalRefs: {
    skills: string[];
    docs: string[];
    additional: string[];
  };
  budgets: {
    targetSummaryTokens: number;
    hardCapSummaryTokens: number;
  };
  reloadRules: string[];
  bodyPolicy: string[];
  nextAction: string;
}

export interface ZobCompactionDetails {
  schema: typeof ZOB_COMPACTION_DETAILS_SCHEMA;
  summaryHash?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  activeMode: string;
  goalId?: string;
  runtimeGoalStatus?: string;
  todoCounts?: {
    total: number;
    open: number;
    blocked: number;
    delegated: number;
    claimReturned: number;
  };
  noShip?: {
    hardNoShip: boolean;
    reviewNoShip: boolean;
    effectiveNoShip: boolean;
  };
  delegationCounts: {
    total: number;
    running: number;
    failed: number;
    complete: number;
  };
  fileRefs: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  criticalRefs: {
    skills: string[];
    docs: string[];
  };
  policy: {
    targetSummaryTokens: number;
    hardCapSummaryTokens: number;
    refsNotBodies: true;
    sourceOfTruth: string[];
  };
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface ZobCompactionLedgerEntry extends Omit<ZobCompactionDetails, "schema"> {
  schema: typeof ZOB_COMPACTION_LEDGER_SCHEMA;
  event: "session_compact" | "session_tree";
  fromExtension?: boolean;
  at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}

function safeRef(ref: string): boolean {
  return !ZERO_ACCESS_REF_PATTERN.test(ref.trim());
}

function safeRefs(refs: string[], limit = MAX_REF_COUNT): string[] {
  return unique(refs.map((ref) => ref.trim()).filter(safeRef)).slice(0, limit);
}

function iterableStrings(value: Iterable<string> | undefined): string[] {
  return value ? [...value].filter((item) => typeof item === "string") : [];
}

function fileRefsFromInput(input: ZobCompactionFileRefsInput): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = safeRefs([
    ...(input.modifiedFiles ?? []),
    ...iterableStrings(input.fileOps?.written),
    ...iterableStrings(input.fileOps?.edited),
  ]);
  const modifiedSet = new Set(modified);
  const read = safeRefs([
    ...(input.readFiles ?? []),
    ...iterableStrings(input.fileOps?.read),
  ].filter((ref) => !modifiedSet.has(ref)));
  return { readFiles: read, modifiedFiles: modified };
}

function truncate(value: string | undefined, limit = 420): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function capArray(values: string[], limit: number, itemLimit = 220): string[] {
  return values.slice(0, limit).map((value) => truncate(value, itemLimit) ?? "");
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function truncateInstruction(value: string): string {
  if (value.length <= INSTRUCTION_CHAR_LIMIT) return value;
  const keepHead = Math.floor(INSTRUCTION_CHAR_LIMIT * 0.82);
  const keepTail = INSTRUCTION_CHAR_LIMIT - keepHead - 160;
  return `${value.slice(0, keepHead)}\n\n[ZOB_COMPACTION_INSTRUCTIONS_TRUNCATED: keep blockers/no_ship/TODO/next_action; drop resolved detail]\n\n${value.slice(-keepTail)}`;
}

function todoItemLabel(item: { path: string; title: string; status: string }): string {
  return `${item.path} ${item.title} [${item.status}]`;
}

export function buildZobCompactionStateCapsule(state: HarnessRuntimeState, input: ZobCompactionInstructionInput = {}): ZobCompactionStateCapsule {
  const goal = state.runtimeGoal;
  const goalId = goal?.goalId;
  const todoState = state.goalTodos;
  const todoSummary = goalId && todoState ? summarizeGoalTodos(todoState, goalId) : undefined;
  const todoDiagnostics = goalId && todoState ? goalTodoCompletionDiagnostics(todoState, goalId) : undefined;
  const goalTodos = goalId && todoState ? todoState.nodes.filter((node) => node.goalId === goalId) : [];
  const activeOrOpenTodos = goalTodos
    .filter((node) => node.status !== "done" && node.status !== "skipped")
    .slice(0, MAX_TODO_COUNT)
    .map((node): ZobTodoThreadItem => ({
      id: node.id,
      path: node.path,
      title: truncate(node.title, 180) ?? node.title,
      status: node.status,
      owner: node.owner,
      required: node.required,
      priority: node.priority,
      evidenceRefs: safeRefs(node.evidenceRefs, 4),
      validationCommands: capArray(node.validationCommands, 4, 160),
      blocker: truncate(node.blocker, 220),
      reviewNoShip: node.reviewNoShip,
    }));
  const nextAgent = todoSummary?.nextAgent ? todoItemLabel(todoSummary.nextAgent) : undefined;
  const nextUser = todoSummary?.nextUser ? todoItemLabel(todoSummary.nextUser) : undefined;
  const delegations = (state.delegations?.runs ?? []).slice(0, MAX_DELEGATION_COUNT).map((run) => ({
    runId: run.id,
    source: run.source,
    mode: run.mode,
    agent: run.agent,
    status: run.status,
    gatePassed: run.gatePassed,
    failureKind: run.failureKind,
    stopCondition: run.stopCondition,
    sessionPath: run.sessionPath && safeRef(run.sessionPath) ? run.sessionPath : undefined,
    cost: run.usage?.cost,
    contextTokens: run.usage?.contextTokens,
  }));
  const rules = state.activeRuleResolution;
  return {
    schema: "zob.compaction-capsule.v1",
    generatedAt: nowIso(),
    reason: input.reason ?? "compaction",
    activeMode: state.activeMode,
    originalUserAsk: truncate(state.activeGoal?.originalUserAsk ?? state.lastUserInputText, 520),
    activeGoal: state.activeGoal
      ? {
        activeGoal: truncate(state.activeGoal.activeGoal, 520) ?? "",
        expectedOutput: truncate(state.activeGoal.expectedOutput, 360) ?? "",
        constraints: truncate(state.activeGoal.constraints, 420) ?? "",
        validationEvidence: truncate(state.activeGoal.validationEvidence, 420) ?? "",
      }
      : undefined,
    runtimeGoal: goal
      ? {
        goalId: goal.goalId,
        objective: truncate(goal.objective, 620) ?? goal.objective,
        status: goal.status,
        oracleStatus: goal.oracle.status,
        oracleVerdict: goal.oracle.verdict,
        oracleNoShip: goal.oracle.noShip,
        completionProposalNoShip: goal.completionProposal?.noShip,
        evidenceRefs: safeRefs(goal.oracle.evidenceRefs, 8),
        validationCommands: goal.completionProposal ? capArray(goal.completionProposal.validationCommands, 8, 160) : [],
      }
      : undefined,
    todoThread: todoSummary && todoDiagnostics
      ? {
        total: todoSummary.total,
        done: todoSummary.done,
        skipped: todoSummary.skipped,
        open: todoSummary.open,
        active: todoSummary.active,
        blocked: todoSummary.blocked,
        delegated: todoSummary.delegated,
        claimReturned: todoSummary.claimReturned,
        completionReady: todoDiagnostics.completionReady,
        hardNoShip: todoDiagnostics.hardNoShip,
        reviewNoShip: todoDiagnostics.reviewNoShip,
        effectiveNoShip: todoDiagnostics.effectiveNoShip,
        completionBlockers: capArray(todoDiagnostics.completionBlockers, MAX_BLOCKER_COUNT, 220),
        nextAgent,
        nextUser,
        activeOrOpenTodos,
      }
      : undefined,
    ruleProfile: rules
      ? {
        profile: rules.profile,
        rulePacks: rules.rulePacks,
        requiredValidation: capArray(rules.requiredValidation, 8, 160),
        oracleRequired: rules.oracleRequired,
        noShipConditions: capArray(rules.noShipConditions, 8, 160),
      }
      : undefined,
    delegations,
    fileRefs: fileRefsFromInput(input),
    criticalRefs: {
      skills: safeRefs(CRITICAL_SKILL_REFS),
      docs: safeRefs(CRITICAL_DOC_REFS),
      additional: safeRefs(input.additionalCriticalRefs ?? []),
    },
    budgets: {
      targetSummaryTokens: ZOB_COMPACTION_TARGET_TOKENS,
      hardCapSummaryTokens: ZOB_COMPACTION_HARD_CAP_TOKENS,
    },
    reloadRules: [
      "After compaction, trust persisted ZOB state and cited artifacts over summary prose.",
      "Re-read critical skills/docs/files by path before applying detailed behavior or editing.",
      "Re-check get_goal/get_goal_todos before completion, delegation, or oracle proposal.",
      "Do not treat compacted tool output summaries as validation evidence; use commands/artifact refs.",
    ],
    bodyPolicy: [
      "Persist refs, hashes, statuses, counts, goal/TODO ids, and artifact paths only.",
      "Do not persist raw prompt bodies, raw subagent outputs, raw tool outputs, raw diffs, secrets, or credentials in ZOB compaction details/ledgers.",
      "The natural-language compaction summary should avoid verbatim prompt/output dumps and stay under the hard cap.",
    ],
    nextAction: nextAgent ?? nextUser ?? "Resume from the latest user ask and verify live goal/TODO/evidence state before claiming completion.",
  };
}

export function buildZobCompactionInstructions(state: HarnessRuntimeState, input: ZobCompactionInstructionInput = {}): string {
  const capsule = buildZobCompactionStateCapsule(state, input);
  const custom = input.customInstructions?.trim();
  const lines = [
    "ZOB-AWARE COMPACTION INSTRUCTIONS",
    `- Output a compact ${ZOB_COMPACTION_SUMMARY_SCHEMA} summary, not a continuation answer.`,
    `- Target ${ZOB_COMPACTION_TARGET_TOKENS} tokens; hard cap ${ZOB_COMPACTION_HARD_CAP_TOKENS} tokens.`,
    "- Preserve refs, decisions, state, evidence, blockers/no_ship, and next action; do not paste full skills/prompts/files/outputs.",
    "- Mandatory sections: original_user_ask, active_mode, runtime_goal, todo_thread, work_thread, critical_refs, decisions, files, delegations, evidence, validations, blockers_no_ship, reload_rules, next_action, body_policy.",
    "- Source-of-truth order after compaction: persisted ZOB state > repo files/artifacts > compaction summary > old model memory.",
    "- If shrinking is needed, drop resolved detail first; never drop blockers, no_ship, active TODOs, evidence refs, waits, or next action.",
    custom ? `- Operator/custom compaction focus: ${custom}` : undefined,
    "",
    "Transient ZOB continuity capsule; summarize it, do not store it verbatim:",
    compactJson(capsule),
  ].filter((line): line is string => typeof line === "string");
  return truncateInstruction(lines.join("\n"));
}

function delegationCounts(state: HarnessRuntimeState): ZobCompactionDetails["delegationCounts"] {
  return {
    total: state.delegations.runs.length,
    running: state.delegations.runs.filter((run) => run.status === "running" || run.status === "queued").length,
    failed: state.delegations.runs.filter((run) => run.status === "failed" || run.status === "preflight_failed" || run.status === "aborted").length,
    complete: state.delegations.runs.filter((run) => run.status === "complete").length,
  };
}

export function buildZobCompactionDetails(state: HarnessRuntimeState, input: ZobCompactionFileRefsInput & { summary?: string; firstKeptEntryId?: string; tokensBefore?: number } = {}): ZobCompactionDetails {
  const goal = state.runtimeGoal;
  const goalId = goal?.goalId;
  const todoSummary = goalId ? summarizeGoalTodos(state.goalTodos, goalId) : undefined;
  const todoDiagnostics = goalId ? goalTodoCompletionDiagnostics(state.goalTodos, goalId) : undefined;
  return {
    schema: ZOB_COMPACTION_DETAILS_SCHEMA,
    summaryHash: input.summary ? sha256(input.summary) : undefined,
    firstKeptEntryId: input.firstKeptEntryId,
    tokensBefore: input.tokensBefore,
    activeMode: state.activeMode,
    goalId,
    runtimeGoalStatus: goal?.status,
    todoCounts: todoSummary
      ? {
        total: todoSummary.total,
        open: todoSummary.open,
        blocked: todoSummary.blocked,
        delegated: todoSummary.delegated,
        claimReturned: todoSummary.claimReturned,
      }
      : undefined,
    noShip: todoDiagnostics
      ? {
        hardNoShip: todoDiagnostics.hardNoShip,
        reviewNoShip: todoDiagnostics.reviewNoShip,
        effectiveNoShip: todoDiagnostics.effectiveNoShip,
      }
      : undefined,
    delegationCounts: delegationCounts(state),
    fileRefs: fileRefsFromInput(input),
    criticalRefs: {
      skills: safeRefs(CRITICAL_SKILL_REFS),
      docs: safeRefs(CRITICAL_DOC_REFS),
    },
    policy: {
      targetSummaryTokens: ZOB_COMPACTION_TARGET_TOKENS,
      hardCapSummaryTokens: ZOB_COMPACTION_HARD_CAP_TOKENS,
      refsNotBodies: true,
      sourceOfTruth: ["persisted_zob_state", "repo_files_and_artifacts", "compaction_summary", "old_model_memory"],
    },
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildZobCompactionLedgerEntry(state: HarnessRuntimeState, input: ZobCompactionFileRefsInput & { event: "session_compact" | "session_tree"; summary?: string; firstKeptEntryId?: string; tokensBefore?: number; fromExtension?: boolean }): ZobCompactionLedgerEntry {
  return {
    ...buildZobCompactionDetails(state, input),
    schema: ZOB_COMPACTION_LEDGER_SCHEMA,
    event: input.event,
    fromExtension: input.fromExtension,
    at: nowIso(),
  };
}

export function buildDeterministicZobCompactionSummary(state: HarnessRuntimeState, input: ZobCompactionInstructionInput = {}): string {
  const capsule = buildZobCompactionStateCapsule(state, input);
  const lines = [
    `## schema\n${ZOB_COMPACTION_SUMMARY_SCHEMA}`,
    `## original_user_ask\n${capsule.originalUserAsk ?? "unknown; inspect current user ask and persisted goal state"}`,
    `## active_mode\n${capsule.activeMode}`,
    `## runtime_goal\n${capsule.runtimeGoal ? compactJson(capsule.runtimeGoal) : "none"}`,
    `## todo_thread\n${capsule.todoThread ? compactJson(capsule.todoThread) : "none"}`,
    `## work_thread\nCurrent continuation reason: ${capsule.reason}. Next action: ${capsule.nextAction}`,
    `## critical_refs\n${compactJson(capsule.criticalRefs)}`,
    `## decisions\n- Preserve refs/state/evidence/blockers/next action instead of full bodies.\n- Trust persisted ZOB state and cited artifacts over compacted memory.`,
    `## files\n${compactJson(capsule.fileRefs)}`,
    `## delegations\n${compactJson(capsule.delegations)}`,
    `## evidence\nRuntime evidence refs and validation commands are in runtime_goal/todo_thread; re-read artifacts before completion.`,
    `## validations\n${capsule.ruleProfile ? compactJson(capsule.ruleProfile.requiredValidation) : "Re-run required validation from rule profile before completion."}`,
    `## blockers_no_ship\n${capsule.todoThread ? compactJson({ hardNoShip: capsule.todoThread.hardNoShip, reviewNoShip: capsule.todoThread.reviewNoShip, effectiveNoShip: capsule.todoThread.effectiveNoShip, completionBlockers: capsule.todoThread.completionBlockers }) : "unknown; inspect get_goal/get_goal_todos before completion"}`,
    `## reload_rules\n${capsule.reloadRules.map((rule) => `- ${rule}`).join("\n")}`,
    `## next_action\n${capsule.nextAction}`,
    `## body_policy\n${capsule.bodyPolicy.map((rule) => `- ${rule}`).join("\n")}`,
  ];
  return truncateInstruction(lines.join("\n\n"));
}

export function buildDeterministicZobCompactionResult(state: HarnessRuntimeState, preparation: { firstKeptEntryId: string; tokensBefore: number }, input: ZobCompactionInstructionInput = {}): CompactionResult<ZobCompactionDetails> {
  const summary = buildDeterministicZobCompactionSummary(state, input);
  return {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: buildZobCompactionDetails(state, {
      ...input,
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }),
  };
}

export function withZobCompactionDetails<T>(state: HarnessRuntimeState, result: CompactionResult<T>, input: ZobCompactionFileRefsInput = {}): CompactionResult<ZobCompactionDetails> {
  return {
    ...result,
    details: buildZobCompactionDetails(state, {
      ...input,
      summary: result.summary,
      firstKeptEntryId: result.firstKeptEntryId,
      tokensBefore: result.tokensBefore,
    }),
  };
}

export function zobCompactionBodyFreeViolations(value: unknown, path = "root"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => zobCompactionBodyFreeViolations(item, `${path}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const current = `${path}.${key}`;
    const self = BODY_LIKE_KEYS.has(key) ? [current] : [];
    return [...self, ...zobCompactionBodyFreeViolations(child, current)];
  });
}
