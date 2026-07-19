# Lane Audit: schemas-examples-validation

**Review:** staging-design-2026-07-18
**Lane:** schemas-examples-validation
**Auditor:** independent (factory-engineer profile, oracle posture)
**Date:** 2026-07-18
**Scope manifest:** `docs/zob/reviews/staging-design-2026-07-18/SCOPE_MANIFEST.json` (frozen)
**Mode:** read-only audit — no source edits, no network, no commits, no merge/deploy

---

## 1. Scope integrity

### 1.1 File inventory and hash verification

Every `schemas-examples-validation` file in `SCOPE_MANIFEST.json` was verified at its exact recorded SHA-256. All 44 lane files exist and match their frozen hashes.

| Category | Expected | Found | Hash match |
|---|---|---|---|
| `*.schema.json` | 19 | 19 | all OK |
| `*.example.json` | 21 | 21 | all OK |
| validators (`*.py`) | 2 | 2 | all OK |
| READMEs | 2 | 2 | all OK |
| **total** | **44** | **44** | **ALL_HASHES_OK** |

No file is missing; no hash mismatched; no extra file appeared outside the manifest scope.

### 1.2 All 44 files read fully

Every file was read in full. No file was truncated or skipped. The full content of all 19 schemas, 21 examples, 2 validators, and 2 READMEs was audited.

---

## 2. Validator execution (run but not trusted alone)

Both validators were executed. Both exit 0. Their outputs were recorded and then independently challenged (see §4 and §5).

### 2.1 `validate_contracts.py`

```
META_SCHEMA_PASS schemas=19
EXAMPLE_SCHEMA_PASS examples=21
ENUM_BRANCH_PARITY_PASS
STAGING_ASSURANCE_PROMOTION_SEMANTICS_PASS
NEGATIVE_GUARDS_PASS cases=13
EXIT: 0
```

### 2.2 `validate_documentation.py`

```
SCOPE_FRESHNESS_PASS files=66 lines=5768 bytes=316746
MARKDOWN_LINK_PASS docs=24 local_links=46
INDEX_COVERAGE_PASS top_level_docs=20
DECISION_ID_PASS unique=121
ENHANCEMENT_ID_FIELD_PASS count=37
STAGING_POLICY_ASSERTIONS_PASS
BODY_POLICY_PYTHON_PARSE_PASS
META_SCHEMA_PASS schemas=19
EXAMPLE_SCHEMA_PASS examples=21
ENUM_BRANCH_PARITY_PASS
STAGING_ASSURANCE_PROMOTION_SEMANTICS_PASS
NEGATIVE_GUARDS_PASS cases=13
DOCUMENTATION_VALIDATION_PASS
EXIT: 0
```

`validate_documentation.py` validates the full 66-file scope (all four lanes) via `source_paths()`, confirming scope freshness (path set + per-file `lineCount`/`byteCount`/`sha256` + aggregate `fileCount`/`lineCount`/`byteCount`). The scope is fresh.

---

## 3. Independent schema-by-schema audit (19 schemas)

### 3.1 Structural policy: `additionalProperties: false`

**Finding: PASS.** Every non-conditional object definition across all 19 schemas sets `additionalProperties: false`. This was verified by recursively walking every `properties`, `items`, and `$defs` node.

Conditional subschemas inside `if`/`then`/`else`/`anyOf`/`oneOf`/`allOf` correctly **omit** `additionalProperties: false`. This is the correct JSON Schema 2020-12 pattern: a `then` block that refines a subset of properties (e.g. requiring `needsHumanCaseId` when `status=needs-human`) must not set `additionalProperties: false`, because doing so would reject all the other valid properties the top-level schema already permits. The 44 flagged "missing additionalProperties" nodes from the raw walk are all inside conditional applicators — this is **intentional and correct**, not a defect.

`repository-assurance-result.schema.json` uses a `$defs/lane` definition with `additionalProperties: false`, and all 10 lane properties correctly reference it via `{"$ref":"#/$defs/lane"}`.

### 3.2 Structural policy: `bodyStored: false`

**Finding: PASS (by design) / WARN (clarity).** 15 of 19 schemas declare `bodyStored: {"const": false}` in required properties. The 4 schemas that do **not** are:

| Schema | Type | Why no `bodyStored` |
|---|---|---|
| `execution-profile.schema.json` | static profile definition | manifest/template, not a ledger record |
| `gate.schema.json` | static gate manifest template | manifest/template, not a ledger record |
| `story-execution.schema.json` | static story manifest template | manifest/template, not a ledger record |
| `task.schema.json` | static task manifest template | manifest/template, not a ledger record |

The `schemas/README.md:31` rule states: "Runtime events/checkpoints require `bodyStored: false`." The 15 schemas with `bodyStored` are precisely the runtime ledger records (events, checkpoints, evidence, receipts, telemetry, authorization records, assurance verdicts, candidate snapshots, coverage inventories, repair rounds). The 4 without are static manifest/template *definitions* that define work, not records of work done. This is a **consistent design distinction**: the rule is scoped to "runtime events/checkpoints" (i.e. appended ledger records), and the 4 manifest schemas are not appended to ledgers.

**WARN (cosmetic):** The README rule could be clearer that it applies to ledger records, not manifest templates. The 4 manifest schemas could optionally declare `bodyStored: false` for uniformity, but its absence is semantically valid and does not violate the rule as written.

### 3.3 Structural policy: JSON Schema draft 2020-12, `$schema`, `$id`

**Finding: PASS.** All 19 schemas declare `"$schema": "https://json-schema.org/draft/2020-12/schema"` and a `urn:wheel:zob:*:v1` `$id`. All pass `Draft202012Validator.check_schema()` meta-schema validation.

Three schemas use a short URN name in `$id` while their `schema` const discriminator uses a longer name:

| Schema | `$id` | `schema` const |
|---|---|---|
| `checkpoint.schema.json` | `urn:wheel:zob:checkpoint:v1` | `zob.mission-checkpoint.v1` |
| `gate.schema.json` | `urn:wheel:zob:gate:v1` | `zob.story-gate.v1` |
| `task.schema.json` | `urn:wheel:zob:task:v1` | `zob.story-task.v1` |

This is an **intentional naming convention**: the `$id` is a compact URN identifier; the `schema` const is a version discriminator embedded in each instance document. These are different fields with different purposes. Not a defect.

### 3.4 Per-schema semantic findings

#### `ack-receipt.schema.json` — PASS
- Top-level + nested objects all `additionalProperties: false`.
- `ackType` enum (11 values) matches `execution-profile.humanReceiptTypes.items.enum` exactly (enum parity verified independently).
- `scope` allows `headSha`, `stagingSha`, `developSha` all with `^[a-f0-9]{40}$` pattern.

#### `assurance-repair-round.schema.json` — PASS
- `round`: `minimum: 1, maximum: 3` — enforces round ≤ 3 at schema level.
- `auditorAssignmentIds` and `repairerAssignmentIds` are separate required arrays (minItems 1, uniqueItems true). Disjointness is a semantic-validator rule (JSON Schema cannot express set-disjoint).
- `allOf[0]`: `status=needs-human` → requires `needsHumanCaseId`.
- `allOf[1]`: `status=reaudit-required` → requires `afterStagingSha` + `fullStagingIntegration`.
- `nextAssuranceRequired`: `const: true` — repair always requires a fresh re-audit.
- `targetBranch` in `repairPullRequests`: `const: "develop-staging"` — repair PRs target staging, never direct develop.

#### `blind-review-result.schema.json` — PASS
- `audits`: `minItems: 3, maxItems: 3` — exactly three auditors (source-integration, evidence-qa-ci, finalizer).
- `round`: `maximum: 3`.
- Risk-class conditional `allOf` correctly requires escalating lane panels:
  - `low` → general-control (control=true, complete)
  - `medium` → general-control + evidence-domain (both control=true, complete)
  - `high`/`critical` → general-control + security-domain + evidence-qa (all control=true, complete)
- `findings` items have `path` + `line` (integer, minimum 1) — exact path:line findings.

#### `checkpoint.schema.json` — PASS
- `previousCheckpointHash`: `oneOf [null, 64-hex string]` — first checkpoint allows null, subsequent require hash chain.
- `bodyStored: const false`.
- All nested objects (`mission`, `stories[]`, `activeRuns[]`, `workspaces[]`, `externalTruth`, `humanReceipts[]`) have `additionalProperties: false`.

#### `evidence.schema.json` — PASS
- `evidenceType` enum (14 values) covers all evidence types including staging/promotion/merge.
- `bindings`: requires `repositoryId`, `headSha`, `manifestHash`, `policyHash`.
- `validationResults[]` + `attemptChain[]` + `artifacts[]` all `additionalProperties: false`.
- `bodyStored: const false`.

#### `execution-profile.schema.json` — PASS (no `bodyStored` by design — see §3.2)
- `kind`: base/overlay with `allOf` constraining `profileId` to disjoint enum sets:
  - base (4): full-feature, quick-fix, docs-process, refactor-cleanup
  - overlay (15): security-trust, privacy-encryption, ..., destructive-change
  - base/overlay disjoint: verified.
- `compositionPolicy`: `mergeMode: const "union-stricter-wins"`, `canStrengthenAutomatically: const true`, `requiresHumanToWeakenOrRemove: const true` — profiles can only strengthen, never weaken without human.
- `deferredActions` enum (10 values) includes staging-merge/repository-assurance/promotion (factory-level actions).

#### `gate.schema.json` — PASS (no `bodyStored` by design — see §3.2)
- `gateType` enum (11 values): ratification, context, plan, blueprint, reconcile, build, document, learn, release, pr-close, repair.
- `invalidationRules`: `minItems: 1` — every gate must declare at least one invalidation rule.
- `entryCriteria[]`, `taskRefs[]`, `exitCriteria[]` all `additionalProperties: false`.

#### `merge-authorization.schema.json` — PASS
- Title: "Wheel ZOB **Legacy** Direct-Base Exact-Head Merge Batch Authorization v1" — clearly labeled legacy.
- `mergeMethod: const "squash"` — legacy batch uses squash.
- `targetBranch`: free-form string (not const develop) — but example uses `"develop"`.
- `deploymentImpact.manualDispatchAuthorized: const false` — manual dispatch forbidden even in legacy flow.
- `bodyStored: const false`.

#### `mission-event.schema.json` — PASS
- `payload.not.anyOf` forbids 6 body-unsafe keys: `rawBody`, `prompt`, `response`, `transcript`, `credential`, `rawDiff`. Verified: example payload contains none of these.
- `prevEventHash`: `oneOf [null, 64-hex]` — hash chain.
- `eventId`: `minLength: 16, maxLength: 80`.
- `bodyStored: const false`.

#### `mission.schema.json` — PASS
- `factoryType` enum (8 values) includes `post-promotion-reconciliation` and `post-merge-reconciliation`.
- `completion.forbiddenActions` enum (11 values) includes `workflow-dispatch` — mission-level completion forbids manual workflow dispatch.
- `concurrency`: global/perStory/perRole all minimum 1.
- `bodyStored: const false`.

#### `model-attempt.schema.json` — PASS
- `description`: "Protected telemetry only; never expose this record to agent task contexts or story evidence." — satisfies AGENTS.md rule 6 (keep model/thinking/prompt mappings outside agent-readable story evidence).
- `promptTreatment`: `mode` enum (uniform-control, shared-candidate, model-candidate, approved-optimized), `promptHash: 64-hex`, `control: boolean`.
- `requestedThinking`/`actualThinking` enums match (default, low, medium, high, xhigh, max).
- `bodyStored: const false`.

#### `pr-close-evidence.schema.json` — PASS
- `audits`: `minItems: 3, maxItems: 3` — exactly three auditors.
- `auditType` enum: source-integration, evidence-qa-ci, finalizer.
- `issuer.type: const "builder-app"`, `checkName: const "ZOB / PR Close"`.
- `draftCi`: `terminalAcceptable`, `deferredReadyOnly` — staged ready guard.
- `bodyStored: const false`.

#### `promotion-authorization.schema.json` — PASS
- `stagingBranch: const "develop-staging"`, `developBranch: const "develop"`.
- `mergeMethod: const "merge-commit"` — promotion is merge-commit only (not squash).
- `mergeCommitPolicy`: `auditedStagingMustBeParent: const true`, `resultTreeMustMatchStaging: const true`, `adminBypassAllowed: const false` — no admin bypass.
- `assurance.verdict: const "pass"`, `assurance.noShip: const false` — only passing assurance can authorize.
- `assurance.round: maximum 3`.
- `deploymentImpact.manualDispatchAuthorized: const false` — no manual dispatch.
- Separate receipt hashes: `windowReceiptHash` + `promotionMergeReceiptHash` (two distinct human receipts).
- `bodyStored: const false`.

#### `promotion-merge-evidence.schema.json` — PASS
- `parents`: `auditedStagingIsParent: const true` — audited staging must be a parent of the merge commit.
- `treeProof`: `treesEqual: const true` — result tree must match audited staging tree.
- `mergeMethod: const "merge-commit"`.
- `automaticCdRuns[].triggerEvent: const "push"` — CD must be push-triggered, not manual dispatch.
- `manualDispatchPerformed: const false` — manual dispatch forbidden.
- `reconciliation`: `inputMergeSha`, `result`, `stagingAlignment` (with `expectedOldSha`, `newSha`, `expectedHeadProtected: const true`, `result`), `queueUnfrozen`.
- `allOf[0]`: `status=complete` → `reconciliation.result: const "pass"`, `stagingAlignment.result: const "fast-forwarded"`, `queueUnfrozen: const true` — queue cannot unfreeze before reconciliation and alignment pass.
- `bodyStored: const false`.

#### `repository-assurance-result.schema.json` — PASS
- `laneResults`: exactly 10 named lanes, all required: source-integration, product-reachability, security-privacy, reliability-performance, data-control-plane, qa-test-truth, supply-chain-ci, operations-rollout, top-down-docs, bottom-up-coverage. All use `$ref: #/$defs/lane`.
- `modelIndependence.anyOf`: either `eligibleFamilyCount ≤ 2` (degraded ok) OR `eligibleFamilyCount ≥ 3 AND usedFamilyCount ≥ 3` — three-family rule enforced at schema level.
- `allOf[0]`: `verdict=pass` → `noShip: const false`, all 10 lanes `result: const "pass"`, `topDownDocs.stale/pending/duplicateAssignments: const 0`, `bottomUpCoverage.status: const "complete-clean"` + `missingDocumentation/unknownOrUnresolved/duplicateElementIds: const 0`, `findings.blocking: const 0`, `assuranceCheck.conclusion: const "success"`.
- `repairRoundIds: maxItems 3`.
- `synthesizer.fixedControl: const true`.
- `bodyStored: const false`.

#### `source-doc-coverage.schema.json` — PASS
- `elements[].kind` enum: 44 values (file, module, export, ..., runbook) — exhaustive element coverage taxonomy.
- `elements[].disposition` enum: 8 values (canonical-documented, intentionally-internal, test-only, generated, vendor, deprecated-or-superseded, missing-documentation, unknown-or-unresolved).
- `counts`: 11 keys mapping 1:1 to the 8 dispositions + total + disposed + duplicateElementIds. Verified complete — no missing/extra count keys.
- `elements[].allOf[0]`: `publicOperational=true` → `disposition: const "canonical-documented"`, `docRefs: minItems 1, required` — public elements must have canonical-doc mapping.
- `allOf[0]`: `status=complete-clean` → `missingDocumentation/unknownOrUnresolved/duplicateElementIds: const 0`.
- `bodyStored: const false`.

#### `staging-candidate.schema.json` — PASS
- `stagingBranch: const "develop-staging"`, `developBranch: const "develop"`.
- `includedPullRequests[].mergeMethod: const "squash"` — staging merges use squash.
- `integration.deploymentDisabledProof.stagingCanTriggerDeployment: const false` — staging cannot deploy.
- `freeze.humanStarted: const true`, `stagingMergeQueueFrozen: const true` — human-started freeze.
- `maxAssuranceRounds: const 3`.
- `bodyStored: const false`.

#### `story-execution.schema.json` — PASS (no `bodyStored` by design — see §3.2)
- `profile.base` enum (4) matches execution-profile base enum.
- `branchContract.draftRequired: const true` — PRs must start as drafts.
- `prClose.requiredAudits: minItems 3` with enum [source-integration, evidence-qa-ci, finalizer].
- `deferredActions` enum (7 values) — deliberately excludes staging-merge/repository-assurance/promotion (those are factory-level, not story-level). This is a correct layered design (see §3.5).

#### `task.schema.json` — PASS (no `bodyStored` by design — see §3.2)
- `permissions.deniedCapabilities` — per-task denial list.
- `execution.workspaceMode` enum: canonical, sandbox, read-only-review.
- `deliverables: minItems 1`, `acceptanceCriteria: minItems 1`.
- `labels.inferred[]` with confidence (0..1) — inferred labels carry confidence scores.

### 3.5 `deferredActions` enum divergence (observation, not defect)

Three schemas define `deferredActions`/`forbiddenActions` with deliberately different enum sets:

| Schema | Field | Count | Includes staging-merge/repository-assurance/promotion? |
|---|---|---|---|
| `mission.schema.json` | `completion.forbiddenActions` | 11 | yes (+ `workflow-dispatch`) |
| `execution-profile.schema.json` | `deferredActions` | 10 | yes (no `workflow-dispatch`) |
| `story-execution.schema.json` | `deferredActions` | 7 | **no** |

This is **semantically correct by design**: `story-execution` is an ordinary PR-level manifest, so it only defers ordinary-PR actions (formal-review, ready, merge, deploy, publish, provider-activation, post-deploy-confirmation). Staging-merge, repository-assurance, and promotion are factory-level deferred actions that do not apply to a single story PR. `mission.forbiddenActions` is the broadest (mission-level completion gates, includes `workflow-dispatch`). `execution-profile` sits in between. `story-execution.deferredActions` ⊆ `execution-profile.deferredActions`: verified. This is a deliberate layered design, not an inconsistency.

---

## 4. Independent example-by-example audit (21 examples)

### 4.1 Schema validation

All 21 examples validate against their declared schema. Verified independently via `Draft202012Validator` with `FormatChecker`. The validator's `EXAMPLE_SCHEMA_PASS examples=21` is confirmed.

### 4.2 Cross-example semantic relation audit (24 checks)

All 24 independent cross-example semantic checks **PASS**:

| # | Check | Result |
|---|---|---|
| 1 | Staging SHA lineage: candidate = assurance = authorization = merge.stagingSha | PASS |
| 2 | Develop SHA lineage: candidate = assurance = authorization = merge.developBaseSha | PASS |
| 3a | authorization.windowReceiptHash = promotion-window-ack-receipt.receiptHash | PASS |
| 3b | authorization.promotionMergeReceiptHash = promotion-merge-ack-receipt.receiptHash | PASS |
| 4a | authorization.assurance.assuranceId = assurance.assuranceId | PASS |
| 4b | authorization.assurance.resultHash = assurance.resultHash | PASS |
| 5a | merge.authorizationId = authorization.authorizationId | PASS |
| 5b | merge.authorizationHash = authorization.authorizationHash | PASS |
| 6a | merge.parents.developParentSha = merge.developBaseSha | PASS |
| 6b | merge.parents.auditedStagingParentSha = merge.stagingSha | PASS |
| 6c | merge.parents.auditedStagingIsParent = true | PASS |
| 6d | merge.treeProof.treesEqual = true | PASS |
| 6e | merge.treeProof.promotionTreeHash = merge.treeProof.auditedStagingTreeHash | PASS |
| 7a | authorization.deploymentImpact.manualDispatchAuthorized = false | PASS |
| 7b | merge.manualDispatchPerformed = false | PASS |
| 7c | All CD runs: triggerEvent=push, triggerSha=merge.promotionMergeSha | PASS |
| 8a | merge.reconciliation.inputMergeSha = merge.promotionMergeSha | PASS |
| 8b | merge.reconciliation.stagingAlignment.expectedOldSha = merge.stagingSha | PASS |
| 8c | merge.reconciliation.stagingAlignment.newSha = merge.promotionMergeSha | PASS |
| 8d | merge.reconciliation.stagingAlignment.expectedHeadProtected = true | PASS |
| 8e | status=complete → reconciliation.result=pass | PASS |
| 8f | status=complete → stagingAlignment.result=fast-forwarded | PASS |
| 8g | status=complete → queueUnfrozen=true | PASS |
| 9a | repair round ≤ 3 | PASS |
| 9b | assurance round ≤ 3 | PASS |
| 9c | authorization.assurance.round ≤ 3 | PASS |
| 9d | candidate.maxAssuranceRounds = 3 | PASS |
| 10 | auditor/repairer assignment IDs disjoint | PASS |
| 11 | Separate receipts: window-ack ≠ merge-ack (different receiptId + ackType) | PASS |
| 12 | Exactly 10 named lanes, matching expected order | PASS |
| 13a | 3 model families used | PASS |
| 13b | modelIndependence.usedFamilyCount = len(used families) | PASS |
| 13c | eligible ≥ 3 → used ≥ 3 | PASS |
| 13d | degraded = false | PASS |
| 14 | Active examples target develop-staging; legacy merge-auth targets develop | PASS |
| 15 | Candidate final stagingMergeSha = frozen stagingSha | PASS |
| 16a | Candidate integration result = pass | PASS |
| 16b | Candidate stagingCanTriggerDeployment = false | PASS |
| 17a–e | Coverage count arithmetic (total, disposed, disposition sum, dupIDs, public-doc mapping) | PASS |
| 18 | Assurance top-down doc count arithmetic | PASS |
| 19a–e | Assurance pass conditions (noShip, all lanes pass, blocking=0, coverage clean, check success) | PASS |
| 20 | Enum parity: ack-receipt.ackType = execution-profile.humanReceiptTypes | PASS |
| 21 | Repair reaudit-required: afterStagingSha + integration.pass + headSha match + invalidated | PASS |
| 22 | Candidate freeze: humanStarted + queueFrozen + windowReceiptHash match | PASS |
| 23 | Blind review medium-risk panel: general-control + evidence-domain both control+complete | PASS |
| 24 | Execution-profile kind=overlay, profileId valid for overlay enum | PASS |

### 4.3 Active examples staging vs legacy direct-base

**Finding: PASS.** The 4 active Story/Review examples (`mission`, `story-execution`, `pr-close-evidence`, `blind-review-result`) all target non-deploying `develop-staging` and do **not** contain a direct `"develop"` target. Only the legacy `merge-authorization.example.json` retains `"targetBranch": "develop"` for backward-compatible schema tests. The `examples/README.md` and `schemas/README.md` both clearly label this as legacy direct-base compatibility.

### 4.4 Promotion narrative consistency (round 1 → repair → round 2 → promotion)

**Finding: PASS.** The cross-example narrative is fully consistent:

1. **Round-1 assurance** (`assurance-20260718-round-1`) found defects at the initial staging head.
2. **Repair round 1** (`repair-round-20260718-001`, `round: 1`) fixed defects via PR 4110 merged to `develop-staging` (squash). It invalidated the round-1 assurance (`invalidatedAssuranceIds: ["assurance-20260718-round-1"]`). `afterStagingSha` = `aaaa...` (new staging head after repair). `fullStagingIntegration.result = pass` at the new head. `status = reaudit-required`.
3. **Round-2 assurance** (`assurance-20260718-001`, `round: 2`) is the fresh re-audit at `stagingSha = aaaa...` (matches `repair.afterStagingSha`). Verdict = pass, noShip = false. `repairRoundIds: ["repair-round-20260718-001"]` links back to the repair.
4. **Promotion authorization** references the round-2 assurance (`assurance.assuranceId = assurance-20260718-001`, `round: 2`). `includedPrNumbers: [4101, 4102, 4110]` = initial candidate PRs + repair PR.

Cross-checks all pass: `repair.afterStagingSha == assurance.stagingSha`, `assurance.repairRoundIds` contains `repair.repairRoundId`, `authz.assurance.assuranceId == assurance.assuranceId`, `authz.assurance.round == assurance.round`.

**WARN (cosmetic):** The assurance ID naming convention is inconsistent: the invalidated round-1 assurance uses suffix `-round-1` (`assurance-20260718-round-1`) while the final round-2 assurance uses suffix `-001` (`assurance-20260718-001`). These are different assurance runs (round-1 was invalidated; `-001` is the round-2 fresh re-audit), so the inconsistency is semantically valid, but a uniform naming convention (e.g. `-round-1` / `-round-2` or `-001` / `-002`) would make the linkage clearer.

### 4.5 SHA/hash pattern integrity

**Finding: PASS.** All example SHA values (40-char hex) and hash values (64-char hex) match their schema patterns. No truncated or malformed values. All `bodyStored` values are `false` in examples whose schemas define `bodyStored`. The 4 manifest examples (execution-profile, gate, story-execution, task) correctly omit `bodyStored` since their schemas do not define it.

---

## 5. Validator audit (2 validators)

### 5.1 `validate_contracts.py` — PASS

**Coverage:**
- Meta-schema validation of all 19 schemas (duplicate token detection).
- Schema validation of all 21 examples against their declared schema.
- Enum parity check (ack-receipt.ackType vs execution-profile.humanReceiptTypes).
- Active-contract staging-target check (4 active examples must contain `develop-staging`).
- Candidate final-merge-equals-frozen-head check.
- Candidate integration pass + deployment-disabled check.
- `validate_coverage()`: element-ID uniqueness, total==len(elements), per-disposition count accuracy, disposition sum, duplicateElementIds=0, public-element doc mapping.
- `validate_assurance()`: 10 lanes, usedFamilyCount drift, 3-eligible→3-used, top-down doc arithmetic, coverage fully disposed, pass-conditions (noShip, all-lanes-pass, doc gaps, coverage clean, blocking=0).
- `validate_repair()`: auditor/repairer disjoint, round ≤ 3, assurance invalidated, reaudit-required integration pass + head match.
- `validate_promotion()`: full SHA lineage (4-way), receipt hash cross-refs (window + merge), authorization→assurance ref (ID + hash), merge→authorization ref (ID + hash), merge parents (develop + staging), tree equality, no manual dispatch, CD push-triggered + triggerSha, reconciliation input/alignment, queue-unfreeze gating.
- 13 negative guards (all independently confirmed to reject — see §5.3).

**Safety:** No network, no secrets, no randomness. Uses `jsonschema.Draft202012Validator` + `FormatChecker`. Local file I/O only.

### 5.2 `validate_documentation.py` — PASS

**Coverage:**
- `validate_scope()`: path-set equality + per-file lineCount/byteCount/sha256 + aggregate fileCount/lineCount/byteCount against frozen manifest (all 66 files).
- `validate_links()`: all local markdown links resolve + anchor validation.
- `validate_index_coverage()`: `docs/zob/README.md` links all top-level docs; schema/example READMEs list all schema/example files; validator files linked.
- `validate_decisions()`: decision IDs exactly 001..121; direct-develop decisions visibly superseded.
- `validate_enhancements()`: enhancement IDs exactly 001..037; required fields present; ENH-031/032 promoted; ENH-033 maturity qualified.
- `validate_policy_assertions()`: section 17 policy phrases present; staging-branch absence recorded; staging design maturity-qualified; active examples use staging; legacy fixture labeled.
- `validate_body_policy_and_python()`: body-safe policy present; privacy naming policy present; all `.py` files parse.
- `run_contract_validator()`: invokes `validate_contracts.py` as local subprocess.

**Safety:** No network (subprocess is local-only), no secrets. `urllib.parse` used for URL parsing only (link validation), not network access.

### 5.3 Independent negative-guard verification

All 13 negative guards in `validate_contracts.py` were independently reproduced and confirmed to reject:

| # | Guard | Rejection mechanism | Confirmed |
|---|---|---|---|
| NEG1 | Public element without docRef | schema | yes |
| NEG2 | Coverage count drift | semantic | yes (passes schema, fails semantic) |
| NEG3 | Passing assurance with stale docs | schema (allOf pass-condition) | yes |
| NEG4 | Assurance missing mandatory lane | schema (required laneResults) | yes |
| NEG5 | 3 eligible families not used | schema (anyOf) | yes |
| NEG6 | Auditor repairs own finding | semantic | yes (passes schema, fails semantic) |
| NEG7 | Repair round above 3 | schema (maximum: 3) | yes |
| NEG8 | Squash promotion | schema (const merge-commit) | yes |
| NEG9 | Wrong staging parent | semantic | yes (passes schema, fails semantic) |
| NEG10 | Manual workflow dispatch | schema (const false) | yes |
| NEG11 | Queue unfreeze before staging alignment | schema (allOf complete-condition) | yes |
| NEG12 | Incomplete high-risk blind review panel | schema (allOf risk-class) | yes (4 errors) |
| NEG13 | Overlay ID declared as base | schema (allOf kind-profileId) | yes |

### 5.4 Validator coverage gaps (WARN, not FAIL)

The validators are thorough but do not cross-check every possible cross-example linkage. The following gaps are **WARN-level observations** — the examples are internally consistent, but the validators do not enforce these specific cross-example relations:

1. **`authz.includedPrNumbers` superset of candidate + repair PRs:** The validator does not check that `promotion-authorization.includedPrNumbers` is a superset of `staging-candidate.includedPullRequests[].prNumber` plus `assurance-repair-round.repairPullRequests[].prNumber`. The examples are consistent ([4101, 4102] + [4110] = [4101, 4102, 4110]), but this is not enforced.

2. **`repair.afterStagingSha` == `assurance.stagingSha`:** `validate_repair()` checks `integration.headSha == afterStagingSha` (self-referential), but does not cross-check that `afterStagingSha` equals the final assurance's `stagingSha`. The examples are consistent (`aaaa...` == `aaaa...`), but this is not enforced.

3. **`repair.assuranceId` naming linkage to final assurance:** `validate_repair()` checks `assuranceId in invalidatedAssuranceIds` (self-referential), but does not cross-check that the invalidated assurance ID links to the final assurance result (they are different runs by design). The naming inconsistency (`-round-1` vs `-001`) makes this linkage harder to trace programmatically.

These gaps do not indicate defects in the frozen artifacts — they indicate opportunities to strengthen the validators for future use. The frozen examples are consistent with or without these additional checks.

---

## 6. Required semantic challenges (task checklist)

| Required challenge | Verdict | Evidence |
|---|---|---|
| Candidate (frozen staging boundary + integration proof) | PASS | `staging-candidate.schema.json`: stagingBranch/developBranch const, mergeBaseSha, includedPullRequests (squash), integration.deploymentDisabledProof.stagingCanTriggerDeployment=false, freeze.humanStarted=true, freeze.stagingMergeQueueFrozen=true, maxAssuranceRounds=3. Example: integration.result=pass, final stagingMergeSha=frozen head. |
| Exhaustive element coverage | PASS | `source-doc-coverage.schema.json`: 44-kind element taxonomy, 8-disposition enum, 11-key counts (1:1 mapping), publicOperational→canonical-documented+docRefs conditional, complete-clean→zero-gaps conditional. Validator enforces count arithmetic. |
| Ten lanes | PASS | `repository-assurance-result.schema.json`: laneResults requires exactly 10 named lanes (source-integration, product-reachability, security-privacy, reliability-performance, data-control-plane, qa-test-truth, supply-chain-ci, operations-rollout, top-down-docs, bottom-up-coverage), all via `$ref #/$defs/lane`. Example: 10 lanes present. |
| Three families | PASS | `modelIndependence.anyOf`: eligible≤2 OR (eligible≥3 AND used≥3). Example: 3 families (family-A/B/C), eligible=3, used=3, degraded=false. |
| Auditor-repairer disjointness | PASS | `assurance-repair-round.schema.json`: separate `auditorAssignmentIds` + `repairerAssignmentIds` arrays. Validator `validate_repair()` enforces disjointness (semantic). Example: disjoint. |
| Round ≤ 3 | PASS | `assurance-repair-round.schema.json`: `round: maximum 3`. `repository-assurance-result.schema.json`: `round: maximum 3`, `repairRoundIds: maxItems 3`. `promotion-authorization.schema.json`: `assurance.round: maximum 3`. `staging-candidate.schema.json`: `maxAssuranceRounds: const 3`. |
| Separate receipts (window + merge) | PASS | `promotion-authorization.schema.json`: distinct `windowReceiptHash` + `promotionMergeReceiptHash`. Two separate ack-receipt examples (promotion-window-ack-receipt, promotion-merge-ack-receipt) with distinct receiptId + ackType. Cross-refs verified. |
| Merge-commit parents/tree | PASS | `promotion-merge-evidence.schema.json`: `parents.auditedStagingIsParent: const true`, `parents.auditedStagingParentSha` + `parents.developParentSha` required, `treeProof.treesEqual: const true`, `treeProof.promotionTreeHash` + `auditedStagingTreeHash` required. Example: all consistent. |
| Automatic push CD / no manual dispatch | PASS | `promotion-merge-evidence.schema.json`: `automaticCdRuns[].triggerEvent: const "push"`, `manualDispatchPerformed: const false`. `promotion-authorization.schema.json`: `deploymentImpact.manualDispatchAuthorized: const false`. Example: CD run push-triggered, triggerSha=promotionMergeSha, no manual dispatch. |
| Reconciliation/alignment before unfreeze | PASS | `promotion-merge-evidence.schema.json`: `allOf[0]` status=complete → reconciliation.result=pass, stagingAlignment.result=fast-forwarded, queueUnfrozen=true. Example: status=complete, all conditions met. Queue cannot unfreeze before reconciliation+alignment pass. |
| Active examples staging vs labeled legacy direct-base | PASS | 4 active examples target develop-staging, no direct develop. Legacy merge-authorization targets develop, labeled "Legacy" in schema title + both READMEs. |
| Exact path:line findings | PASS | `blind-review-result.schema.json` findings items require `path` (string) + `line` (integer, minimum 1). |
| Strict additionalProperties/body policy | PASS | §3.1 (all non-conditional objects have additionalProperties:false), §3.2 (bodyStored design distinction). |
| `bodyStored: false` on runtime ledger records | PASS | 15 ledger schemas require `bodyStored: const false`. 4 manifest schemas correctly omit it (not ledger records). |

---

## 7. README audit (2 READMEs)

### 7.1 `schemas/README.md` — PASS
- Lists all 19 schemas with purpose descriptions.
- Rules section: JSON Schema draft 2020-12, full-length IDs/SHA-256, `bodyStored: false` for runtime events/checkpoints, forbidden raw prompts/outputs/diffs/credentials/transcripts, versioned schemas fail-closed, develop-staging for ordinary PRs, merge-commit for promotion, cross-field semantic rules.
- Clearly labels `merge-authorization` as "Legacy direct-base exact-head batch authorization (not Wheel v1 ordinary PR flow)".
- States implementation may split into `$defs`; standalone versions favor auditability.

### 7.2 `examples/README.md` — PASS
- Lists all 21 examples with schema mapping table.
- 2 supplemental ack-receipt examples (promotion-window, promotion-merge) correctly map to `ack-receipt.schema.json`.
- States all hashes/PRs/URLs are fictional placeholders, `bodyStored: false` is intentional.
- Clearly states active Story/Review examples target non-deploying `develop-staging`; only legacy merge-batch retains direct `develop` target.

---

## 8. Verdict

### 8.1 Overall verdict: **PASS**

All 44 `schemas-examples-validation` files verified at exact hash. All 19 schemas are structurally sound (draft 2020-12, `additionalProperties: false` on all non-conditional objects, `bodyStored: false` on all runtime ledger records). All 21 examples validate against their schemas. All 24 independent cross-example semantic checks pass. Both validators pass and their 13 negative guards were independently confirmed. The required semantic challenges (candidate, exhaustive coverage, ten lanes, three families, auditor-repairer disjointness, round ≤ 3, separate receipts, merge-commit parents/tree, automatic push CD, reconciliation before unfreeze, active-vs-legacy staging, exact path:line findings, strict additionalProperties/body policy) all pass.

### 8.2 `no_ship`: **false**

No no-ship blocker identified. The artifacts are internally consistent, structurally valid, and semantically sound.

### 8.3 WARN-level observations (non-blocking)

1. **`bodyStored` clarity (§3.2):** The `schemas/README.md:31` rule "Runtime events/checkpoints require `bodyStored: false`" could be clearer that it applies to appended ledger records, not static manifest templates. The 4 manifest schemas (execution-profile, gate, story-execution, task) correctly omit `bodyStored` but a uniform convention would reduce ambiguity.

2. **Assurance ID naming inconsistency (§4.4):** The invalidated round-1 assurance uses suffix `-round-1` while the final round-2 assurance uses suffix `-001`. Semantically valid (different runs) but a uniform naming convention would improve traceability.

3. **Validator cross-example coverage gaps (§5.4):** The validators do not enforce three specific cross-example linkages (authz.includedPrNumbers superset, repair.afterStagingSha == assurance.stagingSha, repair-to-final-assurance ID naming). The frozen examples are consistent, but these gaps could be closed in future validator versions.

4. **`deferredActions` enum divergence (§3.5):** Three schemas define deliberately different `deferredActions`/`forbiddenActions` enums (mission: 11, execution-profile: 10, story-execution: 7). This is a correct layered design (story-level excludes factory-level actions), not a defect, but the rationale could be documented.

These WARNs are design-clarity observations. None indicates a structural defect, a semantic inconsistency, or a safety violation in the frozen artifacts.

### 8.4 Evidence summary

- **Hash integrity:** 44/44 files verified at exact SHA-256 (§1.1).
- **Validators:** both exit 0 (§2). Negative guards: 13/13 independently confirmed (§5.3).
- **Schemas:** 19/19 structurally sound (§3). All non-conditional objects have `additionalProperties: false`. 15/15 ledger schemas require `bodyStored: false`.
- **Examples:** 21/21 schema-valid (§4.1). 24/24 semantic cross-checks pass (§4.2).
- **Safety:** no network, no secrets, no commits, no merge/deploy. Read-only audit.

LANE_AUDIT_COMPLETE
