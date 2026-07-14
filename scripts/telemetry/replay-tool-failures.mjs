import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

import { replayToolFailureFixtures } from "../../.pi/extensions/zob-harness/src/domains/telemetry/tool-failures.ts";

const fixtureArguments = process.argv.slice(2);
if (fixtureArguments.length === 0) {
  console.error("explicit fixture path required");
  process.exitCode = 2;
} else {
  const repoRoot = process.cwd();
  const fixtureRoot = realpathSync(resolve(repoRoot, "test", "fixtures", "tool-failure-reliability"));
  const fixtures = fixtureArguments.map((fixtureArgument) => {
    const requestedPath = resolve(repoRoot, fixtureArgument);
    const requestedRelative = relative(fixtureRoot, requestedPath);
    if (requestedRelative === "" || requestedRelative.startsWith("..") || !requestedPath.endsWith(".json")) {
      throw new Error("fixture path must be a JSON file inside test/fixtures/tool-failure-reliability");
    }
    const fixturePath = realpathSync(requestedPath);
    const fixtureRelative = relative(fixtureRoot, fixturePath);
    if (fixtureRelative.startsWith("..") || resolve(fixtureRoot, fixtureRelative) !== fixturePath) {
      throw new Error("fixture path must be a JSON file inside test/fixtures/tool-failure-reliability");
    }
    return JSON.parse(readFileSync(fixturePath, "utf8"));
  });
  const summary = replayToolFailureFixtures(fixtures);
  console.log(JSON.stringify({
    rawAttemptCount: summary.rawAttemptCount,
    uniqueIncidentCount: summary.uniqueIncidentCount,
    unchangedStateRetryCount: summary.unchangedStateRetryCount,
  }));
}
