import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildZcommitPlan, runGovernedZcommitCommit, runGovernedZcommitPush, type ZcommitCommandResult, type ZcommitPlan, type ZcommitPlanOptions } from "../domains/git/git-ops.js";
import { ZcommitRunParams } from "./schemas.js";
import type { HarnessRuntimeState } from "./state.js";
import { sha256 } from "../core/utils/hashing.js";

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function sessionModifiedPathspecs(state: HarnessRuntimeState): string[] {
  const sessionStartedAt = Date.parse(state.zcommit.sessionStartedAt ?? "");
  const touched = Object.keys(state.zcommit.touchedFiles ?? {});
  const ownedThisSession = Object.values(state.zcommit.ownedPathRefs ?? {})
    .filter((ref) => {
      if (Number.isNaN(sessionStartedAt)) return true;
      const lastOwnedAt = Date.parse(ref.lastOwnedAt);
      return !Number.isNaN(lastOwnedAt) && lastOwnedAt >= sessionStartedAt;
    })
    .map((ref) => ref.path);
  return uniqueSorted([...touched, ...ownedThisSession]);
}

function resolvePathspecs(state: HarnessRuntimeState, scope: string | undefined, paths: string[] | undefined): { pathspecs: string[]; errors: string[] } {
  const selectedScope = scope ?? (paths && paths.length > 0 ? "pathspecs" : "all_safe_dirty");
  if (selectedScope === "all_safe_dirty") return { pathspecs: [], errors: [] };
  if (selectedScope === "pathspecs") {
    if (!paths || paths.length === 0) return { pathspecs: [], errors: ["scope=pathspecs requires non-empty paths"] };
    return { pathspecs: uniqueSorted(paths), errors: [] };
  }
  if (selectedScope === "session_modified") {
    const sessionPaths = sessionModifiedPathspecs(state);
    if (paths && paths.length > 0) {
      const allowed = new Set(sessionPaths);
      const requested = uniqueSorted(paths);
      const outside = requested.filter((path) => !allowed.has(path));
      if (outside.length > 0) return { pathspecs: requested.filter((path) => allowed.has(path)), errors: outside.map((path) => `path is not recorded as modified in this session: ${path}`) };
      return { pathspecs: requested, errors: [] };
    }
    if (sessionPaths.length === 0) return { pathspecs: [], errors: ["scope=session_modified found no current-session modified paths; use scope=pathspecs or all_safe_dirty"] };
    return { pathspecs: sessionPaths, errors: [] };
  }
  return { pathspecs: [], errors: [`unknown zcommit scope: ${selectedScope}`] };
}

type ZcommitToolParams = {
  paths?: string[];
  message?: string;
  body?: string[];
  user_requested?: boolean;
  handoff_candidate_hash?: string;
  handoff_authority_hash?: string;
  handoff_expected_base_sha?: string;
};

type ZcommitReceiptRecord = {
  schema: "zob.zcommit-receipt.v1";
  receiptHash: string;
  action: "commit";
  status: "ok";
  repositoryRootHash: string;
  baseHeadSha: string;
  committedHeadSha: string;
  treeHash: string;
  branchHash: string;
  eligiblePathHashes: string[];
  handoffCandidateHash: string;
  handoffAuthorityHash: string;
  handoffExpectedBaseSha: string;
  userRequested: true;
  validationOk: true;
  actualGitCommitRun: true;
  actualGitPushRun: false;
  generatedAt: string;
  bodyStored: false;
};

function prepareZcommitReceiptDirectory(repoRoot: string): { root: string; directory: string } {
  const resolvedRoot = resolve(repoRoot);
  const root = realpathSync(execFileSync("git", ["-C", resolvedRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  const directory = join(root, ".pi", "logs", "zcommit-receipts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new Error("zcommit receipt directory must not traverse symlinks");
  accessSync(directory, fsConstants.W_OK);
  execFileSync("git", ["-C", root, "check-ignore", "--quiet", "--", ".pi/logs/zcommit-receipts/receipt-probe.json"], { stdio: ["ignore", "ignore", "pipe"] });
  return { root, directory };
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  throw new Error(`unsupported canonical value type ${typeof value}`);
}

export function writeZcommitReceipt(repoRoot: string, params: ZcommitToolParams, result: ZcommitCommandResult): { receiptRef: string; receiptFileHash: string; receiptHash: string } {
  if (!result.ok || result.action !== "commit" || !result.commit || !result.baseHeadSha || result.actualGitCommitRun !== true || result.actualGitPushRun !== false || result.validation?.ok !== true) {
    throw new Error("zcommit receipt requires a successful validated commit without push");
  }
  if (!params.handoff_candidate_hash || !params.handoff_authority_hash || !params.handoff_expected_base_sha || params.user_requested !== true) throw new Error("zcommit receipt requires complete explicit handoff bindings");
  if (result.baseHeadSha !== params.handoff_expected_base_sha) throw new Error("zcommit result base HEAD does not match handoff_expected_base_sha");
  const { root, directory } = prepareZcommitReceiptDirectory(repoRoot);
  const treeHash = execFileSync("git", ["-C", root, "rev-parse", `${result.commit.hash}^{tree}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const branch = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const payload: Omit<ZcommitReceiptRecord, "receiptHash"> = {
    schema: "zob.zcommit-receipt.v1",
    action: "commit",
    status: "ok",
    repositoryRootHash: sha256(root),
    baseHeadSha: result.baseHeadSha,
    committedHeadSha: result.commit.hash,
    treeHash,
    branchHash: sha256(branch),
    eligiblePathHashes: result.commit.files.map((path) => sha256(path)).sort(),
    handoffCandidateHash: params.handoff_candidate_hash,
    handoffAuthorityHash: params.handoff_authority_hash,
    handoffExpectedBaseSha: params.handoff_expected_base_sha,
    userRequested: true,
    validationOk: true,
    actualGitCommitRun: true,
    actualGitPushRun: false,
    generatedAt: result.commit.createdAt,
    bodyStored: false,
  };
  const receipt: ZcommitReceiptRecord = { ...payload, receiptHash: sha256(JSON.stringify(canonicalValue(payload))) };
  const path = join(directory, `${result.commit.hash}.json`);
  const raw = `${JSON.stringify(receipt, null, 2)}\n`;
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error("existing zcommit receipt must not be a symlink");
    if (readFileSync(path, "utf8") !== raw) throw new Error("existing zcommit receipt conflicts with current commit receipt");
  } else {
    const temporary = `${path}.tmp.${receipt.receiptHash.slice(0, 16)}`;
    writeFileSync(temporary, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  }
  return { receiptRef: relative(root, path).split("\\").join("/"), receiptFileHash: sha256(raw), receiptHash: receipt.receiptHash };
}

function zcommitLedgerEntry(action: string, scope: string, params: ZcommitToolParams, plan: ZcommitPlan, result?: ZcommitCommandResult, receipt?: { receiptRef: string; receiptFileHash: string; receiptHash: string }): Record<string, unknown> {
  return {
    schema: "zob.zcommit-tool.v1",
    bodyStored: false,
    action,
    scope,
    status: result ? (result.ok ? "ok" : "blocked_or_failed") : "planned",
    userRequested: params.user_requested === true,
    policyLoaded: plan.policyLoaded,
    selectionMode: plan.selectionMode,
    validationMode: plan.validationMode,
    selectionPathspecHashes: plan.selectionPathspecs.map((pathspec) => sha256(pathspec)),
    requestedPathHashes: (params.paths ?? []).map((path) => sha256(path)),
    messageHash: params.message ? sha256(params.message) : undefined,
    bodyLineHashes: (params.body ?? []).map((line) => sha256(line)),
    eligibleCount: plan.eligible.length,
    excludedCount: plan.excluded.length,
    forbiddenCount: plan.forbidden.length,
    unexpectedStagedCount: plan.unexpectedStaged.length,
    noShip: plan.noShip,
    commitEnabled: plan.commitEnabled,
    pushEnabled: plan.pushEnabled,
    validationOk: result?.validation?.ok,
    lastCommitHash: result?.commit?.hash,
    lastCommitShortHash: result?.commit?.shortHash,
    errorHashes: result?.errors.map((error) => sha256(error)),
    actualGitCommitRun: result?.actualGitCommitRun ?? false,
    actualGitPushRun: result?.actualGitPushRun ?? false,
    handoffCandidateHash: params.handoff_candidate_hash,
    handoffAuthorityHash: params.handoff_authority_hash,
    handoffExpectedBaseSha: params.handoff_expected_base_sha,
    receiptRefHash: receipt ? sha256(receipt.receiptRef) : undefined,
    receiptFileHash: receipt?.receiptFileHash,
    receiptHash: receipt?.receiptHash,
    generatedAt: new Date().toISOString(),
  };
}

function planSummary(plan: ZcommitPlan): string {
  const commit = `${plan.conventionalCommit.type}(${plan.conventionalCommit.scope}): ${plan.conventionalCommit.subject}`;
  const pathspecs = plan.selectionPathspecs.join(", ") || "all-safe-dirty";
  return `mode=${plan.selectionMode} scope_pathspecs=[${pathspecs}] eligible=${plan.eligible.length} excluded=${plan.excluded.length} forbidden=${plan.forbidden.length} commit=${plan.commitEnabled ? "ready" : "blocked"} conventional_commit="${commit}"`;
}

export function registerZcommitTools(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerTool({
    name: "zob_zcommit_run",
    label: "ZOB Zcommit Run",
    description: "Agent-executable governed zcommit workflow. Plan, commit, push, or commit_and_push via the /zcommit engine when the user explicitly asks; never use direct git commit/push/tag or global staging.",
    promptSnippet: "Use zob_zcommit_run when the user asks you to commit/push. Prefer action=commit_and_push with scope=session_modified or paths; do not ask the user to paste /zcommit commands.",
    parameters: ZcommitRunParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "plan";
      const scope = params.scope ?? (params.paths && params.paths.length > 0 ? "pathspecs" : "all_safe_dirty");
      const { pathspecs, errors } = resolvePathspecs(state, scope, params.paths);
      const options: ZcommitPlanOptions = { pathspecs, message: params.message, body: params.body };
      const plan = buildZcommitPlan(ctx.cwd, state.zcommit, options);
      if (errors.length > 0) {
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry(action, scope, params, plan));
        return { content: [{ type: "text", text: `zob_zcommit_run blocked: ${errors.join(" | ")}; ${planSummary(plan)}` }], details: { schema: "zob.zcommit-tool-result.v1", status: "blocked", errors, plan } };
      }

      const wantsCommit = action === "commit" || action === "commit_and_push";
      const wantsPush = action === "push" || action === "commit_and_push" || params.push === true;
      const handoffBindings = [params.handoff_candidate_hash, params.handoff_authority_hash, params.handoff_expected_base_sha];
      const handoffProvided = handoffBindings.some((value) => value !== undefined);
      const handoffComplete = handoffBindings.every((value) => value !== undefined);
      const handoffErrors: string[] = [];
      if (handoffProvided && !handoffComplete) handoffErrors.push("handoff commit requires candidate hash, authority hash, and expected base sha together");
      if (handoffProvided && (action !== "commit" || wantsPush)) handoffErrors.push("handoff commit bindings permit action=commit without push only");
      if (handoffProvided && params.user_requested !== true) handoffErrors.push("handoff commit requires user_requested=true");
      if (handoffComplete) {
        try {
          const head = execFileSync("git", ["-C", ctx.cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
          if (head !== params.handoff_expected_base_sha) handoffErrors.push("current HEAD does not match handoff_expected_base_sha");
          prepareZcommitReceiptDirectory(ctx.cwd);
        } catch (error) {
          handoffErrors.push(`handoff receipt destination is not safe and ignored: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (handoffErrors.length > 0) {
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry("tool_handoff_blocked", scope, params, plan));
        return { content: [{ type: "text", text: `zob_zcommit_run blocked: ${handoffErrors.join(" | ")}; ${planSummary(plan)}` }], details: { schema: "zob.zcommit-tool-result.v1", status: "blocked", errors: handoffErrors, plan } };
      }
      if ((wantsCommit || wantsPush) && params.user_requested !== true && state.zcommit.autocommit !== "on") {
        const authorizationErrors = ["commit/push actions require user_requested=true or /zcommit autocommit on"];
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry(action, scope, params, plan));
        return { content: [{ type: "text", text: `zob_zcommit_run blocked: ${authorizationErrors.join(" | ")}; ${planSummary(plan)}` }], details: { schema: "zob.zcommit-tool-result.v1", status: "blocked", errors: authorizationErrors, plan } };
      }

      if (action === "plan") {
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry("tool_plan", scope, params, plan));
        return { content: [{ type: "text", text: `zob_zcommit_run plan: ${planSummary(plan)}` }], details: { schema: "zob.zcommit-tool-result.v1", status: "planned", plan } };
      }

      if (action === "commit") {
        const result = runGovernedZcommitCommit(ctx.cwd, state.zcommit, options);
        let receipt: { receiptRef: string; receiptFileHash: string; receiptHash: string } | undefined;
        if (result.ok && handoffComplete) {
          try {
            receipt = writeZcommitReceipt(ctx.cwd, params, result);
          } catch (error) {
            const receiptError = error instanceof Error ? error.message : String(error);
            pi.appendEntry("zob-zcommit", zcommitLedgerEntry("tool_commit_receipt_failed", scope, params, result.plan, result));
            return { content: [{ type: "text", text: `zob_zcommit_run commit created but handoff receipt failed: ${receiptError}` }], details: { schema: "zob.zcommit-tool-result.v1", status: "commit_ok_receipt_failed", errors: [receiptError], result } };
          }
        }
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry(result.ok ? "tool_commit_created" : "tool_commit_blocked", scope, params, result.plan, result, receipt));
        if (params.push === true && result.ok) {
          const pushResult = runGovernedZcommitPush(ctx.cwd, state.zcommit, { explicitPush: true });
          pi.appendEntry("zob-zcommit", zcommitLedgerEntry(pushResult.ok ? "tool_push_completed" : "tool_push_blocked", scope, params, pushResult.plan, pushResult));
          return { content: [{ type: "text", text: `zob_zcommit_run commit+push: ${result.message}; ${pushResult.message}` }], details: { schema: "zob.zcommit-tool-result.v1", status: pushResult.ok ? "ok" : "blocked_or_failed", commitResult: result, pushResult } };
        }
        return { content: [{ type: "text", text: `zob_zcommit_run commit: ${result.message}${receipt ? `; receipt=${receipt.receiptRef}; receipt_file_sha256=${receipt.receiptFileHash}` : ""}` }], details: { schema: "zob.zcommit-tool-result.v1", status: result.ok ? "ok" : "blocked_or_failed", result, receipt } };
      }

      if (action === "push") {
        const result = runGovernedZcommitPush(ctx.cwd, state.zcommit, { explicitPush: true });
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry(result.ok ? "tool_push_completed" : "tool_push_blocked", scope, params, result.plan, result));
        return { content: [{ type: "text", text: `zob_zcommit_run push: ${result.message}` }], details: { schema: "zob.zcommit-tool-result.v1", status: result.ok ? "ok" : "blocked_or_failed", result } };
      }

      if (action === "commit_and_push") {
        const commitResult = runGovernedZcommitCommit(ctx.cwd, state.zcommit, options);
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry(commitResult.ok ? "tool_commit_created" : "tool_commit_blocked", scope, params, commitResult.plan, commitResult));
        if (!commitResult.ok) return { content: [{ type: "text", text: `zob_zcommit_run commit_and_push blocked during commit: ${commitResult.message}` }], details: { schema: "zob.zcommit-tool-result.v1", status: "blocked_or_failed", commitResult } };
        const pushResult = runGovernedZcommitPush(ctx.cwd, state.zcommit, { explicitPush: true });
        pi.appendEntry("zob-zcommit", zcommitLedgerEntry(pushResult.ok ? "tool_push_completed" : "tool_push_blocked", scope, params, pushResult.plan, pushResult));
        return { content: [{ type: "text", text: `zob_zcommit_run commit_and_push: ${commitResult.message}; ${pushResult.message}` }], details: { schema: "zob.zcommit-tool-result.v1", status: pushResult.ok ? "ok" : "blocked_or_failed", commitResult, pushResult } };
      }

      const unknownErrors = [`unknown zcommit action: ${action}`];
      pi.appendEntry("zob-zcommit", zcommitLedgerEntry("tool_unknown_action", scope, params, plan));
      return { content: [{ type: "text", text: `zob_zcommit_run blocked: ${unknownErrors.join(" | ")}` }], details: { schema: "zob.zcommit-tool-result.v1", status: "blocked", errors: unknownErrors, plan } };
    },
  });
}
