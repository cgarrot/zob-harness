import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";

import { delegationDurationMs, delegationSignalBadge, delegationSignalColor, formatDelegationContextLabel, formatDelegationCostLabel, formatDelegationModelLabel, formatDelegationSignalBadge, formatDuration, statusIcon, type DelegationRunView } from "./delegation-monitor.js";
import { sanitizeDelegationText } from "./delegation-markdown.js";
import { isRecord } from "../core/utils/records.js";

const FEED_MAX_BYTES = 240_000;
const FEED_MAX_LINES = 1_200;
const BLOCK_MAX_CHARS = 32_000;

type ThemeFg = Parameters<Theme["fg"]>[0];
type ThemeBg = Parameters<Theme["bg"]>[0];

interface SessionReadResult {
  status: "ok" | "missing" | "blocked" | "empty";
  path?: string;
  text?: string;
  note?: string;
  fingerprint: string;
}

function normalizePath(path: string): string {
  return resolve(path);
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function capText(text: string, limit = BLOCK_MAX_CHARS): string {
  text = sanitizeDelegationText(text);
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = Math.max(0, limit - head);
  return `${text.slice(0, head)}\n\n[… ${text.length - limit} chars omitted from subagent feed …]\n\n${text.slice(-tail)}`;
}

function readCapped(path: string, size: number, maxBytes: number): string {
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const headBytes = Math.floor(maxBytes * 0.55);
  const tailBytes = Math.max(0, maxBytes - headBytes);
  const head = Buffer.alloc(headBytes);
  const tail = Buffer.alloc(tailBytes);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, headBytes, 0);
    readSync(fd, tail, 0, tailBytes, Math.max(0, size - tailBytes));
  } finally {
    closeSync(fd);
  }
  return `${head.toString("utf8")}\n{"type":"custom","customType":"zob-transcript-truncated","data":{"omittedBytes":${size - maxBytes}}}\n${tail.toString("utf8")}`;
}

function readSession(sessionPath: string | undefined, repoRoot: string): SessionReadResult {
  if (!sessionPath) return { status: "missing", note: "Child session is not captured yet.", fingerprint: "no-session" };
  const resolved = resolve(sessionPath);
  if (!isInside(repoRoot, resolved)) {
    return { status: "blocked", path: sessionPath, note: `Child session path is outside repo root: ${sessionPath}`, fingerprint: `blocked:${sessionPath}` };
  }
  if (!existsSync(resolved)) return { status: "missing", path: sessionPath, note: `Child session file not found yet: ${sessionPath}`, fingerprint: `missing:${sessionPath}` };
  const stat = statSync(resolved);
  const text = readCapped(resolved, stat.size, FEED_MAX_BYTES);
  const status = text.trim() ? "ok" : "empty";
  return {
    status,
    path: resolved,
    text,
    note: stat.size > FEED_MAX_BYTES ? `Child session capped to ${FEED_MAX_BYTES} bytes from ${stat.size} bytes.` : undefined,
    fingerprint: `${resolved}:${stat.size}:${Math.floor(stat.mtimeMs)}`,
  };
}

function sessionFingerprint(sessionPath: string | undefined, repoRoot: string): string {
  if (!sessionPath) return "no-session";
  const resolved = resolve(sessionPath);
  if (!isInside(repoRoot, resolved)) return `blocked:${sessionPath}`;
  if (!existsSync(resolved)) return `missing:${sessionPath}`;
  const stat = statSync(resolved);
  return `${resolved}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

export function delegationFeedFingerprint(run: DelegationRunView | undefined, repoRoot: string): string {
  if (!run) return "none";
  return [
    run.id,
    run.status,
    run.sessionPath ?? "",
    sessionFingerprint(run.sessionPath, repoRoot),
    run.outputPreview.length,
    run.stderrPreview.length,
    run.endedAtMs ?? "running",
    run.exitCode ?? "",
    run.gatePassed ?? "",
    run.failureKind ?? "",
    run.usage?.cost ?? "",
    run.usage?.input ?? "",
    run.usage?.output ?? "",
    run.usage?.contextTokens ?? "",
    (run.gateErrors ?? []).join(";"),
    run.model ?? "",
  ].join("|");
}

function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
    codeBlockIndent: "  ",
  };
}

function humanizeTag(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeMarkdownText(text: string): string {
  return capText(text)
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const singleTag = trimmed.match(/^<([A-Za-z0-9_-]+)>([\s\S]*)<\/\1>$/);
      if (singleTag) return `- **${humanizeTag(singleTag[1])}:** ${singleTag[2].trim() || "_empty_"}`;
      const openTag = trimmed.match(/^<([A-Za-z0-9_-]+)>$/);
      if (openTag) return `#### ${humanizeTag(openTag[1])}`;
      if (/^<\/[A-Za-z0-9_-]+>$/.test(trimmed)) return "";
      return line;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function renderMarkdown(text: string, width: number, theme: Theme, colorKey: ThemeFg = "text", paddingX = 1): string[] {
  const normalized = normalizeMarkdownText(text).trim();
  if (!normalized) return [];
  const renderer = new Markdown(normalized, paddingX, 0, markdownTheme(theme), { color: (value) => theme.fg(colorKey, value) });
  return renderer.render(Math.max(1, width));
}

function pushSpacer(lines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
}

function boxed(lines: string[], label: string, body: string, width: number, theme: Theme, bgKey: ThemeBg, textKey: ThemeFg): void {
  pushSpacer(lines);
  lines.push(theme.bg(bgKey, padToWidth(` ${label} `, width)));
  for (const rendered of renderMarkdown(body, Math.max(1, width - 2), theme, textKey, 1)) {
    lines.push(theme.bg(bgKey, padToWidth(rendered, width)));
  }
}

function actionCard(lines: string[], title: string, details: string[], width: number, theme: Theme, status: "pending" | "success" | "error" = "pending"): void {
  pushSpacer(lines);
  const bgKey = status === "error" ? "toolErrorBg" : status === "success" ? "toolSuccessBg" : "toolPendingBg";
  const titleKey = status === "error" ? "error" : status === "success" ? "success" : "toolTitle";
  lines.push(theme.bg(bgKey, padToWidth(theme.fg(titleKey, theme.bold(` ${title}`)), width)));
  for (const detail of details.filter(Boolean)) {
    lines.push(theme.bg(bgKey, padToWidth(theme.fg("toolOutput", `   ${detail}`), width)));
  }
}

function failureDetails(run: DelegationRunView, fallback: string): string[] {
  const details: string[] = [];
  if (run.errorMessage) details.push(`message: ${sanitizeDelegationText(run.errorMessage)}`);
  if (run.stopReason) details.push(`stopReason: ${sanitizeDelegationText(run.stopReason)}`);
  if (run.exitCode !== undefined) details.push(`exitCode: ${run.exitCode}`);
  if (run.stopCondition) details.push(`stopCondition: ${sanitizeDelegationText(run.stopCondition)}`);
  return details.length > 0 ? details : [fallback];
}

function contentText(content: unknown, options: { includeThinking?: boolean } = {}): string {
  if (typeof content === "string") return sanitizeDelegationText(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(sanitizeDelegationText(part.text));
    else if (part.type === "thinking" && options.includeThinking && typeof part.thinking === "string") parts.push(sanitizeDelegationText(part.thinking));
    else if (part.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    const safeValue = sanitizeDelegationText(value);
    const compact = safeValue.replace(/\s+/g, " ").trim();
    if (!compact) return "empty string";
    if (safeValue.includes("\n")) return `${safeValue.split("\n").length} lines · ${safeValue.length} chars`;
    return compact.length <= 90 ? compact : `${compact.slice(0, 87)}…`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isRecord(value)) return `object(${Object.keys(value).slice(0, 5).join(", ") || "empty"})`;
  if (value === null || value === undefined) return "empty";
  return String(value);
}

function toolArguments(part: Record<string, unknown>): Record<string, unknown> {
  const direct = part.arguments ?? part.args ?? part.input;
  return isRecord(direct) ? direct : {};
}

function toolName(part: Record<string, unknown>): string {
  return typeof part.name === "string" ? part.name : typeof part.toolName === "string" ? part.toolName : "tool";
}

function toolDetails(name: string, args: Record<string, unknown>): string[] {
  const lower = name.toLowerCase();
  const path = typeof args.path === "string" ? args.path : typeof args.file === "string" ? args.file : undefined;
  if (lower === "read") return [path ? `file: ${path}` : "read file"];
  if (lower === "write") {
    const content = typeof args.content === "string" ? args.content : undefined;
    return [path ? `file: ${path}` : "write file", content ? `content: ${content.split("\n").length} lines · ${content.length} chars` : undefined].filter((value): value is string => Boolean(value));
  }
  if (lower === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits.length : undefined;
    return [path ? `file: ${path}` : "edit file", edits !== undefined ? `replacements: ${edits}` : undefined].filter((value): value is string => Boolean(value));
  }
  if (lower === "bash") {
    const command = typeof args.command === "string" ? args.command : undefined;
    return command ? [`$ ${command}`] : ["run shell command"];
  }
  if (lower === "delegate_agent") {
    if (Array.isArray(args.tasks)) return [`parallel delegates: ${args.tasks.length}`];
    if (Array.isArray(args.chain)) return [`chain delegates: ${args.chain.length}`];
    return [typeof args.agent === "string" ? `agent: ${args.agent}` : "delegate agent"];
  }
  if (lower === "delegate_task") return [typeof args.agent === "string" ? `agent: ${args.agent}` : "delegate task"];
  if (lower === "factory_run") return [`factory: ${summarizeValue(args.factory)}`, `mode: ${summarizeValue(args.mode)}`];
  if (lower === "orchestrate_run") return [`goal: ${summarizeValue(args.goal)}`];
  return Object.entries(args).slice(0, 6).map(([key, value]) => `${key}: ${summarizeValue(value)}`);
}

function renderToolCall(part: Record<string, unknown>, lines: string[], width: number, theme: Theme): void {
  const name = toolName(part);
  actionCard(lines, `◉ ${name}`, toolDetails(name, toolArguments(part)), width, theme, "pending");
}

function renderToolResult(message: Record<string, unknown>, lines: string[], width: number, theme: Theme): void {
  const name = typeof message.toolName === "string" ? message.toolName : "tool";
  const isError = message.isError === true;
  const text = contentText(message.content);
  actionCard(lines, `${isError ? "✗" : "✓"} ${name}`, text ? [] : ["completed"], width, theme, isError ? "error" : "success");
  if (text.trim()) lines.push(...renderMarkdown(text, width, theme, isError ? "error" : "toolOutput", 1));
}

function renderAssistantContent(message: Record<string, unknown>, lines: string[], width: number, theme: Theme): void {
  const content = message.content;
  if (typeof content === "string") {
    pushSpacer(lines);
    lines.push(...renderMarkdown(content, width, theme, "text", 1));
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      pushSpacer(lines);
      lines.push(...renderMarkdown(part.text, width, theme, "text", 1));
    } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
      pushSpacer(lines);
      for (const rendered of renderMarkdown(part.thinking, width, theme, "thinkingText", 1)) lines.push(theme.italic(rendered));
    } else if (part.type === "toolCall") {
      renderToolCall(part, lines, width, theme);
    } else if (part.type === "image") {
      actionCard(lines, "□ image", ["image content captured in child session"], width, theme, "pending");
    }
  }
}

function renderBashExecution(message: Record<string, unknown>, lines: string[], width: number, theme: Theme): void {
  const command = typeof message.command === "string" ? sanitizeDelegationText(message.command) : "bash";
  const output = typeof message.output === "string" ? sanitizeDelegationText(message.output) : "";
  const cancelled = message.cancelled === true;
  const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
  const status = cancelled || (exitCode !== undefined && exitCode !== 0) ? "error" : "success";
  actionCard(lines, `$ ${command}`, [cancelled ? "cancelled" : exitCode !== undefined ? `exit ${exitCode}` : "running"], width, theme, status);
  if (output.trim()) lines.push(...renderMarkdown(`\`\`\`text\n${capText(output, 12_000)}\n\`\`\``, width, theme, "toolOutput", 1));
}

function renderMessageEntry(message: Record<string, unknown>, lines: string[], width: number, theme: Theme): void {
  const role = typeof message.role === "string" ? message.role : "message";
  if (role === "user") boxed(lines, "You / task", contentText(message.content), width, theme, "userMessageBg", "userMessageText");
  else if (role === "assistant") renderAssistantContent(message, lines, width, theme);
  else if (role === "toolResult") renderToolResult(message, lines, width, theme);
  else if (role === "bashExecution") renderBashExecution(message, lines, width, theme);
  else if (role === "custom") boxed(lines, typeof message.customType === "string" ? message.customType : "custom", contentText(message.content), width, theme, "customMessageBg", "customMessageText");
  else if (role === "branchSummary" && typeof message.summary === "string") boxed(lines, "Branch summary", message.summary, width, theme, "customMessageBg", "customMessageText");
  else if (role === "compactionSummary" && typeof message.summary === "string") boxed(lines, "Compaction", message.summary, width, theme, "customMessageBg", "customMessageText");
}

function renderSessionEntry(entry: Record<string, unknown>, lines: string[], width: number, theme: Theme): void {
  if (entry.type === "session") {
    const cwd = typeof entry.cwd === "string" ? entry.cwd : "unknown cwd";
    lines.push(theme.fg("dim", `session · ${cwd}`));
    return;
  }
  if (entry.type === "message" && isRecord(entry.message)) {
    renderMessageEntry(entry.message, lines, width, theme);
    return;
  }
  if (entry.type === "custom" && typeof entry.customType === "string") {
    if (entry.customType === "zob-transcript-truncated" && isRecord(entry.data) && typeof entry.data.omittedBytes === "number") {
      actionCard(lines, "… transcript capped", [`${entry.data.omittedBytes} bytes omitted`], width, theme, "pending");
      return;
    }
    actionCard(lines, `custom · ${entry.customType}`, isRecord(entry.data) ? Object.entries(entry.data).slice(0, 5).map(([key, value]) => `${key}: ${summarizeValue(value)}`) : [], width, theme, "pending");
    return;
  }
  if (entry.type === "custom_message") {
    const label = typeof entry.customType === "string" ? entry.customType : "custom message";
    boxed(lines, label, contentText(entry.content), width, theme, "customMessageBg", "customMessageText");
    return;
  }
  if (entry.type === "model_change") {
    const provider = typeof entry.provider === "string" ? entry.provider : "";
    const model = typeof entry.modelId === "string" ? entry.modelId : "";
    lines.push(theme.fg("muted", `model · ${provider}/${model}`.replace(/\/$/, "")));
    return;
  }
  if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
    lines.push(theme.fg("muted", `thinking · ${entry.thinkingLevel}`));
    return;
  }
  if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
    boxed(lines, entry.type === "compaction" ? "Compaction" : "Branch summary", entry.summary, width, theme, "customMessageBg", "customMessageText");
  }
}

function sessionContainsPreview(sessionText: string | undefined, preview: string): boolean {
  const trimmed = preview.trim();
  if (!sessionText || trimmed.length < 40) return false;
  return sessionText.includes(trimmed.slice(-Math.min(300, trimmed.length)));
}

function capLines(lines: string[]): string[] {
  if (lines.length <= FEED_MAX_LINES) return lines;
  const head = Math.floor(FEED_MAX_LINES * 0.45);
  const tail = Math.max(0, FEED_MAX_LINES - head - 2);
  return [...lines.slice(0, head), "", `[… ${lines.length - FEED_MAX_LINES} rendered feed lines omitted …]`, "", ...lines.slice(-tail)];
}

export function renderDelegationFeedLines(run: DelegationRunView | undefined, repoRoot: string, width: number, theme: Theme): string[] {
  if (!run) return [theme.fg("muted", "No delegation selected.")];
  const safeWidth = Math.max(20, width);
  const lines: string[] = [];
  const signalBadge = delegationSignalBadge(run);
  const signalText = formatDelegationSignalBadge(signalBadge);
  const modelLabel = formatDelegationModelLabel(run);
  lines.push(theme.fg("dim", `${statusIcon(run.status)} ${run.agent}${signalText ? ` · ${theme.fg(delegationSignalColor(signalBadge), signalText)}` : ""}${modelLabel ? ` · ${theme.fg("muted", `(${modelLabel})`)}` : ""} · ${run.status}${run.failureKind ? ` · ${run.failureKind}` : ""} · ${formatDuration(delegationDurationMs(run))} · ${formatDelegationCostLabel(run)} · ${formatDelegationContextLabel(run)}`));
  if (run.usage) lines.push(theme.fg("muted", `usage · in ${run.usage.input} · out ${run.usage.output} · cache ${run.usage.cacheRead}/${run.usage.cacheWrite} · context ${run.usage.contextTokens}`));
  if (run.taskPreview) lines.push(theme.fg("muted", `task · ${sanitizeDelegationText(run.taskPreview)}`));
  let renderedFailureSummary = false;
  if (run.failureKind === "preflight" || run.failureKind === "config") {
    renderedFailureSummary = true;
    actionCard(lines, "blocked before child launch", [run.errorMessage ?? "Parent preflight/config blocked dispatch."], safeWidth, theme, "error");
  }
  if (run.failureKind === "output_gate") {
    renderedFailureSummary = true;
    actionCard(lines, "output-contract gate", ["Inspect exact gate errors before relaunching.", ...[...new Set(run.gateErrors ?? [])]], safeWidth, theme, "error");
  }
  if (run.failureKind === "child_runtime") {
    renderedFailureSummary = true;
    actionCard(lines, "child runtime failure", failureDetails(run, "Child process failed before producing a valid result."), safeWidth, theme, "error");
  }
  if (run.failureKind === "aborted" || run.status === "aborted") {
    renderedFailureSummary = true;
    actionCard(lines, "delegation aborted", failureDetails(run, "Delegation was aborted before completion."), safeWidth, theme, "error");
  }

  const session = readSession(run.sessionPath, repoRoot);
  if (session.note) lines.push(theme.fg(session.status === "blocked" ? "error" : "muted", session.note));
  if (session.text) {
    for (const rawLine of session.text.split("\n")) {
      if (!rawLine.trim()) continue;
      try {
        const parsed = JSON.parse(rawLine) as unknown;
        if (isRecord(parsed)) renderSessionEntry(parsed, lines, safeWidth, theme);
      } catch {
        // Ignore malformed partial JSON lines while the child process is actively appending.
      }
      if (lines.length > FEED_MAX_LINES + 100) break;
    }
  }

  if (run.outputPreview.trim() && (run.status === "running" || !sessionContainsPreview(session.text, run.outputPreview))) {
    boxed(lines, run.status === "running" ? "Assistant live" : "Assistant output", run.outputPreview, safeWidth, theme, "customMessageBg", "customMessageText");
  }
  if (run.stderrPreview.trim()) actionCard(lines, "stderr", capText(run.stderrPreview, 8_000).split("\n").slice(0, 20), safeWidth, theme, "error");
  if (run.errorMessage && !renderedFailureSummary) actionCard(lines, "error", [sanitizeDelegationText(run.errorMessage)], safeWidth, theme, "error");
  if (lines.length <= 2 && !run.outputPreview.trim() && !run.stderrPreview.trim()) lines.push(theme.fg("muted", "Waiting for the child agent feed…"));
  return capLines(lines);
}
