# 06 — Mission Control TUI

**Truth class:** Approved design

## Surfaces

- **Compact HUD:** persistent Pi widget with mission/story progress, active/blocked counts, watcher freshness and urgent human item.
- **Full Mission Control:** focused Pi overlay connected to `zobd` over a local Unix socket.

One story defaults to Story Cockpit. Several stories default to Mission Overview. The TUI is a projection of the event ledger and external reconciliation; it never manufactures status from prose.

## Status truth

Canonical mission status is the `mission.schema.json` vocabulary: `admitting`, `active`, `paused`, `needs-human`, `recovery-blocked`, `complete`, `failed`, `cancelled`.

Canonical task status is: `planned`, `ready`, `blocked`, `delegated`, `in-progress`, `claim-returned`, `needs-review`, `accepted`, `failed`, `cancelled`, `superseded`. Task `in-progress` is the projection that it owns a non-terminal active attempt (for example `launching`, `running`, `validating` or `needs-review`); it is not another name for attempt `running`.

Canonical attempt status is: `dispatch-reserved`, `launching`, `running`, `claim-returned`, `validating`, `needs-review`, `accepted`, `rejected`, `blocked`, `failed`, `lost`, `cancelled`, `superseded`. `dispatched` is UI shorthand for `dispatch-reserved`; it is never shown as `running`. Preflight, process-started and agent-acknowledged are events that cause transitions, not additional statuses. The protected model-attempt `outcome` is the terminal subset `accepted|rejected|failed|blocked|cancelled|lost|superseded`.

Separate orthogonal clocks/flags:

- heartbeat — process/session liveness;
- activity — new stream/tool event;
- progress — accepted task/evidence transition;
- external freshness — age of Git/worktree/GitHub/CI/human watcher data;
- stale — derived health flag attached to the affected source/clock, never a lifecycle status;
- waiting — a queue/watcher condition with an explicit reason, never an active worker status (human waits close the worker and block the task).

“Working” begins only after process start and agent acknowledgement. Every visible state includes exact timestamp/age. Unavailable watchers turn dependent facts `unknown/stale`; a prior green state is not displayed as current.

## Core views

### Mission Overview

- overall accepted weighted progress;
- stories sorted by criticality/urgency with starvation protection;
- gate, task, CI, human and dependency state;
- concurrency/budget use;
- supervisor and watcher freshness;
- latest alerts and next safe action.

### Story Cockpit

- branch, worktree, draft PR, base/head;
- active manifest revision/profile/overlays;
- gate-first task tree;
- accepted versus claimed progress;
- dependencies/stacks;
- QA/CI/evidence/review status;
- live selected output.

### Task/Attempt Inspector

- task contract ref/hash and labels;
- dependencies and acceptance criteria;
- owned/read paths and capability grant;
- attempts, opaque assignments, failure classes and ladder state;
- validation/evidence refs;
- transcript replay controls;
- split/repair/review lineage.

### Agents

Show active and recently completed rows:

```text
agent alias | role | story/task | status | started | activity age | progress age | user-visible model*
```

`*` Exact model/thinking is visible only to the human/supervisor. Agents and orchestrator receive opaque IDs.

Selected row always shows live output. Structured events remain authoritative if output claims something contradictory.

### Needs You

- canonical card ID/type/priority;
- affected mission/story/task;
- exact decision and proposed answer;
- blocked work and remaining productive work;
- receipt/expiry/conflict state;
- selectable low-risk batch answers;
- separate high-risk ACK, override, takeover, promotion-window and promotion-merge authorization forms.

High-risk receipts cannot be accepted through generic batch response controls. Starting a promotion window freezes unrelated merges at the initial candidate and exposes only finding-bound repair descendants; it does not authorize the later develop merge. Promotion-merge authorization has its own final-candidate exact-head UI after assurance and CI pass.

### CI

- PR/head and draft/ready phase;
- expected versus observed check set;
- status, conclusion, run URL, age;
- flake classification and rerun count;
- stale/superseded checks;
- profile-gated deferred ready-only checks;
- exact `develop-staging` integration and promotion-PR full-CI views.

### Staging and Promotion

- ordinary PR queue and Staging Merge Gate readiness;
- current `develop-staging` SHA, green/red/unknown integration state and deployment-disabled proof;
- staged PR/story set since the prior promotion;
- promotion-window receipt/freeze/expiry/abandon state;
- initial staging SHA, current candidate revision/SHA, authorized repair lineage and unrelated-merge queue;
- assurance round (1–3), remaining automatic repair transitions (2→0), ten lane dispositions and live selected lane;
- top-down document verdict counts (`CURRENT`, `EVIDENCE-BOUND`, `STALE`, `PENDING`);
- bottom-up element coverage/disposition counts and missing public documentation;
- repair PRs, full-CI reruns and invalidated rounds;
- promotion PR, audited staging SHA, current develop base, merge-commit relation and automatic-CD impact;
- separate Staging Merge App and Promotion App state/permissions;
- post-promotion reconciliation, staging fast-forward, aligned-head integration CI and queue unfreeze.

### Evidence

- task/gate/PR-close/review/staging-integration/repository-assurance/promotion artifacts;
- issuer, schema/policy version and source binding;
- current/stale/invalid cause;
- GitHub Check/comment/branch artifact refs;
- no raw transcript bodies.

### Models

Human-only exact view:

- role pool snapshot and shuffled order;
- provider route/family/model/version;
- requested/actual thinking;
- prompt control/candidate assignment;
- usage/cost/outcome/failure class;
- independence degradation;
- provider health.

Agents never receive this projection.

### Timeline

Append-only event timeline with filters by story/task/attempt/type/severity. Shows causation/correlation, external observations, mutations, retries, invalidations, human receipts and recovery events. Raw transcript replay is separate and access-audited.

### Permissions

- role defaults;
- task/attempt grants and denials;
- pending expansion requests;
- GitHub mutation broker decisions;
- App identity used (Builder, Reviewer, Staging Merge or Promotion);
- ACK/override/promotion-window/promotion-merge receipt scope.

### Workspaces/Merge Queue

- canonical worktrees, sandboxes and path leases;
- claimant/expiry/conflict;
- merge candidates, validation and parent decision;
- dirty/contaminated paths;
- stack/dependency order.

### Settings

Read-only active policy versions and typed controls for permitted mission-local overrides. No credential values.

## Controls

Minimum keys:

```text
↑/↓ or j/k   move
Enter        open
Esc          back
/            search
f            filters
l            live-output focus
r            reconcile/refresh request
p            pause/resume menu
x            typed action palette
?            help
```

Actions are typed: pause, resume, retry, cancel attempt, request context, request oracle, approve/reject merge candidate, answer card, acknowledge receipt, start/abandon a promotion window, and authorize one exact-head audited promotion merge. Ordinary staging merges are mechanical and have no human batch form. Arbitrary command execution is not a TUI feature.

Irreversible/high-risk actions show exact scope/consequences and require typed confirmation/receipt. Data changing while a confirmation is open invalidates the stale form.

## Alerts

- in-TUI banner and sticky HUD;
- terminal bell for urgent items;
- never steal input focus;
- alert deduplication and acknowledgement state;
- future external notification adapter is enhancement-gated.

## Search/filter

Search story, task, PR, branch, finding, check, card and event IDs. Filters include status, risk, profile, factory, agent, model (human only), stale source and time window.

## Responsive behavior

- `<80 columns`: one pane, abbreviated IDs/status, detail replaces list.
- `80–119`: list + selected detail; live output toggles full width.
- `≥120`: list, detail and live output side-by-side.

No essential fact depends solely on color. Use text/symbol/state labels; support keyboard-only operation.

## Disconnect behavior

If `zobd` is unreachable, display `supervisor disconnected` with last projection time. Do not animate agents or advance progress from cache. Reattach triggers full reconciliation.