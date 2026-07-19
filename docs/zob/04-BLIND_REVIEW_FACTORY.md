# 04 — Blind PR Review Factory (R-Machine Successor)

**Truth class:** Approved design
**Maturity / activation:** Specified only; disabled until separate implementation, pilots and activation receipt

## Existing R behavior being replaced

**Truth class for this subsection:** Current evidence at the source refs/SHA captured in `SOURCE_EVIDENCE.md`.

Current Fleet v4 R machines statically cover W-machine groups, poll `fleet:needs-review`, claim via GitHub assignee, and dispatch `/review-all` using the story’s build model at medium thinking. A SHA-bound verdict controls `blind-review-clean` or findings labels.

The new design corrects these problems:

- same-model self-similarity is not independent review;
- `/review-all` is a human-facing pre-close scan/fix workflow, not a formal read-only R contract;
- isolated review worktrees are writable;
- claims/recovery are coarse;
- telemetry rewards finding count without adjudicating precision/recall;
- exact build-model data is visible;
- review telemetry uses application `develop` as a bus.

`/review-all` remains a pre-close scanner owned by PR-close. Formal review becomes an `mpr` formal-PR profile.

## Input and output

**Input:** current draft PR with valid exact-head PR-close evidence and `fleet:needs-review`.
**Output:** either a SHA-bound clean review or structured findings returned to Story repair.
**Stop:** before ready, merge or deployment.

Legacy `/pr-close` evidence is supported through a strict adapter. Missing fields fail closed.

## Queue and claim

- One dynamic global queue replaces static R→W affinity.
- Priority: invalidated prior round, risk, age, then starvation protection.
- R1/R2/R3 may remain logical concurrency slots in Mission Control.
- Claims bind PR, exact head, run, lane set and lease.
- GitHub assignee is optional visibility, not authority.
- Head change cancels/requeues the round.

## Admission

Require:

- open ordinary PR targeting mandatory base `develop-staging`;
- branch current with base at intake;
- valid Builder App `ZOB / PR Close` exact-head Check or strict read-only legacy evidence equivalent;
- required story/profile artifacts;
- ordinary draft CI state allowed by the close contract;
- no open close blocker;
- available read-only review workspace and reviewer App.

Base movement after intake invalidates only when it creates a conflict or meaningful path/symbol/schema/lock/workflow/dependency collision.

## Risk-scaled panel

The normalized `riskClass` vocabulary is `low|medium|high|critical`; security/trust work that requires the strongest panel is `critical` rather than a separate `security-critical` enum.

### Low risk

- one mandatory general control lane;
- optional experimental shadow lane.

### Medium risk

- general control lane;
- independent evidence/domain lane;
- optional experimental shadow lane.

### High/security/trust risk

This subsection covers both `high` and `critical`. Both require the same three control minima enforced by the schema: general control, security/domain control and evidence/QA control, plus all signaled specialists. `critical` additionally forbids a same-exact-model independence fallback unless a human authorizes the degraded condition and an extra independent control lane is added; budget pressure cannot remove a mandatory lane.

- general control lane;
- security/domain control lane;
- evidence/QA control lane;
- any signaled specialist lanes;
- optional experimental shadows.

Each reviewer is independently randomized, preferably from a different model family than builders and peer reviewers. Same exact model is an explicit degraded fallback.

Experimental prompt lanes cannot clear a PR alone. They may contribute a validated blocker. Required risk-domain control coverage always remains.

## Blindness and visibility

Reviewers do not receive builder/reviewer model identity, thinking, prompt treatment, prior reputation or prior review conclusions.

Review proceeds in stages:

1. **Fresh source pass:** diff, surrounding source and tests; no implementation rationale/prior findings.
2. **Acceptance/evidence pass:** ratified acceptance, execution manifest and PR-close evidence.
3. **Adjudication:** frozen lane reports and supporting evidence, still without model identities.

The first report cannot be rewritten after later context is shown.

## Lane tasks

```text
review.fresh-source
review.acceptance-completeness
review.qa-evidence
review.security-trust
review.frontend-a11y
review.migration-infra
review.repair-verification
review.adjudication
```

Agents have source read, bounded test/scanner execution and report output only. They cannot edit source or call GitHub.

## Finding contract

A finding records:

- finding/round/opaque lane IDs;
- PR and exact head;
- file:line/symbol;
- severity and category;
- specific claim and source evidence;
- acceptance/evidence relation;
- reproduction/failure path;
- confidence;
- recommended correction class;
- blocking disposition.

All evidence-qualified defects and acceptance gaps block regardless of severity. Suggestions are advisory. Scope/trust questions route to needs-human.

## Adjudication

A fixed strong blind adjudicator:

- verifies evidence;
- deduplicates semantic overlaps;
- distinguishes defect/gap/question/suggestion;
- enforces required lane coverage;
- emits PASS or findings.

Exact adjudicator model is verified later. Discovery lanes remain randomized/experimental.

## GitHub identity and artifacts

A dedicated reviewer GitHub App has contents/checks read and review/comment/approved-label/check write only. It cannot write source, merge, deploy or administer.

Canonical artifact: App-authored `ZOB / Blind Review` Check on the exact SHA. Human-readable review comments and labels are projections.

A bare `blind-review-clean` label never satisfies downstream gates.

## Repair loop

```text
findings
→ request-changes artifact + fleet:findings/fleet:needs-fixer
→ Story repair mission
→ affected gate/task reopening
→ validation + PR-close rerun
→ fleet:needs-review
→ new full review round
```

The new round includes a fresh full-diff lane blind to prior findings and a separate repair-verification lane that sees finding IDs.

Maximum: three complete repair/re-review rounds. Remaining blockers then create one needs-human card with full lineage.

## Model/prompt telemetry

Formal review metrics use adjudicated outcomes:

- valid/unique finding precision;
- duplicate/noise rate;
- severity accuracy;
- false-positive/contested rate;
- later-discovered misses;
- invalidated clean verdicts;
- repair acceptance;
- time/tokens/cost;
- model × domain/task × prompt interactions.

Exact identities remain on the protected telemetry branch. PR evidence uses opaque lane/assignment IDs.

## Disabled-by-default gate

```text
factory.blindReview.enabled = false
reviewerApp.credentials = absent
activationReceipt = none
```

Installation or implementation does not change these values. Activation requires the separate rollout in [`14-VALIDATION_AND_PILOTS.md`](14-VALIDATION_AND_PILOTS.md#blind-review-factory-rollout), fresh oracle PASS/no-ship false and an explicit factory activation receipt.

## Completion states

```text
blind-review-clean
findings-returned-to-story-factory
needs-human
invalidated/requeued
```

Clean requires all mandatory lanes, no validated defect/gap/question, adjudicator PASS, unchanged head, current PR-close evidence, successful Reviewer-App Check and confirmed label projection. A clean verdict hands the PR to the automatic Staging Merge factory; it is not develop-promotion or deployment approval.