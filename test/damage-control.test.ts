import { strict as assert } from "node:assert";
import { test } from "node:test";

import { blockedFeedback } from "../.pi/extensions/zob-harness/src/core/utils/formatting.ts";
import { registerHarnessEvents } from "../.pi/extensions/zob-harness/src/runtime/events.ts";
import { createHarnessRuntimeState } from "../.pi/extensions/zob-harness/src/runtime/state.ts";
import {
  DAMAGE_CONTROL_REASON_CODES,
  buildDamageControlBlockMetadata,
  damageControlBodyLikeFieldViolations,
  loadDamageRules,
  persistDamageControlBlockFailClosed,
  validateDamageControlBlockMetadata,
} from "../.pi/extensions/zob-harness/src/domains/governance/safety.ts";

const SECRET = "synthetic-secret-value-never-persist";

type ToolCallHandler = (event: unknown, context: unknown) => Promise<unknown>;

function damageControlHarness(options: { mode?: "explore" | "implement"; confirm?: boolean; appendThrows?: boolean } = {}) {
  const handlers = new Map<string, ToolCallHandler>();
  const entries: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const state = createHarnessRuntimeState();
  state.activeMode = options.mode ?? "implement";
  state.currentRules = loadDamageRules(process.cwd());
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (eventName: string, handler: ToolCallHandler) => handlers.set(eventName, handler),
    appendEntry: (customType: string, data: Record<string, unknown>) => {
      if (options.appendThrows) throw new Error("synthetic telemetry outage");
      entries.push({ customType, data });
    },
  };
  registerHarnessEvents(pi as never, state);
  const context = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      confirm: async () => options.confirm === true,
      notify: () => undefined,
    },
  };
  const call = async (toolName: string, input: Record<string, unknown>) => {
    const handler = handlers.get("tool_call");
    assert.ok(handler, "tool_call handler must be registered");
    return handler({ toolName, input }, context);
  };
  return { call, entries };
}

test("damage-control exposes stable reason codes for every existing block class", () => {
  assert.deepEqual(DAMAGE_CONTROL_REASON_CODES, [
    "mode_blocked",
    "zero_access",
    "read_only",
    "protected_delete",
    "destructive_command",
    "approval_denied",
  ]);
});

test("damage-control metadata is deterministic, body-free, and contains only hashed arguments", () => {
  const first = buildDamageControlBlockMetadata({
    toolName: "bash",
    currentMode: "implement",
    reasonCode: "destructive_command",
    ruleIdentity: "bash-pattern:recursive-deletion",
    attemptedInput: {
      command: `printf ${SECRET}`,
      nested: {
        prompt: SECRET,
        credentials: [{ token: SECRET }, { content: SECRET }],
      },
    },
  });
  const reordered = buildDamageControlBlockMetadata({
    toolName: "bash",
    currentMode: "implement",
    reasonCode: "destructive_command",
    ruleIdentity: "bash-pattern:recursive-deletion",
    attemptedInput: {
      nested: {
        credentials: [{ token: SECRET }, { content: SECRET }],
        prompt: SECRET,
      },
      command: `printf ${SECRET}`,
    },
  });

  assert.equal(first.schema, "zob.damage-control-block.v1");
  assert.equal(first.block, true);
  assert.equal(first.executionPerformed, false);
  assert.equal(first.bodyStored, false);
  assert.equal(first.argumentCount, 2);
  assert.equal(first.argumentHash, reordered.argumentHash);
  assert.equal(first.ruleDigest, reordered.ruleDigest);
  assert.equal(JSON.stringify(first).includes(SECRET), false);
  assert.deepEqual(damageControlBodyLikeFieldViolations(first), []);
  assert.deepEqual(validateDamageControlBlockMetadata(first), []);
});

test("damage-control recursive safety gate rejects nested body-like fields", () => {
  const unsafe = {
    ...buildDamageControlBlockMetadata({
      toolName: "read",
      currentMode: "explore",
      reasonCode: "zero_access",
      ruleIdentity: "zero-access-pattern",
      attemptedInput: { path: SECRET },
    }),
    nested: {
      items: [{ message: SECRET }],
      oldText: SECRET,
      rawPrompt: SECRET,
    },
  };

  assert.deepEqual(damageControlBodyLikeFieldViolations(unsafe), ["$.nested.items[0].message", "$.nested.oldText", "$.nested.rawPrompt"]);
  assert.ok(validateDamageControlBlockMetadata(unsafe).some((error) => error.includes("forbidden body-like field")));
});

test("damage-control telemetry failure remains fail-closed", () => {
  const metadata = buildDamageControlBlockMetadata({
    toolName: "edit",
    currentMode: "explore",
    reasonCode: "mode_blocked",
    ruleIdentity: "mode:explore:file-write",
    attemptedInput: { path: "src/example.ts", oldText: SECRET, newText: SECRET },
  });
  let calls = 0;
  const result = persistDamageControlBlockFailClosed(metadata, () => {
    calls += 1;
    throw new Error("synthetic telemetry outage");
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { block: true, telemetryRecorded: false });
});

test("runtime preserves block classes, rule order, and body-free durable entries", async () => {
  const cases: Array<{
    toolName: string;
    input: Record<string, unknown>;
    mode?: "explore" | "implement";
    reasonCode: string;
  }> = [
    { toolName: "edit", input: { path: "src/example.ts", oldText: SECRET, newText: SECRET }, mode: "explore", reasonCode: "mode_blocked" },
    { toolName: "read", input: { path: ".env", nested: { token: SECRET } }, reasonCode: "zero_access" },
    { toolName: "write", input: { path: "node_modules/example.ts", content: SECRET }, reasonCode: "read_only" },
    { toolName: "bash", input: { command: "rm .pi/extensions/example.ts" }, reasonCode: "protected_delete" },
    { toolName: "bash", input: { command: "git commit -m unsafe" }, reasonCode: "destructive_command" },
    { toolName: "bash", input: { command: "sudo echo denied" }, reasonCode: "approval_denied" },
  ];

  for (const item of cases) {
    const harness = damageControlHarness({ mode: item.mode, confirm: false });
    const result = await harness.call(item.toolName, item.input) as { block?: unknown; reason?: unknown };
    assert.equal(result.block, true, item.reasonCode);
    assert.equal(harness.entries.length, 1, item.reasonCode);
    assert.equal(harness.entries[0].customType, "zob-damage-control");
    assert.equal(harness.entries[0].data.reasonCode, item.reasonCode);
    assert.equal(harness.entries[0].data.executionPerformed, false);
    assert.equal(JSON.stringify(harness.entries[0].data).includes(SECRET), false);
    assert.deepEqual(validateDamageControlBlockMetadata(harness.entries[0].data), []);
  }
});

test("runtime preserves approval success and fail-closed telemetry behavior", async () => {
  const approved = damageControlHarness({ confirm: true });
  assert.equal(await approved.call("bash", { command: "sudo echo approved" }), undefined);
  assert.equal(approved.entries.length, 0);

  const telemetryFailure = damageControlHarness({ mode: "explore", appendThrows: true });
  const blocked = await telemetryFailure.call("edit", { path: "src/example.ts", oldText: SECRET, newText: SECRET }) as { block?: unknown };
  assert.equal(blocked.block, true);
  assert.equal(telemetryFailure.entries.length, 0);
});

test("blocked feedback keeps attempted input transient and adds structured diagnostics", () => {
  const feedback = blockedFeedback("bash", "recursive deletion", `rm -rf ${SECRET}`, {
    executionPerformed: false,
    currentMode: "implement",
    reasonCode: "destructive_command",
    retryPolicy: "do_not_retry_same_call",
    safeNextAction: "request_explicit_approval_with_risk_and_rollback",
  });

  assert.ok(feedback.includes("ZOB damage-control blocked bash: recursive deletion"));
  assert.ok(feedback.includes(`Attempted: rm -rf ${SECRET}`));
  assert.ok(feedback.includes("execution_performed=false"));
  assert.ok(feedback.includes("current_mode=implement"));
  assert.ok(feedback.includes("reason_code=destructive_command"));
  assert.ok(feedback.includes("retry_policy=do_not_retry_same_call"));
  assert.ok(feedback.includes("safe_next_action=request_explicit_approval_with_risk_and_rollback"));
});
