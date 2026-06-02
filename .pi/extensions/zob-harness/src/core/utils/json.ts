import { existsSync, readFileSync } from "node:fs";
import { isRecord, parseJsonLine } from "./records.js";

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line)).filter(isRecord);
}

function readJsonObjectIfPresent(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseJsonFile(path);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readJsonlRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => parseJsonLine(line)).filter(isRecord);
}

export { parseJsonFile, readJsonl, readJsonlRecords, readJsonObjectIfPresent };
