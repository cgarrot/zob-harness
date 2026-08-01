import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  buildIsolatedChildArgs,
  createChildModelAvailabilityProbe,
  modelListHasExactModel,
  runChildModelListProbe,
} from "../.pi/extensions/zob-harness/src/domains/delegation/child-runner.ts";
import { resolveChildProviderExtension } from "../.pi/extensions/zob-harness/src/domains/models/child-provider-extension.ts";

function makeFixture(): { root: string; repoRoot: string; agentDir: string; providerRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "zob-child-provider-"));
  const repoRoot = join(root, "repo");
  const agentDir = join(root, "agent");
  const providerRoot = join(root, "pi-provider-ollama-cloud");
  mkdirSync(join(repoRoot, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(providerRoot, "src"), { recursive: true });
  writeFileSync(join(providerRoot, "package.json"), JSON.stringify({
    name: "pi-provider-ollama-cloud",
    keywords: ["pi-package", "pi-provider"],
    pi: { extensions: ["./src/index.ts"] },
  }));
  writeFileSync(join(providerRoot, "src", "index.ts"), "export default function provider() {}\n");
  return { root, repoRoot, agentDir, providerRoot };
}

test("resolveChildProviderExtension: auto-discovers an installed local provider package", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: [fixture.providerRoot] }));
    const result = resolveChildProviderExtension({
      repoRoot: fixture.repoRoot,
      agentDir: fixture.agentDir,
      provider: "ollama-cloud",
      projectTrusted: false,
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.source, realpathSync(fixture.providerRoot));
    assert.equal(result.origin, "global_settings");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resolveChildProviderExtension: ignores project package settings until trust is proven", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.repoRoot, ".pi", "settings.json"), JSON.stringify({ packages: [fixture.providerRoot] }));
    const blocked = resolveChildProviderExtension({
      repoRoot: fixture.repoRoot,
      agentDir: fixture.agentDir,
      provider: "ollama-cloud",
      projectTrusted: false,
    });
    assert.equal(blocked.source, undefined);
    assert.deepEqual(blocked.errors, []);

    const trusted = resolveChildProviderExtension({
      repoRoot: fixture.repoRoot,
      agentDir: fixture.agentDir,
      provider: "ollama-cloud",
      projectTrusted: true,
    });
    assert.equal(trusted.source, realpathSync(fixture.providerRoot));
    assert.equal(trusted.origin, "project_settings");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resolveChildProviderExtension: explicit mappings require approval and a Pi extension package", () => {
  const fixture = makeFixture();
  try {
    const mappingPath = join(fixture.agentDir, "child-provider-extensions.json");
    writeFileSync(mappingPath, JSON.stringify({ providers: { "ollama-cloud": { source: fixture.providerRoot, approved: false } } }));
    const denied = resolveChildProviderExtension({
      repoRoot: fixture.repoRoot,
      agentDir: fixture.agentDir,
      provider: "ollama-cloud",
      projectTrusted: false,
    });
    assert.equal(denied.source, undefined);
    assert.ok(denied.errors.some((error) => error.includes("not approved")));

    writeFileSync(mappingPath, JSON.stringify({ providers: { "ollama-cloud": { source: fixture.providerRoot, approved: true } } }));
    const approved = resolveChildProviderExtension({
      repoRoot: fixture.repoRoot,
      agentDir: fixture.agentDir,
      provider: "ollama-cloud",
      projectTrusted: false,
    });
    assert.equal(approved.source, realpathSync(fixture.providerRoot));
    assert.equal(approved.origin, "global_mapping");
    assert.deepEqual(approved.errors, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("buildIsolatedChildArgs: keeps isolation and loads only explicit approved extensions once", () => {
  assert.deepEqual(buildIsolatedChildArgs({}), ["--mode", "json", "-p", "--no-extensions"]);
  assert.deepEqual(buildIsolatedChildArgs({
    providerExtension: "/providers/ollama",
    codexFastModeExtension: "/extensions/codex-fast.ts",
    childSafetyExtension: "/repo/.pi/extensions/zob-child-safety/index.ts",
  }), [
    "--mode", "json", "-p", "--no-extensions",
    "-e", "/providers/ollama",
    "-e", "/extensions/codex-fast.ts",
    "-e", "/repo/.pi/extensions/zob-child-safety/index.ts",
  ]);
  assert.deepEqual(buildIsolatedChildArgs({
    providerExtension: "/same",
    childSafetyExtension: "/same",
  }), ["--mode", "json", "-p", "--no-extensions", "-e", "/same"]);
});

test("modelListHasExactModel: requires the exact provider and model id", () => {
  const listing = [
    "provider      model                   context  max-out  thinking  images",
    "ollama-cloud  deepseek-v4-flash       1.0M     32.8K    yes       no",
    "ollama-cloud  deepseek-v4-flash:0731  1.0M     32.8K    yes       no",
  ].join("\n");
  assert.equal(modelListHasExactModel(listing, "ollama-cloud/deepseek-v4-flash:0731"), true);
  assert.equal(modelListHasExactModel(listing, "ollama-cloud/deepseek-v4-flash:missing"), false);
  assert.equal(modelListHasExactModel("provider warning only", "ollama-cloud/deepseek-v4-flash:0731"), false);
  assert.equal(modelListHasExactModel(listing, "deepseek-v4-flash:0731"), true);
});

test("createChildModelAvailabilityProbe: caches successful exact matches only for the bounded TTL", async () => {
  let now = 1_000;
  let runs = 0;
  const probe = createChildModelAvailabilityProbe({
    cacheTtlMs: 60_000,
    now: () => now,
    runner: async () => {
      runs += 1;
      return { code: 0, stdout: "provider model context\nzai glm-5.2 1M", stderr: "", timedOut: false };
    },
  });
  const input = { repoRoot: "/repo", model: "zai/glm-5.2" };
  assert.deepEqual(await probe(input), { ok: true });
  assert.deepEqual(await probe(input), { ok: true });
  assert.equal(runs, 1);
  now += 60_001;
  assert.deepEqual(await probe(input), { ok: true });
  assert.equal(runs, 2);
});

test("createChildModelAvailabilityProbe: rejects fuzzy listings and timeout results", async () => {
  const fuzzy = createChildModelAvailabilityProbe({
    runner: async () => ({ code: 0, stdout: "provider model context\nzai glm-5.1 1M", stderr: "", timedOut: false }),
  });
  const missing = await fuzzy({ repoRoot: "/repo", model: "zai/glm-5.2" });
  assert.equal(missing.ok, false);
  assert.ok(missing.reason?.includes("exact model 'zai/glm-5.2' was not present"));

  const stderrDiagnostic = createChildModelAvailabilityProbe({
    runner: async () => ({
      code: 0,
      stdout: "provider model context",
      stderr: "zai glm-5.2 authentication failed",
      timedOut: false,
    }),
  });
  const diagnosticOnly = await stderrDiagnostic({ repoRoot: "/repo", model: "zai/glm-5.2" });
  assert.equal(diagnosticOnly.ok, false);
  assert.ok(diagnosticOnly.reason?.includes("exact model 'zai/glm-5.2' was not present"));

  const timeout = createChildModelAvailabilityProbe({
    runner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: true }),
  });
  assert.deepEqual(await timeout({ repoRoot: "/repo", model: "zai/glm-5.2" }), {
    ok: false,
    reason: "child model availability probe timed out",
  });
});

test("createChildModelAvailabilityProbe: one waiter abort does not cancel a shared probe", async () => {
  let runs = 0;
  let release: ((value: { code: number; stdout: string; stderr: string; timedOut: boolean }) => void) | undefined;
  const sharedRun = new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolveRun) => { release = resolveRun; });
  const probe = createChildModelAvailabilityProbe({
    runner: async () => {
      runs += 1;
      return sharedRun;
    },
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const input = { repoRoot: "/repo", model: "zai/glm-5.2" };
  const first = probe({ ...input, signal: firstController.signal });
  const second = probe({ ...input, signal: secondController.signal });
  firstController.abort();
  assert.deepEqual(await first, { ok: false, reason: "child model availability probe aborted" });
  release?.({ code: 0, stdout: "provider model context\nzai glm-5.2 1M", stderr: "", timedOut: false });
  assert.deepEqual(await second, { ok: true });
  assert.equal(runs, 1);
});

test("runChildModelListProbe: escalates SIGTERM to SIGKILL and resolves only after close", async () => {
  class FakeProbeProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly signals: NodeJS.Signals[] = [];

    kill(signal: NodeJS.Signals): boolean {
      this.signals.push(signal);
      return true;
    }
  }

  const child = new FakeProbeProcess();
  let settled = false;
  const run = runChildModelListProbe({ repoRoot: "/repo", model: "zai/glm-5.2" }, {
    timeoutMs: 5,
    killGraceMs: 5,
    spawnChild: () => child,
  }).then((result) => {
    settled = true;
    return result;
  });
  const deadline = Date.now() + 1_000;
  while (child.signals.length < 2 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(settled, false);
  child.emit("close", null);
  assert.deepEqual(await run, { code: 1, stdout: "", stderr: "", timedOut: true });
});

test("delegation prompt surfaces distinguish textual REQUIRED TOOLS from the optional JSON field", () => {
  const schemas = readFileSync(join(process.cwd(), ".pi/extensions/zob-harness/src/runtime/schemas.ts"), "utf8");
  const registration = readFileSync(join(process.cwd(), ".pi/extensions/zob-harness/src/runtime/tools-delegation/register.ts"), "utf8");
  const catalog = readFileSync(join(process.cwd(), ".pi/extensions/zob-harness/src/runtime/tools-delegation/helpers.ts"), "utf8");
  assert.ok(schemas.includes("A focused prompt without these sections is rejected."));
  assert.ok(registration.includes("The textual REQUIRED TOOLS section is mandatory"));
  assert.ok(catalog.includes("delegate_task.required_tools is a separate optional JSON narrowing field"));
});
