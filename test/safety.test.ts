import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { test } from "node:test";

import {
  parsePathListEnv,
  parseToolList,
  pathMatches,
  resolveChildCwd,
  validateAllowedPathPolicy,
  validateDelegateTaskWriteScope,
  validateDelegationWriteScope,
  validateForbiddenPathPolicy,
  validatePathPolicy,
  validateRuntimeWritePolicy,
  validateSixPartContract,
  validateToolList,
  buildChildEnv,
} from "../.pi/extensions/zob-harness/index.ts";

const REPO = "/repo";

const VALID_CONTRACT = [
  "1. TASK: implement the safety validator",
  "2. EXPECTED OUTCOME: a passing validator with tests",
  "3. REQUIRED TOOLS: read, grep",
  "4. MUST DO: restate constraints before edits",
  "5. MUST NOT DO: no secret reads",
  "6. CONTEXT: paths under test/",
].join("\n");

test("validateSixPartContract: accepts a complete, ordered contract", () => {
  assert.deepEqual(validateSixPartContract(VALID_CONTRACT), []);
});

test("validateSixPartContract: flags every missing section in an empty task", () => {
  const errors = validateSixPartContract("");
  assert.equal(errors.length, 6);
  for (const label of ["TASK", "EXPECTED OUTCOME", "REQUIRED TOOLS", "MUST DO", "MUST NOT DO", "CONTEXT"]) {
    assert.ok(
      errors.some((error) => error === `Missing contract section: ${label}`),
      `expected missing section error for ${label}`,
    );
  }
});

test("validateSixPartContract: reports a single missing section", () => {
  const withoutContext = VALID_CONTRACT.split("\n").slice(0, 5).join("\n");
  assert.deepEqual(validateSixPartContract(withoutContext), ["Missing contract section: CONTEXT"]);
});

test("validateSixPartContract: rejects placeholder/empty bodies", () => {
  const placeholder = [
    "1. TASK: [atomic goal]",
    "2. EXPECTED OUTCOME: [observable]",
    "3. REQUIRED TOOLS: [tools]",
    "4. MUST DO: [do]",
    "5. MUST NOT DO: [dont]",
    "6. CONTEXT: [ctx]",
  ].join("\n");
  const errors = validateSixPartContract(placeholder);
  assert.ok(errors.length >= 1);
  assert.ok(errors.every((error) => error.startsWith("Empty contract section:")));
});

test("validateSixPartContract: detects out-of-order sections", () => {
  const reordered = [
    "2. EXPECTED OUTCOME: a passing validator",
    "1. TASK: implement the validator",
    "3. REQUIRED TOOLS: read",
    "4. MUST DO: restate constraints",
    "5. MUST NOT DO: no secret reads",
    "6. CONTEXT: paths under test/",
  ].join("\n");
  const errors = validateSixPartContract(reordered);
  assert.ok(errors.some((error) => error.includes("out of order")), JSON.stringify(errors));
});

test("parseToolList: parses, trims and filters", () => {
  assert.equal(parseToolList(undefined), undefined);
  assert.equal(parseToolList(""), undefined);
  assert.deepEqual(parseToolList("read, write , edit"), ["read", "write", "edit"]);
  assert.deepEqual(parseToolList(" , , "), []);
});

test("validateToolList: enforces the agent allowlist", () => {
  const agent = { name: "explore", tools: ["read", "grep"] };
  assert.deepEqual(validateToolList(agent, undefined), []);
  assert.deepEqual(validateToolList(agent, []), []);
  assert.deepEqual(validateToolList(agent, ["read"]), []);

  const denied = validateToolList(agent, ["write"]);
  assert.ok(denied.some((error) => error.includes("Tool 'write' is not allowed for agent 'explore'")));

  const noAllowlist = validateToolList({ name: "locked", tools: [] }, ["read"]);
  assert.deepEqual(noAllowlist, ["Agent 'locked' has no declared tool allowlist; refusing tool override."]);

  const malformed = validateToolList(agent, ["bad name!"]);
  assert.ok(malformed.some((error) => error === "Invalid tool name 'bad name!'"));
});

test("resolveChildCwd: keeps the child inside the repo root", () => {
  assert.deepEqual(resolveChildCwd(REPO, undefined), { cwd: REPO, errors: [] });
  assert.deepEqual(resolveChildCwd(REPO, "sub/dir"), { cwd: "/repo/sub/dir", errors: [] });

  const traversal = resolveChildCwd(REPO, "../escape");
  assert.equal(traversal.errors.length, 1);
  assert.ok(traversal.errors[0].includes("Child cwd must stay inside repo root"));

  const absolute = resolveChildCwd(REPO, "/etc/passwd");
  assert.equal(absolute.errors.length, 1);

  const home = resolveChildCwd(REPO, "~");
  assert.equal(home.cwd, homedir());
  assert.equal(home.errors.length, 1);
});

test("validateAllowedPathPolicy: rejects traversal, absolute, home and broad roots", () => {
  assert.deepEqual(validateAllowedPathPolicy(["src/file.ts"], "allowed", REPO), []);
  assert.deepEqual(validateAllowedPathPolicy(undefined, "allowed", REPO), []);

  const cases: Array<[string, string]> = [
    ["/etc/passwd", "absolute and home paths are not allowed"],
    ["~/secrets", "absolute and home paths are not allowed"],
    ["../escape", "path traversal segments are not allowed anywhere in allowed_paths"],
    ["a/../../b", "path traversal segments are not allowed anywhere in allowed_paths"],
    [".", "broad repo roots are not allowed"],
    ["", "broad repo roots are not allowed"],
    ["with\0null", "NUL bytes are not allowed"],
  ];
  for (const [input, fragment] of cases) {
    const errors = validateAllowedPathPolicy([input], "allowed", REPO);
    assert.ok(errors.length >= 1 && errors[0].includes(fragment), `input ${JSON.stringify(input)} -> ${JSON.stringify(errors)}`);
  }
});

test("validatePathPolicy: behaves like the allowed-path policy", () => {
  assert.deepEqual(validatePathPolicy(["src/file.ts"], "allowed", REPO), []);
  assert.ok(validatePathPolicy(["../escape"], "allowed", REPO).length >= 1);
});

test("validateForbiddenPathPolicy: blocks broad deny patterns but allows scoped denies", () => {
  assert.deepEqual(validateForbiddenPathPolicy(["node_modules/"], "forbidden", REPO), []);
  assert.deepEqual(validateForbiddenPathPolicy(["/absolute/deny"], "forbidden", REPO), []);

  for (const broad of ["*", "**", "/", "~", ""]) {
    const errors = validateForbiddenPathPolicy([broad], "forbidden", REPO);
    assert.ok(errors.some((error) => error.includes("too broad for a deny-only pattern")), `broad ${JSON.stringify(broad)}`);
  }

  const escaping = validateForbiddenPathPolicy(["../outside"], "forbidden", REPO);
  assert.ok(escaping.some((error) => error.includes("must stay inside repo root")));

  const nul = validateForbiddenPathPolicy(["bad\0path"], "forbidden", REPO);
  assert.ok(nul.some((error) => error.includes("contains a NUL byte")));
});

test("pathMatches: matches directory prefixes and wildcard patterns", () => {
  assert.equal(pathMatches("src/a.ts", "src/", REPO), true);
  assert.equal(pathMatches("docs/a.ts", "src/", REPO), false);
  assert.equal(pathMatches("/repo/src/a.ts", "*.ts", REPO), true);
  assert.equal(pathMatches(".env", ".env", REPO), true);
  assert.equal(pathMatches("src/a.ts", "lib/", REPO), false);
});

test("parsePathListEnv: splits on commas, colons and newlines", () => {
  assert.deepEqual(parsePathListEnv(undefined), []);
  assert.deepEqual(parsePathListEnv(""), []);
  assert.deepEqual(parsePathListEnv("a, b:c\nd"), ["a", "b", "c", "d"]);
});

test("validateDelegationWriteScope: write/edit tools require allowed_paths", () => {
  assert.ok(validateDelegationWriteScope("delegate_agent", ["write"], undefined).length === 1);
  assert.ok(validateDelegationWriteScope("delegate_agent", ["edit"], []).length === 1);
  assert.deepEqual(validateDelegationWriteScope("delegate_agent", ["read"], undefined), []);
  assert.deepEqual(validateDelegationWriteScope("delegate_agent", ["write"], ["src/"]), []);

  const taskScoped = validateDelegateTaskWriteScope(["write"], undefined);
  assert.equal(taskScoped.length, 1);
  assert.ok(taskScoped[0].startsWith("delegate_task"));
});

test("validateRuntimeWritePolicy: enforces forbidden, allowed, zero-access and sandbox bounds", () => {
  assert.deepEqual(
    validateRuntimeWritePolicy({ targetPath: "src/a.ts", cwd: REPO, allowedPaths: ["src/"] }),
    { allowed: true, violations: [] },
  );

  const forbidden = validateRuntimeWritePolicy({ targetPath: "src/a.ts", cwd: REPO, forbiddenPaths: ["src/"] });
  assert.equal(forbidden.allowed, false);
  assert.ok(forbidden.violations.some((violation) => violation.includes("forbidden path")));

  const outside = validateRuntimeWritePolicy({ targetPath: "out/a.ts", cwd: REPO, allowedPaths: ["src/"] });
  assert.equal(outside.allowed, false);
  assert.ok(outside.violations.some((violation) => violation.includes("outside allowed_paths")));

  const zero = validateRuntimeWritePolicy({ targetPath: ".env", cwd: REPO, zeroAccessPaths: [".env"] });
  assert.equal(zero.allowed, false);
  assert.ok(zero.violations.some((violation) => violation.includes("zero-access path")));

  const sandbox = validateRuntimeWritePolicy({ targetPath: "../escape.ts", cwd: REPO, sandboxRoot: ".pi/tmp/sb" });
  assert.equal(sandbox.allowed, false);
  assert.ok(sandbox.violations.some((violation) => violation.includes("outside sandbox root")));
});

test("buildChildEnv: drops un-allowlisted env vars and sets the harness root", () => {
  const marker = "ZOB_TEST_SHOULD_BE_DROPPED";
  process.env[marker] = "secret";
  try {
    const env = buildChildEnv(REPO, { allowedPaths: ["src/"], forbiddenPaths: ["secrets/"], sandboxRoot: ".pi/tmp/sb" });
    assert.equal(env.ZOB_HARNESS_ROOT, REPO);
    assert.equal(env.ZOB_ALLOWED_PATHS, "src/");
    assert.equal(env.ZOB_FORBIDDEN_PATHS, "secrets/");
    assert.equal(env.ZOB_SANDBOX_ROOT, ".pi/tmp/sb");
    assert.equal(env[marker], undefined);
  } finally {
    delete process.env[marker];
  }
});
