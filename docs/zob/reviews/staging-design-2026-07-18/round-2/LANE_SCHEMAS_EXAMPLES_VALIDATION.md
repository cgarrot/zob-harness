# Lane Audit: Schemas, Examples & Validation — Round 2

**Scope manifest:** `docs/zob/reviews/staging-design-2026-07-18/round-2/SCOPE_MANIFEST.json`
**Manifest SHA-256 (verified):** `786bce2b809c62f135fbe4e15050cba4aabacfcfb80341377178a1064238ba76`
**Lane:** `schemas-examples-validation`
**Files in lane:** 44 (19 schemas, 21 examples, 2 validators, 2 READMEs)
**Audit mode:** independent full-read + hash/line attestation + independent schema/example checks + validator challenge
**Audit date:** 2026-07-18
**Design-only:** all artifacts are design schemas/examples/validators; no runtime consumes them.

---

## 1. Manifest integrity

The round-2 `SCOPE_MANIFEST.json` was read in full and its SHA-256 independently recomputed:

```
786bce2b809c62f135fbe4e15050cba4aabacfcfb80341377178a1064238ba76  docs/zob/reviews/staging-design-2026-07-18/round-2/SCOPE_MANIFEST.json
```

This matches the expected manifest hash exactly. The top-level `docs/zob/reviews/staging-design-2026-07-18/SCOPE_MANIFEST.json` (the one `validate_documentation.py` validates against) is byte-identical to the round-2 manifest — same hash, same 66 files / 6068 lines / 348528 bytes — confirming the documentation validator's scope-freshness check covers the same corpus as this round-2 audit.

All 44 lane files were independently hash/line/byte verified against the manifest. **Zero mismatches.** See §3 for per-file attestations.

---

## 2. Validator execution and independent challenge

### 2.1 Validator 1: `validate_contracts.py` (432 lines, hash `b84587d1…`)

Executed independently:

```
META_SCHEMA_PASS schemas=19
EXAMPLE_SCHEMA_PASS examples=21
ENUM_BRANCH_PARITY_PASS
STAGING_ASSURANCE_PROMOTION_SEMANTICS_PASS
NEGATIVE_GUARDS_PASS cases=26
```

### 2.2 Validator 2: `validate_documentation.py` (215 lines, hash `581cb7bf…`)

Executed independently:

```
SCOPE_FRESHNESS_PASS files=66 lines=6068 bytes=348528
MARKDOWN_LINK_PASS docs=24 local_links=46
INDEX_COVERAGE_PASS top_level_docs=20
DECISION_ID_PASS rows=121
ENHANCEMENT_ID_FIELD_PASS count=37
STAGING_POLICY_ASSERTIONS_PASS
BODY_POLICY_PYTHON_PARSE_PASS
META_SCHEMA_PASS schemas=19
EXAMPLE_SCHEMA_PASS examples=21
ENUM_BRANCH_PARITY_PASS
STAGING_ASSURANCE_PROMOTION_SEMANTICS_PASS
NEGATIVE_GUARDS_PASS cases=26
DOCUMENTATION_VALIDATION_PASS
```

### 2.3 Independent challenge — validators not trusted alone

The audit re-derived every check without importing the validators:

1. **Meta-schema:** all 19 schemas parsed and checked against `Draft202012Validator.check_schema()` independently. All pass.
2. **Example→schema validation:** all 21 examples validated against their declared schema using a standalone `Draft202012Validator` + `FormatChecker`. Zero errors.
3. **Schema token uniqueness:** 19 schemas, 19 unique `schema` const tokens, zero duplicates.
4. **Draft 2020-12:** all 19 schemas declare `$schema: https://json-schema.org/draft/2020-12/schema`. Zero deviations.
5. **`additionalProperties: false`:** all 19 root object schemas set it false; recursive scan of nested object schemas (items, properties, allOf/anyOf branches) found **zero** object-with-properties schemas missing `additionalProperties: false`.
6. **26 negative guards:** each guard was independently replicated by mutating the relevant example and confirming rejection (schema-level via `iter_errors`, or semantic-level via the same assertion logic). **All 26 independently verified as correctly rejecting.** The count of 26 was confirmed by counting `expect_schema_reject`/`expect_semantic_reject` call sites (28 matches − 2 function definitions = 26 guards).
7. **Promotion lineage chain:** the full 7-record chain (window-ack → candidate → repair → assurance → authorization → merge-ack → merge-evidence) was independently verified field-by-field. See §4.
8. **Enum parity:** `ack-receipt.ackType` enum == `execution-profile.humanReceiptTypes` enum (11 values, identical). `story-execution.deferredActions` ⊂ `execution-profile.deferredActions` == `mission.completion.forbiddenActions` (11 values). Verified independently.

---

## 3. Per-file full-read / hash / line attestations (44 files)

### Schemas (19 files)

| # | Path | Lines | Bytes | SHA-256 (verified) | Read |
|---|---|---|---|---|---|
| 1 | `docs/zob/schemas/README.md` | 40 | 3304 | `6cf2eb8369dbc0131c087b3cc77686f8af8fdcb4c2af8a12dfec9f10c633a881` | ✓ full |
| 2 | `docs/zob/schemas/ack-receipt.schema.json` | 36 | 3267 | `c2bb418a7ce8e3c58334701badcd4002fed961d8a7d20c7240db2d3c72c4ca35` | ✓ full |
| 3 | `docs/zob/schemas/assurance-repair-round.schema.json` | 56 | 3688 | `2b122ba994149586fffe714cf7131742e3e7a3e8855d493640bb6731174b85e3` | ✓ full |
| 4 | `docs/zob/schemas/blind-review-result.schema.json` | 50 | 5227 | `1e702300ceba1f66f00073d2701849303ee4c7869e94c05c0d6f159b492cbc74` | ✓ full |
| 5 | `docs/zob/schemas/checkpoint.schema.json` | 22 | 3171 | `ac6759a23663849694f99e71386fe5ab5fc2e3606384d4ca631ac536c60d8044` | ✓ full |
| 6 | `docs/zob/schemas/evidence.schema.json` | 35 | 4004 | `ff2a4c4cff6272f5bca56166a94d9001a8b17476eed1fa61aa89bde72f3c89ec` | ✓ full |
| 7 | `docs/zob/schemas/execution-profile.schema.json` | 38 | 3622 | `11b78556d529fcaca77a16c7975ba0988b62c27810da21b763dfef8793402c41` | ✓ full |
| 8 | `docs/zob/schemas/gate.schema.json` | 24 | 2166 | `278f14bb941756ec7b6287720bf04aa6b1f05f820613d4d2ba0ee73012bba04a` | ✓ full |
| 9 | `docs/zob/schemas/merge-authorization.schema.json` | 21 | 2559 | `85cad0baf209944650cfdaff035244daa726bf839a7b5a47974796eabd994b2c` | ✓ full |
| 10 | `docs/zob/schemas/mission-event.schema.json` | 36 | 1762 | `c62a313c6545981055b011ac1da8731f1b47c2569c1d1faee89e279181c4aa3c` | ✓ full |
| 11 | `docs/zob/schemas/mission.schema.json` | 51 | 3574 | `c86976180dcbf062ddcf7f2bd668b62216d69fee1a461a5d8b3f3efccdf08d6e` | ✓ full |
| 12 | `docs/zob/schemas/model-attempt.schema.json` | 28 | 3431 | `0aa51172fe117031be7c1d9b22a83a0245b36868c3f376550716ff7bd8baa2ba` | ✓ full |
| 13 | `docs/zob/schemas/pr-close-evidence.schema.json` | 23 | 3168 | `94b4687a8d59a0d6c7ec6681364a8c8d8f57253320f514f0a181118bf5748f90` | ✓ full |
| 14 | `docs/zob/schemas/promotion-authorization.schema.json` | 55 | 4915 | `233f5a3e28a60ebe51080610fd3bd3d653ae96e05e8881c07859e6aa4b8e8888` | ✓ full |
| 15 | `docs/zob/schemas/promotion-merge-evidence.schema.json` | 104 | 5431 | `79714936817743f7715c60438d1d919cf199f555a31e39c424879a8dbbd80b22` | ✓ full |
| 16 | `docs/zob/schemas/repository-assurance-result.schema.json` | 127 | 7979 | `856c376d758a95a0a58af7bd886afd1f51e226f4ab8ab6a16c8e0cacc6c6ebf8` | ✓ full |
| 17 | `docs/zob/schemas/source-doc-coverage.schema.json` | 65 | 4769 | `980c6544c11fa29681a64636f9637456158f38a51ad6d53c5b3aac282cc1a080` | ✓ full |
| 18 | `docs/zob/schemas/staging-candidate.schema.json` | 113 | 6557 | `114bfaa4804a561c6d862d062d33e0ffdef336bcfdc606c3539c9d9cbc1c4976` | ✓ full |
| 19 | `docs/zob/schemas/story-execution.schema.json` | 27 | 4814 | `e02769809a81d2b80656ab4d8d43038a9fd157130542d31010d1aba076ab7b3b` | ✓ full |
| — | `docs/zob/schemas/task.schema.json` | 30 | 4994 | `23958e31956736ecbcc21ca1cdac56998e15090bd2e7b27915e08544b19ae044` | ✓ full |

### Examples (21 files)

| # | Path | Lines | Bytes | SHA-256 (verified) | Read |
|---|---|---|---|---|---|
| 1 | `docs/zob/examples/README.md` | 29 | 2393 | `fe5057070206c9b3f7e219102c3b7fbc8e53da3e7a2ea4b30012ecb235798c45` | ✓ full |
| 2 | `docs/zob/examples/ack-receipt.example.json` | 16 | 1001 | `6c2b87a7fb3702c402155eb26258e3d02ae0777d5124b40ad0c1088655e18823` | ✓ full |
| 3 | `docs/zob/examples/assurance-repair-round.example.json` | 40 | 1714 | `d5beafcc2cdfc4bfae98b1b342eb2ef167ddd926c128c3215ddbfa9f06036bf5` | ✓ full |
| 4 | `docs/zob/examples/blind-review-result.example.json` | 21 | 1504 | `ecc66f9a076a8d0b03fc9f82891be46160cb23ff63510be1673548a5e1b7cd48` | ✓ full |
| 5 | `docs/zob/examples/checkpoint.example.json` | 19 | 1368 | `a8cc942776ed0803cb1cfb14d4292ba1c3ed0a7b4edd356ae1f5a01dc1a91140` | ✓ full |
| 6 | `docs/zob/examples/evidence.example.json` | 15 | 1485 | `662c4a54a2e7211201d478bd6b976cbb1381909a0550624f48152f689f46ab91` | ✓ full |
| 7 | `docs/zob/examples/execution-profile.example.json` | 19 | 1244 | `7a4c5842b040fc449e3fc8c47f8e612a92c1dc22cc92390d7741805d5cd87503` | ✓ full |
| 8 | `docs/zob/examples/gate.example.json` | 15 | 952 | `830d83762563b6085c83c663dad49eb65e77479ec428a19dca74496ac8a6bdbc` | ✓ full |
| 9 | `docs/zob/examples/merge-authorization.example.json` | 26 | 1245 | `42f114b7f8c6eaa94d2c1c88e324bc4efb2dfcd53d162a6a35b65907801fecd6` | ✓ full |
| 10 | `docs/zob/examples/mission-event.example.json` | 22 | 908 | `95f69f9a18bd79191b7c8bd163b49a9820b7ea84a2eb4940d3961c67fd3a7fbe` | ✓ full |
| 11 | `docs/zob/examples/mission.example.json` | 16 | 1330 | `08b4865feb64db07c9816784769df0e8ad4bd72b219353766fdbe2c5f99fc441` | ✓ full |
| 12 | `docs/zob/examples/model-attempt.example.json` | 25 | 1198 | `d8cc5f02cb145b46f2bc9a3b4a010a49c33887f8377367417afabb6b9f8c1212` | ✓ full |
| 13 | `docs/zob/examples/pr-close-evidence.example.json` | 24 | 1862 | `0b3ca2d931afa24418d7a42081679807b3de3ddb93370ab6de4554677fd0dc1e` | ✓ full |
| 14 | `docs/zob/examples/promotion-authorization.example.json` | 58 | 2530 | `ecc2889e5410a707547f695bc665994e539c2d3e35452a8de749c8cc655b6187` | ✓ full |
| 15 | `docs/zob/examples/promotion-merge-ack-receipt.example.json` | 27 | 1231 | `e89679f50f1c5e4e99f607834916ccdb3fe18664ac9ddee15c1a272d33b9ef42` | ✓ full |
| 16 | `docs/zob/examples/promotion-merge-evidence.example.json` | 62 | 2464 | `c876c553d93b6c97870cf28d231eb905a4e402e546d42b854abcd5ae470e4511` | ✓ full |
| 17 | `docs/zob/examples/promotion-window-ack-receipt.example.json` | 25 | 1186 | `0822a8c069f814fb499607bc9437ffe6a8e492a23b065b7d4d621396b8bb2396` | ✓ full |
| 18 | `docs/zob/examples/repository-assurance-result.example.json` | 71 | 4448 | `88bca249dd9294775353d896ce04ce110bf3e7f7060d95574d20ef53acc8fa4d` | ✓ full |
| 19 | `docs/zob/examples/source-doc-coverage.example.json` | 61 | 2663 | `97b0688778f6d9ad89c610a5cda1cedeaab7c5233350b0d497c49566386b01fe` | ✓ full |
| 20 | `docs/zob/examples/staging-candidate.example.json` | 45 | 3576 | `cb2d8fff68eff1bd1567b6eab1cd4f7acd6eda5ecdf14a3b362f83b2aba06828` | ✓ full |
| 21 | `docs/zob/examples/story-execution.example.json` | 24 | 2195 | `1086a7fd6a756a8ca09d6e1f87384b515900c207c70c3e5c46e41235c61dff28` | ✓ full |
| — | `docs/zob/examples/task.example.json` | 22 | 2244 | `fe79e31a58332e78e67c9c56e52461e1ad83cf57036b114e5c2fc6e31374c689` | ✓ full |

### Validators (2 files)

| # | Path | Lines | Bytes | SHA-256 (verified) | Read |
|---|---|---|---|---|---|
| 1 | `docs/zob/validation/validate_contracts.py` | 432 | 27177 | `b84587d1d7daa2fa841933365d11b739be36b02805355e91d12e85ab499c75b9` | ✓ full |
| 2 | `docs/zob/validation/validate_documentation.py` | 215 | 10059 | `581cb7bf40e0dffffa74b9dfddc36f7accd1bff43a182b3bd1fcf0ef21d852cc` | ✓ full |

---

## 4. Independent schema/example semantic checks

### 4.1 Draft 2020-12 / additionalProperties / body policy

- **Draft 2020-12:** all 19 schemas declare `"$schema": "https://json-schema.org/draft/2020-12/schema"`. Zero deviations.
- **`additionalProperties: false`:** all 19 root object schemas set it false. Recursive scan of all nested object schemas (array items, property sub-objects, `$defs`) found **zero** gaps — every object-with-properties schema closes unknown fields.
- **`bodyStored: false`:** all 15 runtime record schemas require `bodyStored` with `const: false`. The 4 static manifest templates (`execution-profile`, `gate`, `story-execution`, `task`) correctly omit the field entirely — they define work, not journal records. This matches the README rule: *"Every appended runtime event/checkpoint/evidence/receipt record requires `bodyStored: false`. Static manifest templates … intentionally omit the field."*
- **Forbidden payload keys:** `mission-event.schema.json` payload uses `not: {anyOf: [...]}` to reject `rawBody`, `prompt`, `response`, `transcript`, `credential`, `rawDiff`. Verified.
- **`model-attempt.schema.json`** properties contain zero raw-like fields (`prompt`, `output`, `response`, `transcript`, `rawBody`, `rawDiff`, `credential`). Its description states: *"Protected telemetry only; never expose this record to agent task contexts or story evidence."* The schema itself enforces body-safety structurally.

### 4.2 Canonical terminal-hash construction

`schemas/README.md` (lines 30-33) specifies the canonical hash construction:
- Record hashes use **RFC 8785 JSON Canonicalization Scheme** bytes and **SHA-256**.
- Before hashing, omit only the record's own terminal hash field.
- For nested candidate artifacts, omit `artifactHashes.candidate`; referenced prior/input hashes remain included.
- This avoids self-reference and makes every receipt/candidate/result digest reproducible.

Verified present in the README. All hash fields in schemas use `pattern: "^[a-f0-9]{64}$"` (SHA-256) or `^[a-f0-9]{40}$` (git SHA-1). IDs are full-length.

### 4.3 Initial window ACK → candidate revision/hash chain → repair contract → round-2 assurance → final promotion ACK/auth/evidence lineage

The 7-record promotion lineage was independently verified field-by-field:

| Link | Check | Result |
|---|---|---|
| window-ack → candidate | `window_ack.scope.stagingSha == candidate.initialStagingSha` | ✓ `999…` |
| window-ack → candidate | `window_ack.scope.candidateRevision == 1` (schema const) | ✓ |
| window-ack → candidate | `window_ack.scope.candidateHash == repairLineage[0].priorCandidateHash` | ✓ `232…` |
| candidate internal | `candidateRevision == len(repairLineage) + 1` (2 == 1+1) | ✓ |
| candidate internal | `priorCandidateHash == repairLineage[0].priorCandidateHash` | ✓ `232…` |
| candidate internal | `artifactHashes.candidate == repairLineage[-1].resultingCandidateHash` | ✓ `777…` |
| repair round 1 | `round == 1 <= 2` (repair only after rounds 1..2) | ✓ |
| repair round 1 | `beforeCandidateRevision == round` (1==1) | ✓ |
| repair round 1 | `afterCandidateRevision == round+1` (2==2) | ✓ |
| repair round 1 | `nextAssuranceRound == round+1` (2==2) | ✓ |
| repair round 1 | `assuranceId in invalidatedAssuranceIds` | ✓ |
| repair → assurance | `repair.afterStagingSha == assurance.stagingSha` | ✓ `aaa…` |
| repair → assurance | `repair.nextAssuranceRound == assurance.round` (2==2) | ✓ |
| repair → assurance | `repair.repairRoundId in assurance.repairRoundIds` | ✓ |
| assurance | `candidateRevision == candidate.candidateRevision` (2==2) | ✓ |
| assurance | `candidateHash == candidate.artifactHashes.candidate` | ✓ `777…` |
| assurance | `verdict == pass`, `noShip == false` | ✓ |
| authorization | `candidateRevision == 2` (final) | ✓ |
| authorization | `candidateHash == candidate.artifactHashes.candidate` | ✓ `777…` |
| authorization | `assurance.assuranceId == assurance.assuranceId` | ✓ |
| authorization | `assurance.resultHash == assurance.resultHash` | ✓ `151…` |
| authorization | `assurance.verdict == pass`, `noShip == false` | ✓ |
| authorization | `windowReceiptHash == window_ack.receiptHash` | ✓ `444…` |
| authorization | `promotionMergeReceiptHash == merge_ack.receiptHash` | ✓ `171…` |
| authorization | `includedPrNumbers` set == candidate PR set | ✓ {4101,4102,4110} |
| merge-evidence | `authorizationId == authorization.authorizationId` | ✓ |
| merge-evidence | `authorizationHash == authorization.authorizationHash` | ✓ `202…` |
| merge-evidence | `candidateRevision == 2` | ✓ |
| merge-evidence | `candidateHash == candidate.artifactHashes.candidate` | ✓ `777…` |
| merge-evidence | `parents.developParentSha == developBaseSha` | ✓ `bbb…` |
| merge-evidence | `parents.auditedStagingParentSha == stagingSha` | ✓ `aaa…` |
| merge-evidence | `parents.auditedStagingIsParent == true` | ✓ |
| merge-evidence | `treeProof.treesEqual == true` | ✓ |
| merge-evidence | `manualDispatchPerformed == false` | ✓ |
| staging SHA chain | `candidate == assurance == authorization == merge.stagingSha` | ✓ `aaa…` |
| develop SHA chain | `candidate == assurance == authorization == merge.developBaseSha` | ✓ `bbb…` |

### 4.4 Unique complete cohort + repair PR sets

- Staged-cohort PRs: `[4101, 4102]`
- Assurance-repair PRs: `[4110]`
- All PR numbers across `includedPullRequests` are unique: ✓
- `authorization.includedPrNumbers == {4101, 4102, 4110}` matches candidate set: ✓
- Repair PR set lineage: `candidate.repairLineage[0].repairPrNumbers == {4110}` == included repair PRs == `repair.repairPullRequests` PR numbers: ✓
- The final included PR (4110, repair) `stagingMergeSha == candidate.stagingSha` (`aaa…`): ✓

### 4.5 Assurance rounds 1..3, repair only after 1..2

- `staging-candidate.schema.json`: `maxAssuranceRounds: const 3`, `maxAutomaticRepairTransitions: const 2`, `repairLineage: maxItems 2`, `candidateRevision: maximum 3`.
- `assurance-repair-round.schema.json`: `round: minimum 1, maximum 2`, `nextAssuranceRound: minimum 2, maximum 3`, `beforeCandidateRevision: maximum 2`, `afterCandidateRevision: minimum 2, maximum 3`.
- Example: round-1 repair (round=1) → nextAssuranceRound=2 → assurance round-2 pass. No repair after round 3. ✓
- `repository-assurance-result.schema.json`: `repairRoundIds: maxItems 2`, `round: minimum 1, maximum 3`. ✓

### 4.6 Degraded family and non-pass noShip rules

**Degraded family** (`repository-assurance-result.schema.json` allOf):
- If `eligibleFamilyCount <= 2` → `degraded: const true` + `degradationReasonHash` required.
- `anyOf`: either `eligibleFamilyCount <= 2` (degraded allowed) or `eligibleFamilyCount >= 3 AND usedFamilyCount >= 3`.
- Semantic validator independently confirmed: if `eligibleFamilyCount >= 3` then `len(used_families) >= 3`; else `degraded == true` and `degradationReasonHash` present.
- Example: `eligibleFamilyCount=3, usedFamilyCount=3, degraded=false`, 3 unique families (A/B/C). ✓

**Non-pass noShip** (`repository-assurance-result.schema.json` allOf):
- If `verdict in [blocked, needs-human, invalid]` → `noShip: const true`.
- If `verdict == pass` → `noShip: const false` + all 10 lanes pass + clean docs/coverage + zero blocking findings + assurance check conclusion success.
- Example: `verdict=pass, noShip=false`, all 10 lanes pass. ✓

### 4.7 Separate receipts / Apps

- **Separate receipts:** window receipt (`444…`), merge receipt (`171…`), deployment-impact acknowledgement receipt (`191…`) are three distinct hashes. ✓
- **Separate Apps:** PR-close evidence issuer type = `builder-app` with checkName `ZOB / PR Close`. Promotion merge evidence has `promotionAppId`. Assurance check issuer type = `reviewer-app`. The documentation (section 17) references `Staging Merge App` and `Promotion App` as distinct. ✓
- `promotion-authorization.schema.json` separately requires `windowReceiptHash` and `promotionMergeReceiptHash` as distinct required fields. ✓

### 4.8 Merge parents / tree

- `promotion-merge-evidence.schema.json` requires `parents` with `developParentSha`, `auditedStagingParentSha`, `auditedStagingIsParent: const true`.
- `treeProof` requires `promotionTreeHash`, `auditedStagingTreeHash`, `treesEqual: const true`.
- `mergeMethod: const "merge-commit"`.
- Example: `auditedStagingIsParent=true`, `treesEqual=true`, both tree hashes `eee…`. ✓
- Semantic validator checks: `parents.developParentSha == developBaseSha`, `parents.auditedStagingParentSha == stagingSha`. ✓

### 4.9 Active unknown-impact rejection

- `promotion-authorization.schema.json` allOf: if `status == active` → `deploymentImpact.classification` must be `automatic-cd-expected` or `no-deploying-path` (not `unknown-blocked`).
- Example: `status=active`, `classification=automatic-cd-expected`. ✓
- Negative guard #13 independently verified: setting `classification=unknown-blocked` with `status=active` is schema-rejected. ✓

### 4.10 Expected automatic push CD observation and completed conclusion

- `promotion-merge-evidence.schema.json`: `automaticCdRuns` items require `triggerEvent: const "push"` and `triggerSha` (40-hex). If `status == completed` → `conclusion` required.
- Semantic validator: if `authorization.deploymentImpact.classification == automatic-cd-expected` → `merge.automaticCdRuns` must be non-empty. Each run: `triggerEvent == "push"` and `triggerSha == merge.promotionMergeSha`.
- Example: `classification=automatic-cd-expected`, one CD run with `triggerEvent=push`, `triggerSha == promotionMergeSha` (`ddd…`), `status=in-progress` (conclusion not yet required). ✓
- **Completed conclusion:** `merge.status == complete` → allOf enforces `reconciliation.result=pass`, `stagingAlignment.result=fast-forwarded`, `alignedHeadIntegration.result=pass`, `queueUnfrozen=true`. Example: all four pass. ✓
- Negative guards #16, #17, #18, #19 independently verified: blocked alignment, failed aligned-head CI, missing CD run, and completed-without-conclusion are all rejected. ✓

### 4.11 Aligned-head staging CI before unfreeze

- `promotion-merge-evidence.schema.json` allOf: `status == complete` → `reconciliation.alignedHeadIntegration.result == pass` AND `queueUnfrozen == true`.
- Semantic validator: if `queueUnfrozen` → `result == pass AND alignment.result == fast-forwarded AND aligned_ci.result == pass`.
- Example: `alignedHeadIntegration.headSha == alignment.newSha == promotionMergeSha` (`ddd…`), `result=pass`, `queueUnfrozen=true`. ✓
- This confirms: new aligned head passes staging CI **before** the queue unfreezes. ✓

### 4.12 Read-only legacy tokens reject new missions/effects

- `merge-authorization.schema.json`: `migrationReadOnly: const true`, `migrationDisposition: const "historical-only"`, both required. `mergeMethod: const "squash"`. `deploymentImpact.manualDispatchAuthorized: const false`.
- `mission.schema.json` allOf: `factoryType in [pr-ship, post-merge-reconciliation]` → `migrationReadOnly` required + `status in [complete, cancelled]` only.
- `evidence.schema.json` allOf: `evidenceType in [merge-authorization, ship-gate, post-merge]` → `migrationReadOnly` required + `status in [stale, invalid, superseded]`. Also: `issuer.type == ship-app` → same constraint.
- Example: `merge-authorization.example.json` has `targetBranch: "develop"`, `migrationReadOnly: true`, `migrationDisposition: "historical-only"`. The `schemas/README.md` states: *"Legacy direct-base schemas/tokens are read-only migration inputs; the Wheel adapter rejects them for new missions, Checks and effects."* ✓
- Negative guards #25, #26 independently verified: active legacy mission (`factoryType=pr-ship`) and current legacy evidence (`evidenceType=ship-gate`) are schema-rejected. ✓

### 4.13 All 26 negative guards

Each guard was independently replicated by mutating the relevant example and confirming rejection. All 26 correctly reject:

| # | Guard | Type | Independently verified |
|---|---|---|---|
| 1 | public element without doc mapping | schema | ✓ rejected |
| 2 | coverage count drift | semantic | ✓ rejected |
| 3 | passing assurance with stale docs | schema | ✓ rejected |
| 4 | assurance missing mandatory lane | schema | ✓ rejected |
| 5 | three eligible families not used | schema | ✓ rejected |
| 6 | used family count exceeds eligible | semantic | ✓ rejected |
| 7 | family shortage marked undegraded | schema | ✓ rejected |
| 8 | non-pass assurance with noShip false | schema | ✓ rejected |
| 9 | auditor repairs its own finding | semantic | ✓ rejected |
| 10 | repair after assurance round three | schema | ✓ rejected |
| 11 | non-sequential next assurance round | semantic | ✓ rejected |
| 12 | squash promotion | schema | ✓ rejected |
| 13 | active promotion with unknown impact | schema | ✓ rejected |
| 14 | wrong staging parent | semantic | ✓ rejected |
| 15 | manual workflow dispatch | schema | ✓ rejected |
| 16 | queue unfreeze before staging alignment | schema | ✓ rejected |
| 17 | queue unfreeze before aligned-head CI | schema | ✓ rejected |
| 18 | expected automatic CD run missing | semantic | ✓ rejected |
| 19 | completed CD run without conclusion | schema | ✓ rejected |
| 20 | duplicate candidate PR number | semantic | ✓ rejected |
| 21 | candidate repair PR-set mismatch | semantic | ✓ rejected |
| 22 | window receipt bound to repaired head | semantic | ✓ rejected |
| 23 | incomplete high-risk Blind Review panel | schema | ✓ rejected |
| 24 | overlay ID declared as base | schema | ✓ rejected |
| 25 | active legacy mission | schema | ✓ rejected |
| 26 | current legacy evidence | schema | ✓ rejected |

### 4.14 Enum parity and deferred-action layering

- `ack-receipt.ackType` enum (11 values) == `execution-profile.humanReceiptTypes` enum (11 values): ✓ identical.
- `story-execution.deferredActions` (7 values) ⊂ `execution-profile.deferredActions` (11 values) == `mission.completion.forbiddenActions` (11 values): ✓
- Story-level omits `staging-merge`, `promotion`, `repository-assurance`, `workflow-dispatch` — these are factory-level/staging-level deferrals, not story-level. ✓
- `workflow-dispatch` present in profile/mission but absent from story: correct — stories don't dispatch workflows directly. ✓

### 4.15 Blind-review risk-class lane requirements

- `low` → requires `general-control` lane (control=true, complete). ✓
- `medium` → requires `general-control` + `evidence-domain` lanes. ✓
- `high`/`critical` → requires `general-control` + `security-domain` + `evidence-qa` lanes. ✓
- Example: `riskClass=medium`, 2 lanes (general-control + evidence-domain), both control=true, complete. ✓
- Negative guard #23: high-risk with only general-control is schema-rejected. ✓

### 4.16 PR-close three-auditor exact-head

- `pr-close-evidence.schema.json`: `audits` minItems=3, maxItems=3, auditType enum `[source-integration, evidence-qa-ci, finalizer]`.
- `issuer.type: const "builder-app"`, `issuer.checkName: const "ZOB / PR Close"`.
- Example: 3 audits, all verdict=pass, issuer type=builder-app. ✓

### 4.17 Coverage inventory integrity

- `source-doc-coverage.schema.json`: elements require `sourceRefs` (minItems 1), `evidenceRefs` (minItems 1). Public-operational elements must be `canonical-documented` with `docRefs` (minItems 1).
- Example: 3 elements, total=3, disposed=3, counts match, no duplicates, public element has docRefs. ✓
- `complete-clean` status → `missingDocumentation=0, unknownOrUnresolved=0, duplicateElementIds=0`. ✓

### 4.18 Staging deployment disabled

- `staging-candidate.schema.json`: `integration.deploymentDisabledProof.stagingCanTriggerDeployment: const false`.
- Example: `stagingCanTriggerDeployment=false`, with `workflowManifestHash` and `proofArtifactHash`. ✓
- `stagingBranch: const "develop-staging"`, `developBranch: const "develop"`. ✓

---

## 5. Path:line findings

| ID | Path:line | Finding | Severity | Current-branch fix |
|---|---|---|---|---|
| — | — | No findings | — | — |

No schema, example, validator, or README defects were found in this lane. All 44 files match their manifest hash/line/byte counts. All 19 schemas are valid Draft 2020-12 with closed `additionalProperties`. All 21 examples validate against their schemas. Both validators pass and their 26 negative guards were independently confirmed. The promotion lineage chain is internally consistent across all 7 records. Body policy, canonical hash construction, legacy read-only rejection, degraded-family rules, non-pass noShip rules, separate receipts/Apps, merge parents/tree, active unknown-impact rejection, CD observation, aligned-head CI before unfreeze, and assurance round/repair bounds are all correctly specified and exemplified.

---

## 6. Verdict

**Verdict: PASS**
**no_ship: false**

All 44 lane files independently audited:
- 19 schemas: valid Draft 2020-12, closed `additionalProperties`, correct body policy, correct terminal-hash construction rules.
- 21 examples: validate against schemas, form a coherent promotion lineage, correct enum parity.
- 2 validators: pass; 26 negative guards independently challenged and confirmed.
- 2 READMEs: accurate schema/example index, correct policy assertions.

No findings, no warnings, no no-ship blockers.

LANE_AUDIT_COMPLETE