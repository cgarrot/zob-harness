import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GOAL_MUTATION_TOOL_NAMES, createHarnessRuntimeState } from "../.pi/extensions/zob-harness/index.ts";
import { registerGoalRuntimeEvents } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/events.ts";
import {
  appendRuntimeGoalEntry,
  createRuntimeGoal,
  setEntry,
} from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/state.ts";
import { registerGoalRuntimeTools } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts";

const GOAL_ENTRY_TYPE = "zob-runtime-goal";

type CapturedTool = {
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
};

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function capturePi() {
  const entries: Array<{ type: string; data: unknown }> = [];
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, EventHandler>();
  const pi = {
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, entries, tools, handlers };
}

function hasCas(tool: CapturedTool): boolean {
  const cas = tool.parameters.properties?.cas as { type?: string } | undefined;
  return cas?.type === "object";
}

test("canonical Goal/TODO mutation inventory exactly matches every registered CAS mutator", () => {
  const capture = capturePi();
  registerGoalRuntimeTools(capture.pi, createHarnessRuntimeState());

  const registeredCasMutators = [...capture.tools.values()]
    .filter(hasCas)
    .map((tool) => tool.name)
    .sort();
  const inventory = [...GOAL_MUTATION_TOOL_NAMES].sort();

  assert.equal(GOAL_MUTATION_TOOL_NAMES.length, 20);
  assert.equal(new Set(GOAL_MUTATION_TOOL_NAMES).size, 20, "canonical inventory has no duplicates");
  assert.deepEqual(registeredCasMutators, inventory, "registered optional-cas mutators cannot drift from the canonical inventory");
  for (const name of GOAL_MUTATION_TOOL_NAMES) {
    assert.ok(capture.tools.has(name), `${name} is registered`);
  }
  assert.equal(capture.tools.get("recover_goal_todo_delegation")!.parameters.required?.includes("cas"), true, "delegation recovery CAS is mandatory");
  assert.equal(hasCas(capture.tools.get("get_goal")!), false);
  assert.equal(hasCas(capture.tools.get("get_goal_todos")!), false);
});

test("tool_execution_end renders only for every guarded mutation outcome and preserves unguarded legacy accounting", async () => {
  const capture = capturePi();
  const state = createHarnessRuntimeState();
  appendRuntimeGoalEntry(capture.pi, state, setEntry(createRuntimeGoal("CAS post-hook matrix"), "tool"));
  capture.entries.length = 0;
  let renders = 0;
  registerGoalRuntimeEvents(capture.pi, state, () => { renders += 1; });
  const handler = capture.handlers.get("tool_execution_end");
  assert.ok(handler);

  const guardedEvents = [
    { args: { cas: { mutation_id: "event-applied" } }, result: { details: { cas: { status: "applied" } } } },
    { input: { cas: { mutation_id: "event-replayed" } }, result: { details: { cas: { status: "replayed" } } } },
    { result: { details: { cas: { status: "stale" } } } },
    { result: { details: { cas: { status: "conflict" } } } },
    { result: { isError: true, details: { cas: { status: "rejected" } } } },
  ] as const;

  for (const toolName of GOAL_MUTATION_TOOL_NAMES) {
    for (const event of guardedEvents) {
      capture.entries.length = 0;
      const before = JSON.stringify(state);
      const rendersBefore = renders;
      await handler({ toolName, ...event }, { ui: { setStatus: () => undefined } });
      assert.equal(capture.entries.length, 0, `${toolName} guarded post-hook emits no entry`);
      assert.equal(JSON.stringify(state), before, `${toolName} guarded post-hook advances no revision/state`);
      assert.equal(renders, rendersBefore + 1, `${toolName} guarded post-hook renders once`);
    }
  }

  for (const toolName of GOAL_MUTATION_TOOL_NAMES) {
    capture.entries.length = 0;
    const revisionBefore = state.runtimeGoal!.revision;
    await handler({ toolName, args: {}, result: { details: {} } }, { ui: { setStatus: () => undefined } });
    const ownsExactRootLineage = toolName === "record_goal_oracle" || toolName === "update_goal";
    assert.equal(capture.entries.filter((entry) => entry.type === GOAL_ENTRY_TYPE).length, ownsExactRootLineage ? 0 : 1, `${toolName} post-hook persistence policy`);
    assert.equal(state.runtimeGoal?.revision, revisionBefore + (ownsExactRootLineage ? 0 : 1), `${toolName} post-hook revision policy`);
  }

  capture.entries.length = 0;
  const unrelatedRevision = state.runtimeGoal!.revision;
  await handler({
    toolName: "unrelated_tool",
    args: { cas: { mutation_id: "unrelated-field" } },
    result: { details: { cas: { status: "replayed" } } },
  }, { ui: { setStatus: () => undefined } });
  assert.equal(capture.entries.filter((entry) => entry.type === GOAL_ENTRY_TYPE).length, 1, "an unrelated cas field does not suppress legacy persistence");
  assert.equal(state.runtimeGoal?.revision, unrelatedRevision + 1);

  capture.entries.length = 0;
  const getterRevision = state.runtimeGoal!.revision;
  await handler({ toolName: "get_goal" }, { ui: { setStatus: () => undefined } });
  await handler({ toolName: "get_goal_todos" }, { ui: { setStatus: () => undefined } });
  assert.equal(capture.entries.length, 0);
  assert.equal(state.runtimeGoal?.revision, getterRevision);
});
