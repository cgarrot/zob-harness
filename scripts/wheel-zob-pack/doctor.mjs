#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { validateWheelModelRegistry } from "../../packages/wheel-zob-pack/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ciMode = process.argv.includes("--ci");
const interactiveMode = process.argv.includes("--interactive");
const providerToolsMode = process.argv.includes("--providers");
const checks = [];

function record(name, passed, detail, required = true) {
  checks.push({ name, passed, required, detail });
}

function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    available: result.status === 0,
    version: result.status === 0 ? String(result.stdout || result.stderr).trim().split(/\r?\n/)[0] : undefined,
  };
}

function versionAtLeast(actual, minimum) {
  const parts = String(actual).replace(/^v/, "").split(".").map((value) => Number.parseInt(value, 10));
  const floor = minimum.split(".").map((value) => Number.parseInt(value, 10));
  for (let index = 0; index < Math.max(parts.length, floor.length); index += 1) {
    const left = Number.isFinite(parts[index]) ? parts[index] : 0;
    const right = Number.isFinite(floor[index]) ? floor[index] : 0;
    if (left !== right) return left > right;
  }
  return true;
}

record("node", versionAtLeast(process.versions.node, "22.19.0"), `found=${process.versions.node}; required=>=22.19.0`);

for (const path of [
  ".pi/extensions/zob-harness/index.ts",
  ".pi/extensions/wheel-zob-pack/index.ts",
  "packages/wheel-zob-pack/extension.ts",
  "packages/wheel-zob-pack/model-policy/model-registry.ts",
  "tools/wheel-zob/cli.ts",
]) {
  record(`file:${path}`, existsSync(resolve(repoRoot, path)), path);
}

const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const piExtensions = Array.isArray(packageJson.pi?.extensions) ? packageJson.pi.extensions : [];
record("pi-extension-manifest", piExtensions.includes(".pi/extensions/wheel-zob-pack/index.ts"), "package.json pi.extensions includes Wheel bridge");

const registry = validateWheelModelRegistry();
record("model-registry", registry.valid, `routes=${registry.routeCount}; pools=${registry.randomizedPoolCount}; min_pool=${registry.minimumPoolSize}`);

if (interactiveMode) {
  const piBin = process.env.WHEEL_ZOB_PI_BIN;
  if (!piBin) {
    record("interactive-pi", false, "set WHEEL_ZOB_PI_BIN to the absolute global Pi 0.80.7+ executable path");
  } else if (!isAbsolute(piBin) || resolve(piBin).startsWith(`${repoRoot}/`)) {
    record("interactive-pi", false, "WHEEL_ZOB_PI_BIN must be an absolute executable path outside the repository checkout");
  } else {
    const pi = commandVersion(piBin);
    record("interactive-pi", pi.available && versionAtLeast(pi.version, "0.80.7"), pi.available ? `found=${pi.version}; required=>=0.80.7; absolute_external_path=true` : `unavailable=${piBin}`);
  }
}

if (providerToolsMode) {
  const fireconnectBin = process.env.WHEEL_ZOB_FIRECONNECT_BIN;
  if (!fireconnectBin || !isAbsolute(fireconnectBin)) {
    record("fireconnect-cli", false, "set WHEEL_ZOB_FIRECONNECT_BIN to an absolute Fireconnect v0.8.0+ executable path");
  } else {
    const fireconnect = commandVersion(fireconnectBin);
    record("fireconnect-cli", fireconnect.available && versionAtLeast(fireconnect.version, "0.8.0"), fireconnect.available ? `found=${fireconnect.version}; required=>=0.8.0; absolute_path=true` : `unavailable=${fireconnectBin}`);
  }
}

const failures = checks.filter((check) => check.required && !check.passed);
const report = {
  schema: "wheel.zob.machine-doctor.v1",
  mode: ciMode ? "ci" : interactiveMode ? "interactive-operator" : "source",
  providerToolsChecked: providerToolsMode,
  valid: failures.length === 0,
  checks,
  scope: "local source, manifest, registry, and explicitly requested CLI presence only",
  externalEffectsEnabled: false,
  bodyStored: false,
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.valid ? 0 : 1;
