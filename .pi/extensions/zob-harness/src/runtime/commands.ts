import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { HarnessRuntimeState } from "./state.js";
import { registerZobIntroCommand } from "./zob-intro.js";
import { refreshIntentClassifierModelCache, registerIntentCommands } from "./commands/intent.js";
import { registerZmodeCommand } from "./commands/zmode.js";
import { registerDelegatesCommands } from "./commands/delegates.js";
import { registerZliveCommands } from "./commands/zlive.js";
import { registerZcommitCommand } from "./commands/zcommit.js";
import { registerAutonomyCommand } from "./commands/autonomy.js";
import { registerComputeCommands } from "./commands/compute.js";
import { registerProjectDnaCommand } from "./commands/project-dna.js";
import { registerGoalCommands } from "./commands/goal.js";
import { registerNewCommand, registerStopCommand, registerStatusCommands, registerRulesStatusCommand, registerContractCommand, registerAgentsCommand } from "./commands/misc.js";

export function registerHarnessCommands(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.on("session_start", (_event, ctx) => {
    refreshIntentClassifierModelCache(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    refreshIntentClassifierModelCache(ctx);
  });

  registerZobIntroCommand(pi);

  registerNewCommand(pi, state);

  registerZmodeCommand(pi, state);

  registerIntentCommands(pi, state);

  registerStopCommand(pi, state);

  registerDelegatesCommands(pi, state);

  registerZliveCommands(pi, state);

  registerStatusCommands(pi, state);

  registerZcommitCommand(pi, state);

  registerAutonomyCommand(pi, state);

  registerComputeCommands(pi, state);

  registerProjectDnaCommand(pi, state);

  registerRulesStatusCommand(pi, state);

  registerContractCommand(pi, state);

  registerGoalCommands(pi, state);

  registerAgentsCommand(pi, state);
}
