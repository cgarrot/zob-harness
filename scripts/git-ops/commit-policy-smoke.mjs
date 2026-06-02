#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

function readText(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function fail(message) {
  console.error(`git-ops policy smoke failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertIncludes(text, needle, label) {
  assert(text.includes(needle), `${label} missing ${JSON.stringify(needle)}`);
}

function assertNotIncludes(text, needle, label) {
  assert(!text.includes(needle), `${label} must not contain ${JSON.stringify(needle)}`);
}

const packageManifest = JSON.parse(readText("package.json"));
const policy = JSON.parse(readText(".pi/git-policy.json"));
const capabilities = JSON.parse(readText(".pi/capabilities/zob-public-runtime-capabilities.json"));
const damageRules = JSON.parse(readText(".pi/damage-control-rules.json"));
const skill = readText(".pi/skills/zob-commit/SKILL.md");
const gitOps = readText(".pi/extensions/zob-harness/src/domains/git/git-ops.ts");
const commands = readText(".pi/extensions/zob-harness/src/runtime/commands.ts");
const events = readText(".pi/extensions/zob-harness/src/runtime/events.ts");
const toolsZcommit = readText(".pi/extensions/zob-harness/src/runtime/tools-zcommit.ts");
const runtime = readText(".pi/extensions/zob-harness/src/runtime/zobHarness.ts");
const state = readText(".pi/extensions/zob-harness/src/runtime/state.ts");
const goalTodos = readText(".pi/extensions/zob-harness/src/domains/goal/goal-todos.ts");
const goalRuntime = readText(".pi/extensions/zob-harness/src/runtime/goal-runtime.ts");
const toolsDelegation = readText(".pi/extensions/zob-harness/src/runtime/tools-delegation.ts");

const allowedZcommitCommands = [
  "/zcommit status [paths/globs...]",
  "/zcommit plan [paths/globs...]",
  "/zcommit adopt <paths...>",
  "/zcommit commit [paths/globs...]",
  "/zcommit push",
  "/zcommit autocommit on",
  "/zcommit autocommit off",
  "/zcommit autopush on",
  "/zcommit autopush off",
];

assert(policy.defaults?.autocommit === "off", ".pi/git-policy.json must default autocommit off");
assert(policy.defaults?.autopush === "off", ".pi/git-policy.json must default autopush off");
assert(policy.commandSurface?.aliasesAllowed === false, ".pi/git-policy.json must set aliasesAllowed=false");
assert(policy.commandSurface?.explicitOnly === true, ".pi/git-policy.json must require explicitOnly command surface");
assert(policy.commandSurface?.directGitCommitPushTagAllowed === false, ".pi/git-policy.json must block direct git commit/push/tag");
assert((policy.commandSurface?.agentExecutableTools ?? []).includes("zob_zcommit_run"), ".pi/git-policy.json must expose agent-executable zcommit tool");
assert(policy.fileSelection?.strategy === "workspace_filtered", ".pi/git-policy.json must use easy workspace_filtered selection");
assert(policy.fileSelection?.onlyAgentOwnedFiles === false, ".pi/git-policy.json must not require agent-owned files in easy mode");
assert(policy.fileSelection?.excludeUnrelatedDirtyFiles === false, ".pi/git-policy.json must not exclude safe workspace dirty files in easy mode");
assert(policy.fileSelection?.bulkStageAllAllowed === true, ".pi/git-policy.json must allow bulk selection of safe filtered workspace files");
assert((policy.fileSelection?.forbiddenPaths ?? []).includes(".pi/worker-pools/"), ".pi/git-policy.json must exclude worker-pool runtime ledgers");
assert(policy.push?.forcePushAllowed === false, ".pi/git-policy.json must disallow force push");
assert(policy.push?.tagsAllowed === false, ".pi/git-policy.json must disallow tag push");
assert(policy.push?.pushAllAllowed === false, ".pi/git-policy.json must disallow push --all");
assert(policy.commitMessage?.format === "conventional-commits", ".pi/git-policy.json must require Conventional Commits");
assert(policy.commitMessage?.required === true, ".pi/git-policy.json must require a commit message policy");
assert(policy.validation?.mode === "advisory", ".pi/git-policy.json must use advisory validation before easy commits");
assert(policy.validation?.runBeforeCommit === true, ".pi/git-policy.json must still run validation before commit when possible");
assert(policy.validation?.requiredBeforeCommit === false, ".pi/git-policy.json must not block easy commits on validation by default");
assert(policy.validation?.requiredBeforePush === false, ".pi/git-policy.json must not block easy push on advisory validation by default");
assert(JSON.stringify(policy.commandSurface?.allowedCommands ?? []) === JSON.stringify(allowedZcommitCommands), ".pi/git-policy.json allowedCommands must be the explicit /zcommit surface only");
assert((packageManifest.files ?? []).includes(".pi/git-policy.json"), "package.json files must include .pi/git-policy.json");
assert((packageManifest.files ?? []).includes("scripts/git-ops"), "package.json files must include scripts/git-ops");

const damagePatterns = (damageRules.bashToolPatterns ?? []).map((rule) => rule.pattern ?? "");
for (const expected of ["\\bgit\\s+commit\\b", "\\bgit\\s+push\\b", "\\bgit\\s+tag\\b", "\\bgit\\s+add\\s+(-A|\\.)"]) {
  assert(damagePatterns.includes(expected), `.pi/damage-control-rules.json missing blocked pattern ${expected}`);
}
assert(damagePatterns.some((pattern) => pattern.includes("--force") || pattern.includes("force-with-lease")), ".pi/damage-control-rules.json must explicitly block force push");

for (const command of allowedZcommitCommands) assertIncludes(skill, `- \`${command}\``, ".pi/skills/zob-commit/SKILL.md allowed command list");
for (const forbidden of ["/zc", "/zci", "/zpush", "/commit", "/push"]) {
  assert(!skill.includes("`" + forbidden + "`") && !skill.includes("`" + forbidden + " "), `.pi/skills/zob-commit/SKILL.md alias surface must not list ${forbidden}`);
}
assertIncludes(skill, "Use only these explicit commands", ".pi/skills/zob-commit/SKILL.md");
assertIncludes(skill, "Do not invent aliases", ".pi/skills/zob-commit/SKILL.md");
assertIncludes(skill, "zob_zcommit_run", ".pi/skills/zob-commit/SKILL.md");
assertIncludes(skill, "do not answer with instructions", ".pi/skills/zob-commit/SKILL.md");
assertIncludes(skill, "Conventional Commits", ".pi/skills/zob-commit/SKILL.md");
assertIncludes(skill, "Easy workspace file rule", ".pi/skills/zob-commit/SKILL.md");
assertIncludes(skill, "autocommit` defaults to `off", ".pi/skills/zob-commit/SKILL.md");
assertIncludes(skill, "autopush` defaults to `off", ".pi/skills/zob-commit/SKILL.md");

assertIncludes(commands, 'pi.registerCommand("zcommit"', "commands.ts");
assertNotIncludes(commands, 'registerCommand("zc"', "commands.ts alias surface");
assertNotIncludes(commands, 'registerCommand("commit"', "commands.ts alias surface");
assertNotIncludes(commands, 'registerCommand("push"', "commands.ts alias surface");
assertIncludes(commands, "Easy governed ZOB commit workflow", "commands.ts zcommit description");
assertIncludes(commands, "status [paths/globs...]|plan [paths/globs...]|adopt <paths...>|commit [paths/globs...]|push|autocommit on|off|autopush on|off (no aliases)", "commands.ts zcommit description");
assertIncludes(commands, "Unknown /zcommit command", "commands.ts command parser");
assert((capabilities.tools ?? []).some((entry) => entry?.name === "zob_zcommit_run"), ".pi/capabilities registry must list zob_zcommit_run under tools[]");
assert(!(capabilities.commands ?? []).some((entry) => entry?.name === "zob_zcommit_run"), ".pi/capabilities registry must not list zob_zcommit_run under commands[]");
assertIncludes(runtime, "registerZcommitTools(pi, state)", "zobHarness.ts registers agent-executable zcommit tool");
assertIncludes(toolsZcommit, 'name: "zob_zcommit_run"', "tools-zcommit.ts registers zob_zcommit_run");
assertIncludes(toolsZcommit, "runGovernedZcommitCommit(ctx.cwd, state.zcommit, options)", "tools-zcommit.ts reuses governed commit engine");
assertIncludes(toolsZcommit, "runGovernedZcommitPush(ctx.cwd, state.zcommit, { explicitPush: true })", "tools-zcommit.ts reuses governed push engine");
assertIncludes(toolsZcommit, "sessionModifiedPathspecs", "tools-zcommit.ts supports session_modified scope");
assertIncludes(toolsZcommit, "scope=pathspecs requires non-empty paths", "tools-zcommit.ts supports explicit pathspec scope preflight");
assertIncludes(toolsZcommit, "action === \"commit_and_push\"", "tools-zcommit.ts supports commit_and_push");
assertIncludes(toolsZcommit, "messageHash", "tools-zcommit.ts stores message hash only in ledger");
assertNotIncludes(toolsZcommit, '["commit"', "tools-zcommit.ts must not call git commit directly");
assertNotIncludes(toolsZcommit, '["push"', "tools-zcommit.ts must not call git push directly");
assertNotIncludes(toolsZcommit, '["add"', "tools-zcommit.ts must not stage directly");

assertIncludes(gitOps, 'selectionMode === "workspace_filtered"', "git-ops.ts easy workspace mode");
assertIncludes(gitOps, "normalizeZcommitPathspecs", "git-ops.ts supports explicit pathspec filters");
assertIncludes(gitOps, "outside_zcommit_pathspec_filter", "git-ops.ts excludes dirty files outside explicit pathspec filters");
assertIncludes(gitOps, "pathspecErrors.length === 0", "git-ops.ts invalid pathspecs must block commit execution");
assertIncludes(gitOps, "abort: no safe dirty files match zcommit pathspecs", "git-ops.ts reports empty pathspec selections");
assertIncludes(gitOps, "abort: no safe dirty workspace files to commit", "git-ops.ts easy mode missing-files blocker");
assertIncludes(gitOps, "forbidden_by_git_policy_excluded", "git-ops.ts excludes forbidden unstaged paths");
assertIncludes(gitOps, '".pi/worker-pools/"', "git-ops.ts hard-excludes worker-pool runtime ledgers");
assertIncludes(gitOps, "plan.validationMode === \"blocking\"", "git-ops.ts advisory validation must not block easy commits");
assertIncludes(gitOps, "add supervised owner micro-worker pools", "git-ops.ts infers a beautiful worker-pool Conventional Commit");
assertIncludes(gitOps, "parseConventionalCommitOverride", "git-ops.ts supports governed message overrides");
assertIncludes(gitOps, '["add", "--", ...eligiblePaths]', "git-ops.ts explicit selected-path staging");
assertNotIncludes(gitOps, '["add", "."]', "git-ops.ts must not use git add .");
assertNotIncludes(gitOps, '["add", "-A"]', "git-ops.ts must not use git add -A");
assertNotIncludes(gitOps, '["add", "--all"]', "git-ops.ts must not use git add --all");
assertIncludes(gitOps, '["push", remote, `HEAD:${branch}`]', "git-ops.ts governed push shape");
assertIncludes(gitOps, "policy.validation?.requiredBeforePush !== false", "git-ops.ts keeps optional strict push validation gate");
assertIncludes(gitOps, 'runtime.autocommit !== "on"', "git-ops.ts autopush requires autocommit on");
assertIncludes(gitOps, "runtime.lastValidation", "git-ops.ts optional push validation gate");
assertIncludes(gitOps, "validation.requiredBeforePush requires successful validation before /zcommit push", "git-ops.ts optional missing push validation blocker");
assertIncludes(gitOps, "validation.requiredBeforePush requires validation to run before or at the last /zcommit commit creation", "git-ops.ts optional stale push validation blocker");
assertIncludes(gitOps, "plan.unexpectedStaged.length > 0", "git-ops.ts push staged-file blocker");
assertIncludes(gitOps, "last /zcommit commit contains forbidden files", "git-ops.ts push forbidden last-commit blocker");
for (const forbidden of ["--force", "--force-with-lease", "-f", "--tags", "--all", "tag"]) {
  assert(!gitOps.includes(`[${JSON.stringify(forbidden)}`), `git-ops.ts must not provide git ${forbidden} command path`);
  assert(!gitOps.includes(`, ${JSON.stringify(forbidden)}`), `git-ops.ts must not provide git ${forbidden} command path`);
}
assertIncludes(gitOps, '["restore", "--staged", "--", ...paths]', "git-ops.ts commit cleanup");
assertIncludes(gitOps, 'export type ZcommitOwnershipSource = "local_tool_call" | "parent_accepted_child_claim" | "compaction_continuity" | "explicit_zcommit_adopt"', "git-ops.ts explicit ownership sources");
assertIncludes(gitOps, "export interface ZcommitAdoptResult", "git-ops.ts explicit adopt result");
assertIncludes(gitOps, "runGovernedZcommitAdopt", "git-ops.ts governed adopt API");
assertIncludes(gitOps, "readGitDirtyFiles(repoRoot)", "git-ops.ts adopt reads git status");
assertIncludes(gitOps, '"--untracked-files=all"', "git-ops.ts git status must include untracked files");
assertIncludes(gitOps, "isExplicitZcommitAdoptArg", "git-ops.ts adopt rejects broad-root/global adoption");
assertIncludes(gitOps, "statSync(resolve(repoRoot, normalizedPath)).isDirectory()", "git-ops.ts adopt rejects directory adoption");
assertIncludes(gitOps, "hasZcommitAdoptWildcard", "git-ops.ts adopt rejects wildcard adoption");
assertIncludes(gitOps, "zcommitDirtyFileMatchesAdoptPath", "git-ops.ts adopt uses explicit path matching");
assertIncludes(gitOps, "file.path === requestedPath || file.originalPath === requestedPath", "git-ops.ts adopt must match exact dirty file paths only");
assertNotIncludes(gitOps, "file.path.startsWith(`${requestedPath}/`)", "git-ops.ts adopt must not use directory-prefix matching");
assertNotIncludes(gitOps, "file.originalPath?.startsWith(`${requestedPath}/`)", "git-ops.ts adopt must not use original-path directory-prefix matching");
assertIncludes(gitOps, "staged_file_not_adopted", "git-ops.ts adopt refuses staged dirty files");
assertIncludes(gitOps, "recordZcommitOwnedPath(runtime, repoRoot, file.path, \"explicit_zcommit_adopt\"", "git-ops.ts adopt records only matched dirty files");
assertNotIncludes(gitOps, "recordZcommitOwnedPaths(runtime, repoRoot, dirtyFiles", "git-ops.ts adopt must not globally adopt dirty files");
const adoptFunction = gitOps.slice(gitOps.indexOf("export function runGovernedZcommitAdopt"), gitOps.indexOf("export function readZcommitPolicy"));
assert(adoptFunction.includes("runGovernedZcommitAdopt"), "git-ops.ts adopt function block must be discoverable");
assertNotIncludes(adoptFunction, '["add"', "git-ops.ts adopt must not run git add");
assertNotIncludes(adoptFunction, "...dirtyFiles", "git-ops.ts adopt must not bulk-record all dirty files");
assertIncludes(gitOps, "recordZcommitOwnedPath", "git-ops.ts explicit owned path API");
assertIncludes(gitOps, "captureZcommitChildDirtySnapshot", "git-ops.ts child dirty delta snapshot API");
assertIncludes(gitOps, "diffZcommitChildDirtySnapshots", "git-ops.ts child dirty delta diff API");
assertIncludes(gitOps, "recordZcommitOwnedPaths", "git-ops.ts accepted child changed path adoption API");
assertIncludes(gitOps, "zcommitPathWithinAllowed", "git-ops.ts child dirty delta allowed-path filter");
assertIncludes(gitOps, "zcommitFileContentHash", "git-ops.ts child dirty delta content hash");
assertIncludes(gitOps, "hardForbiddenZcommitPatterns", "git-ops.ts policy/hard forbidden path filter");
assertIncludes(gitOps, "...Object.keys(runtime.ownedPathRefs ?? {})", "git-ops.ts retains explicit owned path refs for legacy/adopt metadata");
assertNotIncludes(gitOps, "dirtyFiles.map", "git-ops.ts must not blindly map all dirty files into ownership refs");
assertIncludes(gitOps, '["diff", "--cached", "--no-renames", "--name-only", "-z"]', "git-ops.ts cached index inspection must be stable for delete+add rehomes");
assertIncludes(gitOps, '["diff", "--cached", "--no-renames", "--binary", "--", ...paths]', "git-ops.ts cached patch capture must avoid rename-collapsed rehomes");
assertIncludes(gitOps, '["diff", "--cached", "--check"]', "git-ops.ts cached diff verification");
assertIncludes(gitOps, "sameStringSet(stagedAfterAdd, eligiblePaths)", "git-ops.ts staged path allowlist verification");
assertIncludes(gitOps, "commitMessageArgs", "git-ops.ts Conventional Commit path");

assertIncludes(events, 'pi.on("message_end"', "events.ts message_end hook");
assertIncludes(events, 'state.zcommit.autocommit !== "on"', "events.ts autocommit default-off guard");
assertIncludes(events, "runGovernedZcommitCommit(ctx.cwd, state.zcommit)", "events.ts governed autocommit gate");
assertIncludes(events, 'state.zcommit.autopush === "on"', "events.ts autopush toggle guard");
assertIncludes(events, "runGovernedZcommitPush(ctx.cwd, state.zcommit, { explicitPush: false })", "events.ts governed autopush hook");
assertIncludes(events, "zob.zcommit-message-end.v1", "events.ts body-free autocommit ledger schema");
assertIncludes(events, 'schema: "zob.zcommit-message-end.v1",\n    bodyStored: false', "events.ts body-free autocommit ledger flag");
assertIncludes(events, "ownedPathRefs: zcommitOwnedPathLedgerRefs(state)", "events.ts persists explicit zcommit ownership refs");
assertIncludes(events, "zob.zcommit-continuity.v1", "events.ts compaction persists zcommit-owned refs in zcommit ledger");
assertIncludes(commands, "ownedPathRefs: zcommitOwnedPathLedgerRefs(state)", "commands.ts persists explicit zcommit ownership refs");
assertNotIncludes(state, "restoreZcommitCompactionContinuity", "state.ts must not restore zcommit ownership from compaction modifiedFiles");
assertNotIncludes(state, "restoreZcommitAcceptedTodoClaimOwnership", "state.ts must not restore zcommit ownership from TODO evidenceRefs");
assertNotIncludes(state, "fileRefs?.modifiedFiles", "state.ts must not inspect compaction modifiedFiles for zcommit ownership");
assertNotIncludes(state, "for (const ref of node.evidenceRefs)", "state.ts must not adopt TODO evidenceRefs as zcommit ownership");
assertIncludes(state, "restoreZcommitMetadataFromEntries", "state.ts restores zcommit-owned refs only from zob-zcommit entries");
assertIncludes(goalTodos, "childChangedPaths", "goal-todos.ts stores child changed paths on returned claim");
assertIncludes(goalTodos, "recordZcommitOwnedPaths(state.zcommit", "goal-todos.ts adopts accepted child changed paths");
assertIncludes(goalTodos, "changedPaths.length > 0 && !input.repoRoot", "goal-todos.ts must require explicit repoRoot when accepting child changed paths");
assertNotIncludes(goalTodos, "input.repoRoot ?? process.cwd()", "goal-todos.ts must not fall back to process.cwd for child ownership adoption");
assertIncludes(goalTodos, "parent_accepted_child_claim", "goal-todos.ts uses delegated claim ownership source only at acceptance");
assertIncludes(goalRuntime, "resolveGoalTodo(pi, state, goalId, params.todo_id, { action: params.action as ResolveGoalTodoAction, evidenceRefs: params.evidence_refs, validationCommands: params.validation_commands, reason: params.reason, repoRoot: ctx.cwd }", "goal-runtime.ts resolve_goal_todo passes ctx.cwd as repoRoot");
assertIncludes(goalRuntime, "recordGoalTodoClaimValidationResult(pi, state, goalId, params.todo_id", "goal-runtime.ts validates delegated claims through runtime path");
assertIncludes(goalRuntime, "repoRoot: ctx.cwd", "goal-runtime.ts auto/accept claim paths pass ctx.cwd repoRoot");
assertIncludes(toolsDelegation, "captureZcommitChildDirtySnapshot", "tools-delegation.ts captures child dirty snapshot");
assertIncludes(toolsDelegation, "diffZcommitChildDirtySnapshots", "tools-delegation.ts computes child dirty delta");
assertIncludes(toolsDelegation, "captureZcommitChildDirtySnapshot(ctx.cwd, childPathPolicy)", "tools-delegation.ts must capture child dirty snapshot at repo root, not child cwd");
assertIncludes(toolsDelegation, "captureChildDirtyDelta(ctx.cwd, childPathPolicy, beforeChildDirty)", "tools-delegation.ts must diff child dirty snapshot at repo root, not child cwd");
assertNotIncludes(toolsDelegation, "captureZcommitChildDirtySnapshot(cwdResult.cwd, childPathPolicy)", "tools-delegation.ts must not use child cwd as repoRoot for dirty snapshot");
assertNotIncludes(toolsDelegation, "captureChildDirtyDelta(cwdResult.cwd, childPathPolicy, beforeChildDirty)", "tools-delegation.ts must not use child cwd as repoRoot for dirty diff");
assertIncludes(toolsDelegation, "toolsEnableWrites", "tools-delegation.ts captures only write-enabled child runs");
assertIncludes(toolsDelegation, "result.childChangedPaths", "tools-delegation.ts stores child changed paths in ChildResult");
assertIncludes(toolsDelegation, "childChangedPathRefs", "tools-delegation.ts persists body-free child changed paths in ledger");
assertIncludes(toolsDelegation, "recordTodoClaimFromChildResult", "tools-delegation.ts attaches run changed paths to returned claims");

const cached = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
assert(cached.length === 0, `current git index must be empty; staged files: ${cached.join(", ")}`);

console.log("git-ops policy smoke passed");
