import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  createFileToolPreflightRuntimeState,
  FILE_TOOL_PREFLIGHT_REASON_CODES,
  type FileToolPreflightIo,
  type FileToolPreflightLedgerEntry,
  fileToolPreflightBodyLikeFieldViolations,
  persistFileToolPreflightDecision,
  preflightFileToolCall,
  validateFileToolPreflightDecision,
  validateFileToolPreflightLedgerEntry,
} from "../.pi/extensions/zob-harness/index.ts";
import { registerHarnessEvents } from "../.pi/extensions/zob-harness/src/runtime/events.ts";
import { createHarnessRuntimeState } from "../.pi/extensions/zob-harness/src/runtime/state.ts";

const SECRET = "synthetic-old-and-new-text-never-persist";
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zob-file-preflight-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface RuntimeEventResult {
  block?: boolean;
  reason?: string;
  systemPrompt?: string;
}

type EventHandler = (event: unknown, context: unknown) => Promise<unknown>;

function runtimeHarness(input: { cwd: string; appendThrows?: boolean; mode?: "explore" | "implement"; zeroAccessPaths?: string[]; readOnlyPaths?: string[] }): {
  call(toolName: string, toolInput: Record<string, unknown>): Promise<RuntimeEventResult | undefined>;
  beforeAgentStart(): Promise<RuntimeEventResult>;
  entries: Array<{ customType: string; data: Record<string, unknown> }>;
} {
  const handlers = new Map<string, EventHandler>();
  const entries: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const state = createHarnessRuntimeState();
  state.activeMode = input.mode ?? "implement";
  state.currentRules = {
    bashToolPatterns: [],
    zeroAccessPaths: input.zeroAccessPaths ?? [],
    readOnlyPaths: input.readOnlyPaths ?? [],
    noDeletePaths: [],
  };
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (eventName: string, handler: EventHandler) => handlers.set(eventName, handler),
    appendEntry: (customType: string, data: Record<string, unknown>) => {
      if (input.appendThrows) throw new Error("synthetic telemetry outage");
      entries.push({ customType, data });
    },
  };
  registerHarnessEvents(pi as never, state);
  const context = {
    cwd: input.cwd,
    hasUI: true,
    ui: {
      confirm: async () => false,
      notify: () => undefined,
    },
  };
  return {
    entries,
    call: async (toolName, toolInput) => {
      const handler = handlers.get("tool_call");
      assert.ok(handler);
      return (await handler({ toolName, input: toolInput }, context)) as RuntimeEventResult | undefined;
    },
    beforeAgentStart: async () => {
      const handler = handlers.get("before_agent_start");
      assert.ok(handler);
      return (await handler({ systemPrompt: "base", prompt: "request" }, context)) as RuntimeEventResult;
    },
  };
}

function assertBlock(result: RuntimeEventResult | undefined, reasonCode: string): void {
  assert.ok(result);
  assert.equal(result.block, true);
  assert.match(String(result.reason), new RegExp(`reason_code=${reasonCode}`));
  assert.match(String(result.reason), /execution_performed=false/);
  assert.match(String(result.reason), /path_hash=[a-f0-9]{64}/);
  assert.match(String(result.reason), /input_hash=[a-f0-9]{64}/);
  assert.match(String(result.reason), /snapshot_hash=[a-f0-9]{64}/);
  assert.doesNotMatch(String(result.reason), new RegExp(SECRET));
}

test("pure preflight accepts valid native read, grep, find, and exact unique multi-edit calls", () => {
  const root = tempRoot();
  const file = join(root, "sample.ts");
  const directory = join(root, "src");
  writeFileSync(file, "const first = 1;\nconst second = 2;\n");
  mkdirSync(directory);

  const decisions = [
    preflightFileToolCall({ toolName: "read", cwd: root, input: { path: file } }),
    preflightFileToolCall({ toolName: "grep", cwd: root, input: { pattern: "const first", path: root, literal: true } }),
    preflightFileToolCall({ toolName: "find", cwd: root, input: { pattern: "*.ts", path: root } }),
    preflightFileToolCall({
      toolName: "edit",
      cwd: root,
      input: {
        path: file,
        edits: [
          { oldText: "const first = 1;", newText: "const first = 3;" },
          { oldText: "const second = 2;", newText: "const second = first;" },
        ],
      },
    }),
  ];

  assert.deepEqual(
    decisions.map((item) => item.verdict),
    ["pass", "pass", "pass", "pass"],
  );
  for (const item of decisions) {
    assert.deepEqual(validateFileToolPreflightDecision(item), []);
    assert.equal(item.bodyStored, false);
  }
  assert.equal(readFileSync(file, "utf8"), "const first = 1;\nconst second = 2;\n", "preflight must not edit the file");
});

test("path checks deterministically block missing roots and wrong native root types", () => {
  const root = tempRoot();
  const file = join(root, "file.txt");
  const directory = join(root, "directory");
  writeFileSync(file, "text");
  mkdirSync(directory);

  const cases = [
    preflightFileToolCall({ toolName: "read", cwd: root, input: { path: join(root, "missing.txt") } }),
    preflightFileToolCall({ toolName: "grep", cwd: root, input: { pattern: "x", path: join(root, "missing-root") } }),
    preflightFileToolCall({ toolName: "find", cwd: root, input: { pattern: "*", path: join(root, "missing-root") } }),
    preflightFileToolCall({ toolName: "read", cwd: root, input: { path: directory } }),
    preflightFileToolCall({ toolName: "edit", cwd: root, input: { path: directory, edits: [{ oldText: "x", newText: "y" }] } }),
    preflightFileToolCall({ toolName: "find", cwd: root, input: { pattern: "*", path: file } }),
  ];

  assert.deepEqual(
    cases.map((item) => item.reasonCode),
    ["path_not_found", "path_not_found", "path_not_found", "path_not_file", "path_not_file", "path_not_directory"],
  );
  assert.ok(cases.every((item) => item.verdict === "block"));
});

test("readability is checked before content and failures never call the read adapter", () => {
  let reads = 0;
  const io: FileToolPreflightIo = {
    stat: () => ({ size: 4, mtimeMs: 1, mode: 0, isFile: () => true, isDirectory: () => false }),
    accessReadable: () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
    readFile: () => {
      reads += 1;
      return Buffer.from("body");
    },
  };
  const result = preflightFileToolCall({ toolName: "read", cwd: "/repo", input: { path: "blocked.txt", offset: 2 } }, io);
  assert.equal(result.reasonCode, "path_not_readable");
  assert.equal(result.verdict, "block");
  assert.equal(reads, 0);
});

test("grep blocks invalid regex only when literal is false and observes root/glob mismatch", () => {
  const root = tempRoot();
  mkdirSync(join(root, "src"));

  const invalid = preflightFileToolCall({ toolName: "grep", cwd: root, input: { pattern: "[", path: root } });
  const literal = preflightFileToolCall({ toolName: "grep", cwd: root, input: { pattern: "[", path: root, literal: true } });
  const mismatch = preflightFileToolCall({ toolName: "grep", cwd: root, input: { pattern: "x", path: "src", glob: "src/**/*.ts" } });

  assert.equal(invalid.reasonCode, "invalid_regex");
  assert.equal(invalid.verdict, "block");
  assert.equal(literal.verdict, "pass");
  assert.equal(mismatch.reasonCode, "grep_root_glob_mismatch");
  assert.equal(mismatch.verdict, "observe");
});

test("read offsets distinguish deterministic text EOF from binary, empty, and large observations", () => {
  const root = tempRoot();
  const text = join(root, "text.txt");
  const binary = join(root, "binary.bin");
  const empty = join(root, "empty.txt");
  const large = join(root, "large.txt");
  writeFileSync(text, "one\ntwo");
  writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  writeFileSync(empty, "");
  writeFileSync(large, `${"line\n".repeat(10_000)}tail`);

  assert.equal(preflightFileToolCall({ toolName: "read", cwd: root, input: { path: text, offset: 2 } }).verdict, "pass");
  const beyond = preflightFileToolCall({ toolName: "read", cwd: root, input: { path: text, offset: 3 } });
  assert.equal(beyond.reasonCode, "offset_beyond_eof");
  assert.equal(beyond.lineCount, 2);
  assert.equal(beyond.verdict, "block");

  const binaryOffset = preflightFileToolCall({ toolName: "read", cwd: root, input: { path: binary, offset: 99 } });
  assert.equal(binaryOffset.reasonCode, "binary_offset_observed");
  assert.equal(binaryOffset.verdict, "observe");

  assert.equal(preflightFileToolCall({ toolName: "read", cwd: root, input: { path: empty, offset: 1 } }).verdict, "pass");
  const emptyBeyond = preflightFileToolCall({ toolName: "read", cwd: root, input: { path: empty, offset: 2 } });
  assert.equal(emptyBeyond.reasonCode, "offset_beyond_eof");
  assert.equal(emptyBeyond.lineCount, 0);

  const largeOffset = preflightFileToolCall({ toolName: "read", cwd: root, input: { path: large, offset: 10_000 } });
  assert.equal(largeOffset.reasonCode, "large_offset_observed");
  assert.equal(largeOffset.verdict, "observe");
});

test("edit oldText must be nonempty and occur exactly once without fuzzy selection", () => {
  const root = tempRoot();
  const file = join(root, "edit.txt");
  writeFileSync(file, "alpha\nbeta\nalpha\n");

  const empty = preflightFileToolCall({ toolName: "edit", cwd: root, input: { path: file, edits: [{ oldText: "", newText: "x" }] } });
  const zero = preflightFileToolCall({ toolName: "edit", cwd: root, input: { path: file, edits: [{ oldText: "gamma", newText: "x" }] } });
  const one = preflightFileToolCall({ toolName: "edit", cwd: root, input: { path: file, edits: [{ oldText: "beta", newText: "x" }] } });
  const many = preflightFileToolCall({ toolName: "edit", cwd: root, input: { path: file, edits: [{ oldText: "alpha", newText: "x" }] } });

  assert.deepEqual([empty.reasonCode, zero.reasonCode, one.reasonCode, many.reasonCode], ["old_text_empty", "old_text_not_found", "file_tool_preflight_pass", "old_text_not_unique"]);
  assert.deepEqual([empty.occurrenceCount, zero.occurrenceCount, one.occurrenceCount, many.occurrenceCount], [0, 0, 1, 2]);
  assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\nalpha\n");
});

test("stale edit retries get a new content snapshot and fingerprint when the file changes", () => {
  const root = tempRoot();
  const file = join(root, "stale.txt");
  const call = { toolName: "edit" as const, cwd: root, input: { path: file, edits: [{ oldText: "beta", newText: "done" }] } };
  writeFileSync(file, "alpha\n");
  const first = preflightFileToolCall(call);
  writeFileSync(file, "beta\n");
  const second = preflightFileToolCall(call);

  assert.equal(first.reasonCode, "old_text_not_found");
  assert.equal(second.verdict, "pass");
  assert.notEqual(first.snapshotHash, second.snapshotHash);
  assert.notEqual(first.fingerprintHash, second.fingerprintHash);
});

test("ambiguous concatenated path shapes are observe-only and are never split or corrected", () => {
  const root = tempRoot();
  const relative = "first.txt\nsecond.txt";
  const file = join(root, relative);
  writeFileSync(file, "body");
  const frozenInput = Object.freeze({ path: relative });
  const result = preflightFileToolCall({ toolName: "read", cwd: root, input: frozenInput });

  assert.equal(result.reasonCode, "ambiguous_concatenated_path");
  assert.equal(result.verdict, "observe");
  assert.equal(frozenInput.path, relative);
  assert.equal(readFileSync(file, "utf8"), "body");
});

test("body-free ledger validation rejects recursive raw fields and stores hashes/counts only", () => {
  const root = tempRoot();
  const file = join(root, "secret.txt");
  writeFileSync(file, "safe-content");
  const result = preflightFileToolCall({
    toolName: "edit",
    cwd: root,
    input: { path: file, edits: [{ oldText: SECRET, newText: `${SECRET}-new` }] },
  });
  const state = createFileToolPreflightRuntimeState();
  const entries: FileToolPreflightLedgerEntry[] = [];
  const recorded = persistFileToolPreflightDecision(result, state, (_customType, data) => entries.push(data));

  assert.equal(recorded.telemetryRecorded, true);
  assert.equal(entries.length, 1);
  assert.deepEqual(validateFileToolPreflightLedgerEntry(entries[0]), []);
  assert.deepEqual(fileToolPreflightBodyLikeFieldViolations(entries[0]), []);
  assert.equal(JSON.stringify(entries[0]).includes(SECRET), false);

  const unsafe = { ...entries[0], nested: { oldText: SECRET, items: [{ rawPattern: SECRET }] } };
  assert.deepEqual(fileToolPreflightBodyLikeFieldViolations(unsafe), ["$.nested.items[0].rawPattern", "$.nested.oldText"]);
  assert.ok(validateFileToolPreflightLedgerEntry(unsafe).some((error) => error.includes("forbidden body-like field")));
});

test("identical fingerprint plus snapshot retries deduplicate ledger writes and count unchanged retries", () => {
  const root = tempRoot();
  const result = preflightFileToolCall({ toolName: "read", cwd: root, input: { path: "missing.txt" } });
  const state = createFileToolPreflightRuntimeState();
  const entries: FileToolPreflightLedgerEntry[] = [];
  const append = (_customType: "zob-file-tool-preflight", data: FileToolPreflightLedgerEntry) => entries.push(data);

  const first = persistFileToolPreflightDecision(result, state, append);
  const second = persistFileToolPreflightDecision(result, state, append);
  const third = persistFileToolPreflightDecision(result, state, append);

  assert.deepEqual(first, { telemetryRecorded: true, deduplicated: false, attemptCount: 1, unchangedRetryCount: 0 });
  assert.deepEqual(second, { telemetryRecorded: true, deduplicated: true, attemptCount: 2, unchangedRetryCount: 1 });
  assert.deepEqual(third, { telemetryRecorded: true, deduplicated: true, attemptCount: 3, unchangedRetryCount: 2 });
  assert.equal(entries.length, 1);
  assert.equal(state.incidentsByFingerprint[result.fingerprintHash]?.attemptCount, 3);
});

test("runtime keeps damage-control precedence and does not preflight zero-access, read-only, or mode-blocked calls", async () => {
  const root = tempRoot();
  const eventSource = readFileSync(join(process.cwd(), ".pi/extensions/zob-harness/src/runtime/events.ts"), "utf8");
  const toolCallSource = eventSource.slice(eventSource.indexOf('pi.on("tool_call"'));
  assert.ok(toolCallSource.indexOf("if (violation)") < toolCallSource.indexOf("let fileToolPreflight"));

  const zero = runtimeHarness({ cwd: root, zeroAccessPaths: ["zero-probe"] });
  const zeroResult = await zero.call("read", { path: "zero-probe" });
  assert.equal(zeroResult.block, true);
  assert.match(zeroResult.reason, /reason_code=zero_access/);
  assert.equal(zero.entries[0]?.customType, "zob-damage-control");
  assert.equal(
    zero.entries.some((entry) => entry.customType === "zob-file-tool-preflight"),
    false,
  );

  const readOnly = runtimeHarness({ cwd: root, readOnlyPaths: ["readonly-probe"] });
  const readOnlyResult = await readOnly.call("edit", { path: "readonly-probe", edits: [{ oldText: "x", newText: "y" }] });
  assert.match(readOnlyResult.reason, /reason_code=read_only/);
  assert.equal(
    readOnly.entries.some((entry) => entry.customType === "zob-file-tool-preflight"),
    false,
  );

  const mode = runtimeHarness({ cwd: root, mode: "explore" });
  const modeResult = await mode.call("edit", { path: "missing.txt", edits: [{ oldText: "x", newText: "y" }] });
  assert.match(modeResult.reason, /reason_code=mode_blocked/);
  assert.equal(
    mode.entries.some((entry) => entry.customType === "zob-file-tool-preflight"),
    false,
  );
});

test("runtime blocks deterministic failures before native execution, deduplicates retries, and never echoes raw input", async () => {
  const root = tempRoot();
  const harness = runtimeHarness({ cwd: root });
  const first = await harness.call("read", { path: `${SECRET}-missing.txt` });
  const second = await harness.call("read", { path: `${SECRET}-missing.txt` });

  assertBlock(first, "path_not_found");
  assertBlock(second, "path_not_found");
  assert.match(second.reason, /deduplicated=true/);
  assert.match(second.reason, /unchanged_retry_count=1/);
  assert.equal(String(first.reason).includes(SECRET), false);
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0]?.customType, "zob-file-tool-preflight");
  assert.equal(JSON.stringify(harness.entries[0]).includes(SECRET), false);
});

test("preflight telemetry failure remains fail-closed and cannot allow an observe or block call", async () => {
  const root = tempRoot();
  const binary = join(root, "binary.bin");
  writeFileSync(binary, Buffer.from([0, 1, 2]));

  const deterministic = runtimeHarness({ cwd: root, appendThrows: true });
  const deterministicResult = await deterministic.call("read", { path: "missing.txt" });
  assertBlock(deterministicResult, "path_not_found");
  assert.match(deterministicResult.reason, /telemetry_recorded=false/);

  const observation = runtimeHarness({ cwd: root, appendThrows: true });
  const observationResult = await observation.call("read", { path: binary, offset: 2 });
  assertBlock(observationResult, "binary_offset_observed");
  assert.match(observationResult.reason, /restore_preflight_telemetry_then_retry/);
});

test("runtime valid calls and observe-only guidance leave native inputs unchanged", async () => {
  const root = tempRoot();
  const file = join(root, "file.txt");
  writeFileSync(file, "alpha\n");
  const harness = runtimeHarness({ cwd: root });
  const validInput = { path: file };
  const observedInput = { pattern: "alpha", path: root, glob: `${root.replace(/\\/g, "/")}/**/*.txt` };

  assert.equal(await harness.call("read", validInput), undefined);
  assert.equal(await harness.call("grep", observedInput), undefined);
  assert.deepEqual(validInput, { path: file });
  assert.equal(observedInput.path, root);
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0]?.data.verdict, "observe");
});

test("runtime prompt injects concise native file-tool guidance without shadow registration", async () => {
  const root = tempRoot();
  const harness = runtimeHarness({ cwd: root });
  const result = await harness.beforeAgentStart();
  const prompt = String(result.systemPrompt);

  assert.match(prompt, /ZOB NATIVE FILE-TOOL RELIABILITY/);
  assert.match(prompt, /context search or find before read when a path is uncertain/i);
  assert.match(prompt, /one explicit file-or-directory root/i);
  assert.match(prompt, /literal=true/);
  assert.match(prompt, /reread the current file/i);
  assert.match(prompt, /oldText that occurs exactly once/);
  assert.match(prompt, /Avoid guessed read offsets/);
  assert.match(prompt, /never rewrites inputs, retries calls, or re-registers tools/);

  const source = readFileSync(join(process.cwd(), ".pi/extensions/zob-harness/src/runtime/events.ts"), "utf8");
  assert.doesNotMatch(source, /registerTool\s*\(\s*\{[\s\S]{0,200}name:\s*["'](?:read|edit|grep|find)["']/);
});

test("preflight zero-access realpath check precedes content read for read and edit (IO spies)", () => {
  let reads = 0;
  let realpaths = 0;
  const io: FileToolPreflightIo = {
    stat: () => ({ size: 9, mtimeMs: 1, mode: 0, isFile: () => true, isDirectory: () => false }),
    accessReadable: () => undefined,
    readFile: () => {
      reads += 1;
      return Buffer.from(SECRET);
    },
    realpath: (p) => {
      realpaths += 1;
      return p === "/repo/benign-link" ? "/repo/vault/secret.env" : p;
    },
  };
  const policy = { zeroAccessPaths: ["vault/"], policyRoot: "/repo" };

  const readResult = preflightFileToolCall({ toolName: "read", cwd: "/repo", input: { path: "benign-link", offset: 1 } }, io, policy);
  assert.equal(readResult.verdict, "block");
  assert.equal(readResult.reasonCode, "symlink_resolves_to_zero_access");
  assert.deepEqual(validateFileToolPreflightDecision(readResult), []);
  assert.equal(reads, 0, "content must not be read when the link resolves to a zero-access target");
  assert.ok(realpaths >= 1);

  const editResult = preflightFileToolCall({ toolName: "edit", cwd: "/repo", input: { path: "benign-link", edits: [{ oldText: "x", newText: "y" }] } }, io, policy);
  assert.equal(editResult.reasonCode, "symlink_resolves_to_zero_access");
  assert.equal(editResult.verdict, "block");
  assert.equal(reads, 0);
});

test("preflight blocks a real benign symlink resolving to a zero-access target and records hashes only", () => {
  const root = tempRoot();
  const vaultDir = join(root, "vault");
  const secret = join(vaultDir, "secret.env");
  const link = join(root, "benign-link");
  mkdirSync(vaultDir);
  writeFileSync(secret, SECRET);
  symlinkSync(secret, link);

  const result = preflightFileToolCall(
    { toolName: "read", cwd: root, input: { path: "benign-link", offset: 1 } },
    undefined,
    { zeroAccessPaths: ["vault/"], policyRoot: root },
  );
  assert.equal(result.verdict, "block");
  assert.equal(result.reasonCode, "symlink_resolves_to_zero_access");
  assert.deepEqual(validateFileToolPreflightDecision(result), []);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("preflight zero-access precedence beats grep on a benign symlink to a protected directory", () => {
  const root = tempRoot();
  const vaultDir = join(root, "vault");
  const secret = join(vaultDir, "secret.env");
  const link = join(root, "vault-link");
  mkdirSync(vaultDir);
  writeFileSync(secret, SECRET);
  symlinkSync(vaultDir, link);

  const result = preflightFileToolCall(
    { toolName: "grep", cwd: root, input: { pattern: "x", path: "vault-link", literal: true } },
    undefined,
    { zeroAccessPaths: ["vault/"], policyRoot: root },
  );
  assert.equal(result.verdict, "block");
  assert.equal(result.reasonCode, "symlink_resolves_to_zero_access");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("preflight realpath failure fails closed without reading content", () => {
  let reads = 0;
  const io: FileToolPreflightIo = {
    stat: () => ({ size: 4, mtimeMs: 1, mode: 0, isFile: () => true, isDirectory: () => false }),
    accessReadable: () => undefined,
    readFile: () => {
      reads += 1;
      return Buffer.from("body");
    },
    realpath: () => {
      throw Object.assign(new Error("loop"), { code: "ELOOP" });
    },
  };
  const result = preflightFileToolCall(
    { toolName: "read", cwd: "/repo", input: { path: "link", offset: 1 } },
    io,
    { zeroAccessPaths: ["vault/"], policyRoot: "/repo" },
  );
  assert.equal(result.verdict, "block");
  assert.equal(result.reasonCode, "path_inspection_failed");
  assert.equal(reads, 0);
});

test("preflight fails closed on a real symlink loop before any read", () => {
  const root = tempRoot();
  const loopA = join(root, "loopA");
  const loopB = join(root, "loopB");
  symlinkSync(loopB, loopA);
  symlinkSync(loopA, loopB);

  const result = preflightFileToolCall(
    { toolName: "read", cwd: root, input: { path: "loopA", offset: 1 } },
    undefined,
    { zeroAccessPaths: ["vault/"], policyRoot: root },
  );
  assert.equal(result.verdict, "block");
  assert.equal(result.reasonCode, "path_inspection_failed");
});

test("preflight observes files above the content-read budget without reading them", () => {
  let reads = 0;
  const io: FileToolPreflightIo = {
    stat: () => ({ size: 1024, mtimeMs: 1, mode: 0, isFile: () => true, isDirectory: () => false }),
    accessReadable: () => undefined,
    readFile: () => {
      reads += 1;
      return Buffer.from("body".repeat(1000));
    },
    realpath: () => "/repo/file.txt",
  };
  const policy = { contentReadBudgetBytes: 512 };

  const readResult = preflightFileToolCall({ toolName: "read", cwd: "/repo", input: { path: "file.txt", offset: 1 } }, io, policy);
  assert.equal(readResult.verdict, "observe");
  assert.equal(readResult.reasonCode, "large_content_above_budget");
  assert.equal(readResult.byteSize, 1024);
  assert.equal(reads, 0);

  const editResult = preflightFileToolCall({ toolName: "edit", cwd: "/repo", input: { path: "file.txt", edits: [{ oldText: "x", newText: "y" }] } }, io, policy);
  assert.equal(editResult.verdict, "observe");
  assert.equal(editResult.reasonCode, "large_content_above_budget");
  assert.equal(reads, 0);
});

test("preflight reads small files within the budget and keeps deterministic offset/edit checks", () => {
  let reads = 0;
  const io: FileToolPreflightIo = {
    stat: () => ({ size: 32, mtimeMs: 1, mode: 0, isFile: () => true, isDirectory: () => false }),
    accessReadable: () => undefined,
    readFile: () => {
      reads += 1;
      return Buffer.from("alpha\nbeta\n");
    },
    realpath: () => "/repo/file.txt",
  };
  const policy = { contentReadBudgetBytes: 512 };

  const readResult = preflightFileToolCall({ toolName: "read", cwd: "/repo", input: { path: "file.txt", offset: 1 } }, io, policy);
  assert.equal(readResult.verdict, "pass");
  assert.equal(reads, 1);

  const editResult = preflightFileToolCall({ toolName: "edit", cwd: "/repo", input: { path: "file.txt", edits: [{ oldText: "beta", newText: "gamma" }] } }, io, policy);
  assert.equal(editResult.verdict, "pass");
  assert.equal(reads, 2);
});

test("runtime blocks a benign symlink resolving to a zero-access target via preflight before content read", async () => {
  const root = tempRoot();
  const vaultDir = join(root, "vault");
  const secret = join(vaultDir, "secret.env");
  const link = join(root, "benign-link");
  mkdirSync(vaultDir);
  writeFileSync(secret, SECRET);
  symlinkSync(secret, link);

  const harness = runtimeHarness({ cwd: root, zeroAccessPaths: ["vault/"] });
  const result = await harness.call("read", { path: "benign-link" });
  assert.ok(result);
  assert.equal(result.block, true);
  assert.match(String(result.reason), /reason_code=symlink_resolves_to_zero_access/);
  assert.equal(harness.entries[0]?.customType, "zob-file-tool-preflight");
  assert.equal(harness.entries[0]?.data.reasonCode, "symlink_resolves_to_zero_access");
  assert.equal(String(result.reason).includes(SECRET), false);
  assert.equal(JSON.stringify(harness.entries[0]).includes(SECRET), false);
});

test("preflight telemetry failure for a symlink zero-access block remains fail-closed", async () => {
  const root = tempRoot();
  const vaultDir = join(root, "vault");
  const secret = join(vaultDir, "secret.env");
  const link = join(root, "benign-link");
  mkdirSync(vaultDir);
  writeFileSync(secret, SECRET);
  symlinkSync(secret, link);

  const harness = runtimeHarness({ cwd: root, zeroAccessPaths: ["vault/"], appendThrows: true });
  const result = await harness.call("read", { path: "benign-link" });
  assertBlock(result, "symlink_resolves_to_zero_access");
  assert.match(String(result?.reason), /telemetry_recorded=false/);
  assert.equal(String(result?.reason).includes(SECRET), false);
});

test("reason-code surface is stable and body-free", () => {
  assert.deepEqual(FILE_TOOL_PREFLIGHT_REASON_CODES, [
    "file_tool_preflight_pass",
    "path_not_found",
    "path_not_file",
    "path_not_directory",
    "path_not_file_or_directory",
    "path_not_readable",
    "path_inspection_failed",
    "symlink_resolves_to_zero_access",
    "invalid_regex",
    "offset_beyond_eof",
    "old_text_empty",
    "old_text_not_found",
    "old_text_not_unique",
    "ambiguous_concatenated_path",
    "grep_root_glob_mismatch",
    "large_offset_observed",
    "large_content_above_budget",
    "binary_offset_observed",
  ]);
});
