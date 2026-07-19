# 11 — Evidence, CI and GitHub Checks

**Truth class:** Approved design

## Body policy

Normal persisted evidence may contain:

- IDs, refs, paths, hashes, enums, timestamps, status, counts;
- exact provider/model operational metadata only on protected telemetry;
- safe command names/templates and result summaries;
- GitHub URLs/check/review IDs;
- source/manifest/policy bindings.

It may not contain credentials, raw prompts, raw model/provider responses, full tool output, raw diffs, private transcripts or sensitive URLs.

Full transcripts remain encrypted local data.

## Canonical hash construction

Every record/candidate/result/receipt hash is SHA-256 over RFC 8785 JSON Canonicalization Scheme bytes. The producer omits only that record's own terminal hash field before canonicalization (for example `receiptHash`, `resultHash`, `authorizationHash`, `evidenceHash`, `reviewHash`, `inventoryHash`, `roundHash`, `checkpointHash` or `eventHash`; for a candidate, `artifactHashes.candidate`). Prior/input/referenced hashes remain in the payload. Verifiers reconstruct the same projection and reject unknown canonicalization versions, missing full hashes or mismatches. A hash field never hashes itself.

## Branch evidence

```text
execution/evidence/tasks/<task-id>.json
execution/evidence/gates/<gate-id>.json
execution/evidence/human/<receipt-id>.json
execution/evidence/ci/<head-sha>.json
execution/evidence/reviews/<review-id>.json
execution/evidence/staging/<staging-sha>.json
execution/evidence/assurance/<round>-<staging-sha>.json
execution/evidence/promotions/<promotion-id>.json
execution/PR_CLOSE_EVIDENCE.json
execution/PR_CLOSE_EVIDENCE.md
```

The directory shorthand `human/` stores evidence records whose schema `evidenceType` is `human-gate`; the shorter path name is not a second evidence-type token.

Current factory evidence tokens are `task`, `gate`, `pr-close`, `blind-review`, `human-gate`, `staging-merge-gate`, `staging-integration`, `repository-assurance`, `promotion-authorization`, `promotion-gate` and `post-promotion`. `merge-authorization`, `ship-gate` and `post-merge` remain parseable only by the read-only historical migration adapter. Current issuer tokens include `supervisor`, `builder-app`, `reviewer-app`, `staging-merge-app`, `promotion-app`, `ci` and `human`; `ship-app` is legacy. The Wheel adapter rejects every legacy token/issuer as authority for a new Check, mission or mutation.

Per-task records contain the complete compact attempt chain—success, failure, rejection, timeout, abandonment and supersession—using opaque assignment IDs. Gate and PR-close files aggregate accepted current truth.

Large logs live in CI or encrypted local storage and are referenced by hash/URL.

## Binding

Evidence states:

- lifecycle status `current`, `stale`, `invalid` or `superseded`, with cause when non-current;
- repository/branch/head/base/merge-base;
- story/task/manifest revision;
- policy/taxonomy/skill/prompt compiler versions;
- command/check/test identifiers;
- artifact hashes;
- issuer/validator;
- produced/observed timestamps;
- freshness and invalidation cause.

A source, dependency, policy, receipt or relevant base change invalidates affected evidence and reopens dependent work. The invalidation evaluator is evidence-type-aware:

| Change | Minimum affected evidence |
|---|---|
| accepted source/head or manifest revision | owning task, containing gate, PR-close, Blind Review, staging integration, repository assurance and downstream promotion |
| hard dependency artifact/source | dependent task/gate and all aggregates above it |
| validation command/runner/CI policy | evidence that used that validation plus dependent aggregates |
| permission/profile/taxonomy/prompt compiler change | only evidence whose semantic contract depends on the changed version; otherwise record new version for future attempts |
| human receipt expiry/revocation/supersession | Human Gates projection and every unconsumed action/evidence that required it |
| PR base movement | review/staging evidence only when conflict or meaningful path/symbol/schema/lock/workflow/dependency collision changes the evaluated contract |
| authorized finding-bound repair merge during a window | increment candidate revision, retain the window lineage, stale prior assurance/promotion artifacts and require full staging CI + next assurance round |
| unrelated/unrecorded frozen staging movement or any develop base movement | invalidate the window and every assurance/promotion Check/receipt until a new human-started exact boundary is established |
| issuer/App/schema allowlist change | affected GitHub Check evidence until reissued or explicitly migrated |
| exact staging/promotion merge event, merge SHA or reconciliation output changes | staging-integration, promotion/post-promotion evidence and any downstream deployment-confirmation evidence |

`superseded` means a newer valid artifact replaces an older still-auditable one; `stale` means freshness/binding is no longer current; `invalid` means integrity/policy/issuer/contract validation failed. Historical records are retained in all cases.

## Canonical GitHub machine artifacts

App-authored Check Runs are canonical because they bind issuer and SHA.

### `ZOB / PR Close`

Builder App; exact head. Includes close profile, manifest/evidence hashes, ordinary draft CI state, close auditor results and deferred ready-only checks.

### `ZOB / Blind Review`

Reviewer App; exact head/base relation. Includes round/lane/adjudicator opaque refs, finding counts/dispositions and clean/findings verdict.

### `ZOB / Human Gates`

Supervisor projection of authenticated human receipts. Includes receipt IDs/hashes and exact head/process-diff/promotion scope. It cannot create human authority.

### `ZOB / Staging Merge Gate`

Staging Merge App; exact ordinary PR head/base. Proves PR-close, Blind Review, PR CI, mergeability and either no interlock or a current exact failure/finding-bound repair exception.

### `ZOB / Staging Integration`

Staging Merge App; exact `develop-staging` SHA. Proves the complete configured integration CI set is terminal/acceptable and that deployment workflows exclude staging.

### `ZOB / Repository Assurance`

Reviewer App; exact frozen staging/develop boundary. Binds ten lane results, top-down doc verdict ledger, bottom-up element coverage, repair round and fixed synthesizer PASS.

### `ZOB / Promotion Authorization`

Promotion App; exact promotion PR/staging/develop heads. Binds the separate human promotion-merge receipt and automatic-CD impact receipt.

### `ZOB / Promotion Gate`

Promotion App; exact pre-merge promotion PR. Proves staging integration, repository assurance, full promotion-PR CI, mergeability, issuer/schema/receipt current and merge method `merge-commit`.

Human-readable PR comments summarize Checks. Lifecycle labels project queue state. Neither comments nor labels replace canonical Checks/receipts.

## Staging and Promotion Guards

Shared pure evaluators are used by draft preview, GitHub workflows and broker reconciliation. The Staging Guard reads `develop-staging` policy; the Promotion Guard reads `develop` policy and the frozen assurance contract. They validate:

- governed profile and required Check set;
- current SHA and approved issuer App IDs;
- schema/policy compatibility;
- profile artifact requirements;
- exact human ACK/override scope;
- current check failures/pending/missing state;
- review-state consistency;
- ordinary PR base is `develop-staging` and deployment workflows exclude it;
- frozen staging/develop SHA relation, assurance coverage and promotion merge method when applicable;
- automatic-CD impact for the develop promotion;
- post-promotion bundle artifact and scoped diff.

No early `human-override` exit. No title-only exemption. No bare-label proof. New Wheel evaluations fail closed on legacy direct-base factory/evidence/issuer/merge-batch tokens.

## PR, staging and promotion CI

1. Story PR-close requires all scheduled ordinary draft-head checks terminal/acceptable; profile-declared ready-only checks remain explicit.
2. Staging Merge marks a qualified ordinary PR ready, waits for every expected post-ready PR check, then squash-merges to `develop-staging`.
3. Every staging merge—including a window-bound repair merge—runs the full integration CI set on the exact staging SHA before the next assurance/merge.
4. A human-started frozen promotion window reruns full staging CI before assurance.
5. The promotion PR to `develop` runs every required develop-target PR/ready check again before human promotion-merge authorization.
6. Post-promotion staging fast-forward creates a new SHA; full staging integration CI and a current Check on that aligned SHA pass before queue unfreeze.

Acceptable skipped/neutral conclusions must be policy-declared. Cancelled, superseded, missing or unknown checks do not silently pass. Staging branches must not match any deployment trigger; the develop promotion merge may trigger automatic CD and is recorded without manual dispatch.

## Flakes

One automatic rerun only when:

- check matches a versioned known-flake ledger entry;
- current log signature matches;
- rerun ceiling not consumed.

Otherwise route real failure to repair.

## Claim versus completion

- Agent output/final marker is a claim.
- Parent validation/review creates accepted task evidence.
- Gate closure aggregates accepted required tasks.
- PR-close aggregates current gates/CI/audits.
- Blind Review independently evaluates the PR.
- Staging Merge mechanically revalidates and integrates one PR, then full staging CI validates the combined head.
- Final Repository Assurance independently evaluates the whole frozen repository and documentation coverage.
- Promotion mechanically revalidates assurance/CI/receipts and merge-commits only the exact authorized candidate.

No lower layer can self-certify a higher one.

## Progress

Derived weighted progress counts accepted required DAG nodes only. A running/claimed task can display activity but contributes no accepted completion. Invalidation may decrease progress with explicit cause.