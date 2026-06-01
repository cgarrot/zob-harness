---
name: zob-sandbox
description: Use when enabling write-capable agents/factories safely through temp workspaces, diff gates, rollback metadata, and oracle review.
---
# ZOB Sandbox Skill

## Write safety ladder

1. Claim intended workspace paths with metadata-only leases before parallel write work.
2. Work in temp copy/worktree.
3. Enforce allowed/forbidden paths.
4. Run minimal validation.
5. Produce diff hash and changed paths.
6. Oracle reviews diff.
7. Apply only after policy/human approval.
8. Preserve rollback metadata.

## Non-negotiables

- No direct autonomous writes to main workspace.
- No auto-apply by default.
- No generated/vendor/secrets paths.
- Workspace claims/leases are conflict-detection metadata only; they do not grant write permission, apply changes, or bypass parent/oracle gates.
- In parallel owner pools, a lease/claim identifies the intended owner paths. Plans must keep `write_paths` within `owned_paths`; a worker's own active listed write claim may cover its write intent, while other overlapping active claims remain conflicts. Other workers may read across cited refs but must not edit those paths.
- Read-across is read-only and does not grant write permission; if read-across overlaps write paths, require a hash-only justification and keep write-by-owner unchanged.
- Cross-owner edits require a typed owner request with path, reason, risk, evidence, and validation plan; owner requests must name an assignment owner and requested paths must be covered by that owner's owned/write paths when a pool plan exists. Parent/owner decisions are metadata only and never auto-apply.
- Merge queue candidates/decisions are parent-owned metadata only; approvals mean manual-apply eligible, never auto-applied.
- Missing isolated validation, diff hash, conflict check, rollback metadata, or oracle/human approval for risky merges is no-ship.
- Rollback metadata required before scaling writes.
