# 10 — Execution Profiles, Taxonomy and Skills

**Truth class:** Approved design

## Composition

Each story selects one base profile plus overlays.

### Base profiles

- `full-feature`
- `quick-fix`
- `docs-process`
- `refactor-cleanup`

### Overlays

- `security-trust`
- `privacy-encryption`
- `database-migration`
- `infrastructure-ci`
- `frontend-user-visible`
- `backend-api-data`
- `cli-mcp-tooling`
- `vendor-dependency`
- `external-integration`
- `model-prompt-control`
- `performance-cost`
- `supply-chain-installer`
- `observability-operations`
- `test-harness-evidence`
- `destructive-change`

Requirements union and the stricter rule wins. The supervisor may add evidence-backed conservative overlays. Removing/weakening a declared/required overlay needs human approval. Quick may auto-promote to full; full cannot auto-downgrade.

## Profile schema behavior

The normative design contract and fictional example are [`schemas/execution-profile.schema.json`](schemas/execution-profile.schema.json) and [`examples/execution-profile.example.json`](examples/execution-profile.example.json).

Profiles contain:

- selectors and signal/source predicates;
- gate requirement patches;
- task templates;
- entry/exit/evidence/review additions;
- permissions/human receipts;
- deferred actions.

Conflicts that cannot be safely unioned create needs-human.

## Base profile expectations

| Base | Planning | Build | Docs/Learn | Readiness |
|---|---|---|---|---|
| full-feature | Full -1–3 | parallel bounded tasks + integration owner | required by affected surface | full current-head QA |
| quick-fix | lightweight ratification/root cause + compact 1–3 | targeted repair/regression | docs conditional; learning proposal | targeted + affected suite |
| docs-process | approved intent/source map + compact plan | docs/process artifacts | canonical index/drift closure | link/schema/process checks |
| refactor-cleanup | scope/equivalence/integration plan | behavior-preserving change | architecture docs conditional | equivalence, CodeScene, tests |

All use exact-head PR-close and three read-only close tasks.

## Overlay examples

### Security/trust

Threat model, security blueprint, SAST, independent security review, auth/RLS/privilege checks and human trust receipts.

### Privacy/encryption

Data-custody/retention map, plaintext/key-boundary checks, crypto review, privacy disclosure impact and no-live-KMS/secrets boundary.

### Database

Schema truth, idempotent migration/rollback, lock/row estimate, temporary DB dry run and RLS transaction tests. Live migration/deploy deferred.

### Infrastructure/CI

Workflow/path/event coverage, IaC scan, branch-protection reality, rollback and process ACK. No workflow dispatch.

### Frontend

Design context/mock where required, responsive states, accessibility, design tokens, copy honesty and browser QA.

### Backend/API/data

Route registration, auth, request/response/schema contracts, service wiring and integration tests.

### CLI/MCP

Command/tool schema, help/discovery, noninteractive behavior, transport permissions and end-to-end invocation.

### Vendor/dependency

Vulnerability/license/maintenance, attribution, vendor privacy, dependency scans and vendor/spend gates.

### Supply chain/installer

Package provenance/checksums/SBOM, clean-machine install, pinned lock, upgrade/rollback and publish gate.

### External integration

Connector/vendor contract, token/refresh/webhook boundaries, rate limits, fixture/sandbox behavior and no-live-call gate.

### Model/prompt

Provider/policy authority, eval/golden cases, privacy/budget/decode constraints and dev-only/no-activation evidence.

### Performance/cost

Baseline/target, representative workload, bounded profiler/benchmark, cost/latency regression limits and budget receipt for paid tests.

### Observability/operations

Structured event/log/metric/SLO contract, privacy/redaction, failure/recovery runbook and current-state health evidence without claiming live proof from source alone.

### Test-harness/evidence

Active runner/CI selection proof, production-signature mocks, coverage/skip/quarantine contracts and visible current-head validation output.

### Destructive change

Complete consumer/dependency inventory, reversible plan or explicit irreversibility, backups/rollback, dry run, human destructive receipt and deferred live mutation.

## Fleet v5 signal mapping

Preserve all 17 story signals:

```text
profileWeights, routeHint, domains, surfaces, blast, securityFlags,
diffBreadth, reversibility, verification, testDemands, contextLoad,
designFreedom, opsTouch, humanCheckpoint, parallelizable,
reviewerGate, escalationTriggers
```

They are inputs, not decisions.

- security flags/reviewer gate add security/privacy overlays;
- surfaces/domains nominate overlays;
- blast/reversibility strengthen risk/review;
- verification/test demands add evidence/QA tasks;
- external-publish/live-systems create deferred-action boundaries;
- human checkpoint creates needs-human;
- escalation triggers become machine stop rules;
- route hint informs workload planning, not initial model preference;
- profile weights remain analytics labels.

If full acceptance includes publish/deploy/live action, admission splits build/PR-close/staging versus promotion/post-promotion/live acceptance. If the bundle cannot authorize that split, needs-human blocks false completion. Ordinary story profiles never authorize a develop promotion or deployment.

## Taxonomy

Versioned registries in this repository's bounded `packages/wheel-zob-pack/` layer:

```text
story-types.json
gate-types.json
task-verbs.json
artifact-types.json
domains.json
surfaces.json
risk-and-blast.json
verification-types.json
dependency-types.json
task-origins.json
```

Every label has authored/inherited/inferred provenance, confidence and taxonomy version. Unknown values become `candidate:<value>` with evidence. Candidates appear in analysis/UI but cannot alter routing, permissions or review until human-promoted.

## Repository-assurance profile

Final assurance is a factory-level profile, not a story base/overlay. It requires the ten lanes in section 17, an exact canonical-doc manifest, an exhaustive every-element source inventory with one disposition per element, full staging CI, a fixed blind synthesizer, zero unresolved public documentation gaps and a maximum of three complete audit/repair/re-audit rounds. It cannot be weakened by any story profile or sampled scan.

## Skill binding

| Stage | Intent owner | Support |
|---|---|---|
| admission/-1–3 | `work` | gate-discover/context/plan/blueprint/reconcile, scope/estimate |
| build | `work` | gate-build, domain fixes |
| docs | `work` | gate-document, source-backed doc skills |
| learn | `work` | gate-learn, proposal generators |
| QA/readiness | `qa`, `readiness-scan` | domain QA/scans/CodeScene |
| PR-close | `pr-close` | three fixed read-only contracts |
| formal review | `mpr` formal-PR | fresh/evidence/domain/adjudication lanes |
| staging merge | `pr-ship` staging mode | deterministic Staging Merge broker + full integration CI |
| final assurance | `full-review` assurance profile | ten PR #3817-style lanes, canonical-doc audit, source-element coverage, fixed synthesizer |
| develop promotion | `pr-ship` promotion mode | Promotion broker, exact-head receipt, merge-commit only |
| post-promotion | `merged` promotion mode | exact-input reconciliation, staging alignment, automatic-CD run correlation |

Workers receive only the owning skill, required support skills/contracts and permitted ZOB mechanisms. Additional skill need is a typed request.

Every attempt records skill/shared-contract/prompt/context versions so model analysis does not blame a model for a changed workflow.