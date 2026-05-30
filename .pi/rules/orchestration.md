# ZOB Rule Pack: Orchestration Engineer

```json
{
  "schema": "zob.rule-pack.v1",
  "id": "orchestration",
  "description": "Rules for teams, orchestration profiles, rooms, local coms, and supervised read-only dispatch.",
  "applies_to": {
    "paths": [
      ".pi/extensions/zob-harness/src/orchestration/**",
      ".pi/extensions/zob-harness/src/topology/**",
      ".pi/teams/**",
      ".pi/orchestrations/**"
    ],
    "profiles": ["orchestration-engineer"]
  },
  "must_do": [
    "Keep parent-owned preflight and dispatch for lead/worker tasks.",
    "Keep worker-spawns-worker disabled unless an explicit future policy gate allows it.",
    "Use hash-only or redacted coms by default.",
    "Write room/context-pack and evidence-index artifacts for orchestration runs."
  ],
  "must_not_do": [
    "Do not build free-form peer chat before audited room/context-pack gates.",
    "Do not enable networked coms in this harness stage.",
    "Do not write DONE.sentinel for plan_only or incomplete supervised_readonly orchestration.",
    "Do not persist plaintext prompt/task/output bodies in coms or room ledgers."
  ],
  "allowed_tools": ["read", "bash", "edit", "write", "grep", "find", "ls", "orchestrate_run", "zob_coms_send", "zob_coms_ack", "zob_coms_status", "zob_coms_reply", "zob_coms_list", "zob_coms_get", "zob_coms_await"],
  "required_validation": [
    "npm run check -- --pretty false",
    "npm run smoke:harness",
    "orchestration validation.json room/context-pack checks"
  ],
  "oracle_required": true,
  "no_ship_conditions": [
    "worker-to-worker edge accepted without policy",
    "networked coms enabled",
    "DONE.sentinel written without evidence and oracle gate",
    "plaintext body persisted in coms or room"
  ],
  "enforcement": "preflight_fail"
}
```
