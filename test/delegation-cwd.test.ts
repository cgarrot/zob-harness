import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";

import { DelegateParams } from "../.pi/extensions/zob-harness/src/runtime/schemas.ts";
import {
  buildDelegationLogLines,
  createDelegationMonitorState,
  finishDelegationRun,
  formatDelegationCwdLabel,
  formatDelegationWorkspaceLabel,
  startDelegationRun,
  updateDelegationRun,
} from "../.pi/extensions/zob-harness/src/runtime/delegation-monitor.ts";
import { renderDelegationFeedLines } from "../.pi/extensions/zob-harness/src/runtime/delegation-feed.ts";
import { hydrateDelegationRunsFromDetails, renderDelegationToolResultText } from "../.pi/extensions/zob-harness/src/runtime/tools-delegation/helpers.ts";
import type { ChildResult } from "../.pi/extensions/zob-harness/src/types.ts";

const REPO = "/repo";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
  underline: (text: string) => text,
};

function childResult(cwd: string): ChildResult {
  return {
    agent: "explore",
    task: "1. TASK: inspect\n2. EXPECTED OUTCOME: evidence\n3. REQUIRED TOOLS: read\n4. MUST DO: cite\n5. MUST NOT DO: edit\n6. CONTEXT: scoped",
    exitCode: 0,
    output: "ok",
    stderr: "",
    cwd,
    ledgerRunId: "delegate_cwd",
    usage: { turns: 1, input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 5 },
  };
}

test("DelegateParams exposes top-level cwd for delegate_agent defaults", () => {
  const properties = (DelegateParams as unknown as { properties?: Record<string, unknown> }).properties ?? {};
  assert.ok(properties.cwd, "expected DelegateParams.properties.cwd");
});

test("delegation cwd label is compact and repo-relative", () => {
  assert.equal(formatDelegationCwdLabel({ cwd: "/repo" }, REPO), "cwd .");
  assert.equal(formatDelegationCwdLabel({ cwd: "/repo/packages/a" }, REPO), "cwd packages/a");
  assert.equal(formatDelegationWorkspaceLabel({ cwd: "/repo/packages/a" }, REPO), "workspace · packages/a");
});

test("DelegationRunView stores cwd across start, update, finish, and log/feed rendering", () => {
  const state = createDelegationMonitorState();
  startDelegationRun(state, {
    id: "run_cwd",
    parentToolCallId: "tool_cwd",
    source: "delegate_agent",
    mode: "single",
    agent: "explore",
    task: "inspect cwd",
    startedAtMs: 100,
    cwd: "/repo/subdir",
  });
  assert.equal(state.runs[0]?.cwd, "/repo/subdir");

  updateDelegationRun(state, "run_cwd", { cwd: "/repo/other", outputPreview: "running" });
  finishDelegationRun(state, "run_cwd", { status: "complete", endedAtMs: 200, cwd: "/repo/other", outputPreview: "done" });
  assert.equal(state.runs[0]?.cwd, "/repo/other");

  assert.ok(buildDelegationLogLines(state.runs[0], REPO).some((line) => line === "workspace · other"));
  assert.ok(renderDelegationFeedLines(state.runs[0], REPO, 100, theme as any).some((line) => line.includes("workspace · other")));
});

test("hydration and compact tool rendering preserve cwd from ChildResult", () => {
  const state = { delegations: createDelegationMonitorState() };
  const cwd = join(process.cwd(), "workspace");
  const details = { mode: "single" as const, results: [childResult(cwd)], agents: ["explore"] };

  hydrateDelegationRunsFromDetails("delegate_agent", details, state as any, "tool_cwd");
  assert.equal(state.delegations.runs[0]?.cwd, cwd);

  const rendered = renderDelegationToolResultText("delegate_agent", details, state as any, "tool_cwd", false, false, theme);
  assert.ok(rendered.includes("workspace · workspace"), rendered);
  assert.ok(rendered.includes("cwd workspace"), rendered);
});
