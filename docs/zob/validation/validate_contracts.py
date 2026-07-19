#!/usr/bin/env python3
"""Validate Wheel ZOB design schemas, examples and cross-contract invariants.

This validator is local, body-safe and performs no network or GitHub effects.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "schemas"
EXAMPLES = ROOT / "examples"


@dataclass(frozen=True)
class ContractSuite:
    schemas: dict[str, dict[str, Any]]
    examples: dict[str, dict[str, Any]]


@dataclass(frozen=True)
class PromotionContracts:
    candidate: dict[str, Any]
    repair: dict[str, Any]
    assurance: dict[str, Any]
    authorization: dict[str, Any]
    merge: dict[str, Any]
    window_ack: dict[str, Any]
    merge_ack: dict[str, Any]


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def schema_errors(schema: dict[str, Any], document: dict[str, Any]) -> list[str]:
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    return [f"{list(error.path)}: {error.message}" for error in validator.iter_errors(document)]


def validate_coverage(document: dict[str, Any]) -> None:
    elements = document["elements"]
    counts = document["counts"]
    ids = [item["elementId"] for item in elements]
    check(len(ids) == len(set(ids)), "coverage element IDs are not unique")
    check(counts["total"] == len(elements), "coverage total differs from element count")
    check(counts["disposed"] == len(elements), "coverage disposed differs from element count")
    mapping = {
        "canonical-documented": "canonicalDocumented",
        "intentionally-internal": "intentionallyInternal",
        "test-only": "testOnly",
        "generated": "generated",
        "vendor": "vendor",
        "deprecated-or-superseded": "deprecatedOrSuperseded",
        "missing-documentation": "missingDocumentation",
        "unknown-or-unresolved": "unknownOrUnresolved",
    }
    for disposition, count_key in mapping.items():
        actual = sum(item["disposition"] == disposition for item in elements)
        check(counts[count_key] == actual, f"coverage count drift for {disposition}")
    check(sum(counts[key] for key in mapping.values()) == counts["total"], "coverage disposition sum drift")
    check(counts["duplicateElementIds"] == 0, "coverage reports duplicate IDs")
    for item in elements:
        if item["publicOperational"]:
            check(item["disposition"] == "canonical-documented", f"public element {item['elementId']} is not canonical-documented")
            check(bool(item.get("docRefs")), f"public element {item['elementId']} lacks a canonical-doc mapping")


def validate_assurance(document: dict[str, Any]) -> None:
    lanes = document["laneResults"]
    check(len(lanes) == 10, "assurance must contain exactly ten named lanes")
    independence = document["modelIndependence"]
    used_families = {lane["familyOpaqueId"] for lane in lanes.values()}
    check(independence["usedFamilyCount"] == len(used_families), "used family count drift")
    check(independence["usedFamilyCount"] <= independence["eligibleFamilyCount"], "used family count exceeds eligible families")
    if independence["eligibleFamilyCount"] >= 3:
        check(len(used_families) >= 3, "three eligible model families were not used")
    else:
        check(independence["degraded"], "family shortage was not marked degraded")
        check(bool(independence.get("degradationReasonHash")), "degraded assurance lacks reason hash")
    docs = document["topDownDocs"]
    check(docs["assignedCount"] == docs["current"] + docs["evidenceBound"] + docs["stale"] + docs["pending"], "top-down document count drift")
    coverage = document["bottomUpCoverage"]
    check(coverage["total"] == coverage["disposed"], "assurance coverage is not fully dispositioned")
    if document["verdict"] == "pass":
        check(not document["noShip"], "passing assurance has noShip=true")
        check(all(lane["result"] == "pass" for lane in lanes.values()), "passing assurance has a non-pass lane")
        check(docs["stale"] == docs["pending"] == docs["duplicateAssignments"] == 0, "passing assurance has doc gaps")
        check(coverage["status"] == "complete-clean", "passing assurance has non-clean coverage")
        check(coverage["missingDocumentation"] == coverage["unknownOrUnresolved"] == coverage["duplicateElementIds"] == 0, "passing assurance has source/doc gaps")
        check(document["findings"]["blocking"] == 0, "passing assurance has blocking findings")
    else:
        check(document["noShip"], "non-pass assurance has noShip=false")


def validate_repair(document: dict[str, Any]) -> None:
    check(set(document["auditorAssignmentIds"]).isdisjoint(document["repairerAssignmentIds"]), "auditor and repairer assignments overlap")
    check(document["round"] <= 2, "repair follows round three or later")
    check(document["nextAssuranceRound"] == document["round"] + 1, "repair next assurance round is not sequential")
    check(document["beforeCandidateRevision"] == document["round"], "repair before-candidate revision drift")
    check(document["afterCandidateRevision"] == document["round"] + 1, "repair after-candidate revision drift")
    check(document["assuranceId"] in document["invalidatedAssuranceIds"], "repair did not invalidate its input assurance")
    if document["status"] == "reaudit-required":
        integration = document["fullStagingIntegration"]
        check(integration["result"] == "pass", "re-audit requested before full staging CI passed")
        check(integration["headSha"] == document["afterStagingSha"], "repair integration head differs from repaired staging head")


def validate_candidate_hash_chain(candidate: dict[str, Any]) -> None:
    cursor = candidate["initialStagingSha"]
    prior_result_hash: str | None = None
    for expected_round, lineage in enumerate(candidate["repairLineage"], start=1):
        check(lineage["repairRound"] == expected_round, "repair lineage round is not sequential")
        check(lineage["beforeStagingSha"] == cursor, "repair lineage before-SHA gap")
        if prior_result_hash is not None:
            check(lineage["priorCandidateHash"] == prior_result_hash, "candidate hash-chain gap")
        cursor, prior_result_hash = lineage["afterStagingSha"], lineage["resultingCandidateHash"]
    check(cursor == candidate["stagingSha"], "repair lineage does not reach current staging SHA")
    if not candidate["repairLineage"]:
        return
    last = candidate["repairLineage"][-1]
    check(candidate["priorCandidateHash"] == last["priorCandidateHash"], "candidate prior hash mismatch")
    check(candidate["artifactHashes"]["candidate"] == last["resultingCandidateHash"], "candidate result hash mismatch")


def validate_repair_entries(candidate: dict[str, Any], repair: dict[str, Any]) -> None:
    lineage_prs = {pr for item in candidate["repairLineage"] for pr in item["repairPrNumbers"]}
    included = {pr["prNumber"]: pr for pr in candidate["includedPullRequests"] if pr["origin"] == "assurance-repair"}
    repair_entries = {pr["prNumber"]: pr for pr in repair["repairPullRequests"]}
    check(lineage_prs == set(included) == set(repair_entries), "candidate repair PR set mismatch")
    for pr_number, repair_entry in repair_entries.items():
        candidate_entry = included[pr_number]
        check(candidate_entry["prHeadSha"] == repair_entry["headSha"], "repair PR head mismatch")
        check(candidate_entry["stagingMergeSha"] == repair_entry["stagingMergeSha"], "repair merge SHA mismatch")
    repair_line = candidate["repairLineage"][repair["round"] - 1]
    check(repair["beforeCandidateHash"] == repair_line["priorCandidateHash"], "repair before-candidate hash mismatch")
    check(repair["afterCandidateHash"] == repair_line["resultingCandidateHash"], "repair after-candidate hash mismatch")
    check(set(repair["findingRefs"]) == set(repair_line["findingRefs"]), "repair finding lineage mismatch")
    check(repair["fullStagingIntegration"]["checkId"] == repair_line["integrationCheckId"], "repair integration Check lineage mismatch")


def validate_candidate_lineage(contracts: PromotionContracts) -> None:
    candidate, repair, assurance = contracts.candidate, contracts.repair, contracts.assurance
    freeze = candidate["freeze"]
    check(candidate["windowId"] == freeze["windowId"], "candidate/freeze window mismatch")
    check(candidate["initialStagingSha"] == freeze["windowInitialStagingSha"], "window initial staging SHA mismatch")
    check(candidate["candidateRevision"] == len(candidate["repairLineage"]) + 1, "candidate revision/repair count drift")
    pr_numbers = [entry["prNumber"] for entry in candidate["includedPullRequests"]]
    check(len(pr_numbers) == len(set(pr_numbers)), "candidate contains duplicate PR numbers")
    check(candidate["includedPullRequests"][-1]["stagingMergeSha"] == candidate["stagingSha"], "candidate current head is not final included merge")
    validate_candidate_hash_chain(candidate)
    validate_repair_entries(candidate, repair)
    check(repair["candidateId"] == candidate["candidateId"], "repair references wrong candidate")
    check(assurance["candidateId"] == candidate["candidateId"], "assurance references wrong candidate")
    check(assurance["candidateRevision"] == candidate["candidateRevision"], "assurance candidate revision mismatch")
    check(assurance["candidateHash"] == candidate["artifactHashes"]["candidate"], "assurance candidate hash mismatch")
    check(repair["afterStagingSha"] == assurance["stagingSha"], "repair result differs from next assurance head")
    check(repair["nextAssuranceRound"] == assurance["round"], "repair does not lead to recorded assurance round")
    check(repair["repairRoundId"] in assurance.get("repairRoundIds", []), "assurance omits repair round lineage")


def validate_receipt_authorization(contracts: PromotionContracts) -> None:
    candidate, assurance, authorization = contracts.candidate, contracts.assurance, contracts.authorization
    window_ack, merge_ack = contracts.window_ack, contracts.merge_ack
    check(window_ack["scope"]["windowId"] == candidate["windowId"] == authorization["windowId"], "promotion-window ID mismatch")
    check(window_ack["scope"]["stagingSha"] == candidate["initialStagingSha"], "window receipt does not bind initial staging SHA")
    initial_hash = candidate["repairLineage"][0]["priorCandidateHash"] if candidate["repairLineage"] else candidate["artifactHashes"]["candidate"]
    check(window_ack["scope"]["candidateHash"] == initial_hash, "window receipt does not bind initial candidate hash")
    check(window_ack["scope"]["candidateRevision"] == 1, "window receipt does not bind initial candidate revision")
    check(authorization["candidateId"] == candidate["candidateId"], "authorization references wrong candidate")
    check(authorization["candidateRevision"] == candidate["candidateRevision"], "authorization candidate revision mismatch")
    check(authorization["candidateHash"] == candidate["artifactHashes"]["candidate"], "authorization candidate hash mismatch")
    check(merge_ack["scope"]["candidateId"] == candidate["candidateId"], "merge receipt candidate mismatch")
    check(merge_ack["scope"]["candidateRevision"] == candidate["candidateRevision"], "merge receipt candidate revision mismatch")
    check(merge_ack["scope"]["candidateHash"] == candidate["artifactHashes"]["candidate"], "merge receipt candidate hash mismatch")
    candidate_prs = {entry["prNumber"] for entry in candidate["includedPullRequests"]}
    check(set(authorization["includedPrNumbers"]) == candidate_prs, "authorization included PR set differs from candidate")
    check(authorization["assurance"]["assuranceId"] == assurance["assuranceId"], "authorization references wrong assurance")
    check(authorization["assurance"]["resultHash"] == assurance["resultHash"], "authorization assurance hash mismatch")
    check(authorization["windowReceiptHash"] == window_ack["receiptHash"], "promotion-window receipt mismatch")
    check(authorization["promotionMergeReceiptHash"] == merge_ack["receiptHash"], "promotion-merge receipt mismatch")


def validate_merge_proof(contracts: PromotionContracts) -> None:
    candidate, authorization, merge = contracts.candidate, contracts.authorization, contracts.merge
    check(authorization["deploymentImpact"]["classification"] != "unknown-blocked", "active promotion has unknown deployment impact")
    check(not authorization["deploymentImpact"]["manualDispatchAuthorized"], "promotion authorizes manual dispatch")
    check(merge["authorizationId"] == authorization["authorizationId"], "merge evidence authorization ID mismatch")
    check(merge["windowId"] == candidate["windowId"], "merge evidence window mismatch")
    check(merge["candidateId"] == candidate["candidateId"], "merge evidence candidate mismatch")
    check(merge["candidateRevision"] == candidate["candidateRevision"], "merge evidence candidate revision mismatch")
    check(merge["candidateHash"] == candidate["artifactHashes"]["candidate"], "merge evidence candidate hash mismatch")
    check(merge["authorizationHash"] == authorization["authorizationHash"], "merge evidence authorization hash mismatch")
    check(merge["parents"]["developParentSha"] == merge["developBaseSha"], "develop parent mismatch")
    check(merge["parents"]["auditedStagingParentSha"] == merge["stagingSha"], "audited staging is not the recorded parent")
    check(merge["treeProof"]["promotionTreeHash"] == merge["treeProof"]["auditedStagingTreeHash"], "promotion tree differs from audited staging")
    check(not merge["manualDispatchPerformed"], "manual deployment dispatch was performed")


def validate_cd_correlation(authorization: dict[str, Any], merge: dict[str, Any]) -> None:
    if authorization["deploymentImpact"]["classification"] == "automatic-cd-expected":
        check(bool(merge["automaticCdRuns"]), "expected automatic CD run was not observed")
    for run in merge["automaticCdRuns"]:
        check(run["triggerEvent"] == "push" and run["triggerSha"] == merge["promotionMergeSha"], "CD run trigger mismatch")
        if run["status"] == "completed":
            check("conclusion" in run, "completed CD run lacks conclusion")


def validate_reconciliation(merge: dict[str, Any]) -> None:
    reconciliation = merge["reconciliation"]
    alignment, aligned_ci = reconciliation["stagingAlignment"], reconciliation["alignedHeadIntegration"]
    check(reconciliation["inputMergeSha"] == merge["promotionMergeSha"], "reconciliation input differs from promotion merge")
    check(alignment["expectedOldSha"] == merge["stagingSha"], "staging alignment expected-old mismatch")
    check(alignment["newSha"] == merge["promotionMergeSha"], "staging alignment new SHA mismatch")
    check(aligned_ci["headSha"] == alignment["newSha"], "aligned-head CI is bound to wrong SHA")
    if reconciliation["queueUnfrozen"]:
        check(reconciliation["result"] == "pass" and alignment["result"] == "fast-forwarded" and aligned_ci["result"] == "pass", "queue unfroze before reconciliation/alignment/CI passed")


def validate_promotion(contracts: PromotionContracts) -> None:
    candidate, assurance, authorization, merge = contracts.candidate, contracts.assurance, contracts.authorization, contracts.merge
    validate_candidate_lineage(contracts)
    check(candidate["stagingSha"] == assurance["stagingSha"] == authorization["stagingSha"] == merge["stagingSha"], "staging SHA lineage mismatch")
    check(candidate["developSha"] == assurance["developSha"] == authorization["developSha"] == merge["developBaseSha"], "develop SHA lineage mismatch")
    validate_receipt_authorization(contracts)
    validate_merge_proof(contracts)
    validate_cd_correlation(authorization, merge)
    validate_reconciliation(merge)


def expect_schema_reject(schemas: dict[str, dict[str, Any]], token: str, document: dict[str, Any], label: str) -> None:
    check(bool(schema_errors(schemas[token], document)), f"negative schema fixture unexpectedly passed: {label}")


def expect_semantic_reject(action: Callable[[], None], label: str) -> None:
    try:
        action()
    except AssertionError:
        return
    raise AssertionError(f"negative semantic fixture unexpectedly passed: {label}")


def load_suite() -> ContractSuite:
    schema_paths = sorted(SCHEMAS.glob("*.schema.json"))
    schemas: dict[str, dict[str, Any]] = {}
    for path in schema_paths:
        schema = load(path)
        Draft202012Validator.check_schema(schema)
        token = schema.get("properties", {}).get("schema", {}).get("const")
        if token:
            check(token not in schemas, f"duplicate schema token {token}")
            schemas[token] = schema
    print(f"META_SCHEMA_PASS schemas={len(schema_paths)}")

    example_paths = sorted(EXAMPLES.glob("*.example.json"))
    examples: dict[str, dict[str, Any]] = {}
    for path in example_paths:
        document = load(path)
        token = document.get("schema")
        check(token in schemas, f"{path.name} references unknown schema {token}")
        errors = schema_errors(schemas[token], document)
        check(not errors, f"{path.name} failed schema validation: {'; '.join(errors)}")
        examples[path.name] = document
    print(f"EXAMPLE_SCHEMA_PASS examples={len(example_paths)}")
    return ContractSuite(schemas=schemas, examples=examples)


def promotion_contracts(examples: dict[str, dict[str, Any]]) -> PromotionContracts:
    return PromotionContracts(
        candidate=examples["staging-candidate.example.json"],
        repair=examples["assurance-repair-round.example.json"],
        assurance=examples["repository-assurance-result.example.json"],
        authorization=examples["promotion-authorization.example.json"],
        merge=examples["promotion-merge-evidence.example.json"],
        window_ack=examples["promotion-window-ack-receipt.example.json"],
        merge_ack=examples["promotion-merge-ack-receipt.example.json"],
    )


def validate_positive_contracts(suite: ContractSuite, contracts: PromotionContracts) -> None:
    schemas, examples = suite.schemas, suite.examples
    ack_enum = schemas["zob.ack-receipt.v1"]["properties"]["ackType"]["enum"]
    profile_enum = schemas["zob.execution-profile.v1"]["properties"]["humanReceiptTypes"]["items"]["enum"]
    check(ack_enum == profile_enum, "ACK receipt enum differs from execution-profile enum")
    profile_actions = set(schemas["zob.execution-profile.v1"]["properties"]["deferredActions"]["items"]["enum"])
    mission_actions = set(schemas["zob.mission.v1"]["properties"]["completion"]["properties"]["forbiddenActions"]["items"]["enum"])
    story_actions = set(schemas["zob.story-execution.v1"]["properties"]["deferredActions"]["items"]["enum"])
    check("workflow-dispatch" in profile_actions, "execution profile does not defer workflow dispatch")
    check(story_actions < profile_actions == mission_actions, "deferred-action layer relationship drift")
    active_contracts = ["mission.example.json", "story-execution.example.json", "pr-close-evidence.example.json", "blind-review-result.example.json"]
    for name in active_contracts:
        check("develop-staging" in json.dumps(examples[name]), f"active contract {name} does not target staging")
    legacy = examples["merge-authorization.example.json"]
    check(legacy["migrationReadOnly"] and legacy["migrationDisposition"] == "historical-only", "legacy merge fixture is not read-only")
    print("ENUM_BRANCH_PARITY_PASS")

    candidate = contracts.candidate
    check(candidate["includedPullRequests"][-1]["stagingMergeSha"] == candidate["stagingSha"], "candidate final staging merge differs from frozen head")
    check(candidate["integration"]["result"] == "pass", "candidate froze before full staging integration passed")
    check(candidate["integration"]["deploymentDisabledProof"]["stagingCanTriggerDeployment"] is False, "staging deployment is enabled")
    validate_coverage(examples["source-doc-coverage.example.json"])
    validate_assurance(contracts.assurance)
    validate_repair(examples["assurance-repair-round.example.json"])
    validate_promotion(contracts)
    print("STAGING_ASSURANCE_PROMOTION_SEMANTICS_PASS")


def validate_negative_assurance(schemas: dict[str, dict[str, Any]], coverage: dict[str, Any], assurance: dict[str, Any]) -> None:
    bad = copy.deepcopy(coverage)
    del bad["elements"][0]["docRefs"]
    expect_schema_reject(schemas, bad["schema"], bad, "public element without doc mapping")
    bad = copy.deepcopy(coverage)
    bad["counts"]["total"] += 1
    expect_semantic_reject(lambda: validate_coverage(bad), "coverage count drift")
    bad = copy.deepcopy(assurance)
    bad["topDownDocs"]["stale"] = 1
    expect_schema_reject(schemas, bad["schema"], bad, "passing assurance with stale docs")
    bad = copy.deepcopy(assurance)
    del bad["laneResults"]["security-privacy"]
    expect_schema_reject(schemas, bad["schema"], bad, "assurance missing mandatory lane")
    bad = copy.deepcopy(assurance)
    bad["modelIndependence"]["usedFamilyCount"] = 2
    for lane in bad["laneResults"].values():
        lane["familyOpaqueId"] = "family-A"
    expect_schema_reject(schemas, bad["schema"], bad, "three eligible families not used")
    bad = copy.deepcopy(assurance)
    bad["modelIndependence"].update({"eligibleFamilyCount": 2, "degraded": True, "degradationReasonHash": "0" * 64})
    expect_semantic_reject(lambda: validate_assurance(bad), "used family count exceeds eligible families")
    bad = copy.deepcopy(assurance)
    bad["modelIndependence"].update({"eligibleFamilyCount": 2, "usedFamilyCount": 2, "degraded": False})
    expect_schema_reject(schemas, bad["schema"], bad, "family shortage marked undegraded")
    bad = copy.deepcopy(assurance)
    bad.update({"verdict": "blocked", "noShip": False})
    expect_schema_reject(schemas, bad["schema"], bad, "non-pass assurance with noShip false")


def validate_negative_repair(schemas: dict[str, dict[str, Any]], repair: dict[str, Any]) -> None:
    bad = copy.deepcopy(repair)
    bad["repairerAssignmentIds"].append(bad["auditorAssignmentIds"][0])
    expect_semantic_reject(lambda: validate_repair(bad), "auditor repairs its own finding")
    bad = copy.deepcopy(repair)
    bad.update({"round": 3, "nextAssuranceRound": 3})
    expect_schema_reject(schemas, bad["schema"], bad, "repair after assurance round three")
    bad = copy.deepcopy(repair)
    bad["nextAssuranceRound"] = 3
    expect_semantic_reject(lambda: validate_repair(bad), "non-sequential next assurance round")


def validate_negative_promotion(schemas: dict[str, dict[str, Any]], contracts: PromotionContracts) -> None:
    bad = copy.deepcopy(contracts.authorization)
    bad["mergeMethod"] = "squash"
    expect_schema_reject(schemas, bad["schema"], bad, "squash promotion")
    bad = copy.deepcopy(contracts.authorization)
    bad["deploymentImpact"]["classification"] = "unknown-blocked"
    expect_schema_reject(schemas, bad["schema"], bad, "active promotion with unknown impact")
    bad = copy.deepcopy(contracts.merge)
    bad["parents"]["auditedStagingParentSha"] = "ffffffffffffffffffffffffffffffffffffffff"
    expect_semantic_reject(lambda: validate_promotion(replace(contracts, merge=bad)), "wrong staging parent")
    bad = copy.deepcopy(contracts.merge)
    bad["manualDispatchPerformed"] = True
    expect_schema_reject(schemas, bad["schema"], bad, "manual workflow dispatch")
    bad = copy.deepcopy(contracts.merge)
    bad["reconciliation"]["stagingAlignment"]["result"] = "blocked"
    expect_schema_reject(schemas, bad["schema"], bad, "queue unfreeze before staging alignment")
    bad = copy.deepcopy(contracts.merge)
    bad["reconciliation"]["alignedHeadIntegration"]["result"] = "fail"
    expect_schema_reject(schemas, bad["schema"], bad, "queue unfreeze before aligned-head CI")
    bad = copy.deepcopy(contracts.merge)
    bad["automaticCdRuns"] = []
    expect_semantic_reject(lambda: validate_promotion(replace(contracts, merge=bad)), "expected automatic CD run missing")
    bad = copy.deepcopy(contracts.merge)
    bad["automaticCdRuns"][0]["status"] = "completed"
    bad["automaticCdRuns"][0].pop("conclusion", None)
    expect_schema_reject(schemas, bad["schema"], bad, "completed CD run without conclusion")
    bad_candidate = copy.deepcopy(contracts.candidate)
    bad_candidate["includedPullRequests"][1]["prNumber"] = bad_candidate["includedPullRequests"][0]["prNumber"]
    expect_semantic_reject(lambda: validate_promotion(replace(contracts, candidate=bad_candidate)), "duplicate candidate PR number")
    bad_candidate = copy.deepcopy(contracts.candidate)
    bad_candidate["includedPullRequests"][-1]["prNumber"] = 4111
    expect_semantic_reject(lambda: validate_promotion(replace(contracts, candidate=bad_candidate)), "candidate repair PR-set mismatch")
    bad_ack = copy.deepcopy(contracts.window_ack)
    bad_ack["scope"]["stagingSha"] = contracts.candidate["stagingSha"]
    expect_semantic_reject(lambda: validate_promotion(replace(contracts, window_ack=bad_ack)), "window receipt bound to repaired head")


def validate_negative_misc(schemas: dict[str, dict[str, Any]], examples: dict[str, dict[str, Any]]) -> None:
    blind = copy.deepcopy(examples["blind-review-result.example.json"])
    blind["riskClass"] = "high"
    blind["requiredLaneTypes"] = ["general-control"]
    blind["lanes"] = [lane for lane in blind["lanes"] if lane["laneType"] == "general-control"]
    expect_schema_reject(schemas, blind["schema"], blind, "incomplete high-risk Blind Review panel")
    profile = copy.deepcopy(examples["execution-profile.example.json"])
    profile["kind"] = "base"
    expect_schema_reject(schemas, profile["schema"], profile, "overlay ID declared as base")
    legacy_mission = copy.deepcopy(examples["mission.example.json"])
    legacy_mission["factoryType"] = "pr-ship"
    expect_schema_reject(schemas, legacy_mission["schema"], legacy_mission, "active legacy mission")
    legacy_evidence = copy.deepcopy(examples["evidence.example.json"])
    legacy_evidence["evidenceType"] = "ship-gate"
    expect_schema_reject(schemas, legacy_evidence["schema"], legacy_evidence, "current legacy evidence")


def validate_negative_guards(suite: ContractSuite, contracts: PromotionContracts) -> None:
    schemas, examples = suite.schemas, suite.examples
    validate_negative_assurance(schemas, examples["source-doc-coverage.example.json"], contracts.assurance)
    validate_negative_repair(schemas, contracts.repair)
    validate_negative_promotion(schemas, contracts)
    validate_negative_misc(schemas, examples)
    print("NEGATIVE_GUARDS_PASS cases=26")


def main() -> None:
    suite = load_suite()
    contracts = promotion_contracts(suite.examples)
    validate_positive_contracts(suite, contracts)
    validate_negative_guards(suite, contracts)


if __name__ == "__main__":
    main()
