# 17 — Staging Assurance and Promotion Factory

**Truth class:** Approved design
**Maturity / activation:** Specified only; not implemented, installed or activated

## Purpose

`develop-staging` becomes the mandatory persistent integration branch for every ordinary Wheel PR. It is a non-deploying buffer where independently reviewed changes combine and run full integration CI before any code reaches `develop`.

A human-started promotion window freezes unrelated merges at an initial staging head, tracks any finding-bound repair descendants as versioned candidates, runs a final whole-repository assurance/repair/re-audit loop, opens a typed promotion PR, obtains final exact-head human authorization, and merge-commits the audited history into `develop`. That single develop merge is where automatic CD turns back on.

## Absolute branch policy

```text
ordinary PR base:       develop-staging
staging deployment:     forbidden / no CD workflow trigger
ordinary merge method:  squash
promotion PR base:      develop
promotion PR head:      develop-staging
promotion merge method: merge-commit
manual deploy dispatch: forbidden
```

No ordinary feature/fix/docs/process/migration/CI/tooling PR targets `develop`. Version one has no break-glass direct-to-develop path. A production emergency remains needs-human until a separately reviewed emergency policy exists; it does not silently bypass staging.

## Lifecycle

```text
Story → PR-Close
→ Blind PR Review
→ Staging Merge Factory
→ full develop-staging integration CI
→ staged-awaiting-promotion

human starts promotion window at initial staging SHA
→ freeze unrelated develop-staging merges
→ full staging CI on exact candidate revision
→ Final Repository Assurance round
   ├─ clean → promotion PR
   └─ findings in rounds 1–2 → only finding-bound repair PR(s)
       → gated staging repair merge → candidate revision → full CI → full re-audit
→ round 3 findings → needs-human (no automatic repair/round 4)
→ promotion PR full CI + exact assurance/authorization Checks
→ human exact-final-head promotion authorization
→ Promotion App merge-commit into develop
→ automatic CD from develop
→ exact-input post-promotion reconciliation
→ expected-head fast-forward develop-staging to promotion merge SHA
→ full aligned-head staging integration CI
→ unfreeze staging queue
```

PRs may keep building/reviewing/running PR CI while staging is frozen. Unrelated PRs cannot merge until promotion completes or a human abandons/unfreezes the window. The sole merge exception is a repair PR bound to a validated finding and the active window; it passes every ordinary gate, revises the candidate and invalidates the prior assurance.

## Staging Merge Factory

Input: open PR targeting `develop-staging` with current exact-head:

- `ZOB / PR Close` success;
- `ZOB / Blind Review` success;
- required ordinary PR CI terminal/acceptable;
- mergeability and base-collision proof;
- no blocking human/review item.

The Staging Merge App automatically squash-merges one qualified PR at a time using an expected-head request. No human per-PR merge receipt is required because staging cannot deploy and cannot promote itself. During a red interlock, the broker rejects every merge except an exact failure-bound repair PR. During a promotion freeze, it rejects every merge except an active-window repair PR whose finding IDs, expected staging head and candidate revision are current.

After each merge:

1. record exact PR/head/staging merge SHA;
2. observe/correlate the configured push-triggered full integration CI set on `develop-staging`; the App never dispatches a workflow;
3. publish `ZOB / Staging Integration` on the exact staging SHA only after that CI is terminal;
4. reconcile staged story/dependency/kanban state;
5. allow the next merge only if staging is terminal green.

A failure freezes staging merges and returns evidence to the responsible Story repair path. There is no automatic destructive reset/revert. Repair uses a new reviewed PR to staging; attribution uncertainty becomes needs-human.

## Promotion-window authority

Only a human may start a promotion window. The receipt binds:

- repository and window ID;
- initial `develop-staging` SHA and initial candidate hash;
- current `develop` SHA;
- initial staged cohort PR/merge list;
- assurance policy/profile versions;
- maximum three assurance rounds and at most two automatic repair transitions;
- budget/concurrency/expiry;
- actor/source/receipt hash.

Starting the window authorizes freeze/audit and finding-bound repair descendants, not promotion. Each expected repair merge creates a monotonically numbered candidate revision linked to the prior candidate/hash and authorized finding/repair PR; it does not require a new window receipt. Any unrelated or unrecorded branch movement, develop movement, lineage gap or policy change invalidates the window and blocks effects. The later promotion-merge receipt binds the final exact candidate revision/SHA.

## Final Repository Assurance

### Frozen boundary

Every round records:

- window ID, candidate revision and prior-candidate hash;
- initial staging SHA, current staging worktree/branch/exact SHA and authorized repair lineage;
- current develop SHA and merge base;
- complete included cohort + repair PR/merge set since prior promotion;
- source/doc manifest hashes;
- CI/workflow/profile/taxonomy/skill/model/prompt policy versions;
- timestamp and external evidence freshness.

All lanes read source from that immutable boundary. The finalizer cannot repair its own findings.

### Independent lanes

The PR #3817 assurance system is the implementation seed. Required lanes are independently dispatched, blind to prior conclusions, and span at least three model families when available:

1. source integration, architecture and registration;
2. product/feature completeness and reachable user behavior;
3. security, privacy, auth, RLS, crypto and trust boundaries;
4. reliability, performance, cost and observability;
5. data/control plane, migrations and external integrations;
6. QA, test/coverage/skip/quarantine truth;
7. dependencies, supply chain, CI/IaC and installation;
8. operations, rollout, rollback and deployment impact;
9. top-down canonical documentation truth;
10. bottom-up source-to-documentation coverage.

A fixed strong blind synthesizer/adjudicator verifies evidence, deduplicates findings and issues the round verdict. Experimental lanes cannot clear the candidate alone.

### Top-down documentation audit

1. Enumerate the exact canonical-document manifest.
2. Assign every document once; prove no gaps/duplicates.
3. Verify every material present-tense claim against exact candidate source/configuration/evidence.
4. Classify each document `CURRENT`, `EVIDENCE-BOUND`, `STALE` or `PENDING`.
5. Require `STALE=0` and `PENDING=0` before clean.
6. Dated live/legal/vendor claims may remain `EVIDENCE-BOUND` only when their external boundary and refresh evidence are explicit.
7. One document is never sole proof for another.

### Bottom-up element coverage

The factory inventories every discoverable repository code element—not only files. Parsers/adapters cover at minimum:

- files, modules, exports, classes, functions, methods, types, enums, constants;
- startup/registration/caller/wiring edges;
- routes, middleware, handlers and request/response contracts;
- frontend pages/components/hooks/user-visible controls;
- CLI commands and MCP/tools/resources/prompts;
- services/jobs/queues/connectors/webhooks;
- database schemas/tables/columns/indexes/FKs/policies/RLS context/migrations;
- workflows/jobs/events/path filters/IaC/runtime/env/config;
- auth/encryption/key/plaintext/security boundaries;
- provider/model/prompt/evaluation/control-plane registries;
- tests/fixtures/mocks/generated/vendor/deprecated elements;
- logging/metrics/traces/SLO/operational runbooks.

Each inventory element gets exactly one disposition:

```text
canonical-documented
intentionally-internal
test-only
generated
vendor
deprecated-or-superseded
missing-documentation
unknown-or-unresolved
```

Public/operational elements—anything exported, registered, reachable, user-visible, security/data/runtime relevant, or externally depended on—must be `canonical-documented` with a valid current doc path+anchor and source/caller evidence. Private/test/generated/vendor/deprecated elements still require explicit disposition/evidence but do not each require canonical prose. Filename heuristics alone cannot prove documentation.

Clean requires 100% disposition coverage, zero duplicate/missing inventory IDs, `missing-documentation=0`, `unknown-or-unresolved=0`, and all public/operational mappings current.

### Findings and repair loop

Every validated source defect, contract gap, undocumented public element, stale canonical claim, CI/QA gap or unresolved inventory item blocks.

The audit produces structured findings. After assurance rounds 1 or 2, fresh repair agents may work in isolated branches/worktrees and open repair PRs targeting frozen `develop-staging`; they do not inherit reviewer identities or conclusions beyond the exact finding contract. Repair PRs must bind the window/candidate/finding IDs and expected staging head, then pass PR-close, Blind Review and ordinary CI before the Staging Merge App applies the narrow freeze exception.

After each authorized repair merge:

- the candidate revision increments and records prior/current SHA, repair PR and finding lineage;
- full push-triggered staging integration CI reruns;
- every prior assurance artifact is stale;
- a completely new assurance round reads the new exact head;
- prior findings are visible only to dedicated repair-verification tasks, while fresh lanes begin from source.

Maximum three full assurance rounds means at most two automatic repair transitions. Findings in round 3 create one needs-human case; the system does not auto-repair into a nonexistent round 4. No partial/experimental/sampled audit can clear promotion.

## Promotion PR and Checks

A clean round creates/updates one promotion PR from `develop-staging` to `develop`. Both branches remain frozen for the candidate relation except unrelated external base events, which invalidate/reconcile.

Required exact-head Checks:

```text
ZOB / Staging Integration      Staging Merge App
ZOB / Repository Assurance     Reviewer App
ZOB / Human Gates              Supervisor projection
ZOB / Promotion Authorization  Promotion App
ZOB / Promotion Gate           Promotion App
```

The promotion PR runs every required develop-target PR/ready check again. Tree equivalence to the audited staging SHA, current develop base, mergeability, deployment-impact analysis and Check issuers/schema versions are revalidated.

## Promotion authorization

After the promotion PR and all required CI/Checks are green, the human reviews one exact candidate and issues a promotion-merge receipt binding:

- promotion PR;
- audited staging SHA;
- current develop SHA;
- assurance result/hash/round;
- full CI/check set;
- merge method `merge-commit`;
- included staged PRs;
- automatic CD workflow/path/environment consequences;
- expiry/revocation;
- explicit `manualDispatchAuthorized=false`.

This is distinct from the earlier promotion-window receipt. Head/base/workflow/policy changes invalidate it.

## Merge and automatic CD

The dormant Promotion App performs one expected-head GitHub merge-commit. Squash/rebase are forbidden because they rewrite the audited staging commits. Admin/bypass flags are forbidden.

The `develop` merge event may automatically trigger configured CD workflows. That is the intended point where automatic CD is enabled again. The factory records workflow run IDs and deployment-impact receipts but never manually runs `workflow_dispatch` or claims deployment success.

Post-promotion reconciliation receives the exact promotion merge event. When complete, the Promotion App fast-forwards `develop-staging` from the audited staging SHA to the new develop promotion merge SHA using expected-head protection, restoring branch alignment without changing the tree. The aligned SHA is new, so push-triggered full staging integration CI must finish and a current `ZOB / Staging Integration` Check must bind that SHA before the staging merge queue is unfrozen.

A deployment-confirmation factory remains separate/deferred.

## Apps and permissions

### Staging Merge App

- read PR/check/review/content metadata;
- mark ready and squash-merge only PRs whose base is `develop-staging`;
- publish Staging Integration Check;
- no write/merge to `develop`/`main`;
- no workflow/deploy/environment/secret/admin authority.

### Promotion App

- dormant except an active human-started promotion window;
- read required source/check/review/receipt metadata;
- publish Promotion Authorization/Gate Checks;
- merge-commit only the typed promotion PR into `develop`;
- expected-head fast-forward `develop-staging` only after successful promotion/reconciliation;
- no source repair, workflow dispatch, environment/secret/admin bypass.

Builder and Reviewer Apps remain separate.

## Contract schemas and semantic validation

- [`staging-candidate.schema.json`](schemas/staging-candidate.schema.json)
- [`source-doc-coverage.schema.json`](schemas/source-doc-coverage.schema.json)
- [`repository-assurance-result.schema.json`](schemas/repository-assurance-result.schema.json)
- [`assurance-repair-round.schema.json`](schemas/assurance-repair-round.schema.json)
- [`promotion-authorization.schema.json`](schemas/promotion-authorization.schema.json)
- [`promotion-merge-evidence.schema.json`](schemas/promotion-merge-evidence.schema.json)
- `ack-receipt.v1` with distinct `promotion-window` and `promotion-merge` tokens

Mandatory semantic validators add cross-field guarantees JSON Schema cannot express:

1. window ACK initial SHA/hash, every candidate revision, authorized repair transition and final included PR set form one exact staging ancestry;
2. every candidate PR/check/merge is current; candidate and promotion included-PR sets match cohort + repairs;
3. coverage IDs are unique, totals/disposition sums agree and every public/operational element has a current canonical-doc mapping;
4. assurance has all ten independent lanes, eligible family/degradation rules and exact source/doc/inventory hashes;
5. auditor and repairer assignment sets are disjoint;
6. each round-1/2 repair merge invalidates the old assurance, passes full staging CI and forces the next round; round-3 repair is rejected and remaining findings require needs-human;
7. non-pass assurance is `noShip=true`; promotion authorization receipt/check/assurance/staging/develop hashes all match current GitHub truth and deployment impact is not unknown;
8. promotion merge parents include exact audited staging and exact authorized develop base, result tree equals staging and method is merge-commit;
9. any observed CD run is push-triggered by the exact promotion merge, completed observations have conclusions and manual dispatch remains false;
10. staging alignment expected-old/new SHAs match the audited staging and promotion merge, and aligned-head integration CI passes before queue unfreeze.

## Disabled-by-default gate

```text
developStaging.required = design-only / not installed
factory.stagingMerge.enabled = false
factory.repositoryAssurance.enabled = false
factory.promotion.enabled = false
stagingMergeApp.credentials = absent
promotionApp.credentials = absent
activationReceipt = none
```

Activation requires application branch/workflow changes, staging non-deployment proof, full CI fixture, PR #3817 functionality integration, schemas, test-repo pilots, permission denial tests, three-assurance-round/two-repair-transition simulation, promotion merge/aligned-head-CI/CD simulation without live deployment, independent oracle PASS/no-ship false, and explicit human activation.