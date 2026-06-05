import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

import type { ChildResult, OutputContract, OutputRequirement } from "../../types.js";

const COMMON_OUTPUT_REQUIREMENTS: OutputRequirement[] = [
  {
    name: "deliverable_delivered",
    pattern: "deliverable_delivered\\s*:\\s*(yes|no)|<deliverable_delivered>\\s*(yes|no)\\s*</deliverable_delivered>",
    message: "Missing required final marker: deliverable_delivered: yes/no",
  },
  {
    name: "evidence",
    pattern: "<evidence>|\\bevidence\\b|proof",
    message: "Missing evidence/proof section",
  },
  {
    name: "risks_blockers",
    pattern: "<risks_blockers>|risks?/blockers?|risks?|blockers?",
    message: "Missing risks/blockers section",
  },
  {
    name: "compliance",
    pattern: "<compliance>|\\bcompliance\\b|must not",
    message: "Missing compliance line",
  },
];

const OUTPUT_CONTRACTS: OutputContract[] = [
  {
    id: "base.v1",
    description: "Base ZOB delegated output: deliverable marker, evidence, risks/blockers, compliance.",
    agentNames: [],
    required: COMMON_OUTPUT_REQUIREMENTS,
  },
  {
    id: "explore.v1",
    description: "Read-only exploration with reframing, files, answer, gaps, and next steps.",
    agentNames: ["explore", "refactor-cartographer"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "literal_request", pattern: "<literal_request>|literal request|literal_request", message: "Explore output missing literal_request" },
      { name: "actual_need", pattern: "<actual_need>|actual need|actual_need", message: "Explore output missing actual_need" },
      { name: "success_looks_like", pattern: "<success_looks_like>|success looks like|success_looks_like", message: "Explore output missing success_looks_like" },
      { name: "files", pattern: "<files>|\\bfiles\\b", message: "Explore output missing files section" },
      { name: "answer", pattern: "<answer>|\\banswer\\b", message: "Explore output missing answer section" },
      { name: "gaps", pattern: "<gaps>|\\bgaps\\b", message: "Explore output missing gaps section" },
      { name: "next_steps", pattern: "<next_steps>|next steps|next_steps", message: "Explore output missing next_steps section" },
    ],
  },
  {
    id: "plan.v1",
    description: "Planning output with scope, assumptions, validation ladder, stop conditions, and handoff contract.",
    agentNames: ["planner", "plan", "chief-vision"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "scope", pattern: "scope|in-scope|out-of-scope|forbidden", message: "Plan output missing scope table" },
      { name: "assumptions", pattern: "assumptions?", message: "Plan output missing assumptions" },
      { name: "implementation_slices", pattern: "implementation (steps|slices)|slices?", message: "Plan output missing implementation slices/steps" },
      { name: "validation_ladder", pattern: "validation ladder|validation", message: "Plan output missing validation ladder" },
      { name: "stop_conditions", pattern: "stop conditions?", message: "Plan output missing stop conditions" },
      { name: "handoff_contract", pattern: "handoff|TASK:|EXPECTED OUTCOME:|MUST NOT", message: "Plan output missing implementer handoff contract" },
    ],
  },
  {
    id: "implement.v1",
    description: "Bounded implementation report with gap verdict, changed files/no-change evidence, commands, and results.",
    agentNames: ["implementer", "implement", "refactor-mover"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "gap_verdict", pattern: "gap verdict|SUFFICIENT|GAP|no change|no-change", message: "Implement output missing gap/no-change verdict" },
      { name: "changed_files", pattern: "changed files|no change|no-change", message: "Implement output missing changed files or no-change evidence" },
      { name: "verification_commands", pattern: "verification|commands?", message: "Implement output missing verification commands" },
      { name: "results", pattern: "results?|exit code|passed|failed", message: "Implement output missing command/results evidence" },
    ],
  },
  {
    id: "oracle.v1",
    description: "Skeptical review with verdict, confidence, blockers, evidence, and no_ship decision.",
    agentNames: ["oracle", "refactor-oracle"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "verdict", pattern: "<verdict>\\s*(PASS|FAIL|WARN)\\s*</verdict>|\\b(PASS|FAIL|WARN)\\b", message: "Oracle output missing PASS/FAIL/WARN verdict" },
      { name: "confidence", pattern: "<confidence>|\\bconfidence\\b", message: "Oracle output missing confidence" },
      { name: "blocking_issues", pattern: "<blocking_issues>|blocking issues?|blockers?", message: "Oracle output missing blocking issues" },
      { name: "non_blocking_notes", pattern: "<non_blocking_notes>|non[-_ ]blocking", message: "Oracle output missing non-blocking notes" },
      { name: "no_ship", pattern: "<no_ship>|no_ship|no ship", message: "Oracle output missing no_ship decision" },
    ],
  },
  {
    id: "qa.v1",
    description: "QA verification with verdict, commands, exit/output evidence, and reproduction details.",
    agentNames: ["qa"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "verdict", pattern: "\\b(PASS|FAIL|WARN|INCONCLUSIVE)\\b|verdict", message: "QA output missing verification verdict" },
      { name: "command", pattern: "commands?|cwd", message: "QA output missing command/cwd evidence" },
      { name: "exit_or_output", pattern: "exit code|output|stdout|stderr|important output", message: "QA output missing exit/output evidence" },
      { name: "reproduction", pattern: "reproduction|reproduce|steps", message: "QA output missing reproduction steps" },
    ],
  },
  {
    id: "synthesis.v1",
    description: "Parallel-lane synthesis with consensus, conflicts, missing evidence, next action, and rerun tasks.",
    agentNames: ["synthesis"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "consensus", pattern: "<consensus>|\\bconsensus\\b", message: "Synthesis output missing consensus section" },
      { name: "conflicts", pattern: "<conflicts>|conflicts?", message: "Synthesis output missing conflicts section" },
      { name: "missing_evidence", pattern: "<missing_evidence>|missing_evidence|missing evidence", message: "Synthesis output missing missing_evidence section" },
      { name: "recommended_next_action", pattern: "<recommended_next_action>|recommended_next_action|recommended next action", message: "Synthesis output missing recommended_next_action section" },
      { name: "tasks_to_rerun", pattern: "<tasks_to_rerun>|tasks_to_rerun|tasks to rerun|rerun", message: "Synthesis output missing tasks_to_rerun section" },
    ],
  },
  {
    id: "oracle-merge.v1",
    description: "Merged review verdict with confidence, no_ship, blockers, evidence, and lane summary.",
    agentNames: ["oracle-merge"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "verdict", pattern: "<verdict>\\s*(PASS|FAIL|WARN)\\s*</verdict>|\\b(PASS|FAIL|WARN)\\b", message: "Oracle merge output missing PASS/FAIL/WARN verdict" },
      { name: "confidence", pattern: "<confidence>|\\bconfidence\\b", message: "Oracle merge output missing confidence" },
      { name: "no_ship", pattern: "<no_ship>|no_ship|no ship", message: "Oracle merge output missing no_ship decision" },
      { name: "blocking_issues", pattern: "<blocking_issues>|blocking issues?|blockers?", message: "Oracle merge output missing blocking issues" },
      { name: "merged_lanes", pattern: "<merged_lanes>|merged_lanes|merged lanes", message: "Oracle merge output missing merged_lanes" },
    ],
  },
  {
    id: "factory.v1",
    description: "Factory design with manifest, schema, validators, pilot, sentinel, and resume strategy.",
    agentNames: ["factory"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "manifest", pattern: "manifest", message: "Factory output missing manifest" },
      { name: "schema", pattern: "schema", message: "Factory output missing schema" },
      { name: "validators", pattern: "validators?|validation gates?", message: "Factory output missing validators" },
      { name: "pilot", pattern: "pilot|smoke", message: "Factory output missing pilot plan/result" },
      { name: "sentinel", pattern: "sentinel", message: "Factory output missing sentinel strategy" },
      { name: "resume", pattern: "resume|checkpoint", message: "Factory output missing resume/checkpoint strategy" },
    ],
  },
  {
    id: "research.v1",
    description: "Sourced research with sources, unknowns, recommendation, evidence, risks, and compliance.",
    agentNames: ["librarian", "research"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "sources", pattern: "sources?|sources_consulted|URLs?|paths?", message: "Research output missing sources" },
      { name: "unknowns", pattern: "unknowns?|uncertainties", message: "Research output missing unknowns/uncertainties" },
      { name: "recommendation", pattern: "recommendation", message: "Research output missing recommendation" },
    ],
  },
  {
    id: "brain-lookup.v1",
    description: "Context/GBrain P0 lookup result with explicit scope, brain/source ids, citations, freshness, confidence, and no body storage.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "context_scope", pattern: "context_scope|context scope", message: "Brain lookup output missing context_scope" },
      { name: "brain_id", pattern: "brain_id|brainId|brain id", message: "Brain lookup output missing brain_id" },
      { name: "source_id", pattern: "source_id|sourceId|source id", message: "Brain lookup output missing source_id" },
      { name: "citations", pattern: "citations?|source refs?", message: "Brain lookup output missing citations" },
      { name: "facts_or_patterns", pattern: "facts_or_patterns|facts|patterns", message: "Brain lookup output missing facts_or_patterns" },
      { name: "gaps", pattern: "gaps|source gaps", message: "Brain lookup output missing gaps" },
      { name: "freshness", pattern: "freshness|stale", message: "Brain lookup output missing freshness" },
      { name: "confidence", pattern: "confidence", message: "Brain lookup output missing confidence" },
      { name: "no_body_storage", pattern: "no_body_storage|bodyStored\s*[:=]\s*false|no body storage", message: "Brain lookup output missing no_body_storage" },
    ],
  },
  {
    id: "context-pack.v1",
    description: "Bounded Context/GBrain P0 context pack with source locks, citations, loading rules, agent profile map, and no body storage.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "pack_id", pattern: "pack_id|packId|pack id", message: "Context pack output missing pack_id" },
      { name: "context_scope", pattern: "context_scope|context scope", message: "Context pack output missing context_scope" },
      { name: "source_locks", pattern: "source_locks|sourceLocks|source locks", message: "Context pack output missing source_locks" },
      { name: "loading_rules", pattern: "loading_rules|loadingRules|loading rules", message: "Context pack output missing loading_rules" },
      { name: "agent_profile_map", pattern: "agent_profile_map|agentProfileMap|agent profile map", message: "Context pack output missing agent_profile_map" },
      { name: "citations", pattern: "citations?|source refs?", message: "Context pack output missing citations" },
      { name: "budget_limits", pattern: "budget_limits|budgetLimits|context limits", message: "Context pack output missing budget_limits" },
      { name: "no_body_storage", pattern: "no_body_storage|bodyStored\s*[:=]\s*false|no body storage", message: "Context pack output missing no_body_storage" },
    ],
  },
  {
    id: "context-writeback-proposal.v1",
    description: "Context/GBrain P0 learning writeback proposal. Proposal only; no auto-promotion or GBrain write.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "observed_problem", pattern: "observed_problem|observed problem", message: "Context writeback proposal missing observed_problem" },
      { name: "new_pattern", pattern: "new_pattern|new pattern", message: "Context writeback proposal missing new_pattern" },
      { name: "evidence_refs", pattern: "evidence_refs|evidence refs|evidence", message: "Context writeback proposal missing evidence_refs" },
      { name: "recommended_artifact", pattern: "recommended_artifact|recommended artifact", message: "Context writeback proposal missing recommended_artifact" },
      { name: "promotion_requires", pattern: "promotion_requires|promotion requires|oracle_PASS|human_approval|smoke_proof", message: "Context writeback proposal missing promotion_requires" },
      { name: "auto_promote", pattern: "auto_promote\s*[:=]\s*false|autoPromote\s*[:=]\s*false", message: "Context writeback proposal missing auto_promote=false" },
    ],
  },
  {
    id: "context-steward.v1",
    description: "Context Steward P0 output with cited context hints, source gaps, stale/missing context warnings, and writeback candidates only.",
    agentNames: ["context-steward"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "context_scope", pattern: "context_scope|context scope", message: "Context steward output missing context_scope" },
      { name: "context_hints", pattern: "context_hints|context hints", message: "Context steward output missing context_hints" },
      { name: "citations", pattern: "citations?|source refs?", message: "Context steward output missing citations" },
      { name: "source_gaps", pattern: "source_gaps|source gaps", message: "Context steward output missing source_gaps" },
      { name: "writeback_candidates", pattern: "writeback_candidates|writeback candidates", message: "Context steward output missing writeback_candidates" },
      { name: "parent_owned", pattern: "parent_owned|parent-owned", message: "Context steward output missing parent_owned" },
      { name: "no_plan_mutation", pattern: "no_plan_mutation|no plan mutation", message: "Context steward output missing no_plan_mutation" },
    ],
  },
  {
    id: "spec.v1",
    description: "Product/factory specification with scope, constraints, acceptance criteria, and planner handoff.",
    agentNames: ["specifier", "spec"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "problem", pattern: "<problem>|\\bproblem\\b", message: "Spec output missing problem" },
      { name: "context", pattern: "<context>|\\bcontext\\b", message: "Spec output missing context" },
      { name: "objectives", pattern: "<objectives>|objectives?", message: "Spec output missing objectives" },
      { name: "non_goals", pattern: "<non_goals>|non[-_ ]goals?", message: "Spec output missing non_goals" },
      { name: "in_scope", pattern: "<in_scope>|in[-_ ]scope", message: "Spec output missing in_scope" },
      { name: "out_of_scope", pattern: "<out_of_scope>|out[-_ ]of[-_ ]scope", message: "Spec output missing out_of_scope" },
      { name: "constraints", pattern: "<constraints>|constraints?", message: "Spec output missing constraints" },
      { name: "acceptance_criteria", pattern: "<acceptance_criteria>|acceptance criteria|acceptance_criteria", message: "Spec output missing acceptance_criteria" },
      { name: "open_questions", pattern: "<open_questions>|open questions|open_questions", message: "Spec output missing open_questions" },
      { name: "handoff_to_planner", pattern: "<handoff_to_planner>|handoff to planner|handoff_to_planner|planner", message: "Spec output missing handoff_to_planner" },
    ],
  },
  {
    id: "clarification.v1",
    description: "Clarification gate with clarity score, verdict, allow_plan, guided questions, and minimum-to-plan.",
    agentNames: ["clarifier"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "clarity_score", pattern: "<clarity_score>|clarity_score|clarity score", message: "Clarification output missing clarity_score" },
      { name: "verdict", pattern: "<verdict>\\s*(CLEAR|NEEDS_CLARIFICATION|BLOCKED)\\s*</verdict>|\\b(CLEAR|NEEDS_CLARIFICATION|BLOCKED)\\b", message: "Clarification output missing CLEAR/NEEDS_CLARIFICATION/BLOCKED verdict" },
      { name: "allow_plan", pattern: "<allow_plan>\\s*(yes|no)\\s*</allow_plan>|allow_plan\\s*[:=]\\s*(yes|no)", message: "Clarification output missing allow_plan yes/no" },
      { name: "ambiguities", pattern: "<ambiguities>|ambiguities", message: "Clarification output missing ambiguities" },
      { name: "questions", pattern: "<questions>|questions?", message: "Clarification output missing questions" },
      { name: "assumptions", pattern: "<assumptions>|assumptions?", message: "Clarification output missing assumptions" },
      { name: "refined_spec", pattern: "<refined_spec>|refined spec|refined_spec", message: "Clarification output missing refined_spec" },
      { name: "minimum_to_plan", pattern: "<minimum_to_plan>|minimum to plan|minimum_to_plan", message: "Clarification output missing minimum_to_plan" },
      { name: "acceptance_criteria", pattern: "<acceptance_criteria>|acceptance criteria|acceptance_criteria", message: "Clarification output missing acceptance_criteria" }
    ],
  },
  {
    id: "launch-authorization.v1",
    description: "Launch authorization envelope: spec lock plus explicit user launch bounds in-scope autonomous actions without storing raw bodies.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "schema", pattern: "zob\.launch-authorization\.v1|launch-authorization\.v1", message: "Launch authorization output missing schema" },
      { name: "spec_locked", pattern: "specLocked\s*[:=]\s*true|spec_locked\s*[:=]\s*true", message: "Launch authorization output missing specLocked=true" },
      { name: "user_launch_confirmed", pattern: "userLaunchConfirmed|user_launch_confirmed", message: "Launch authorization output missing user launch confirmation field" },
      { name: "allowed_actions", pattern: "allowedActions|allowed_actions|allowed actions", message: "Launch authorization output missing allowed actions" },
      { name: "allowed_paths", pattern: "allowedPaths|allowed_paths|allowed paths", message: "Launch authorization output missing allowed paths" },
      { name: "forbidden_paths", pattern: "forbiddenPaths|forbidden_paths|forbidden paths", message: "Launch authorization output missing forbidden paths" },
      { name: "apply_policy", pattern: "applyPolicy|apply_policy|apply policy", message: "Launch authorization output missing apply policy" },
      { name: "stop_conditions", pattern: "stopConditions|stop_conditions|stop conditions", message: "Launch authorization output missing stop conditions" },
      { name: "body_free", pattern: "bodyStored\s*[:=]\s*false|body-free|hash-only", message: "Launch authorization output missing body-free posture" },
    ],
  },
  {
    id: "mission-readiness.v1",
    description: "Interactive autonomy mission-readiness verdict with score, decision, safety gates, launch posture, and hash-only input metadata.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "schema", pattern: "zob\\.mission-readiness\\.v1|mission-readiness\\.v1", message: "Mission readiness output missing schema" },
      { name: "mode", pattern: "mode|open|controlled|adaptive", message: "Mission readiness output missing mode" },
      { name: "decision", pattern: "auto_launch|clarify|block|stopped|decision", message: "Mission readiness output missing decision" },
      { name: "score", pattern: "score|readiness", message: "Mission readiness output missing score" },
      { name: "safety_gates", pattern: "safetyGates|safety_gates|no[- ]secrets|no[- ]destructive", message: "Mission readiness output missing safety gates" },
      { name: "manual_per_action_approval", pattern: "manualPerActionApproval|manual_per_action|per-action", message: "Mission readiness output missing manual per-action approval posture" },
      { name: "launch_authorization", pattern: "launchAuthorization|launch_authorization|launch authorized|launch=", message: "Mission readiness output missing launch authorization posture" },
      { name: "body_free", pattern: "rawInputStored\\s*[:=]\\s*false|bodyStored\\s*[:=]\\s*false|body-free|hash-only", message: "Mission readiness output missing body-free posture" },
    ],
  },
  {
    id: "agent-event.v1",
    description: "Typed parent-visible agent event with hash-only body/output refs, evidence, and no direct TODO mutation.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "schema", pattern: "zob\.agent-event\.v1|agent-event\.v1|zob\.goal-room-message\.v1", message: "Agent event output missing schema" },
      { name: "kind", pattern: "STATUS_UPDATE|FINDING|ACTION_TAKEN|ARTIFACT_READY|TODO_CLAIM|BLOCKER|RISK|CONTEXT_REQUEST|SPLIT_REQUEST|DELEGATION_REQUEST|ORACLE_REQUEST|HANDOFF|DECISION", message: "Agent event output missing typed kind" },
      { name: "body_hash", pattern: "bodyHash|body_hash", message: "Agent event output missing body hash" },
      { name: "parent_visible", pattern: "parentVisible\s*[:=]\s*true|parent_visible\s*[:=]\s*true", message: "Agent event output missing parent-visible posture" },
      { name: "parent_owned_actions", pattern: "parentOwnedActions\s*[:=]\s*true|parent_owned_actions\s*[:=]\s*true", message: "Agent event output missing parent-owned action posture" },
      { name: "no_direct_todo_mutation", pattern: "reducerRequiredForTodoMutation|no direct TODO mutation|no_direct_todo_mutation", message: "Agent event output missing reducer/no-direct-TODO-mutation guard" },
      { name: "body_free", pattern: "bodyStored\s*[:=]\s*false|body-free|hash-only", message: "Agent event output missing body-free posture" },
    ],
  },
  {
    id: "prompt-pack.v1",
    description: "Role-scoped prompt/context pack with bounded docs, skill refs, output contract, event policy, and body-free posture.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "schema", pattern: "zob\.prompt-pack\.v1|prompt-pack\.v1", message: "Prompt pack output missing schema" },
      { name: "role_id", pattern: "roleId|role_id|role id", message: "Prompt pack output missing role id" },
      { name: "prompt_refs", pattern: "promptRefs|prompt_refs|prompt refs", message: "Prompt pack output missing prompt refs" },
      { name: "skill_refs", pattern: "skillRefs|skill_refs|skill refs", message: "Prompt pack output missing skill refs" },
      { name: "doc_refs", pattern: "docRefs|doc_refs|doc refs", message: "Prompt pack output missing doc refs" },
      { name: "output_contract", pattern: "outputContract|output_contract|output contract", message: "Prompt pack output missing output contract" },
      { name: "event_policy", pattern: "eventPolicy|event_policy|agent-event", message: "Prompt pack output missing event policy" },
      { name: "body_free", pattern: "bodyStored\s*[:=]\s*false|body-free|hash-only", message: "Prompt pack output missing body-free posture" },
    ],
  },
  {
    id: "lead-plan.v1",
    description: "Lead plan with worker contracts, risks, evidence needs, no-ship criteria, and model classes.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "lead_id", pattern: "lead_id|leadId|lead id", message: "Lead plan output missing lead_id" },
      { name: "phase", pattern: "phase", message: "Lead plan output missing phase" },
      { name: "worker_contracts", pattern: "worker_contracts|workerContracts|worker contracts", message: "Lead plan output missing worker_contracts" },
      { name: "required_tools", pattern: "required_tools|requiredTools|required tools", message: "Lead plan output missing required_tools" },
      { name: "allowed_paths", pattern: "allowed_paths|allowedPaths|allowed paths", message: "Lead plan output missing allowed_paths" },
      { name: "forbidden_paths", pattern: "forbidden_paths|forbiddenPaths|forbidden paths", message: "Lead plan output missing forbidden_paths" },
      { name: "output_contract", pattern: "output_contract|outputContract|output contract", message: "Lead plan output missing output_contract" },
      { name: "model_class", pattern: "model_class|modelClass|model class", message: "Lead plan output missing model_class" },
      { name: "evidence_needed", pattern: "evidence_needed|evidenceNeeded|evidence needed", message: "Lead plan output missing evidence_needed" },
      { name: "no_ship_criteria", pattern: "no_ship_criteria|noShipCriteria|no ship criteria", message: "Lead plan output missing no_ship_criteria" },
    ],
  },
  {
    id: "todo-child-result.v1",
    description: "Parent-owned delegated TODO claim with child goal status, evidence, validation commands, risks, no_ship, and final marker.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "todo_id", pattern: "todo_id|TODO_ID|todo id", message: "TODO child result missing todo_id" },
      { name: "child_goal_status", pattern: "child_goal_status\\s*[:=]\\s*(ready_for_oracle|incomplete|blocked)|child goal status", message: "TODO child result missing child_goal_status" },
      { name: "status_claim", pattern: "status_claim\\s*[:=]\\s*(done|incomplete|blocked)|status claim", message: "TODO child result missing status_claim" },
      { name: "evidence_refs", pattern: "evidence_refs|evidence refs|evidence", message: "TODO child result missing evidence_refs" },
      { name: "validation_commands", pattern: "validation_commands|validation commands|commands", message: "TODO child result missing validation_commands" },
      { name: "subtodo_delta_proposals", pattern: "subtodo_delta_proposals|subtodo delta proposals", message: "TODO child result missing subtodo_delta_proposals" },
      { name: "no_ship", pattern: "no_ship|no ship", message: "TODO child result missing no_ship" },
      { name: "final_marker", pattern: "FINAL_MARKER\\s*:\\s*TODO_CHILD_RESULT_END|TODO_CHILD_RESULT_END", message: "TODO child result missing FINAL_MARKER: TODO_CHILD_RESULT_END" },
    ],
  },
  {
    id: "todo-child-result.v2",
    description: "Parent-owned delegated TODO claim v2; no_ship is advisory/readiness evidence and does not make a delivered child result a runtime failure.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "todo_id", pattern: "todo_id|TODO_ID|todo id", message: "TODO child result missing todo_id" },
      { name: "child_goal_status", pattern: "child_goal_status\\s*[:=]\\s*(ready_for_oracle|incomplete|blocked)|child goal status", message: "TODO child result missing child_goal_status" },
      { name: "status_claim", pattern: "status_claim\\s*[:=]\\s*(done|incomplete|blocked)|status claim", message: "TODO child result missing status_claim" },
      { name: "evidence_refs", pattern: "evidence_refs|evidence refs|evidence", message: "TODO child result missing evidence_refs" },
      { name: "validation_commands", pattern: "validation_commands|validation commands|commands", message: "TODO child result missing validation_commands" },
      { name: "acceptance_blockers", pattern: "acceptance_blockers|acceptance blockers", message: "TODO child result v2 missing acceptance_blockers" },
      { name: "target_readiness", pattern: "target_readiness\\s*[:=]\\s*(ready_for_parent_acceptance|needs_parent_review|blocked)|target readiness", message: "TODO child result v2 missing target_readiness" },
      { name: "subtodo_delta_proposals", pattern: "subtodo_delta_proposals|subtodo delta proposals", message: "TODO child result missing subtodo_delta_proposals" },
      { name: "no_ship", pattern: "no_ship|no ship", message: "TODO child result missing no_ship" },
      { name: "final_marker", pattern: "FINAL_MARKER\\s*:\\s*(TODO_CHILD_RESULT_V2_END|TODO_CHILD_RESULT_END)|TODO_CHILD_RESULT_V2_END|TODO_CHILD_RESULT_END", message: "TODO child result missing FINAL_MARKER: TODO_CHILD_RESULT_V2_END" },
    ],
  },
  {
    id: "todo-claim-validation.v1",
    description: "Oracle validation of a returned delegated TODO claim; parent runtime may auto-accept only on PASS and no_ship=false.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "todo_id", pattern: "todo_id|TODO_ID|todo id", message: "TODO claim validation missing todo_id" },
      { name: "claim_hash", pattern: "claim_hash\\s*[:=]\\s*[a-fA-F0-9]{64}|claim hash", message: "TODO claim validation missing claim_hash" },
      { name: "verdict", pattern: "verdict\\s*[:=]\\s*(PASS|WARN|FAIL)|\\b(PASS|WARN|FAIL)\\b", message: "TODO claim validation missing PASS/WARN/FAIL verdict" },
      { name: "recommended_action", pattern: "recommended_action\\s*[:=]\\s*(accept_claim|needs_review|reject_claim|block)|recommended action", message: "TODO claim validation missing recommended_action" },
      { name: "evidence_refs", pattern: "evidence_refs|evidence refs|evidence", message: "TODO claim validation missing evidence_refs" },
      { name: "validation_commands", pattern: "validation_commands|validation commands|commands", message: "TODO claim validation missing validation_commands" },
      { name: "blocking_issues", pattern: "blocking_issues|blocking issues|blockers", message: "TODO claim validation missing blocking_issues" },
      { name: "no_ship", pattern: "no_ship|no ship", message: "TODO claim validation missing no_ship" },
      { name: "confidence", pattern: "confidence\\s*[:=]\\s*(LOW|MEDIUM|HIGH)|confidence", message: "TODO claim validation missing confidence" },
      { name: "final_marker", pattern: "FINAL_MARKER\\s*:\\s*TODO_CLAIM_VALIDATION_END|TODO_CLAIM_VALIDATION_END", message: "TODO claim validation missing FINAL_MARKER: TODO_CLAIM_VALIDATION_END" },
    ],
  },
  {
    id: "todo-split-request.v1",
    description: "Parent-owned TODO replan signal: a delegated child requests that its parent split an oversized TODO instead of forcing poor completion.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "todo_id", pattern: "todo_id|TODO_ID|todo id", message: "TODO split request missing todo_id" },
      { name: "reason", pattern: "reason\\s*[:=]|reason|rationale", message: "TODO split request missing reason" },
      { name: "recommended_action", pattern: "recommended_action\\s*[:=]\\s*(split|replan|factory|needs_user|blocked)|recommended action", message: "TODO split request missing recommended_action" },
      { name: "proposed_subtodos", pattern: "proposed_subtodos|proposed subtodos|subtasks", message: "TODO split request missing proposed_subtodos" },
      { name: "risk_level", pattern: "risk_level\\s*[:=]\\s*(low|medium|high)|risk level", message: "TODO split request missing risk_level" },
      { name: "validation_plan", pattern: "validation_plan|validation plan", message: "TODO split request missing validation_plan" },
      { name: "no_ship", pattern: "no_ship|no ship", message: "TODO split request missing no_ship" },
      { name: "final_marker", pattern: "FINAL_MARKER\\s*:\\s*TODO_SPLIT_REQUEST_END|TODO_SPLIT_REQUEST_END", message: "TODO split request missing FINAL_MARKER: TODO_SPLIT_REQUEST_END" },
    ],
  },
  {
    id: "delegation-request.v1",
    description: "Governed parent-owned request for a future delegation. It is a request only: no child direct dispatch or parent TODO mutation.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "request_type", pattern: "request_type\\s*[:=]\\s*DELEGATION_REQUEST\\.v1|DELEGATION_REQUEST\\.v1", message: "Delegation request missing request_type: DELEGATION_REQUEST.v1" },
      { name: "request_id", pattern: "request_id|request id", message: "Delegation request missing request_id" },
      { name: "requested_by", pattern: "requested_by|requested by", message: "Delegation request missing requested_by" },
      { name: "requested_action", pattern: "requested_action|requested action", message: "Delegation request missing requested_action" },
      { name: "body_hash", pattern: "body_hash\\s*[:=]\\s*[a-fA-F0-9]{64}|body hash", message: "Delegation request missing body_hash" },
      { name: "agent", pattern: "agent\\s*[:=]", message: "Delegation request missing agent" },
      { name: "risk_level", pattern: "risk_level\\s*[:=]\\s*(low|medium|high)|risk level", message: "Delegation request missing risk_level" },
      { name: "no_ship", pattern: "no_ship|no ship", message: "Delegation request missing no_ship" },
      { name: "final_marker", pattern: "FINAL_MARKER\\s*:\\s*DELEGATION_REQUEST_END|DELEGATION_REQUEST_END", message: "Delegation request missing FINAL_MARKER: DELEGATION_REQUEST_END" },
    ],
  },
  {
    id: "oracle-request.v1",
    description: "Governed parent-owned request for oracle review. It is visible metadata only and executes no oracle dispatch by itself.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "request_type", pattern: "request_type\\s*[:=]\\s*ORACLE_REQUEST\\.v1|ORACLE_REQUEST\\.v1", message: "Oracle request missing request_type: ORACLE_REQUEST.v1" },
      { name: "request_id", pattern: "request_id|request id", message: "Oracle request missing request_id" },
      { name: "requested_by", pattern: "requested_by|requested by", message: "Oracle request missing requested_by" },
      { name: "requested_action", pattern: "requested_action|requested action", message: "Oracle request missing requested_action" },
      { name: "body_hash", pattern: "body_hash\\s*[:=]\\s*[a-fA-F0-9]{64}|body hash", message: "Oracle request missing body_hash" },
      { name: "risk_level", pattern: "risk_level\\s*[:=]\\s*(low|medium|high)|risk level", message: "Oracle request missing risk_level" },
      { name: "no_ship", pattern: "no_ship|no ship", message: "Oracle request missing no_ship" },
      { name: "final_marker", pattern: "FINAL_MARKER\\s*:\\s*ORACLE_REQUEST_END|ORACLE_REQUEST_END", message: "Oracle request missing FINAL_MARKER: ORACLE_REQUEST_END" },
    ],
  },
  {
    id: "context-request.v1",
    description: "Governed parent-owned request for bounded context. It is visible metadata only and performs no corpus/backend write or child dispatch.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "request_type", pattern: "request_type\\s*[:=]\\s*CONTEXT_REQUEST\\.v1|CONTEXT_REQUEST\\.v1", message: "Context request missing request_type: CONTEXT_REQUEST.v1" },
      { name: "request_id", pattern: "request_id|request id", message: "Context request missing request_id" },
      { name: "requested_by", pattern: "requested_by|requested by", message: "Context request missing requested_by" },
      { name: "requested_action", pattern: "requested_action|requested action", message: "Context request missing requested_action" },
      { name: "body_hash", pattern: "body_hash\\s*[:=]\\s*[a-fA-F0-9]{64}|body hash", message: "Context request missing body_hash" },
      { name: "context_scope_id", pattern: "context_scope_id|context scope", message: "Context request missing context_scope_id" },
      { name: "risk_level", pattern: "risk_level\\s*[:=]\\s*(low|medium|high)|risk level", message: "Context request missing risk_level" },
      { name: "no_ship", pattern: "no_ship|no ship", message: "Context request missing no_ship" },
      { name: "final_marker", pattern: "FINAL_MARKER\\s*:\\s*CONTEXT_REQUEST_END|CONTEXT_REQUEST_END", message: "Context request missing FINAL_MARKER: CONTEXT_REQUEST_END" },
    ],
  },
  {
    id: "guidance-steward.v1",
    description: "Documentation/guidance steward output with layer docs, role doc packs, rule gaps, and proposal-only writebacks.",
    agentNames: ["doc-steward", "guidance-steward"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "documentation_policy", pattern: "documentation_policy|documentationPolicy|documentation policy", message: "Guidance steward output missing documentation_policy" },
      { name: "guidance_index", pattern: "guidance_index|guidanceIndex|guidance index", message: "Guidance steward output missing guidance_index" },
      { name: "layer_docs", pattern: "layer_docs|layer docs|AGENTS\.md", message: "Guidance steward output missing layer_docs" },
      { name: "role_doc_packs", pattern: "role_doc_packs|role doc packs|roleDocs", message: "Guidance steward output missing role_doc_packs" },
      { name: "writeback_proposals", pattern: "writeback_proposals|writeback proposals|proposal_only", message: "Guidance steward output missing writeback_proposals" },
      { name: "body_free", pattern: "bodyStored\s*[:=]\s*false|body-free|hash-only", message: "Guidance steward output missing body-free/hash-only posture" },
    ],
  },
  {
    id: "temp-agent-card.v1",
    description: "Run-scoped temporary agent card proposal. Proposal only; parent/governor validates before any temp agent joins a run.",
    agentNames: ["temp-agent-creator", "agent-creator"],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "request_type", pattern: "AGENT_CREATE_REQUEST\.v1|request_type", message: "Temp agent card output missing AGENT_CREATE_REQUEST.v1" },
      { name: "temp_agent_card", pattern: "temp_agent_card|temp-agent-card|TempAgentCard", message: "Temp agent card output missing temp_agent_card" },
      { name: "run_id", pattern: "run_id|runId", message: "Temp agent card output missing run_id" },
      { name: "role", pattern: "role", message: "Temp agent card output missing role" },
      { name: "allowed_tools", pattern: "allowed_tools|allowedTools|allowed tools", message: "Temp agent card output missing allowed_tools" },
      { name: "forbidden_paths", pattern: "forbidden_paths|forbiddenPaths|forbidden paths", message: "Temp agent card output missing forbidden_paths" },
      { name: "output_contract", pattern: "output_contract|outputContract|output contract", message: "Temp agent card output missing output_contract" },
      { name: "model_class", pattern: "model_class|modelClass|model class", message: "Temp agent card output missing model_class" },
      { name: "expires_at", pattern: "expires_at|expiresAt", message: "Temp agent card output missing expires_at" },
      { name: "promotion_policy", pattern: "promotion_policy|promotion requires|promotionEligible", message: "Temp agent card output missing promotion_policy" },
      { name: "body_free", pattern: "bodyStored\s*[:=]\s*false|promptBodiesStored\s*[:=]\s*false|body-free|hash-only", message: "Temp agent card output missing body-free posture" },
    ],
  },
  {
    id: "orchestration-profile.v1",
    description: "Declarative orchestration profile with roles, edges, phases, model policy, and completion gates.",
    agentNames: [],
    required: [
      ...COMMON_OUTPUT_REQUIREMENTS,
      { name: "profile", pattern: "profile", message: "Orchestration profile output missing profile" },
      { name: "roles", pattern: "roles", message: "Orchestration profile output missing roles" },
      { name: "edges", pattern: "edges", message: "Orchestration profile output missing edges" },
      { name: "phases", pattern: "phases", message: "Orchestration profile output missing phases" },
      { name: "model_policy", pattern: "model_policy|modelPolicy|model policy", message: "Orchestration profile output missing model_policy" },
      { name: "output_contracts", pattern: "output_contracts|outputContracts|output contracts", message: "Orchestration profile output missing output_contracts" },
      { name: "tools", pattern: "tools", message: "Orchestration profile output missing tools" },
      { name: "paths", pattern: "paths", message: "Orchestration profile output missing paths" },
      { name: "final_report", pattern: "final_report|finalReport|final report", message: "Orchestration profile output missing final_report" },
      { name: "refusal_rules", pattern: "refusal_rules|refusalRules|refusal rules", message: "Orchestration profile output missing refusal_rules" },
    ],
  },
];

const OUTPUT_CONTRACT_BY_ID = new Map(OUTPUT_CONTRACTS.map((contract) => [contract.id, contract]));
const OUTPUT_CONTRACT_BY_AGENT = new Map(
  OUTPUT_CONTRACTS.flatMap((contract) => contract.agentNames.map((agentName) => [agentName.toLowerCase(), contract.id] as const)),
);

interface OutputContractValidationOptions {
  repoRoot?: string;
  maxArtifactBytes?: number;
}

const ARTIFACT_REF_REGEX = /(?:^|[\s("'`])((?:\.\/)?(?:reports|\.pi\/tmp|docs)\/[A-Za-z0-9._\/-]+\.(?:md|txt|json|jsonl))(?:$|[\s)"'`,.;:])/g;
const SAFE_ARTIFACT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl"]);
const DEFAULT_ARTIFACT_MAX_BYTES = 96 * 1024;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requirementAliasPattern(name: string): RegExp {
  const snake = escapeRegExp(name);
  const hyphen = escapeRegExp(name.replace(/_/g, "-"));
  const spaced = escapeRegExp(name.replace(/_/g, " "));
  return new RegExp(`(?:<${snake}>|<${hyphen}>|\\b${snake}\\b|\\b${hyphen}\\b|\\b${spaced}\\b)`, "i");
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function isSafeArtifactPath(repoRoot: string, candidate: string): boolean {
  if (!isInside(repoRoot, candidate)) return false;
  const relative = candidate.slice(resolve(repoRoot).length + 1).replace(/\\/g, "/");
  if (!/^(reports|\.pi\/tmp|docs)\//.test(relative)) return false;
  if (/(^|\/)(node_modules|dist|build)(\/|$)/.test(relative)) return false;
  if (/(^|\/)(\.env|.*\.env|.*secret.*|.*credential.*|.*key.*)$/i.test(relative)) return false;
  return SAFE_ARTIFACT_EXTENSIONS.has(extname(relative).toLowerCase());
}

function extractArtifactRefs(output: string): string[] {
  const refs = new Set<string>();
  for (const match of output.matchAll(ARTIFACT_REF_REGEX)) {
    const ref = match[1]?.replace(/^\.\//, "");
    if (ref) refs.add(ref);
  }
  return [...refs];
}

function readReferencedArtifacts(output: string, options: OutputContractValidationOptions): string[] {
  if (!options.repoRoot) return [];
  const artifacts: string[] = [];
  const maxBytes = options.maxArtifactBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
  for (const ref of extractArtifactRefs(output)) {
    const candidate = resolve(options.repoRoot, ref);
    if (!isSafeArtifactPath(options.repoRoot, candidate) || !existsSync(candidate)) continue;
    const stat = statSync(candidate);
    if (!stat.isFile() || stat.size > maxBytes) continue;
    artifacts.push(readFileSync(candidate, "utf8"));
  }
  return artifacts;
}

export function listOutputContracts(): string[] {
  return OUTPUT_CONTRACTS.map((contract) => contract.id);
}

export function getOutputContractDefinitions(): Array<{ id: string; required: string[] }> {
  return OUTPUT_CONTRACTS.map((contract) => ({ id: contract.id, required: contract.required.map((requirement) => requirement.name) }));
}

export function inferOutputContract(agentName: string): string {
  return OUTPUT_CONTRACT_BY_AGENT.get(agentName.toLowerCase()) ?? "base.v1";
}

export function validateOutputContractId(contractId: string | undefined): string[] {
  if (!contractId) return [];
  return OUTPUT_CONTRACT_BY_ID.has(contractId) ? [] : [`Unknown output contract '${contractId}'. Available: ${listOutputContracts().join(", ")}`];
}

function extractDeliverableMarker(output: string): "yes" | "no" | undefined {
  const finalLine = output.split(/\r?\n/).filter((line) => line.trim()).at(-1);
  if (!finalLine) return undefined;
  const normalized = finalLine.trim().replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
  const colonMarker = /^deliverable_delivered\s*:\s*(yes|no)\s*\.?$/i.exec(normalized);
  const xmlMarker = /^<deliverable_delivered>\s*(yes|no)\s*<\/deliverable_delivered>\s*$/i.exec(normalized);
  const value = colonMarker?.[1] ?? xmlMarker?.[1];
  if (value?.toLowerCase() === "yes" || value?.toLowerCase() === "no") return value.toLowerCase() as "yes" | "no";
  return undefined;
}

function extractAnyDeliverableMarker(output: string): "yes" | "no" | undefined {
  const marker = /(?:^|\n)\s*(?:[-*]\s*)?(?:deliverable_delivered\s*:\s*(yes|no)|<deliverable_delivered>\s*(yes|no)\s*<\/deliverable_delivered>)\s*(?:\n|$)/i.exec(output);
  const value = marker?.[1] ?? marker?.[2];
  if (value?.toLowerCase() === "yes" || value?.toLowerCase() === "no") return value.toLowerCase() as "yes" | "no";
  return undefined;
}

function validateOutputContractText(output: string, contract: OutputContract): string[] {
  const trimmed = output.trim();
  if (!trimmed) return ["Child produced no assistant output"];

  const deliverableMarker = extractDeliverableMarker(trimmed);
  const allowsEmbeddedDeliverable = ["todo-child-result.v1", "todo-child-result.v2", "todo-split-request.v1", "todo-claim-validation.v1", "delegation-request.v1", "oracle-request.v1", "context-request.v1"].includes(contract.id);
  const embeddedDeliverableMarker = allowsEmbeddedDeliverable ? extractAnyDeliverableMarker(trimmed) : undefined;
  const effectiveDeliverableMarker = embeddedDeliverableMarker ?? deliverableMarker;
  const errors: string[] = [];
  for (const requirement of contract.required) {
    if (requirement.name === "deliverable_delivered") {
      if (allowsEmbeddedDeliverable ? !embeddedDeliverableMarker : !deliverableMarker) errors.push(requirement.message);
      continue;
    }

    let pattern: RegExp;
    try {
      pattern = new RegExp(requirement.pattern, "i");
    } catch (error) {
      errors.push(`Invalid output contract '${contract.id}' requirement '${requirement.name}': ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const aliasPattern = requirementAliasPattern(requirement.name);
    if (!pattern.test(trimmed) && !aliasPattern.test(trimmed)) errors.push(requirement.message);
  }

  if (effectiveDeliverableMarker === "no") errors.push("Child reported deliverable_delivered: no");

  return errors;
}

export function validateOutputContract(output: string, contractId: string, options: OutputContractValidationOptions = {}): string[] {
  const trimmed = output.trim();
  const contract = OUTPUT_CONTRACT_BY_ID.get(contractId);
  if (!contract) return validateOutputContractId(contractId);

  const directErrors = validateOutputContractText(trimmed, contract);
  if (directErrors.length === 0) return [];

  for (const artifact of readReferencedArtifacts(trimmed, options)) {
    if (validateOutputContractText(artifact, contract).length === 0) return [];
    if (validateOutputContractText(`${artifact}\n\n${trimmed}`, contract).length === 0) return [];
  }

  return directErrors;
}

export function validateChildOutput(result: ChildResult, contractId = result.outputContract ?? inferOutputContract(result.agent), options: OutputContractValidationOptions = {}): string[] {
  return validateOutputContract(result.output, contractId, options);
}

export function applyChildGates(result: ChildResult, options: OutputContractValidationOptions = {}): ChildResult {
  result.gateErrors = validateChildOutput(result, result.outputContract ?? inferOutputContract(result.agent), options);
  result.gatePassed = result.gateErrors.length === 0;
  return result;
}
