# 09 — Model Routing and Prompt Experiments

**Truth class:** Approved design (pools now evidence-backed from gated capability audit)
**Exact pool state:** Verified 2026-07-18 via bounded Fireconnect/OpenAI capability audit (297 calls, $0.13 metered spend, $5 cap). Only routes that passed their required capabilities on the actual provider path are admitted to pools. Registration alone was not a pass.

## Goals

- remove orchestrator/reviewer bias from known model reputation;
- learn which model/effort/prompt works for each story, gate and task shape;
- preserve reproducibility and exact operational metadata;
- never auto-promote learned policy.

## Blind identity

Mission-visible identities:

```text
agentId       agent-dev-7KQ2
runId         run-01J…
attemptId     H31:G4:T2:A2
assignmentId  assign-V8M4
```

Every attempt gets a new opaque assignment ID. Agents/orchestrator do not receive their own or peers' provider/model/family, thinking, prompt treatment, reputation or stable pseudonym.

The human Models view and protected telemetry resolve:

```text
assignmentId → provider route + model/version + actual thinking + prompt variant
```

Launcher/tool/session/process metadata must be sanitized/denied so model identity is not leaked through CLI arguments, logs, session files or process inspection.

## Provider surface (verified)

| Provider id | Auth mode | Endpoint | Observed status |
|---|---|---|---|
| `fireworks` | API key (macOS Keychain + environment, wired by `fireconnect` CLI v0.8.0) | `https://api.fireworks.ai/inference/v1` (OpenAI-compatible) | active, Pi `[on]`, signed in |
| `openai-codex` | Codex OAuth (built-in) | Pi CLI `--model openai-codex/<id>:<thinking>` | active |

**Fireconnect** is the Fireworks CLI tool (`~/.local/bin/fireconnect`, v0.8.0) that wires Pi (and other harnesses) to Fireworks' OpenAI-compatible endpoint. It is not a separate provider; in Pi it surfaces as the `fireworks` provider. No credential or base URL is stored in this repository.

## Verified route registry

Fireworks routes below passed a bounded 11-test capability battery (inference, message roles, JSON, tool-call, tool continuation, streaming, thinking low/high, context probe, cancellation, quality fixture) on the actual provider path. OpenAI Codex routes passed the reduced Pi-CLI battery documented below: inference, low/high thinking, fresh-session startup, and the quality fixture. OpenAI raw JSON mode, tool-call wire format, message-role compatibility, and streaming event order remain unverified. Cost is per million tokens (in/out) at Fireworks standard serverless pricing. OpenAI Codex routes are subscription-priced (no metered cost observed).

### OpenAI Codex (fixed/stable roles)

| Route | Thinking | Context | Quality fixture | Role |
|---|---|---|---|---|
| `openai-codex/gpt-5.6-sol` | ✓ pi :low/:high | 372K | ✓ `def add` | orchestrator, adjudicator, synthesizer |
| `openai-codex/gpt-5.6-terra` | ✓ pi :low/:high | 372K | ✓ `def add` | worker, review, docs |
| `openai-codex/gpt-5.6-luna` | ✓ pi :low/:high | 372K | ✓ `def add` | worker, docs |

OpenAI JSON mode / raw tool-call format / streaming event order not tested via pi CLI (pi wraps calls). These dimensions remain unverified, not failed.

### Fireworks (via Fireconnect) — verified routes

| Route | Family | Think fmt | Think diff? | Avg lat | $/M in/out | Vision | Roles |
|---|---|---|---|---|---|---|---|
| `accounts/fireworks/models/deepseek-v4-flash` | DeepSeek | budget_tokens | ✓ | 2.3s | $0.14/$0.28 | no | sys+dev+user |
| `accounts/fireworks/models/deepseek-v4-pro` | DeepSeek | budget_tokens | ✓ | 3.5s | $1.74/$3.48 | no | sys+dev+user |
| `accounts/fireworks/models/glm-5p2` | GLM | budget_tokens | ⚠ advisory | 6.2s | $1.40/$4.40 | no | sys+dev+user |
| `accounts/fireworks/models/glm-5p1` | GLM | budget_tokens | ⚠ advisory | 4.6s | $1.40/$4.40 | no | sys+dev+user |
| `accounts/fireworks/models/gpt-oss-120b` | GPT-OSS | reasoning_effort | ✓ (135→510) | 1.7s | $0.15/$0.60 | no | sys+dev+user |
| `accounts/fireworks/models/kimi-k2p7-code` | Kimi | budget_tokens | ✓ | 1.6s | $0.95/$4.00 | yes | sys+dev+user |
| `accounts/fireworks/models/kimi-k2p6` | Kimi | budget_tokens | ✓ | 2.6s | $0.95/$4.00 | yes | sys+dev+user |
| `accounts/fireworks/models/minimax-m3` | MiniMax | budget_tokens | ✓ | 2.4s | $0.30/$1.20 | no | sys+dev+user |
| `accounts/fireworks/models/minimax-m2p7` | MiniMax | reasoning_effort | ✓ | 1.4s | $0.30/$1.20 | no | sys+dev+user |
| `accounts/fireworks/models/qwen3p7-plus` | Qwen | budget_tokens | ⚠ advisory | 1.3s | $0.40/$1.60 | yes | sys+user only ‡ |
| `accounts/fireworks/models/nemotron-3-ultra-nvfp4` | Nemotron | budget_tokens | ✓ | ~20s | free/preview | no | sys+dev+user |
| `accounts/fireworks/routers/glm-5p2-fast` | GLM | budget_tokens | ⚠ advisory | 1.3s | $2.10/$6.60 | no | sys+dev+user |
| `accounts/fireworks/routers/glm-fast-latest` | GLM | budget_tokens | ⚠ advisory | 1.3s | $2.10/$6.60 | no | sys+dev+user |
| `accounts/fireworks/routers/glm-latest` | GLM | budget_tokens | ⚠ advisory | 4.6s | $1.40/$4.40 | no | sys+dev+user |
| `accounts/fireworks/routers/kimi-k2p7-code-fast` | Kimi | budget_tokens | ✓ | 1.2s | $1.90/$8.00 | yes | sys+dev+user |
| `accounts/fireworks/routers/kimi-latest` | Kimi | budget_tokens | ✓ | 1.4s | $0.95/$4.00 | yes | sys+dev+user |
| `accounts/fireworks/routers/kimi-k2p6-turbo` | Kimi | budget_tokens | ✓ | 1.6s | $2.00/$8.00 | yes | sys+dev+user |

‡ qwen3p7-plus rejects the `developer` role (error 1010); uses `system`+`user` only. All other capabilities pass.

**Invalid id (excluded):** `accounts/fireworks/models/glm-latest` returns NOT_FOUND — only the router `accounts/fireworks/routers/glm-latest` is valid.

### Thinking format adapter (required)

ZOB routing must apply a per-model thinking control format:

- **`reasoning_effort` enum** (`low`/`medium`/`high`): gpt-oss-120b, minimax-m2p7
- **`thinking.budget_tokens`** (token budget): kimi, deepseek, minimax-m3, nemotron
- **`thinking.budget_tokens` advisory**: glm, qwen (accepted without error but does not visibly clamp reasoning output at fixture size; the thinking ladder is unproven to scale cost/depth for these families)

An unapproved provider clamp is a capability mismatch, not a successful rung. Requested and actual levels are both recorded.

### Role-format adapter (required)

qwen3p7-plus requires `system`+`user` message roles only. The ZOB prompt compiler must emit system-role instructions for qwen routes, not developer-role. All other verified routes accept `system`+`developer`+`user`.

## Role pools

### Fixed/stable

- **orchestrator-model alias** → `openai-codex/gpt-5.6-sol`
- **three Sol-high PR-close tasks** → `openai-codex/gpt-5.6-sol` at high thinking
- **formal review adjudicator** → `openai-codex/gpt-5.6-sol` at high thinking
- **final repository-assurance synthesizer/adjudicator** → `openai-codex/gpt-5.6-sol` at high thinking
- **optional promotion blocker analyst** → `openai-codex/gpt-5.6-sol` at high thinking

### Randomized pools (shuffled per mission with the model-order seed)

**Development (workers):**

```text
accounts/fireworks/models/kimi-k2p7-code
accounts/fireworks/models/deepseek-v4-pro
accounts/fireworks/models/gpt-oss-120b
accounts/fireworks/models/kimi-k2p6
accounts/fireworks/models/minimax-m3
accounts/fireworks/models/deepseek-v4-flash
accounts/fireworks/models/glm-5p2
openai-codex/gpt-5.6-terra
openai-codex/gpt-5.6-luna
```

**QA:**

```text
accounts/fireworks/models/qwen3p7-plus
accounts/fireworks/models/minimax-m2p7
accounts/fireworks/models/nemotron-3-ultra-nvfp4
accounts/fireworks/models/glm-5p1
accounts/fireworks/models/deepseek-v4-flash
accounts/fireworks/models/gpt-oss-120b
```

**Documentation:**

```text
accounts/fireworks/models/kimi-k2p7-code
accounts/fireworks/models/deepseek-v4-pro
accounts/fireworks/models/glm-5p2
accounts/fireworks/models/minimax-m3
accounts/fireworks/models/qwen3p7-plus
openai-codex/gpt-5.6-terra
```

**Internal task review:**

```text
accounts/fireworks/models/deepseek-v4-pro
accounts/fireworks/models/glm-5p2
accounts/fireworks/models/kimi-k2p6
accounts/fireworks/models/minimax-m3
accounts/fireworks/models/qwen3p7-plus
accounts/fireworks/models/nemotron-3-ultra-nvfp4
```

**Formal blind-review:**

```text
accounts/fireworks/models/deepseek-v4-pro
accounts/fireworks/models/glm-5p2
accounts/fireworks/models/qwen3p7-plus
accounts/fireworks/models/minimax-m3
accounts/fireworks/models/nemotron-3-ultra-nvfp4
openai-codex/gpt-5.6-terra
```

**Final repository-assurance:**

```text
accounts/fireworks/models/deepseek-v4-pro
accounts/fireworks/models/glm-5p2
accounts/fireworks/models/kimi-k2p7-code
accounts/fireworks/models/qwen3p7-plus
accounts/fireworks/models/minimax-m3
accounts/fireworks/models/nemotron-3-ultra-nvfp4
```

### Router aliases (reserve)

Router aliases are held in reserve as speed/cost alternatives. They share a family with their base model and do not add family diversity. They may be swapped into a pool when latency or cost pressure justifies it, subject to the same capability requirements:

```text
accounts/fireworks/routers/glm-5p2-fast
accounts/fireworks/routers/glm-fast-latest
accounts/fireworks/routers/glm-latest
accounts/fireworks/routers/kimi-k2p7-code-fast
accounts/fireworks/routers/kimi-latest
accounts/fireworks/routers/kimi-k2p6-turbo
```

### Pool composition rationale

- **Development** is the broadest pool (9 routes) — all capable coding models, shuffled randomly.
- **QA, internal review, formal blind-review** are built for family diversity away from the Kimi/DeepSeek-heavy worker pool, per the independence rule.
- **Formal blind-review** excludes Kimi (the main worker family) to maximize review independence; DeepSeek, GLM, Qwen, MiniMax, Nemotron, and OpenAI provide six independent families.
- **Repository-assurance** spans six families to satisfy the ≥3-family requirement with maximum margin.

## Registry snapshot

At mission admission snapshot:

- provider/model route and underlying family;
- adapter/version and API family;
- auth mode only;
- availability/capability test time;
- reasoning and supported thinking levels (with format: `budget_tokens` or `reasoning_effort`);
- modalities/tool support;
- context/max output;
- cost schedule;
- compatibility flags (role format, thinking advisory);
- config hash.

No credential/base URL/private body is stored.

Equivalent underlying models through different providers are distinct routes for reliability/cost analysis but share a family for independence.

## Selection

1. Apply hard eligibility: role membership, availability, modality, tools, context, privacy, budget, provider policy, never-use and capability requirements.
2. Generate a cryptographically random private task seed, then derive domain-separated `model-order` and `prompt-treatment` seeds (for example HKDF with those exact info labels). Persist commitments and the protected seeds in telemetry; never expose them to agent contexts.
3. Uniform Fisher–Yates shuffle eligible routes with the `model-order` seed.
4. Freeze pool/order per mission/task and persist privately.
5. Use Fleet/task labels only for hard eligibility in the initial unbiased baseline—not preference.

## Thinking ladder

Minimum `low`:

```text
low → medium → high → xhigh → max
```

Skip unsupported holes; never silently clamp. Pi's `off` and `minimal` levels are below the ZOB quality minimum and are ineligible for reasoning ladders. A verified non-reasoning model gets one ZOB `default` rung, mapped to the provider's ordinary non-reasoning mode. Requested and actual levels are both recorded; an unapproved provider clamp is a capability mismatch, not a successful rung.

The thinking format adapter (above) must be applied before requesting a rung: `reasoning_effort` enum routes receive `low`/`medium`/`high` mapped to those enum values; `budget_tokens` routes receive the configured token budget for each rung. GLM and qwen budgets are advisory — the rung is still requested and recorded, but the supervisor notes `advisory_thinking=true` for cost analysis.

Qualifying model/quality failure advances the same model. Provider, rate, tool, permission, human, cancellation and environment failures do not consume quality rungs. Context overflow/output-budget defects receive their own recovery/classification.

All-model exhaustion creates needs-human. It should be rare, but is never hidden.

## Independence

For QA/formal review:

1. prefer a different provider/model family from implementation and peer lanes;
2. otherwise require a different exact model when possible;
3. same model is a visible degraded fallback;
4. critical policy may require human/additional review when independence degrades.

The supervisor enforces this privately; reviewers do not learn what was excluded.

## Prompt experiment design

Existing Wheel model lab evidence already includes:

- `analysis.promptShapes[model][task]`;
- per-model/task prompt guidance;
- strongest templates and combo exceptions;
- prompt feature counts;
- `gates-bakeoff.ts` shared/common+rider/per-model modes;
- declared but not yet implemented `fleet-bakeoff` optimized/both modes.

This becomes the seed catalog, not automatic truth.

### Assignment

- 50% uniform control;
- 50% vetted candidate variants;
- prompt treatment uses the domain-separated `prompt-treatment` seed, never the model-order RNG stream;
- prompt variant fixed across one model's thinking ladder;
- candidate exhaustion receives bounded same-model control rescue;
- fixed orchestrator/close/adjudication prompts do not experiment initially.

Formal review and final repository assurance always retain required stable control coverage. Experimental shadows may find validated blockers but cannot clear a PR or staging candidate alone. Assurance uses at least three eligible model families where available. If fewer than three are eligible, the result must record `degraded=true` plus a reason hash and apply the configured human/no-ship policy; it cannot report undegraded independence.

### Prompt metadata

- template/variant IDs and versions;
- mode uses the schema tokens: `uniform-control`, `shared-candidate`, `model-candidate`, `approved-optimized`;
- `uniform-control` is the permanent control; shared/model candidates are the experimental 50%; approved-optimized is available only after human promotion;
- compiler/prompt/context/task hashes;
- features: length, headings, bullets, numbered constraints, examples, code blocks, imperatives, output contract, ordering, verbosity target;
- prompt-builder identity/version when generated.

Prompt text does not name model/treatment. Raw compiled prompts do not enter committed story evidence.

## Attempt outcome and failure taxonomy

Lifecycle states live in section 06. Protected terminal attempt `outcome` is exactly `accepted`, `rejected`, `failed`, `blocked`, `cancelled`, `lost` or `superseded`. A `rejected` attempt may return the task to `ready`; `blocked` closes the worker and records what dependency/human input is required. `failureClass` explains why and does not create another lifecycle vocabulary.

```text
none
provider_transient
provider_unavailable
rate_limit
capability_mismatch
context_overflow
output_budget
tool_environment
permission_denied
human_blocked
cancelled
prompt_candidate_failure
model_quality_failure
validation_failure
review_rejection
integration_regression
ci_regression
policy_violation
```

`none` is the sentinel for a non-failed terminal outcome. The other tokens classify failure/block/rejection causes; they do not replace `outcome`.

Later attributable task defects resume private lineage/next rung. Cross-task defects get a new shuffled repair task while preserving attribution.

## Protected telemetry

`zob-model-telemetry` stores compact exact mappings/outcomes at milestones:

```text
telemetry/<mission-id>/
  assignments.jsonl
  prompt-assignments.jsonl
  outcomes.jsonl
  summary.json
```

Story branches/checkpoints use opaque IDs. Worker/reviewer contexts cannot read telemetry or run unscoped `gh`, process-list or session-inspection commands.

## Analysis

Segment by:

- story/gate/task labels and role;
- model route/family/version;
- thinking rung (with format and advisory flag);
- prompt/template/features;
- skill/shared-contract/prompt compiler/context versions;
- first-pass acceptance;
- defects/misses/false positives/repair burden;
- latency/tokens/cost/provider reliability.

Recommendations include uncertainty/sample sufficiency and require human approval. No runtime self-modifies routing or prompt policy.

## Provider audit (completed 2026-07-18)

The gated provider capability audit was run under explicit human spend approval ($5.00 cap, $0.13 actual metered spend, 297 calls, bounded deterministic fixtures, no production/app calls).

### What was tested

For every Fireworks route: inference, system/developer/user message compatibility, JSON structured output, tool-call request, tool-result continuation, streaming event order, thinking low + high (with format auto-detection), context probe (6K), cancellation/timeout, and a deterministic coding quality fixture (`def add`).

For OpenAI Codex routes: inference at low + high thinking, quality fixture, and fresh-session launch through Pi (reduced battery — pi CLI wraps JSON/tool/streaming dimensions).

### What was verified

- exact provider ids, route ids, model ids and families (see registry above);
- registration visibility versus authenticated inference (all verified routes produced real responses);
- thinking levels and clamp/mismatch — two formats identified (`reasoning_effort` enum, `budget_tokens`); GLM/qwen advisory;
- system/developer/user compatibility — qwen rejects developer role;
- structured output / JSON adherence;
- tool-call request and continuation;
- streaming event order and usage;
- cancellation/timeout behavior;
- context-window behavior (bounded 6K fixture);
- provider error classification (NOT_FOUND, 1010, invalid_request);
- fresh-session launch (OpenAI via pi CLI);
- token and cost reporting;
- model identity leakage (none observed at fixture scope).

### What remains unverified or out of scope

- OpenAI JSON mode / raw tool-call format / streaming event order (pi CLI wraps these);
- encrypted transcript/redaction posture (out of scope for fixture testing);
- same-model-family equivalence across provider routes (not applicable — all routes are single-provider);
- larger reasoning fixtures to confirm GLM/qwen thinking budgets actually clamp.

### Evidence

```text
reports/fireconnect-capability-tests/MATRIX.md
reports/fireconnect-capability-tests/results.json
reports/fireconnect-capability-tests/results_v2.json
reports/fireconnect-capability-tests/fw_test.py
reports/fireconnect-capability-tests/fw_test2.py
```

Only verified routes enter pools. `Sol-high` fixed aliases are now resolved to `openai-codex/gpt-5.6-sol` at high thinking.
