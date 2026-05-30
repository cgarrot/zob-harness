---
description: Design a software factory from a repeated manual workflow
argument-hint: "<workflow>"
---
Switch to `/zmode factory` if not already there.

Consult `.pi/capabilities/zob-public-runtime-capabilities.json` for factory, quarantine, and `zob_autonomous_*` routing. Apply `.pi/skills/zob-tool-router/SKILL.md` when the workflow touches autonomy, context, delegation, compute, oracle, workspace, or promotion gates. Load `.pi/skills/zob-autonomous-runtime/SKILL.md` for autonomous dry-run/readonly smoke/validation design, and keep those gates distinct from final E2E completion.

Design a reusable software factory for: $ARGUMENTS

Output:
1. Repeated workflow and target quality gate.
2. Tool routing summary: factory/autonomous/context/delegation/compute/oracle families selected or skipped with reasons.
3. Input contract and typed schema.
4. Pipeline stages: deterministic steps vs LLM enrichment.
5. Specialist agents and tool access.
6. Artifacts, manifests, sentinel files, and resume/checkpoint logic.
7. Pilot batch plan and scaling rules.
8. Pi resources to create: extension tools, prompt templates, skills, agent prompts, scripts.
9. Risks / anti-patterns from prior sessions that this factory prevents.
