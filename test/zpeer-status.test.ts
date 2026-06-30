import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  annotateZpeerStatus,
  isZpeerTerminalStatus,
  shouldAcceptZpeerStatusUpdate,
  zpeerStatusRank,
} from "../.pi/extensions/zob-harness/index.ts";

test("zpeer status reducer: terminal reply beats late waiting for the same msgId", () => {
  const waiting = { kind: "waiting", status: "waiting", at: "2026-06-29T10:53:17.840Z" };
  const reply = { kind: "reply", status: "reply", at: "2026-06-29T10:54:26.164Z" };
  const lateWaiting = { kind: "waiting", status: "waiting", at: "2026-06-29T10:55:33.069Z" };

  assert.equal(shouldAcceptZpeerStatusUpdate(undefined, waiting), true);
  assert.equal(shouldAcceptZpeerStatusUpdate(waiting, reply), true);
  assert.equal(shouldAcceptZpeerStatusUpdate(reply, lateWaiting), false);
});

test("zpeer status reducer: terminal states are explicit and ranked above waiting", () => {
  const annotated = annotateZpeerStatus({ kind: "reply", status: "reply" });

  assert.equal(isZpeerTerminalStatus("reply"), true);
  assert.equal(isZpeerTerminalStatus("waiting"), false);
  assert.equal(annotated.terminal, true);
  assert.ok(zpeerStatusRank("reply") > zpeerStatusRank("waiting"));
});

test("zpeer status reducer: non-terminal progress can advance before a terminal", () => {
  const delivered = { kind: "delivered", status: "delivered", at: "2026-06-29T10:53:17.840Z" };
  const waiting = { kind: "waiting", status: "waiting", at: "2026-06-29T10:53:18.000Z" };
  const timeout = { kind: "timeout", status: "timeout", at: "2026-06-29T10:55:17.000Z" };

  assert.equal(shouldAcceptZpeerStatusUpdate(delivered, waiting), true);
  assert.equal(shouldAcceptZpeerStatusUpdate(waiting, timeout), true);
  assert.equal(shouldAcceptZpeerStatusUpdate(timeout, delivered), false);
});
