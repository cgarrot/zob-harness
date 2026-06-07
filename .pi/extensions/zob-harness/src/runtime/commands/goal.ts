import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseBillableJobIntake, validateBillableJobIntake } from "../../domains/goal/goal.js";
import { handleGoalCommand, handleGoalGateCommand } from "../goal-runtime.js";
import { showGoalTodoOverlay } from "../goal-todo-overlay.js";
import type { HarnessRuntimeState } from "../state.js";
import { renderHarnessWidget } from "../widget.js";

export function registerGoalCommands(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerCommand("goal", {
    description: "Unified ZOB runtime goal: /goal <objective>, pause, resume, clear, status, gate, todo, oracle PASS|WARN|FAIL",
    handler: async (args, ctx) => {
      await handleGoalCommand(pi, state, args, ctx, () => renderHarnessWidget(pi, state, ctx));
    },
  });

  pi.registerCommand("todo", {
    description: "Alias for /goal todo. Manage goal-linked TODOs and subtodos.",
    handler: async (args, ctx) => {
      await handleGoalCommand(pi, state, `todo ${args}`.trim(), ctx, () => renderHarnessWidget(pi, state, ctx));
    },
  });

  pi.registerCommand("todos", {
    description: "Alias for /goal todo tree. Use /todos overlay to open the TODO overlay.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "overlay" || trimmed.startsWith("overlay ") || trimmed === "view" || trimmed.startsWith("view ")) {
        await showGoalTodoOverlay(ctx, state, trimmed.split(/\s+/)[1]);
        return;
      }
      await handleGoalCommand(pi, state, `todo ${trimmed || "tree"}`.trim(), ctx, () => renderHarnessWidget(pi, state, ctx));
    },
  });

  pi.registerCommand("goal_gate", {
    description: "Alias for /goal gate. Set or insert the active ZOB goal gate; --strict requires it before ZOB dispatch tools.",
    handler: async (args, ctx) => {
      handleGoalGateCommand(pi, state, args.trim(), ctx, () => renderHarnessWidget(pi, state, ctx));
    },
  });

  pi.registerCommand("job_intake", {
    description: "Parse billable job intake into active goal plus optional advisory budget sidecar",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.setEditorText([
          "ORIGINAL_USER_ASK: [paste the user's exact ask]",
          "ACTIVE_GOAL: [one bounded billable job goal]",
          "EXPECTED_OUTPUT: [observable paid deliverable]",
          "CONSTRAINTS: [must-do and must-not-do constraints]",
          "VALIDATION_EVIDENCE: [commands, files, sentinels, or oracle verdict required]",
          "BUDGET: [optional advisory sidecar; absence is allowed]",
        ].join("\n"));
        return;
      }
      const intake = parseBillableJobIntake(text);
      const errors = validateBillableJobIntake(intake);
      if (errors.length > 0) {
        ctx.ui.notify(`ZOB job intake rejected:\n- ${errors.join("\n- ")}`, "warning");
        return;
      }
      state.activeGoal = intake.goal;
      state.goalRequired = true;
      pi.appendEntry("zob-job-intake", intake);
      renderHarnessWidget(pi, state, ctx);
      ctx.ui.notify(`ZOB job intake accepted: ${intake.goal.activeGoal.slice(0, 100)} (budget advisory only)`, "info");
    },
  });
}
