# Wheel ZOB Contract Examples

These fictional, body-safe examples are intended to validate against sibling schemas. They do not represent a live mission, real GitHub Check, provider/model result, human authorization or factory activation.

| Example | Schema |
|---|---|
| `mission.example.json` | `mission.schema.json` |
| `mission-event.example.json` | `mission-event.schema.json` |
| `story-execution.example.json` | `story-execution.schema.json` |
| `fleet-v5-machine-bundle.example.json` | `fleet-v5-machine-bundle.schema.json` |
| `execution-profile.example.json` | `execution-profile.schema.json` |
| `gate.example.json` | `gate.schema.json` |
| `task.example.json` | `task.schema.json` |
| `evidence.example.json` | `evidence.schema.json` |
| `pr-close-evidence.example.json` | `pr-close-evidence.schema.json` |
| `ack-receipt.example.json` | `ack-receipt.schema.json` |
| `model-attempt.example.json` | `model-attempt.schema.json` (protected telemetry only) |
| `blind-review-result.example.json` | `blind-review-result.schema.json` |
| `merge-authorization.example.json` | `merge-authorization.schema.json` (legacy direct-base compatibility only) |
| `staging-candidate.example.json` | `staging-candidate.schema.json` |
| `source-doc-coverage.example.json` | `source-doc-coverage.schema.json` |
| `repository-assurance-result.example.json` | `repository-assurance-result.schema.json` |
| `assurance-repair-round.example.json` | `assurance-repair-round.schema.json` |
| `promotion-authorization.example.json` | `promotion-authorization.schema.json` |
| `promotion-merge-evidence.example.json` | `promotion-merge-evidence.schema.json` |
| `promotion-window-ack-receipt.example.json` | `ack-receipt.schema.json` (supplemental) |
| `promotion-merge-ack-receipt.example.json` | `ack-receipt.schema.json` (supplemental) |
| `checkpoint.example.json` | `checkpoint.schema.json` |

All hashes, PR numbers and GitHub URLs are fictional placeholders. `bodyStored: false` is intentional. The examples form one lineage: a human window starts at the initial staging SHA; a round-1 finding-bound repair creates candidate revision 2; round 2 passes; promotion binds that final SHA; post-promotion alignment passes new-head staging CI before unfreeze. Active Story/Review examples target non-deploying `develop-staging`; only the read-only legacy merge-batch fixture retains a direct `develop` target for backward-compatible schema tests and it cannot authorize a new Wheel effect.