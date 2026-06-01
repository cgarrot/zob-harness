import { Type } from "typebox";

const ProjectDnaReadinessParams = Type.Object({
  scan_dir: Type.Optional(Type.String({ description: "Repo-relative ProjectDNA scan artifact directory. Must stay under reports/project-dna-scans." })),
});

const ProjectDnaPlanWorkflowParams = Type.Object({
  manifest_path: Type.String({ description: "Repo-relative ProjectDNA manifest v2 path." }),
  scan_dir: Type.Optional(Type.String({ description: "Optional repo-relative ProjectDNA scan artifact directory. Must stay under reports/project-dna-scans." })),
});

const ProjectDnaQueryParams = Type.Object({
  scan_dir: Type.Optional(Type.String({ description: "Repo-relative ProjectDNA scan artifact directory. Must stay under reports/project-dna-scans." })),
  query: Type.String({ description: "Transient query text. It is hashed in outputs and must not be persisted raw." }),
  max_files: Type.Optional(Type.Number({ description: "Maximum cited files to return. Capped at 20." })),
  max_context_tokens: Type.Optional(Type.Number({ description: "Bounded context limit. Runtime cap is 8000." })),
  allowed_sources: Type.Optional(Type.Array(Type.String(), { description: "Allowed ProjectDNA source ids for this query." })),
  context_scope_id: Type.Optional(Type.String({ description: "Optional context_scope id to attach to the bounded context result." })),
});

const ProjectDnaFederatedQueryParams = Type.Object({
  scan_dirs: Type.Array(Type.String(), { description: "Repo-relative ProjectDNA scan artifact directories. Each must stay under reports/project-dna-scans." }),
  query: Type.String({ description: "Transient query text. It is hashed in outputs and must not be persisted raw." }),
  max_files_per_source: Type.Optional(Type.Number({ description: "Maximum cited files per source. Capped at 10." })),
  max_total_files: Type.Optional(Type.Number({ description: "Maximum cited files across all sources. Capped at 50." })),
  max_context_tokens: Type.Optional(Type.Number({ description: "Bounded context limit. Runtime cap is 8000." })),
  allowed_sources: Type.Optional(Type.Array(Type.String(), { description: "Allowed ProjectDNA source ids for this federated query." })),
  context_scope_id: Type.Optional(Type.String({ description: "Optional context_scope id to attach to the bounded federated context result." })),
});

const ProjectDnaWritebackProposalParams = Type.Object({
  run_id: Type.String({ description: "ProjectDNA run id that produced the proposal. Stored only as a hash." }),
  proposal_id: Type.Optional(Type.String({ description: "Optional deterministic proposal id. Must be path-safe." })),
  source_ids: Type.Array(Type.String(), { description: "ProjectDNA source ids supporting the proposal." }),
  observed_pattern_hash: Type.String({ description: "sha256 hash of the observed pattern/problem. Raw text is not accepted or stored." }),
  proposed_capsule_hash: Type.String({ description: "sha256 hash of the proposed capsule/pattern body. Raw text is not accepted or stored." }),
  evidence_refs: Type.Array(Type.String(), { description: "Safe repo-relative evidence refs supporting this proposal." }),
  recommended_artifact: Type.String({ description: "Safe repo-relative support artifact recommendation." }),
});

export {
  ProjectDnaReadinessParams,
  ProjectDnaPlanWorkflowParams,
  ProjectDnaQueryParams,
  ProjectDnaFederatedQueryParams,
  ProjectDnaWritebackProposalParams,
};
