import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import {
  FULL_READ_DEFAULT_IO,
  FULL_READ_DEFAULT_POLICY,
  type FullReadIo,
} from "../../.pi/extensions/zob-harness/src/domains/files/full-read.ts";
import {
  DEFAULT_RUN_ARTIFACT,
  RESPONSE_RECEIVE_SCHEMA,
  RUN_ARTIFACT_DIRS,
  isPathSafeArtifactName,
  isPathSafeRunId,
  receiveFullResponse,
  responseReceiveBodyFreeViolations,
  runDirRelative,
  type ResponseReceiveDetails,
} from "../../.pi/extensions/zob-harness/src/domains/files/response-receive.ts";

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * In-memory IO keyed by the absolute resolved path so stat lookups match
 * runFullRead's resolve(). Files only — no directories/symlinks — so this is
 * suitable for `path` source tests, not `run` source tests.
 */
function makeIo(cwd: string, entries: Record<string, string>): FullReadIo {
  const store = new Map<string, string>();
  for (const [key, value] of Object.entries(entries)) {
    store.set(resolve(cwd, key), value);
  }

  const failEnoent = (path: string): never => {
    const error = new Error(`ENOENT: ${path}`);
    (error as NodeJS.ErrnoException).code = "ENOENT";
    throw error;
  };

  return {
    stat(path: string) {
      if (!store.has(path)) failEnoent(path);
      const content = store.get(path) as string;
      return { size: Buffer.byteLength(content), isFile: () => true, isDirectory: () => false };
    },
    accessReadable(path: string) {
      if (!store.has(path)) failEnoent(path);
    },
    readFile(path: string) {
      if (!store.has(path)) failEnoent(path);
      return store.get(path) as string;
    },
    realpath(path: string): string {
      return path;
    },
  };
}

// Real-filesystem temp repo roots for run_id tests (need directory stat).
const tempRoots: string[] = [];

function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "zob-response-receive-"));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; ignore
    }
  }
});

test("path source PASS: small file within headroom returns content", () => {
  const cwd = "/repo";
  const body = "x".repeat(2048);
  const result = receiveFullResponse({
    cwd,
    path: "file.txt",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "file.txt": body }),
    estimateTokens,
  });

  assert.equal(result.decision, "pass");
  assert.equal(typeof result.content, "string");
  assert.equal(result.content, body);
  assert.equal(result.details.source, "path");
  assert.equal(result.details.schema, RESPONSE_RECEIVE_SCHEMA);
  assert.equal(result.details.bodyStored, false);
  assert.equal(result.details.runType, undefined);
  assert.equal(result.details.runId, undefined);
  assert.equal(result.details.artifact, undefined);
});

test("path source BLOCK: tiny headroom refuses with pagination guidance", () => {
  const cwd = "/repo";
  const result = receiveFullResponse({
    cwd,
    path: "file.txt",
    usage: { tokens: 199000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "file.txt": "y".repeat(4000) }),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "exceeds_context_budget");
  assert.equal(result.content, undefined);
  assert.equal(result.details.source, "path");
});

test("path source secret: path .env reuses runFullRead path_secret_rejected", () => {
  const cwd = "/repo";
  const result = receiveFullResponse({
    cwd,
    path: ".env",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, {}),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "path_secret_rejected");
  assert.equal(result.content, undefined);
  assert.equal(result.details.byteSize, 0);
});

test("run source PASS (orchestration): resolves final-report.md and returns content", () => {
  const repo = makeTempRepo();
  const runId = "run-001";
  const dir = join(repo, RUN_ARTIFACT_DIRS.orchestration, runId);
  mkdirSync(dir, { recursive: true });
  const body = "# Report\nsmall content\n";
  writeFileSync(join(dir, DEFAULT_RUN_ARTIFACT), body);

  const result = receiveFullResponse({
    cwd: repo,
    runId,
    runType: "orchestration",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "pass");
  assert.equal(result.content, body);
  assert.equal(result.details.source, "run");
  assert.equal(result.details.runType, "orchestration");
  assert.equal(result.details.runId, runId);
  assert.equal(result.details.artifact, DEFAULT_RUN_ARTIFACT);
  assert.equal(result.details.schema, RESPONSE_RECEIVE_SCHEMA);
  assert.equal(result.details.bodyStored, false);
});

test("run source PASS with explicit artifact (factory)", () => {
  const repo = makeTempRepo();
  const runId = "run-002";
  const dir = join(repo, RUN_ARTIFACT_DIRS.factory, runId);
  mkdirSync(dir, { recursive: true });
  const body = '{"ok":true}\n';
  const artifact = "agentic-results.json";
  writeFileSync(join(dir, artifact), body);

  const result = receiveFullResponse({
    cwd: repo,
    runId,
    runType: "factory",
    artifact,
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "pass");
  assert.equal(result.content, body);
  assert.equal(result.details.source, "run");
  assert.equal(result.details.runType, "factory");
  assert.equal(result.details.runId, runId);
  assert.equal(result.details.artifact, artifact);
});

test("run source PASS auto-detect runType (chain)", () => {
  const repo = makeTempRepo();
  const runId = "run-003";
  const dir = join(repo, RUN_ARTIFACT_DIRS.chain, runId);
  mkdirSync(dir, { recursive: true });
  const body = "chain report\n";
  writeFileSync(join(dir, DEFAULT_RUN_ARTIFACT), body);

  const result = receiveFullResponse({
    cwd: repo,
    runId,
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "pass");
  assert.equal(result.content, body);
  assert.equal(result.details.source, "run");
  assert.equal(result.details.runType, "chain");
  assert.equal(result.details.runId, runId);
  assert.equal(result.details.artifact, DEFAULT_RUN_ARTIFACT);
});

test("run source BLOCK on budget: large final-report.md + tiny headroom", () => {
  const repo = makeTempRepo();
  const runId = "run-004";
  const dir = join(repo, RUN_ARTIFACT_DIRS.orchestration, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, DEFAULT_RUN_ARTIFACT), "z".repeat(4000));

  const result = receiveFullResponse({
    cwd: repo,
    runId,
    runType: "orchestration",
    usage: { tokens: 199000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "exceeds_context_budget");
  assert.equal(result.content, undefined);
  assert.equal(result.details.source, "run");
  assert.equal(result.details.runType, "orchestration");
  assert.equal(result.details.runId, runId);
});

test("run_id_unsafe: traversal runId is rejected before resolution", () => {
  const repo = makeTempRepo();
  const result = receiveFullResponse({
    cwd: repo,
    runId: "../escape",
    runType: "factory",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "run_id_unsafe");
  assert.equal(result.content, undefined);
});

test("run_id_unsafe: runId with slash is rejected", () => {
  const repo = makeTempRepo();
  const result = receiveFullResponse({
    cwd: repo,
    runId: "a/b",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "run_id_unsafe");
  assert.equal(result.content, undefined);
});

test("artifact_unsafe: traversal artifact is rejected", () => {
  const repo = makeTempRepo();
  const result = receiveFullResponse({
    cwd: repo,
    runId: "run-005",
    runType: "factory",
    artifact: "../../etc/passwd",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "artifact_unsafe");
  assert.equal(result.content, undefined);
});

test("artifact_unsafe: artifact with slash is rejected", () => {
  const repo = makeTempRepo();
  const result = receiveFullResponse({
    cwd: repo,
    runId: "run-006",
    artifact: "a/b",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "artifact_unsafe");
  assert.equal(result.content, undefined);
});

test("run_not_found: valid runId with no dir is rejected", () => {
  const repo = makeTempRepo();
  const result = receiveFullResponse({
    cwd: repo,
    runId: "missing-run",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "run_not_found");
  assert.equal(result.content, undefined);
  assert.equal(result.details.source, "run");
  assert.equal(result.details.runId, "missing-run");
});

test("artifact_not_found: run dir exists but default artifact absent", () => {
  const repo = makeTempRepo();
  const runId = "run-007";
  const dir = join(repo, RUN_ARTIFACT_DIRS.factory, runId);
  mkdirSync(dir, { recursive: true });
  // Write a non-default file so the run dir exists but final-report.md is absent.
  writeFileSync(join(dir, "other.txt"), "x");

  const result = receiveFullResponse({
    cwd: repo,
    runId,
    runType: "factory",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "artifact_not_found");
  assert.equal(result.content, undefined);
  assert.equal(result.details.runType, "factory");
  assert.equal(result.details.runId, runId);
});

test("ambiguous_source: both path and runId set is rejected", () => {
  const result = receiveFullResponse({
    cwd: "/repo",
    path: "file.txt",
    runId: "run-008",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo("/repo", {}),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "ambiguous_source");
  assert.equal(result.content, undefined);
});

test("source_required: neither path nor runId set is rejected", () => {
  const result = receiveFullResponse({
    cwd: "/repo",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo("/repo", {}),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "source_required");
  assert.equal(result.content, undefined);
});

test("BODY-FREE: pass details yield no body-like violations", () => {
  const cwd = "/repo";
  const result = receiveFullResponse({
    cwd,
    path: "file.txt",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "file.txt": "x".repeat(2048) }),
    estimateTokens,
  });

  assert.equal(result.decision, "pass");
  assert.deepEqual(responseReceiveBodyFreeViolations(result.details), []);
  assert.equal("content" in result.details, false);
  assert.equal("text" in result.details, false);
  assert.equal("body" in result.details, false);
});

test("BODY-FREE: error details yield no body-like violations", () => {
  const repo = makeTempRepo();
  const result = receiveFullResponse({
    cwd: repo,
    runId: "missing-run",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "run_not_found");
  const details: ResponseReceiveDetails = result.details;
  assert.deepEqual(responseReceiveBodyFreeViolations(details), []);
  assert.equal("content" in details, false);
  assert.equal("text" in details, false);
  assert.equal("body" in details, false);
});

test("BODY-FREE: responseReceiveBodyFreeViolations flags body-like fields", () => {
  assert.deepEqual(responseReceiveBodyFreeViolations({ content: "x" }), ["$.content"]);
  // Violation paths report the original field key.
  assert.deepEqual(responseReceiveBodyFreeViolations({ rawPrompt: "x" }), ["$.rawPrompt"]);
  // Hash-bearing and bodystored fields are explicitly allowed.
  assert.deepEqual(responseReceiveBodyFreeViolations({ pathHash: "abc", bodyStored: false }), []);
});

test("isPathSafeRunId: positive and negative cases", () => {
  assert.equal(isPathSafeRunId("run-001"), true);
  assert.equal(isPathSafeRunId("abc_def.123"), true);
  assert.equal(isPathSafeRunId("../escape"), false);
  assert.equal(isPathSafeRunId("a/b"), false);
  assert.equal(isPathSafeRunId("."), false);
  assert.equal(isPathSafeRunId(".."), false);
  assert.equal(isPathSafeRunId(""), false);
});

test("isPathSafeArtifactName: positive and negative cases", () => {
  assert.equal(isPathSafeArtifactName("final-report.md"), true);
  assert.equal(isPathSafeArtifactName("agentic-results.json"), true);
  assert.equal(isPathSafeArtifactName("../../etc/passwd"), false);
  assert.equal(isPathSafeArtifactName("a/b"), false);
  assert.equal(isPathSafeArtifactName("a\\b"), false);
  assert.equal(isPathSafeArtifactName(".."), false);
  assert.equal(isPathSafeArtifactName(""), false);
});

test("runDirRelative: pure composition of artifact dir + runId", () => {
  assert.equal(runDirRelative("factory", "run-1"), "reports/factory-runs/run-1");
  assert.equal(runDirRelative("orchestration", "run-1"), "reports/orchestrations/run-1");
  assert.equal(runDirRelative("chain", "run-1"), "reports/chains/run-1");
});
