import { annotateZpeerStatus, shouldAcceptZpeerStatusUpdate } from "../domains/coms/coms-v2/zpeer-status.js";
import type { HarnessRuntimeState, ZobLiveLastEvent } from "./state.js";

export type ZpeerRuntimeEventInput = Omit<ZobLiveLastEvent, "at" | "localOnly" | "networkEnabled" | "bodyStored" | "terminal" | "statusRank" | "superseded" | "supersededByStatus"> & { at?: string };

export interface ZpeerRuntimeEventRecordResult {
  accepted: boolean;
  event: ZobLiveLastEvent;
  current?: ZobLiveLastEvent;
}

function materializeZpeerRuntimeEvent(event: ZpeerRuntimeEventInput): ZobLiveLastEvent {
  return annotateZpeerStatus({
    ...event,
    at: event.at ?? new Date().toISOString(),
    localOnly: true as const,
    networkEnabled: false as const,
    bodyStored: false as const,
  });
}

export function recordZpeerRuntimeEvent(state: HarnessRuntimeState, event: ZpeerRuntimeEventInput): ZpeerRuntimeEventRecordResult {
  const next = materializeZpeerRuntimeEvent(event);
  if (!next.msgId) {
    state.zobLive.lastEvent = next;
    return { accepted: true, event: next };
  }

  state.zobLive.latestZpeerEventByMsgId ??= {};
  const current = state.zobLive.latestZpeerEventByMsgId[next.msgId];
  if (!shouldAcceptZpeerStatusUpdate(current, next)) {
    return {
      accepted: false,
      current,
      event: {
        ...next,
        superseded: true,
        supersededByStatus: current?.status,
      },
    };
  }

  state.zobLive.latestZpeerEventByMsgId[next.msgId] = next;
  state.zobLive.lastEvent = next;
  return { accepted: true, event: next, current: next };
}

export function isCurrentZpeerRuntimeEvent(state: HarnessRuntimeState, event: ZobLiveLastEvent): boolean {
  if (!event.msgId) return true;
  const current = state.zobLive.latestZpeerEventByMsgId?.[event.msgId];
  if (!current) return true;
  return current.at === event.at && current.status === event.status && current.kind === event.kind;
}
