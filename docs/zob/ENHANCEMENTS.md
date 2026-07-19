# Enhancement Register

**Truth class:** Deferred/proposed capability register with promoted-item provenance
**Rule:** An enhancement is not approved implementation scope unless promoted through an explicit decision and versioned plan.

Statuses:

- **Deferred** — useful, outside v1.
- **Specified-disabled** — design exists, implementation/activation separately gated.
- **Research** — evidence needed before design.
- **Proposed-needs-discussion** — newly requested; no policy decision yet.
- **Promoted-to-v1-design** — originated here, then ratified into the decision record/current specification; retained for provenance.

## Runtime, persistence and scale

### ZOB-ENH-001 — Live multi-machine agent execution

- **Status:** Deferred
- **Value:** More capacity and machine-failure tolerance.
- **Dependencies:** v1 portable manifests/checkpoints, distributed owner/lease protocol, secure transport, budget governor.
- **Acceptance:** No split-brain; deterministic sequence/claim ownership; crash/takeover/property tests; oracle PASS.
- **Promotion trigger:** One-machine multi-story pilots show sustained capacity/availability limits.

### ZOB-ENH-002 — Portable encrypted transcript export

- **Status:** Research
- **Value:** Cross-machine replay and takeover with full local evidence.
- **Dependencies:** recipient key trust, rewrap protocol, export receipt, retention/deletion policy.
- **Acceptance:** authenticated re-encryption, no plaintext, revocation/deletion audit, fixture interoperability.
- **Promotion trigger:** Real takeover requires prior-machine transcript evidence.

### ZOB-ENH-003 — GitHub webhook ingestion

- **Status:** Deferred
- **Value:** Lower latency/API usage.
- **Dependencies:** authenticated ingress, delivery journal, replay protection, polling reconciliation fallback.
- **Acceptance:** signature validation, duplicates/reorder/loss tests, no unverified status transition.
- **Promotion trigger:** Polling rate budget or latency becomes material.

### ZOB-ENH-004 — Distributed lease/lock service

- **Status:** Deferred
- **Value:** Cross-machine workspaces and scheduler ownership.
- **Dependencies:** ENH-001, fencing tokens, failure detector.
- **Acceptance:** stale owner cannot write/dispatch after lease loss.
- **Promotion trigger:** Multi-machine execution approved.

### ZOB-ENH-005 — Supervisor high availability

- **Status:** Deferred
- **Value:** Continuous control-plane operation across host failure.
- **Dependencies:** ENH-001/004, replicated journal or consensus.
- **Acceptance:** one active leader, no event/effect duplication, recovery RTO evidence.
- **Promotion trigger:** Mission business criticality exceeds one-host posture.

### ZOB-ENH-006 — Long-term transcript archival tiers

- **Status:** Research
- **Value:** Reduce local disk while preserving selected evidence.
- **Dependencies:** retention/legal/privacy decision, encrypted object storage, key lifecycle.
- **Acceptance:** user-selected only; encryption, retrieval, deletion and audit proof.
- **Promotion trigger:** Manual retention causes recurring disk pressure.

### ZOB-ENH-007 — Strong remote/network execution sandbox

- **Status:** Deferred
- **Value:** Run untrusted scanners/providers or remote workers safely.
- **Dependencies:** egress allowlists, secrets broker, filesystem isolation, artifact attestation.
- **Acceptance:** escape/egress/secret tests and independent security review.
- **Promotion trigger:** External worker/runtime adoption.

## Mission Control and operator experience

### ZOB-ENH-008 — Browser Mission Control

- **Status:** Deferred
- **Value:** Remote/multi-mission operations and richer visualization.
- **Dependencies:** authenticated transport, ENH-001 or secure local bridge, same typed control API.
- **Acceptance:** parity with TUI, no weaker receipts/permissions, accessibility/security tests.
- **Promotion trigger:** Local TUI proves semantics and remote access is needed.

### ZOB-ENH-009 — External notifications

- **Status:** Deferred
- **Value:** Needs-human/incident alerts outside the terminal.
- **Dependencies:** notification adapter, privacy/body-safe templates, dedupe/ACK correlation.
- **Acceptance:** no raw body/secrets, no alert loops, explicit user opt-in.
- **Promotion trigger:** Operators miss time-critical in-TUI alerts.

### ZOB-ENH-010 — Saved Mission Control queries/dashboards

- **Status:** Deferred
- **Value:** Repeatable fleet/quality/cost views.
- **Dependencies:** stable projections and filter schema.
- **Acceptance:** versioned, user-scoped, body-safe and reproducible.
- **Promotion trigger:** Recurring manual filter patterns.

### ZOB-ENH-011 — Predictive blocker/conflict alerts

- **Status:** Research
- **Value:** Catch likely stack/path/schema conflicts before work begins.
- **Dependencies:** enough validated mission history, no model reputation leakage.
- **Acceptance:** measured precision/recall and advisory-only output.
- **Promotion trigger:** Collision data reaches useful sample size.

## Context, models and prompts

### ZOB-ENH-012 — Semantic ProjectDNA/ColGREP mission context

- **Status:** Deferred
- **Value:** Better bounded source retrieval.
- **Dependencies:** citation/forbidden-source policy, freshness and token limits.
- **Acceptance:** cited line refs, no secret/session/vendor corpus, deterministic fallback.
- **Promotion trigger:** Grep-based context becomes a quality bottleneck.

### ZOB-ENH-013 — `fleet-bakeoff` optimized/both prompt modes

- **Status:** Deferred
- **Value:** Exercise existing declared CLI modes using vetted per-model prompt guidance.
- **Dependencies:** prompt catalog/version compiler, leakage review, balanced control.
- **Acceptance:** optimized and both modes execute; control remains comparable; tests/analysis updated.
- **Promotion trigger:** Story-factory prompt telemetry pipeline is stable.

### ZOB-ENH-014 — Learned model preference policy

- **Status:** Research
- **Value:** Shift from uniform baseline toward measured task-specific efficiency/quality.
- **Dependencies:** blinded representative samples, uncertainty thresholds, human policy approval.
- **Acceptance:** holdout improvement, no fairness/starvation regression, rollbackable advisory release.
- **Promotion trigger:** Adequate sample size by task/domain/role.

### ZOB-ENH-015 — Generated model-specific prompt compiler

- **Status:** Research
- **Value:** Convert measured prompt features into versioned candidate templates.
- **Dependencies:** ENH-013, prompt-builder provenance and review.
- **Acceptance:** reproducible compilation, no identity/treatment leakage, control comparison.
- **Promotion trigger:** Manual candidate maintenance becomes limiting.

### ZOB-ENH-016 — Additional provider/model routes

- **Status:** Deferred
- **Value:** Resilience, cost/quality diversity.
- **Dependencies:** provider adapter, capability/cost/privacy/blindness audit.
- **Acceptance:** same provider-gate suite as initial routes; exact family map.
- **Promotion trigger:** New route has credible role benefit or existing route risk.

### ZOB-ENH-017 — Continuous provider/model canaries

- **Status:** Deferred
- **Value:** Detect silent model/version/thinking/tool drift.
- **Dependencies:** bounded spend, non-sensitive fixtures, alert/quarantine policy.
- **Acceptance:** detects known simulated drifts; never auto-promotes.
- **Promotion trigger:** Initial provider audit shows route volatility.

### ZOB-ENH-018 — Reviewer/adjudicator calibration corpus

- **Status:** Research
- **Value:** Measure false positives, misses and severity accuracy.
- **Dependencies:** adjudicated defect corpus, contamination safeguards.
- **Acceptance:** blinded held-out benchmark and versioned rubric.
- **Promotion trigger:** Blind Review pilot has enough resolved findings.

### ZOB-ENH-019 — Budget-aware model market

- **Status:** Research
- **Value:** Optimize quality/latency/cost under mission budget.
- **Dependencies:** reliable usage/cost telemetry and ENH-014.
- **Acceptance:** hard eligibility/safety unchanged; human caps enforced; deterministic replay of choice.
- **Promotion trigger:** Uniform random baseline is statistically characterized.

## Factories and lifecycle

### ZOB-ENH-020 — Blind PR Review factory activation

- **Status:** Specified-disabled
- **Value:** Independent risk-scaled successor to R machines.
- **Dependencies:** Story-factory close Check, Reviewer App, fixtures/pilots, oracle and human activation.
- **Acceptance:** [`04-BLIND_REVIEW_FACTORY.md`](04-BLIND_REVIEW_FACTORY.md) and validation phases pass.
- **Promotion trigger:** Story factory is stable and formal review pilot is authorized.

### ZOB-ENH-021 — Staging Merge factory activation

- **Status:** Specified-disabled
- **Value:** Crash-safe S1 successor for automatic qualified ordinary PR integration without deployment authority.
- **Dependencies:** ENH-020, Staging Merge App, `develop-staging`/Guard/CI migration, oracle and activation.
- **Acceptance:** [`05-PR_SHIP_FACTORY.md`](05-PR_SHIP_FACTORY.md), validation phase 11 and denied-permission/non-deployment tests pass.
- **Promotion trigger:** Blind Review is stable and human authorizes the staging pilot.

### ZOB-ENH-037 — Final Assurance and Promotion factory activation

- **Status:** Specified-disabled
- **Value:** Whole-repository assurance and exact-history human-authorized promotion before automatic CD.
- **Dependencies:** ENH-021, promoted ENH-031/032 design, Reviewer and Promotion Apps, inventory schemas/adapters, validation phases 12–13, oracle and activation.
- **Acceptance:** section 17, three-assurance-round/two-repair-transition simulation, candidate lineage, merge-commit ancestry, staging alignment plus aligned-head CI, denied-permission and no-manual-dispatch tests pass.
- **Promotion trigger:** Staging Merge is stable and a human authorizes the assurance/promotion pilot.

### ZOB-ENH-022 — Exact-input Post-Promotion Reconciliation factory

- **Status:** Specified-disabled
- **Value:** Durable `/merged` successor, Promotion interlock completion and safe staging alignment.
- **Dependencies:** clean isolated worktree, code↔docs reconciler, bounded reconciliation PR rules, exact promotion merge event.
- **Acceptance:** no rediscovery ambiguity, non-recursive bundle handling, risk-based review, current-base proof, expected-head staging fast-forward, aligned-head integration CI and only then queue unfreeze.
- **Promotion trigger:** Before any Final Assurance/Promotion factory activation.

### ZOB-ENH-023 — Deployment Confirmation factory

- **Status:** Deferred
- **Value:** Verify automatic CD result after develop promotion without broadening Promotion authority.
- **Dependencies:** workflow-run correlation, environment health probes, deployment ownership policy.
- **Acceptance:** never dispatches deploy by default; exact merge→run→environment evidence; incident routing.
- **Promotion trigger:** Automatic CD needs systematic confirmation.

### ZOB-ENH-024 — Deployment rollback/recovery factory

- **Status:** Research
- **Value:** Governed response to failed/unsafe deployment.
- **Dependencies:** ENH-023, environment-specific rollback design and explicit irreversible gates.
- **Acceptance:** sandbox/test environment simulation; human authorization for live mutation.
- **Promotion trigger:** Deployment Confirmation evidence demonstrates recurring recoverable patterns.

### ZOB-ENH-025 — Incident/postmortem factory

- **Status:** Deferred
- **Value:** Convert mission/deploy incidents into evidence-backed RCAs/actions.
- **Dependencies:** incident taxonomy, body-safe evidence/export policy.
- **Acceptance:** no secret/transcript leakage; verified timeline; human-owned actions.
- **Promotion trigger:** Repeated incidents merit automation.

### ZOB-ENH-026 — Cross-repository release/batch factory

- **Status:** Research
- **Value:** Coordinate versioned runtime/pack/application PR sets.
- **Dependencies:** stack graph, compatibility/checkpoint proofs, exact multi-repo receipts.
- **Acceptance:** no partial unauthorized promotion; rollback/dependency evidence.
- **Promotion trigger:** ZOB/pack/app releases become frequent.

### ZOB-ENH-027 — Parallel staging qualification lanes

- **Status:** Deferred
- **Value:** Precompute readiness/collision evidence concurrently while preserving serial staging merges and integration-CI interlocks.
- **Dependencies:** proven staging reconciliation, disjoint impact analysis and fair queue policy.
- **Acceptance:** no parallel base mutation, no missed collisions, stale previews invalidated after every merge and branch-protection compatibility.
- **Promotion trigger:** One-at-a-time staging qualification (not merge execution) is a measured bottleneck.

## GitHub evidence and supply chain

### ZOB-ENH-028 — Rich Check annotations

- **Status:** Deferred
- **Value:** Structured inline findings/evidence links without giant comments.
- **Dependencies:** stable Check schemas and privacy review.
- **Acceptance:** bounded annotations, exact SHA/issuer, no raw sensitive output.
- **Promotion trigger:** Human review benefits from localized evidence.

### ZOB-ENH-029 — Native GitHub merge-queue integration

- **Status:** Research
- **Value:** Use hosted queue/base-update semantics while retaining receipts/Ship interlock.
- **Dependencies:** repository feature evaluation and expected-head semantics.
- **Acceptance:** no bypass of exact human authorization/deployment impact; simulation.
- **Promotion trigger:** GitHub merge queue is enabled/needed.

### ZOB-ENH-030 — Private npm distribution for Wheel pack

- **Status:** Deferred
- **Value:** Cleaner package lifecycle than Git refs.
- **Dependencies:** registry/org, provenance/signing, release automation, access controls.
- **Acceptance:** reproducible signed package, SBOM, exact lock, rollback.
- **Promotion trigger:** Tagged Git package distribution becomes operationally limiting.

## Promoted design items (provenance)

### ZOB-ENH-031 — `develop-staging` integration branch

- **Status:** Promoted-to-v1-design on 2026-07-18; see ZOB-D-103–ZOB-D-110 and section 17.
- **Value:** Catch cross-PR integration/documentation drift before deployment-capable `develop` and restore automatic CD only at an audited promotion boundary.
- **Ratified design:** Every ordinary PR targets persistent `develop-staging`; qualified reviewed PRs auto-squash-merge through a staging-only App, full integration CI runs after each merge, and staging never deploys.
- **Promotion:** A human starts a staging freeze; the audited exact head reaches `develop` only through a merge-commit promotion PR. Automatic CD turns on from that develop merge only.
- **Resolved choices:** all ordinary PR classes; human-started window; freeze unrelated staging merges with finding-bound repair exceptions; separate Staging Merge/Promotion Apps; no human receipt for ordinary staging merges; no v1 break-glass direct path.
- **Dependencies:** application branch/workflow/protection audit, App setup, guard/check schemas, test-repo pilots and explicit activation.
- **Acceptance:** section 17 and validation phases 11–13; no deployment from staging, exact-history promotion, no manual dispatch or hidden bypass.
- **Promotion trigger:** Human ratification on 2026-07-18 (complete); implementation/activation remain independently gated.

### ZOB-ENH-032 — Final Repository Assurance Audit factory

- **Status:** Promoted-to-v1-design on 2026-07-18; see ZOB-D-111–ZOB-D-119 and section 17.
- **Value:** Catch whole-repository source, integration, security, QA, operations and bidirectional documentation gaps after combined changes but before develop/CD.
- **Ratified design:** After staging integration/full CI, run a human-started final independent factory based on PR #3817’s assurance functionality before promotion.
- **Required directions:**
  - top-down: every canonical document’s material present-tense claim matches exact candidate source/configuration/evidence;
  - bottom-up: every discoverable code element/domain/export/route/schema/workflow/user-visible behavior is inventoried and explicitly dispositioned; every public/operational element maps to canonical documentation.
- **Evidence baseline at design capture (2026-07-18):** PR #3817 was an open draft at `02af54029423310cbc4ed1cd70153ab611b766df`; it added ten independent review lanes, frozen-SHA/current-head delta handling, canonical-doc manifest coverage and source-backed documentation reconciliation. Recheck current PR/merge state before promotion. This captured head is evidence for the design seed, not merged current truth.
- **Resolved choices:** closed audit→separate finding-bound repair PR→candidate revision→full CI→wholly fresh re-audit; maximum three assurance rounds/at most two automatic repair transitions; unrelated staging merges frozen; every discoverable code element inventoried; public/operational elements require current canonical docs while private/test/generated/vendor/deprecated elements require explicit dispositions.
- **Dependencies:** PR #3817 outcome/integration, source↔docs inventory schema, language/framework inventory adapters, independent lane/adjudication contracts and exact-head audit Check.
- **Acceptance:** initial/current candidate revision lineage; exhaustive top-down doc manifest with `STALE=0/PENDING=0`; bottom-up source inventory with 100% disposition and zero missing/unknown public elements; ten independent lanes across ≥3 model families where available; full staging/promotion/aligned-head CI; three-assurance-round/two-repair limit; App-authored exact-SHA assurance Check; finalizer never repairs itself.
- **Promotion trigger:** Human ratification on 2026-07-18 (complete); implementation/activation remain independently gated.

### ZOB-ENH-033 — Persistent source↔documentation coverage graph

- **Status:** Research; supporting the promoted ENH-032 design but not required as a persistent cross-run graph for v1
- **Value:** Maintain bidirectional mappings among symbols/routes/schemas/workflows/features and canonical docs, with stale-edge detection.
- **Dependencies:** parser inventory by language/surface, doc citation format, canonical ownership registry.
- **Acceptance:** machine-generated inventory plus human-reviewed dispositions; no “documented” status from filename heuristics alone.
- **Promotion trigger:** ENH-032 is ratified and manual coverage proves too expensive.

## Other recorded ideas

### ZOB-ENH-034 — Reusable factory forge for new Wheel lifecycle factories

- **Status:** Deferred
- **Value:** Generate disabled-by-default schema/docs/test scaffolds from a reviewed template.
- **Dependencies:** stable Story/Review/Ship implementation lessons and quarantine activation workflow.
- **Acceptance:** generated output stays quarantined until review/oracle/human activation; no credential/authority inheritance.
- **Promotion trigger:** Three or more additional factories are planned.

### ZOB-ENH-035 — Cross-factory model/prompt causal evaluation

- **Status:** Research
- **Value:** Connect build choices to later review misses/repair/deploy outcomes without unblinding live agents.
- **Dependencies:** protected lineage across factories and enough adjudicated outcomes.
- **Acceptance:** privacy/body-safe, uncertainty-aware, advisory-only.
- **Promotion trigger:** Story + Blind Review + staging/assurance/promotion telemetry exist.

### ZOB-ENH-036 — Compliance/export evidence package

- **Status:** Research
- **Value:** Produce scoped audit bundles without exposing transcripts/secrets.
- **Dependencies:** evidence classification/redaction/signing and retention policy.
- **Acceptance:** deterministic manifest/hash/issuer chain; explicit human export approval.
- **Promotion trigger:** Customer/legal audit need.

## Rejected as v1 shortcuts

These are not enhancements to revive without a new decision:

- one fragile long-lived LLM as supervisor;
- automatic cross-machine takeover;
- journal tail deletion on corruption;
- plaintext or Git-stored transcripts;
- labels/comments as canonical authorization;
- reviewer source edits;
- static R→W assignments;
- same-story build model as default reviewer;
- experimental review lane clearing alone;
- title-only post-merge exemptions;
- broad `human-override` Ready Guard bypass;
- global unattended auto-merge into `develop` (qualified ordinary staging auto-merge is explicitly allowed);
- manual Ship/Promotion-triggered deployment workflows (automatic CD from the audited develop promotion merge is explicitly allowed);
- automatic learned routing/prompt promotion.