import type { AgentScope, ChildThinkingLevel } from "../../types.js";

export type AgenticClaimValidationInput = {
  mode?: "off" | "oracle_then_auto_accept";
  oracle_agent?: string;
  auto_accept_on_pass?: boolean;
  output_contract?: string;
};

export type ChildGoalBinding = {
  schema: "zob.child-goal-binding.v1";
  goal_id: string;
  goal_revision: number;
  graph_revision: number;
  todo_id: string;
  todo_path: string;
  todo_revision: number;
  parent_todo_id?: string;
  delegation_attempt_id: string;
  validation_policy: "parent_review" | "oracle_required";
  expected_claim: {
    goal_id: string;
    todo_id: string;
    todo_path: string;
    todo_revision: number;
    delegation_attempt_id: string;
    validation_policy: "parent_review" | "oracle_required";
    output_contract: string;
  };
};

export type ChildGoalInput = {
  enabled?: boolean;
  objective?: string;
  todo_id?: string;
  parent_todo_id?: string;
  todo_path?: string;
  delegation_depth?: number;
  request_id?: string;
  oracle_required?: boolean;
  max_turns?: number;
  max_tokens?: number;
  completion_policy?: "return_claim" | "oracle_before_complete";
  agentic_validation?: AgenticClaimValidationInput;
  /** Parent-runtime-only canonical binding. Input values are always discarded and recomputed before launch. */
  binding?: ChildGoalBinding;
};

export type DelegateTaskAliasInput = {
  agent: string;
  task: string;
  expected_outcome?: string;
  expectedOutcome?: string;
  required_tools?: string[];
  requiredTools?: string[];
  must_do?: string[];
  mustDo?: string[];
  must_not_do?: string[];
  mustNotDo?: string[];
  must_not?: string[];
  mustNot?: string[];
  context: string;
  original_user_ask?: string;
  originalUserAsk?: string;
  allowed_paths?: string[];
  allowedPaths?: string[];
  forbidden_paths?: string[];
  forbiddenPaths?: string[];
  output_contract?: string;
  outputContract?: string;
  child_goal?: ChildGoalInput;
  childGoal?: ChildGoalInput;
  run_in_background?: boolean;
  runInBackground?: boolean;
  load_skills?: string[];
  loadSkills?: string[];
  cwd?: string;
  scope?: AgentScope;
  model?: string;
  thinking?: ChildThinkingLevel;
};

export type DelegateTaskCanonicalInput = Omit<DelegateTaskAliasInput,
  | "expectedOutcome"
  | "requiredTools"
  | "mustDo"
  | "mustNotDo"
  | "must_not"
  | "mustNot"
  | "originalUserAsk"
  | "allowedPaths"
  | "forbiddenPaths"
  | "outputContract"
  | "childGoal"
  | "runInBackground"
  | "loadSkills"
> & {
  expected_outcome: string;
  must_do: string[];
  must_not_do: string[];
};
