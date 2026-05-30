---
name: zob-agentic-access
description: Use when adding or reviewing external adapters such as package metadata, GitHub, browser, cloud, or other APIs.
---
# ZOB Agentic Access Skill

## Activation ladder

1. Local filesystem/git readonly.
2. Package manager readonly.
3. GitHub readonly.
4. Browser only on explicit human request.
5. Write adapters only after sandbox + oracle + approval.

## Adapter rules

- Never read secrets or credentials.
- Write access requires explicit approval metadata.
- Browser/cloud/production actions are no-ship unless gated.
- Every adapter needs proposal -> smoke -> oracle -> manual activation.
