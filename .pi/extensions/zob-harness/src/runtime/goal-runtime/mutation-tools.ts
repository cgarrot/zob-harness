/** Canonical inventory of every public Goal/TODO tool whose optional `cas` guard owns persistence. */
export const GOAL_MUTATION_TOOL_NAMES = [
  "create_goal",
  "resume_goal",
  "propose_goal_completion",
  "record_goal_oracle",
  "update_goal",
  "add_goal_todo",
  "add_goal_todos",
  "update_goal_todo",
  "resolve_goal_todo",
  "complete_goal_todo",
  "block_goal_todo",
  "split_goal_todo",
  "validate_goal_todo_claim",
  "accept_goal_todo_claim",
  "reject_goal_todo_claim",
  "recover_goal_todo_delegation",
  "handoff_goal_todo",
  "import_factory_todos",
  "import_orchestration_todos",
  "import_chain_todos",
] as const;

export type GoalMutationToolName = (typeof GOAL_MUTATION_TOOL_NAMES)[number];

const goalMutationToolNames = new Set<string>(GOAL_MUTATION_TOOL_NAMES);

export function isGoalMutationToolName(value: string): value is GoalMutationToolName {
  return goalMutationToolNames.has(value);
}
