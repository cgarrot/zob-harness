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
- Merge queue candidates/decisions are parent-owned metadata only; approvals mean manual-apply eligible, never auto-applied.
- Rollback metadata required before scaling writes.
