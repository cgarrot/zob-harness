import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { HarnessRuntimeState } from "./state.js";
import { launchCapturedPlan } from "./plan-launch.js";

const PlanLaunchParams = Type.Object({
  plan_id: Type.Optional(Type.String({ description: "Captured plan_id from .pi/plans/index.json or legacy plans/index.json." })),
  plan_path: Type.Optional(Type.String({ description: "Repo-relative captured plan Markdown path or sibling .todos.json path under .pi/plans/ or legacy plans/." })),
  selector: Type.Optional(StringEnum(["latest_launchable", "latest"] as const, { description: "Plan selector when plan_id/plan_path are omitted. Default latest_launchable." })),
  dry_run: Type.Optional(Type.Boolean({ description: "Validate and preview the saved plan TODO tree without creating a runtime goal/TODOs.", default: false })),
  attach_to_active_goal: Type.Optional(Type.Boolean({ description: "Legacy explicit attach flag. When true, attach TODOs to the active non-complete goal. Default launch behavior now auto-attaches safely when an active goal exists.", default: false })),
  active_goal_strategy: Type.Optional(StringEnum(["auto", "block", "attach"] as const, { description: "How to handle a non-complete active runtime goal. auto (default) attaches safely; block preserves strict old behavior; attach is explicit attach." })),
  queue_continuation: Type.Optional(Type.Boolean({ description: "Queue automatic goal continuation after materializing TODOs. Default true.", default: true })),
  relaunch_as_new_goal: Type.Optional(Type.Boolean({ description: "Allow launching a plan whose sidecar/index is already marked launched. Default false. With an active goal, combine with active_goal_strategy=attach only if duplicate materialization into that goal is intentional.", default: false })),
});

export function registerPlanTools(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerTool({
    name: "zob_plan_launch",
    label: "ZOB Plan Launch",
    description: "Launch a saved mode-plan artifact by reading its validated .todos.json sidecar, creating/attaching a runtime goal, materializing TODO/sub-TODO nodes, and optionally queueing continuation. The LLM must not recreate TODOs from prose.",
    promptSnippet: "Use when the user says go/run/do this saved plan: read the launchable plan TODO sidecar and materialize runtime /goal TODOs without re-planning.",
    promptGuidelines: [
      "Prefer selector=latest_launchable only when the user's reference is unambiguous; otherwise pass plan_id or plan_path.",
      "Use dry_run=true for inspection or ambiguity; launch mutates runtime goal/TODO state but not source files.",
      "When a non-complete active runtime goal exists, default active_goal_strategy=auto attaches safely instead of failing; use active_goal_strategy=block only when strict blocking is required.",
    ],
    parameters: PlanLaunchParams,
    renderCall(args, theme) {
      const target = args.plan_id ?? args.plan_path ?? args.selector ?? "latest_launchable";
      const mode = args.dry_run ? "dry-run" : "launch";
      return new Text(`${theme.fg("toolTitle", theme.bold("plan"))} ${theme.fg("accent", `${mode} ${target}`)}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = typeof result === "object" && result && "details" in result ? (result as { details?: Record<string, unknown> }).details : undefined;
      const status = typeof details?.status === "string" ? details.status : "done";
      const planId = typeof details?.planId === "string" ? details.planId : undefined;
      const planPath = typeof details?.planPath === "string" ? details.planPath : undefined;
      const sidecarPath = typeof details?.sidecarPath === "string" ? details.sidecarPath : undefined;
      const todoCount = typeof details?.todoCount === "number" ? details.todoCount : undefined;
      const summary = typeof details?.summary === "string" ? details.summary : undefined;
      const errors = Array.isArray(details?.errors) ? details.errors.filter((item): item is string => typeof item === "string") : [];
      const statusColor = status === "blocked" ? "warning" : status === "launched" || status === "already_launched" ? "success" : "accent";
      let text = [
        theme.fg(statusColor, status === "blocked" ? "⚠ plan launch blocked" : status === "already_launched" ? "↪ plan already launched" : status === "launched" ? "🚀 plan launched" : "✅ plan preview"),
        planId ? theme.fg("accent", planId) : undefined,
        todoCount !== undefined ? theme.fg("muted", `${todoCount} TODO${todoCount === 1 ? "" : "s"}`) : undefined,
      ].filter(Boolean).join(theme.fg("dim", " · "));
      if (planPath) text += `\n${theme.fg("dim", "plan:")} ${theme.fg("muted", planPath)}`;
      if (sidecarPath) text += `\n${theme.fg("dim", "sidecar:")} ${theme.fg("muted", sidecarPath)}`;
      if (errors.length > 0) text += `\n${theme.fg("warning", errors.join("\n"))}`;
      if (expanded && summary) text += `\n${theme.fg("dim", summary)}`;
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = launchCapturedPlan(pi, state, ctx, {
        plan_id: params.plan_id,
        plan_path: params.plan_path,
        selector: params.selector,
        dry_run: params.dry_run,
        attach_to_active_goal: params.attach_to_active_goal,
        active_goal_strategy: params.active_goal_strategy,
        queue_continuation: params.queue_continuation,
        relaunch_as_new_goal: params.relaunch_as_new_goal,
      });
      return { content: [{ type: "text", text: result.summary }], details: result };
    },
  });
}
