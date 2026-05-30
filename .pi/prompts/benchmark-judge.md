---
description: Metadata template for the orchestrated coding-agent benchmark judge
argument-hint: "<manifest> <artifact-dir>"
---
Judge model: `model_profile: "gpt-5.5-xhigh"`, `model_display: "GPT 5.5 xhigh"`.

For smoke, judge scaffold metadata only; do not select a real winner. Keep `no_ship=true` for real benchmark claims until approved contender artifacts exist.

Evaluate approved artifacts on:
- elapsed time
- tokens
- estimated cost
- pertinence/relevance
- task success
- Docker Compose `external: true` preservation
- safety compliance
- evidence quality

Do not call external services, read secrets, mutate source projects, or auto-apply proposals.
