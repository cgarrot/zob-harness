import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import type { ModeName, RuleEnforcementLevel, RuleOracleRequirement, RulePack, RuleResolution, RuleResolverInput } from "./types.js";
import { pathMatches, safeFileStem } from "./utils/paths.js";
import { isRecord } from "./utils/records.js";

const RULE_PACK_SCHEMA = "zob.rule-pack.v1";
const RULE_RESOLUTION_SCHEMA = "zob.rule-resolution.v1";
const RULE_PACK_ORDER = ["always", "project", "runtime", "factory", "orchestration", "prompts", "docs", "sandbox", "oracle"];
const MODE_NAMES = new Set<ModeName>(["explore", "plan", "implement", "oracle", "factory", "orchestrator", "vanilla"]);
const ENFORCEMENT_LEVELS = new Set<RuleEnforcementLevel>(["advisory", "warn", "preflight_fail", "block", "no_ship", "human_approval"]);

const PROFILE_PATHS: Array<{ profile: string; patterns: string[] }> = [
  { profile: "factory-engineer", patterns: [".pi/extensions/zob-harness/src/factory/**", ".pi/factories/**", "reports/factory-runs/**"] },
  { profile: "orchestration-engineer", patterns: [".pi/extensions/zob-harness/src/orchestration/**", ".pi/extensions/zob-harness/src/topology/**", ".pi/teams/**", ".pi/orchestrations/**", "reports/orchestrations/**"] },
  { profile: "prompt-ops", patterns: [".pi/agents/**", ".pi/prompts/**", ".pi/skills/**", ".pi/output-contracts/**", ".pi/chains/**"] },
  { profile: "sandbox-engineer", patterns: ["reports/sandbox-runs/**", ".pi/extensions/zob-harness/src/safety.ts", ".pi/extensions/zob-harness/src/child-runner.ts"] },
  { profile: "runtime-maintainer", patterns: [".pi/extensions/zob-harness/index.ts", ".pi/extensions/zob-harness/src/runtime/**", ".pi/extensions/zob-harness/src/schemas.ts", ".pi/extensions/zob-harness/src/types.ts", ".pi/extensions/zob-harness/src/rules.ts"] },
  { profile: "docs-maintainer", patterns: ["docs/**", "README.md", "AGENTS.md"] },
];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOracleRequirement(value: unknown): value is RuleOracleRequirement {
  return typeof value === "boolean" || value === "conditional";
}

function rulesDir(repoRoot: string): string {
  return join(repoRoot, ".pi", "rules");
}

function extractJsonBlock(markdown: string): string | undefined {
  const fenced = markdown.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = markdown.indexOf("{");
  const lastBrace = markdown.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return markdown.slice(firstBrace, lastBrace + 1);
  return undefined;
}

function parseRulePackFile(filePath: string): { pack?: RulePack; errors: string[] } {
  try {
    const raw = readFileSync(filePath, "utf8");
    const json = extractJsonBlock(raw);
    if (!json) return { errors: [`Rule pack missing fenced json block: ${filePath}`] };
    const parsed = JSON.parse(json) as unknown;
    if (!isRecord(parsed)) return { errors: [`Rule pack json must be an object: ${filePath}`] };
    const pack = parsed as unknown as RulePack;
    pack.sourcePath = filePath;
    const errors = validateRulePack(pack);
    return errors.length > 0 ? { errors: errors.map((error) => `${basename(filePath)}: ${error}`) } : { pack, errors: [] };
  } catch (error) {
    return { errors: [`Could not parse rule pack '${filePath}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function dangerousPositiveInstruction(text: string): boolean {
  return /\b(read|open|cat|print|dump|exfiltrate|extract)\b[^\n]*(\.env|secret|private key|~\/.ssh|~\/.aws|\.pem|\.key)/i.test(text)
    || /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-|sudo\b)\b/i.test(text);
}

export function validateRulePack(pack: RulePack | undefined): string[] {
  const errors: string[] = [];
  if (!pack || !isRecord(pack)) return ["Rule pack is missing"];
  if (pack.schema !== RULE_PACK_SCHEMA) errors.push(`schema must be ${RULE_PACK_SCHEMA}`);
  if (typeof pack.id !== "string" || pack.id.trim().length === 0) errors.push("id is required");
  else if (safeFileStem(pack.id) !== pack.id) errors.push(`id must be path-safe: ${pack.id}`);
  if (typeof pack.description !== "string" || pack.description.trim().length === 0) errors.push("description is required");
  if (!isRecord(pack.applies_to)) {
    errors.push("applies_to is required");
  } else {
    if (pack.applies_to.paths !== undefined && !isStringArray(pack.applies_to.paths)) errors.push("applies_to.paths must be a string array");
    if (pack.applies_to.modes !== undefined && (!isStringArray(pack.applies_to.modes) || pack.applies_to.modes.some((mode) => !MODE_NAMES.has(mode as ModeName)))) errors.push("applies_to.modes must contain valid ZOB modes");
    if (pack.applies_to.task_types !== undefined && !isStringArray(pack.applies_to.task_types)) errors.push("applies_to.task_types must be a string array");
    if (pack.applies_to.profiles !== undefined && !isStringArray(pack.applies_to.profiles)) errors.push("applies_to.profiles must be a string array");
  }
  if (!isStringArray(pack.must_do) || pack.must_do.length === 0) errors.push("must_do must be a non-empty string array");
  if (!isStringArray(pack.must_not_do) || pack.must_not_do.length === 0) errors.push("must_not_do must be a non-empty string array");
  if (pack.allowed_tools !== undefined && !isStringArray(pack.allowed_tools)) errors.push("allowed_tools must be a string array");
  if (!isStringArray(pack.required_validation)) errors.push("required_validation must be a string array");
  if (!isOracleRequirement(pack.oracle_required)) errors.push("oracle_required must be boolean or 'conditional'");
  if (!isStringArray(pack.no_ship_conditions)) errors.push("no_ship_conditions must be a string array");
  if (!ENFORCEMENT_LEVELS.has(pack.enforcement)) errors.push("enforcement must be a known rule enforcement level");

  for (const instruction of [...(isStringArray(pack.must_do) ? pack.must_do : []), ...(isStringArray(pack.required_validation) ? pack.required_validation : [])]) {
    if (dangerousPositiveInstruction(instruction)) errors.push(`rule must not positively require secret access or destructive commands: ${instruction}`);
  }
  for (const tool of pack.allowed_tools ?? []) {
    if (/secret|credential|sudo|rm-rf|shell-root/i.test(tool)) errors.push(`allowed_tools contains unsafe tool name: ${tool}`);
  }
  return errors;
}

export function listRulePackPaths(repoRoot: string): string[] {
  const dir = rulesDir(repoRoot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((fileName) => fileName.endsWith(".md"));
  return files
    .sort((left, right) => {
      const leftIndex = RULE_PACK_ORDER.indexOf(basename(left, ".md"));
      const rightIndex = RULE_PACK_ORDER.indexOf(basename(right, ".md"));
      const normalizedLeft = leftIndex >= 0 ? leftIndex : RULE_PACK_ORDER.length;
      const normalizedRight = rightIndex >= 0 ? rightIndex : RULE_PACK_ORDER.length;
      return normalizedLeft - normalizedRight || left.localeCompare(right);
    })
    .map((fileName) => join(dir, fileName));
}

export function loadRulePack(repoRoot: string, id: string): { pack?: RulePack; rulePath: string; errors: string[] } {
  if (safeFileStem(id) !== id) return { rulePath: join(rulesDir(repoRoot), `${safeFileStem(id)}.md`), errors: [`Invalid rule pack id '${id}'`] };
  const rulePath = join(rulesDir(repoRoot), `${id}.md`);
  if (!existsSync(rulePath)) return { rulePath, errors: [`Rule pack not found: ${rulePath}`] };
  const parsed = parseRulePackFile(rulePath);
  return { rulePath, ...parsed };
}

export function loadRulePacks(repoRoot: string): { packs: RulePack[]; errors: string[] } {
  const packs: RulePack[] = [];
  const errors: string[] = [];
  for (const rulePath of listRulePackPaths(repoRoot)) {
    const parsed = parseRulePackFile(rulePath);
    if (parsed.pack) packs.push(parsed.pack);
    errors.push(...parsed.errors);
  }
  return { packs, errors };
}

function pathPatternApplies(repoRoot: string, targetPath: string, pattern: string): boolean {
  if (pattern === "**" || pattern === "*") return true;
  return pathMatches(targetPath, pattern, repoRoot, repoRoot);
}

export function inferRuleProfile(input: RuleResolverInput): string {
  if (input.profile && input.profile.trim().length > 0) return input.profile;
  const targetPaths = input.paths ?? [];
  for (const targetPath of targetPaths) {
    for (const candidate of PROFILE_PATHS) {
      if (candidate.patterns.some((pattern) => pathPatternApplies(input.repoRoot, targetPath, pattern))) return candidate.profile;
    }
  }
  const text = input.taskText?.toLowerCase() ?? "";
  if (/sandbox|write autonomy|diff gate|rollback/.test(text)) return "sandbox-engineer";
  if (input.mode === "factory") return "factory-engineer";
  if (input.mode === "oracle") return "oracle-reviewer";
  return "project-maintainer";
}

function rulePackApplies(pack: RulePack, input: RuleResolverInput, profile: string): boolean {
  if (pack.id === "always" || pack.id === "project") return true;
  const applies = pack.applies_to;
  if (applies.profiles?.includes(profile)) return true;
  if (input.mode && applies.modes?.includes(input.mode)) return true;
  const taskText = input.taskText?.toLowerCase() ?? "";
  if (taskText && applies.task_types?.some((taskType) => taskText.includes(taskType.toLowerCase()))) return true;
  const targetPaths = input.paths ?? [];
  if (targetPaths.length > 0 && applies.paths?.some((pattern) => targetPaths.some((targetPath) => pathPatternApplies(input.repoRoot, targetPath, pattern)))) return true;
  return false;
}

function dedupe<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const output: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function oracleRequirement(values: RuleOracleRequirement[]): RuleOracleRequirement {
  if (values.some((value) => value === true)) return true;
  if (values.some((value) => value === "conditional")) return "conditional";
  return false;
}

export function resolveRuleProfile(input: RuleResolverInput): RuleResolution {
  const loaded = loadRulePacks(input.repoRoot);
  const profile = inferRuleProfile(input);
  const selected: RulePack[] = [];
  const byId = new Map(loaded.packs.map((pack) => [pack.id, pack]));
  const addPack = (pack: RulePack | undefined): void => {
    if (!pack || selected.some((candidate) => candidate.id === pack.id)) return;
    selected.push(pack);
  };

  addPack(byId.get("always"));
  addPack(byId.get("project"));
  for (const pack of loaded.packs) {
    if (rulePackApplies(pack, input, profile)) addPack(pack);
  }
  if (selected.some((pack) => pack.id !== "oracle" && pack.oracle_required === true)) addPack(byId.get("oracle"));

  return {
    schema: RULE_RESOLUTION_SCHEMA,
    profile,
    rulePacks: selected.map((pack) => pack.id),
    allowedTools: dedupe(selected.flatMap((pack) => pack.allowed_tools ?? [])),
    requiredValidation: dedupe(selected.flatMap((pack) => pack.required_validation)),
    oracleRequired: oracleRequirement(selected.map((pack) => pack.oracle_required)),
    noShipConditions: dedupe(selected.flatMap((pack) => pack.no_ship_conditions)),
    mustDo: dedupe(selected.flatMap((pack) => pack.must_do)),
    mustNotDo: dedupe(selected.flatMap((pack) => pack.must_not_do)),
    enforcement: dedupe(selected.map((pack) => pack.enforcement)),
    errors: loaded.errors,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function formatRuleResolution(resolution: RuleResolution): string {
  return [
    `ZOB rules profile: ${resolution.profile}`,
    `rule packs: ${resolution.rulePacks.length > 0 ? resolution.rulePacks.join(", ") : "none"}`,
    `allowed tools: ${resolution.allowedTools.length > 0 ? resolution.allowedTools.join(", ") : "not specified"}`,
    `required validation: ${resolution.requiredValidation.length > 0 ? resolution.requiredValidation.join(" | ") : "not specified"}`,
    `oracle required: ${String(resolution.oracleRequired)}`,
    `enforcement: ${resolution.enforcement.length > 0 ? resolution.enforcement.join(", ") : "none"}`,
    `no-ship: ${resolution.noShipConditions.length > 0 ? resolution.noShipConditions.join(" | ") : "none"}`,
    resolution.errors.length > 0 ? `errors:\n- ${resolution.errors.join("\n- ")}` : "errors: none",
  ].join("\n");
}
