import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import {
  FULL_READ_DEFAULT_IO,
  FULL_READ_DEFAULT_POLICY,
  FULL_READ_SCHEMA,
  type FullReadFacts,
  type FullReadIo,
  type FullReadPolicy,
  classifyPathForbiddenGenerated,
  classifyPathSecret,
  evaluateFullRead,
  fullReadBodyFreeViolations,
  runFullRead,
} from "../../.pi/extensions/zob-harness/src/domains/files/full-read.ts";

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** In-memory IO keyed by the absolute resolved path so stat lookups match runFullRead's resolve(). */
function makeIo(cwd: string, entries: Record<string, string>): FullReadIo {
  const store = new Map<string, string>();
  for (const [key, value] of Object.entries(entries)) store.set(resolve(cwd, key), value);

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
    // The in-memory store holds no symlinks, so realpath is the identity. This
    // exercises the canonical check wiring without touching the real filesystem;
    // the dedicated symlink test below uses FULL_READ_DEFAULT_IO instead.
    realpath(path: string): string {
      return path;
    },
  };
}

function twoKb(): string {
  return "x".repeat(2048);
}

const symlinkTempRoots: string[] = [];

after(() => {
  for (const root of symlinkTempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; ignore
    }
  }
});

test("PASS: small file within context headroom returns content", () => {
  const cwd = "/repo";
  const result = runFullRead({
    cwd,
    path: "file.txt",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "file.txt": twoKb() }),
    estimateTokens,
  });

  assert.equal(result.decision, "pass");
  assert.equal(result.reasonCode, "full_read_pass");
  assert.equal(typeof result.content, "string");
  assert.equal(result.content, twoKb());
  assert.equal(result.details.bodyStored, false);
  assert.equal(result.details.schema, FULL_READ_SCHEMA);
  assert.equal(result.details.encoding, "utf8");
  assert.equal(result.details.byteSize, 2048);
  assert.equal(result.details.lineCount, 1);
  assert.equal(result.details.estimatedTokens, 512);
  assert.equal(result.details.contextKnown, true);
  assert.equal(result.details.availableTokens, 200000 - 1000);
  assert.equal(result.details.allowedTokens, Math.floor(Math.min((200000 - 1000) * 0.7, 200000 * 0.5)));
});

test("BLOCK exceeds_context_budget: tiny headroom refuses with pagination guidance", () => {
  const cwd = "/repo";
  // 4000 chars -> 1000 estimated tokens; allowedTokens with this usage is 700.
  const bigEnough = "y".repeat(4000);
  const result = runFullRead({
    cwd,
    path: "file.txt",
    usage: { tokens: 199000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "file.txt": bigEnough }),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "exceeds_context_budget");
  assert.equal(result.content, undefined);
  assert.equal(result.details.contextKnown, true);
  // allowedTokens = max(0, min(floor(1000 * 0.7), floor(200000 * 0.5))) = 700
  assert.equal(result.details.allowedTokens, 700);
  assert.equal(result.details.availableTokens, 1000);
  assert.equal(result.details.estimatedTokens, 1000);
});

test("OBSERVE context_unknown_fallback_pass: unknown context window still returns content under hard ceiling", () => {
  const cwd = "/repo";
  const result = runFullRead({
    cwd,
    path: "file.txt",
    usage: {},
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "file.txt": twoKb() }),
    estimateTokens,
  });

  assert.equal(result.decision, "observe");
  assert.equal(result.reasonCode, "context_unknown_fallback_pass");
  assert.equal(result.content, twoKb());
  assert.equal(result.details.contextKnown, false);
  assert.equal(result.details.availableTokens, undefined);
  assert.equal(result.details.allowedTokens, undefined);
});

test("BLOCK exceeds_hard_ceiling: file larger than hard ceiling is refused without reading content", () => {
  const cwd = "/repo";
  const threeMb = "z".repeat(3 * 1024 * 1024);
  const result = runFullRead({
    cwd,
    path: "big.txt",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "big.txt": threeMb }),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "exceeds_hard_ceiling");
  assert.equal(result.content, undefined);
  assert.equal(result.details.byteSize, 3 * 1024 * 1024);
  assert.equal(result.details.hardCeilingBytes, FULL_READ_DEFAULT_POLICY.hardCeilingBytesDefault);
  assert.equal(result.details.estimatedTokens, 0);
  assert.equal(result.details.lineCount, 0);
});

test("BLOCK path_secret_rejected: secret path is refused and content is never read", () => {
  const cwd = "/repo";
  // The secret path is intentionally absent from the in-memory store, so
  // readFile would throw. runFullRead must block path_secret_rejected without
  // ever calling readFile (no throw escapes this scope).
  const result = runFullRead({
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

test("BLOCK path_secret_rejected: an existing DIRECT (non-symlink) secret keeps path_secret_rejected, not symlink_resolves_to_zero_access", () => {
  const cwd = "/repo";
  // The in-memory io has no symlinks (realpath is identity), so the canonical
  // path equals targetPath. An existing direct .env has lexical isSecret === true,
  // so it must fall through to evaluateFullRead and return path_secret_rejected —
  // NOT symlink_resolves_to_zero_access (reserved for symlinked secrets). This
  // locks the `&& !isSecret` guard on the canonical secret check.
  const result = runFullRead({
    cwd,
    path: ".env",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { ".env": "SECRET=never-read" }),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "path_secret_rejected");
  assert.notEqual(result.reasonCode, "symlink_resolves_to_zero_access");
  assert.equal(result.content, undefined);
  assert.equal(result.details.bodyStored, false);
});

test("BLOCK path_forbidden_generated: generated/vendor path is refused", () => {
  const cwd = "/repo";
  const result = runFullRead({
    cwd,
    path: "node_modules/pkg/index.js",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "node_modules/pkg/index.js": "module.exports = 1;\n" }),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "path_forbidden_generated");
  assert.equal(result.content, undefined);
});

test("BLOCK path_not_found: missing path blocks with path_not_found", () => {
  const cwd = "/repo";
  const result = runFullRead({
    cwd,
    path: "missing.txt",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, {}),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "path_not_found");
  assert.equal(result.content, undefined);
  assert.equal(result.details.byteSize, 0);
});

test("BLOCK binary_not_supported: non-utf8 encoding is refused", () => {
  const cwd = "/repo";
  const result = runFullRead({
    cwd,
    path: "file.txt",
    encoding: "base64",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "file.txt": twoKb() }),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "binary_not_supported");
  assert.equal(result.content, undefined);
});

test("PURE evaluateFullRead: pass for a hand-built facts object", () => {
  const facts: FullReadFacts = {
    pathKind: "file",
    isSecret: false,
    isForbiddenGenerated: false,
    binaryRequested: false,
    readable: true,
    byteSize: 100,
    estimatedTokens: 512,
    usage: { tokens: 1000, contextWindow: 200000 },
  };
  const evaluation = evaluateFullRead(facts, FULL_READ_DEFAULT_POLICY);
  assert.equal(evaluation.decision, "pass");
  assert.equal(evaluation.reasonCode, "full_read_pass");
  assert.equal(evaluation.contextKnown, true);
  assert.equal(typeof evaluation.availableTokens, "number");
  assert.equal(typeof evaluation.allowedTokens, "number");
});

test("PURE evaluateFullRead: block exceeds_context_budget when estimatedTokens exceed allowedTokens", () => {
  const facts: FullReadFacts = {
    pathKind: "file",
    isSecret: false,
    isForbiddenGenerated: false,
    binaryRequested: false,
    readable: true,
    byteSize: 100,
    estimatedTokens: 10_000,
    usage: { tokens: 199000, contextWindow: 200000 },
  };
  const evaluation = evaluateFullRead(facts, FULL_READ_DEFAULT_POLICY);
  assert.equal(evaluation.decision, "block");
  assert.equal(evaluation.reasonCode, "exceeds_context_budget");
  assert.equal(evaluation.allowedTokens, 700);
});

test("PURE evaluateFullRead: observe context_unknown_fallback_pass when context window unknown", () => {
  const facts: FullReadFacts = {
    pathKind: "file",
    isSecret: false,
    isForbiddenGenerated: false,
    binaryRequested: false,
    readable: true,
    byteSize: 100,
    estimatedTokens: 512,
    usage: {},
  };
  const evaluation = evaluateFullRead(facts, FULL_READ_DEFAULT_POLICY);
  assert.equal(evaluation.decision, "observe");
  assert.equal(evaluation.reasonCode, "context_unknown_fallback_pass");
  assert.equal(evaluation.contextKnown, false);
});

test("classifyPathSecret and classifyPathForbiddenGenerated match expected paths", () => {
  const policy: FullReadPolicy = FULL_READ_DEFAULT_POLICY;
  assert.equal(classifyPathSecret("/repo/.env", "/repo", policy), true);
  assert.equal(classifyPathSecret("/repo/src/file.ts", "/repo", policy), false);
  assert.equal(classifyPathForbiddenGenerated("/repo/node_modules/pkg/index.js", "/repo", policy), true);
  assert.equal(classifyPathForbiddenGenerated("/repo/src/file.ts", "/repo", policy), false);
});

test("BODY-FREE: a valid pass details object yields no body-like violations", () => {
  const cwd = "/repo";
  const result = runFullRead({
    cwd,
    path: "file.txt",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "file.txt": twoKb() }),
    estimateTokens,
  });

  assert.deepEqual(fullReadBodyFreeViolations(result.details), []);
  assert.equal("content" in result.details, false);
  assert.equal("text" in result.details, false);
  assert.equal("body" in result.details, false);
  assert.equal(result.details.bodyStored, false);
});

test("BODY-FREE: fullReadBodyFreeViolations flags body-like fields", () => {
  assert.deepEqual(fullReadBodyFreeViolations({ content: "x" }), ["$.content"]);
  // Violation paths report the original field key, while normalization is applied for matching.
  assert.deepEqual(fullReadBodyFreeViolations({ rawPrompt: "x" }), ["$.rawPrompt"]);
  // Hash-bearing and bodystored fields are explicitly allowed.
  assert.deepEqual(fullReadBodyFreeViolations({ pathHash: "abc", bodyStored: false }), []);
});

test("maxBytesOverride tightens the hard ceiling and can flip a would-be-pass into a block", () => {
  const cwd = "/repo";
  const result = runFullRead({
    cwd,
    path: "file.txt",
    maxBytesOverride: 1024,
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "file.txt": twoKb() }),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "exceeds_hard_ceiling");
  assert.equal(result.details.hardCeilingBytes, 1024);
  assert.equal(result.details.maxBytesOverride, 1024);
  assert.equal(result.content, undefined);
});

test("BLOCK symlink_resolves_to_zero_access: in-cwd symlink to a secret target is refused and never read", () => {
  // The in-memory io has no real symlink semantics, so this test exercises the
  // real filesystem FULL_READ_DEFAULT_IO. An in-cwd symlink that resolves to a
  // *.pem zero-access target must be blocked without ever returning content.
  // The link name is intentionally non-secret ("link") so the lexical isSecret
  // check is false — exercising the canonical realpath bypass detection (a
  // symlinked secret has isSecret === false but canonicalSecret === true).
  const tempRoot = mkdtempSync(join(tmpdir(), "zob-read-full-symlink-"));
  symlinkTempRoots.push(tempRoot);
  const cwd = join(tempRoot, "cwd");
  const secretDir = join(tempRoot, "secretDir");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(secretDir, { recursive: true });
  // Synthetic, harmless .pem content — NOT a real secret.
  writeFileSync(join(secretDir, "key.pem"), "PRIVATE KEY MATERIAL");
  symlinkSync(join(secretDir, "key.pem"), join(cwd, "link"));

  const result = runFullRead({
    cwd,
    path: "link",
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: FULL_READ_DEFAULT_IO,
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "symlink_resolves_to_zero_access");
  assert.equal(result.content, undefined);
  assert.equal(result.details.bodyStored, false);
});

test("maxBytesOverride cannot enlarge the ceiling above the default", () => {
  const cwd = "/repo";
  // 3MB sits strictly between the 2MB default ceiling and a huge override, so a
  // replace-style ceiling would pass it while a tighten-style ceiling blocks it.
  const threeMb = "z".repeat(3 * 1024 * 1024);
  const result = runFullRead({
    cwd,
    path: "big.txt",
    maxBytesOverride: 1_000_000_000,
    usage: { tokens: 1000, contextWindow: 200000 },
    policy: FULL_READ_DEFAULT_POLICY,
    io: makeIo(cwd, { "big.txt": threeMb }),
    estimateTokens,
  });

  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "exceeds_hard_ceiling");
  assert.equal(result.details.hardCeilingBytes, FULL_READ_DEFAULT_POLICY.hardCeilingBytesDefault);
  assert.equal(result.details.maxBytesOverride, 1_000_000_000);
  assert.equal(result.content, undefined);
});
