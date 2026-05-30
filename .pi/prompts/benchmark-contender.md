---
description: Metadata template for a coding-agent benchmark contender
argument-hint: "<manifest> <contender-id>"
---
Use only after parent approval for a real benchmark run. For scaffold smoke, do not execute.

Required model for every contender: `model_profile: "gpt-5.5-xhigh"`, `model_display: "GPT 5.5 xhigh"`.

Contender IDs: `pi-baseline`, `zob-orchestration-full-auto`, `codex`.

Rules:
- Do not read secrets or forbidden paths.
- Do not mutate the source project.
- For the Dokploy pilot, preserve Docker Compose names marked `external: true` and suffix only internal resources/references in proposals.
- Record elapsed time, tokens, estimated cost, relevance, success, and safety compliance when real execution is approved.
