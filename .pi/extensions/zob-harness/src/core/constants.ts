import type { DamageRules, ModeName } from "../types.js";

const DEFAULT_RULES: DamageRules = {
  bashToolPatterns: [
    { pattern: "\\brm\\s+(-rf?|--recursive)", reason: "recursive deletion" },
    { pattern: "\\bgit\\s+reset\\s+--hard\\b", reason: "destructive git reset" },
    { pattern: "\\bgit\\s+clean\\s+-", reason: "destructive git clean" },
    { pattern: "\\bgit\\s+add\\s+(-A|\\.)", reason: "bulk git staging" },
    { pattern: "\\bsudo\\b", reason: "privileged command", ask: true },
  ],
  zeroAccessPaths: [".env", ".env.*", "~/.ssh", "~/.aws", "*.pem", "*.key"],
  readOnlyPaths: [".git/", "node_modules/", "dist/", "build/", "package-lock.json", "pnpm-lock.yaml", "bun.lock"],
  noDeletePaths: [".git/", "AGENTS.md", "README.md", ".pi/"],
};

export { DEFAULT_RULES };

export const ZOB_TOOL_ROUTING_CONTRACT = [
  "ZOB TOOL ROUTING CONTRACT",
  "- For non-trivial or tool-ambiguous work, run a lightweight routing loop before acting.",
  "- Classify applicable families: goal/TODO, delegation, orchestration, compute, context/ProjectDNA, factory, coms/goal-room, workspace/merge, autonomous-runtime, oracle.",
  "- Load .pi/skills/zob-tool-router/SKILL.md when routing is uncertain or work spans multiple families; then load the domain skill(s) named by the registry.",
  "- Use the smallest sufficient tool set: use, delegate, or explicitly skip applicable families with a reason.",
  "- Do not bypass mode/tool safety, approval, sandbox, budget, evidence, or oracle gates.",
].join("\n");

export const ZOB_COMPACTION_CONTINUITY_CONTRACT = [
  "ZOB COMPACTION CONTINUITY CONTRACT",
  "- After compaction, trust persisted goal/TODO/evidence state and cited artifacts over memory or summary prose.",
  "- Reload critical skills/docs/files by path when detailed behavior or edits depend on them; compaction keeps refs, not full bodies.",
  "- Do not assume compacted tool outputs preserve all details; validate from commands, ledgers, reports, or safe file refs before completion.",
  "- Preserve blockers/no_ship/next action across compaction; if unclear, inspect live state or block instead of claiming done.",
].join("\n");

export const EXTERNAL_PACKAGE_TOOLS_CONTRACT = [
  "ZOB EXTERNAL PACKAGE TOOLS CONTRACT",
  "- Non-builtin tools registered by external Pi packages/extensions may be active automatically in governed ZOB modes.",
  "- Follow each package tool's own promptSnippet/promptGuidelines and never use package tools to bypass ZOB safety gates.",
  "- Do not send secrets, credentials, private code, proprietary raw data, or sensitive URLs to external/cloud tools.",
  "- For external facts, cite source URLs or tool evidence and distinguish external facts from repo-local evidence.",
  "- If a package tool requires private/authenticated data or sensitive payloads, stop and ask for an explicitly gated workflow instead.",
].join("\n");

export const SUPERVISED_SMOKE_CHILD_TOOLS = ["read", "grep", "find", "ls"] as const;
export const SUPERVISED_READONLY_CHILD_TOOLS = ["read", "grep", "find", "ls"] as const;
export const READ_ONLY_CHAIN_TOOLS = ["read", "grep", "find", "ls"] as const;
export const BLOCKED_CHAIN_TOOLS = ["bash", "edit", "write", "delegate_agent", "delegate_task", "orchestrate_run", "factory_run", "factory_quarantine_review", "factory_quarantine_activate", "factory_quarantine_verify_activation", "chain_run"] as const;

export const ZOB_COMS_TOOLS = ["zob_coms_send", "zob_coms_ack", "zob_coms_status", "zob_coms_reply", "zob_coms_list", "zob_coms_get", "zob_coms_await", "zpeer_ask"] as const;
export const ZOB_GOAL_ROOM_TOOLS = ["zob_goal_room_send", "zob_goal_room_list"] as const;
export const ZOB_GOVERNED_REQUEST_TOOLS = ["zob_governed_request_extract"] as const;
export const ZOB_WORKSPACE_CLAIM_TOOLS = ["zob_workspace_claim", "zob_workspace_release", "zob_workspace_claims_list"] as const;
export const ZOB_WORKER_POOL_TOOLS = ["zob_worker_pool_plan", "zob_worker_pool_status", "zob_worker_pool_owner_request", "zob_worker_pool_owner_decision"] as const;
export const ZOB_MERGE_QUEUE_TOOLS = ["zob_merge_candidate_submit", "zob_merge_queue_decide", "zob_merge_queue_list"] as const;
export const ZOB_ZCOMMIT_TOOLS = ["zob_zcommit_run"] as const;
export const ZOB_ZAGENT_TOOLS = ["zob_zteam_hot_add", "zob_zteam_remove"] as const;
export const ZOB_DELEGATION_READ_TOOLS = ["zob_delegation_catalog", "get_delegation_run", "await_delegation_run"] as const;
export const ZOB_MISSION_CONTROL_READ_TOOLS = ["zob_coms_readiness", "zob_mission_control_snapshot"] as const;
export const ZOB_MISSION_CONTROL_PROPOSAL_TOOLS = ["zob_mission_control_propose_command"] as const;
export const ZOB_CONTEXT_READ_TOOLS = ["zob_context_search", "zob_context_readiness", "zob_context_validate_scope"] as const;
export const ZOB_CONTEXT_PROPOSAL_TOOLS = ["zob_context_writeback_proposal"] as const;
export const ZOB_COMPUTE_READ_TOOLS = ["zob_compute_preview", "zob_compute_resolve_profile", "zob_compute_plan_workflow", "zob_compute_validate_profile"] as const;
export const ZOB_COMPUTE_REPORT_TOOLS = ["zob_compute_write_profile_reports"] as const;
export const ZOB_PROJECT_DNA_READ_TOOLS = ["zob_project_dna_readiness", "zob_project_dna_plan_workflow", "zob_project_dna_query", "zob_project_dna_federated_query"] as const;
export const ZOB_PROJECT_DNA_PROPOSAL_TOOLS = ["zob_project_dna_writeback_proposal"] as const;
export const ZOB_PLAN_LAUNCH_TOOLS = ["zob_plan_launch"] as const;
export const ZOB_RUNTIME_GOAL_TOOLS = ["get_goal", "get_goal_todos", "add_goal_todo", "add_goal_todos", "update_goal_todo", "resolve_goal_todo", "complete_goal_todo", "block_goal_todo", "split_goal_todo", "validate_goal_todo_claim", "accept_goal_todo_claim", "reject_goal_todo_claim", "import_factory_todos", "import_orchestration_todos", "import_chain_todos", "create_goal", "resume_goal", "propose_goal_completion", "record_goal_oracle", "update_goal"] as const;
export const ZOB_AUTONOMOUS_READ_TOOLS = ["zob_autonomous_validate_run", "zob_autonomous_validate_smoke"] as const;
export const ZOB_AUTONOMOUS_FACTORY_TOOLS = ["zob_autonomous_dry_run", "zob_autonomous_readonly_smoke"] as const;

export const MODE_TOOLS: Record<ModeName, string[]> = {
  explore: ["read", "grep", "find", "ls", "bash", "delegate_agent", "delegate_task", "zob_coms_list", "zob_coms_get", "zob_coms_await", "zpeer_ask", "zob_goal_room_list", "zob_workspace_claims_list", "zob_worker_pool_status", "zob_merge_queue_list", ...ZOB_RUNTIME_GOAL_TOOLS, ...ZOB_DELEGATION_READ_TOOLS, ...ZOB_ZCOMMIT_TOOLS, ...ZOB_AUTONOMOUS_READ_TOOLS, ...ZOB_MISSION_CONTROL_READ_TOOLS, ...ZOB_CONTEXT_READ_TOOLS, ...ZOB_COMPUTE_READ_TOOLS, ...ZOB_PROJECT_DNA_READ_TOOLS],
  plan: ["read", "grep", "find", "ls", "delegate_agent", "delegate_task", "orchestrate_run", "chain_run", ...ZOB_PLAN_LAUNCH_TOOLS, ...ZOB_RUNTIME_GOAL_TOOLS, ...ZOB_DELEGATION_READ_TOOLS, ...ZOB_ZCOMMIT_TOOLS, ...ZOB_ZAGENT_TOOLS, ...ZOB_COMS_TOOLS, ...ZOB_GOAL_ROOM_TOOLS, ...ZOB_GOVERNED_REQUEST_TOOLS, ...ZOB_WORKSPACE_CLAIM_TOOLS, ...ZOB_WORKER_POOL_TOOLS, ...ZOB_MERGE_QUEUE_TOOLS, ...ZOB_MISSION_CONTROL_READ_TOOLS, ...ZOB_MISSION_CONTROL_PROPOSAL_TOOLS, ...ZOB_CONTEXT_READ_TOOLS, ...ZOB_CONTEXT_PROPOSAL_TOOLS, ...ZOB_COMPUTE_READ_TOOLS, ...ZOB_COMPUTE_REPORT_TOOLS, ...ZOB_PROJECT_DNA_READ_TOOLS, ...ZOB_PROJECT_DNA_PROPOSAL_TOOLS],
  implement: ["read", "bash", "edit", "write", "grep", "find", "ls", "delegate_agent", "delegate_task", ...ZOB_PLAN_LAUNCH_TOOLS, ...ZOB_RUNTIME_GOAL_TOOLS, ...ZOB_DELEGATION_READ_TOOLS, ...ZOB_ZCOMMIT_TOOLS, ...ZOB_ZAGENT_TOOLS, ...ZOB_COMS_TOOLS, ...ZOB_GOAL_ROOM_TOOLS, ...ZOB_GOVERNED_REQUEST_TOOLS, ...ZOB_WORKSPACE_CLAIM_TOOLS, ...ZOB_WORKER_POOL_TOOLS, ...ZOB_MERGE_QUEUE_TOOLS, ...ZOB_MISSION_CONTROL_READ_TOOLS, ...ZOB_MISSION_CONTROL_PROPOSAL_TOOLS, ...ZOB_CONTEXT_READ_TOOLS, ...ZOB_CONTEXT_PROPOSAL_TOOLS, ...ZOB_COMPUTE_READ_TOOLS, ...ZOB_COMPUTE_REPORT_TOOLS, ...ZOB_PROJECT_DNA_READ_TOOLS, ...ZOB_PROJECT_DNA_PROPOSAL_TOOLS],
  oracle: ["read", "grep", "find", "ls", "bash", "delegate_agent", "delegate_task", "zob_coms_list", "zob_coms_get", "zob_coms_await", "zpeer_ask", "zob_goal_room_list", "zob_workspace_claims_list", "zob_worker_pool_status", "zob_merge_queue_list", ...ZOB_RUNTIME_GOAL_TOOLS, ...ZOB_DELEGATION_READ_TOOLS, ...ZOB_ZCOMMIT_TOOLS, ...ZOB_AUTONOMOUS_READ_TOOLS, ...ZOB_MISSION_CONTROL_READ_TOOLS, ...ZOB_CONTEXT_READ_TOOLS, ...ZOB_COMPUTE_READ_TOOLS, ...ZOB_PROJECT_DNA_READ_TOOLS],
  orchestrator: ["read", "grep", "find", "ls", "delegate_agent", "delegate_task", "orchestrate_run", "chain_run", ...ZOB_PLAN_LAUNCH_TOOLS, ...ZOB_RUNTIME_GOAL_TOOLS, ...ZOB_DELEGATION_READ_TOOLS, ...ZOB_ZCOMMIT_TOOLS, ...ZOB_ZAGENT_TOOLS, ...ZOB_COMS_TOOLS, ...ZOB_GOAL_ROOM_TOOLS, ...ZOB_GOVERNED_REQUEST_TOOLS, ...ZOB_WORKSPACE_CLAIM_TOOLS, ...ZOB_WORKER_POOL_TOOLS, ...ZOB_MERGE_QUEUE_TOOLS, ...ZOB_MISSION_CONTROL_READ_TOOLS, ...ZOB_MISSION_CONTROL_PROPOSAL_TOOLS, ...ZOB_CONTEXT_READ_TOOLS, ...ZOB_CONTEXT_PROPOSAL_TOOLS, ...ZOB_COMPUTE_READ_TOOLS, ...ZOB_COMPUTE_REPORT_TOOLS],
  factory: ["read", "bash", "edit", "write", "grep", "find", "ls", "delegate_agent", "delegate_task", "orchestrate_run", "factory_run", "factory_quarantine_review", "factory_quarantine_activate", "factory_quarantine_verify_activation", "chain_run", ...ZOB_PLAN_LAUNCH_TOOLS, ...ZOB_RUNTIME_GOAL_TOOLS, ...ZOB_DELEGATION_READ_TOOLS, ...ZOB_ZCOMMIT_TOOLS, ...ZOB_ZAGENT_TOOLS, ...ZOB_AUTONOMOUS_READ_TOOLS, ...ZOB_AUTONOMOUS_FACTORY_TOOLS, ...ZOB_COMS_TOOLS, ...ZOB_GOAL_ROOM_TOOLS, ...ZOB_GOVERNED_REQUEST_TOOLS, ...ZOB_WORKSPACE_CLAIM_TOOLS, ...ZOB_WORKER_POOL_TOOLS, ...ZOB_MERGE_QUEUE_TOOLS, ...ZOB_MISSION_CONTROL_READ_TOOLS, ...ZOB_MISSION_CONTROL_PROPOSAL_TOOLS, ...ZOB_CONTEXT_READ_TOOLS, ...ZOB_CONTEXT_PROPOSAL_TOOLS, ...ZOB_COMPUTE_READ_TOOLS, ...ZOB_COMPUTE_REPORT_TOOLS, ...ZOB_PROJECT_DNA_READ_TOOLS, ...ZOB_PROJECT_DNA_PROPOSAL_TOOLS],
  // Vanilla is handled specially by applyMode: all currently available Pi tools are enabled.
  vanilla: [],
};

export const MODE_PROMPTS: Record<ModeName, string> = {
  explore: `ZOB MODE: EXPLORE (read-only reconnaissance)
- Start with: Literal Request / Actual Need / Success Looks Like.
- Use read/grep/find/ls and safe read-only bash only.
- Return <files>, <answer>, <next_steps>. Mirror every numbered user question.
- Do not edit files. If a write is required, propose the smallest follow-up implement task.`,
  plan: `ZOB MODE: PLAN (factory planning)
- No edits, no commits, no broad test runs.
- For non-trivial or tool-ambiguous plans, apply the ZOB tool-routing contract and state which families are in/out before detailed steps.
- Produce scope table, likely files, TDD sequence, validation ladder, atomic commit plan, risks, and stop conditions.
- For complete implementation plans, include exactly one machine-readable TODO manifest block at the end: <!-- ZOB_PLAN_TODOS_START --> + fenced JSON schema zob.plan-todos.v1 + <!-- ZOB_PLAN_TODOS_END -->; keep it simple (objective, todos, key, title, done_when, checks, children) so zob_plan_launch can launch without the LLM recreating TODOs from prose.
- Treat launchability as part of plan quality: if the explicit TODO block is omitted, capture falls back to deterministic Markdown list parsing and may record fallback warnings or needs_manifest; do not rely on prose-only plans when you can emit the block.
- Consume prior explore outputs before re-reading. Avoid duplicate discovery.
- Single-plan rule: if the immediately previous assistant response already provided a complete plan for the same request, do not restate it; summarize that the plan is already provided and offer to refine, save, or implement it.
- If auto-mode switched to plan after a short handoff, produce the deferred plan once and do not request plan mode again.`,
  implement: `ZOB MODE: IMPLEMENT (bounded build)
- Before editing, state a sufficiency verdict: sufficient/no-change or exact gap + smallest file set.
- For non-trivial or tool-ambiguous slices, apply the ZOB tool-routing contract but avoid unnecessary delegation/compute/coms for small edits.
- Make surgical edits only. Prefer edit over write for existing files.
- Use edit/write for file changes; do not mutate repo files through bash/python/perl/node patch scripts unless the user explicitly approves that fallback.
- Verify in ladder order: touched-file diagnostics or static checks -> smallest targeted test -> affected package build/typecheck when justified.
- End with commands/results and explicit MUST NOT compliance. No commits unless the user asks.`,
  oracle: `ZOB MODE: ORACLE (skeptical verdict)
- Read-only verification. Lead with PASS / FAIL / WARN and confidence.
- Cite file paths, commands, logs, or exact missing evidence.
- Separate blockers from non-blocking notes. Do not patch.`,
  orchestrator: `ZOB MODE: ORCHESTRATOR (Chief Vision non-coding)
- Root role: govern goals, TODOs, work graphs, routing, parent-owned delegation, evidence, blockers, and completion gates.
- Apply the ZOB tool-routing contract before building the workgraph: classify families, load relevant domain skills, and use/delegate/skip each with a reason.
- Do not code directly: no edit/write/patch/commit and no destructive shell; do not perform worker implementation yourself.
- For any substantive exploration, implementation, QA, security review, documentation production, or oracle judgment, create or delegate a bounded subtask instead of doing the work yourself.
- You may perform only lightweight coordination, TODO/goal metadata management, synthesis of returned evidence, blocker decisions, and user clarification.
- Use delegate_task/delegate_agent for bounded specialist subtasks and prefer orchestrate_run for multi-agent Lead/Worker decomposition; default orchestration execution=plan_only unless explicit parent/oracle gates allow supervised_readonly.
- Use goal/TODO graph, compute profile, context scopes, chain_run plan_only, goal-room/coms metadata, Mission Control proposals, and oracle gates to coordinate.
- Do not treat planned orchestration as completed implementation work.
- Completion requires evidence, validation, oracle PASS, and no_ship=false.`,
  factory: `ZOB MODE: FACTORY (build the system that builds the system)
- Apply the ZOB tool-routing contract for repeatability/autonomy/context/oracle questions before designing the pipeline.
- Turn repeated work into reusable prompts, agents, scripts, schemas, or Pi extensions.
- Prefer deterministic scaffolding for immutable content; let LLMs enrich structured sections only.
- Require sentinel/completion artifacts and validation before scale-up.`,
  vanilla: `ZOB MODE: VANILLA (Pi base-style unrestricted agent)
- Behave like the base Pi coding agent rather than a governed ZOB workflow agent.
- ZOB-specific Explore/Plan/Implement/Oracle routing, tool-routing, TODO/goal governance, and bash mutation blocks are disabled for this mode.
- You may use any available Pi tool and launch arbitrary shell commands, including external coding tools such as codex or project scripts that modify files.
- Do not claim ZOB safety/oracle/governance guarantees while in vanilla; the user is intentionally choosing direct operator-style execution.
- Keep normal conversational clarity: state what you are about to run when useful, then execute directly and report results.`,
};
