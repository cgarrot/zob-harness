#!/usr/bin/env node
import { readFileSync } from "node:fs";

const files = {
  workerPool: ".pi/extensions/zob-harness/src/domains/governance/worker-pool.ts",
  runtime: ".pi/extensions/zob-harness/src/runtime/tools-worker-pool.ts",
  goalRoom: ".pi/extensions/zob-harness/src/domains/goal/goal-room.ts",
  constants: ".pi/extensions/zob-harness/src/core/constants.ts",
  schemas: ".pi/extensions/zob-harness/src/runtime/schemas.ts",
  governedRequests: ".pi/extensions/zob-harness/src/domains/governance/governed-requests.ts",
  governedRuntime: ".pi/extensions/zob-harness/src/runtime/tools-governed-requests.ts",
  registry: ".pi/capabilities/zob-public-runtime-capabilities.json",
};

const read = (path) => readFileSync(path, "utf8");
const checks = [
  [files.workerPool, "schema: \"zob.worker-pool-plan.v1\""],
  [files.workerPool, "productionWritesPerformed: false"],
  [files.workerPool, "autoApply: false"],
  [files.workerPool, "write_paths must be within owned_paths"],
  [files.workerPool, "workspaceClaimsCoverWriteIntent"],
  [files.workerPool, "zob.worker-pool-safety-gates.v1"],
  [files.workerPool, "owner request requested_paths must be covered"],
  [files.workerPool, "kind: \"OWNER_CHANGE_REQUEST\""],
  [files.workerPool, "kind: \"OWNER_CHANGE_DECISION\""],
  [files.runtime, "zob_worker_pool_plan"],
  [files.runtime, "zob_worker_pool_owner_request"],
  [files.runtime, "zob_worker_pool_owner_decision"],
  [files.goalRoom, "OWNER_CHANGE_REQUEST"],
  [files.goalRoom, "OWNER_CHANGE_DECISION"],
  [files.constants, "ZOB_WORKER_POOL_TOOLS"],
  [files.schemas, "WorkerPoolPlanParams"],
  [files.schemas, "read_across_write_overlap_justification_hash"],
  [files.schemas, "each path must be within owned_paths"],
  [files.registry, "zob_worker_pool_plan"],
  [files.registry, "zob_worker_pool_status"],
  [files.registry, "zob_worker_pool_owner_request"],
  [files.registry, "zob_worker_pool_owner_decision"],
  [files.registry, "Actual child dispatch remains parent-owned through delegate_task/delegate_agent"],
  [files.governedRequests, "OWNER_CHANGE_REQUEST"],
  [files.governedRequests, "owner-change-request.v1"],
  [files.governedRequests, "owner change request change_hash must be sha256 hex"],
  [files.governedRequests, "requested_path_hashes"],
  [files.governedRuntime, "OWNER_CHANGE_REQUEST.v1"],
  [files.schemas, "OWNER_CHANGE_REQUEST.v1"],
];

const failures = checks.filter(([path, needle]) => !read(path).includes(needle));
if (failures.length > 0) {
  console.error("worker-pool static smoke failed:");
  for (const [path, needle] of failures) console.error(`- ${path} missing ${needle}`);
  process.exit(1);
}
console.log("worker-pool static smoke passed");
