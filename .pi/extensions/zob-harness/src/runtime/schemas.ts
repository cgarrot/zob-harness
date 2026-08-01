import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { ProjectDnaReadinessParams, ProjectDnaPlanWorkflowParams, ProjectDnaQueryParams, ProjectDnaFederatedQueryParams, ProjectDnaWritebackProposalParams } from "./schemas-project-dna.js";
import { CANONICAL_GOAL_TODO_ID_PATTERN, VISIBLE_GOAL_TODO_PATH_PATTERN } from "../domains/goal/goal-todos/reference.js";

export { GoalMutationGuardProperties, GoalMutationGuardSchema, parseOptionalGoalMutationGuard } from "./goal-runtime/schemas.js";

const AgentScopeSchema = StringEnum(["project", "user", "both"] as const, {
  description: "Which agent catalog to use. Default: project.",
  default: "project",
});

const ThinkingLevelSchema = StringEnum(["low", "medium", "high", "xhigh"] as const, {
  description: "Optional explicit child reasoning effort override. Defaults remain agent/session-configured when omitted.",
});

const AgenticClaimValidationParams = Type.Object({
  mode: Type.Optional(StringEnum(["off", "oracle_then_auto_accept"] as const, { description: "Agentic validation mode for TODO-linked child claims. Default off for compatibility." })),
  oracle_agent: Type.Optional(Type.String({ description: "Oracle agent to validate returned claim. Default oracle." })),
  auto_accept_on_pass: Type.Optional(Type.Boolean({ description: "Auto-accept the returned TODO claim after oracle PASS/no_ship=false and strict claim gates. Default true when mode=oracle_then_auto_accept." })),
  output_contract: Type.Optional(Type.String({ description: "Oracle validation output contract. Default todo-claim-validation.v1." })),
});

const ChildGoalParams = Type.Object({
  enabled: Type.Optional(Type.Boolean({ description: "Enable parent-owned child goal guidance for long delegated tasks. Default true when child_goal is provided." })),
  objective: Type.String({ description: "Child goal objective to pursue inside the delegated task." }),
  todo_id: Type.Optional(Type.String({ description: "Exact canonical active-goal TODO node ID. Paths and legacy todo_<path> shorthands are rejected without fallback.", pattern: CANONICAL_GOAL_TODO_ID_PATTERN.source })),
  parent_todo_id: Type.Optional(Type.String({ description: "Exact canonical parent TODO node ID. When supplied it must be the resolved TODO's actual parent.", pattern: CANONICAL_GOAL_TODO_ID_PATTERN.source })),
  todo_path: Type.Optional(Type.String({ description: "Exact visible dotted TODO path, e.g. 1.2. Canonical IDs and legacy shorthands are rejected; dual ID/path refs must resolve independently to the same node.", pattern: VISIBLE_GOAL_TODO_PATH_PATTERN.source })),
  delegation_depth: Type.Optional(Type.Integer({ description: "Parent-owned delegation depth for TODO-linked child work.", minimum: 0 })),
  request_id: Type.Optional(Type.String({ description: "Adaptive delegation request id when this child is dispatched from a governor decision." })),
  oracle_required: Type.Optional(Type.Boolean({ description: "Whether parent/oracle review is required before accepting the child goal. Default true." })),
  max_turns: Type.Optional(Type.Integer({ description: "Advisory maximum child continuation turns for future parent-managed loops.", minimum: 1 })),
  max_tokens: Type.Optional(Type.Integer({ description: "Advisory maximum child tokens for future parent-managed loops.", minimum: 1 })),
  completion_policy: Type.Optional(StringEnum(["return_claim", "oracle_before_complete"] as const, { description: "How the child should exit. P0 supports return_claim only; parent/oracle decides completion." })),
  agentic_validation: Type.Optional(AgenticClaimValidationParams),
});

const TaskItem = Type.Object({
  agent: Type.String({ description: "Specialist agent name" }),
  task: Type.String({ description: "Required exact six-part contract with literal TASK, EXPECTED OUTCOME, REQUIRED TOOLS, MUST DO, MUST NOT DO, and CONTEXT sections. A focused prompt without these sections is rejected." }),
  cwd: Type.Optional(Type.String({ description: "Override cwd for this child Pi process" })),
  thinking: Type.Optional(ThinkingLevelSchema),
  child_goal: Type.Optional(ChildGoalParams),
});

const DelegateParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name for single-agent mode" })),
  task: Type.Optional(Type.String({ description: "Task for single-agent mode" })),
  cwd: Type.Optional(Type.String({ description: "Default cwd for delegate_agent child Pi processes. Must stay inside repo; tasks[].cwd and chain[].cwd override this value." })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks. Max 8, 4 concurrent." })),
  chain: Type.Optional(Type.Array(TaskItem, { description: "Sequential chain. {previous} is replaced by prior output." })),
  scope: Type.Optional(AgentScopeSchema),
  model: Type.Optional(Type.String({ description: "Exceptional explicit model override for all delegated children. Normally omit to use the parent/session default. Use only with current runtime availability/auth proof for the concrete provider/model; desired/configured/catalogued models are not availability proof." })),
  thinking: Type.Optional(ThinkingLevelSchema),
  tools: Type.Optional(Type.String({ description: "Override comma-separated tool allowlist for all children. Must be a subset of the selected agent tools." })),
  child_goal: Type.Optional(ChildGoalParams),
  allowed_paths: Type.Optional(Type.Array(Type.String(), { description: "Repo-relative-only paths delegated children may inspect/change. Absolute, home, traversal, broad-root, and NUL paths are rejected; use repo-local reports/... snapshot/context_ref artifacts for external context. Required when effective tools include edit/write." })),
  forbidden_paths: Type.Optional(Type.Array(Type.String(), { description: "Deny-only path patterns delegated children must not touch. May be repo-local, absolute, or home-relative; broad roots are rejected." })),
});

const DelegationCatalogParams = Type.Object({
  scope: Type.Optional(AgentScopeSchema),
  include_contract_requirements: Type.Optional(Type.Boolean({ description: "Include required marker names for each valid output contract. Default false for compact routing." })),
});

const DelegateTaskParams = Type.Object({
  agent: Type.String({ description: "Specialist agent name" }),
  task: Type.String({ description: "Atomic task statement" }),
  expected_outcome: Type.Optional(Type.String({ description: "Canonical observable artifact, verdict, or change. Required after safe alias normalization." })),
  expectedOutcome: Type.Optional(Type.String({ description: "Safe alias for expected_outcome. Conflicts with canonical values are blocked before child launch." })),
  required_tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool subset for this task. Normally omit; the harness infers the selected agent's declared tools. Only set to narrow tools, never to add tools not listed by zob_delegation_catalog." })),
  requiredTools: Type.Optional(Type.Array(Type.String(), { description: "Safe alias for required_tools. Conflicts with canonical values are blocked before child launch." })),
  must_do: Type.Optional(Type.Array(Type.String(), { description: "Canonical positive constraints. Required after safe alias normalization." })),
  mustDo: Type.Optional(Type.Array(Type.String(), { description: "Safe alias for must_do. Conflicts with canonical values are blocked before child launch." })),
  must_not_do: Type.Optional(Type.Array(Type.String(), { description: "Canonical hard stops. Required after safe alias normalization." })),
  mustNotDo: Type.Optional(Type.Array(Type.String(), { description: "Safe alias for must_not_do. Conflicts with canonical values are blocked before child launch." })),
  must_not: Type.Optional(Type.Array(Type.String(), { description: "Safe alias for must_not_do. Conflicts with canonical values are blocked before child launch." })),
  mustNot: Type.Optional(Type.Array(Type.String(), { description: "Safe alias for must_not_do. Conflicts with canonical values are blocked before child launch." })),
  context: Type.String({ description: "Paths, prior evidence, downstream use" }),
  original_user_ask: Type.Optional(Type.String({ description: "Original human request for scope anchoring. Required for write-enabled delegate_task calls when effective tools include edit/write; context text does not satisfy the strict write preflight gate." })),
  originalUserAsk: Type.Optional(Type.String({ description: "Safe alias for original_user_ask. Conflicts with canonical values are blocked before child launch." })),
  allowed_paths: Type.Optional(Type.Array(Type.String(), { description: "Repo-relative-only paths this task is allowed to inspect/change; external context must be represented by repo-local reports/... snapshot/context_ref refs" })),
  allowedPaths: Type.Optional(Type.Array(Type.String(), { description: "Safe alias for allowed_paths. Conflicts with canonical values are blocked before child launch; values must remain repo-relative only." })),
  forbidden_paths: Type.Optional(Type.Array(Type.String(), { description: "Deny-only path patterns this task must not touch. May be repo-local, absolute, or home-relative; broad roots are rejected." })),
  forbiddenPaths: Type.Optional(Type.Array(Type.String(), { description: "Safe alias for forbidden_paths. Conflicts with canonical values are blocked before child launch." })),
  output_contract: Type.Optional(Type.String({ description: "Optional exact output contract id. Normally omit; the harness infers it from agent. If uncertain, call zob_delegation_catalog first. Do not invent ids." })),
  outputContract: Type.Optional(Type.String({ description: "Safe alias for output_contract. Conflicts with canonical values are blocked before child launch." })),
  child_goal: Type.Optional(ChildGoalParams),
  childGoal: Type.Optional(ChildGoalParams),
  run_in_background: Type.Optional(Type.Boolean({ description: "Run this delegate_task in active-session background when enabled by parent. Returns runId immediately; no daemon/auto-start.", default: false })),
  runInBackground: Type.Optional(Type.Boolean({ description: "Safe alias for run_in_background. Conflicts with canonical values are blocked before child launch." })),
  load_skills: Type.Optional(Type.Array(Type.String(), { description: "Reserved skill list. Default empty." })),
  loadSkills: Type.Optional(Type.Array(Type.String(), { description: "Safe alias for load_skills; still reserved by the P0 gate when non-empty." })),
  cwd: Type.Optional(Type.String({ description: "Override cwd for this child Pi process. Must stay inside repo." })),
  scope: Type.Optional(AgentScopeSchema),
  model: Type.Optional(Type.String({ description: "Exceptional explicit model override for this child. Normally omit to use the parent/session default. Use only with current runtime availability/auth proof for the concrete provider/model; desired/configured/catalogued models are not availability proof." })),
  thinking: Type.Optional(ThinkingLevelSchema),
});

const DelegationRunParams = Type.Object({
  run_id: Type.String({ description: "Delegation run id returned by delegate_task/delegate_agent." }),
});

const AwaitDelegationRunParams = Type.Object({
  run_id: Type.String({ description: "Delegation run id returned by a background delegate_task." }),
  timeout_ms: Type.Optional(Type.Number({ description: "Bounded await timeout in milliseconds. Capped by runtime; brief caps at 30s, long_idle caps at 300s." })),
  wait_mode: Type.Optional(StringEnum(["brief", "long_idle"] as const, { description: "Wait behavior. brief preserves the short bounded wait for quick checks; long_idle is a passive bounded wait for parents that want to idle longer without polling. No daemon or wakeup is started.", default: "brief" })),
  include_result: Type.Optional(Type.Boolean({ description: "Include the full child result on completion. Set false for compact status/hash metadata only. Default true for compatibility." })),
});

const BudgetCapsParams = Type.Object({
  maxCostUsd: Type.Optional(Type.Number({ description: "Maximum allowed cost in USD for strict budget gate evaluation." })),
  maxRuns: Type.Optional(Type.Number({ description: "Maximum allowed child/run count for strict budget gate evaluation." })),
  maxDurationMs: Type.Optional(Type.Number({ description: "Maximum allowed duration in milliseconds for strict budget gate evaluation." })),
  maxParallelChildren: Type.Optional(Type.Number({ description: "Maximum allowed parallel child count for strict budget gate evaluation." })),
  strictEnabled: Type.Optional(Type.Boolean({ description: "Explicitly enable strict budget dispatch blocking for this run. Default false." })),
  strictRequested: Type.Optional(Type.Boolean({ description: "Record that strict budget behavior was requested. Does not block unless strictEnabled=true." })),
  estimatedCostUsd: Type.Optional(Type.Number({ description: "Estimated cost in USD used by strict budget dispatch gate." })),
  estimatedRuns: Type.Optional(Type.Number({ description: "Estimated child/run count used by strict budget dispatch gate." })),
  estimatedDurationMs: Type.Optional(Type.Number({ description: "Estimated duration in milliseconds used by strict budget dispatch gate." })),
  estimatedParallelChildren: Type.Optional(Type.Number({ description: "Estimated parallel children used by strict budget dispatch gate." })),
});

const ModelRoutingParams = Type.Object({
  enabled: Type.Optional(Type.Boolean({ description: "Explicitly enable per-run model-class routing for agentic factory child dispatch. Default false." })),
  modelByClass: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional model override by model class. Values are passed to child dispatch only when routing is enabled." })),
  risk: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "Optional risk hint for routing." })),
  contextTokens: Type.Optional(Type.Number({ description: "Optional context-token estimate for high-context routing." })),
});

const ComputeProfileEnum = StringEnum(["auto", "low", "medium", "high", "xhigh", "max"] as const, {
  description: "Requested compute/effort profile. auto resolves to low/medium/high/xhigh/max from preview scores.",
  default: "auto",
});

const ComputeEffectiveProfileEnum = StringEnum(["low", "medium", "high", "xhigh", "max"] as const, {
  description: "Maximum or effective compute/effort profile.",
});

const ComputeCapsParams = Type.Object({
  maxAgents: Type.Optional(Type.Number({ description: "Maximum planned/allowed agent count for this compute scope." })),
  maxDelegationDepth: Type.Optional(Type.Number({ description: "Maximum parent-owned delegation depth for this compute scope." })),
  maxParallel: Type.Optional(Type.Number({ description: "Maximum concurrent children/lanes for this compute scope." })),
  maxIterations: Type.Optional(Type.Number({ description: "Maximum planning/execution validation iterations for this compute scope." })),
  maxDurationMs: Type.Optional(Type.Number({ description: "Maximum wall-clock duration budget in milliseconds." })),
  maxCostUsd: Type.Optional(Type.Number({ description: "Maximum cost budget in USD for strict/advisory budget gates." })),
  maxContextTokens: Type.Optional(Type.Number({ description: "Maximum context-token budget for context packs or previewed workflow shape." })),
  strictBudgetRequired: Type.Optional(Type.Boolean({ description: "Whether strict budget gates are required before live dispatch at this profile." })),
  oracleRequired: Type.Optional(Type.Boolean({ description: "Whether oracle review is required for completion at this profile." })),
});

const ComputeProfileBaseParams = Type.Object({
  run_id: Type.Optional(Type.String({ description: "Optional deterministic compute profile run id. Must be path-safe when reports are written." })),
  domain: Type.Optional(StringEnum(["generic", "project-dna", "factory", "orchestration"] as const, { description: "Domain hint for compute scoring. Default generic." })),
  requested_profile: Type.Optional(ComputeProfileEnum),
  target_path: Type.Optional(Type.String({ description: "Repo-relative target path for metadata-only preview. Runtime tools keep this inside the repo root." })),
  task_hash: Type.Optional(Type.String({ description: "sha256 hash of the task/spec body. Raw task text is not accepted or persisted." })),
  max_profile: Type.Optional(ComputeEffectiveProfileEnum),
  compute_caps: Type.Optional(ComputeCapsParams),
  risk_hints: Type.Optional(Type.Array(Type.String(), { description: "Bounded risk hints such as write, network, browser, cloud, durable, or promotion." })),
});

const ComputePreviewParams = ComputeProfileBaseParams;
const ComputeResolveProfileParams = ComputeProfileBaseParams;
const ComputeWriteProfileReportsParams = ComputeProfileBaseParams;

const ComputeValidateProfileParams = Type.Object({
  preview_path: Type.String({ description: "Repo-relative compute-preview.json artifact to validate." }),
  resolution_path: Type.Optional(Type.String({ description: "Optional repo-relative compute-profile-resolution.json artifact to validate." })),
});

const ComputePlanWorkflowParams = Type.Object({
  ...ComputeProfileBaseParams.properties,
  resolution_path: Type.Optional(Type.String({ description: "Optional repo-relative compute-profile-resolution.json artifact to shape into workflow lanes." })),
});

const AdaptiveDelegationParams = Type.Object({
  enabled: Type.Optional(Type.Boolean({ description: "Explicitly enable adaptive hierarchical delegation proposals. Default false." })),
  mode: Type.Optional(StringEnum(["off", "advisory_only", "when_pertinent"] as const, { description: "off disables; advisory_only scores/records without dispatch; when_pertinent may dispatch only through parent-owned gates." })),
  dispatch: Type.Optional(Type.Boolean({ description: "Allow parent-owned live dispatch after gates. Default false." })),
  recordDecisionsOnly: Type.Optional(Type.Boolean({ description: "Record governor decisions without live dispatch. Default true unless dispatch=true." })),
  configuredMaxDepth: Type.Optional(Type.Number({ description: "Hard configured depth cap. Must be <= 4." })),
  runtimeMaxDepth: Type.Optional(Type.Number({ description: "Rollout depth cap for this run. Starts at 1 and must be <= configuredMaxDepth." })),
  rootFanoutMax: Type.Optional(Type.Number({ description: "Maximum adaptive requests directly below root." })),
  nodeFanoutMax: Type.Optional(Type.Number({ description: "Maximum adaptive requests per non-root requester." })),
  globalParallelMax: Type.Optional(Type.Number({ description: "Maximum live adaptive child dispatches in one wave." })),
  maxTotalAgents: Type.Optional(Type.Number({ description: "Default total adaptive agent cap before oracle/human gates." })),
  maxTotalAgentsWithOracle: Type.Optional(Type.Number({ description: "Hard adaptive total agent cap with oracle/human gates. Must be <= 30." })),
  ttlPerRequest: Type.Optional(Type.Number({ description: "Default TTL for adaptive delegation requests." })),
  minApprovalScore: Type.Optional(Type.Number({ description: "Minimum governor-computed approval score between 0 and 1." })),
  oracle: Type.Optional(StringEnum(["off", "conditional", "always"] as const, { description: "Oracle policy for high-risk/deep/ambiguous adaptive delegation." })),
  strictBudgetRequired: Type.Optional(Type.Boolean({ description: "Require strict budget gates before live adaptive dispatch. Default true." })),
  sandboxGate: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean({ description: "Enable P9 sandbox/write proposal metadata. Live write dispatch remains disabled." })),
    mode: Type.Optional(StringEnum(["off", "proposal_only"] as const, { description: "P9 supports proposal_only metadata only; no live write dispatch." })),
    sandboxRunId: Type.Optional(Type.String({ description: "Sandbox run id. Stored only as sandboxRunIdHash in artifacts." })),
    diffReviewGateHash: Type.Optional(Type.String({ description: "sha256 of an approved sandbox diff review gate artifact." })),
    applyReadinessHash: Type.Optional(Type.String({ description: "sha256 of a sandbox apply-readiness artifact." })),
    approvalHash: Type.Optional(Type.String({ description: "sha256 of human approval metadata for sandbox/write path." })),
  }, { description: "P9 sandbox/write gate metadata. Does not enable live adaptive writes or auto-apply." })),
  scaleApproval: Type.Optional(Type.Object({ 
    approvedBy: Type.Optional(Type.String({ description: "Human/operator approver identifier. Stored only as approvedByHash in artifacts." })),
    approvedAt: Type.Optional(Type.String({ description: "Human/operator approval timestamp or date for 20/30-agent adaptive scale." })),
    approvalId: Type.Optional(Type.String({ description: "Approval ticket/id. Stored only as approvalIdHash in artifacts." })),
    scope: Type.Optional(Type.String({ description: "Approval scope. Stored only as scopeHash in artifacts." })),
  }, { description: "Required for live adaptive 20/30-agent scale above 20. Raw identifiers are accepted only as input and persisted as hashes." })),
});

const FactoryRunParams = Type.Object({
  factory: Type.String({ description: "Factory name under .pi/factories/<name>/factory.json" }),
  input_manifest: Type.String({ description: "Repo-relative JSON manifest with factory and items[]" }),
  run_id: Type.Optional(Type.String({ description: "Optional deterministic run id. Must be path-safe." })),
  mode: Type.Optional(StringEnum(["smoke", "pilot", "batch"] as const, { description: "Run scale. smoke=1, pilot=10, batch=all." })),
  max_items: Type.Optional(Type.Number({ description: "Optional cap on processed items" })),
  resume: Type.Optional(Type.Boolean({ description: "Allow writing into an existing run directory", default: false })),
  execution: Type.Optional(StringEnum(["deterministic", "plan_only", "agentic"] as const, { description: "Execution strategy. deterministic writes local artifacts; plan_only writes only agentic-plan/validation/report; agentic executes planned child-agent stages after planning." })),
  model: Type.Optional(Type.String({ description: "Optional model override for agentic execution stages" })),
  prerequisite_smoke_run_id: Type.Optional(Type.String({ description: "Required for non-plan pilot runs: completed smoke run id with SMOKE_PASSED.sentinel and DONE.sentinel." })),
  prerequisite_pilot_run_id: Type.Optional(Type.String({ description: "Required for non-plan batch runs: completed pilot run id with PILOT_PASSED.sentinel and DONE.sentinel." })),
  oracle_review_path: Type.Optional(Type.String({ description: "Required for non-plan pilot/batch runs: repo-local JSON oracle review artifact with PASS/no_ship=false evidence for the prerequisite smoke/pilot run." })),
  batch_concurrency: Type.Optional(Type.Number({ description: "Required for non-plan batch runs: positive concurrency cap for batch processing." })),
  budget: Type.Optional(BudgetCapsParams),
  compute_profile: Type.Optional(ComputeProfileEnum),
  compute_caps: Type.Optional(ComputeCapsParams),
  model_routing: Type.Optional(ModelRoutingParams),
  adaptive_factory_dispatch_gate: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean({ description: "Enable hash-only proof/activation metadata for future live factory adaptive dispatch." })),
    liveReadOnlyProofEnabled: Type.Optional(Type.Boolean({ description: "Enable the smoke-only registered live read-only factory adaptive proof path. Does not enable writes, pilot, or batch." })),
    proofRunId: Type.Optional(Type.String({ description: "Registered factory adaptive proof run id. Stored only as proofRunIdHash." })),
    proofReviewHash: Type.Optional(Type.String({ description: "sha256 of registered proof/oracle review artifact." })),
    approvedBy: Type.Optional(Type.String({ description: "Human approver identifier. Stored only as approvedByHash." })),
    approvedAt: Type.Optional(Type.String({ description: "Human approval timestamp or date." })),
    approvalId: Type.Optional(Type.String({ description: "Approval ticket/id. Stored only as approvalIdHash." })),
    scope: Type.Optional(Type.String({ description: "Approval/proof scope. Stored only as scopeHash." })),
  }, { description: "Factory adaptive live dispatch proof gate metadata. Only smoke read-only proof may use live dispatch; writes remain disabled." })),
  adaptive_delegation: Type.Optional(AdaptiveDelegationParams),
  oracle_gate: Type.Optional(Type.Object({ 
    verdict: Type.Optional(StringEnum(["PASS", "FAIL", "WARN"] as const, { description: "Oracle verdict for promoting smoke to pilot. Must be PASS for pilot execution." })),
    no_ship: Type.Optional(Type.Boolean({ description: "Oracle no-ship flag. Must be false/absent for pilot execution." })),
    evidence: Type.Optional(Type.String({ description: "Evidence summary proving the smoke run was reviewed." })),
    reviewer: Type.Optional(Type.String({ description: "Optional reviewer/oracle identifier." })),
  })),
});

const FactoryQuarantineReviewParams = Type.Object({
  run_id: Type.String({ description: "Factory-forge run id under reports/factory-runs/<runId>" }),
  generated_factory: Type.String({ description: "Generated factory name under the run quarantine directory" }),
  review_id: Type.Optional(Type.String({ description: "Optional deterministic review id. Must be path-safe." })),
  oracle_verdict: Type.Optional(StringEnum(["PASS", "FAIL", "WARN"] as const, { description: "Independent oracle verdict. Must be PASS for activationReady=true." })),
  approval: Type.Optional(Type.Object({
    approvedBy: Type.Optional(Type.String({ description: "Human approver identifier" })),
    approvedAt: Type.Optional(Type.String({ description: "Human approval timestamp or date" })),
    approvalId: Type.Optional(Type.String({ description: "Approval ticket/id" })),
  })),
});

const FactoryQuarantineActivateParams = Type.Object({
  run_id: Type.String({ description: "Factory-forge run id under reports/factory-runs/<runId>. Must be path-safe." }),
  generated_factory: Type.String({ description: "Generated factory name under the run quarantine directory. Must be path-safe." }),
  review_id: Type.String({ description: "Review id containing activation-readiness.json. Must be path-safe." }),
  confirmation_phrase: Type.String({ description: "Exact phrase: ACTIVATE QUARANTINED FACTORY <generated_factory> FROM RUN <run_id> REVIEW <review_id>" }),
  activation_id: Type.Optional(Type.String({ description: "Optional deterministic activation id. Must be path-safe." })),
});

const FactoryQuarantineVerifyActivationParams = Type.Object({
  run_id: Type.String({ description: "Factory-forge run id under reports/factory-runs/<runId>. Must be path-safe." }),
  generated_factory: Type.String({ description: "Activated generated factory name under .pi/factories/<generated>. Must be path-safe." }),
  activation_id: Type.String({ description: "Activation id that must have a successful activation-journal entry. Must be path-safe." }),
  verification_id: Type.Optional(Type.String({ description: "Optional deterministic verification id. Must be path-safe." })),
});

const OrchestrateRunParams = Type.Object({
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
  profile: Type.Optional(Type.String({ description: "Orchestration profile under .pi/orchestrations/<profile>.json. Mutually exclusive with team." })),
  goal: Type.String({ description: "Human goal to expand into lead/worker delegate_task contracts" }),
  original_user_ask: Type.Optional(Type.String({ description: "Original user request for scope anchoring" })),
  goal_id: Type.Optional(Type.String({ description: "Optional parent runtime goal id to attach metadata-only orchestration artifacts to a TODO graph." })),
  todo_id: Type.Optional(Type.String({ description: "Optional parent /goal TODO id to attach messages, delegations, blockers, claims, and evidence refs to." })),
  run_id: Type.Optional(Type.String({ description: "Optional deterministic run id. Must be path-safe." })),
  execution: Type.Optional(StringEnum(["plan_only", "supervised_smoke", "supervised_readonly"] as const, { description: "plan_only writes contracts only; supervised_smoke adds parent-owned read-only dispatch/final-gate metadata without live child execution in smoke tests; supervised_readonly explicitly dispatches worker children through parent-owned read-only tools." })),
  resume: Type.Optional(Type.Boolean({ description: "Allow writing into an existing orchestration run directory", default: false })),
  max_workers: Type.Optional(Type.Number({ description: "Optional cap on planned worker contracts" })),
  compute_profile: Type.Optional(ComputeProfileEnum),
  compute_caps: Type.Optional(ComputeCapsParams),
  adaptive_delegation: Type.Optional(AdaptiveDelegationParams),
});

const ChainRunParams = Type.Object({
  chain: Type.String({ description: "Chain registry name under .pi/chains/<chain>.json" }),
  goal: Type.String({ description: "Human goal rendered into chain step contracts" }),
  original_user_ask: Type.Optional(Type.String({ description: "Original user request for scope anchoring" })),
  run_id: Type.Optional(Type.String({ description: "Optional deterministic run id. Must be path-safe." })),
  execution: Type.Optional(StringEnum(["plan_only"] as const, { description: "Only plan_only is supported; no live child execution." })),
  resume: Type.Optional(Type.Boolean({ description: "Allow writing into an existing chain run directory", default: false })),
});

const ZobComsSendParams = Type.Object({
  runId: Type.String({ description: "Run id for the local mailbox message" }),
  sender: Type.String({ description: "Topology role id sending the message" }),
  receiver: Type.String({ description: "Topology role id receiving the message" }),
  kind: Type.Optional(Type.String({ description: "Message kind. Default: handoff" })),
  taskId: Type.Optional(Type.String({ description: "Optional task/message correlation id" })),
  taskHash: Type.Optional(Type.String({ description: "Hash of the task/contract body; bodies are not stored by default" })),
  transientBody: Type.Optional(Type.String({ description: "Transient live delivery body used only when zob_coms v2 live transport is required; never stored in .pi/coms" })),
  outputHash: Type.Optional(Type.String({ description: "Optional output hash; output bodies are not stored by default" })),
  status: Type.Optional(Type.String({ description: "Message status. Default: queued" })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});

const ZobComsListParams = Type.Object({
  runId: Type.Optional(Type.String({ description: "Filter by run id" })),
  receiver: Type.Optional(Type.String({ description: "Filter by receiver role id" })),
  sender: Type.Optional(Type.String({ description: "Filter by sender role id" })),
  status: Type.Optional(Type.String({ description: "Filter by status" })),
  limit: Type.Optional(Type.Number({ description: "Max messages to return. Capped at 100; default 20" })),
});

const ZobComsGetParams = Type.Object({
  msgId: Type.String({ description: "Message id to fetch" }),
});

const ZobComsAckParams = Type.Object({
  msgId: Type.String({ description: "Message id to ACK" }),
  actor: Type.String({ description: "Role id acknowledging receipt. Must be the message receiver" }),
});

const ZobComsStatusParams = Type.Object({
  msgId: Type.String({ description: "Message id to transition" }),
  actor: Type.String({ description: "Role id recording the transition. Must be sender or receiver" }),
  status: Type.String({ description: "New derived message status" }),
});

const ZobComsReplyParams = Type.Object({
  msgId: Type.String({ description: "Parent message id being replied to" }),
  sender: Type.String({ description: "Topology role id sending the reply" }),
  receiver: Type.String({ description: "Topology role id receiving the reply" }),
  kind: Type.Optional(Type.String({ description: "Reply kind. Default: reply" })),
  taskId: Type.Optional(Type.String({ description: "Optional reply correlation id" })),
  taskHash: Type.Optional(Type.String({ description: "Hash of the reply task/body; bodies are not stored" })),
  outputHash: Type.Optional(Type.String({ description: "Optional reply output hash; output bodies are not stored" })),
  status: Type.Optional(Type.String({ description: "Reply message status. Default: queued" })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});

const ZobComsAwaitParams = Type.Object({
  msgId: Type.Optional(Type.String({ description: "Optional live message id to await in zob_coms v2 required_local mode" })),
  runId: Type.Optional(Type.String({ description: "Filter by run id" })),
  receiver: Type.Optional(Type.String({ description: "Filter by receiver role id" })),
  status: Type.Optional(Type.String({ description: "Filter by derived status" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Bounded wait timeout. Capped at 5000ms; default 1000ms" })),
  pollMs: Type.Optional(Type.Number({ description: "Poll interval. Default 100ms" })),
});

const ZpeerAskParams = Type.Object({
  targetAlias: Type.String({ description: "ZPeer target alias in the current local room. May include or omit the leading @." }),
  message: Type.String({ description: "Transient peer request body. Used only for local live delivery; never persisted in durable ledgers or reports." }),
  roomId: Type.Optional(Type.String({ description: "Optional ZPeer room id. Defaults to the current active local room." })),
  mode: Type.Optional(StringEnum(["async", "await", "long"] as const, { description: "Send mode. Default async for non-blocking coordination; when an actual reply/status is required, use await or long with requireResponse=true.", default: "async" })),
  reason: Type.Optional(Type.String({ description: "Optional transient coordination/interrupt reason. Required for force; hashed only in visible metadata; raw value is not persisted." })),
  urgency: Type.Optional(StringEnum(["normal", "urgent", "force"] as const, { description: "ZPeer delivery priority. normal=follow-up, urgent=steer, force=controlled abort+steer when policy allows." })),
  force: Type.Optional(Type.Boolean({ description: "Alias for urgency=force. Requires reason and remains local/hash-only." })),
  interruptMode: Type.Optional(StringEnum(["none", "steer", "abort"] as const, { description: "Requested interrupt mode. Derived from urgency when omitted; invalid broadening is blocked by runtime." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Bounded reply wait timeout for await/long modes, and required-response expiration when requireResponse=true; capped by runtime." })),
  requireResponse: Type.Optional(Type.Boolean({ description: "Opt in to a real msgId-correlated required response. Set true whenever the user asks for a reply, status, or confirmation; the sender waits only for the exact msgId reply and expires explicitly." })),
  maxReinjects: Type.Optional(Type.Number({ description: "Bounded receiver reminder budget for requireResponse. Default 1, capped 0..3." })),
});

const ZpeerReplyParams = Type.Object({
  msgId: Type.String({ description: "ZPeer inbound msgId being answered. Must match an active unanswered inbound message." }),
  message: Type.String({ description: "Transient reply body. Sent over local socket only; durable records store outputHash/metadata, not the raw message." }),
});

const ZobComsReadinessParams = Type.Object({
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});

const ZcommitRunParams = Type.Object({
  action: Type.Optional(StringEnum(["plan", "commit", "push", "commit_and_push"] as const, { description: "Governed zcommit action. Default plan." })),
  scope: Type.Optional(StringEnum(["session_modified", "pathspecs", "all_safe_dirty"] as const, { description: "File selection scope. session_modified uses current runtime touched/owned paths; pathspecs uses paths; all_safe_dirty uses the easy filtered workspace." })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Repo-relative files, directories, or globs to include when scope=pathspecs, or to narrow session_modified." })),
  message: Type.Optional(Type.String({ description: "Optional Conventional Commit subject, e.g. feat(worker-pool): add supervised owner micro-worker pools." })),
  body: Type.Optional(Type.Array(Type.String(), { description: "Optional commit body lines. Stored only in git commit when commit runs; ledger stores hashes only." })),
  push: Type.Optional(Type.Boolean({ description: "When true with action=commit, also request push behavior. action=commit_and_push is preferred." })),
  user_requested: Type.Optional(Type.Boolean({ description: "Set true only when the user explicitly asked the agent to commit/push. Required for commit/push unless autocommit is on." })),
});

const ZteamHotAddParams = Type.Object({
  action: Type.Optional(StringEnum(["plan", "apply", "launch"] as const, { description: "Hot-add action. Default plan. Apply writes prompt/manifest/team only after exact apply_confirmation; launch starts only the target ZAgent in an existing tmux session after exact launch_confirmation_phrase." })),
  request: Type.Optional(Type.String({ description: "Natural-language ask for plan/apply. Raw value is accepted transiently and persisted only as requestHash. Not required for action=launch." })),
  team_id: Type.Optional(Type.String({ description: "Optional ZTeam id. Required for action=launch. When omitted for plan/apply, current ZOB/ZPeer/repo context fallback is used." })),
  zagent_id: Type.Optional(Type.String({ description: "Optional explicit ZAgent id. Required for action=launch. Otherwise derived safely from request hash." })),
  alias: Type.Optional(Type.String({ description: "Optional ZPeer alias for generated ZAgent." })),
  role: Type.Optional(Type.String({ description: "Optional role label for generated ZAgent." })),
  room: Type.Optional(Type.String({ description: "Optional existing ZTeam room id." })),
  default_mode: Type.Optional(StringEnum(["explore", "plan", "implement", "oracle", "factory", "orchestrator"] as const, { description: "Default ZOB mode for generated ZAgent. Inferred when omitted." })),
  apply_confirmation: Type.Optional(Type.String({ description: "Exact team id required when action=apply." })),
  tmux_window_plan: Type.Optional(Type.Boolean({ description: "When true, returns a manual tmux new-window plan only; never executes it." })),
  launch_confirmation: Type.Optional(Type.String({ description: "Exact team id required to include optional tmux-window plan." })),
  launch_confirmation_phrase: Type.Optional(Type.String({ description: "Exact phrase required for action=launch: LAUNCH ZTEAM <team_id> ZAGENT <zagent_id> IN TMUX <session_name>." })),
  tmux_session_name: Type.Optional(Type.String({ description: "Existing tmux session name for action=launch. Defaults to safe team metadata tmuxSession or team id." })),
  presence_timeout_ms: Type.Optional(Type.Number({ description: "Bounded ZPeer presence wait for action=launch. Default 5000ms, capped at 30000ms." })),
  presence_poll_ms: Type.Optional(Type.Number({ description: "Bounded ZPeer presence poll interval for action=launch. Default 500ms, capped at 2000ms." })),
});

const ZteamRemoveParams = Type.Object({
  action: Type.Optional(StringEnum(["plan", "apply", "close_tmux"] as const, { description: "Remove action. Default plan. Apply requires exact confirmation_phrase; close_tmux closes only one target ZAgent tmux window after exact close_confirmation_phrase." })),
  team_id: Type.String({ description: "ZTeam id to remove membership from or close a target ZAgent window for." }),
  zagent_id: Type.String({ description: "ZAgent id targeted for membership removal, manifest/prompt deletion, or target tmux-window close." }),
  scope: Type.Optional(StringEnum(["membership", "manifest", "prompt", "manifest_and_prompt"] as const, { description: "Removal scope. Default membership. Manifest scopes also remove membership from the team." })),
  confirmation_phrase: Type.Optional(Type.String({ description: "Exact phrase required for apply: REMOVE ZTEAM <team_id> ZAGENT <zagent_id> SCOPE <scope>." })),
  include_tmux_plan: Type.Optional(Type.Boolean({ description: "Return a manual tmux cleanup note only; never executes tmux/process operations." })),
  tmux_confirmation_phrase: Type.Optional(Type.String({ description: "Exact phrase required to include optional tmux manual plan: PLAN TMUX REMOVE <team_id> <zagent_id>." })),
  close_confirmation_phrase: Type.Optional(Type.String({ description: "Exact phrase required for action=close_tmux: CLOSE ZTEAM <team_id> ZAGENT <zagent_id> TMUX WINDOW <session_name>." })),
  tmux_session_name: Type.Optional(Type.String({ description: "Existing tmux session name for action=close_tmux. Defaults to safe team metadata tmuxSession or team id." })),
  tmux_window_name: Type.Optional(Type.String({ description: "Optional explicit safe tmux window override for action=close_tmux. Defaults to zagent_id-derived window name." })),
  presence_timeout_ms: Type.Optional(Type.Number({ description: "Bounded ZPeer presence wait after targeted tmux close. Default 5000ms, capped at 30000ms." })),
  presence_poll_ms: Type.Optional(Type.Number({ description: "Bounded ZPeer/window poll interval for close_tmux. Default 500ms, capped at 2000ms." })),
  graceful_timeout_ms: Type.Optional(Type.Number({ description: "Bounded wait after sending graceful Pi /quit. Default 5000ms, capped at 30000ms." })),
  force_close_window: Type.Optional(Type.Boolean({ description: "When true with exact close confirmation, allows targeted tmux kill-window fallback for only the selected window if graceful /quit does not close it." })),
});

const GoalRoomKindEnum = StringEnum(["QUESTION", "ANSWER", "FINDING", "ACTION_TAKEN", "ARTIFACT_READY", "TODO_CLAIM", "BLOCKER", "RISK", "NO_SHIP_ALERT", "CONTEXT_REQUEST", "SPLIT_REQUEST", "DELEGATION_REQUEST", "ORACLE_REQUEST", "OWNER_CHANGE_REQUEST", "OWNER_CHANGE_DECISION", "HANDOFF", "DECISION", "STATUS_UPDATE"] as const, { description: "Typed goal-room message kind." });
const GoalRoomAudienceEnum = StringEnum(["all", "parent", "lead", "oracle", "worker"] as const, { description: "Visible goal-room audience bucket. This is not hidden peer chat." });
const GoalRoomPriorityEnum = StringEnum(["low", "normal", "high", "critical"] as const, { description: "Goal-room message priority." });

const ZobGoalRoomSendParams = Type.Object({
  goal_id: Type.String({ description: "Parent goal id / room id. Must be path-safe." }),
  run_id: Type.Optional(Type.String({ description: "Optional run id correlation. Must be path-safe." })),
  todo_id: Type.Optional(Type.String({ description: "Optional /goal TODO id correlation. Must be path-safe." })),
  sender: Type.String({ description: "Sender role id. Must be a known team role or parent/mission-control." }),
  audience: Type.Optional(GoalRoomAudienceEnum),
  kind: GoalRoomKindEnum,
  priority: Type.Optional(GoalRoomPriorityEnum),
  body_hash: Type.String({ description: "sha256 hash of transient message body; raw body is not accepted or persisted." }),
  task_id: Type.Optional(Type.String({ description: "Optional safe task/message correlation id." })),
  output_hash: Type.Optional(Type.String({ description: "Optional output hash. Output bodies are not stored." })),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Safe repo-relative evidence refs. No bodies, no secrets." })),
  artifact_refs: Type.Optional(Type.Array(Type.String(), { description: "Safe repo-relative artifact refs. No bodies, no secrets." })),
  ttl_ms: Type.Optional(Type.Number({ description: "Optional positive TTL in milliseconds, capped by runtime validator." })),
  requires_parent_action: Type.Optional(Type.Boolean({ description: "Whether parent/governor action is requested. Message itself executes no action." })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Hash-only metadata; raw body-like keys are rejected." })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});

const ZobGoalRoomListParams = Type.Object({
  goal_id: Type.String({ description: "Parent goal id / room id. Must be path-safe." }),
  sender: Type.Optional(Type.String({ description: "Filter by sender role id" })),
  kind: Type.Optional(GoalRoomKindEnum),
  todo_id: Type.Optional(Type.String({ description: "Filter by TODO id" })),
  limit: Type.Optional(Type.Number({ description: "Max messages to return. Capped at 100; default 20" })),
});

const GovernedRequestExtractParams = Type.Object({
  goal_id: Type.String({ description: "Parent goal id / Goal Room id where extracted requests should be made visible. Must be path-safe." }),
  transient_text: Type.String({ description: "Transient child output/request text to parse. Supports DELEGATION_REQUEST.v1, ORACLE_REQUEST.v1, CONTEXT_REQUEST.v1, and OWNER_CHANGE_REQUEST.v1 blocks. Raw text is never persisted by this tool." }),
  append_to_goal_room: Type.Optional(Type.Boolean({ description: "Append parsed requests to the parent-visible Goal Room. Default true." })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});

const WorkerPoolCommunicationPolicyParams = Type.Object({
  mode: Type.Optional(StringEnum(["goal_room_only", "goal_room_with_optional_live"] as const, { description: "Goal Room remains canonical; live/ZPeer is optional transient delivery only." })),
  parent_visible: Type.Optional(Type.Boolean({ description: "Must not be false; persisted records are parentVisible=true." })),
  hidden_peer_chat: Type.Optional(Type.Boolean({ description: "Must not be true; hidden worker chat is blocked." })),
  worker_to_worker_direct: Type.Optional(Type.Boolean({ description: "Must not be true; owner protocol is parent-visible Goal Room metadata." })),
  required_local_live: Type.Optional(Type.Boolean({ description: "Optional live delivery hint; never canonical for owner requests." })),
  goal_room_canonical: Type.Optional(Type.Boolean({ description: "Must not be false; Goal Room is canonical." })),
});
const WorkerPoolAssignmentParams = Type.Object({
  worker_id: Type.String({ description: "Known team role id assigned to this pool lane." }),
  agent_name: Type.String({ description: "Agent profile/name assigned to this worker lane." }),
  owned_paths: Type.Array(Type.String(), { description: "Repo-relative paths owned by this worker lane." }),
  write_paths: Type.Array(Type.String(), { description: "Repo-relative writable intent paths for this worker; each path must be within owned_paths. Overlaps are reported as parent-owned conflicts." }),
  read_across_paths: Type.Optional(Type.Array(Type.String(), { description: "Repo-relative peer paths this worker may inspect read-only; never grants write access." })),
  read_across_write_overlap_justification_hash: Type.Optional(Type.String({ description: "Required sha256 justification when read_across_paths overlap this worker's write_paths; raw rationale is not accepted." })),
  forbidden_paths: Type.Optional(Type.Array(Type.String(), { description: "Deny-only patterns/paths for this worker lane." })),
  todo_id: Type.Optional(Type.String({ description: "Parent /goal TODO id correlation." })),
  child_goal_id: Type.Optional(Type.String({ description: "Parent-managed child goal id correlation." })),
  run_id: Type.Optional(Type.String({ description: "Worker/run id correlation." })),
  workspace_claim_ids: Type.Optional(Type.Array(Type.String(), { description: "Path-safe workspace claim ids covering this worker's write intent, when already claimed. The worker's own active write claim may satisfy coverage; other overlapping active claims remain conflicts." })),
  communication_policy: Type.Optional(WorkerPoolCommunicationPolicyParams),
});
const WorkerPoolPlanParams = Type.Object({
  goal_id: Type.String({ description: "Parent goal id for this worker pool." }),
  pool_id: Type.Optional(Type.String({ description: "Optional deterministic pool id. Must be path-safe." })),
  run_id: Type.Optional(Type.String({ description: "Optional parent orchestration/delegation run id." })),
  todo_id: Type.Optional(Type.String({ description: "Optional parent TODO id this pool serves." })),
  owner: Type.String({ description: "Parent/lead role recording the pool plan." }),
  assignments: Type.Array(WorkerPoolAssignmentParams, { description: "Worker assignments with owned/write/read-across path metadata." }),
  forbidden_paths: Type.Optional(Type.Array(Type.String(), { description: "Pool-level deny-only paths/patterns." })),
  communication_policy: Type.Optional(WorkerPoolCommunicationPolicyParams),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});
const WorkerPoolStatusParams = Type.Object({
  goal_id: Type.Optional(Type.String({ description: "Filter by parent goal id." })),
  pool_id: Type.Optional(Type.String({ description: "Filter by worker pool id." })),
  run_id: Type.Optional(Type.String({ description: "Filter by parent run id." })),
  limit: Type.Optional(Type.Number({ description: "Max pool records to return. Capped at 100; default 20." })),
});
const WorkerPoolOwnerRequestParams = Type.Object({
  goal_id: Type.String({ description: "Parent goal / Goal Room id." }),
  pool_id: Type.String({ description: "Worker pool id." }),
  request_id: Type.Optional(Type.String({ description: "Optional deterministic owner request id." })),
  run_id: Type.Optional(Type.String({ description: "Optional run id correlation." })),
  todo_id: Type.Optional(Type.String({ description: "Optional TODO id correlation." })),
  requester: Type.String({ description: "Worker role requesting a peer-owned change." }),
  owner_worker: Type.String({ description: "Worker role that owns the requested paths." }),
  requested_paths: Type.Array(Type.String(), { description: "Repo-relative owner paths requested for change. When a pool plan exists, these must be covered by owner_worker owned/write paths or the request is blocked." }),
  change_hash: Type.String({ description: "sha256 hash of the proposed change intent; raw diff/patch is not accepted." }),
  reason_hash: Type.String({ description: "sha256 hash of the request reason; raw reason text is not accepted." }),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Safe repo-relative evidence refs." })),
  artifact_refs: Type.Optional(Type.Array(Type.String(), { description: "Safe repo-relative artifact refs." })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});
const WorkerPoolOwnerDecisionParams = Type.Object({
  goal_id: Type.String({ description: "Parent goal / Goal Room id." }),
  pool_id: Type.String({ description: "Worker pool id." }),
  request_id: Type.String({ description: "Owner request id being decided." }),
  run_id: Type.Optional(Type.String({ description: "Optional run id correlation." })),
  todo_id: Type.Optional(Type.String({ description: "Optional TODO id correlation." })),
  decided_by: Type.String({ description: "Owner/parent role recording the decision." }),
  owner_worker: Type.String({ description: "Worker role that owns the paths." }),
  requester: Type.Optional(Type.String({ description: "Original requester role, when known." })),
  decision: StringEnum(["approved", "rejected", "needs_parent", "owner_will_handle"] as const, { description: "Typed owner decision. No decision applies diffs automatically." }),
  decision_hash: Type.String({ description: "sha256 hash of the decision basis; raw rationale text is not accepted." }),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "Safe repo-relative evidence refs." })),
  artifact_refs: Type.Optional(Type.Array(Type.String(), { description: "Safe repo-relative artifact refs." })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});

const WorkspaceClaimModeEnum = StringEnum(["read", "write"] as const, { description: "Workspace claim mode. write conflicts with overlapping active claims." });
const WorkspaceClaimParams = Type.Object({
  run_id: Type.String({ description: "Run id requiring the workspace lease. Must be path-safe." }),
  claimant: Type.String({ description: "Claimant role id. Must be a known team role or parent/mission-control." }),
  paths: Type.Array(Type.String(), { description: "Repo-relative paths to lease for parallel work intent." }),
  mode: Type.Optional(WorkspaceClaimModeEnum),
  purpose_hash: Type.String({ description: "sha256 hash of transient claim purpose; raw purpose is not accepted or stored." }),
  todo_id: Type.Optional(Type.String({ description: "Optional /goal TODO id correlation. Must be path-safe." })),
  sandbox_run_id: Type.Optional(Type.String({ description: "Optional sandbox run id correlation. Must be path-safe." })),
  lease_ms: Type.Optional(Type.Number({ description: "Positive lease duration in milliseconds. Capped at 24h." })),
  allow_conflicts: Type.Optional(Type.Boolean({ description: "Allow conflicting metadata claim to be recorded. Default false blocks conflicts." })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});
const WorkspaceReleaseParams = Type.Object({
  claim_id: Type.String({ description: "Workspace claim id to release. Must be path-safe." }),
  released_by: Type.String({ description: "Actor role id releasing the claim." }),
  reason_hash: Type.Optional(Type.String({ description: "Optional sha256 release reason hash. Raw reason is not accepted or stored." })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});
const WorkspaceClaimsListParams = Type.Object({
  run_id: Type.Optional(Type.String({ description: "Filter by run id." })),
  claimant: Type.Optional(Type.String({ description: "Filter by claimant role id." })),
  include_expired: Type.Optional(Type.Boolean({ description: "Include expired leases. Default false." })),
  include_released: Type.Optional(Type.Boolean({ description: "Include released claims. Default false." })),
  limit: Type.Optional(Type.Number({ description: "Max claims to return. Capped at 100; default 20." })),
});

const MergePriorityEnum = StringEnum(["low", "normal", "high", "critical"] as const, { description: "Merge queue priority." });
const MergeRiskEnum = StringEnum(["low", "medium", "high"] as const, { description: "Merge candidate risk level." });
const MergeDecisionEnum = StringEnum(["approve_for_manual_apply", "reject", "needs_oracle"] as const, { description: "Parent-owned merge decision; never auto-applies." });
const MergeCandidateSubmitParams = Type.Object({
  run_id: Type.String({ description: "Run id for the merge candidate. Must be path-safe." }),
  submitted_by: Type.String({ description: "Submitter role id. Must be known team role or parent/mission-control." }),
  sandbox_run_id: Type.String({ description: "Sandbox run id that produced the diff. Must be path-safe." }),
  workspace_claim_ids: Type.Array(Type.String(), { description: "Workspace claim ids covering changed paths." }),
  changed_paths: Type.Array(Type.String(), { description: "Repo-relative changed paths from sandbox diff metadata." }),
  diff_hash: Type.String({ description: "sha256 hash of sandbox diff; raw diff is not accepted or stored." }),
  validation_refs: Type.Array(Type.String(), { description: "Safe repo-relative validation artifacts/commands refs." }),
  summary_hash: Type.Optional(Type.String({ description: "Optional sha256 summary hash. Raw summary is not accepted or stored." })),
  todo_id: Type.Optional(Type.String({ description: "Optional /goal TODO id correlation. Must be path-safe." })),
  oracle_review_ref: Type.Optional(Type.String({ description: "Optional safe repo-relative oracle review artifact." })),
  rollback_ref: Type.Optional(Type.String({ description: "Optional safe repo-relative rollback metadata artifact." })),
  priority: Type.Optional(MergePriorityEnum),
  risk_level: Type.Optional(MergeRiskEnum),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});
const MergeQueueDecideParams = Type.Object({
  candidate_id: Type.String({ description: "Merge candidate id. Must be path-safe." }),
  decided_by: Type.String({ description: "Parent/oracle/lead role id recording the decision." }),
  decision: MergeDecisionEnum,
  reason_hash: Type.String({ description: "sha256 hash of decision reason. Raw reason is not accepted or stored." }),
  oracle_review_ref: Type.Optional(Type.String({ description: "Safe repo-relative oracle review artifact; required for approve_for_manual_apply when candidate lacks one." })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});
const MergeQueueListParams = Type.Object({
  run_id: Type.Optional(Type.String({ description: "Filter by run id." })),
  submitted_by: Type.Optional(Type.String({ description: "Filter by submitter role id." })),
  status: Type.Optional(Type.String({ description: "Filter by queued/latest decision status." })),
  limit: Type.Optional(Type.Number({ description: "Max candidates to return. Capped at 100; default 20." })),
});

const MissionControlSnapshotParams = Type.Object({
  runId: Type.Optional(Type.String({ description: "Optional run id filter for latest coms messages" })),
  limit: Type.Optional(Type.Number({ description: "Bounded latest record count. Capped at 50; default 5" })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});

const MissionControlProposeCommandParams = Type.Object({
  runId: Type.String({ description: "Target run id for this parent-owned command proposal" }),
  command: StringEnum(["pause", "resume", "reprioritize", "request_context", "request_oracle", "stop", "approve", "replan"] as const, { description: "Typed Mission Control command proposal. Proposal only; not directly dispatched." }),
  proposalId: Type.Optional(Type.String({ description: "Optional deterministic proposal id. Must be path-safe." })),
  requestedBy: Type.Optional(Type.String({ description: "Operator/dashboard identifier. Metadata only." })),
  targetRole: Type.Optional(Type.String({ description: "Optional orchestrator/lead target role. Worker targets are blocked." })),
  priority: Type.Optional(StringEnum(["low", "normal", "high", "critical"] as const, { description: "Proposal priority. Default normal." })),
  rationaleHash: Type.Optional(Type.String({ description: "sha256 hash of rationale; raw rationale text is not accepted or stored." })),
  artifactRefs: Type.Optional(Type.Array(Type.String(), { description: "Safe repo-relative evidence refs. No bodies, no secrets." })),
  todoId: Type.Optional(Type.String({ description: "Optional /goal TODO id this proposal concerns. Metadata only." })),
  subtreeRootTodoId: Type.Optional(Type.String({ description: "Optional /goal TODO subtree root id for pause/resume/replan/reprioritize proposals. Metadata only." })),
  team: Type.Optional(Type.String({ description: "Team topology under .pi/teams/<team>.json. Default: zob-core" })),
});

const ContextReadinessParams = Type.Object({
  runId: Type.Optional(Type.String({ description: "Optional run id for the metadata-only Context/GBrain P0 readiness audit." })),
});

const ContextSearchParams = Type.Object({
  query: Type.String({ description: "Bounded repo-local context search query. Required for all modes." }),
  mode: Type.Optional(StringEnum(["auto", "semantic", "hybrid", "regex", "files"] as const, { description: "Search mode. auto/semantic/hybrid prefer ColGREP when ready; regex/files use deterministic fallback.", default: "auto" })),
  pattern: Type.Optional(Type.String({ description: "Optional regex pattern used when mode=regex. Defaults to query." })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Optional repo-relative search roots. Forbidden/session/vendor/build paths are rejected by the helper." })),
  max_results: Type.Optional(Type.Number({ description: "Maximum result count. Runtime clamps to safe bounds." })),
  max_context_lines: Type.Optional(Type.Number({ description: "Context lines around fallback matches. Runtime clamps to safe bounds." })),
});

const ContextScopeValidateParams = Type.Object({
  runId: Type.String({ description: "Run id requiring a context_scope before lookup/context-pack injection." }),
  scopeId: Type.Optional(Type.String({ description: "Optional deterministic context scope id." })),
  todoId: Type.Optional(Type.String({ description: "Optional /goal TODO id this context_scope applies to. Metadata only." })),
  allowedBrains: Type.Optional(Type.Array(Type.String(), { description: "Allowed logical brains for this run/agent." })),
  allowedSources: Type.Optional(Type.Array(Type.String(), { description: "Allowed source ids for this run/agent." })),
  forbiddenSources: Type.Optional(Type.Array(Type.String(), { description: "Forbidden source ids/patterns, including secrets and raw conversation history." })),
  agentProfile: Type.Optional(Type.String({ description: "Agent profile this context_scope applies to." })),
  maxContextTokens: Type.Optional(Type.Number({ description: "Bounded context limit. P0 cap is 8000." })),
});

const ContextWritebackProposalParams = Type.Object({
  runId: Type.String({ description: "Run id that produced the writeback candidate." }),
  proposalId: Type.Optional(Type.String({ description: "Optional deterministic proposal id. Must be path-safe." })),
  observedProblemHash: Type.String({ description: "sha256 hash of observed problem. Raw problem text is not stored." }),
  newPatternHash: Type.String({ description: "sha256 hash of proposed new pattern. Raw pattern text is not stored." }),
  evidenceRefs: Type.Array(Type.String(), { description: "Safe repo-relative evidence refs supporting this proposal." }),
  recommendedArtifact: Type.String({ description: "Safe repo-relative support artifact recommendation." }),
});

const FullReadParams = Type.Object({
  path: Type.String({ description: "Path to the file to read in full. Repo-relative or absolute; resolved against cwd." }),
  encoding: Type.Optional(Type.String({ description: "File encoding. v1 supports utf8 only (default). Any other value (e.g. base64) is refused with binary_not_supported." })),
  max_bytes: Type.Optional(Type.Integer({ description: "Optional per-call hard byte ceiling override (must be > 0). Tightens the default 2MB ceiling for this call only.", minimum: 1 })),
});

const ReceiveFullParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Repo-relative path to a response/artifact file. Exactly one of path or run_id must be provided." })),
  run_id: Type.Optional(Type.String({ description: "Run id under reports/factory-runs|orchestrations|chains. Resolves to the run's persisted report artifact (default final-report.md). Exactly one of path or run_id must be provided." })),
  run_type: Type.Optional(StringEnum(["factory", "orchestration", "chain"] as const, { description: "Run type for run_id resolution. If omitted, auto-detected by directory existence in order factory, orchestration, chain." })),
  artifact: Type.Optional(Type.String({ description: "Specific artifact filename within the run dir (e.g. final-report.md, agentic-results.json). Must be a single basename (no slashes). Default final-report.md." })),
  max_bytes: Type.Optional(Type.Integer({ description: "Optional per-call hard byte ceiling override; tightens the default 2MB ceiling only (cannot enlarge it).", minimum: 1 })),
});

const AutonomousDryRunParams = Type.Object({
  user_need: Type.String({ description: "Original user need/spec to dry-run through spec gate. Raw text is hashed in persisted reports." }),
  refined_spec: Type.Optional(Type.String({ description: "Optional refined spec after clarification. Raw text is hashed in persisted reports." })),
  run_id: Type.Optional(Type.String({ description: "Optional deterministic run id. Must be path-safe." })),
  constraints: Type.Optional(Type.Array(Type.String(), { description: "Optional constraints; persisted as hashes only." })),
  acceptance_criteria: Type.Optional(Type.Array(Type.String(), { description: "Spec-lock acceptance criteria; persisted as hashes only." })),
  expected_artifacts: Type.Optional(Type.Array(Type.String(), { description: "Expected artifact descriptions; persisted as hashes only." })),
  allowed_paths: Type.Optional(Type.Array(Type.String(), { description: "Repo-relative-only allowed paths for future gated work; use reports/... snapshot/context_ref refs for external context." })),
  forbidden_paths: Type.Optional(Type.Array(Type.String(), { description: "Forbidden source/path patterns for future gated work." })),
  allowed_sources: Type.Optional(Type.Array(Type.String(), { description: "Allowed context source ids for context_scope." })),
  max_context_tokens: Type.Optional(Type.Number({ description: "Bounded context limit. P0 cap is enforced by context_scope." })),
  apply_policy: Type.Optional(StringEnum(["no_apply", "sandbox_simulation", "manual_apply_only", "auto_apply_in_scope"] as const, { description: "P0 apply posture. Required for spec lock; auto_apply_in_scope only creates a launch-authorization envelope and still performs no production apply." })),
  budget_profile: Type.Optional(StringEnum(["advisory", "strict_requested"] as const, { description: "Budget posture. Required for spec lock; strict_requested is required for autonomous dry-run readiness but does not enable global strict budget." })),
  risk: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "Risk hint for proof planning metadata." })),
  authorized_autonomy_level: Type.Optional(StringEnum(["L4", "L5", "L6"] as const, { description: "Launch authorization autonomy level metadata. Does not enable execution by itself." })),
  user_launch_confirmed: Type.Optional(Type.Boolean({ description: "Explicit user launch confirmation for in-scope actions. Stored only as launch authorization metadata." })),
  launch_confirmed_at: Type.Optional(Type.String({ description: "Optional launch confirmation timestamp/date metadata." })),
  allowed_actions: Type.Optional(Type.Array(Type.String(), { description: "Launch-scoped action names. Metadata only; runtime gates still enforce safety." })),
});

const AutonomousReadOnlySmokeParams = Type.Object({
  user_need: Type.String({ description: "Original user need/spec to run through a Phase 4A deterministic read-only smoke. Raw text is hashed in persisted reports." }),
  refined_spec: Type.Optional(Type.String({ description: "Optional refined spec after clarification. Raw text is hashed in persisted reports." })),
  run_id: Type.Optional(Type.String({ description: "Optional deterministic autonomous smoke run id. Must be path-safe." })),
  factory_run_id: Type.Optional(Type.String({ description: "Optional deterministic underlying factory_run smoke id. Must be path-safe." })),
  constraints: Type.Optional(Type.Array(Type.String(), { description: "Optional constraints; persisted as hashes only." })),
  acceptance_criteria: Type.Optional(Type.Array(Type.String(), { description: "Spec-lock acceptance criteria; persisted as hashes only." })),
  expected_artifacts: Type.Optional(Type.Array(Type.String(), { description: "Expected artifact descriptions; persisted as hashes only." })),
  allowed_paths: Type.Optional(Type.Array(Type.String(), { description: "Repo-relative-only allowed paths for future gated work; use reports/... snapshot/context_ref refs for external context." })),
  forbidden_paths: Type.Optional(Type.Array(Type.String(), { description: "Forbidden source/path patterns for future gated work." })),
  allowed_sources: Type.Optional(Type.Array(Type.String(), { description: "Allowed context source ids for context_scope." })),
  max_context_tokens: Type.Optional(Type.Number({ description: "Bounded context limit. P0 cap is enforced by context_scope." })),
  apply_policy: Type.Optional(StringEnum(["no_apply", "sandbox_simulation", "manual_apply_only"] as const, { description: "Must be no_apply for Phase 4A read-only smoke; omitted defaults to no_apply." })),
  budget_profile: Type.Optional(StringEnum(["advisory", "strict_requested"] as const, { description: "Must be strict_requested for Phase 4A read-only smoke; omitted defaults to strict_requested." })),
  risk: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "Risk hint for proof planning metadata." })),
  authorized_autonomy_level: Type.Optional(StringEnum(["L4", "L5", "L6"] as const, { description: "Launch authorization autonomy level metadata. Does not enable execution by itself." })),
  user_launch_confirmed: Type.Optional(Type.Boolean({ description: "Explicit user launch confirmation for in-scope actions. Stored only as launch authorization metadata." })),
  launch_confirmed_at: Type.Optional(Type.String({ description: "Optional launch confirmation timestamp/date metadata." })),
  allowed_actions: Type.Optional(Type.Array(Type.String(), { description: "Launch-scoped action names. Metadata only; read-only smoke still requires no_apply." })),
});

const AutonomousValidateRunParams = Type.Object({
  run_id: Type.String({ description: "Autonomous dry-run id under reports/autonomous-runs/<run_id> to validate. Read-only; no artifacts are generated." }),
});

const AutonomousValidateSmokeParams = Type.Object({
  run_id: Type.String({ description: "Autonomous read-only smoke run id under reports/autonomous-runs/<run_id> to validate. Read-only; no artifacts are generated." }),
});

const DagNodeStatusEnum = StringEnum(["pending", "in_progress", "done", "blocked", "invalidated"] as const, {
  description: "Worklist DAG node status. 'done' satisfies downstream dependents; 'invalidated'/'blocked' cascade; 'pending' is seedable.",
});
const DagNodeSchema = Type.Object({
  id: Type.String({ description: "DAG node id (slug-safe, no colons/slashes). Unique within the graph." }),
  scope: Type.Optional(Type.String({ description: "Node scope. Defaults to the graph's primary scope." })),
  depends_on: Type.Optional(Type.Array(Type.String(), { description: "Dependency refs: local node ids and/or cross-scope 'scope:nodeId' refs." })),
  unblocks: Type.Optional(Type.Array(Type.String(), { description: "Optional explicit reverse-edge hints. Canonical edge source is depends_on." })),
  status: Type.Optional(DagNodeStatusEnum),
  owner: Type.Optional(Type.String({ description: "Owner role id for the node. Nullable." })),
});

const WorklistActionEnum = StringEnum(["append", "directives", "claim", "satisfy", "validate", "deliver", "observe", "escalate", "dag"] as const, { description: "zob_worklist subcommand. 'dag' (WS-H4) operates the generic dependency DAG: build/impact/seed/save/load." });
const ZobWorklistParams = Type.Object({
  action: WorklistActionEnum,
  scope: Type.String({ description: "Path-safe worklist blackboard scope id (e.g. a run/goal id). Events/leases/directives are stored under .pi/worklist/<scope>/. Must be path-safe." }),
  reducer_id: Type.Optional(Type.String({ description: "append: registered WorklistReducer id. Defaults to 'generic'. Must be homogeneous within a scope." })),
  kind: Type.Optional(Type.String({ description: "append: reducer-defined event kind (the generic reducer understands OPEN/CLOSE/NOTE)." })),
  ref: Type.Optional(Type.String({ description: "append: safe repo-relative correlation ref (e.g. a task-id pointer). No bodies." })),
  owner: Type.Optional(Type.String({ description: "append: owner role id for the work item." })),
  reason_ref: Type.Optional(Type.String({ description: "append: safe repo-relative reason pointer. Raw rationale is not stored." })),
  unblock_path: Type.Optional(Type.String({ description: "append: safe repo-relative unblock pointer." })),
  evidence_refs: Type.Optional(Type.Array(Type.String(), { description: "append: safe repo-relative evidence refs. No bodies, no secrets." })),
  deadline: Type.Optional(Type.String({ description: "append: ISO-8601 deadline for the work item." })),
  directive_hash: Type.Optional(Type.String({ description: "claim/satisfy: target directive content hash (sha256)." })),
  claimant: Type.Optional(Type.String({ description: "claim/satisfy: role id claiming/satisfying the directive." })),
  lease_ms: Type.Optional(Type.Number({ description: "claim: positive lease duration in milliseconds. Capped at 24h. Default 5 minutes." })),
  resend_interval_ms: Type.Optional(Type.Number({ description: "deliver: resend cooldown in milliseconds for lost-nudge re-delivery. Default 120000." })),
  decision_timeout_ms: Type.Optional(Type.Number({ description: "observe/escalate (WS-H3 watchdog): decision window in ms before the resolver/watcher auto-acts. Default 300000 (5 min). Mirrors transposer DECISION_TIMEOUT_DEFAULT_MS." })),
  escalate_to_llm_ms: Type.Optional(Type.Number({ description: "observe/escalate (WS-H3 watchdog): elapsed-since-anchor in ms at which an LLM nudge is sent. Default 600000 (10 min). Mirrors transposer ESCALATE_TO_LLM_DEFAULT_MS." })),
  escalate_to_human_ms: Type.Optional(Type.Number({ description: "observe/escalate (WS-H3 watchdog): elapsed-since-anchor in ms at which a human no_ship block is raised. Default 900000 (15 min). Mirrors transposer ESCALATE_TO_HUMAN_DEFAULT_MS." })),
  dag_op: Type.Optional(StringEnum(["build", "impact", "seed", "save", "load"] as const, { description: "dag: WS-H4 dependency-DAG operation. build=validate+cycle-check; impact=computeDownstreamImpact; seed=butterflySeedNext; save=write dag.json; load=read dag.json." })),
  dag_nodes: Type.Optional(Type.Array(DagNodeSchema, { description: "dag(build/impact/seed/save): the DAG nodes {id,scope?,depends_on?,unblocks?,status?,owner?}." })),
  dag_node_id: Type.Optional(Type.String({ description: "dag(impact): the local node id whose status is changing (the impact trigger)." })),
  dag_status: Type.Optional(DagNodeStatusEnum),
  dag_accepted_node_id: Type.Optional(Type.String({ description: "dag(seed): the accepted (now-done) node id whose dependents to seed next (generalizes nonCompletePhaseAfter)." })),
});

export {
  AgentScopeSchema,
  ThinkingLevelSchema,
  AutonomousDryRunParams,
  AutonomousReadOnlySmokeParams,
  AutonomousValidateRunParams,
  AutonomousValidateSmokeParams,
  ChainRunParams,
  ComputeCapsParams,
  ComputePreviewParams,
  ComputeResolveProfileParams,
  ComputeValidateProfileParams,
  ComputeWriteProfileReportsParams,
  ComputePlanWorkflowParams,
  AwaitDelegationRunParams,
  DelegationCatalogParams,
  DelegationRunParams,
  DelegateParams,
  DelegateTaskParams,
  FactoryQuarantineActivateParams,
  FactoryQuarantineReviewParams,
  FactoryQuarantineVerifyActivationParams,
  FactoryRunParams,
  OrchestrateRunParams,
  TaskItem,
  ZobComsAckParams,
  ZobComsAwaitParams,
  ZobComsGetParams,
  ZobComsListParams,
  ZobComsReadinessParams,
  ZobComsReplyParams,
  ZobComsSendParams,
  ZobComsStatusParams,
  ZpeerAskParams,
  ZpeerReplyParams,
  ZcommitRunParams,
  ZteamHotAddParams,
  ZteamRemoveParams,
  ZobGoalRoomSendParams,
  ZobGoalRoomListParams,
  ZobWorklistParams,
  GovernedRequestExtractParams,
  WorkerPoolPlanParams,
  WorkerPoolStatusParams,
  WorkerPoolOwnerRequestParams,
  WorkerPoolOwnerDecisionParams,
  WorkspaceClaimParams,
  WorkspaceReleaseParams,
  WorkspaceClaimsListParams,
  MergeCandidateSubmitParams,
  MergeQueueDecideParams,
  MergeQueueListParams,
  MissionControlProposeCommandParams,
  MissionControlSnapshotParams,
  ContextReadinessParams,
  ContextSearchParams,
  ContextScopeValidateParams,
  ContextWritebackProposalParams,
  FullReadParams,
  ReceiveFullParams,
  ProjectDnaReadinessParams,
  ProjectDnaPlanWorkflowParams,
  ProjectDnaQueryParams,
  ProjectDnaFederatedQueryParams,
  ProjectDnaWritebackProposalParams,
};
