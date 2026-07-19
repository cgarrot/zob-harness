import { createHash } from "node:crypto";

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical values cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  throw new Error(`unsupported canonical value type ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function isSafeSupervisorId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

export function assertSafeSupervisorId(value: string, label: string): void {
  if (!isSafeSupervisorId(value)) throw new Error(`${label} must be path-safe`);
}
