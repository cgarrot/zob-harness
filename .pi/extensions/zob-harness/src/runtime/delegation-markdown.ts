import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

import { buildDelegationLogLines, type DelegationRunView } from "./delegation-monitor.js";

export function sanitizeDelegationText(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function humanizeTag(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function formatKeyValue(line: string): string | undefined {
  const match = line.match(/^([A-Za-z][A-Za-z0-9 _/-]{1,40}):\s*(.*)$/);
  if (!match) return undefined;
  const key = match[1].trim();
  const value = match[2].trim();
  if (!value) return `- **${key}:** _empty_`;
  if (/^(session|cwd|path|file)$/i.test(key)) return `- **${key}:** ${inlineCode(value)}`;
  return `- **${key}:** ${value}`;
}

function prettifyLogLine(line: string): string | undefined {
  line = sanitizeDelegationText(line);
  const trimmed = line.trim();
  if (!trimmed) return "";

  const singleTag = trimmed.match(/^<([A-Za-z0-9_-]+)>([\s\S]*)<\/\1>$/);
  if (singleTag) {
    const value = singleTag[2].trim();
    return `- **${humanizeTag(singleTag[1])}:** ${value || "_empty_"}`;
  }

  const openTag = trimmed.match(/^<([A-Za-z0-9_-]+)>$/);
  if (openTag) return `#### ${humanizeTag(openTag[1])}`;
  if (/^<\/[A-Za-z0-9_-]+>$/.test(trimmed)) return undefined;

  const section = trimmed.match(/^\[([^\]]+)\](?:\s*(.*))?$/);
  if (section) {
    const label = section[1].trim();
    const rest = section[2]?.trim() ?? "";
    if (/^delegation\s+/i.test(label)) return `# ${label.replace(/^delegation\s+/i, "Delegation ")}`;
    if (/^(assistant|user|system)$/i.test(label)) return `### ${humanizeTag(label)}`;
    if (/^tool result:/i.test(label)) return `### Tool result: ${inlineCode(label.replace(/^tool result:\s*/i, ""))}`;
    if (/^custom message:/i.test(label)) return `### Custom message: ${label.replace(/^custom message:\s*/i, "")}`;
    if (/^(task preview|assistant output preview|stderr preview|conversation|session|model|thinking|compaction|branch summary)$/i.test(label)) {
      const title = humanizeTag(label);
      return rest ? `## ${title}\n${rest}` : `## ${title}`;
    }
    return rest ? `### ${humanizeTag(label)}\n${rest}` : `### ${humanizeTag(label)}`;
  }

  return formatKeyValue(trimmed) ?? line;
}

export function buildDelegationMarkdown(run: DelegationRunView | undefined, repoRoot: string): string {
  if (!run) return "_No delegation selected._";
  const raw = buildDelegationLogLines(run, repoRoot);
  const pretty = raw.map((line) => prettifyLogLine(sanitizeDelegationText(line))).filter((line): line is string => line !== undefined);
  return pretty.join("\n").replace(/\n{3,}/g, "\n\n");
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

export function renderDelegationMarkdownLines(run: DelegationRunView | undefined, repoRoot: string, width: number, theme: Theme): string[] {
  const markdown = buildDelegationMarkdown(run, repoRoot);
  const renderer = new Markdown(markdown, 0, 0, markdownTheme(theme), { color: (text) => theme.fg("text", text) });
  return renderer.render(Math.max(1, width));
}
