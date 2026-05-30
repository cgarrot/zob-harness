import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { appendGoalRoomMessage, listGoalRoomMessages } from "../goal-room.js";
import { ZobGoalRoomListParams, ZobGoalRoomSendParams } from "../schemas.js";
import { loadTeamDefinition, validateTeamDefinition } from "../topology/teams.js";
import type { TeamDefinition } from "../types.js";

export function registerGoalRoomTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "zob_goal_room_send",
    label: "ZOB Goal Room Send",
    description: "Append a visible typed GOAL_ROOM_MESSAGE.v1 to the parent-visible goal room. Metadata/hash-only; no hidden worker-to-worker free chat; no action execution.",
    promptSnippet: "Post a typed metadata-only message to the shared goal room.",
    parameters: ZobGoalRoomSendParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (errors.length > 0 || !team.definition) return { content: [{ type: "text", text: `zob_goal_room_send failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      try {
        const message = appendGoalRoomMessage(ctx.cwd, team.definition as TeamDefinition, params);
        pi.appendEntry("zob-goal-room", { event: "message_appended", msgId: message.msgId, goalId: message.goalId, sender: message.sender, kind: message.kind, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
        return { content: [{ type: "text", text: `zob_goal_room_send: ${message.msgId}` }], details: { schema: "zob.goal-room-send-result.v1", message } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_goal_room_send blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_goal_room_list",
    label: "ZOB Goal Room List",
    description: "List parent-visible typed goal-room messages. Bodies are never returned because only hashes/metadata are persisted.",
    promptSnippet: "List metadata-only messages in the shared goal room.",
    parameters: ZobGoalRoomListParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const messages = listGoalRoomMessages(ctx.cwd, params);
        return { content: [{ type: "text", text: `zob_goal_room_list: ${messages.length} message(s)` }], details: { schema: "zob.goal-room-list.v1", messages } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_goal_room_list blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });
}
