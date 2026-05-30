import { visibleWidth } from "@earendil-works/pi-tui";

const DELEGATE_VIEW_MARKER_PREFIX = "\x1b_zob-delegate:";
const DELEGATE_SELECT_MARKER_PREFIX = "\x1b_zob-delegate-select:";
const DELEGATE_CLOSE_MARKER = "\x1b_zob-delegate-close:\x07";
const VIEW_LABEL = "[view]";
const CLOSE_LABEL = "[close]";

export type DelegationClickAction = { kind: "view" | "select"; runId: string; agent?: string; status?: "queued" | "running" | "complete" | "failed" | "preflight_failed" | "aborted" } | { kind: "close" };

export function delegateViewLink(runId: string, label = VIEW_LABEL): string {
  const safeRunId = sanitizeRunId(runId);
  return `${label}${DELEGATE_VIEW_MARKER_PREFIX}${safeRunId}\x07`;
}

export function delegateSelectMarker(runId: string): string {
  const safeRunId = sanitizeRunId(runId);
  return `${DELEGATE_SELECT_MARKER_PREFIX}${safeRunId}\x07`;
}

export function delegateCloseButton(label = CLOSE_LABEL): string {
  return `${label}${DELEGATE_CLOSE_MARKER}`;
}

export function findDelegateRunIdAtColumn(line: string, column: number): string | undefined {
  const action = findDelegateActionAtColumn(line, column);
  return action?.kind === "view" ? action.runId : undefined;
}

export function findDelegateActionAtColumn(line: string, column: number, options: { wholeRowFallback?: boolean } = { wholeRowFallback: false }): DelegationClickAction | undefined {
  let visibleColumn = 1;
  let visibleText = "";
  let pendingViewSpan: { start: number; end: number } | undefined;
  let pendingCloseSpan: { start: number; end: number } | undefined;
  for (let index = 0; index < line.length;) {
    if (line.startsWith(DELEGATE_VIEW_MARKER_PREFIX, index)) {
      const markerStart = index + DELEGATE_VIEW_MARKER_PREFIX.length;
      const terminator = findEscapeTerminator(line, markerStart);
      if (!terminator) break;
      const runId = line.slice(markerStart, terminator.end) || undefined;
      if (runId && pendingViewSpan && column >= pendingViewSpan.start && column < pendingViewSpan.end) return { kind: "view", runId };
      pendingViewSpan = undefined;
      index = terminator.end + terminator.length;
      continue;
    }
    if (line.startsWith(DELEGATE_SELECT_MARKER_PREFIX, index)) {
      const markerStart = index + DELEGATE_SELECT_MARKER_PREFIX.length;
      const terminator = findEscapeTerminator(line, markerStart);
      if (!terminator) break;
      const runId = line.slice(markerStart, terminator.end) || undefined;
      if (runId && column >= 2 && column < visibleColumn) return { kind: "select", runId };
      index = terminator.end + terminator.length;
      continue;
    }
    if (line.startsWith(DELEGATE_CLOSE_MARKER, index)) {
      if (pendingCloseSpan && column >= pendingCloseSpan.start && column < pendingCloseSpan.end) return { kind: "close" };
      pendingCloseSpan = undefined;
      index += DELEGATE_CLOSE_MARKER.length;
      continue;
    }
    if (line[index] === "\x1b") {
      index = skipAnsiEscape(line, index);
      continue;
    }
    if (line.startsWith(VIEW_LABEL, index)) {
      const start = visibleColumn;
      const width = visibleWidth(VIEW_LABEL);
      pendingViewSpan = { start, end: start + width };
      visibleText += VIEW_LABEL;
      visibleColumn += width;
      index += VIEW_LABEL.length;
      continue;
    }
    if (line.startsWith(CLOSE_LABEL, index)) {
      const start = visibleColumn;
      const width = visibleWidth(CLOSE_LABEL);
      pendingCloseSpan = { start, end: start + width };
      visibleText += CLOSE_LABEL;
      visibleColumn += width;
      index += CLOSE_LABEL.length;
      continue;
    }
    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    visibleText += char;
    visibleColumn += Math.max(visibleWidth(char), 0);
    index += char.length;
  }
  const fallback = findVisibleRunBeforeView(visibleText);
  if (fallback && pendingViewSpan && column >= pendingViewSpan.start && column < pendingViewSpan.end) return { kind: "view", ...fallback };
  if (options.wholeRowFallback === true && fallback && visibleText.includes(VIEW_LABEL) && column >= 2 && column < visibleColumn) return { kind: "view", ...fallback };
  return undefined;
}

function findVisibleRunBeforeView(visibleText: string): { runId: string; agent?: string; status?: "queued" | "running" | "complete" | "failed" | "preflight_failed" | "aborted" } | undefined {
  const viewIndex = visibleText.lastIndexOf(VIEW_LABEL);
  const beforeView = viewIndex >= 0 ? visibleText.slice(0, viewIndex) : visibleText;
  const matches = [...beforeView.matchAll(/\b((?:delegate|task)_[A-Za-z0-9_.:-]+)/g)];
  const match = matches.at(-1);
  const runId = match?.[1] ? sanitizeRunId(match[1]) : undefined;
  if (!runId) return undefined;
  const prefix = beforeView.slice(0, match?.index ?? 0).trimEnd();
  const tokens = prefix.split(/\s+/).filter(Boolean);
  const statusGlyph = [...tokens].reverse().find((token) => ["○", "●", "✓", "✗", "▲", "■"].includes(token));
  const status = statusGlyph === "○" ? "queued" : statusGlyph === "●" ? "running" : statusGlyph === "✓" ? "complete" : statusGlyph === "✗" ? "failed" : statusGlyph === "▲" ? "preflight_failed" : statusGlyph === "■" ? "aborted" : undefined;
  const agent = tokens.at(-1);
  const safeAgent = agent && !["○", "●", "✓", "✗", "▲", "■"].includes(agent) && !agent.includes("─") ? sanitizeRunId(agent) : undefined;
  return { runId, ...(safeAgent ? { agent: safeAgent } : {}), ...(status ? { status } : {}) };
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_.:-]/g, "");
}

function findEscapeTerminator(text: string, start: number): { end: number; length: number } | undefined {
  const bel = text.indexOf("\x07", start);
  const st = text.indexOf("\x1b\\", start);
  if (bel === -1 && st === -1) return undefined;
  if (bel !== -1 && (st === -1 || bel < st)) return { end: bel, length: 1 };
  return { end: st, length: 2 };
}

function skipAnsiEscape(text: string, index: number): number {
  if (text[index] !== "\x1b") return index + 1;
  const next = text[index + 1];
  if (next === "]" || next === "_") {
    const terminator = findEscapeTerminator(text, index + 2);
    return terminator ? terminator.end + terminator.length : text.length;
  }
  if (next === "[") {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      cursor += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return cursor;
  }
  return Math.min(text.length, index + 2);
}
