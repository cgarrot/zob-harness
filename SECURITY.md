# Security Policy

ZOB Harness is designed for local-first, safety-gated agentic engineering.

## Supported version

This repository currently publishes the active `main` branch as the supported development line.

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories when available, or by opening a minimal issue that avoids posting exploit details or secrets publicly.

When reporting, include:

- affected component or path;
- expected vs actual safety behavior;
- reproduction steps that do not expose secrets;
- whether generated artifacts, sessions, or logs are involved.

## Security expectations

The harness should never require contributors or agents to read or commit:

- `.env` files;
- private keys;
- SSH/AWS credential folders;
- provider API keys;
- local session transcripts;
- generated runtime ledgers or reports that may contain private context.

Generated local artifacts such as `reports/`, `.pi/sessions/`, `.pi/agent-sessions/`, `.pi/tmp/`, `.pi/logs/`, coms ledgers, merge queues, and workspace claims are intentionally ignored by default.

## No production-write guarantee

This open-source release does not grant agents unrestricted production write access. Browser, cloud, billing, GitHub write, network, or production mutation workflows require explicit human approval and additional gates.
