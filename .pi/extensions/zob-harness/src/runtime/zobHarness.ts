import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerHarnessCommands } from "./commands.js";
import { registerHarnessEvents } from "./events.js";
import { createHarnessRuntimeState } from "./state.js";
import { registerAutonomousTools } from "./tools-autonomous.js";
import { registerComsTools } from "./tools-coms.js";
import { registerComputeTools } from "./tools-compute.js";
import { registerContextTools } from "./tools-context.js";
import { registerFileTools } from "./tools-files.js";
import { registerDelegationTools } from "./tools-delegation.js";
import { registerMissionControlTools } from "./tools-mission-control.js";
import { registerFactoryTools } from "./tools-factory.js";
import { registerProjectDnaTools } from "./tools-project-dna.js";
import { registerPlanTools } from "./tools-plan.js";
import { registerOrchestrationTools } from "./tools-orchestration.js";
import { registerGoalRuntimeEvents, registerGoalRuntimeTools } from "./goal-runtime.js";
import { registerGoalRoomTools } from "./tools-goal-room.js";
import { registerGovernedRequestTools } from "./tools-governed-requests.js";
import { registerWorkspaceClaimTools } from "./tools-workspace-claims.js";
import { registerWorkerPoolTools } from "./tools-worker-pool.js";
import { registerMergeQueueTools } from "./tools-merge-queue.js";
import { registerZcommitTools } from "./tools-zcommit.js";
import { registerZagentTools } from "./tools-zagent.js";
import { registerWorklistTools } from "./tools-worklist.js";
import { renderHarnessWidget } from "./widget.js";

export default function zobHarness(pi: ExtensionAPI): void {
  const state = createHarnessRuntimeState();

  registerHarnessCommands(pi, state);

  registerGoalRuntimeTools(pi, state);

  registerDelegationTools(pi, state);

  registerOrchestrationTools(pi, state);

  registerComsTools(pi, state);

  registerGoalRoomTools(pi);
  registerGovernedRequestTools(pi);
  registerWorkspaceClaimTools(pi);
  registerWorkerPoolTools(pi);
  registerMergeQueueTools(pi);

  registerZcommitTools(pi, state);

  registerZagentTools(pi, state);

  registerWorklistTools(pi);

  registerMissionControlTools(pi);

  registerContextTools(pi);

  registerFileTools(pi);

  registerComputeTools(pi);

  registerProjectDnaTools(pi);

  registerPlanTools(pi, state);

  registerAutonomousTools(pi);

  registerFactoryTools(pi, state);

  registerGoalRuntimeEvents(pi, state, (ctx) => renderHarnessWidget(pi, state, ctx));

  registerHarnessEvents(pi, state);
}
