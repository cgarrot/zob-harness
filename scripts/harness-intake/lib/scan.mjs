import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { sha256 } from "./cli-io.mjs";
import { DEFAULT_FORBIDDEN, MAX_FILE_BYTES, MAX_SCAN_FILES, SCHEMA_PREFIX, TEXT_EXTENSIONS } from "./constants.mjs";

export function scanSources(spec) {
  const targetRoot = spec.target.path;
  const files = [];
  const skipped = [];
  const startedAt = new Date().toISOString();
  walkRelevant(targetRoot, spec, files, skipped);
  const limited = files.slice(0, MAX_SCAN_FILES);
  if (files.length > limited.length) skipped.push({ path: "<scan-limit>", reason: `max_scan_files>${MAX_SCAN_FILES}`, omitted_count: files.length - limited.length });
  const sources = limited.map((file, index) => inspectSourceFile(targetRoot, file, index, spec));
  const harnesses = summarizeHarnesses(sources, spec.harness_hint);
  return {
    schema: `${SCHEMA_PREFIX}.sources-index.v1`,
    run_id: spec.run_id,
    target: spec.target,
    scanned_at: startedAt,
    source_project_modified: false,
    raw_secret_storage: false,
    session_authorized: spec.sessions.authorized,
    source_count: sources.length,
    sources,
    harnesses,
    skipped,
  };
}

export function walkRelevant(root, spec, files, skipped) {
  function visit(dir, depth) {
    if (files.length >= MAX_SCAN_FILES * 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: safeRel(root, dir), reason: `read_error:${error.message}` });
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relPath = safeRel(root, full);
      const forbidden = pathForbidden(relPath, DEFAULT_FORBIDDEN);
      if (forbidden) {
        skipped.push({ path: relPath, reason: `forbidden:${forbidden}`, directory: entry.isDirectory() });
        continue;
      }
      if (entry.isDirectory()) {
        if (!isRelevantDirectory(relPath, spec) && depth > 1) {
          skipped.push({ path: relPath, reason: "not_harness_relevant_directory", directory: true });
          continue;
        }
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: relPath, reason: "not_regular_file" });
        continue;
      }
      if (!isRelevantFile(relPath, spec)) {
        skipped.push({ path: relPath, reason: "not_harness_relevant_file" });
        continue;
      }
      const size = statSync(full).size;
      if (size > MAX_FILE_BYTES) {
        skipped.push({ path: relPath, reason: `too_large>${MAX_FILE_BYTES}` });
        continue;
      }
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) && !isExtensionlessRelevant(relPath)) {
        skipped.push({ path: relPath, reason: "unsupported_extension" });
        continue;
      }
      files.push({ full, relPath, size });
    }
  }
  visit(root, 0);
}

export function safeRel(root, full) {
  const rel = relative(root, full).split(sep).join("/");
  return rel || ".";
}

export function isRelevantDirectory(relPath, spec) {
  const normalized = relPath.toLowerCase();
  if (normalized === ".") return true;
  if (isSessionLikePath(normalized) && !spec.sessions.authorized) return false;
  if (normalized.startsWith(".claude") || normalized.startsWith(".codex") || normalized.startsWith(".cursor")) return true;
  if (normalized.startsWith(".pi/agents") || normalized.startsWith(".pi/zagents") || normalized.startsWith(".pi/skills") || normalized.startsWith(".pi/prompts") || normalized.startsWith(".pi/teams") || normalized.startsWith(".pi/zteams") || normalized.startsWith(".pi/factories")) return true;
  if (/^(docs?|prompts?|skills?|commands?|agents?|scripts?|workflows?|hooks?)(\/|$)/.test(normalized)) return true;
  if (spec.sessions.authorized && /(^|\/)(sessions?|transcripts?|conversation-history)(\/|$)/.test(normalized)) return true;
  return false;
}

export function isRelevantFile(relPath, spec) {
  const normalized = relPath.toLowerCase();
  const base = basename(normalized);
  if (isSessionLikePath(normalized) && !spec.sessions.authorized) return false;
  if (["agents.md", "claude.md", "codex.md", "gemini.md", "readme.md", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".aider.conf.yml", ".aider.conf.yaml", ".aider.model.settings.yml"].includes(base)) return true;
  if (/\.(team|factory)\.json$/.test(normalized)) return true;
  if (/(kickoff|prompt|agent|team|factory|tmux|workflow|command|skill).*(\.template)?\.(md|json|ya?ml|toml|sh|mjs|js|ts)$/.test(normalized)) return true;
  if (normalized.startsWith(".claude/") || normalized.startsWith(".codex/") || normalized.startsWith(".cursor/")) return true;
  if (normalized.startsWith(".pi/agents/") || normalized.startsWith(".pi/zagents/") || normalized.startsWith(".pi/skills/") || normalized.startsWith(".pi/prompts/") || normalized.startsWith(".pi/teams/") || normalized.startsWith(".pi/zteams/") || normalized.startsWith(".pi/factories/")) return true;
  if (/^(docs?|prompts?|skills?|commands?|agents?|scripts?|workflows?|hooks?)(\/|$)/.test(normalized)) return true;
  if (spec.sessions.authorized && /(^|\/)(sessions?|transcripts?|conversation-history)(\/|$)/.test(normalized)) return true;
  return false;
}

export function isSessionLikePath(normalizedRelPath) {
  return /(^|\/)(sessions?|transcripts?|conversation-history|conversation_history|chat-history|chat_history)(\/|$)/.test(normalizedRelPath);
}

export function isExtensionlessRelevant(relPath) {
  return ["agents", "claude", "codex", "readme"].includes(basename(relPath).toLowerCase());
}

export function pathForbidden(relPath, forbiddenPatterns) {
  const normalized = relPath.split(sep).join("/");
  const segments = normalized.split("/").filter(Boolean);
  for (const pattern of forbiddenPatterns) {
    const clean = String(pattern).replace(/\\/g, "/").replace(/\/$/, "");
    if (!clean) continue;
    if (clean.includes("/")) {
      if (normalized === clean || normalized.startsWith(`${clean}/`)) return clean;
      continue;
    }
    for (const segment of segments) {
      if (segmentMatches(segment, clean)) return clean;
    }
  }
  return null;
}

export function segmentMatches(segment, pattern) {
  if (pattern.startsWith("*")) return segment.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return segment.startsWith(pattern.slice(0, -1));
  return segment === pattern;
}

export function inspectSourceFile(root, file, index, spec) {
  const text = safeRead(file.full);
  const lines = text.split(/\r?\n/u);
  const sourceId = `S-${String(index + 1).padStart(4, "0")}`;
  const type = classifySource(file.relPath, spec);
  const harness = detectHarness(file.relPath, text, spec.harness_hint);
  const signals = extractSignals(file.relPath, lines);
  const secretLike = detectSecretLike(file.relPath, text);
  return {
    source_id: sourceId,
    path: file.relPath,
    absolute_path_hash: sha256(file.full),
    type,
    harness,
    size_bytes: file.size,
    lines: lines.length,
    content_hash: sha256(text),
    contains_possible_secret: secretLike.length > 0,
    secret_like_reasons: secretLike,
    citations: signals.slice(0, 12),
    used_for: usageForType(type),
  };
}

export function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function classifySource(relPath, spec) {
  const lower = relPath.toLowerCase();
  const base = basename(lower);
  if (spec.sessions.authorized && /(^|\/)(sessions?|transcripts?|conversation-history)(\/|$)/.test(lower)) return "session";
  if (lower.startsWith(".pi/zagents/prompts/") || lower.includes("/zagents/prompts/")) return "zagent-prompt";
  if (lower.startsWith(".pi/zagents/") || lower.includes("/zagents/")) return "zagent";
  if ((lower.startsWith(".pi/zteams/") || lower.includes("/zteams/")) && lower.endsWith(".tmux.sh")) return "zteam-launcher";
  if ((lower.startsWith(".pi/zteams/") || lower.includes("/zteams/")) && /runtime\.(mjs|js|ts)$/.test(lower)) return "zteam-runtime";
  if (lower.startsWith(".pi/zteams/") || lower.includes("/zteams/")) return "zteam";
  if (base === "agents.md" || lower.includes("/agents/") || lower.startsWith(".pi/agents/")) return "agent-definition";
  if (base === "claude.md" || base === "codex.md" || base === "gemini.md") return "harness-instructions";
  if (lower.includes("/skills/") || lower.startsWith(".pi/skills/")) return "skill";
  if (lower.includes("/commands/") || lower.includes("/hooks/")) return "command";
  if (lower.includes("/prompts/") || lower.includes("prompt")) return "prompt";
  if (lower.includes("/teams/") || lower.endsWith(".team.json") || lower.includes("team")) return "team";
  if (lower.includes("/factories/") || base === "factory.json" || lower.includes("factory")) return "factory";
  if (base === "package.json") return "package-manifest";
  if (lower.startsWith("scripts/") || lower.includes("/scripts/")) return "script";
  if (lower.startsWith("docs/") || lower.includes("/docs/") || base === "readme.md") return "documentation";
  return "config";
}

export function detectHarness(relPath, text, hint) {
  const lower = `${relPath}\n${text.slice(0, 5000)}`.toLowerCase();
  if (lower.includes("claude") || relPath.toLowerCase().startsWith(".claude/")) return "claude-code";
  if (lower.includes("codex") || relPath.toLowerCase().startsWith(".codex/")) return "codex";
  if (lower.includes("cursor") || relPath.toLowerCase().startsWith(".cursor/")) return "cursor";
  if (lower.includes("aider")) return "aider";
  if (lower.includes("zob") || lower.includes(" pi ") || relPath.toLowerCase().startsWith(".pi/")) return "pi-zob";
  return hint || "unknown";
}

export function extractSignals(relPath, lines) {
  const patterns = [
    ["agent", /\bagents?\b|\bsub-?agents?\b|\bworker\b|\borchestrator\b/i],
    ["skill", /\bskills?\b|\bcapabilit(y|ies)\b/i],
    ["command", /\bcommands?\b|slash command|\/\w+/i],
    ["tool", /\btools?\b|read|write|edit|bash|grep|find/i],
    ["session", /\bsessions?\b|conversation|transcript|history/i],
    ["workflow", /\bworkflow\b|\bplan\b|\bimplement\b|\breview\b|\boracle\b|validate/i],
    ["factory", /\bfactory\b|factories|batch|smoke|pilot/i],
    ["safety", /secret|credential|token|forbidden|must not|never|safety|no-ship/i],
  ];
  const citations = [];
  lines.forEach((line, index) => {
    for (const [kind, pattern] of patterns) {
      if (pattern.test(line)) citations.push({ kind, ref: `${relPath}:L${index + 1}` });
    }
  });
  return citations.slice(0, 48);
}

export function detectSecretLike(relPath, text) {
  const reasons = [];
  if (pathForbidden(relPath, DEFAULT_FORBIDDEN)) reasons.push("secret_like_path");
  const probes = [
    [/AKIA[0-9A-Z]{16}/, "aws_access_key_like"],
    [/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/, "private_key_like"],
    [/(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}/i, "credential_assignment_like"],
  ];
  for (const [pattern, reason] of probes) {
    if (pattern.test(text)) reasons.push(reason);
  }
  return [...new Set(reasons)];
}

export function usageForType(type) {
  const map = {
    "agent-definition": ["harness-profile", "team-candidates"],
    zagent: ["harness-profile", "team-candidates"],
    "zagent-prompt": ["prompt-patterns", "team-candidates"],
    zteam: ["team-candidates", "harness-profile"],
    "zteam-launcher": ["commands-profile", "factory-candidates"],
    "zteam-runtime": ["commands-profile", "factory-candidates", "workflow-patterns"],
    "harness-instructions": ["harness-profile", "workflow-patterns"],
    skill: ["skills-profile", "team-candidates"],
    command: ["commands-profile", "workflow-patterns"],
    prompt: ["prompt-patterns", "team-candidates"],
    session: ["sessions-analysis", "workflow-patterns"],
    team: ["team-candidates"],
    factory: ["factory-candidates"],
    "package-manifest": ["commands-profile"],
    script: ["commands-profile", "factory-candidates"],
    documentation: ["harness-profile", "workflow-patterns"],
    config: ["harness-profile"],
  };
  return map[type] ?? ["harness-profile"];
}

export function summarizeHarnesses(sources, hint) {
  const counts = new Map();
  for (const source of sources) counts.set(source.harness, (counts.get(source.harness) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count, hint_match: name === hint }));
}
