import type { WheelSupervisorStoryStage, WheelSupervisorStoryState } from "./types.js";

export interface WheelStoryStageOperations {
  changeStage: (storyId: string, to: WheelSupervisorStoryStage) => void;
  provisionWorkspace: (story: WheelSupervisorStoryState) => Promise<boolean>;
  bootstrapWorkspace: (story: WheelSupervisorStoryState) => Promise<boolean>;
  openDraftPullRequest: (story: WheelSupervisorStoryState) => Promise<boolean>;
  runDevelopment: (story: WheelSupervisorStoryState, repair: boolean) => Promise<boolean>;
  runDocumentation: (story: WheelSupervisorStoryState) => Promise<boolean>;
  runQa: (story: WheelSupervisorStoryState) => Promise<boolean>;
  runReviewRole: (
    story: WheelSupervisorStoryState,
    role: "internal-review" | "formal-blind-review" | "repository-assurance",
    nextStage: WheelSupervisorStoryStage,
  ) => Promise<boolean>;
  runRepair: (story: WheelSupervisorStoryState) => Promise<boolean>;
  runDraftCi: (story: WheelSupervisorStoryState) => Promise<boolean>;
  runAudit: (
    story: WheelSupervisorStoryState,
    role: "pr-close-source-audit" | "pr-close-evidence-audit",
    nextStage: WheelSupervisorStoryStage,
    evidenceKind: "review",
  ) => Promise<boolean>;
  finalizePrClose: (story: WheelSupervisorStoryState) => Promise<boolean>;
  publishPrCloseCheck: (story: WheelSupervisorStoryState) => Promise<boolean>;
}

export function runWheelStoryStage(
  story: WheelSupervisorStoryState,
  operations: WheelStoryStageOperations,
): Promise<boolean> {
  const handlers: Record<WheelSupervisorStoryStage, () => Promise<boolean>> = {
    admitted: async () => {
      operations.changeStage(story.storyId, "planned");
      return true;
    },
    "waiting-dependencies": async () => {
      operations.changeStage(story.storyId, "planned");
      return true;
    },
    planned: async () => {
      operations.changeStage(story.storyId, "workspace-provisioning");
      return true;
    },
    "workspace-provisioning": () => operations.provisionWorkspace(story),
    "workspace-ready": () => operations.bootstrapWorkspace(story),
    "bootstrap-ready": () => operations.openDraftPullRequest(story),
    "draft-pr-open": async () => {
      operations.changeStage(story.storyId, "development");
      return true;
    },
    development: () => operations.runDevelopment(story, false),
    documentation: () => operations.runDocumentation(story),
    qa: () => operations.runQa(story),
    "internal-review": () => operations.runReviewRole(story, "internal-review", "formal-blind-review"),
    "formal-blind-review": () => operations.runReviewRole(story, "formal-blind-review", "repository-assurance"),
    "repository-assurance": () => operations.runReviewRole(story, "repository-assurance", "draft-ci"),
    repair: () => operations.runRepair(story),
    "draft-ci": () => operations.runDraftCi(story),
    "pr-close-source-audit": () => operations.runAudit(story, "pr-close-source-audit", "pr-close-evidence-audit", "review"),
    "pr-close-evidence-audit": () => operations.runAudit(story, "pr-close-evidence-audit", "pr-close-finalizing", "review"),
    "pr-close-finalizing": () => operations.finalizePrClose(story),
    "pr-close-check": () => operations.publishPrCloseCheck(story),
    "needs-review": async () => false,
    "needs-human": async () => false,
    failed: async () => false,
  };
  const handler = handlers[story.stage];
  if (!handler) throw new Error(`unsupported story stage ${story.stage}`);
  return handler();
}
