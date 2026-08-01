import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isRecord } from "../../core/utils/records.js";

export type ChildProviderExtensionResolution = {
  source?: string;
  origin?: "global_mapping" | "project_mapping" | "global_settings" | "project_settings";
  errors: string[];
};

type ProviderMappingEntry = {
  source: string;
  approved: boolean;
};

const UNSUPPORTED_PACKAGE_SOURCE = /^(?:npm:|git:|https?:|ssh:|git:)/i;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function packageSource(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value) || typeof value.source !== "string") return undefined;
  return value.source.trim() || undefined;
}

function resolveLocalSource(settingsOrMappingPath: string, source: string): string | undefined {
  if (UNSUPPORTED_PACKAGE_SOURCE.test(source)) return undefined;
  const candidate = resolve(dirname(settingsOrMappingPath), source);
  if (!existsSync(candidate)) return undefined;
  try {
    const canonical = realpathSync(candidate);
    return statSync(canonical).isDirectory() ? canonical : dirname(canonical);
  } catch {
    return undefined;
  }
}

function providerPackageManifest(packageRoot: string): Record<string, unknown> | undefined {
  const packageJson = join(packageRoot, "package.json");
  const parsed = existsSync(packageJson) ? readJson(packageJson) : undefined;
  if (!isRecord(parsed)) return undefined;
  const pi = isRecord(parsed.pi) ? parsed.pi : undefined;
  if (!pi || !Array.isArray(pi.extensions) || pi.extensions.length === 0) return undefined;
  return parsed;
}

function explicitProviderMapping(configPath: string, provider: string): ProviderMappingEntry | undefined {
  if (!existsSync(configPath)) return undefined;
  const parsed = readJson(configPath);
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return undefined;
  const raw = parsed.providers[provider];
  if (!isRecord(raw) || typeof raw.source !== "string") return undefined;
  return { source: raw.source, approved: raw.approved === true };
}

function resolveMappedProvider(configPath: string, provider: string, origin: ChildProviderExtensionResolution["origin"]): ChildProviderExtensionResolution | undefined {
  const mapping = explicitProviderMapping(configPath, provider);
  if (!mapping) return undefined;
  if (!mapping.approved) {
    return { errors: [`child provider mapping '${provider}' in ${configPath} is not approved`] };
  }
  const source = resolveLocalSource(configPath, mapping.source);
  if (!source) {
    return { errors: [`child provider mapping '${provider}' in ${configPath} must reference an existing local package path`] };
  }
  if (!providerPackageManifest(source)) {
    return { errors: [`child provider mapping '${provider}' resolves to '${source}', but that package declares no Pi extensions`] };
  }
  return { source, origin, errors: [] };
}

function configuredProviderCandidates(settingsPath: string, provider: string): string[] {
  if (!existsSync(settingsPath)) return [];
  const parsed = readJson(settingsPath);
  if (!isRecord(parsed) || !Array.isArray(parsed.packages)) return [];
  const expectedName = `pi-provider-${provider}`;
  const candidates: string[] = [];
  for (const item of parsed.packages) {
    const sourceValue = packageSource(item);
    if (!sourceValue) continue;
    const source = resolveLocalSource(settingsPath, sourceValue);
    if (!source) continue;
    const manifest = providerPackageManifest(source);
    if (!manifest || manifest.name !== expectedName) continue;
    const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [];
    if (!keywords.includes("pi-provider")) continue;
    candidates.push(source);
  }
  return [...new Set(candidates)];
}

export function resolveChildProviderExtension(input: {
  repoRoot: string;
  agentDir: string;
  provider: string | undefined;
  projectTrusted: boolean;
}): ChildProviderExtensionResolution {
  const provider = input.provider?.trim();
  if (!provider) return { errors: [] };
  if (!SAFE_PROVIDER_ID.test(provider)) return { errors: [`child model provider '${provider}' is not a safe provider id`] };

  const globalMappingPath = join(input.agentDir, "child-provider-extensions.json");
  const globalMapping = resolveMappedProvider(globalMappingPath, provider, "global_mapping");
  if (globalMapping) return globalMapping;

  if (input.projectTrusted) {
    const projectMappingPath = join(input.repoRoot, ".pi", "child-provider-extensions.json");
    const projectMapping = resolveMappedProvider(projectMappingPath, provider, "project_mapping");
    if (projectMapping) return projectMapping;
  }

  const candidateGroups: Array<{ paths: string[]; origin: ChildProviderExtensionResolution["origin"] }> = [
    { paths: configuredProviderCandidates(join(input.agentDir, "settings.json"), provider), origin: "global_settings" },
  ];
  if (input.projectTrusted) {
    candidateGroups.push({ paths: configuredProviderCandidates(join(input.repoRoot, ".pi", "settings.json"), provider), origin: "project_settings" });
  }

  const candidates = [...new Set(candidateGroups.flatMap((group) => group.paths))];
  if (candidates.length > 1) {
    return { errors: [`multiple configured local Pi provider packages match '${provider}'; add one approved child-provider-extensions.json mapping`] };
  }
  if (candidates.length === 0) return { errors: [] };
  const source = candidates[0];
  const origin = candidateGroups.find((group) => group.paths.includes(source))?.origin;
  return { source, origin, errors: [] };
}
