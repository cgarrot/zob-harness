import type { AssistantLikeMessage, JsonEvent, TextBlock } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textFromMessage(message: AssistantLikeMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is TextBlock => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function parseJsonLine(line: string): JsonEvent | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) return undefined;
    return value as JsonEvent;
  } catch {
    return undefined;
  }
}

export { isRecord, parseJsonLine, textFromMessage };
