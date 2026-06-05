#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const releaseBranch = "main";
const tagPrefix = "v";
const releasePriority = { none: 0, patch: 1, minor: 2, major: 3 };
const releaseTypes = { 0: "none", 1: "patch", 2: "minor", 3: "major" };
const jsonMode = process.argv.includes("--json");

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(detail);
  }

  return result.stdout;
}

function parseVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(String(raw).trim());
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: String(raw).trim(),
  };
}

function compareVersions(left, right) {
  return right.major - left.major || right.minor - left.minor || right.patch - left.patch;
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function bumpVersion(version, releaseType) {
  if (releaseType === "major") {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }

  if (releaseType === "minor") {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }

  if (releaseType === "patch") {
    return { major: version.major, minor: version.minor, patch: version.patch + 1 };
  }

  return version;
}

function reachableTag(tag) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", `refs/tags/${tag}`, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function latestReleaseTag() {
  const refs = runGit(["for-each-ref", "--format=%(refname:short)", "refs/tags"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((tag) => ({ tag, version: parseVersion(tag) }))
    .filter((entry) => entry.version)
    .filter((entry) => reachableTag(entry.tag))
    .sort((left, right) => compareVersions(left.version, right.version));

  return refs[0] ?? null;
}

function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const parsed = parseVersion(packageJson.version);
  if (!parsed) {
    throw new Error("package.json version must be a semver value for fallback preview");
  }
  return parsed;
}

function commitRange(latestTag) {
  return latestTag ? [`${latestTag.tag}..HEAD`] : ["HEAD"];
}

function readCommits(latestTag) {
  const args = ["log", "--format=%H%x00%B%x1e", ...commitRange(latestTag)];
  const raw = runGit(args);
  return raw
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, ...bodyParts] = entry.split("\x00");
      const body = bodyParts.join("\x00").trim();
      const header = body.split("\n").find((line) => line.trim())?.trim() ?? "";
      return { hash: hash.trim(), header, body };
    });
}

function analyzeCommit(commit) {
  const headerMatch = /^(?<type>[a-z]+)(?:\([^)]*\))?(?<breaking>!)?:\s+.+$/u.exec(commit.header);
  const breakingFooter = /^BREAKING[- ]CHANGE:\s+.+/imu.test(commit.body);

  if (breakingFooter || headerMatch?.groups?.breaking) {
    return { releaseType: "major", reason: "breaking change", commit };
  }

  const type = headerMatch?.groups?.type;
  if (type === "feat") {
    return { releaseType: "minor", reason: "feat commit", commit };
  }

  if (type === "fix" || type === "perf") {
    return { releaseType: "patch", reason: `${type} commit`, commit };
  }

  return { releaseType: "none", reason: type ? `${type} commit is non-releasing` : "non-conventional commit", commit };
}

function main() {
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const latestTag = latestReleaseTag();
  const baseVersion = latestTag?.version ?? readPackageVersion();
  const baseVersionSource = latestTag ? `tag ${latestTag.tag}` : "package.json version fallback; no reachable semver tag found";
  const commits = readCommits(latestTag);
  const analyses = commits.map(analyzeCommit);
  const topPriority = analyses.reduce((priority, analysis) => Math.max(priority, releasePriority[analysis.releaseType]), 0);
  const releaseType = releaseTypes[topPriority];
  const nextVersion = bumpVersion(baseVersion, releaseType);
  const willRelease = releaseType !== "none";
  const releasingReasons = analyses.filter((analysis) => analysis.releaseType !== "none");

  const summary = {
    releaseBranch,
    currentBranch: branch,
    branchWillTriggerCiRelease: branch === releaseBranch,
    baseVersion: formatVersion(baseVersion),
    baseVersionSource,
    latestTag: latestTag?.tag ?? null,
    commitsAnalyzed: commits.length,
    releaseType,
    nextVersion: willRelease ? `${tagPrefix}${formatVersion(nextVersion)}` : null,
    willCreateTagAfterSuccessfulCi: willRelease,
    willPublishNpmAfterSuccessfulCi: willRelease,
    reasons: releasingReasons.map((analysis) => ({
      releaseType: analysis.releaseType,
      reason: analysis.reason,
      commit: analysis.commit.hash.slice(0, 12),
      header: analysis.commit.header,
    })),
  };

  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("Release preview");
  console.log(`- release branch: ${summary.releaseBranch}`);
  console.log(`- current branch: ${summary.currentBranch}${summary.branchWillTriggerCiRelease ? "" : " (CI publish only runs after these commits land on main)"}`);
  console.log(`- base version: ${summary.baseVersion} (${summary.baseVersionSource})`);
  console.log(`- commits analyzed: ${summary.commitsAnalyzed}`);
  console.log(`- release type: ${summary.releaseType}`);

  if (willRelease) {
    console.log(`- next tag: ${summary.nextVersion}`);
    console.log("- npm publish: yes, after GitHub Actions validation passes");
    for (const reason of summary.reasons) {
      console.log(`  - ${reason.releaseType}: ${reason.header} (${reason.commit}, ${reason.reason})`);
    }
  } else {
    console.log("- next tag: none");
    console.log("- npm publish: no");
  }
}

try {
  main();
} catch (error) {
  console.error(`release preview FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
