import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { sha256Canonical, sha256Text } from "../supervisor/canonical.js";
import type { WheelPrHandoffWorkspaceSnapshot } from "./types.js";

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_SNAPSHOT_FILE_BYTES = 20 * 1024 * 1024;
const FORBIDDEN_CHANGED_PATH = /(^|\/)(?:\.git(?:\/|$)|\.env(?:\.|$)|\.pi\/(?:sessions|agent-sessions)(?:\/|$)|secrets?(?:\/|$)|credentials?(?:\/|$)|reports\/wheel-zob\/local-launches(?:\/|$))/i;

function git(workspaceRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", workspaceRoot, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitSuccess(workspaceRoot: string, args: string[]): boolean {
  const result = spawnSync("git", ["-C", workspaceRoot, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function gitRaw(workspaceRoot: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", workspaceRoot, ...args], {
    timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function parseWheelGitNulPaths(raw: Buffer): string[] {
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index < raw.length && raw[index] !== 0) continue;
    if (index > start) {
      const pathBytes = raw.subarray(start, index);
      if (pathBytes.includes(0x5c)) throw new Error("changed path contains an unsupported literal backslash byte");
      const path = pathBytes.toString("utf8");
      if (!Buffer.from(path, "utf8").equals(pathBytes)) throw new Error("changed path is not valid round-trip UTF-8");
      paths.push(path);
    }
    start = index + 1;
  }
  return paths;
}

function safeChangedPath(path: string): boolean {
  return path.length > 0
    && !isAbsolute(path)
    && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    && !FORBIDDEN_CHANGED_PATH.test(path);
}

function gitHash(workspaceRoot: string, args: string[]): string {
  const raw = execFileSync("git", ["-C", workspaceRoot, ...args], {
    timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return createHash("sha256").update(raw).digest("hex");
}

function pathEscapesRoot(repositoryRoot: string, candidate: string): boolean {
  const rel = relative(repositoryRoot, candidate).split("\\").join("/");
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

function changedPathSnapshot(repositoryRoot: string, paths: string[]): Array<{ path: string; kind: "file" | "deleted"; mode: number; size: number; contentHash: string }> {
  return [...new Set(paths)].sort().map((path) => {
    if (!safeChangedPath(path)) throw new Error(`changed path is forbidden or unsafe: ${path}`);
    const segments = path.split("/");
    let absolute = repositoryRoot;
    let stat;
    for (let index = 0; index < segments.length; index += 1) {
      absolute = resolve(absolute, segments[index]!);
      if (pathEscapesRoot(repositoryRoot, absolute)) throw new Error(`changed path escapes story workspace: ${path}`);
      try {
        stat = lstatSync(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, kind: "deleted" as const, mode: 0, size: 0, contentHash: sha256Text("deleted") };
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`changed path traverses a symlink component: ${path}`);
      if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(`changed path traverses a non-directory component: ${path}`);
    }
    const realPath = realpathSync(absolute);
    if (pathEscapesRoot(repositoryRoot, realPath)) throw new Error(`changed path resolves outside story workspace: ${path}`);
    if (!stat?.isFile()) throw new Error(`changed path is not a regular file: ${path}`);
    if (stat.size > MAX_SNAPSHOT_FILE_BYTES) throw new Error(`changed file exceeds ${MAX_SNAPSHOT_FILE_BYTES} bytes: ${path}`);
    return { path, kind: "file" as const, mode: stat.mode & 0o7777, size: stat.size, contentHash: createHash("sha256").update(readFileSync(realPath)).digest("hex") };
  });
}

export function inspectWheelPrHandoffWorkspace(
  workspaceRoot: string,
  input: { phase: "pre-commit" | "post-commit"; baseSha?: string; sourceSha: string },
): WheelPrHandoffWorkspaceSnapshot {
  const repositoryRoot = realpathSync(git(workspaceRoot, ["rev-parse", "--show-toplevel"]).trim());
  if (repositoryRoot !== realpathSync(resolve(workspaceRoot))) throw new Error("PR handoff workspace must be the linked worktree root");
  const gitDirectory = realpathSync(git(repositoryRoot, ["rev-parse", "--absolute-git-dir"]).trim());
  const commonDirectory = realpathSync(resolve(repositoryRoot, git(repositoryRoot, ["rev-parse", "--git-common-dir"]).trim()));
  if (gitDirectory === commonDirectory) throw new Error("PR handoff requires an isolated linked story worktree");
  let branchName: string;
  try {
    branchName = git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  } catch {
    throw new Error("PR handoff workspace must be on a named branch");
  }
  const headSha = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  if (!GIT_OBJECT_ID.test(headSha)) throw new Error("PR handoff workspace HEAD is invalid");
  const clean = git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).trim().length === 0;
  if (!GIT_OBJECT_ID.test(input.sourceSha)) throw new Error("PR handoff source sha is invalid");
  if (!gitSuccess(repositoryRoot, ["cat-file", "-e", `${input.sourceSha}^{commit}`])) throw new Error("PR handoff source sha is missing from the story repository");
  if (!gitSuccess(repositoryRoot, ["merge-base", "--is-ancestor", input.sourceSha, headSha])) throw new Error("story workspace HEAD does not descend from the source-bound launch revision");

  let changedPaths: string[];
  let treeHash: string;
  if (input.phase === "pre-commit") {
    changedPaths = [
      ...parseWheelGitNulPaths(gitRaw(repositoryRoot, ["diff", "--name-only", "-z", "HEAD"])),
      ...parseWheelGitNulPaths(gitRaw(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"])),
    ];
    if (clean || changedPaths.length === 0) throw new Error("pre-commit PR handoff requires non-empty local changes");
    const entries = changedPathSnapshot(repositoryRoot, changedPaths);
    changedPaths = entries.map((entry) => entry.path);
    const gitSemantics = {
      porcelainV2Hash: gitHash(repositoryRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
      rawDiffHash: gitHash(repositoryRoot, ["diff", "--raw", "-z", "-M", "--full-index", "HEAD"]),
      binaryDiffHash: gitHash(repositoryRoot, ["diff", "--binary", "--full-index", "-M", "HEAD"]),
    };
    treeHash = sha256Canonical({ schema: "wheel.zob.synthetic-worktree-tree.v1", headSha, entries, gitSemantics, bodyStored: false });
    return {
      schema: "wheel.zob.pr-handoff-workspace-snapshot.v1",
      repositoryRoot,
      workspaceRootHash: sha256Text(repositoryRoot),
      branchName,
      headSha,
      treeHash,
      contentHash: sha256Canonical({ schema: "wheel.zob.changed-content.v1", entries, bodyStored: false }),
      diffHash: sha256Canonical({ schema: "wheel.zob.working-diff.v1", entries, gitSemantics, bodyStored: false }),
      changedPaths,
      clean,
      linkedWorktree: true,
      sourceShaVerified: true,
      bodyStored: false,
    };
  }

  if (!input.baseSha || !GIT_OBJECT_ID.test(input.baseSha)) throw new Error("post-commit PR handoff requires a valid pre-commit base sha");
  if (headSha === input.baseSha) throw new Error("post-commit PR handoff requires a new exact head");
  if (!clean) throw new Error("post-commit PR handoff requires a clean story worktree");
  if (!gitSuccess(repositoryRoot, ["merge-base", "--is-ancestor", input.baseSha, headSha])) throw new Error("post-commit head does not descend from the authorized pre-commit base");
  changedPaths = parseWheelGitNulPaths(gitRaw(repositoryRoot, ["diff", "--name-only", "-z", input.baseSha, headSha]));
  if (changedPaths.length === 0) throw new Error("post-commit PR handoff has no changed paths relative to base");
  const entries = changedPathSnapshot(repositoryRoot, changedPaths);
  changedPaths = entries.map((entry) => entry.path);
  treeHash = git(repositoryRoot, ["rev-parse", `${headSha}^{tree}`]).trim();
  if (!GIT_OBJECT_ID.test(treeHash)) throw new Error("post-commit tree hash is invalid");
  const gitSemantics = {
    nameStatusHash: gitHash(repositoryRoot, ["diff", "--name-status", "-z", "-M", input.baseSha, headSha]),
    rawDiffHash: gitHash(repositoryRoot, ["diff", "--raw", "-z", "-M", "--full-index", input.baseSha, headSha]),
    binaryDiffHash: gitHash(repositoryRoot, ["diff", "--binary", "--full-index", "-M", input.baseSha, headSha]),
  };
  return {
    schema: "wheel.zob.pr-handoff-workspace-snapshot.v1",
    repositoryRoot,
    workspaceRootHash: sha256Text(repositoryRoot),
    branchName,
    headSha,
    treeHash,
    contentHash: sha256Canonical({ schema: "wheel.zob.changed-content.v1", entries, bodyStored: false }),
    diffHash: sha256Canonical({ schema: "wheel.zob.committed-diff.v1", baseSha: input.baseSha, headSha, entries, gitSemantics, bodyStored: false }),
    changedPaths,
    clean,
    linkedWorktree: true,
    sourceShaVerified: true,
    bodyStored: false,
  };
}
