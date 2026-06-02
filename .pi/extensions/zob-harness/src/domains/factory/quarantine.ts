import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FactoryQuarantineActivateInput, FactoryQuarantineActivateResult, FactoryQuarantineReviewInput, FactoryQuarantineReviewResult, FactoryQuarantineVerifyActivationInput, FactoryQuarantineVerifyActivationResult, FactoryRunResult } from "../../types.js";
import { sha256Hex } from "../../core/utils/hashing.js";
import { parseJsonFile, readJsonlRecords } from "../../core/utils/json.js";
import { safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";
import { runFactoryRun } from "./run.js";

export function runFactoryQuarantineReview(repoRoot: string, input: FactoryQuarantineReviewInput): FactoryQuarantineReviewResult {
  const runId = safeFileStem(input.run_id);
  const reviewId = safeFileStem(input.review_id ?? `review-${input.generated_factory}`);
  const generatedFactory = safeFileStem(input.generated_factory);
  const runDir = join(repoRoot, "reports", "factory-runs", runId);
  const reviewDir = join(runDir, "reviews", reviewId);
  const quarantineDir = join(runDir, "quarantine", generatedFactory);
  const registryDir = join(repoRoot, ".pi", "factories", generatedFactory);
  const errors: string[] = [];

  if (runId !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  if (input.review_id && reviewId !== input.review_id) errors.push(`review_id must be path-safe: ${input.review_id}`);
  if (generatedFactory !== input.generated_factory) errors.push(`generated_factory must be path-safe: ${input.generated_factory}`);

  const factoryJsonPath = join(quarantineDir, "factory.json");
  const smokeManifestPath = join(quarantineDir, "smoke-manifest.json");
  const readmePath = join(quarantineDir, "README.md");
  const validationPath = join(runDir, "validation.json");
  const sentinelPath = join(runDir, "DONE.sentinel");

  const localChecks: Array<Record<string, unknown>> = [
    { check: "run_dir_exists", passed: existsSync(runDir) },
    { check: "quarantine_factory_json_exists", passed: existsSync(factoryJsonPath) },
    { check: "quarantine_smoke_manifest_exists", passed: existsSync(smokeManifestPath) },
    { check: "quarantine_readme_exists", passed: existsSync(readmePath) },
    { check: "run_validation_exists", passed: existsSync(validationPath) },
    { check: "run_sentinel_exists", passed: existsSync(sentinelPath) },
  ];

  let quarantinedFactory: Record<string, unknown> | undefined;
  if (existsSync(factoryJsonPath)) {
    try {
      const parsed = parseJsonFile(factoryJsonPath);
      if (isRecord(parsed)) quarantinedFactory = parsed;
      else errors.push("quarantined factory.json is not an object");
    } catch (error) {
      errors.push(`could not parse quarantined factory.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let smokeManifest: Record<string, unknown> | undefined;
  if (existsSync(smokeManifestPath)) {
    try {
      const parsed = parseJsonFile(smokeManifestPath);
      if (isRecord(parsed)) smokeManifest = parsed;
      else errors.push("quarantined smoke-manifest.json is not an object");
    } catch (error) {
      errors.push(`could not parse quarantined smoke-manifest.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let validation: Record<string, unknown> | undefined;
  if (existsSync(validationPath)) {
    try {
      const parsed = parseJsonFile(validationPath);
      if (isRecord(parsed)) validation = parsed;
      else errors.push("run validation.json is not an object");
    } catch (error) {
      errors.push(`could not parse run validation.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const validationFactoryForge = isRecord(validation?.factoryForge) ? validation.factoryForge : undefined;
  const generatedFactoryRegistered = existsSync(registryDir);
  const semanticChecks = [
    { check: "factory_status_quarantined", passed: quarantinedFactory?.status === "quarantined" },
    { check: "factory_auto_activation_false", passed: quarantinedFactory?.autoActivation === false },
    { check: "factory_manual_activation_required", passed: quarantinedFactory?.manualActivationRequired === true },
    { check: "manifest_targets_generated_factory", passed: smokeManifest?.factory === generatedFactory },
    { check: "run_validation_passed", passed: validation?.status === "passed" },
    { check: "forge_validation_quarantined", passed: validationFactoryForge?.quarantineStatus === "quarantined" },
    { check: "forge_validation_no_registration", passed: validationFactoryForge?.generatedFactoryRegistered === false },
    { check: "registry_absent", passed: generatedFactoryRegistered === false },
  ];

  for (const check of [...localChecks, ...semanticChecks]) {
    if (check.passed !== true) errors.push(`local check failed: ${String(check.check)}`);
  }

  const oraclePassed = input.oracle_verdict === "PASS";
  const approvalPresent = Boolean(input.approval?.approvedBy && input.approval.approvedAt && input.approval.approvalId);
  const localChecksPassed = errors.length === 0;
  const activationReady = localChecksPassed && oraclePassed && approvalPresent;
  const status = activationReady ? "ready_for_manual_activation" : "review_required";
  const activationPerformed = false as const;
  const artifacts = ["review.json", "activation-readiness.json", "final-report.md"];

  mkdirSync(reviewDir, { recursive: true });
  const review = {
    schema: "zob.factory-quarantine-review.v1",
    runId,
    reviewId,
    generatedFactory,
    quarantinePath: `quarantine/${generatedFactory}`,
    status,
    activationReady,
    activationPerformed,
    generatedFactoryRegistered,
    localChecksPassed,
    oraclePassed,
    approvalPresent,
    oracleVerdict: input.oracle_verdict ?? "MISSING",
    approval: input.approval ?? null,
    localChecks: [...localChecks, ...semanticChecks],
    errors,
  };
  writeFileSync(join(reviewDir, "review.json"), JSON.stringify(review, null, 2), "utf8");
  writeFileSync(join(reviewDir, "activation-readiness.json"), JSON.stringify({
    schema: "zob.factory-activation-readiness.v1",
    runId,
    reviewId,
    generatedFactory,
    status,
    activationReady,
    activationPerformed,
    generatedFactoryRegistered,
    requiredForActivationReady: {
      localChecksPassed,
      oraclePassed,
      approvalPresent,
    },
  }, null, 2), "utf8");
  writeFileSync(join(reviewDir, "final-report.md"), [
    `# Factory Quarantine Review`,
    ``,
    `- runId: ${runId}`,
    `- reviewId: ${reviewId}`,
    `- generatedFactory: ${generatedFactory}`,
    `- status: ${status}`,
    `- activationReady: ${activationReady}`,
    `- activationPerformed: false`,
    `- generatedFactoryRegistered: ${generatedFactoryRegistered}`,
    ``,
  ].join("\n"), "utf8");

  return { runId, reviewId, reviewDir, status, activationReady, activationPerformed, generatedFactoryRegistered, localChecksPassed, oraclePassed, approvalPresent, artifacts, errors };
}

export function runFactoryQuarantineActivate(repoRoot: string, input: FactoryQuarantineActivateInput): FactoryQuarantineActivateResult {
  const runId = safeFileStem(input.run_id);
  const reviewId = safeFileStem(input.review_id);
  const generatedFactory = safeFileStem(input.generated_factory);
  const activationId = safeFileStem(input.activation_id ?? `activation-${reviewId}`);
  const runDir = join(repoRoot, "reports", "factory-runs", runId);
  const reviewDir = join(runDir, "reviews", reviewId);
  const readinessPath = join(reviewDir, "activation-readiness.json");
  const quarantineDir = join(runDir, "quarantine", generatedFactory);
  const targetDir = join(repoRoot, ".pi", "factories", generatedFactory);
  const journalPath = join(runDir, "activation-journal.jsonl");
  const confirmationExpected = `ACTIVATE QUARANTINED FACTORY ${generatedFactory} FROM RUN ${runId} REVIEW ${reviewId}`;
  const confirmationMatched = input.confirmation_phrase === confirmationExpected;
  const errors: string[] = [];
  const copiedFiles: string[] = [];

  if (runId !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  if (reviewId !== input.review_id) errors.push(`review_id must be path-safe: ${input.review_id}`);
  if (generatedFactory !== input.generated_factory) errors.push(`generated_factory must be path-safe: ${input.generated_factory}`);
  if (input.activation_id && activationId !== input.activation_id) errors.push(`activation_id must be path-safe: ${input.activation_id}`);
  if (!confirmationMatched) errors.push("confirmation_phrase did not match exact required phrase");
  if (existsSync(targetDir)) errors.push(`target factory already exists: .pi/factories/${generatedFactory}`);

  let readiness: Record<string, unknown> | undefined;
  if (!existsSync(readinessPath)) {
    errors.push(`activation-readiness.json not found for review: ${reviewId}`);
  } else {
    try {
      const parsed = parseJsonFile(readinessPath);
      if (isRecord(parsed)) readiness = parsed;
      else errors.push("activation-readiness.json is not an object");
    } catch (error) {
      errors.push(`could not parse activation-readiness.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (readiness) {
    if (readiness.runId !== runId) errors.push("activation-readiness.json runId does not match input run_id");
    if (readiness.reviewId !== reviewId) errors.push("activation-readiness.json reviewId does not match input review_id");
    if (readiness.generatedFactory !== generatedFactory) errors.push("activation-readiness.json generatedFactory does not match input generated_factory");
    if (readiness.activationReady !== true) errors.push("activation-readiness.json activationReady must be true");
    if (readiness.activationPerformed !== false) errors.push("activation-readiness.json activationPerformed must be false");
  }

  const allowlistedFiles = ["factory.json", "smoke-manifest.json", "README.md"];
  for (const file of allowlistedFiles) {
    const sourcePath = join(quarantineDir, file);
    if (!existsSync(sourcePath)) {
      errors.push(`quarantine allowlisted file missing: ${file}`);
      continue;
    }
    const stat = lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) errors.push(`quarantine allowlisted file must be a regular non-symlink file: ${file}`);
  }

  const status = errors.length === 0 ? "activated" : "failed_preflight";
  if (status === "activated") {
    mkdirSync(targetDir, { recursive: false });
    for (const file of allowlistedFiles) {
      copyFileSync(join(quarantineDir, file), join(targetDir, file));
      copiedFiles.push(file);
    }
  }

  if (runId === input.run_id) {
    mkdirSync(runDir, { recursive: true });
    appendFileSync(journalPath, `${JSON.stringify({
      schema: "zob.factory-quarantine-activation-journal.v1",
      event: "factory_quarantine_activate",
      activationId,
      runId,
      reviewId,
      generatedFactory,
      status,
      activationPerformed: status === "activated",
      confirmationMatched,
      confirmationHash: sha256Hex(input.confirmation_phrase),
      target: `.pi/factories/${generatedFactory}`,
      copiedFiles,
      errors,
      createdAt: new Date().toISOString(),
    })}\n`, "utf8");
  }

  return { runId, reviewId, activationId, generatedFactory, status, activationPerformed: status === "activated", confirmationMatched, targetDir, journalPath, copiedFiles, errors };
}

export function runFactoryQuarantineVerifyActivation(repoRoot: string, input: FactoryQuarantineVerifyActivationInput): FactoryQuarantineVerifyActivationResult {
  const runId = safeFileStem(input.run_id);
  const generatedFactory = safeFileStem(input.generated_factory);
  const activationId = safeFileStem(input.activation_id);
  const verificationId = safeFileStem(input.verification_id ?? `verify-${activationId}`);
  const runDir = join(repoRoot, "reports", "factory-runs", runId);
  const verificationDir = join(runDir, "verification", verificationId);
  const journalPath = join(runDir, "activation-verification-journal.jsonl");
  const activationJournalPath = join(runDir, "activation-journal.jsonl");
  const targetDir = join(repoRoot, ".pi", "factories", generatedFactory);
  const smokeManifest = `.pi/factories/${generatedFactory}/smoke-manifest.json`;
  const factoryRunId = `${runId}-${verificationId}-factory-run`;
  const factoryRunDir = join(repoRoot, "reports", "factory-runs", factoryRunId);
  const errors: string[] = [];
  const artifacts = ["verification.json", "factory-run-result.json", "final-report.md"];

  if (runId !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  if (generatedFactory !== input.generated_factory) errors.push(`generated_factory must be path-safe: ${input.generated_factory}`);
  if (activationId !== input.activation_id) errors.push(`activation_id must be path-safe: ${input.activation_id}`);
  if (input.verification_id && verificationId !== input.verification_id) errors.push(`verification_id must be path-safe: ${input.verification_id}`);

  const activationEntries = readJsonlRecords(activationJournalPath);
  const matchingActivation = activationEntries.find((entry) => entry.event === "factory_quarantine_activate" && entry.activationId === activationId && entry.runId === runId && entry.generatedFactory === generatedFactory && entry.status === "activated" && entry.activationPerformed === true);
  if (!matchingActivation) errors.push("matching successful activation journal entry not found");
  if (!existsSync(targetDir)) errors.push(`activated factory target not found: .pi/factories/${generatedFactory}`);
  if (!existsSync(join(targetDir, "factory.json"))) errors.push("activated factory.json not found");
  if (!existsSync(join(targetDir, "smoke-manifest.json"))) errors.push("activated smoke-manifest.json not found");
  if (!existsSync(join(targetDir, "README.md"))) errors.push("activated README.md not found");
  if (existsSync(factoryRunDir)) errors.push(`Verification factory_run directory already exists: ${factoryRunDir}`);

  let factoryRunResult: FactoryRunResult | undefined;
  if (errors.length === 0) {
    factoryRunResult = runFactoryRun(repoRoot, { factory: generatedFactory, input_manifest: smokeManifest, run_id: factoryRunId, mode: "smoke", execution: "deterministic" });
    if (factoryRunResult.status !== "done") errors.push(`deterministic factory_run smoke did not complete: ${factoryRunResult.status}`);
    errors.push(...factoryRunResult.errors);
  }

  const status: FactoryQuarantineVerifyActivationResult["status"] = errors.length > 0 ? (factoryRunResult ? "failed_verification" : "failed_preflight") : "verified";
  mkdirSync(verificationDir, { recursive: true });
  const verification = {
    schema: "zob.factory-quarantine-activation-verification.v1",
    runId,
    activationId,
    verificationId,
    generatedFactory,
    status,
    activationJournalPath,
    matchingActivationFound: Boolean(matchingActivation),
    deterministicFactoryRun: factoryRunResult ?? null,
    requiredFactoryRun: { factory: generatedFactory, input_manifest: smokeManifest, run_id: factoryRunId, mode: "smoke", execution: "deterministic" },
    errors,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(verificationDir, "verification.json"), JSON.stringify(verification, null, 2), "utf8");
  writeFileSync(join(verificationDir, "factory-run-result.json"), JSON.stringify(factoryRunResult ?? null, null, 2), "utf8");
  writeFileSync(join(verificationDir, "final-report.md"), [
    `# Factory Activation Verification`,
    ``,
    `- runId: ${runId}`,
    `- activationId: ${activationId}`,
    `- verificationId: ${verificationId}`,
    `- generatedFactory: ${generatedFactory}`,
    `- status: ${status}`,
    `- factoryRunId: ${factoryRunId}`,
    `- deterministicFactoryRunStatus: ${factoryRunResult?.status ?? "not-run"}`,
    ``,
  ].join("\n"), "utf8");
  appendFileSync(journalPath, `${JSON.stringify({
    schema: "zob.factory-quarantine-activation-verification-journal.v1",
    event: "factory_quarantine_verify_activation",
    runId,
    activationId,
    verificationId,
    generatedFactory,
    status,
    matchingActivationFound: Boolean(matchingActivation),
    factoryRunId,
    factoryRunStatus: factoryRunResult?.status ?? "not-run",
    errors,
    createdAt: new Date().toISOString(),
  })}\n`, "utf8");

  return { runId, activationId, verificationId, generatedFactory, status, verificationDir, journalPath, factoryRunId, factoryRunDir, artifacts, errors };
}
