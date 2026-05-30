import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { delegateViewLink, findDelegateActionAtColumn, findDelegateRunIdAtColumn } from "./delegation-click-markers.js";
import type { DelegationClickAction } from "./delegation-click-markers.js";
import { finishDelegationRun, startDelegationRun } from "./delegation-monitor.js";
import type { HarnessRuntimeState } from "./state.js";

export { delegateViewLink, findDelegateRunIdAtColumn } from "./delegation-click-markers.js";

const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

export interface SgrMouseEvent {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

interface TuiRenderSnapshot {
  previousLines?: string[];
  previousViewportTop?: number;
  terminal?: { rows?: number };
}

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
  const sgr = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])$/);
  if (sgr) {
    return {
      button: Number(sgr[1]),
      x: Number(sgr[2]),
      y: Number(sgr[3]),
      release: sgr[4] === "m",
    };
  }

  // Legacy X10/xterm mouse format: ESC [ M Cb Cx Cy.
  // Some terminal/tmux combinations still emit this even when SGR mode was requested.
  if (data.startsWith("\x1b[M") && data.length >= 6) {
    const rawButton = Math.max(0, data.charCodeAt(3) - 32);
    const x = Math.max(1, data.charCodeAt(4) - 32);
    const y = Math.max(1, data.charCodeAt(5) - 32);
    const release = (rawButton & 3) === 3;
    return { button: release ? 0 : rawButton, x, y, release };
  }

  return undefined;
}

function normalizedMouseButton(button: number): number {
  return button & ~(4 | 8 | 16 | 32);
}

function findDelegateActionAtMousePosition(tui: TuiRenderSnapshot | undefined, x: number, y: number): DelegationClickAction | undefined {
  const lines = tui?.previousLines;
  if (!Array.isArray(lines)) return undefined;
  const viewportTop = typeof tui?.previousViewportTop === "number" ? tui.previousViewportTop : Math.max(0, lines.length - (tui?.terminal?.rows ?? lines.length));
  const line = lines[viewportTop + y - 1];
  return line ? findDelegateActionAtColumn(line, x) : undefined;
}

function ensureRunForViewAction(state: HarnessRuntimeState, action: DelegationClickAction): void {
  if (action.kind !== "view") return;
  if (state.delegations.runs.some((run) => run.id === action.runId)) return;
  const nowMs = Date.now();
  startDelegationRun(state.delegations, {
    id: action.runId,
    parentToolCallId: action.runId,
    source: action.runId.startsWith("task_") ? "delegate_task" : "delegate_agent",
    mode: "single",
    agent: action.agent ?? "delegate",
    task: "restored from historical delegate_agent chat row",
    startedAtMs: nowMs - 1,
  });
  const terminalStatus = action.status && action.status !== "queued" && action.status !== "running" ? action.status : "complete";
  finishDelegationRun(state.delegations, action.runId, {
    status: terminalStatus,
    endedAtMs: nowMs,
    outputPreview: "",
    stderrPreview: "",
  });
}

export function enableDelegationMouseMode(tui: TUI): void {
  tui.terminal.write(MOUSE_ENABLE);
}

export function disableDelegationMouseMode(tui: TUI | undefined): void {
  tui?.terminal.write(MOUSE_DISABLE);
}

function overlayActive(state: HarnessRuntimeState): boolean {
  return Boolean(state.delegationMouse.overlaySelect || state.delegationMouse.overlayClose || state.delegationMouse.overlayScroll);
}

function temporarilyReleaseMouseForFeedScroll(state: HarnessRuntimeState): void {
  if (overlayActive(state)) return;
  const tui = state.delegationMouse.tui;
  if (!tui) return;
  if (state.delegationMouse.enabled) {
    disableDelegationMouseMode(tui);
    state.delegationMouse.enabled = false;
  }
  state.delegationMouse.releasedUntilMs = Date.now() + 1200;
  if (state.delegationMouse.mouseReenableTimer) clearTimeout(state.delegationMouse.mouseReenableTimer);
  const releaseEpoch = ++state.delegationMouse.mouseReleaseEpoch;
  state.delegationMouse.mouseReenableTimer = setTimeout(() => {
    state.delegationMouse.mouseReenableTimer = undefined;
    if (state.delegationMouse.mouseReleaseEpoch !== releaseEpoch) return;
    state.delegationMouse.releasedUntilMs = undefined;
    if (!state.delegationMouse.tui || state.delegations.runs.length === 0 || overlayActive(state)) return;
    enableDelegationMouseMode(state.delegationMouse.tui);
    state.delegationMouse.enabled = true;
  }, 1200);
  state.delegationMouse.mouseReenableTimer.unref?.();
}

export function handleDelegationMouseInput(ctx: ExtensionContext, state: HarnessRuntimeState, data: string): { consume: true } | undefined {
  const event = parseSgrMouseEvent(data);
  if (!event) return undefined;
  const button = normalizedMouseButton(event.button);
  if ((button === 64 || button === 65) && !event.release) {
    if (state.delegationMouse.overlayScroll?.(button === 64 ? "up" : "down", event.x, event.y)) state.delegationMouse.tui?.requestRender?.();
    else temporarilyReleaseMouseForFeedScroll(state);
    return { consume: true };
  }
  const isOverlayActive = overlayActive(state);
  if (button !== 0) return isOverlayActive ? undefined : { consume: true };
  const action = findDelegateActionAtMousePosition(state.delegationMouse.tui as unknown as TuiRenderSnapshot | undefined, event.x, event.y);
  if (!action) return isOverlayActive ? undefined : { consume: true };
  if (isOverlayActive && action.kind !== "close" && action.kind !== "select") return undefined;
  if (action.kind === "close") {
    if (state.delegationMouse.overlayClose?.()) state.delegationMouse.tui?.requestRender?.();
    return { consume: true };
  }
  if (action.kind === "select") {
    if (state.delegationMouse.overlaySelect?.(action.runId)) state.delegationMouse.tui?.requestRender?.();
    return { consume: true };
  }
  ensureRunForViewAction(state, action);
  if ((state.delegationMouse.suppressOpenUntilMs ?? 0) > Date.now()) return { consume: true };
  if (!state.delegationMouse.opening) {
    state.delegationMouse.opening = true;
    queueMicrotask(() => {
      void import("./delegation-overlay.js")
        .then(({ showDelegationOverlay }) => showDelegationOverlay(ctx, state, action.runId))
        .finally(() => {
          state.delegationMouse.opening = false;
        });
    });
  }
  return { consume: true };
}

export function installDelegationMouseSupport(ctx: ExtensionContext, state: HarnessRuntimeState, tui: TUI, owner?: symbol, options: { forceEnable?: boolean } = {}): void {
  if (!ctx.hasUI) return;
  if (options.forceEnable) {
    if (state.delegationMouse.mouseReenableTimer) clearTimeout(state.delegationMouse.mouseReenableTimer);
    state.delegationMouse.mouseReleaseEpoch++;
    state.delegationMouse.mouseReenableTimer = undefined;
    state.delegationMouse.releasedUntilMs = undefined;
    state.delegationMouse.suppressOpenUntilMs = undefined;
  }
  const previousTui = state.delegationMouse.tui;
  const ownerChanged = Boolean(owner && state.delegationMouse.widgetOwner && state.delegationMouse.widgetOwner !== owner);
  const tuiChanged = Boolean(previousTui && previousTui !== tui);
  if (state.delegationMouse.unsubscribe && (ownerChanged || tuiChanged)) {
    state.delegationMouse.unsubscribe();
    state.delegationMouse.unsubscribe = undefined;
    if (state.delegationMouse.enabled) disableDelegationMouseMode(previousTui);
    state.delegationMouse.enabled = false;
  }
  if (owner) state.delegationMouse.widgetOwner = owner;
  state.delegationMouse.tui = tui;
  const releasedForFeedScroll = !options.forceEnable && (state.delegationMouse.releasedUntilMs ?? 0) > Date.now() && !overlayActive(state);
  if (!state.delegationMouse.enabled && !releasedForFeedScroll) {
    enableDelegationMouseMode(tui);
    state.delegationMouse.enabled = true;
  }
  if (state.delegationMouse.unsubscribe) return;
  state.delegationMouse.unsubscribe = ctx.ui.onTerminalInput((data) => handleDelegationMouseInput(ctx, state, data));
}

export function disposeDelegationMouseSupport(state: HarnessRuntimeState, options: { force?: boolean; owner?: symbol } = {}): void {
  if (options.owner && state.delegationMouse.widgetOwner && state.delegationMouse.widgetOwner !== options.owner && !options.force) return;
  if (overlayActive(state) && !options.force) return;
  if (state.delegationMouse.mouseReenableTimer) clearTimeout(state.delegationMouse.mouseReenableTimer);
  state.delegationMouse.mouseReleaseEpoch++;
  state.delegationMouse.mouseReenableTimer = undefined;
  state.delegationMouse.releasedUntilMs = undefined;
  state.delegationMouse.suppressOpenUntilMs = undefined;
  state.delegationMouse.unsubscribe?.();
  state.delegationMouse.unsubscribe = undefined;
  if (state.delegationMouse.enabled) disableDelegationMouseMode(state.delegationMouse.tui);
  state.delegationMouse.enabled = false;
  state.delegationMouse.tui = undefined;
  state.delegationMouse.opening = false;
  state.delegationMouse.widgetOwner = undefined;
  if (options.force) {
    state.delegationMouse.overlaySelect = undefined;
    state.delegationMouse.overlayClose = undefined;
    state.delegationMouse.overlayScroll = undefined;
  }
}
