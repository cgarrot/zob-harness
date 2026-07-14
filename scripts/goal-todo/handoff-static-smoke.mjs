#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = process.cwd();

// Reads the source-text "surface" for a module: the file at `path` plus, when a
// move-only refactor split that file into a sibling directory named after it
// (minus the `.ts`/`.mjs` extension), every `*.ts`/`*.mjs` file under that
// directory, concatenated recursively. This widens only WHERE guard text is
// read from (barrel + submodules) without changing any assertion. For files
// without such a sibling directory it returns the file content unchanged.
function readSurface(path) {
  const absPath = resolve(path);
  let text = readFileSync(absPath, "utf8");
  const siblingDir = absPath.replace(/\.(ts|mjs)$/, "");
  if (siblingDir !== absPath && existsSync(siblingDir) && statSync(siblingDir).isDirectory()) {
    const stack = [siblingDir];
    const collected = [];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) stack.push(full);
        else if (/\.(ts|mjs)$/.test(full)) collected.push(full);
      }
    }
    collected.sort();
    for (const sub of collected) text += `\n${readFileSync(sub, "utf8")}`;
  }
  return text;
}

const source = readSurface(join(repoRoot, ".pi", "extensions", "zob-harness", "src", "runtime", "goal-runtime.ts"));

assert(!source.includes("append_goal_room: Type.Optional"), "handoff_goal_todo must not expose append_goal_room in its public parameter schema");
assert(source.includes("append_goal_room=false is not allowed for live TODO handoff"), "legacy append_goal_room=false must be hard-blocked before live delivery");

const handoffStart = source.indexOf("async function executeHandoffGoalTodoEffects");
assert(handoffStart >= 0, "executeHandoffGoalTodoEffects implementation must exist");
const handoffSurfaceStart = source.lastIndexOf("function handoffGoalRoomInput", handoffStart);
assert(handoffSurfaceStart >= 0, "executeHandoffGoalTodoEffects metadata helper must exist");
const handoffMetadataEnd = source.indexOf("/** Canonicalize caller identity", handoffSurfaceStart);
assert(handoffMetadataEnd > handoffSurfaceStart && handoffMetadataEnd < handoffStart, "handoff metadata helper surface must be bounded");
const handoffEnd = source.indexOf("async function handoffGoalTodos", handoffStart);
assert(handoffEnd > handoffStart, "executeHandoffGoalTodoEffects surface must end before the compatibility wrapper");
const handoffBody = `${source.slice(handoffSurfaceStart, handoffMetadataEnd)}\n${source.slice(handoffStart, handoffEnd)}`;

const appendIndex = handoffBody.indexOf("appendGoalRoom(repoRoot");
const queuedIndex = handoffBody.indexOf('status: "queued"');
const deliveryIndex = handoffBody.indexOf("await deliverLive");
assert(appendIndex >= 0, "handoff must append canonical Goal Room metadata");
assert(queuedIndex >= 0, "handoff must prepare TODO delegation tracking");
assert(deliveryIndex >= 0, "handoff must perform live delivery");
assert(appendIndex < deliveryIndex, "canonical Goal Room metadata must be recorded before live delivery");
assert(queuedIndex < deliveryIndex, "TODO delegation tracking must be prepared before live delivery");

assert(handoffBody.includes("canonicalGoalRoomPrepared: true"), "Goal Room handoff metadata must declare canonical preparation");
assert(handoffBody.includes("liveDeliveryRequired: true"), "handoff metadata must declare live delivery requirement");
assert(handoffBody.includes("markGoalTodoDelegationFailed"), "handoff must use the dedicated failure transition if live delivery fails after preparation");
assert(handoffBody.includes("failureHash"), "handoff failure telemetry must be hash-only");
assert(!handoffBody.includes("deliveryPreparedOnly: true"), "handoff must not leave prepared-only success semantics");
assert(!handoffBody.includes("custom_message,"), "raw custom_message must not be persisted in handoff metadata");

console.log("goal-todo handoff static smoke PASS");
