# Wheel ZOB pack scope

This package is the bounded Wheel AgentOps policy/configuration layer. Generic runtime code under `.pi/extensions/zob-harness` must not import this package or hard-code Wheel names, paths, labels, models, factories, or completion policy.

## Direction

- Wheel pack code may import project-neutral public helpers from the generic runtime when needed.
- Generic runtime must remain project-neutral and must not depend on this pack.
- `jointhewheel` owns application-specific adapters, story sources, GitHub/CI integration, and branch protection.

## Safety

- Factories and external effects remain disabled by default.
- No credentials, provider keys, prompt bodies, or model outputs are stored in pack configuration.
- Only capability-audited routes may be marked verified.
- Model selection must preserve family independence and body-safe telemetry.

## Validation

Run:

```text
npm run check -- --pretty false
npm run smoke:wheel-zob-pack
```
