#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const source = readFileSync(join(repoRoot, ".pi", "extensions", "zob-harness", "src", "runtime", "goal-runtime.ts"), "utf8");

assert(!source.includes("append_goal_room: Type.Optional"), "handoff_goal_todo must not expose append_goal_room in its public parameter schema");
assert(source.includes("append_goal_room=false is not allowed for live TODO handoff"), "legacy append_goal_room=false must be hard-blocked before live delivery");

const handoffStart = source.indexOf("async function handoffGoalTodos");
assert(handoffStart >= 0, "handoffGoalTodos implementation must exist");
const handoffBody = source.slice(handoffStart, source.indexOf("function goalTodoStatusIcon", handoffStart));

const appendIndex = handoffBody.indexOf("appendGoalRoomMessage(repoRoot");
const queuedIndex = handoffBody.indexOf('status: "queued"');
const deliveryIndex = handoffBody.indexOf("await deliverHandoffLive");
assert(appendIndex >= 0, "handoff must append canonical Goal Room metadata");
assert(queuedIndex >= 0, "handoff must prepare TODO delegation tracking");
assert(deliveryIndex >= 0, "handoff must perform live delivery");
assert(appendIndex < deliveryIndex, "canonical Goal Room metadata must be recorded before live delivery");
assert(queuedIndex < deliveryIndex, "TODO delegation tracking must be prepared before live delivery");

assert(handoffBody.includes("canonicalGoalRoomPrepared: true"), "Goal Room handoff metadata must declare canonical preparation");
assert(handoffBody.includes("liveDeliveryRequired: true"), "handoff metadata must declare live delivery requirement");
assert(handoffBody.includes('status: "failed"'), "handoff must mark TODO delegation failed if live delivery fails after preparation");
assert(handoffBody.includes("failureHash"), "handoff failure telemetry must be hash-only");
assert(!handoffBody.includes("deliveryPreparedOnly: true"), "handoff must not leave prepared-only success semantics");
assert(!handoffBody.includes("custom_message,"), "raw custom_message must not be persisted in handoff metadata");

console.log("goal-todo handoff static smoke PASS");
