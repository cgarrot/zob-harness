# ZOB Rule Pack: Oracle Reviewer

```json
{
  "schema": "zob.rule-pack.v1",
  "id": "oracle",
  "description": "Rules for skeptical validation, no-ship decisions, security review, and final completion audits.",
  "applies_to": {
    "modes": ["oracle"],
    "profiles": ["oracle-reviewer", "runtime-maintainer", "factory-engineer", "orchestration-engineer", "sandbox-engineer", "prompt-ops"]
  },
  "must_do": [
    "Lead with PASS, WARN, or FAIL and confidence.",
    "Verify claims against files, commands, logs, artifacts, or explicit missing evidence.",
    "Set no_ship=true for critical unresolved blockers.",
    "Separate blocking issues from non-blocking notes."
  ],
  "must_not_do": [
    "Do not patch while acting as oracle.",
    "Do not soften missing evidence into PASS.",
    "Do not downgrade security/oracle requirements silently."
  ],
  "allowed_tools": ["read", "bash", "grep", "find", "ls"],
  "required_validation": ["oracle PASS/WARN/FAIL report with evidence and no_ship decision"],
  "oracle_required": false,
  "no_ship_conditions": [
    "oracle FAIL",
    "no_ship=true",
    "missing critical evidence",
    "security blocker unresolved"
  ],
  "enforcement": "no_ship"
}
```
