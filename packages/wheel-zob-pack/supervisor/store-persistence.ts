import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { canonicalJson, sha256Text } from "./canonical.js";

const FORBIDDEN_DURABLE_KEY = /^(raw|rawBody|prompt|promptBody|transientPromptBody|output|outputBody|transcript|secret|secrets|credential|credentials|privateKey|apiKey)$/i;

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export function assertBodySafe(value: unknown, path = "value"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertBodySafe(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_DURABLE_KEY.test(key)) throw new Error(`${path}.${key} is forbidden in durable supervisor state`);
    if (key === "bodyStored" && nested !== false) throw new Error(`${path}.bodyStored must be false`);
    assertBodySafe(nested, `${path}.${key}`);
  }
}

export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is unavailable on some supported filesystems. File fsync and atomic rename remain mandatory.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeAtomic(path: string, value: unknown): void {
  ensureDirectory(dirname(path));
  const suffix = sha256Text(`${path}:${Date.now()}:${canonicalJson(value)}`).slice(0, 16);
  const temporary = `${path}.tmp.${suffix}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, undefined, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function fileStamp(path: string): FileStamp | undefined {
  if (!existsSync(path)) return undefined;
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

export function sameStamp(left: FileStamp | undefined, right: FileStamp | undefined): boolean {
  return left?.size === right?.size && left?.mtimeMs === right?.mtimeMs;
}
