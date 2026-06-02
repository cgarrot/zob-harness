import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLED_ZOB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");

export function bundledZobRoot(): string {
  return BUNDLED_ZOB_ROOT;
}

export function projectZobResourcePath(repoRoot: string, ...segments: string[]): string {
  return join(repoRoot, ".pi", ...segments);
}

export function bundledZobResourcePath(...segments: string[]): string {
  return join(BUNDLED_ZOB_ROOT, ".pi", ...segments);
}

export function readableZobResourcePath(repoRoot: string, ...segments: string[]): string {
  const projectPath = projectZobResourcePath(repoRoot, ...segments);
  if (existsSync(projectPath)) return projectPath;
  return bundledZobResourcePath(...segments);
}

export function readableZobResourcePaths(repoRoot: string, ...segments: string[]): string[] {
  const paths = [bundledZobResourcePath(...segments), projectZobResourcePath(repoRoot, ...segments)];
  return [...new Set(paths)].filter((path) => existsSync(path));
}

export function listZobResourceJsonStems(repoRoot: string, ...segments: string[]): string[] {
  const names = new Set<string>();
  for (const dir of readableZobResourcePaths(repoRoot, ...segments)) {
    for (const fileName of readdirSync(dir)) {
      if (fileName.endsWith(".json")) names.add(fileName.slice(0, -".json".length));
    }
  }
  return [...names].sort();
}
