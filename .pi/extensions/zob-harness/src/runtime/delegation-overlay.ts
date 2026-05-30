import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import type { DelegationMonitorState, DelegationRunView, DelegationSortMode } from "./delegation-monitor.js";
import { buildDelegationGroups, delegationCost, delegationDurationMs, delegationSignalBadge, delegationSignalColor, formatDelegationContextLabel, formatDelegationCost, formatDelegationCostLabel, formatDelegationSignalBadge, formatDuration, statusIcon } from "./delegation-monitor.js";
import { delegationFeedFingerprint, renderDelegationFeedLines } from "./delegation-feed.js";
import { delegateCloseButton, delegateSelectMarker } from "./delegation-click-markers.js";
import { disableDelegationMouseMode, enableDelegationMouseMode, handleDelegationMouseInput } from "./delegation-mouse.js";
import type { HarnessRuntimeState } from "./state.js";

interface OverlayRow {
  kind: "group" | "run";
  id: string;
  label: string;
  run?: DelegationRunView;
}

const SORT_MODES: DelegationSortMode[] = ["active", "latest", "duration", "agent"];

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function statusColor(status: DelegationRunView["status"]): "success" | "warning" | "error" | "muted" {
  if (status === "complete") return "success";
  if (status === "running" || status === "queued") return "warning";
  if (status === "preflight_failed" || status === "failed" || status === "aborted") return "error";
  return "muted";
}

function flattenRows(state: DelegationMonitorState, sort: DelegationSortMode, nowMs: number): OverlayRow[] {
  const rows: OverlayRow[] = [];
  for (const group of buildDelegationGroups(state, sort, nowMs)) {
    const shortId = group.parentToolCallId.slice(0, 8);
    const groupCost = group.runs.reduce((total, run) => total + delegationCost(run), 0);
    const groupCostLabel = group.runs.some((run) => !run.usage && (run.status === "queued" || run.status === "running"))
      ? "cost pending"
      : group.runs.every((run) => !run.usage)
        ? "cost unavailable"
        : formatDelegationCost(groupCost);
    rows.push({
      kind: "group",
      id: `group:${group.parentToolCallId}`,
      label: `${group.source} ${group.mode} #${shortId} · ${groupCostLabel} · ●${group.running} ✓${group.complete} ✗${group.failed}`,
    });
    for (const [index, run] of group.runs.entries()) {
      const prefix = index === group.runs.length - 1 ? "└─" : "├─";
      rows.push({
        kind: "run",
        id: run.id,
        run,
        label: `${prefix} ${statusIcon(run.status)} ${run.agent}`,
      });
    }
  }
  return rows;
}

export class DelegationOverlayComponent implements Component {
  private selectedRunId?: string;
  private listScroll = 0;
  private logScroll = 0;
  private sortIndex = 0;
  private cachedTranscriptKey?: string;
  private cachedTranscriptLines: string[] = [];
  private followTail = true;
  private lastMaxLogScroll = 0;
  private lastListWidth = 38;
  private ensureSelectionOnNextRender = true;
  private filter = "";
  private filterEditing = false;
  private helpVisible = false;
  private initialSelectionNoMatch = false;
  private readonly overlaySelectHandler: (runId: string) => boolean;
  private readonly overlayCloseHandler: () => boolean;
  private readonly overlayScrollHandler: (direction: "up" | "down", x?: number, y?: number) => boolean;

  constructor(
    private readonly runtimeState: HarnessRuntimeState,
    private readonly repoRoot: string,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly initialSelection: string | undefined,
    private readonly tui: TUI,
  ) {
    this.overlaySelectHandler = (runId) => this.selectRun(runId);
    this.overlayCloseHandler = () => {
      this.close();
      return true;
    };
    this.overlayScrollHandler = (direction, x, _y) => (this.isLeftPaneColumn(x) ? this.scrollList(direction) : this.scrollTranscript(direction));
    this.runtimeState.delegationMouse.overlaySelect = this.overlaySelectHandler;
    this.runtimeState.delegationMouse.overlayClose = this.overlayCloseHandler;
    this.runtimeState.delegationMouse.overlayScroll = this.overlayScrollHandler;
    enableDelegationMouseMode(this.tui);
    this.runtimeState.delegationMouse.tui = this.tui;
    this.runtimeState.delegationMouse.enabled = true;
    this.runtimeState.delegationMouse.mouseReleaseEpoch++;
    this.runtimeState.delegationMouse.releasedUntilMs = undefined;
    if (this.runtimeState.delegationMouse.mouseReenableTimer) clearTimeout(this.runtimeState.delegationMouse.mouseReenableTimer);
    this.runtimeState.delegationMouse.mouseReenableTimer = undefined;
  }

  handleInput(data: string): void {
    if (handleDelegationMouseInput({ hasUI: true, cwd: this.repoRoot, ui: { onTerminalInput: () => () => undefined } } as unknown as ExtensionContext, this.runtimeState, data)?.consume) return;

    if (matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.filterEditing || this.filter) {
        this.filter = "";
        this.filterEditing = false;
        this.listScroll = 0;
        this.ensureSelectionOnNextRender = true;
        this.invalidate();
        return;
      }
      this.close();
      return;
    }

    if (this.filterEditing) {
      if (matchesKey(data, "enter")) {
        this.filterEditing = false;
        return;
      }
      if (matchesKey(data, "backspace") || data === "\x7f") {
        this.filter = this.filter.slice(0, -1);
        this.listScroll = 0;
        this.ensureSelectionOnNextRender = true;
        this.invalidate();
        return;
      }
      if (this.isPrintableInput(data)) {
        this.filter += data;
        this.listScroll = 0;
        this.ensureSelectionOnNextRender = true;
        this.invalidate();
      }
      return;
    }

    if (data === "/") {
      this.filterEditing = true;
      return;
    }
    if (data === "?") {
      this.helpVisible = !this.helpVisible;
      return;
    }

    const rows = this.rows();
    const selectable = rows.filter((row) => row.kind === "run" && row.run);
    const currentIndex = Math.max(0, selectable.findIndex((row) => row.id === this.selectedRunId));

    if (matchesKey(data, "up")) {
      if (selectable.length === 0) return;
      const next = selectable[Math.max(0, currentIndex - 1)];
      this.selectedRunId = next?.id;
      this.logScroll = 0;
      this.followTail = true;
      this.ensureSelectionOnNextRender = true;
      this.ensureSelectedVisible(rows);
    } else if (matchesKey(data, "down")) {
      if (selectable.length === 0) return;
      const next = selectable[Math.min(selectable.length - 1, currentIndex + 1)];
      this.selectedRunId = next?.id;
      this.logScroll = 0;
      this.followTail = true;
      this.ensureSelectionOnNextRender = true;
      this.ensureSelectedVisible(rows);
    } else if (data === "\x1b[5~") {
      this.followTail = false;
      this.logScroll = Math.max(0, this.logScroll - 10);
    } else if (data === "\x1b[6~") {
      this.logScroll += 10;
      if (this.logScroll >= this.lastMaxLogScroll) this.followTail = true;
    } else if (matchesKey(data, "home")) {
      this.followTail = false;
      this.logScroll = 0;
    } else if (matchesKey(data, "end")) {
      this.followTail = true;
      this.logScroll = Number.MAX_SAFE_INTEGER;
    } else if (data === "[" || data === "{") {
      this.scrollList("up");
    } else if (data === "]" || data === "}") {
      this.scrollList("down");
    } else if (data === "s" || data === "S") {
      this.sortIndex = (this.sortIndex + 1) % SORT_MODES.length;
      this.listScroll = 0;
      this.logScroll = 0;
      this.ensureSelectionOnNextRender = true;
    } else if (data === "r" || data === "R") {
      this.invalidate();
    } else if (selectable.length === 0) {
      return;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const w = Math.max(50, width);
    const inner = Math.max(1, w - 2);
    const listWidth = Math.min(38, Math.max(22, Math.floor(inner * 0.36)));
    this.lastListWidth = listWidth;
    const gap = 1;
    const logWidth = Math.max(20, inner - listWidth - gap);
    const bodyHeight = this.bodyHeight();
    const rows = this.rows();
    const selected = this.selectedRun(rows);
    const transcript = this.transcriptLines(selected, logWidth);
    const maxLogScroll = Math.max(0, transcript.length - bodyHeight);
    this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, rows.length - bodyHeight)));
    this.lastMaxLogScroll = maxLogScroll;
    this.logScroll = this.followTail ? maxLogScroll : Math.min(Math.max(0, this.logScroll), maxLogScroll);
    if (this.ensureSelectionOnNextRender) {
      this.ensureSelectedVisible(rows, bodyHeight);
      this.ensureSelectionOnNextRender = false;
    }

    const title = ` ZOB Delegations · sort=${SORT_MODES[this.sortIndex]} `;
    const titleWidth = visibleWidth(title);
    const leftRule = "─".repeat(Math.max(0, Math.floor((inner - titleWidth) / 2)));
    const rightRule = "─".repeat(Math.max(0, inner - titleWidth - leftRule.length));
    const lines: string[] = [th.fg("border", `╭${leftRule}`) + th.fg("accent", title) + th.fg("border", `${rightRule}╮`)];

    const headerLeft = `${th.fg("accent", "Agents")} ${th.fg("muted", delegateCloseButton())}`;
    const selectedBadge = delegationSignalBadge(selected);
    const selectedBadgeText = formatDelegationSignalBadge(selectedBadge);
    const headerRight = selected
      ? `${th.fg(statusColor(selected.status), `${statusIcon(selected.status)} ${selected.agent}`)}${selectedBadgeText ? ` ${th.fg(delegationSignalColor(selectedBadge), selectedBadgeText)}` : ""} ${th.fg("dim", formatDuration(delegationDurationMs(selected)))} ${th.fg("accent", formatDelegationCostLabel(selected))} ${th.fg("muted", formatDelegationContextLabel(selected))}`
      : th.fg("warning", "No delegation selected");
    lines.push(this.row(padToWidth(headerLeft, listWidth) + th.fg("dim", "│") + padToWidth(headerRight, logWidth), inner));
    lines.push(th.fg("border", `├${"─".repeat(listWidth)}┼${"─".repeat(logWidth)}┤`));

    const visibleRows = rows.slice(this.listScroll, this.listScroll + bodyHeight);
    const visibleTranscript = transcript.slice(this.logScroll, this.logScroll + bodyHeight);
    const noMatch = this.noMatchMessage(rows);
    for (let index = 0; index < bodyHeight; index++) {
      const listRow = visibleRows[index];
      const logLine = visibleTranscript[index] ?? "";
      const left = listRow ? this.renderListRow(listRow, listWidth) : index === 0 && noMatch ? th.fg("warning", noMatch) : "";
      const right = truncateToWidth(logLine, logWidth, "…");
      lines.push(this.row(padToWidth(left, listWidth) + th.fg("dim", "│") + padToWidth(right, logWidth), inner));
    }

    const filterInfo = this.filter || this.filterEditing ? ` · filter=${this.filterEditing ? ">" : ""}${this.filter || "<type>"}` : "";
    const helpInfo = this.helpVisible
      ? " · help: / filter · ? hide help · Esc clears filter/closes · ↑↓ select · [] list · PgUp/PgDn feed · s sort · r refresh"
      : " · / filter · ? help";
    const noMatchInfo = noMatch ? ` · ${noMatch}` : "";
    const scrollInfo = `${rows.length} rows${filterInfo}${noMatchInfo} · list ${Math.min(this.listScroll + 1, rows.length || 1)}/${Math.max(1, rows.length)} · feed ${Math.min(this.logScroll + 1, transcript.length || 1)}/${Math.max(1, transcript.length)} · wheel over list/feed · click agent · [close]/Esc · ↑↓ select · [] list · PgUp/PgDn feed · End live-tail · s sort · r refresh${helpInfo}`;
    lines.push(th.fg("border", `├${"─".repeat(inner)}┤`));
    lines.push(this.row(th.fg("dim", truncateToWidth(scrollInfo, inner, "…")), inner));
    lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));
    return lines.map((line) => truncateToWidth(line, w, ""));
  }

  invalidate(): void {
    this.cachedTranscriptKey = undefined;
    this.cachedTranscriptLines = [];
  }

  dispose(): void {
    disableDelegationMouseMode(this.tui);
    this.runtimeState.delegationMouse.mouseReleaseEpoch++;
    if (this.runtimeState.delegationMouse.tui === this.tui) this.runtimeState.delegationMouse.enabled = false;
    this.runtimeState.delegationMouse.releasedUntilMs = undefined;
    if (this.runtimeState.delegationMouse.mouseReenableTimer) clearTimeout(this.runtimeState.delegationMouse.mouseReenableTimer);
    this.runtimeState.delegationMouse.mouseReenableTimer = undefined;
    this.runtimeState.delegationMouse.opening = false;
    if (this.runtimeState.delegationMouse.overlaySelect === this.overlaySelectHandler) this.runtimeState.delegationMouse.overlaySelect = undefined;
    if (this.runtimeState.delegationMouse.overlayClose === this.overlayCloseHandler) this.runtimeState.delegationMouse.overlayClose = undefined;
    if (this.runtimeState.delegationMouse.overlayScroll === this.overlayScrollHandler) this.runtimeState.delegationMouse.overlayScroll = undefined;
  }

  private close(): void {
    this.runtimeState.delegationMouse.suppressOpenUntilMs = Date.now() + 350;
    this.dispose();
    this.done();
  }

  private selectRun(runId: string): boolean {
    const rows = this.rows();
    if (!rows.some((row) => row.kind === "run" && row.id === runId)) return false;
    this.selectedRunId = runId;
    this.logScroll = 0;
    this.followTail = true;
    this.ensureSelectionOnNextRender = true;
    this.ensureSelectedVisible(rows);
    this.invalidate();
    return true;
  }

  private scrollTranscript(direction: "up" | "down"): boolean {
    if (direction === "up") {
      this.followTail = false;
      this.logScroll = Math.max(0, this.logScroll - 4);
    } else {
      this.logScroll += 4;
      if (this.logScroll >= this.lastMaxLogScroll) this.followTail = true;
    }
    return true;
  }

  private scrollList(direction: "up" | "down"): boolean {
    const maxListScroll = Math.max(0, this.rows().length - this.bodyHeight());
    this.listScroll = direction === "up" ? Math.max(0, this.listScroll - 4) : Math.min(maxListScroll, this.listScroll + 4);
    this.ensureSelectionOnNextRender = false;
    return true;
  }

  private isLeftPaneColumn(x: number | undefined): boolean {
    return typeof x === "number" && x > 1 && x <= this.lastListWidth + 1;
  }

  private rows(): OverlayRow[] {
    const nowMs = Date.now();
    const allRows = flattenRows(this.runtimeState.delegations, SORT_MODES[this.sortIndex] ?? "active", nowMs);
    const allRunRows = allRows.filter((row) => row.kind === "run" && row.run);
    const hinted = this.initialSelection ? this.findRunByHint(allRunRows, this.initialSelection) : undefined;
    this.initialSelectionNoMatch = Boolean(this.initialSelection?.trim() && !hinted);
    const rows = this.filterRows(allRows);
    const runRows = rows.filter((row) => row.kind === "run" && row.run);
    const filteredHint = hinted && rows.some((row) => row.id === hinted.id) ? hinted : undefined;
    if (!this.selectedRunId) this.selectedRunId = filteredHint?.id ?? runRows[0]?.id;
    if (this.selectedRunId && !rows.some((row) => row.id === this.selectedRunId && row.kind === "run")) this.selectedRunId = filteredHint?.id ?? runRows[0]?.id;
    return rows;
  }

  private findRunByHint(rows: OverlayRow[], hint: string): OverlayRow | undefined {
    const normalized = hint.trim().toLowerCase();
    if (!normalized) return undefined;
    return rows.find((row) => {
      const run = row.run;
      return Boolean(run && (run.id.toLowerCase().startsWith(normalized) || run.id.slice(0, 8).toLowerCase() === normalized || run.agent.toLowerCase() === normalized));
    });
  }

  private filterRows(rows: OverlayRow[]): OverlayRow[] {
    const needle = this.filter.trim().toLowerCase();
    if (!needle) return rows;
    const filtered: OverlayRow[] = [];
    let currentGroup: OverlayRow | undefined;
    let groupMatches = false;
    for (const row of rows) {
      if (row.kind === "group") {
        currentGroup = row;
        groupMatches = row.label.toLowerCase().includes(needle);
        continue;
      }
      if (!row.run) continue;
      const searchableRun = row.run as DelegationRunView & { failureKind?: string; taskPreview?: string };
      const haystack = [currentGroup?.label, row.id, searchableRun.agent, searchableRun.status, searchableRun.failureKind, searchableRun.taskPreview, formatDelegationSignalBadge(delegationSignalBadge(row.run))]
        .filter((part): part is string => typeof part === "string")
        .join(" ")
        .toLowerCase();
      if (!groupMatches && !haystack.includes(needle)) continue;
      if (currentGroup && filtered[filtered.length - 1]?.id !== currentGroup.id) filtered.push(currentGroup);
      filtered.push(row);
    }
    return filtered;
  }

  private selectedRun(rows: OverlayRow[]): DelegationRunView | undefined {
    return rows.find((row) => row.kind === "run" && row.id === this.selectedRunId)?.run;
  }

  private transcriptLines(run: DelegationRunView | undefined, width: number): string[] {
    const key = run ? `${delegationFeedFingerprint(run, this.repoRoot)}|${width}` : `none|${width}`;
    if (this.cachedTranscriptKey === key) return this.cachedTranscriptLines;
    this.cachedTranscriptKey = key;
    this.cachedTranscriptLines = renderDelegationFeedLines(run, this.repoRoot, width, this.theme);
    return this.cachedTranscriptLines;
  }

  private bodyHeight(): number {
    const terminalRows = (this.tui as { terminal?: { rows?: number } }).terminal?.rows;
    const availableRows = typeof terminalRows === "number" && Number.isFinite(terminalRows) ? terminalRows - 8 : 22;
    return Math.max(8, Math.min(22, availableRows));
  }

  private isPrintableInput(data: string): boolean {
    return data.length === 1 && data >= " " && data !== "\x7f";
  }

  private noMatchMessage(rows: OverlayRow[]): string | undefined {
    const hasRun = rows.some((row) => row.kind === "run" && row.run);
    if (this.filter.trim() && !hasRun) return `No matches for /${this.filter}`;
    if (this.initialSelectionNoMatch) return `No run matches initial selection ${this.initialSelection}`;
    return undefined;
  }

  private ensureSelectedVisible(rows: OverlayRow[], bodyHeight = this.bodyHeight()): void {
    const selectedIndex = rows.findIndex((row) => row.id === this.selectedRunId);
    if (selectedIndex < 0) return;
    if (selectedIndex < this.listScroll) this.listScroll = selectedIndex;
    if (selectedIndex >= this.listScroll + bodyHeight) this.listScroll = selectedIndex - bodyHeight + 1;
    this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, rows.length - bodyHeight)));
  }

  private renderListRow(row: OverlayRow, width: number): string {
    const th = this.theme;
    if (row.kind === "group") return th.fg("muted", truncateToWidth(row.label, width, "…"));
    const selected = row.id === this.selectedRunId;
    const run = row.run;
    if (!run) return "";
    const duration = formatDuration(delegationDurationMs(run));
    const cost = formatDelegationCostLabel(run);
    const context = formatDelegationContextLabel(run);
    const badge = formatDelegationSignalBadge(delegationSignalBadge(run));
    const base = `${row.label}${badge ? ` ${badge}` : ""} ${duration} ${cost} ${context} [view]`;
    const labeled = `${truncateToWidth(base, width - (selected ? 2 : 0), "…")}${delegateSelectMarker(run.id)}`;
    const colored = th.fg(statusColor(run.status), labeled);
    return selected ? th.bg("selectedBg", padToWidth(colored, width)) : colored;
  }

  private row(content: string, innerWidth: number): string {
    return this.theme.fg("border", "│") + padToWidth(content, innerWidth) + this.theme.fg("border", "│");
  }
}

export async function showDelegationOverlay(ctx: ExtensionContext, state: HarnessRuntimeState, initialSelection?: string): Promise<void> {
  if (!ctx.hasUI) return;
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new DelegationOverlayComponent(state, ctx.cwd, theme, done, initialSelection, tui), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 2 },
  });
}
