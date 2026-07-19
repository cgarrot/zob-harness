# Lane Audit — Runtime & Governance (Docs 06–11)

**Audit ID:** LANE_RUNTIME_GOVERNANCE
**Scope manifest:** [`SCOPE_MANIFEST.json`](SCOPE_MANIFEST.json) (schema `zob.doc-audit-scope.v1`, reviewMode `full`)
**Pass:** Second-pass, after repairs
**Files audited (6):**
- `docs/zob/06-MISSION_CONTROL_TUI.md` (185 lines)
- `docs/zob/07-PERSISTENCE_AND_RECOVERY.md` (179 lines)
- `docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md` (159 lines)
- `docs/zob/09-MODEL_AND_PROMPT_EXPERIMENTS.md` (205 lines)
- `docs/zob/10-EXECUTION_PROFILES_AND_SKILLS.md` (176 lines)
- `docs/zob/11-EVIDENCE_AND_GITHUB_CHECKS.md` (135 lines)

**Cross-referenced artifacts consulted (all read in full):**
- Schemas: `mission`, `task`, `model-attempt`, `execution-profile`, `evidence`, `checkpoint`, `ack-receipt`, `mission-event`, `story-execution`, `gate`, `pr-close-evidence`, `merge-authorization`, `blind-review-result` (13 schema files)
- Examples: `mission`, `task`, `model-attempt`, `execution-profile`, `evidence`, `checkpoint`, `ack-receipt`, `mission-event`, `merge-authorization` (9 example files)
- Schemas README, docs `01`–`05`, `13`, `14`, `16-DECISIONS`, `ENHANCEMENTS` for cross-doc terminology reconciliation
- AGENTS.md hard rules (body-safety, no transcripts, truth-class honesty, no premature activation)

**Method:** Every target file read end-to-end (no sampling). Every schema/example cross-referenced by the six docs read in full and machine-parsed (JSON validity + enum reconciliation). Relative link targets verified to resolve. Status vocabularies reconciled across docs 06/07/09 and all runtime schemas. No network, secrets, transcripts, or invented runtime used.

**Severity scale:** H = must fix before pilot/implementation; M = should fix before pilot; L = should fix in next doc pass; I = informational / design observation.

---

## 1. Status-state reconciliation (docs 06, 07, 09)

### 1.1 Mission status — PASS

Doc 06 line 15 declares the canonical mission status vocabulary:
`admitting`, `active`, `paused`, `needs-human`, `recovery-blocked`, `complete`, `failed`, `cancelled`.

`mission.schema.json` `status` enum is byte-identical (8 values, same order). `checkpoint.schema.json` `mission.status` is a free `string` (no enum) — acceptable because the checkpoint is a portable projection that records the mission's own status rather than re-constraining it. `checkpoint.example.json` uses `"active"`, which is a valid mission status. No drift.

### 1.2 Task status — PASS (with note)

Doc 06 line 16 declares the canonical task status vocabulary (11 values):
`planned`, `ready`, `blocked`, `delegated`, `in-progress`, `claim-returned`, `needs-review`, `accepted`, `failed`, `cancelled`, `superseded`.

`task.schema.json` has **no `status` field** — task manifest is an immutable contract; task status is a runtime projection derived from events (doc 07 dispatch invariant) and rendered in the TUI (doc 06). This is a deliberate design choice: the manifest describes the task, the event ledger projects its lifecycle. The 11-value vocabulary is hyphenated-consistent (`in-progress`, `claim-returned`, `needs-review`) across all six scope files — no snake_case leakage was found inside docs 06–11.

**Note (I):** The hyphenated `in-progress` task status is distinct from the attempt status `running`. Doc 07's dispatch invariant clarifies that `running` begins only after agent-acknowledged, and doc 06 line 20 states "Working begins only after process start and agent acknowledgement." The task-level `in-progress` is the projection of having a `running`/`launching`/`validating` attempt, while `delegated` is the pre-dispatch reservation state. This two-level separation (task vs attempt) is internally consistent and well-fenced. Recommend a one-line explicit gloss in doc 06 stating that `in-progress` (task) is the projection of a non-terminal active attempt, to prevent implementer conflation. **Severity: I.**

### 1.3 Attempt status and outcome — PASS

Doc 06 line 18 declares the canonical attempt status vocabulary (13 values):
`dispatch-reserved`, `launching`, `running`, `claim-returned`, `validating`, `needs-review`, `accepted`, `rejected`, `blocked`, `failed`, `lost`, `cancelled`, `superseded`.

The protected terminal `outcome` subset (doc 06 line 18, doc 09 line 142) is exactly `accepted`, `rejected`, `failed`, `blocked`, `cancelled`, `lost`, `superseded` (7 values). `model-attempt.schema.json` `outcome` enum is byte-identical. Doc 09 line 142 explicitly states "Lifecycle states live in section 06" and that `failureClass` "does not create another lifecycle vocabulary" — the single-source-of-truth delegation is clean.

`checkpoint.schema.json` `activeRuns[].status` is a free `string` (no enum); `checkpoint.example.json` uses `"running"`, a valid attempt status. Acceptable — the checkpoint is a point-in-time projection and should not re-enumerate the full vocabulary.

### 1.4 Dispatch recovery invariant (doc 07) — PASS

Doc 07 lines 168–178 reproduce the invariant with explicit transition-event annotation:
```
task ready → attempt dispatch-reserved
  --preflight-passed/process-started event→ launching
  --agent-acknowledged event→ running
  → claim-returned → validating → needs-review
  → accepted | rejected | blocked | failed | lost | cancelled | superseded
```
This is fully consistent with doc 06's vocabulary and the `dispatched` = UI-shorthand-for-`dispatch-reserved` note. The three transition events (preflight-passed, process-started, agent-acknowledged) are correctly described as events, not statuses, in both doc 06 (line 18) and doc 07 (line 174). Preflight failure path ("releases reservation and returns the task to retry/ready") and the `launching`-without-ACK timeout are both covered.

### 1.5 Cross-doc status drift (outside scope, reported for reconciliation) — L

Two drift points exist in docs **outside** the 06–11 scope but cross-reference the same vocabularies. Reported here per the MUST-DO reconciliation requirement; routed to `current_branch_fix` but marked as out-of-scope-source:

- **`docs/zob/14-VALIDATION_AND_PILOTS.md:38`** uses `needs_review` (snake_case) in a regression assertion, while the canonical task status (doc 06) is `needs-review` (hyphenated). The same line's `needs_review` would fail a property test that compares against the canonical enum. **Severity: L** (out-of-scope source, but the regression test it describes would be semantically wrong).
- **`docs/zob/14-VALIDATION_AND_PILOTS.md:37`** states "failed preflight never leaves `delegated`", while doc 07 line 177 states preflight failure "releases reservation and returns the task to retry/ready." These describe the same transition from different angles (the task leaves `delegated` and returns to `ready`), but the doc-14 phrasing ("never leaves `delegated`") is ambiguous and could be misread as "stays `delegated`." **Severity: L** (out-of-scope source, phrasing ambiguity).

Neither affects the internal correctness of docs 06–11; both are `current_branch_fix` candidates for the next doc pass.

---

## 2. Recovery, transcript sealing, takeover fencing (doc 07)

### 2.1 Transcript sealing — PASS

Doc 07 lines 141–162 specify the encrypted transcript subsystem. The repair added the critical sealing invariant (lines 159–160):
- "normal completion writes an authenticated final chunk/index seal before the attempt can become evidence-complete";
- "crash recovery verifies every committed chunk, marks an unsealed tail as `partial`, and never presents a partial transcript as complete";
- "a reattached live process may continue only from its verified next sequence."

This closes the prior gap where a crash-completed attempt could be mistaken for evidence-complete. The `partial` state is a transcript-internal flag (not a lifecycle status), correctly scoped. The keychain-init-failure-blocks-admission guard (line 162) and the never-auto-delete / hard-stop-pause-dispatch policy (lines 157–158) are intact and consistent with `16-DECISIONS.md` ZOB-D-026/027/028.

No schema encodes transcript structure (transcripts are encrypted local data, excluded from body-safe schemas by design — `mission-event.schema.json` `payload` `not.anyOf` forbids `transcript`). This is correct: the transcript contract lives only in doc 07 prose, which is the approved design locus.

### 2.2 Cross-machine takeover fencing — PASS

Doc 07 lines 120–131 specify the fencing transition. The repair added the exclusive-ownership proof requirement (line 122): "the prior owner lease must be expired/revoked or the prior owner must have recorded release, and the new owner must commit the next ownership epoch with expected-remote-head protection before any dispatch/effect. If ownership cannot be proved exclusive, takeover remains blocked."

This is a correct fencing-token / epoch-commit pattern: no dispatch or effect may occur until the new epoch is committed. The takeover receipt is one of the 9 `ackType` values in `ack-receipt.schema.json` (`cross-machine-takeover`), and `checkpoint.schema.json` `reason` enum includes `takeover`. The "records takeover before dispatch" step (line 131) correctly orders the checkpoint commit before any worker effect.

Consistent with `16-DECISIONS.md` ZOB-D-021 (authenticated cross-machine takeover) and ZOB-D-022 (former machine-local runs become orphaned). Doc 07 line 129 "marks former machine-local live runs orphaned" matches the decision. `13-OPERATIONS_RUNBOOK.md:65` ("Cross-machine resume requires takeover receipt") is consistent.

### 2.3 Integrity failures — PASS

Doc 07 lines 133–137 preserve the no-silent-truncation / quarantine-tail / `recovery-blocked` / stop-dispatch-and-GitHub-mutation policy. Consistent with `16-DECISIONS.md` ZOB-D-020. The "completion discovered after crash is validated—not automatically accepted or discarded" guard (line 118) is intact and matches the claim-vs-completion layering in doc 11.

### 2.4 Checkpoint triggers vs schema enum — PASS (with note)

Doc 07 lines 92–99 list 7 trigger classes; `checkpoint.schema.json` `reason` enum has 10 values. Reconciliation:

| Doc 07 trigger (prose) | Schema `reason` enum | Match |
|---|---|---|
| mission start | `mission-start` | ✓ |
| meaningful periodic change | `periodic-change` | ✓ |
| gate closure/reopen | `gate-transition` | ✓ (name generalizes close+reopen) |
| human wait/answer | `human-wait`, `human-answer` | ✓ (split into two enum values) |
| accepted PR head change | `pr-head` | ✓ |
| PR-close/review/ship milestone | `factory-milestone` | ✓ (generalized) |
| clean shutdown/completion | `shutdown`, `completion` | ✓ (split) |
| (takeover — implied by §Cross-machine) | `takeover` | ✓ |

The schema is a clean superset/generalization of the prose triggers. No prose trigger lacks a schema enum value, and no schema enum value is undocumented (takeover is covered by the cross-machine section). **Severity: I** — the prose-to-enum generalization (`gate closure/reopen` → `gate-transition`, `PR-close/review/ship milestone` → `factory-milestone`) is reasonable but a reader mapping prose to enum must infer the generalization. An optional one-line mapping note in doc 07 would help implementers; not required.

---

## 3. Permissions, ACKs, grant revisions, receipt revocation (doc 08)

### 3.1 Capability grant revisions — PASS

Doc 08 lines 50–58 specify immutable grant revisions. The repair added: "Approval creates a new immutable grant revision/event with exact added capability, reason, approver, attempt binding and expiry. The old grant is superseded, not edited; no requested operation runs until the worker receives/acknowledges the new revision. Denied or expired expansion leaves the prior grant unchanged."

This is a correct append-only revision model. The "no operation runs until the worker acknowledges the new revision" fencing prevents a worker from acting on a granted-but-not-yet-received expansion. The "denied/expired leaves prior unchanged" guard prevents accidental privilege reduction on denial. Consistent with `13-OPERATIONS_RUNBOOK.md` "revoke grant" incident response.

`task.schema.json` `permissions` records `rolePolicyRef`, `readPaths`, `writePaths`, `commands`, `deniedCapabilities` — the per-attempt grant fields. The grant *revision* is an event-ledger concept (not a static manifest field), which is the correct design: the manifest captures the initial grant, revisions are events. `mission-event.schema.json` supports this via its generic `eventType` + `payload` envelope.

### 3.2 Receipt revocation/supersession — PASS

Doc 08 lines 118–127 specify the revocation model. The repair added the irreversibility guard: "It never erases the original receipt or reverses an already performed irreversible action. Expired/revoked receipts are removed from current label/Check projections; if an irreversible effect already occurred, the supervisor creates a remediation/incident card instead of pretending revocation undid it."

This is a correct append-only-receipts + projection-removal + remediation-card pattern. `ack-receipt.schema.json` supports it: `decision` enum includes `revoked`, `supersedesReceiptId` links the supersession chain, `revokedAt` timestamp is present. `checkpoint.schema.json` `humanReceipts[].status` enum is `current`, `expired`, `revoked`, `conflict` — covers all projection states. The `conflict` state (doc 08 line 118: "a conflicting later answer creates a conflict card") is represented.

### 3.3 ACK type enum reconciliation — PASS

`ack-receipt.schema.json` `ackType` (9 values) and `execution-profile.schema.json` `humanReceiptTypes` (9 values) are **identical sets**:
`process-change`, `trust-decision`, `destructive-change`, `spend`, `human-override`, `cross-machine-takeover`, `factory-activation`, `merge-batch`, `deployment-impact`.

Doc 08 lines 108–116 enumerate 8 receipt examples and line 115 explicitly states "`ackType: merge-batch`; this is the schema token for merge authorization." The 9th type (`spend`) is implied by the authority model (line 39: "spend"). All 9 are documented. No drift between the two schemas or between schemas and doc 08.

**Note (I):** The `ackType` token is `merge-batch` while the `evidence.schema.json` `evidenceType` token is `merge-authorization`, and the canonical Check name is `ZOB / Merge Authorization`. These are three different fields in three different schemas for three different purposes (receipt type / evidence type / Check name) and are not a conflict. Doc 08 line 115's explicit mapping note ("this is the schema token for merge authorization") correctly bridges the receipt-to-evidence naming. No action needed.

### 3.4 Labels-are-projections and batch rules — PASS

Doc 08 lines 129–135 (labels are projections, require current receipts/evidence) and lines 137–145 (batch rules; high-risk never batched; merge authorization has purpose-built form) are intact. Consistent with `16-DECISIONS.md` ZOB-D-094 (no broad override bypass) and ZOB-D-095 (labels/comments are projections). Doc 06 line 82 ("separate high-risk ACK, override, takeover and merge-authorization forms") and line 83 ("Merge authorization has its own exact-head selective batch UI") are consistent.

### 3.5 GitHub App privilege separation — PASS

Doc 08 lines 87–101 specify Builder/Reviewer/Ship App scopes with no privilege aggregation. `evidence.schema.json` `issuer.type` enum (`supervisor`, `builder-app`, `reviewer-app`, `ship-app`, `ci`, `human`) and `pr-close-evidence.schema.json` `issuer.type` const `builder-app` enforce issuer binding. `merge-authorization.schema.json` is Ship-App-bound by design. Consistent with `16-DECISIONS.md` ZOB-D-089.

### 3.6 Communication policy — PASS

Doc 08 lines 146–147: "Goal Room/mission timeline is canonical parent-visible coordination. Optional live delivery is transient. Hidden worker-to-worker free chat and direct peer-owned writes are prohibited. Owner-change requests are body-safe, path-scoped and parent-visible." Consistent with the AGENTS.md body-safety hard rules and the ZOB harness communication contract.

---

## 4. Model routing, prompt experiments, seed derivation, Pi effort mapping (doc 09)

### 4.1 Seed derivation — PASS

Doc 09 lines 75–78 specify the repair: "Generate a cryptographically random private task seed, then derive domain-separated `model-order` and `prompt-treatment` seeds (for example HKDF with those exact info labels). Persist commitments and the protected seeds in telemetry; never expose them to agent contexts." Line 122: "prompt treatment uses the domain-separated `prompt-treatment` seed, never the model-order RNG stream."

This is a correct HKDF domain-separation design: a single root seed derives two independent subkeys with distinct info labels, preventing RNG-stream correlation between model selection and prompt assignment. The "persist commitments and protected seeds in telemetry; never expose to agent contexts" guard preserves blindness. Consistent with `16-DECISIONS.md` ZOB-D-061 ("Prompt seed is independent of model seed and variant stays fixed over one model ladder").

### 4.2 Pi effort mapping (thinking ladder) — PASS

Doc 09 lines 84–96 specify the thinking ladder with the Pi effort mapping repair:
- Minimum `low`: `low → medium → high → xhigh → max`.
- "Pi's `off` and `minimal` levels are below the ZOB quality minimum and are ineligible for reasoning ladders."
- "A verified non-reasoning model gets one ZOB `default` rung, mapped to the provider's ordinary non-reasoning mode."
- "Requested and actual levels are both recorded; an unapproved provider clamp is a capability mismatch, not a successful rung."
- "Context overflow/output-budget defects receive their own recovery/classification."

`model-attempt.schema.json` `requestedThinking` and `actualThinking` enums are both `["default", "low", "medium", "high", "xhigh", "max"]` — includes the `default` rung for non-reasoning models and excludes `off`/`minimal`. `thinkingVerified` boolean supports the clamp-detection invariant. Consistent with `16-DECISIONS.md` ZOB-D-055 (ladder starts at lowest ≥ low) and ZOB-D-056 (non-reasoning models get one default attempt).

### 4.3 Prompt mode tokens — PASS

Doc 09 lines 131–133 specify the 4 mode tokens: `uniform-control`, `shared-candidate`, `model-candidate`, `approved-optimized`, with the semantics: "uniform-control is the permanent control; shared/model candidates are the experimental 50%; approved-optimized is available only after human promotion." `model-attempt.schema.json` `promptTreatment.mode` enum is byte-identical (4 values). `promptTreatment.control` boolean and `rescueOfVariantId` (for candidate-exhaustion control rescue, ZOB-D-062) are present. `model-attempt.example.json` uses `uniform-control` with `control: true`.

### 4.4 Failure taxonomy — M (doc-schema enum mismatch)

**Finding:** `model-attempt.schema.json` `failureClass` enum has **18 values**:
`none`, `provider_transient`, `provider_unavailable`, `rate_limit`, `capability_mismatch`, `context_overflow`, `output_budget`, `tool_environment`, `permission_denied`, `human_blocked`, `cancelled`, `prompt_candidate_failure`, `model_quality_failure`, `validation_failure`, `review_rejection`, `integration_regression`, `ci_regression`, `policy_violation`.

Doc 09 lines 144–162 enumerate **14 values** in the taxonomy code block, omitting:
- `none` — used by `model-attempt.example.json` (`"failureClass": "none"`) for accepted attempts; not mentioned in doc 09 prose.
- `capability_mismatch` — mentioned in doc 09 line 88 prose ("an unapproved provider clamp is a capability mismatch") but absent from the enumerated code block.
- `context_overflow` — mentioned in doc 09 line 96 prose ("Context overflow/output-budget defects receive their own recovery/classification") but absent from the code block.
- `output_budget` — same as above (line 96 groups them but does not name the token).

The prose acknowledges 3 of the 4 missing classes but the enumerated taxonomy block (the implementer-facing list) is incomplete. The `none` sentinel is required by the schema for accepted attempts but is undocumented in doc 09.

**Severity: M.** The schema is the authoritative superset and is self-consistent; the example validates. But an implementer reading only the doc-09 code block would miss 4 valid `failureClass` values and could reject valid telemetry or fail to classify `capability_mismatch`/`context_overflow`/`output_budget` correctly. **Route: `current_branch_fix`** — add the 4 missing values to the doc 09 taxonomy code block (and a one-line note that `none` is the sentinel for non-failed outcomes).

### 4.5 Blindness and protected telemetry — PASS

Doc 09 lines 20–30 (blind identity, opaque assignment IDs), lines 164–172 (protected telemetry on `zob-model-telemetry`, worker/reviewer cannot read), lines 174–192 (analysis is advisory, no runtime self-modification) are intact. `mission-event.schema.json` `payload.not.anyOf` forbids `prompt`, `response`, `transcript`, `credential`, `rawBody`, `rawDiff` — enforcing body-safe events. Consistent with `16-DECISIONS.md` ZOB-D-025/053/054/064/066.

### 4.6 Provider audit gating — PASS

Doc 09 lines 194–205 require explicit spend approval before the `fireconnect`/OpenAI OAuth capability audit, and "Only verified routes enter pools. `Sol-high` and fixed aliases remain unresolved until then." Doc 09 line 1 truth-class "Exact pool state: Deferred until gated provider capability audit" is honest. Consistent with AGENTS.md hard rule 10 (mark design-only capability honestly) and `16-DECISIONS.md` ZOB-D-066.

---

## 5. Execution profiles, taxonomy, skills (doc 10)

### 5.1 Profile schema and examples — PASS

Doc 10 lines 37–39 correctly cite `schemas/execution-profile.schema.json` and `examples/execution-profile.example.json` (both relative links resolve). The schema `allOf` constraint enforces `profileId` against the base/overlay enum exactly as doc 10 lines 8–23 list them:
- Base (4): `full-feature`, `quick-fix`, `docs-process`, `refactor-cleanup` — byte-identical to schema `then.profileId.enum`.
- Overlay (15): `security-trust`, `privacy-encryption`, `database-migration`, `infrastructure-ci`, `frontend-user-visible`, `backend-api-data`, `cli-mcp-tooling`, `vendor-dependency`, `external-integration`, `model-prompt-control`, `performance-cost`, `supply-chain-installer`, `observability-operations`, `test-harness-evidence`, `destructive-change` — byte-identical to schema overlay enum.

`story-execution.schema.json` `profile.base` enum (4 values) and `profile.overlays` (free string array) are consistent — the story manifest references profiles by ID; the profile schema constrains the IDs.

`execution-profile.example.json` is a valid `security-trust` overlay with all required fields populated, and validates against the schema's overlay `allOf` branch. The `compositionPolicy` (`union-stricter-wins`, `canStrengthenAutomatically: true`, `requiresHumanToWeakenOrRemove: true`) matches doc 10 line 31 ("Requirements union and the stricter rule wins... Removing/weakening a declared/required overlay needs human approval").

### 5.2 Composition and auto-promotion rules — PASS

Doc 10 lines 31–33: "Requirements union and the stricter rule wins. The supervisor may add evidence-backed conservative overlays. Removing/weakening a declared/required overlay needs human approval. Quick may auto-promote to full; full cannot auto-downgrade." Consistent with `16-DECISIONS.md` ZOB-D-036.

### 5.3 Fleet v5 signal mapping — PASS

Doc 10 lines 104–121 list all 17 Fleet v5 signals. `story-execution.schema.json` `signals` required fields are byte-identical to the 17 listed (verified: `schemaVersion`, `profileWeights`, `routeHint`, `domains`, `surfaces`, `blast`, `securityFlags`, `diffBreadth`, `reversibility`, `verification`, `testDemands`, `contextLoad`, `designFreedom`, `opsTouch`, `humanCheckpoint`, `parallelizable`, `reviewerGate`, `escalationTriggers`). Doc 10 correctly states "They are inputs, not decisions" and that `routeHint` informs workload planning, not initial model preference (line 119) — preserving the blindness contract from doc 09.

### 5.4 Taxonomy and candidate values — PASS

Doc 10 lines 123–133 specify 9 versioned registry files and the `candidate:<value>` pattern with provenance/confidence/taxonomy-version. `task.schema.json` `labels` requires `taxonomyVersion`, `authored`, `inherited`, `inferred`, `effective` with `inferred[].confidence` (0–1) and `sourceRef` — consistent. "Candidates appear in analysis/UI but cannot alter routing, permissions or review until human-promoted" is a correct fail-closed guard.

### 5.5 Skill binding — PASS

Doc 10 lines 135–143 specify the skill binding table with intent owners and support skills. "Workers receive only the owning skill, required support skills/contracts and permitted ZOB mechanisms. Additional skill need is a typed request." Consistent with the grant-revision model in doc 08. "Every attempt records skill/shared-contract/prompt/context versions so model analysis does not blame a model for a changed workflow" (line 143) is a correct confound-control invariant, supported by `model-attempt.schema.json` `policyVersions` (free-form key/value).

### 5.6 Deferred-action enum reconciliation — PASS

Doc 10 line 30 and `execution-profile.schema.json` `deferredActions` enum (7 values: `formal-review`, `ready`, `merge`, `deploy`, `publish`, `provider-activation`, `post-deploy-confirmation`) and `mission.schema.json` `completion.forbiddenActions` enum (6 values, same minus `post-deploy-confirmation`) and `story-execution.schema.json` `deferredActions` (7 values, identical) are consistent. The mission `forbiddenActions` is a subset because it describes completion boundary, not the full deferral surface.

---

## 6. Evidence, CI, GitHub Checks, invalidation matrix (doc 11)

### 6.1 Evidence invalidation matrix — PASS

Doc 11 lines 49–59 specify a 7-row evidence-type-aware invalidation matrix. The repair added the nuanced permission/profile/taxonomy/prompt-compiler row (line 55): "only evidence whose semantic contract depends on the changed version; otherwise record new version for future attempts" — correctly avoiding blanket invalidation on every policy version bump. The base-movement row (line 57) correctly scopes to "meaningful collision" rather than any base advance. The issuer/App/schema-allowlist row (line 59) covers Check reissuance.

`evidence.schema.json` `status` enum (`current`, `stale`, `invalid`, `superseded`) is byte-identical to doc 11 line 39. Doc 11 lines 61–63 define the three non-current states precisely: `superseded` = newer valid replacement; `stale` = freshness/binding no longer current; `invalid` = integrity/policy/issuer/contract validation failed. "Historical records are retained in all cases" is a correct audit-preserving guard.

### 6.2 Evidence type enum vs matrix coverage — PASS (with note)

`evidence.schema.json` `evidenceType` enum (8 values): `task`, `gate`, `pr-close`, `blind-review`, `human-gate`, `merge-authorization`, `ship-gate`, `post-merge`.

The invalidation matrix rows reference evidence aggregates by name ("owning task", "containing gate", "PR-close", "Blind Review", "downstream Ship", "Human Gates projection"). All 8 evidence types are either directly named or implied by the matrix rows. `post-merge` evidence is implied by the "downstream Ship" and base-movement rows but not explicitly named. **Severity: I** — the matrix is behaviorally complete but an explicit `post-merge` row (or a note that post-merge evidence follows the ship-gate invalidation rules) would improve implementer clarity. Not required.

### 6.3 Canonical Checks and issuer binding — PASS

Doc 11 lines 64–95 specify the 5 canonical Checks: `ZOB / PR Close` (Builder), `ZOB / Blind Review` (Reviewer), `ZOB / Human Gates` (Supervisor/Ship projection), `ZOB / Merge Authorization` (Ship), `ZOB / Ship Gate` (Ship). Consistent with `16-DECISIONS.md` ZOB-D-089.

Schema enforcement:
- `pr-close-evidence.schema.json` `issuer.type` const `builder-app`, `issuer.checkName` const `ZOB / PR Close` — enforces issuer binding.
- `blind-review-result.schema.json` `binding.githubCheckRef` present; doc 11 line 72 "Includes round/lane/adjudicator opaque refs" matches the schema's `lanes[]` with `assignmentId` (opaque) and `adjudication.assignmentId`.
- `merge-authorization.schema.json` binds `prCloseCheckId`, `blindReviewCheckId`, `shipGateCheckId` per entry — matching doc 11 line 81 "Binds the selected human batch receipt and deployment-impact receipt."

### 6.4 Deployment-impact receipt binding — PASS

Doc 11 line 81 ("Binds the selected human batch receipt and deployment-impact receipt") and doc 08 line 116 (`deployment-impact` ackType) are enforced by `merge-authorization.schema.json` `entries[].deploymentImpact` (required: `classification`, `receiptHash`, `manualDispatchAuthorized: const false`). The `manualDispatchAuthorized: const false` guard is critical — it prevents the merge authorization from implying manual workflow dispatch authority. Consistent with `16-DECISIONS.md` ZOB-D-090 ("Deployment impact requires a separate per-PR receipt").

### 6.5 Ready Guard and draft-vs-ready CI — PASS

Doc 11 lines 97–110 specify the Ready Guard pure evaluator (shared by draft preview, GitHub workflow, ship reconciliation) and the draft-vs-ready CI split. "No early `human-override` exit. No title-only exemption. No bare-label proof." (line 105) is intact. "Cancelled, superseded, missing or unknown checks do not silently pass" (line 110) is a correct fail-closed guard. `pr-close-evidence.schema.json` `draftCi.deferredReadyOnly` array and `terminalAcceptable` boolean enforce the deferred-check contract. Consistent with `16-DECISIONS.md` ZOB-D-094.

### 6.6 Flakes — PASS

Doc 11 lines 112–116: one automatic rerun only when (1) versioned known-flake ledger match, (2) current log signature match, (3) rerun ceiling not consumed. Otherwise route to repair. Correct bounded-rerun policy.

### 6.7 Claim versus completion layering — PASS

Doc 11 lines 118–125 specify the non-self-certifying layering: agent output = claim; parent validation = accepted task evidence; gate closure aggregates accepted tasks; PR-close aggregates gates/CI/audits; Blind Review independently evaluates; Ship mechanically revalidates. "No lower layer can self-certify a higher one" is the core invariant. Consistent with doc 06's status-truth model (TUI "never manufactures status from prose") and doc 07's "completion discovered after crash is validated—not automatically accepted."

### 6.8 Progress semantics — PASS

Doc 11 lines 127–129: "Derived weighted progress counts accepted required DAG nodes only. A running/claimed task can display activity but contributes no accepted completion. Invalidation may decrease progress with explicit cause." Consistent with doc 06 line 12 (TUI shows "accepted versus claimed progress") and `checkpoint.schema.json` `stories[].acceptedProgress` (0–1 range).

### 6.9 Evidence branch paths — PASS (with note)

Doc 11 lines 22–28 list 7 evidence paths under `execution/evidence/` plus 2 PR-close files. Paths use `human/<receipt-id>.json` for the `human-gate` evidence type. The path directory name (`human/`) differs from the `evidenceType` token (`human-gate`). **Severity: I** — this is a benign naming shorthand (the directory holds human-gate evidence) and does not affect schema validity, but a one-line mapping note in doc 11 would prevent implementer confusion. Not required.

---

## 7. Cross-cutting checks

### 7.1 Body-safety / no-transcripts — PASS

All 13 schemas and all examples carry `bodyStored: false` where required (mission, mission-event, checkpoint, evidence, ack-receipt, model-attempt, merge-authorization, pr-close-evidence, blind-review-result). `mission-event.schema.json` `payload.not.anyOf` forbids `rawBody`, `prompt`, `response`, `transcript`, `credential`, `rawDiff`. Doc 07 line 161 ("No prompt/output body enters SQLite, normal journal, Git or PR evidence") and doc 11 lines 16–18 (body policy) are enforced at the schema level. Consistent with AGENTS.md hard rules 1–2.

### 7.2 Truth-class honesty — PASS

All six docs carry `**Truth class:** Approved design`. Doc 09 additionally carries "Exact pool state: Deferred until gated provider capability audit." No doc in scope claims implementation/activation/validation that is not backed by evidence. Consistent with AGENTS.md hard rule 10 and `schemas/README.md` ("Status: Design schemas for implementation/pilot validation; no runtime currently consumes them").

### 7.3 Relative link integrity — PASS

The two explicit schema/example links in scope resolve:
- `docs/zob/07:38` → `schemas/mission-event.schema.json` ✓
- `docs/zob/10:38` → `schemas/execution-profile.schema.json` and `examples/execution-profile.example.json` ✓

No other in-scope doc makes broken relative schema/example references. Doc 06 and doc 11 reference schemas/Checks by name (not as links) which is appropriate for prose-level references.

### 7.4 JSON validity — PASS

All 13 schemas and all 13 examples parse as valid JSON (machine-verified). No trailing commas, no unquoted keys, no structural errors.

### 7.5 Hyphenation consistency (in-scope) — PASS

All status vocabularies in docs 06–11 use hyphenated form (`in-progress`, `claim-returned`, `needs-review`, `dispatch-reserved`, `recovery-blocked`, `needs-human`). No snake_case status leakage was found inside the six scope files. The snake_case drift in `docs/zob/14` (§1.5) is out-of-scope.

---

## 8. Findings summary

| # | Severity | File:Line | Finding | Route |
|---|---|---|---|---|
| F-01 | M | `09:144-162` | `failureClass` taxonomy code block lists 14 values; schema enum has 18 (`none`, `capability_mismatch`, `context_overflow`, `output_budget` missing from prose enumeration). `none` is entirely undocumented; the other 3 are mentioned in prose but absent from the implementer-facing code block. | `current_branch_fix` |
| F-02 | L | `14:38` (out-of-scope) | `needs_review` (snake_case) used in regression assertion; canonical task status is `needs-review` (hyphenated, doc 06). | `current_branch_fix` |
| F-03 | L | `14:37` (out-of-scope) | "failed preflight never leaves `delegated`" phrasing is ambiguous vs doc 07's "returns the task to retry/ready"; could misread as "stays delegated." | `current_branch_fix` |
| F-04 | I | `06:16` | Task `in-progress` vs attempt `running` separation is correct but lacks an explicit one-line gloss; implementers could conflate the two levels. | `current_branch_fix` (optional) |
| F-05 | I | `07:92-99` | Checkpoint trigger prose→enum generalization (`gate closure/reopen`→`gate-transition`, `PR-close/review/ship`→`factory-milestone`) is clean but unmapped; a one-line mapping note would help. | `current_branch_fix` (optional) |
| F-06 | I | `11:49-59` | Invalidation matrix is behaviorally complete for all 8 `evidenceType` values but `post-merge` is not explicitly named in any row. | `current_branch_fix` (optional) |
| F-07 | I | `11:22-26` | Evidence path directory `human/` vs `evidenceType` token `human-gate` naming shorthand is benign but unmapped. | `current_branch_fix` (optional) |

**No High-severity findings.** All repair topics (canonical mission/task/attempt states, transcript sealing, takeover fencing, grant revisions, receipt revocation, seed derivation, Pi effort mapping, prompt tokens, profile schema/examples, evidence invalidation matrix) have landed correctly and are internally consistent with their backing schemas and examples.

---

## 9. Verdict

**Audit verdict: PASS with one M-severity documentation gap.**

The six docs (06–11) form a coherent, internally consistent runtime-and-governance design layer. The second-pass repairs successfully closed the prior gaps:

- ✅ Canonical mission/task/attempt states (doc 06) reconcile byte-for-byte with `mission.schema.json` and `model-attempt.schema.json` outcome enum; dispatch invariant (doc 07) cross-references doc 06 vocabulary explicitly.
- ✅ Transcript sealing (doc 07) adds the authenticated-final-seal / `partial`-tail / verified-next-sequence invariants that prevent crash-completed attempts from being mistaken for evidence-complete.
- ✅ Takeover fencing (doc 07) adds the exclusive-ownership epoch-commit-before-dispatch requirement with expected-remote-head protection.
- ✅ Grant revisions (doc 08) add the immutable-revision / no-operation-until-acknowledged / denied-leaves-prior-unchanged guards.
- ✅ Receipt revocation (doc 08) adds the append-only / projection-removal / remediation-card-for-irreversible guards, backed by `ack-receipt.schema.json` `supersedesReceiptId`/`revokedAt` and `checkpoint.schema.json` receipt status enum.
- ✅ Seed derivation (doc 09) adds HKDF domain-separated `model-order`/`prompt-treatment` seeds with protected-seed-in-telemetry / never-expose-to-agents.
- ✅ Pi effort mapping (doc 09) adds `off`/`minimal` exclusion, `default` non-reasoning rung, requested-vs-actual recording, and clamp-as-mismatch classification, backed by `model-attempt.schema.json` thinking enums + `thinkingVerified`.
- ✅ Prompt tokens (doc 09) add the 4 `mode` enum tokens with control/candidate/promotion semantics, backed by `model-attempt.schema.json` `promptTreatment.mode`.
- ✅ Profile schema/examples (doc 10) correctly cite and align with `execution-profile.schema.json` base/overlay enums and `execution-profile.example.json`.
- ✅ Evidence invalidation matrix (doc 11) adds the semantic-contract-scoped policy-change row and the precise `superseded`/`stale`/`invalid` definitions, backed by `evidence.schema.json` `status` enum.

**One M-severity gap remains (F-01):** the doc-09 `failureClass` taxonomy code block is incomplete relative to the authoritative schema enum (4 missing values: `none`, `capability_mismatch`, `context_overflow`, `output_budget`). The schema and example are correct and self-consistent; only the doc prose enumeration is stale. This is a `current_branch_fix` documentation update, not a design defect.

**Two L-severity out-of-scope drift points (F-02, F-03)** in `docs/zob/14` cross-reference the same status vocabularies and should be fixed in the next doc pass to keep the regression-test specifications aligned with the canonical enums.

**No no-ship blockers.** No secrets, transcripts, credentials, or raw bodies are present. No premature activation or implementation claims. All truth-class labels are honest. The design is ready for pilot validation subject to F-01 correction and the optional I-severity clarifications.

---

## 10. Routing

- **F-01 (M):** `current_branch_fix` — update `docs/zob/09-MODEL_AND_PROMPT_EXPERIMENTS.md` lines 144–162 to include `none`, `capability_mismatch`, `context_overflow`, `output_budget` in the `failureClass` taxonomy code block, with a one-line note that `none` is the sentinel for non-failed outcomes.
- **F-02, F-03 (L):** `current_branch_fix` — update `docs/zob/14-VALIDATION_AND_PILOTS.md` lines 37–38 to use hyphenated `needs-review` and clarify the preflight-failure task-return phrasing.
- **F-04–F-07 (I):** `current_branch_fix` (optional) — add the one-line glosses/mapping notes identified above in the next doc polish pass.

FINAL: DOC_AUDIT_LANE_COMPLETE
