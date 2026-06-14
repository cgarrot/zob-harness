import { existsSync } from "node:fs";
import { join } from "node:path";

export const PRIMARY_PLANS_ROOT = ".pi/plans";
export const LEGACY_PLANS_ROOT = "plans";
export const PRIMARY_REPORTS_ROOT = ".pi/reports";
export const LEGACY_REPORTS_ROOT = "reports";

export type ArtifactRootKind = "plans" | "reports";

function normalizeSegments(segments: string[]): string[] {
  return segments.flatMap((segment) => segment.split("/")).filter(Boolean);
}

export function artifactRootRef(kind: ArtifactRootKind, legacy = false): string {
  if (kind === "plans") return legacy ? LEGACY_PLANS_ROOT : PRIMARY_PLANS_ROOT;
  return legacy ? LEGACY_REPORTS_ROOT : PRIMARY_REPORTS_ROOT;
}

export function artifactRootPath(repoRoot: string, kind: ArtifactRootKind, legacy = false): string {
  return join(repoRoot, ...artifactRootRef(kind, legacy).split("/"));
}

export function artifactRef(kind: ArtifactRootKind, ...segments: string[]): string {
  return [artifactRootRef(kind), ...normalizeSegments(segments)].join("/");
}

export function legacyArtifactRef(kind: ArtifactRootKind, ...segments: string[]): string {
  return [artifactRootRef(kind, true), ...normalizeSegments(segments)].join("/");
}

export function artifactPath(repoRoot: string, kind: ArtifactRootKind, ...segments: string[]): string {
  return join(artifactRootPath(repoRoot, kind), ...normalizeSegments(segments));
}

export function legacyArtifactPath(repoRoot: string, kind: ArtifactRootKind, ...segments: string[]): string {
  return join(artifactRootPath(repoRoot, kind, true), ...normalizeSegments(segments));
}

export function isArtifactRef(value: string, kind: ArtifactRootKind, options: { legacy?: boolean } = {}): boolean {
  const normalized = value.replace(/^\.\//, "");
  const primary = artifactRootRef(kind);
  const legacy = artifactRootRef(kind, true);
  return normalized === primary || normalized.startsWith(`${primary}/`) || options.legacy === true && (normalized === legacy || normalized.startsWith(`${legacy}/`));
}

export function existingArtifactRoots(repoRoot: string, kind: ArtifactRootKind, ...segments: string[]): string[] {
  const primary = artifactPath(repoRoot, kind, ...segments);
  const legacy = legacyArtifactPath(repoRoot, kind, ...segments);
  return [primary, legacy].filter((path, index, paths) => paths.indexOf(path) === index && existsSync(path));
}

export function firstExistingArtifactPath(repoRoot: string, kind: ArtifactRootKind, ...segments: string[]): string {
  return existingArtifactRoots(repoRoot, kind, ...segments)[0] ?? artifactPath(repoRoot, kind, ...segments);
}
