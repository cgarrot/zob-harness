import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import { isRecord } from "../core/utils/records.js";
import { sanitizeDelegationText } from "./delegation-markdown.js";

const ACTIVITY_MAX_BYTES = 180_000;
const DEFAULT_RECENT_LIMIT = 5;

export type DelegationActivityStatus = "running" | "success" | "error";

export interface DelegationActivity {
  toolCallId: string;
  toolName: string;
  status: DelegationActivityStatus;
  startedAtMs?: number;
  endedAtMs?: number;
  elapsedMs?: number;
  command?: string;
  timeoutMs?: number;
  target?: string;
  summary?: string;
  outputSummary?: string;
  errorSummary?: string;
}

export interface DelegationActivitySnapshot {
  status: "ok" | "missing" | "blocked" | "empty";
  note?: string;
  fingerprint: string;
  current?: DelegationActivity;
  recent: DelegationActivity[];
  lastUpdatedMs?: number;
  quietMs?: number;
}

function normalizePath(path: string): string {
  return resolve(path);
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function readTail(path: string, size: number, maxBytes: number): string {
  if (size <= maxBytes) {
    const buffer = Buffer.alloc(size);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, size, 0);
    } finally {
      closeSync(fd);
    }
    return buffer.toString("utf8");
  }
  const buffer = Buffer.alloc(maxBytes);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, maxBytes, Math.max(0, size - maxBytes));
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  const firstNewline = text.indexOf("\n");
  const safeTail = firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  return `{"type":"custom","customType":"zob-activity-tail-capped","data":{"omittedBytes":${size - maxBytes}}}\n${safeTail}`;
}

function timestampMs(entry: Record<string, unknown>): number | undefined {
  if (typeof entry.timestamp !== "string") return undefined;
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function redactDelegationCommand(command: string): string {
  return sanitizeDelegationText(command)
    .replace(/\b([A-Z0-9_]*(?:DATABASE_URL|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, "$1=<redacted>")
    .replace(/(Authorization\s*:\s*Bearer\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>")
    .replace(/\b(--(?:password|passwd|token|secret|api-key|access-key|private-key|database-url)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>")
    .replace(/\b(-H\s+["']?Authorization\s*:\s*Bearer\s+)([^"'\s]+)/gi, "$1<redacted>");
}

function capInline(value: string, limit: number): string {
  const compact = compactWhitespace(sanitizeDelegationText(value));
  if (compact.length <= limit) return compact;
  const head = Math.max(8, Math.floor(limit * 0.65));
  const tail = Math.max(4, limit - head - 1);
  return `${compact.slice(0, head)}…${compact.slice(-tail)}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return sanitizeDelegationText(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(sanitizeDelegationText(part.text));
    else if (part.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

function toolArguments(part: Record<string, unknown>): Record<string, unknown> {
  const direct = part.arguments ?? part.args ?? part.input;
  return isRecord(direct) ? direct : {};
}

function toolName(part: Record<string, unknown>): string {
  return typeof part.name === "string" ? part.name : typeof part.toolName === "string" ? part.toolName : "tool";
}

function timeoutMsFromArgs(args: Record<string, unknown>): number | undefined {
  const raw = args.timeout ?? args.timeout_ms ?? args.timeoutMs;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  // Pi bash tool accepts timeout in seconds; keep millisecond values if callers already use them.
  return raw > 10_000 ? Math.floor(raw) : Math.floor(raw * 1000);
}

function activityFromToolCall(entry: Record<string, unknown>, part: Record<string, unknown>): DelegationActivity | undefined {
  const id = typeof part.id === "string" ? part.id : undefined;
  if (!id) return undefined;
  const name = toolName(part);
  const lower = name.toLowerCase();
  const args = toolArguments(part);
  const startedAtMs = timestampMs(entry);
  const activity: DelegationActivity = {
    toolCallId: id,
    toolName: name,
    status: "running",
    startedAtMs,
    timeoutMs: timeoutMsFromArgs(args),
  };

  const path = typeof args.path === "string" ? args.path : typeof args.file === "string" ? args.file : undefined;
  if (lower === "bash") {
    const command = typeof args.command === "string" ? redactDelegationCommand(args.command) : undefined;
    activity.command = command;
    activity.summary = command ? capInline(command, 140) : "shell command";
  } else if (lower === "read") {
    activity.target = path;
    activity.summary = path ? `read ${path}` : "read file";
  } else if (lower === "grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : typeof args.query === "string" ? args.query : undefined;
    activity.target = path;
    activity.summary = `grep ${pattern ? capInline(pattern, 60) : "pattern"}${path ? ` in ${path}` : ""}`;
  } else if (lower === "find") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "files";
    activity.target = path;
    activity.summary = `find ${capInline(pattern, 60)}${path ? ` in ${path}` : ""}`;
  } else if (lower === "edit" || lower === "write") {
    activity.target = path;
    const edits = Array.isArray(args.edits) ? ` · ${args.edits.length} edit${args.edits.length === 1 ? "" : "s"}` : "";
    activity.summary = `${lower} ${path ?? "file"}${edits}`;
  } else if (lower === "delegate_task" || lower === "delegate_agent") {
    const agent = typeof args.agent === "string" ? args.agent : undefined;
    activity.summary = `${lower}${agent ? ` → ${agent}` : ""}`;
  } else {
    activity.summary = Object.entries(args).length > 0
      ? `${name} ${Object.entries(args).slice(0, 3).map(([key, value]) => `${key}=${typeof value === "string" ? capInline(value, 40) : Array.isArray(value) ? `${value.length} items` : String(value)}`).join(" ")}`
      : name;
  }

  return activity;
}

function resultSummary(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const compact = compactWhitespace(trimmed);
  const timeout = compact.match(/Command timed out after\s+([0-9.]+)\s+seconds/i);
  if (timeout) return `timed out after ${timeout[1]}s`;
  const lineCount = trimmed.split("\n").length;
  if (lineCount > 1 || trimmed.length > 120) return `${lineCount} line${lineCount === 1 ? "" : "s"} · ${trimmed.length} chars`;
  return capInline(trimmed, 140);
}

function applyToolResult(entry: Record<string, unknown>, message: Record<string, unknown>, byId: Map<string, DelegationActivity>, order: DelegationActivity[]): void {
  const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  const name = typeof message.toolName === "string" ? message.toolName : "tool";
  if (!id) return;
  let activity = byId.get(id);
  if (!activity) {
    activity = { toolCallId: id, toolName: name, status: "running" };
    byId.set(id, activity);
    order.push(activity);
  }
  const endedAtMs = timestampMs(entry);
  activity.endedAtMs = endedAtMs;
  activity.elapsedMs = activity.startedAtMs && endedAtMs ? Math.max(0, endedAtMs - activity.startedAtMs) : undefined;
  activity.status = message.isError === true ? "error" : "success";
  const text = contentText(message.content);
  const summary = resultSummary(text);
  if (message.isError === true) activity.errorSummary = summary ?? "tool error";
  else activity.outputSummary = summary ?? "completed";
}

function parseActivityText(text: string, nowMs: number): { recent: DelegationActivity[]; current?: DelegationActivity; lastUpdatedMs?: number } {
  const byId = new Map<string, DelegationActivity>();
  const order: DelegationActivity[] = [];
  let lastUpdatedMs: number | undefined;

  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const at = timestampMs(parsed);
    if (at !== undefined) lastUpdatedMs = lastUpdatedMs === undefined ? at : Math.max(lastUpdatedMs, at);

    if (parsed.type === "message" && isRecord(parsed.message)) {
      const message = parsed.message;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!isRecord(part) || part.type !== "toolCall") continue;
          const activity = activityFromToolCall(parsed, part);
          if (!activity) continue;
          byId.set(activity.toolCallId, activity);
          order.push(activity);
        }
      } else if (message.role === "toolResult") {
        applyToolResult(parsed, message, byId, order);
      }
    }
  }

  for (const activity of order) {
    if (activity.status === "running" && activity.startedAtMs !== undefined) activity.elapsedMs = Math.max(0, nowMs - activity.startedAtMs);
  }
  const current = [...order].reverse().find((activity) => activity.status === "running");
  return { recent: order.slice(-DEFAULT_RECENT_LIMIT), current, lastUpdatedMs };
}

export function readDelegationActivitySnapshot(sessionPath: string | undefined, repoRoot: string, nowMs = Date.now()): DelegationActivitySnapshot {
  if (!sessionPath) return { status: "missing", note: "Child session is not captured yet.", fingerprint: "no-session", recent: [] };
  const resolved = resolve(sessionPath);
  if (!isInside(repoRoot, resolved)) {
    return { status: "blocked", note: `Child session path is outside repo root: ${sessionPath}`, fingerprint: `blocked:${sessionPath}`, recent: [] };
  }
  if (!existsSync(resolved)) return { status: "missing", note: `Child session file not found yet: ${sessionPath}`, fingerprint: `missing:${sessionPath}`, recent: [] };
  const stat = statSync(resolved);
  if (stat.size === 0) return { status: "empty", note: "Child session file is empty.", fingerprint: `${resolved}:0:${Math.floor(stat.mtimeMs)}`, recent: [], lastUpdatedMs: Math.floor(stat.mtimeMs), quietMs: Math.max(0, nowMs - stat.mtimeMs) };
  const text = readTail(resolved, stat.size, ACTIVITY_MAX_BYTES);
  const parsed = parseActivityText(text, nowMs);
  const lastUpdatedMs = parsed.lastUpdatedMs ?? Math.floor(stat.mtimeMs);
  const cappedNote = stat.size > ACTIVITY_MAX_BYTES ? `Activity feed read from last ${ACTIVITY_MAX_BYTES} bytes of ${stat.size} bytes.` : undefined;
  return {
    status: "ok",
    note: cappedNote,
    fingerprint: `${resolved}:${stat.size}:${Math.floor(stat.mtimeMs)}`,
    recent: parsed.recent,
    current: parsed.current,
    lastUpdatedMs,
    quietMs: Math.max(0, nowMs - Math.max(lastUpdatedMs, Math.floor(stat.mtimeMs))),
  };
}

export function formatActivityDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad2 = (value: number): string => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

export function formatActivitySummary(activity: DelegationActivity, options: { includeCommand?: boolean; nowMs?: number } = {}): string[] {
  const icon = activity.status === "running" ? "◉" : activity.status === "success" ? "✓" : "✗";
  const duration = formatActivityDuration(activity.elapsedMs ?? (activity.status === "running" && activity.startedAtMs ? (options.nowMs ?? Date.now()) - activity.startedAtMs : undefined));
  const timeout = formatActivityDuration(activity.timeoutMs);
  const detail = activity.status === "running"
    ? [duration ? `running ${duration}` : "running", timeout ? `timeout ${timeout}` : undefined].filter(Boolean).join(" / ")
    : activity.errorSummary ?? activity.outputSummary ?? (activity.status === "success" ? "done" : "error");
  const summary = activity.summary ?? activity.command ?? activity.target ?? activity.toolName;
  const lines = [`${icon} ${activity.toolName}${detail ? ` · ${detail}` : ""}${summary && activity.toolName.toLowerCase() !== summary.toLowerCase() ? ` · ${summary}` : ""}`];
  if (options.includeCommand && activity.command) lines.push(`$ ${activity.command}`);
  return lines;
}
