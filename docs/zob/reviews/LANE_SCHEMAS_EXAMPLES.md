# Lane Audit Report — `docs/zob/schemas/` + `docs/zob/examples/`

**Review ID:** LANE_SCHEMAS_EXAMPLES
**Pass:** Second-pass (post-repair)
**Scope:** Full audit of every file in `docs/zob/schemas/` and `docs/zob/examples/` — 28 files (13 schemas, 13 examples, 2 READMEs).
**Scope manifest consulted:** `docs/zob/reviews/SCOPE_MANIFEST.json` (schema `zob.doc-audit-scope.v1`, reviewMode `full`, lane files listed in `files[]`).
**Tools used:** `read` (all 28 files read fully, no sampling), read-only bash + Python 3 + `jsonschema` 4.25.1 (Draft 2020-12), `write` (this report only).
**Constraints honored:** No edits except this named report; no network/secrets/transcripts; no sampling; no live-record claims. All hashes/URLs in examples are deterministic placeholders; `https://github.invalid/run/1` is an intentional non-real URL.

## 1. Per-file coverage

All 28 lane files were read in full. File count confirmed: `find docs/zob/schemas docs/zob/examples -type f | wc -l` = 28, matching the 28 lane entries in the scope manifest.

| # | File | Lines (wc -l) | Bytes | Read fully | JSON valid | Meta-schema | Example→schema |
|--:|---|--:|--:|:--:|:--:|:--:|:--:|
| 1 | `schemas/README.md` | 29 | 1579 | ✅ | n/a | n/a | n/a |
| 2 | `schemas/mission.schema.json` | 43 | 3122 | ✅ | ✅ | ✅ | ✅ |
| 3 | `schemas/mission-event.schema.json` | 35 | 1762 | ✅ | ✅ | ✅ | ✅ |
| 4 | `schemas/story-execution.schema.json` | 26 | 4814 | ✅ | ✅ | ✅ | ✅ |
| 5 | `schemas/execution-profile.schema.json` | 37 | 3508 | ✅ | ✅ | ✅ | ✅ |
| 6 | `schemas/gate.schema.json` | 23 | 2166 | ✅ | ✅ | ✅ | ✅ |
| 7 | `schemas/task.schema.json` | 30 | 4994 | ✅ | ✅ | ✅ | ✅ |
| 8 | `schemas/evidence.schema.json` | 23 | 3142 | ✅ | ✅ | ✅ | ✅ |
| 9 | `schemas/pr-close-evidence.schema.json` | 22 | 3168 | ✅ | ✅ | ✅ | ✅ |
| 10 | `schemas/ack-receipt.schema.json` | 25 | 2202 | ✅ | ✅ | ✅ | ✅ |
| 11 | `schemas/model-attempt.schema.json` | 27 | 3431 | ✅ | ✅ | ✅ | ✅ |
| 12 | `schemas/blind-review-result.schema.json` | 49 | 5227 | ✅ | ✅ | ✅ | ✅ |
| 13 | `schemas/merge-authorization.schema.json` | 18 | 2395 | ✅ | ✅ | ✅ | ✅ |
| 14 | `schemas/checkpoint.schema.json` | 21 | 3171 | ✅ | ✅ | ✅ | ✅ |
| 15 | `examples/README.md` | 20 | 1181 | ✅ | n/a | n/a | n/a |
| 16 | `examples/mission.example.json` | 15 | 1268 | ✅ | ✅ | n/a | ✅ |
| 17 | `examples/mission-event.example.json` | 21 | 908 | ✅ | ✅ | n/a | ✅ |
| 18 | `examples/story-execution.example.json` | 23 | 2179 | ✅ | ✅ | n/a | ✅ |
| 19 | `examples/execution-profile.example.json` | 18 | 1223 | ✅ | ✅ | n/a | ✅ |
| 20 | `examples/gate.example.json` | 14 | 952 | ✅ | ✅ | n/a | ✅ |
| 21 | `examples/task.example.json` | 21 | 2244 | ✅ | ✅ | n/a | ✅ |
| 22 | `examples/evidence.example.json` | 14 | 1485 | ✅ | ✅ | n/a | ✅ |
| 23 | `examples/pr-close-evidence.example.json` | 23 | 1854 | ✅ | ✅ | n/a | ✅ |
| 24 | `examples/ack-receipt.example.json` | 15 | 1001 | ✅ | ✅ | n/a | ✅ |
| 25 | `examples/model-attempt.example.json` | 24 | 1198 | ✅ | ✅ | n/a | ✅ |
| 26 | `examples/blind-review-result.example.json` | 20 | 1496 | ✅ | ✅ | n/a | ✅ |
| 27 | `examples/merge-authorization.example.json` | 23 | 1171 | ✅ | ✅ | n/a | ✅ |
| 28 | `examples/checkpoint.example.json` | 18 | 1368 | ✅ | ✅ | n/a | ✅ |

**Coverage verdict:** 28/28 files read fully; 26/26 JSON files well-formed; 13/13 schemas meta-valid against Draft 2020-12; 13/13 examples validate against their sibling schema.

## 2. Draft 2020-12 / meta / example live validation

### 2.1 Meta-schema compliance (every schema is a valid Draft 2020-12 schema)

`Draft202012Validator.check_schema()` was run on all 13 schema files.

| Schema | `$schema` | `$id` | Meta valid |
|---|---|---|:--:|
| mission | `https://json-schema.org/draft/2020-12/schema` | `urn:wheel:zob:mission:v1` | ✅ |
| mission-event | same | `urn:wheel:zob:mission-event:v1` | ✅ |
| story-execution | same | `urn:wheel:zob:story-execution:v1` | ✅ |
| execution-profile | same | `urn:wheel:zob:execution-profile:v1` | ✅ |
| gate | same | `urn:wheel:zob:gate:v1` | ✅ |
| task | same | `urn:wheel:zob:task:v1` | ✅ |
| evidence | same | `urn:wheel:zob:evidence:v1` | ✅ |
| pr-close-evidence | same | `urn:wheel:zob:pr-close-evidence:v1` | ✅ |
| ack-receipt | same | `urn:wheel:zob:ack-receipt:v1` | ✅ |
| model-attempt | same | `urn:wheel:zob:model-attempt:v1` | ✅ |
| blind-review-result | same | `urn:wheel:zob:blind-review-result:v1` | ✅ |
| merge-authorization | same | `urn:wheel:zob:merge-authorization:v1` | ✅ |
| checkpoint | same | `urn:wheel:zob:checkpoint:v1` | ✅ |

**Result: 13/13 meta-valid.** Every schema declares the correct `$schema` URI and a `urn:wheel:zob:*:v1` `$id`.

### 2.2 Example live validation (each example against its sibling schema)

`Draft202012Validator.iter_errors()` was run for each of the 13 example→schema pairs.

**Result: 13/13 examples validate cleanly (0 errors).** No example violates any required field, enum, pattern, const, `additionalProperties:false`, or `allOf` conditional in its sibling schema.

### 2.3 `additionalProperties: false` coverage

All 13 schemas set `additionalProperties: false` at root. Nested object definitions also enforce `additionalProperties: false` throughout (counts: mission=7, mission-event=1, story-execution=10, execution-profile=5, gate=5, task=13, evidence=7, pr-close-evidence=7, ack-receipt=4, model-attempt=5, blind-review-result=5, merge-authorization=4, checkpoint=7). No open object accepts arbitrary fields except the intentional `mission-event.payload` (which is guarded — see §4.2).

## 3. Cross-schema version / hash / body / risk / status consistency

### 3.1 Schema-const vs `$id` alignment

Each schema declares both a `$id` (URN resource) and a top-level `schema` property with a `const` tag. Three schemas use a domain-named `schema` const that differs from the `$id` tail — this is intentional design (the const is the domain contract name, the `$id` is the schema resource name):

| Schema | `$id` tail | `schema` const | Example tag matches const |
|---|---|---|:--:|
| gate | `gate:v1` | `zob.story-gate.v1` | ✅ |
| task | `task:v1` | `zob.story-task.v1` | ✅ |
| checkpoint | `checkpoint:v1` | `zob.mission-checkpoint.v1` | ✅ |

All other 10 schemas have `$id` tail == `schema` const. **Every example's `schema` tag matches its sibling schema's `const` exactly (13/13, 0 mismatches).**

### 3.2 Hash-length integrity

- All `sha-256` patterns in schemas use `^[a-f0-9]{64}$`; all `git sha-1` patterns use `^[a-f0-9]{40}$`.
- All placeholder hash *values* in examples are correct length (64 hex for sha-256 fields, 40 hex for git sha-1 fields): **0 example hash-value length issues.**
- Pattern counts per schema confirmed (e.g. evidence: 3×40hex/6×64hex, blind-review-result: 2×40hex/7×64hex, pr-close-evidence: 2×40hex/5×64hex).

### 3.3 `bodyStored: false` enforcement

Per `schemas/README.md`: *"Runtime events/checkpoints require `bodyStored: false`."* The 9 **runtime ledger / event / receipt / telemetry** schemas enforce `bodyStored` as a required `const: false`:

| Runtime schema | `bodyStored` required | `const: false` |
|---|:--:|:--:|
| mission | ✅ | ✅ |
| mission-event | ✅ | ✅ |
| evidence | ✅ | ✅ |
| pr-close-evidence | ✅ | ✅ |
| ack-receipt | ✅ | ✅ |
| model-attempt | ✅ | ✅ |
| blind-review-result | ✅ | ✅ |
| merge-authorization | ✅ | ✅ |
| checkpoint | ✅ | ✅ |

The 4 **design manifest / contract** schemas (story-execution, execution-profile, gate, task) intentionally do **not** declare `bodyStored` — they are design artifacts, not runtime ledgers, so the README rule does not apply to them. All 9 runtime examples set `bodyStored: false`. **No bodyStored defect.** This is semantically correct, not a gap.

### 3.4 Risk-enum consistency

`['low','medium','high','critical']` is used identically across:
- `gate.reviewPolicy.risk`
- `task.review.risk`
- `blind-review-result.riskClass`
- `execution-profile.selectors.riskAtLeast`

**Match: consistent across all 4 schemas.**

### 3.5 Status / verdict enums

- `blind-review-result.verdict`: `['pass','findings','needs-human','invalidated']`
- `pr-close-evidence.verdict`: `['pass','fail','needs-human','invalidated']`
- `evidence.status`: `['current','stale','invalid','superseded']`
- `mission.status`: `['admitting','active','paused','needs-human','recovery-blocked','complete','failed','cancelled']`

These are domain-appropriate and not required to be identical (different lifecycle stages). No contradiction detected.

## 4. Semantic invariants

### 4.1 Repaired issue #1 — security-critical/critical risk divergence (CONFIRMED FIXED)

The blind-review-result `allOf` conditionals now require **identical** lane sets for `high` and `critical`:

| riskClass | requiredLaneTypes | lane constraints |
|---|---|---|
| `low` | `general-control` | 1 lane: general-control, control=true, status=complete |
| `medium` | `general-control` + `evidence-domain` | 2 lanes, both control=true, status=complete |
| `high` | `general-control` + `security-domain` + `evidence-qa` | 3 lanes, all control=true, status=complete |
| `critical` | `general-control` + `security-domain` + `evidence-qa` | 3 lanes, all control=true, status=complete |

**Disprove tests (9/9 passed):**
- HIGH all-3 valid → ACCEPTED; CRITICAL all-3 (same set) valid → ACCEPTED.
- HIGH with `evidence-domain` instead of `security-domain` → **REJECTED** (old medium lane set no longer accepted on high risk).
- CRITICAL with `evidence-domain` instead of `security-domain` → **REJECTED**.
- HIGH with extra 4th lane but all required present → ACCEPTED (coverage is a contains, not exact, requirement — correct).
- HIGH with extra lane but missing `security-domain` → **REJECTED**.
- HIGH `security-domain` status=cancelled → **REJECTED**.
- HIGH `security-domain` control=false → **REJECTED**.
- HIGH lanes ok but `requiredLaneTypes` missing `security-domain` → **REJECTED**.

**Conclusion:** high and critical no longer diverge; both require the security-domain lane set. The pre-repair divergence (security-critical risk getting a weaker lane set) is eliminated.

### 4.2 Repaired issue #2 — under-enforced required lane coverage (CONFIRMED FIXED)

The schema enforces coverage on **both** `requiredLaneTypes` (via `contains`) **and** `lanes` (via `contains` with a sub-schema requiring `laneType` const + `control: true` + `status: complete`). Negative tests across all four risk classes:

| Test | Expected | Result |
|---|---|:--:|
| LOW missing general-control (empty lanes) | REJECT | ✅ REJECTED (4 errors) |
| LOW general-control control=false | REJECT | ✅ REJECTED |
| MEDIUM missing evidence-domain | REJECT | ✅ REJECTED |
| MEDIUM evidence-domain control=false | REJECT | ✅ REJECTED |
| HIGH missing security-domain | REJECT | ✅ REJECTED |
| HIGH security-domain control=false | REJECT | ✅ REJECTED |
| HIGH security-domain status=invalid | REJECT | ✅ REJECTED |
| CRITICAL missing evidence-qa | REJECT | ✅ REJECTED |
| CRITICAL missing general-control | REJECT | ✅ REJECTED |

**Positive controls (4/4 passed):** valid HIGH, valid CRITICAL, valid LOW, and the shipped MEDIUM example all ACCEPTED.

**Conclusion:** required lane coverage is now enforced at every risk class on both the type-list and the lane-instance dimensions (control + status). The pre-repair under-enforcement is eliminated.

### 4.3 Forbidden-field enforcement (mission-event.payload)

`mission-event.schema.json` declares `payload.not.anyOf` forbidding `rawBody`, `prompt`, `response`, `transcript`, `credential`, `rawDiff`. All 6 were tested as payload keys → **all 6 REJECTED**. This is the only open object in any schema; all other objects use `additionalProperties: false`, which independently rejects any of these field names anywhere else. Defense-in-depth is intact.

### 4.4 Security-critical consts

| Const | Schema | Negative test |
|---|---|---|
| `merge-authorization.deploymentImpact.manualDispatchAuthorized = false` | merge-authorization | `true` → REJECTED ✅ |
| `pr-close-evidence.gates.status = accepted` | pr-close-evidence | other → REJECTED ✅ |
| `pr-close-evidence.audits` min/max = 3/3 | pr-close-evidence | 2 audits → REJECTED ✅ |
| `pr-close-evidence.issuer.type = builder-app` | pr-close-evidence | (const) ✅ |
| `pr-close-evidence.issuer.checkName = "ZOB / PR Close"` | pr-close-evidence | (const) ✅ |
| `story-execution.branchContract.draftRequired = true` | story-execution | `false` → REJECTED ✅ |
| `execution-profile.compositionPolicy.mergeMode = union-stricter-wins` | execution-profile | `last-wins` → REJECTED ✅ |
| `execution-profile.compositionPolicy.canStrengthenAutomatically = true` | execution-profile | `false` → REJECTED ✅ |
| `execution-profile.compositionPolicy.requiresHumanToWeakenOrRemove = true` | execution-profile | (const) ✅ |

### 4.5 Cross-schema enum alignment

| Enum set | Schemas | Match |
|---|---|:--:|
| `authenticatedBy` = `[local-session, github-user, signed-receipt]` | ack-receipt.actor, merge-authorization.actor | ✅ |
| `ackType` / `humanReceiptTypes` (9 values) | ack-receipt.ackType, execution-profile.humanReceiptTypes | ✅ |
| `deferredActions` (7 values incl. `post-deploy-confirmation`) | story-execution, execution-profile | ✅ |
| `requiredAudits` / `auditType` = `[source-integration, evidence-qa-ci, finalizer]` | story-execution.prClose, pr-close-evidence.audits | ✅ |
| `profile.base` / base `profileId` = `[full-feature, quick-fix, docs-process, refactor-cleanup]` | story-execution.profile.base, execution-profile (base kind) | ✅ |
| `risk` = `[low, medium, high, critical]` | gate.reviewPolicy, task.review, blind-review-result.riskClass, execution-profile.riskAtLeast | ✅ |

### 4.6 execution-profile new schema/example (MUST DO item)

`execution-profile.schema.json` (37 lines, 3508 bytes) + `execution-profile.example.json` (profileId `security-trust`, kind `overlay`) deep-validated:

- `allOf` base/overlay profileId constraints: base→`full-feature|quick-fix|docs-process|refactor-cleanup`; overlay→15 values incl. `security-trust`. Cross-kind mismatches (base+overlay id, overlay+base id, base+unknown) all **REJECTED**.
- `version` semver-ish pattern `^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$` enforced (`1.0` rejected, `1.0.0` accepted).
- `selectors` requires `storyTypes, domains, surfaces, signalPredicateRefs`; missing `signalPredicateRefs` → REJECTED.
- `permissionAdditions` requires `capabilityRefs, deniedCapabilities`.
- `humanReceiptTypes` items enum enforced (bad type rejected).
- example `deferredActions: [deploy, provider-activation]` both in enum.

**Verdict: new execution-profile schema/example is valid, internally consistent, and cross-consistent with story-execution and ack-receipt.**

### 4.7 Repo-relative refs in examples

- All example refs are repo-relative paths (e.g. `docs/operations/kanban/stories/H31/...`, `execution/tasks/H31-G4-T2.json`, `src/services/ExampleService.ts`) or `local:`/`github-check:` scheme refs.
- Only one URL in any example: `https://github.invalid/run/1` in `pr-close-evidence.example.json` — an intentional non-real placeholder (`.invalid` TLD). No real URLs, no credentials, no tokens, no raw transcripts.

### 4.8 README link integrity

- `schemas/README.md` → `../examples/README.md` resolves ✅.
- `examples/README.md` cross-links all 13 example→schema pairs; the table maps every example to its correct sibling schema name ✅.

## 5. Scope manifest consistency

The scope manifest (`docs/zob/reviews/SCOPE_MANIFEST.json`) lists 49 files total; 28 are lane files. Verified against actual filesystem:

- **File count:** manifest lists 28 lane files; filesystem has 28 lane files. ✅ No missing, no extra.
- **Line counts:** The manifest uses the `content.split('\n')` convention (counts the final segment after the last `\n`). All 28 lane files lack a trailing newline, so `wc -l` reports `manifest_lines - 1`. Using the manifest's own convention, **line counts match exactly for all 28 files (0 drift).** This is a counting-convention difference, not a content defect.
- **Byte counts:** 25/28 lane files match exactly. **3 files have stale byte counts** (see Findings F-3).

## 6. Findings

### F-1 — `post-deploy-confirmation` missing from `mission.completion.forbiddenActions` enum (LOW)

**Where:** `schemas/mission.schema.json` → `completion.forbiddenActions.items.enum`.
**Evidence:** `mission.forbiddenActions` enum = `[formal-review, ready, merge, deploy, publish, provider-activation]` (6 values). `story-execution.deferredActions` and `execution-profile.deferredActions` both = `[formal-review, ready, merge, deploy, publish, provider-activation, post-deploy-confirmation]` (7 values). `post-deploy-confirmation` is absent from the mission enum only.
**Impact:** A story or execution-profile may defer `post-deploy-confirmation` (ZOB-ENH-023), and `03-STORY_TO_PR_CLOSE_FACTORY.md` line 185 states the mission "does not claim the stories … deployed or post-deploy confirmed." But a mission cannot express forbidding `post-deploy-confirmation` in `forbiddenActions` because the value is absent from the enum. This is a closed enum consistency gap, not a security hole (the action still cannot be claimed as complete — it just cannot be explicitly listed as forbidden at the mission level).
**Severity:** LOW (design consistency; no security impact; no body-safety impact).
**Recommended action:** Add `post-deploy-confirmation` to `mission.completion.forbiddenActions.items.enum` to restore parity with the deferredActions enums.

### F-2 — `$id` tail vs `schema` const divergence on 3 schemas (INFO, intentional)

**Where:** `gate` (`$id …gate:v1` vs const `zob.story-gate.v1`), `task` (`$id …task:v1` vs const `zob.story-task.v1`), `checkpoint` (`$id …checkpoint:v1` vs const `zob.mission-checkpoint.v1`).
**Assessment:** Intentional — the `schema` const is the domain contract name (story-gate, story-task, mission-checkpoint), the `$id` is the schema resource name. All examples use the const, not the `$id` tail, and all match. No example mismatch. Documented here for audit completeness; **not a defect.**
**Severity:** INFO.

### F-3 — Scope manifest byte counts stale for 3 lane files (LOW)

**Where:** `docs/zob/reviews/SCOPE_MANIFEST.json`.
**Evidence:**
- `examples/mission.example.json`: manifest=1219 bytes, actual=1268 bytes (+49).
- `schemas/mission.schema.json`: manifest=3073 bytes, actual=3122 bytes (+49).
- `schemas/model-attempt.schema.json`: manifest=3371 bytes, actual=3431 bytes (+60).
**Impact:** The manifest was generated before these 3 files were last edited (inline content grew without adding newline-delimited lines, so line counts still match under the split convention). The manifest's `fileCount`/`lineCount`/`byteCount` aggregate headers (49/3937/203839) are therefore also slightly stale for the byte total. This is a metadata-freshness issue, not a content defect — the 3 files themselves are valid JSON, meta-valid, and example-valid.
**Severity:** LOW (manifest metadata drift; no content or schema impact).
**Recommended action:** Regenerate `SCOPE_MANIFEST.json` byte counts (and aggregate `byteCount`) from current file contents, or document that byte counts are advisory.

### No other findings

- No high or critical findings.
- No example fails validation against its sibling schema.
- No schema fails meta-schema validation.
- No hash-length defects.
- No `bodyStored` defects (the 4 design-manifest schemas without `bodyStored` are correctly excluded by the README rule scope).
- No forbidden-field leak (mission-event payload guarded; all other objects `additionalProperties: false`).
- No security-critical const bypass (`manualDispatchAuthorized`, `draftRequired`, `mergeMode`, audit count=3 all enforced).
- No real secrets, tokens, URLs, or transcripts in any example.

## 7. Severity summary

| Severity | Count | IDs |
|---|--:|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 2 | F-1, F-3 |
| Info | 1 | F-2 |

## 8. Verdict

**PASS (with 2 low-severity, 1 info findings).**

The two prior medium issues that were repaired are **confirmed fixed and could not be disproven**:

1. **Security-critical/critical risk divergence** — eliminated. `high` and `critical` now require the identical, stronger lane set `{general-control, security-domain, evidence-qa}` with `control=true` and `status=complete` on each. The weaker medium lane set (`evidence-domain`) is rejected for high/critical risks (9/9 disprove tests passed).

2. **Under-enforced required lane coverage** — eliminated. Coverage is now enforced on both `requiredLaneTypes` (contains) and `lanes` (contains + control + status) at every risk class (low/medium/high/critical). All 9 negative lane-coverage tests rejected; all 4 positive controls accepted.

The new `execution-profile` schema/example is valid, internally consistent, and cross-consistent with `story-execution`, `ack-receipt`, and `gate`/`task` risk enums. All 28 lane files are read, well-formed, meta-valid, and example-valid. The 2 low findings (F-1 enum parity, F-3 manifest byte staleness) are non-blocking design/metadata consistency issues with no security or body-safety impact.

No high or critical defects remain in this lane.

FINAL: DOC_AUDIT_LANE_COMPLETE
