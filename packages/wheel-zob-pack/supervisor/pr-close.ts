import { sha256Canonical, sha256Text } from "./canonical.js";
import type {
  WheelPrCloseAuditResult,
  WheelPrCloseAuditType,
  WheelPrCloseEvidence,
  WheelSupervisorAttempt,
  WheelSupervisorMissionState,
  WheelSupervisorRole,
  WheelSupervisorStoryState,
} from "./types.js";

const AUDIT_ROLE: Readonly<Record<WheelPrCloseAuditType, WheelSupervisorRole>> = Object.freeze({
  "source-integration": "pr-close-source-audit",
  "evidence-qa-ci": "pr-close-evidence-audit",
  finalizer: "pr-close",
});

function acceptedAttempt(story: WheelSupervisorStoryState, role: WheelSupervisorRole): WheelSupervisorAttempt {
  const attempt = [...story.attempts].reverse().find((candidate) => candidate.role === role && candidate.status === "accepted" && candidate.headSha === story.workspace?.headSha);
  if (!attempt || !attempt.outputHash) throw new Error(`${story.storyId}: accepted ${role} attempt is missing`);
  return attempt;
}

function auditResult(
  story: WheelSupervisorStoryState,
  auditType: WheelPrCloseAuditType,
  headSha: string,
): WheelPrCloseAuditResult {
  const attempt = acceptedAttempt(story, AUDIT_ROLE[auditType]);
  return {
    auditType,
    assignmentId: attempt.assignmentId,
    attemptId: attempt.attemptId,
    routeIdHash: sha256Text(attempt.routeId),
    headSha,
    verdict: "pass",
    evidenceRefs: story.evidence.filter((evidence) => evidence.status === "current").map((evidence) => evidence.evidenceId),
    outputHash: attempt.outputHash as string,
    bodyStored: false,
  };
}

function evidenceHashInput(evidence: Omit<WheelPrCloseEvidence, "evidenceHash"> | WheelPrCloseEvidence) {
  const { evidenceHash: _evidenceHash, ...input } = evidence as WheelPrCloseEvidence;
  return input;
}

export function computeWheelPrCloseEvidenceHash(
  evidence: Omit<WheelPrCloseEvidence, "evidenceHash"> | WheelPrCloseEvidence,
): string {
  return sha256Canonical(evidenceHashInput(evidence));
}

export function buildWheelPrCloseEvidence(
  state: WheelSupervisorMissionState,
  story: WheelSupervisorStoryState,
): WheelPrCloseEvidence {
  if (!story.workspace?.headSha) throw new Error(`${story.storyId}: workspace head is missing`);
  if (!story.pullRequest || story.pullRequest.state !== "open" || !story.pullRequest.isDraft) throw new Error(`${story.storyId}: current draft pull request is missing`);
  if (story.pullRequest.headSha !== story.workspace.headSha) throw new Error(`${story.storyId}: workspace and pull request heads differ`);
  const headSha = story.workspace.headSha;
  const auditResults = [
    auditResult(story, "source-integration", headSha),
    auditResult(story, "evidence-qa-ci", headSha),
    auditResult(story, "finalizer", headSha),
  ] as [WheelPrCloseAuditResult, WheelPrCloseAuditResult, WheelPrCloseAuditResult];
  const withoutHash: Omit<WheelPrCloseEvidence, "evidenceHash"> = {
    schema: "wheel.zob.supervisor-pr-close-evidence.v1",
    missionId: state.missionId,
    storyId: story.storyId,
    storyRevision: story.revision,
    manifestHash: story.manifestHash,
    branchName: story.workspace.branchName,
    baseRef: "develop-staging",
    baseSha: story.workspace.baseSha,
    headSha,
    pullRequestId: story.pullRequest.pullRequestId,
    draftRequired: true,
    terminalAcceptable: true,
    auditResults,
    requiredCheckNames: state.checkPolicy.requiredCiChecks.map((check) => check.name),
    observedCheckIds: story.externalSnapshot?.checks
      .filter((check) => check.headSha === headSha && check.status === "completed" && check.conclusion === "success")
      .map((check) => check.checkId) ?? [],
    bodyStored: false,
  };
  return { ...withoutHash, evidenceHash: computeWheelPrCloseEvidenceHash(withoutHash) };
}

export function validateWheelPrCloseEvidence(
  evidence: WheelPrCloseEvidence,
  state: WheelSupervisorMissionState,
  story: WheelSupervisorStoryState,
): string[] {
  const issues: string[] = [];
  if (evidence.schema !== "wheel.zob.supervisor-pr-close-evidence.v1") issues.push("unsupported PR-close evidence schema");
  if (evidence.bodyStored !== false) issues.push("PR-close evidence must be body-free");
  if (evidence.missionId !== state.missionId || evidence.storyId !== story.storyId) issues.push("PR-close identity mismatch");
  if (evidence.storyRevision !== story.revision || evidence.manifestHash !== story.manifestHash) issues.push("PR-close manifest binding mismatch");
  if (evidence.baseRef !== "develop-staging" || evidence.draftRequired !== true) issues.push("PR-close branch contract mismatch");
  if (!story.workspace || evidence.baseSha !== story.workspace.baseSha || evidence.headSha !== story.workspace.headSha) issues.push("PR-close workspace head/base mismatch");
  if (!story.pullRequest || evidence.pullRequestId !== story.pullRequest.pullRequestId || !story.pullRequest.isDraft || story.pullRequest.state !== "open") issues.push("PR-close draft pull request mismatch");
  const types = evidence.auditResults.map((audit) => audit.auditType);
  if (new Set(types).size !== 3 || !["source-integration", "evidence-qa-ci", "finalizer"].every((type) => types.includes(type as WheelPrCloseAuditType))) {
    issues.push("PR-close requires exactly one source, evidence, and finalizer audit");
  }
  if (new Set(evidence.auditResults.map((audit) => audit.attemptId)).size !== 3) issues.push("PR-close audit attempts must be distinct");
  if (new Set(evidence.auditResults.map((audit) => audit.assignmentId)).size !== 3) issues.push("PR-close audit assignments must be distinct");
  if (evidence.auditResults.some((audit) => audit.verdict !== "pass" || audit.headSha !== evidence.headSha)) issues.push("PR-close audits must pass on the exact head");
  if (!evidence.terminalAcceptable) issues.push("PR-close terminal state is not acceptable");
  const observedChecks = story.externalSnapshot?.checks ?? [];
  for (const required of state.checkPolicy.requiredCiChecks) {
    const matching = observedChecks.find((check) => check.name === required.name && check.issuerHash === required.issuerHash && check.headSha === evidence.headSha);
    if (!matching || matching.status !== "completed" || matching.conclusion !== "success" || !evidence.observedCheckIds.includes(matching.checkId)) {
      issues.push(`required CI check ${required.name} is missing or invalid`);
    }
  }
  if (computeWheelPrCloseEvidenceHash(evidence) !== evidence.evidenceHash) issues.push("PR-close evidence hash mismatch");
  return issues;
}

export function validateWheelPrCloseTerminal(
  state: WheelSupervisorMissionState,
  story: WheelSupervisorStoryState,
): string[] {
  if (!story.prCloseEvidence) return ["PR-close evidence is missing"];
  const issues = validateWheelPrCloseEvidence(story.prCloseEvidence, state, story);
  const required = state.checkPolicy.prCloseCheck;
  const matching = story.externalSnapshot?.checks.find((check) =>
    check.name === required.name
    && check.issuerHash === required.issuerHash
    && check.headSha === story.prCloseEvidence?.headSha);
  if (!matching || matching.status !== "completed" || matching.conclusion !== "success") {
    issues.push(`PR-close check ${required.name} is missing or invalid`);
  }
  if (!story.pullRequest?.labels.includes(state.checkPolicy.completionLabel)) issues.push("completion label is missing");
  return issues;
}
