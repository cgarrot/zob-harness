# 03 — Story → PR-Close Factory

**Truth class:** Approved design
**Maturity / activation:** Specified; first implementation target; not yet implemented or activated

## Mission contract

**Input:** one or more approved story bundles.
**Output:** one exact-head, evidence-bound draft PR per story targeting mandatory non-deploying `develop-staging`, handed to formal review.
**Stop:** before formal R review, ready transition, staging merge, promotion, deployment, publish or provider activation.

## Admission

For each story the supervisor:

1. verifies repository, mandatory ordinary-PR base `develop-staging` and bundle hash;
2. reconciles current source, branches, PRs and prior evidence;
3. confirms product scope was ratified;
4. chooses one base execution profile plus overlays;
5. imports valid existing gate artifacts and invalidates stale ones;
6. builds the story/gate/task DAG;
7. records permissions, model/prompt policy and budgets;
8. creates the canonical branch/worktree;
9. commits a non-empty bootstrap execution manifest;
10. opens a draft PR immediately;
11. begins the first ready task.

Missing technical detail may be repaired automatically. Unresolved product, trust, destructive, spend, target-branch or completion decisions create needs-human.

## Canonical manifest

The full execution contract is committed to the story branch:

```text
<story-root>/
  EXECUTION_MANIFEST.json
  execution/
    revisions/
    handoffs/
    evidence/tasks/
    evidence/gates/
    evidence/human/
    evidence/ci/
    evidence/reviews/
    PR_CLOSE_EVIDENCE.json
    PR_CLOSE_EVIDENCE.md
```

High-frequency status remains in the mission ledger. Every structural replan creates an immutable revision with parent hash/reason. Workers may submit typed split/add/label/permission/dependency proposals but cannot edit the canonical manifest.

## Gate path

```text
-1  Ratification proof
 0  Current source/context and file:symbol integration map
 1  Plan, task graph, test/doc/permission strategy
 2  Concrete blueprint
 3  Source-drift, scope, collision, estimate and executable-plan reconciliation
 4  Build/integration
 5  Source-backed documentation
 6  Learning/enhancement/model-prompt proposals
 7  Current-head readiness and functional QA
```

Gate 8/post-deploy is outside this factory. Exact-input post-promotion reconciliation/staging alignment is the separately disabled design in [`17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md`](17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md#merge-and-automatic-cd) / `ZOB-ENH-022`; deployment confirmation remains `ZOB-ENH-023`.

Safe cross-gate preparation may pipeline through explicit dependencies. Gate closure remains contract-ordered. A closed gate automatically reopens when source, dependency, receipt or evidence bindings become invalid; only affected descendants reopen.

## Task design

A task has one owning gate/role, stable lineage, explicit dependencies, bounded paths, acceptance criteria, validation commands, evidence requirements, risk/review policy, skill allowlist and attempt budget.

Example lineage:

```text
H31:G4:T2
H31:G4:T2.1
H31:G4:T2.R1
H31:G4:T2.V1
```

IDs never renumber.

## Scheduling and workspaces

- One canonical story worktree/branch owns accepted integration.
- Exclusive path leases protect concurrent writes.
- Overlapping/high-risk work uses isolated sandboxes.
- Workers submit merge candidates; they do not commit or accept themselves.
- The integration owner validates candidates, creates scoped commits and pushes coherent accepted work automatically.
- Those pushes are limited to approved feature/stack branches; direct pushes to protected base branches remain forbidden.
- Stacked story PRs target parent story branches until dependency order permits retargeting; their final ordinary target is `develop-staging`, never `develop`.

## Agent roles

- deterministic supervisor;
- fixed orchestrator-model invocations for technical planning/judgment;
- randomized development, QA, documentation and internal-review workers;
- integration owner;
- three fresh fixed PR-close auditors.

Agents use opaque IDs and task-scoped skills/tools. The supervisor knows exact assignments; agents/orchestrator do not.

## Attempt ladder

1. Filter the role pool by hard capability/security/budget requirements.
2. Uniformly shuffle the eligible routes with a private persisted seed.
3. Start the selected model at its lowest supported level at or above `low`.
4. Traverse supported `low → medium → high → xhigh → max` levels after qualifying quality failure.
5. Give non-reasoning models one `default` attempt.
6. Do not penalize model quality for provider, tool, permission, human or environment failure.
7. Exhaust the model only after its valid quality ladder (and prompt control rescue when applicable) fails.
8. Continue to the next shuffled model.
9. Create needs-human only after policy/budget/pool exhaustion.

Every escalation starts a fresh session with a bounded factual handoff.

## Prompt experiments

For randomized worker pools:

- 50% uniform control;
- 50% vetted shared/model-specific candidates;
- private independent seed;
- variant fixed across one model’s thinking ladder;
- bounded control rescue after a candidate exhausts;
- no prompt text names the model or treatment;
- fixed orchestrator and PR-close prompts do not experiment initially.

## Acceptance and review

A worker returns a typed claim with changed paths, artifact hashes, validation results, risks and final marker. The supervisor verifies actual source/workspace state.

- Low-risk mechanical work may receive deterministic acceptance.
- Medium/high-risk work requires independent review.
- Every gate requires reconciliation.
- Every final head requires fresh close review.
- A later attributable defect reopens its lineage and advances the private model ladder; cross-task integration defects create independently routed repair tasks.

## Human questions

A genuine human blocker causes:

1. canonical needs-human card;
2. body-safe shared checkpoint;
3. branch handoff commit/push;
4. requesting worker termination and capacity release;
5. watcher monitoring;
6. first valid answer receipt becoming authoritative;
7. fresh attempt on the exact blocked task.

Conflicting later answers create a conflict card.

## Draft CI

The Story factory requires every scheduled ordinary draft-head check to be terminal and acceptable. Ready-only checks are recorded as deferred. One automatic rerun is allowed only for a known ledgered flake whose current logs match.

## PR-close

PR-close is part of this factory, not the later R review.

Three fresh, read-only, fixed `Sol-high` tasks run on the exact final head:

1. **Source/integration audit** — contract, wiring, source and scope.
2. **Evidence/QA/CI audit** — validation, artifacts, draft CI, freshness and honesty.
3. **Finalizer** — reconciles both audits and produces the close verdict/check.

`Sol-high` is a policy alias, not a provider/model identity. Its exact route is filled only after the gated provider audit (including OpenAI OAuth); the design does not pre-assert which verified route will satisfy it. The three sessions are independent and cannot edit source.

Any repair invalidates prior close evidence and reruns the necessary checks. The three-round ceiling in the Blind Review factory applies only to formal R review; internal build/PR-close repair remains bounded by task attempt, model-pool, cost and duration budgets, then routes to needs-human.

## Disabled-until-validated gate

```text
factory.story.enabled = false until local validation
builderApp.credentials = absent until separately installed
activationReceipt = none
```

Story is the first implementation target, but implementation/installation does not activate it. Its one-story pilot and fresh oracle/human activation gate in section 14 must pass first.

## Completion

A story leaves the factory only when:

- all required gates/tasks are accepted;
- all required evidence is current;
- ordinary draft CI is terminal/acceptable;
- no blocking needs-human item remains;
- all three close tasks pass;
- Builder App `ZOB / PR Close` Check succeeds on the exact head;
- compact task/gate/attempt-chain evidence is committed;
- `fleet:needs-review` is projected from valid evidence.

The mission completes after all admitted stories meet this state. It does not claim the stories formally reviewed, ready, staged, promoted, deployed or post-deploy confirmed. Blind Review consumes the handoff; only the separate Staging Merge factory may later merge a clean PR into `develop-staging`.