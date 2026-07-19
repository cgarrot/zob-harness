# Next Session Handoff — ZOB Consolidation + Fireconnect Model Qualification

**Prepared:** 2026-07-18
**Resume worktree:** `/Users/alexandracohen/codebase/zob-harness-worktrees/wheel-zob-system-docs`
**Branch:** `docs/wheel-zob-system`
**Base / current HEAD:** `657f470b3a5fcdb594fa1e746f58e186383567d4` (`origin/main` at worktree creation)
**Session stop reason:** Pi must restart so **Fireconnect** becomes visible before the model/provider architecture is redone.

## Human decisions made

1. The complete Wheel ZOB system—generic runtime plus bounded Wheel AgentOps pack, documentation, schemas, installation, factories, decisions, enhancements and user manual—must be consolidated in the **ZOB repository**.
2. Do **not** put this work into the existing dirty `execution-observability` worktree. Use the clean `wheel-zob-system-docs` worktree above.
3. The model/provider design must be redone around **OpenAI and Fireworks through Fireconnect**.
4. Exact models and capability tests must be discussed and verified; they must not remain a vague deferred placeholder.
5. Stop this session before provider/auth/live inference work. Restart Pi first so Fireconnect can register/show up.

## What existed before consolidation

The complete documentation suite was first authored in:

```text
/Users/alexandracohen/codebase/jointhewheel-docs-tools-zob-system
branch: docs/zob-system-architecture
base: 443af1b48b35
```

That authoring copy contains the full Story → PR-Close → Blind Review → non-deploying `develop-staging` → Final Repository Assurance → merge-commit Promotion → automatic-CD design.

Original pre-consolidation validation evidence:

- 66-file frozen source boundary;
- 19 Draft 2020-12 schemas;
- 21 examples;
- 26 negative guards;
- 121 original decisions;
- 37 enhancements;
- both Python validators passed;
- both validators received CodeScene 10.0;
- four fresh audit lanes passed with `no_ship=false`;
- final independent oracle returned PASS/HIGH and `no_ship=false`.

Original frozen manifest:

```text
docs/zob/reviews/staging-design-2026-07-18/round-2/SCOPE_MANIFEST.json
sha256: 786bce2b809c62f135fbe4e15050cba4aabacfcfb80341377178a1064238ba76
```

**Important:** that audit is historical evidence for the old repository boundary. It does not validate the new ZOB root files, consolidation decision, HTML manual, Fireconnect design or future regenerated manifest.

## Work completed in the clean ZOB worktree

### 1. Clean worktree created

```text
/Users/alexandracohen/codebase/zob-harness-worktrees/wheel-zob-system-docs
branch: docs/wheel-zob-system
base: origin/main @ 657f470b3a5fcdb594fa1e746f58e186383567d4
```

The separate worktree `/Users/alexandracohen/codebase/zob-harness-worktrees/execution-observability` was not modified, reset, rebased, checked out or cleaned. Its preserved state remains:

```text
branch: feature/execution-observability-v016
HEAD: 657f470b3a5fcdb594fa1e746f58e186383567d4
22 tracked modified paths
10 untracked paths
32 dirty paths total
```

### 2. Documentation copied

All 88 files under the docs-tools `docs/zob/` source were copied and SHA-256 compared into the clean ZOB worktree. Copy verification returned:

```text
ZOB_DOCS_COPY_PASS files=88
```

The new HTML manual makes the current count 89 files under `docs/zob/`.

### 3. ZOB now tracks the consolidated docs path

Changed `.gitignore` so `docs/zob/**` is tracked while other local captured planning areas remain ignored.

### 4. Repository ownership partially reconciled

Changed these files:

- `.gitignore`
- `AGENTS.md`
- `README.md`
- `docs/zob/01-SYSTEM_OVERVIEW.md`
- `docs/zob/02-ARCHITECTURE_AND_OWNERSHIP.md`
- `docs/zob/10-EXECUTION_PROFILES_AND_SKILLS.md`
- `docs/zob/12-INSTALLATION.md`
- `docs/zob/14-VALIDATION_AND_PILOTS.md`
- `docs/zob/16-DECISIONS.md`
- `docs/zob/SOURCE_EVIDENCE.md`
- `docs/zob/README.md`

Key change: `ZOB-D-122` now records that `zob-harness` is canonical for generic runtime plus the bounded Wheel AgentOps pack/specification, while `jointhewheel` retains application-specific adapters and integration. The generic runtime still must not import or hard-code Wheel policy; consolidation changes repository placement, not dependency direction.

The docs-tools authoring copy remains preserved and uncommitted. Do not delete it without a separate explicit cleanup decision.

### 5. Interactive HTML terminal manual drafted

Created:

```text
docs/zob/WHEEL_ZOB_TERMINAL_MANUAL.html
~66 KB, standalone HTML/CSS/JS, no network calls
```

The draft includes:

- exact current wide-widget labels from `runtime/widget.ts`;
- interactive Idle / Goal running / Needs human / Review blocked / Promotion-freeze fixture states;
- field inspector for Mission, Progress, Next, Need, Daemon, Context, ZPeer, Focus, Review, Quality and Assistants;
- safe first-session workflow;
- seven ZOB/Pi modes;
- searchable table of all 27 registered slash commands;
- 81-tool family summary;
- current mechanisms versus specified/disabled Wheel factories;
- Story → Blind Review → Staging → Assurance → Promotion → automatic-CD lifecycle;
- authority matrix for source edits, claims, commits, promotion, deployment and secrets;
- responsive behavior, visible focus states and reduced-motion handling;
- Wheel Black Fig / Verdigris / Porcelain product tokens.

**Not yet done:** the manual has not been HTML/a11y reviewed and does not yet include the required Fireconnect/model roster and capability-test experience.

## Model/provider facts discovered before stopping

### Current repository configuration—not yet Fireconnect-qualified

The active Wheel model registry currently names only two providers:

1. `openai-codex` — built-in Codex OAuth;
2. `fireworks` — API-key OpenAI-compatible provider.

Current `.pi/settings.json`:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "openai-codex/gpt-5.6-sol",
  "enabledModels": ["openai-codex/gpt-5.6-*", "fireworks/**"]
}
```

Current curated 12-model registry:

| Provider | Model alias | Concrete/provider model | Tier | Existing listed role |
|---|---|---|---|---|
| OpenAI Codex OAuth | `gpt-5.6-sol` | `gpt-5.6-sol` | frontier | worker, orchestrator |
| OpenAI Codex OAuth | `gpt-5.6-terra` | `gpt-5.6-terra` | workhorse | worker |
| OpenAI Codex OAuth | `gpt-5.6-luna` | `gpt-5.6-luna` | volume | worker |
| Fireworks | `glm-5.2` | `accounts/fireworks/models/glm-5p2` | frontier | worker, orchestrator |
| Fireworks | `kimi-k2.7-code` | `accounts/fireworks/models/kimi-k2p7-code` | frontier | worker |
| Fireworks | `kimi-k2.6` | `accounts/fireworks/models/kimi-k2p6` | workhorse | worker |
| Fireworks | `deepseek-v4-pro` | `accounts/fireworks/models/deepseek-v4-pro` | frontier | worker |
| Fireworks | `deepseek-v4-flash` | `accounts/fireworks/models/deepseek-v4-flash` | volume | worker |
| Fireworks | `minimax-m3` | `accounts/fireworks/models/minimax-m3` | workhorse | worker |
| Fireworks | `minimax-m2.7` | `accounts/fireworks/models/minimax-m2p7` | workhorse | worker |
| Fireworks | `qwen-3.7-plus` | `accounts/fireworks/models/qwen3p7-plus` | workhorse | worker |
| Fireworks | `gpt-oss-120b` | `accounts/fireworks/models/gpt-oss-120b` | volume | worker |

Existing fleet instructions say:

- Fireworks GLM-5.2 starts worker supervisors;
- OpenAI Codex GPT-5.6 Sol at low thinking starts reviewer and ship supervisors;
- per-story routing manifest remains authoritative for worker/escalation/thinking.

### Critical gap

`docs/zob/09-MODEL_AND_PROMPT_EXPERIMENTS.md` currently says exact IDs will be filled after “`fireconnect` and OpenAI OAuth capability tests,” but a repository search found no implemented `fireconnect` identifier. Existing source/config uses direct provider id `fireworks` and a `fireworks-provider` setup path.

The human clarified that this must be **redone through Fireconnect** after Pi restart. Therefore:

- do not treat the direct `fireworks` registry as final authority;
- do not silently rename Fireconnect to Fireworks;
- do not run live prompts before Fireconnect’s actual provider id/API/auth/model surface is observed;
- do not read or print credentials;
- do not infer that registration proves inference, tool use, thinking support, streaming, cancellation, cost or blindness.

### Reload/visibility observation

A later `/reload` was followed by non-inference CLI visibility checks:

```text
pi --list-models fireconnect
→ No models matching "fireconnect"

pi --list-models fireworks
→ direct `fireworks` catalog remains visible
```

The visible direct Fireworks catalog included the candidate model families plus additional models/routers such as GLM-5.1, GPT-OSS 20B and `*-fast`/`*-latest` router aliases. No installed extension/package path containing `fireconnect` or `fireworks` was found under the bounded extension/package-name scan. Therefore `/reload` did **not** prove Fireconnect was installed or registered. A full Pi process restart may still be required; if Fireconnect remains absent after restart, verify its package/extension registration with the human rather than falling back silently to direct Fireworks.

### No provider inference test happened in this session

No Fireconnect/Fireworks/OpenAI live inference or capability call was made. Model listing only inspected registration visibility. No credential file was read. No key was printed. No provider spend was authorized or incurred by this work. No provider/model was activated for ZOB routing.

## Current git state

Clean consolidation worktree currently reports:

```text
 M .gitignore
 M AGENTS.md
 M README.md
?? docs/
```

Nothing is staged or committed. No push or PR exists for this branch.

The docs-tools authoring copy still reports:

```text
?? AGENTS.md
?? README.md
?? docs/
```

The old execution-observability worktree remains 32 paths dirty as recorded above.

## Work that is deliberately incomplete

1. Fireconnect registration/identity has not been observed after restart.
2. Exact OpenAI + Fireworks-through-Fireconnect roster is not ratified.
3. No live model capability matrix exists.
4. No provider spend cap has been authorized for inference testing.
5. `09-MODEL_AND_PROMPT_EXPERIMENTS.md` still needs a full rewrite after Fireconnect evidence.
6. Installation/provider sections, schemas/examples and decision record may need Fireconnect-specific updates.
7. The HTML manual needs an interactive Models & Testing section.
8. `validate_documentation.py` still expects exactly decisions 001–121; it must be updated for D-122 and any new model decision(s).
9. The copied old scope manifest is stale for the consolidated location and changed root files.
10. Historical review reports must remain immutable and be labeled pre-consolidation; a new consolidated-scope audit is required.
11. No HTML/accessibility, CodeScene, full validation or independent oracle has run on this branch.
12. No source cleanup in docs-tools is authorized yet.

## Required first actions after Pi restart

1. `cd /Users/alexandracohen/codebase/zob-harness-worktrees/wheel-zob-system-docs`
2. Read this handoff and `AGENTS.md`.
3. Run `git status --short`; confirm only the intended consolidation paths are dirty.
4. Verify that Fireconnect now appears in Pi using **non-secret registration/model visibility only**.
5. Record the exact observed Fireconnect provider id, adapter/API shape, model ids, thinking controls and auth mode without reading or printing any secret.
6. Compare Fireconnect’s observed model surface with the 12-model candidate table above.
7. Present the human with:
   - models observed;
   - models missing/new;
   - proposed role pools;
   - proposed thinking ladders;
   - capability-test cases;
   - estimated call count and maximum spend.
8. Obtain explicit human approval before any paid/live inference test.

## Required Fireconnect capability matrix

For every candidate route admitted to a ZOB pool, test and record:

- exact provider id, route id, model id/version and underlying family;
- registration visibility versus actual authenticated inference;
- supported thinking/reasoning levels and any clamp/mismatch;
- system/developer/user message compatibility;
- structured output/JSON adherence;
- tool-call request, tool result continuation and multi-tool behavior;
- streaming event order and final usage accounting;
- cancellation and timeout behavior;
- context-window and output-limit behavior using bounded fixtures;
- provider transient/rate-limit/auth/capability error classification;
- fresh-session launch through Pi;
- input/output/cache token and cost reporting;
- model identity leakage through command lines, logs, sessions or tool metadata;
- encrypted transcript/redaction posture;
- same-model-family equivalence across provider routes;
- one deterministic quality fixture for the role before pool admission.

Registration alone is not a pass. A route enters a pool only after its required capabilities pass on the actual Fireconnect path. Failed or ambiguous routes remain visible in the human model inventory but ineligible for dispatch.

## Remaining consolidation sequence

After Fireconnect/model decisions:

1. Rewrite `docs/zob/09-MODEL_AND_PROMPT_EXPERIMENTS.md` with exact observed routes and explicit unknowns.
2. Update `12-INSTALLATION.md`, `14-VALIDATION_AND_PILOTS.md`, `16-DECISIONS.md`, `SOURCE_EVIDENCE.md`, schemas/examples and any provider policy references.
3. Add the model roster, role-pool explanation, test matrix, cost boundary and live status labels to `WHEEL_ZOB_TERMINAL_MANUAL.html`.
4. Finish repository-ownership reconciliation and stale docs-tools references.
5. Update validator decision bounds for D-122 plus any new Fireconnect decisions.
6. Add a consolidated-review marker explaining old reports are historical for the pre-move boundary.
7. Regenerate a new exact consolidated source manifest.
8. Run contract/documentation validation, privacy scan and HTML structural checks.
9. Run accessibility review on the standalone HTML.
10. Run CodeScene on changed code/scripts where supported.
11. Dispatch fresh independent documentation, model-policy, operations and HTML/UX audit lanes.
12. Obtain a fresh final oracle PASS/no-ship=false for the new repository boundary.
13. Stop before commit/push/PR unless the human explicitly requests the governed `/zcommit` path.
14. Keep the docs-tools source copy until the ZOB copy is validated and the human separately approves cleanup.

## Paste-ready next-session prompt

```text
Resume the Wheel ZOB consolidation in:
/Users/alexandracohen/codebase/zob-harness-worktrees/wheel-zob-system-docs

Read these first:
1. AGENTS.md
2. NEXT_SESSION_FIRECONNECT_HANDOFF.md
3. docs/zob/09-MODEL_AND_PROMPT_EXPERIMENTS.md
4. docs/zob/02-ARCHITECTURE_AND_OWNERSHIP.md
5. docs/zob/WHEEL_ZOB_TERMINAL_MANUAL.html

The human decision is binding: the complete system belongs in the ZOB repo, and model/provider routing must be redone for OpenAI plus Fireworks through Fireconnect. Pi was restarted so Fireconnect could become visible.

FIRST:
- verify git status and preserve the separate dirty execution-observability worktree;
- verify Fireconnect registration/model visibility without reading or printing credentials;
- identify its exact provider id, adapter/API shape, auth mode, model ids, thinking controls and observed availability;
- compare the observed surface with the 12-model candidate roster in the handoff;
- show the human the proposed exact test matrix, call count and spend cap;
- do not make paid/live inference calls until the human explicitly approves that matrix and cap.

THEN, after approval:
- run bounded Fireconnect/OpenAI capability tests with no production/app calls;
- record exact evidence and failures truthfully;
- rewrite the model/prompt policy, installation, validation plan, decisions, schemas/examples and source evidence;
- add an interactive Models & Testing section to the HTML terminal manual using the Wheel design system;
- finish consolidation, update validators, regenerate the frozen manifest, rerun full validation and fresh independent oracle review.

MUST NOT:
- touch, reset, rebase, checkout or clean the execution-observability worktree;
- delete the docs-tools authoring copy;
- read/print secrets or auth files;
- infer capability from catalog visibility;
- activate routing/providers/Apps/factories;
- commit, push, create a PR, merge, alter branch protection/workflows or deploy without explicit separate authorization.
```

## Safe stopping state

This handoff is the authoritative restart point. The clean ZOB branch contains partial ownership reconciliation and an unvalidated HTML manual. Provider/model work is intentionally blocked on Fireconnect appearing after restart and an explicit human-approved live-test budget.
