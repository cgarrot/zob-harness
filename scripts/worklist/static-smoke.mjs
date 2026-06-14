#!/usr/bin/env node
import { readFileSync } from "node:fs";

const files = {
  runtime: ".pi/extensions/zob-harness/src/runtime/tools-worklist.ts",
  constants: ".pi/extensions/zob-harness/src/core/constants.ts",
  schemas: ".pi/extensions/zob-harness/src/runtime/schemas.ts",
  registry: ".pi/capabilities/zob-public-runtime-capabilities.json",
  skill: ".pi/skills/zob-worklist/SKILL.md",
};

const read = (path) => readFileSync(path, "utf8");
const checks = [
  [files.constants, "ZOB_WORKLIST_TOOLS"],
  [files.constants, "...ZOB_WORKLIST_TOOLS"],
  [files.runtime, "zob_worklist"],
  [files.runtime, "name: \"zob_worklist\","],
  [files.runtime, "deliver / validate / observe / escalate / dag"],
  [files.schemas, "ZobWorklistParams"],
  [files.registry, "zob_worklist"],
  [files.skill, "name: zob-worklist"],
];

const failures = checks.filter(([path, needle]) => !read(path).includes(needle));
if (failures.length > 0) {
  console.error("worklist static smoke failed:");
  for (const [path, needle] of failures) console.error(`- ${path} missing ${needle}`);
  process.exit(1);
}
console.log("worklist static smoke passed");
