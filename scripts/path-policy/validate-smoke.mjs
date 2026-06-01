#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const repoRoot = process.cwd();
const srcRoot = join(repoRoot, ".pi", "extensions", "zob-harness", "src");
const outRoot = join(tmpdir(), `zob-path-policy-smoke-${process.pid}-${Date.now()}`);

function listTsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listTsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

for (const file of listTsFiles(srcRoot)) {
  const rel = relative(srcRoot, file).replace(/\.ts$/, ".js");
  const out = join(outRoot, rel);
  mkdirSync(dirname(out), { recursive: true });
  const transpiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      skipLibCheck: true,
      sourceMap: false,
    },
    fileName: file,
  });
  const outputText = transpiled.outputText.replace(
    /import \{ getAgentDir \} from "@earendil-works\/pi-coding-agent";/g,
    "const getAgentDir = () => process.cwd();",
  );
  writeFileSync(out, outputText);
}

const safety = await import(pathToFileURL(join(outRoot, "safety.js")).href);
const paths = await import(pathToFileURL(join(outRoot, "utils", "paths.js")).href);
const adaptive = await import(pathToFileURL(join(outRoot, "orchestration", "adaptive-delegation.js")).href);

const invalidAllowedPaths = ["docs/../", "docs/../src", "./docs/../", "a/../../b"];
for (const candidate of invalidAllowedPaths) {
  const errors = safety.validateAllowedPathPolicy([candidate], "allowed_paths", repoRoot);
  assert(errors.some((error) => error.includes("traversal segments")), `${candidate} should be rejected as embedded traversal; got ${JSON.stringify(errors)}`);
}

for (const candidate of ["docs/private", ".pi/extensions/zob-harness/src"]) {
  assert.deepEqual(safety.validateAllowedPathPolicy([candidate], "allowed_paths", repoRoot), [], `${candidate} should remain accepted`);
}

assert.equal(paths.pathMatches("package.json", "docs/../", repoRoot, repoRoot), true, "docs/../ still resolves to a broad root match if policy fails first");
assert(safety.validateAllowedPathPolicy(["docs/../"], "allowed_paths", repoRoot).length > 0, "policy must block trailing-slash broad-root traversal before pathMatches can grant access");

const policy = adaptive.normalizeAdaptiveDelegationPolicy({ enabled: true, mode: "advisory_only", dispatch: false, runtimeMaxDepth: 1 });
const validHash = "a".repeat(64);
const requestBase = {
  schema: "zob.delegation-request.v1",
  requesterRole: "root",
  referentRole: "worker",
  requestedAgent: "explore",
  requestedOutputContract: "explore.v1",
  requiredTools: ["read"],
  requesterDepth: 0,
  targetDepth: 1,
  ttlRequested: 1,
  evidenceRefs: ["package.json"],
  estimatedTokensIfAlone: 100,
  estimatedTokensWithDelegation: 80,
  estimatedSuccessIfAlone: 0.5,
  estimatedSuccessWithDelegation: 0.7,
  risk: "low",
  proposedTaskHash: validHash,
  proposedContextHash: validHash,
  rationaleHash: validHash,
  bodyStored: false,
  promptBodiesStored: false,
  outputBodiesStored: false,
};

const adaptiveErrors = adaptive.validateDelegationRequestHardGates({
  repoRoot,
  request: { ...requestBase, targetFileSet: ["docs/../"] },
  policy,
  rootGoalHash: validHash,
  parentTaskId: "parent",
});
assert(adaptiveErrors.some((error) => error.includes("adaptive_delegation targetFileSet") && error.includes("traversal segments")), `adaptive targetFileSet should reject embedded traversal; got ${JSON.stringify(adaptiveErrors)}`);

const adaptiveAccepted = adaptive.validateDelegationRequestHardGates({
  repoRoot,
  request: { ...requestBase, targetFileSet: [".pi/extensions/zob-harness/src"] },
  policy,
  rootGoalHash: validHash,
  parentTaskId: "parent",
});
assert(!adaptiveAccepted.some((error) => error.includes("targetFileSet")), `adaptive targetFileSet should accept scoped repo path; got ${JSON.stringify(adaptiveAccepted)}`);

console.log("path-policy smoke PASS");
