export const PROMOTION_KINDS = ["documentation_writeback", "temp_agent", "factory", "write_lane"] as const;
export type PromotionKind = typeof PROMOTION_KINDS[number];

export const PROMOTION_STATUSES = ["proposal", "prepared", "validated", "oracle_reviewed", "approved", "applied", "rejected", "blocked"] as const;
export type PromotionStatus = typeof PROMOTION_STATUSES[number];

export const PROMOTION_APPLY_SCOPES = ["none", "manual_apply_only", "quarantine_test_directory"] as const;
export type PromotionApplyScope = typeof PROMOTION_APPLY_SCOPES[number];

export interface PromotionGates {
  comsThreadRequired: boolean;
  sandboxRequired: boolean;
  validationRequired: boolean;
  oracleRequired: boolean;
  humanApprovalRequired: boolean;
  rollbackRequired: boolean;
}

export interface PromotionCandidateInput {
  candidateId?: string;
  kind: PromotionKind;
  runId: string;
  goalId?: string;
  todoId?: string;
  sourceRef: string;
  sourceHash?: string;
  comsThreadRef?: string;
  goalRoomMessageRefs?: string[];
  preparedArtifactRef?: string | null;
  validationRefs?: string[];
  oracleReviewRef?: string | null;
  oracleVerdict?: "PASS" | "WARN" | "FAIL" | null;
  oracleNoShip?: boolean | null;
  approvalRef?: string | null;
  rollbackRef?: string | null;
  changedPaths?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  gates?: Partial<PromotionGates>;
  applyScope?: PromotionApplyScope;
  metadata?: Record<string, unknown>;
}

export interface PromotionCandidateRecord {
  schema: "zob.promotion-candidate.v1";
  candidateId: string;
  kind: PromotionKind;
  runId: string;
  goalId: string | null;
  todoId: string | null;
  status: PromotionStatus;
  sourceRef: string;
  sourceHash: string | null;
  preparedArtifactRef: string | null;
  validationRefs: string[];
  oracleReviewRef: string | null;
  oracleVerdict: "PASS" | "WARN" | "FAIL" | null;
  oracleNoShip: boolean | null;
  approvalRef: string | null;
  rollbackRef: string | null;
  comsThreadRef: string | null;
  goalRoomMessageRefs: string[];
  changedPaths: string[];
  changedPathHashes: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  gates: PromotionGates;
  applyScope: PromotionApplyScope;
  applyPerformed: boolean;
  productionWritesPerformed: false;
  autoApply: false;
  parentOwned: true;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PromotionTransitionInput {
  toStatus: PromotionStatus;
  preparedArtifactRef?: string;
  validationRefs?: string[];
  oracleReviewRef?: string;
  oracleVerdict?: "PASS" | "WARN" | "FAIL";
  oracleNoShip?: boolean;
  approvalRef?: string;
  rollbackRef?: string;
  goalRoomMessageRefs?: string[];
  applyScope?: PromotionApplyScope;
  applyPerformed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PromotionComsMessageRef {
  msgId: string;
  kind: "STATUS_UPDATE" | "FINDING" | "RISK" | "BLOCKER" | "NO_SHIP_ALERT" | "CONTEXT_REQUEST" | "DELEGATION_REQUEST" | "ORACLE_REQUEST" | "QUESTION" | "ANSWER";
  sender: string;
  status: "queued" | "acked" | "running" | "completed" | "blocked" | "timeout" | "stale" | "offline";
  bodyHash: string;
  outputHash?: string | null;
  artifactRefs: string[];
  evidenceRefs: string[];
  requiresParentAction: boolean;
  countsAsCompletion: boolean;
  parentVisible: true;
  hiddenPeerChat: false;
  workerToWorkerDirect: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface PromotionComsThreadInput {
  threadId?: string;
  goalId: string;
  todoId?: string;
  candidateId: string;
  kind: PromotionKind;
  messageRefs?: PromotionComsMessageRef[];
  requiredAcks?: string[];
  stalePolicy?: "stale_blocks_completion";
}

export interface PromotionComsThreadRecord {
  schema: "zob.promotion-coms-thread.v1";
  threadId: string;
  goalId: string;
  todoId: string | null;
  candidateId: string;
  kind: PromotionKind;
  messageRefs: PromotionComsMessageRef[];
  requiredAcks: string[];
  stalePolicy: "stale_blocks_completion";
  parentVisible: true;
  parentOwnedActions: true;
  hiddenPeerChat: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  createdAt: string;
  updatedAt: string;
}

export interface PromotionValidationResult {
  valid: boolean;
  errors: string[];
}
