import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { sha256, writeJson, writeText } from "./cli-io.mjs";
import { FACTORY_NAME, MAX_SESSION_FILES, SCHEMA_PREFIX } from "./constants.mjs";
import { safeRead, summarizeHarnesses } from "./scan.mjs";

export function buildProfiles(spec, sourcesIndex) {
  const sources = sourcesIndex.sources ?? [];
  const harnessProfile = buildHarnessProfile(spec, sources);
  const skillsProfile = buildSkillsProfile(spec, sources);
  const commandsProfile = buildCommandsProfile(spec, sources);
  const promptPatterns = buildPromptPatterns(spec, sources);
  const sessionArtifacts = buildSessionArtifacts(spec, sources);
  const workflowPatterns = buildWorkflowPatterns(spec, harnessProfile, skillsProfile, commandsProfile, sessionArtifacts.sessionsAnalysis);
  const teamCandidates = buildTeamCandidates(spec, workflowPatterns, sources);
  const factoryCandidates = buildFactoryCandidates(spec, teamCandidates, workflowPatterns);
  return { harnessProfile, skillsProfile, commandsProfile, promptPatterns, ...sessionArtifacts, workflowPatterns, teamCandidates, factoryCandidates };
}

export function evidenceFor(sources, predicate, limit = 12) {
  return sources.filter(predicate).flatMap((source) => source.citations.map((citation) => citation.ref)).slice(0, limit);
}

export function buildHarnessProfile(spec, sources) {
  const harnessCounts = summarizeHarnesses(sources, spec.harness_hint);
  const sourceTypes = countBy(sources, (source) => source.type);
  const safetyRefs = evidenceFor(sources, (source) => source.citations.some((citation) => citation.kind === "safety"));
  return {
    schema: `${SCHEMA_PREFIX}.harness-profile.v1`,
    run_id: spec.run_id,
    harness_hint: spec.harness_hint,
    detected_harnesses: harnessCounts,
    primary_harness: harnessCounts[0]?.name ?? spec.harness_hint,
    source_types: sourceTypes,
    agent_definition_count: countType(sources, "agent-definition"),
    zagent_count: countType(sources, "zagent"),
    zagent_prompt_count: countType(sources, "zagent-prompt"),
    zteam_count: countType(sources, "zteam"),
    zteam_launcher_count: countType(sources, "zteam-launcher"),
    zteam_runtime_count: countType(sources, "zteam-runtime"),
    skill_count: countType(sources, "skill"),
    command_count: countType(sources, "command") + countType(sources, "package-manifest"),
    prompt_count: countType(sources, "prompt"),
    session_source_count: countType(sources, "session"),
    conventions: inferConventions(sources),
    setup_steps: inferSetupSteps(sources),
    safety_rules: safetyRefs.map((ref) => ({ ref, rule: "safety/secret/no-ship signal observed" })),
    confidence: confidenceFromSignals(sources.length, harnessCounts[0]?.count ?? 0),
    evidence_refs: evidenceFor(sources, () => true, 24),
    unknowns: buildUnknowns(spec, sources),
  };
}

export function inferConventions(sources) {
  const paths = sources.map((source) => source.path.toLowerCase());
  const conventions = [];
  if (paths.some((path) => path === "claude.md" || path.endsWith("/claude.md"))) conventions.push("CLAUDE.md root/local instruction file");
  if (paths.some((path) => path.startsWith(".claude/agents/"))) conventions.push("Claude Code agent definitions under .claude/agents");
  if (paths.some((path) => path.startsWith(".claude/commands/"))) conventions.push("Claude Code slash commands under .claude/commands");
  if (paths.some((path) => path.startsWith(".cursor/"))) conventions.push("Cursor rules/configuration under .cursor");
  if (paths.some((path) => path.startsWith(".codex/"))) conventions.push("Codex configuration under .codex");
  if (paths.some((path) => path.startsWith(".pi/"))) conventions.push("Pi/ZOB project-local agents, skills, teams or factories");
  if (paths.some((path) => path.startsWith(".pi/zagents/"))) conventions.push("Full-session ZAgent definitions under .pi/zagents");
  if (paths.some((path) => path.startsWith(".pi/zteams/"))) conventions.push("ZTeam manifests, tmux launchers, and runtime scripts under .pi/zteams");
  if (paths.some((path) => path.includes("skills/"))) conventions.push("Skill-oriented behavior instructions");
  if (paths.some((path) => path.includes("commands/"))) conventions.push("Command-oriented reusable workflows");
  return conventions;
}

export function inferSetupSteps(sources) {
  return sources
    .filter((source) => ["documentation", "harness-instructions", "package-manifest", "script"].includes(source.type))
    .slice(0, 20)
    .map((source) => ({ source_id: source.source_id, path: source.path, inferred_step: `review ${source.type} for setup/use instructions` }));
}

export function buildUnknowns(spec, sources) {
  const unknowns = [];
  if (!sources.length) unknowns.push("No harness-relevant sources were found.");
  if (spec.sessions.mentioned && !spec.sessions.authorized) unknowns.push("Sessions were mentioned but not authorized, so real behavioral usage was not mined.");
  if (!sources.some((source) => source.type === "skill")) unknowns.push("No explicit skill files were found.");
  if (!sources.some((source) => source.type === "command" || source.type === "package-manifest")) unknowns.push("No explicit command/package command files were found.");
  return unknowns;
}

export function buildSkillsProfile(spec, sources) {
  const skillSources = sources.filter((source) => ["skill", "agent-definition", "zagent", "zagent-prompt", "harness-instructions"].includes(source.type));
  return {
    schema: `${SCHEMA_PREFIX}.skills-profile.v1`,
    run_id: spec.run_id,
    skill_count: skillSources.filter((source) => source.type === "skill").length,
    role_definition_count: skillSources.filter((source) => source.type === "agent-definition" || source.type === "zagent").length,
    skills: skillSources.map((source) => ({
      source_id: source.source_id,
      name: inferNameFromPath(source.path),
      path: source.path,
      type: source.type,
      harness: source.harness,
      trigger_evidence_refs: source.citations.filter((citation) => ["skill", "workflow", "tool"].includes(citation.kind)).map((citation) => citation.ref).slice(0, 8),
      possible_zob_mapping: possibleMappingForSource(source),
      confidence: source.citations.length ? 0.72 : 0.45,
    })),
    evidence_refs: evidenceFor(skillSources, () => true, 24),
  };
}

export function buildCommandsProfile(spec, sources) {
  const commandSources = sources.filter((source) => ["command", "package-manifest", "script"].includes(source.type));
  const packageScripts = [];
  for (const source of sources.filter((entry) => entry.type === "package-manifest")) {
    const full = resolve(spec.target.path, source.path);
    try {
      const parsed = JSON.parse(readFileSync(full, "utf8"));
      for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
        packageScripts.push({ name, command_hash: sha256(String(command)), source_ref: `${source.path}:scripts.${name}` });
      }
    } catch {
      // ignore invalid package manifests; validation can flag separately if needed
    }
  }
  return {
    schema: `${SCHEMA_PREFIX}.commands-profile.v1`,
    run_id: spec.run_id,
    command_source_count: commandSources.length,
    package_scripts: packageScripts,
    commands: commandSources.map((source) => ({
      source_id: source.source_id,
      name: inferNameFromPath(source.path),
      path: source.path,
      type: source.type,
      harness: source.harness,
      evidence_refs: source.citations.filter((citation) => ["command", "workflow", "tool"].includes(citation.kind)).map((citation) => citation.ref).slice(0, 8),
      possible_zob_mapping: source.type === "script" ? "validator-or-launcher" : "slash-command-or-workflow-step",
    })),
  };
}

export function buildPromptPatterns(spec, sources) {
  const promptSources = sources.filter((source) => ["prompt", "harness-instructions", "agent-definition"].includes(source.type));
  return {
    schema: `${SCHEMA_PREFIX}.prompt-patterns.v1`,
    run_id: spec.run_id,
    prompt_source_count: promptSources.length,
    patterns: promptSources.map((source) => ({
      source_id: source.source_id,
      path: source.path,
      pattern: inferPromptPattern(source),
      evidence_refs: source.citations.map((citation) => citation.ref).slice(0, 8),
    })),
  };
}

export function buildSessionArtifacts(spec, sources) {
  if (!spec.sessions.authorized) {
    return {
      sessionsAnalysis: {
        schema: `${SCHEMA_PREFIX}.sessions-analysis.v1`,
        run_id: spec.run_id,
        status: spec.sessions.mentioned ? "skipped-needs-authorization" : "skipped-not-requested",
        raw_session_body_persisted: false,
        session_count: 0,
        findings: [],
        skipped_reason: spec.sessions.skipped_reason || "sessions not requested",
      },
      sessionEvidenceIndex: {
        schema: `${SCHEMA_PREFIX}.session-evidence-index.v1`,
        run_id: spec.run_id,
        status: "skipped",
        evidence: [],
      },
    };
  }
  const sessionSources = sources.filter((source) => source.type === "session").slice(0, MAX_SESSION_FILES);
  const evidence = [];
  const findings = [];
  for (const source of sessionSources) {
    const full = resolve(spec.target.path, source.path);
    const text = safeRead(full);
    const lines = text.split(/\r?\n/u);
    const metrics = sessionMetrics(lines);
    evidence.push({
      session_id: source.source_id,
      path: source.path,
      content_hash: source.content_hash,
      raw_body_persisted: false,
      line_count: lines.length,
      metrics,
      evidence_refs: source.citations.map((citation) => citation.ref).slice(0, 12),
    });
    for (const finding of metrics.patterns) {
      findings.push({ session_id: source.source_id, ...finding });
    }
  }
  return {
    sessionsAnalysis: {
      schema: `${SCHEMA_PREFIX}.sessions-analysis.v1`,
      run_id: spec.run_id,
      status: "analyzed",
      raw_session_body_persisted: false,
      authorization_source: spec.sessions.authorization_source,
      session_count: sessionSources.length,
      findings,
      aggregate: {
        tool_mentions: sumMetric(evidence, "tool_mentions"),
        agent_mentions: sumMetric(evidence, "agent_mentions"),
        skill_mentions: sumMetric(evidence, "skill_mentions"),
        validation_mentions: sumMetric(evidence, "validation_mentions"),
      },
    },
    sessionEvidenceIndex: {
      schema: `${SCHEMA_PREFIX}.session-evidence-index.v1`,
      run_id: spec.run_id,
      status: "indexed",
      raw_session_body_persisted: false,
      evidence,
    },
  };
}

export function sessionMetrics(lines) {
  const text = lines.join("\n").toLowerCase();
  const metrics = {
    tool_mentions: countMatches(text, /\b(read|write|edit|bash|grep|find|ls|web_search|web_fetch|delegate(_agent|_task)?)\b/g),
    agent_mentions: countMatches(text, /\b(agent|subagent|worker|orchestrator|planner|implementer|oracle|reviewer)\b/g),
    skill_mentions: countMatches(text, /\bskill|skills|capability|capabilities\b/g),
    validation_mentions: countMatches(text, /\bvalidate|validation|test|oracle|review|pass|fail|no-ship\b/g),
    patterns: [],
  };
  if (/spec[\s\S]{0,300}plan[\s\S]{0,300}(implement|code)[\s\S]{0,300}(review|oracle|validate)/.test(text)) metrics.patterns.push({ pattern: "spec-plan-implement-review", confidence: 0.78 });
  if (/delegate|subagent|worker/.test(text) && /review|oracle|validate/.test(text)) metrics.patterns.push({ pattern: "delegate-then-review", confidence: 0.72 });
  if (/skill/.test(text) && /trigger|use|load|when/.test(text)) metrics.patterns.push({ pattern: "skill-triggered-workflow", confidence: 0.68 });
  return metrics;
}

export function sumMetric(evidence, metric) {
  return evidence.reduce((sum, row) => sum + Number(row.metrics?.[metric] ?? 0), 0);
}

export function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

export function buildWorkflowPatterns(spec, harnessProfile, skillsProfile, commandsProfile, sessionsAnalysis) {
  const patterns = [];
  const staticSupport = Object.values(harnessProfile.source_types ?? {}).reduce((sum, count) => sum + Number(count || 0), 0);
  patterns.push({
    id: "harness-static-intake-to-team-proposal",
    description: "Scan harness setup files, interpret roles/skills/commands, then synthesize ZOB team proposals.",
    static_support: staticSupport > 0,
    session_support: sessionsAnalysis.status === "analyzed" && sessionsAnalysis.findings.length > 0,
    observed_count: Math.max(1, staticSupport),
    candidate_team: true,
    confidence: clamp(0.45 + Math.min(staticSupport, 8) * 0.04 + (sessionsAnalysis.status === "analyzed" ? 0.15 : 0), 0.35, 0.92),
    evidence_refs: [...(harnessProfile.evidence_refs ?? []), ...(skillsProfile.evidence_refs ?? [])].slice(0, 16),
  });
  if (skillsProfile.skill_count > 0) {
    patterns.push({
      id: "skill-to-role-or-validator-mapping",
      description: "External skills can map to ZOB role prompts, workflow steps, or validators depending on trigger and tool posture.",
      static_support: true,
      session_support: sessionsAnalysis.findings.some((finding) => finding.pattern === "skill-triggered-workflow"),
      observed_count: skillsProfile.skill_count,
      candidate_team: true,
      confidence: clamp(0.52 + Math.min(skillsProfile.skill_count, 8) * 0.04, 0.4, 0.88),
      evidence_refs: skillsProfile.evidence_refs.slice(0, 16),
    });
  }
  for (const finding of sessionsAnalysis.findings ?? []) {
    patterns.push({
      id: finding.pattern,
      description: `Session-mined behavioral pattern: ${finding.pattern}`,
      static_support: false,
      session_support: true,
      observed_count: 1,
      candidate_team: true,
      confidence: finding.confidence,
      evidence_refs: [],
    });
  }
  return {
    schema: `${SCHEMA_PREFIX}.workflow-patterns.v1`,
    run_id: spec.run_id,
    patterns,
  };
}

export function buildTeamCandidates(spec, workflowPatterns, sources) {
  const bestConfidence = Math.max(...workflowPatterns.patterns.map((pattern) => pattern.confidence), 0.4);
  const includeSessionMiner = spec.sessions.authorized;
  const roles = [
    "harness-intake-orchestrator",
    "harness-source-cartographer",
    "harness-interpreter",
    "harness-skill-command-analyst",
    ...(includeSessionMiner ? ["harness-session-miner"] : []),
    "harness-workflow-pattern-miner",
    "zob-team-architect",
    "harness-factory-designer",
    "harness-intake-oracle",
  ];
  return {
    schema: `${SCHEMA_PREFIX}.team-candidates.v1`,
    run_id: spec.run_id,
    candidates: [
      {
        team_name: `${normalizeName(spec.harness_hint)}-harness-intake-team`,
        purpose: "Analyze an external agent harness and propose reusable ZOB teams/factories from cited setup and session evidence.",
        entry_agent: "harness-intake-orchestrator",
        roles,
        communication_policy: {
          parent_visible: true,
          hidden_peer_chat: false,
          goal_room_canonical: true,
        },
        expected_artifacts: ["sources-index.json", "harness-profile.json", "skills-profile.json", "workflow-patterns.json", "factory-candidates.json", "validation.json"],
        activation_status: "quarantine-only",
        confidence: bestConfidence,
        evidence_refs: evidenceFor(sources, () => true, 20),
        blockers: bestConfidence < 0.7 ? ["Low confidence: inspect sources and consider authorizing sessions or adding docs before activation."] : [],
      },
    ],
  };
}

export function buildFactoryCandidates(spec, teamCandidates, workflowPatterns) {
  const team = teamCandidates.candidates[0];
  const confidence = clamp(team.confidence - 0.05, 0.3, 0.88);
  const blockers = [];
  if (confidence < 0.75) blockers.push("Factory proposal is useful but not activation-ready until confidence >= 0.75 and validators are reviewed.");
  if (!spec.sessions.authorized && spec.sessions.mentioned) blockers.push("Session mining was requested but not authorized; behavioral evidence is incomplete.");
  return {
    schema: `${SCHEMA_PREFIX}.factory-candidates.v1`,
    run_id: spec.run_id,
    candidates: [
      {
        factory_name: `${normalizeName(spec.harness_hint)}-derived-agent-team-factory`,
        purpose: "Reusable factory proposal that relaunches a harness-intake analysis team for similar external setups.",
        input_contract: "natural-language-request compiled to inferred-run-spec.v1",
        output_artifacts: ["team-candidates.json", "generated-proposals/teams", "generated-proposals/agents", "validation.json"],
        validators: ["validate-run.mjs", "validate-no-secrets", "validate-quarantine"],
        smoke_mode: true,
        pilot_mode: true,
        batch_mode: true,
        activation_status: blockers.length ? "needs-review" : "activation-review-eligible",
        confidence,
        evidence_refs: workflowPatterns.patterns.flatMap((pattern) => pattern.evidence_refs).slice(0, 20),
        blockers,
      },
    ],
  };
}

export function countBy(items, fn) {
  const out = {};
  for (const item of items) {
    const key = fn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function countType(sources, type) {
  return sources.filter((source) => source.type === type).length;
}

export function confidenceFromSignals(total, primary) {
  if (!total) return 0.2;
  return clamp(0.45 + Math.min(total, 20) * 0.015 + Math.min(primary, 10) * 0.02, 0.35, 0.9);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value.toFixed(3))));
}

export function inferNameFromPath(path) {
  return basename(path).replace(/\.(md|json|ya?ml|toml|txt|mjs|js|ts|sh)$/i, "");
}

export function normalizeName(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function possibleMappingForSource(source) {
  if (source.type === "skill") return "zob-skill-or-workflow-step";
  if (source.type === "agent-definition" || source.type === "zagent") return "zob-agent-role";
  if (source.type === "zagent-prompt") return "zob-agent-prompt";
  if (source.type === "zteam") return "zob-team-topology";
  if (source.type === "harness-instructions") return "team-global-instructions";
  return "analysis-evidence";
}

export function inferPromptPattern(source) {
  if (source.type === "agent-definition" || source.type === "zagent") return "role-prompt";
  if (source.type === "zagent-prompt") return "zagent-prompt";
  if (source.type === "harness-instructions") return "global-instructions";
  if (source.type === "prompt") return "reusable-prompt-template";
  return "instruction-pattern";
}

export function writeProfileArtifacts(runDir, profiles) {
  writeJson(join(runDir, "harness-profile.json"), profiles.harnessProfile);
  writeJson(join(runDir, "skills-profile.json"), profiles.skillsProfile);
  writeJson(join(runDir, "commands-profile.json"), profiles.commandsProfile);
  writeJson(join(runDir, "prompt-patterns.json"), profiles.promptPatterns);
  writeJson(join(runDir, "sessions-analysis.json"), profiles.sessionsAnalysis);
  writeJson(join(runDir, "session-evidence-index.json"), profiles.sessionEvidenceIndex);
  writeJson(join(runDir, "workflow-patterns.json"), profiles.workflowPatterns);
  writeText(join(runDir, "workflow-patterns.md"), renderWorkflowPatternsMarkdown(profiles.workflowPatterns));
  writeJson(join(runDir, "team-candidates.json"), profiles.teamCandidates);
  writeJson(join(runDir, "factory-candidates.json"), profiles.factoryCandidates);
  renderGeneratedProposals(runDir, profiles.teamCandidates, profiles.factoryCandidates);
}

export function renderWorkflowPatternsMarkdown(workflowPatterns) {
  const rows = workflowPatterns.patterns.map((pattern) => `| ${pattern.id} | ${pattern.confidence} | ${pattern.candidate_team ? "yes" : "no"} | ${pattern.description} |`).join("\n");
  return `# Workflow Patterns\n\n| Pattern | Confidence | Candidate team | Description |\n| --- | ---: | --- | --- |\n${rows}\n`;
}

export function renderGeneratedProposals(runDir, teamCandidates, factoryCandidates) {
  for (const candidate of teamCandidates.candidates) {
    writeJson(join(runDir, "generated-proposals", "teams", `${candidate.team_name}.json`), {
      schema: `${SCHEMA_PREFIX}.generated-team.v1`,
      ...candidate,
      generated_by: FACTORY_NAME,
    });
    writeText(join(runDir, "generated-proposals", "kickoff", `${candidate.team_name}-kickoff.md`), renderTeamKickoff(candidate));
    for (const role of candidate.roles) {
      writeText(join(runDir, "generated-proposals", "agents", `${role}.md`), renderGeneratedAgent(role, candidate));
    }
  }
  for (const candidate of factoryCandidates.candidates) {
    const dir = join(runDir, "generated-proposals", "factories", candidate.factory_name);
    writeJson(join(dir, "factory.json"), {
      name: candidate.factory_name,
      version: "0.1.0-proposal",
      description: candidate.purpose,
      status: candidate.activation_status,
      autoPromotion: false,
      manualPromotionRequired: true,
      inputContract: candidate.input_contract,
      expectedArtifacts: candidate.output_artifacts,
      validators: candidate.validators,
      modes: { smoke: candidate.smoke_mode, pilot: candidate.pilot_mode, batch: candidate.batch_mode },
      confidence: candidate.confidence,
      evidenceRefs: candidate.evidence_refs,
      blockers: candidate.blockers,
    });
    writeText(join(dir, "README.md"), `# ${candidate.factory_name}\n\nStatus: ${candidate.activation_status}.\n\n${candidate.purpose}\n\nThis is a quarantine proposal. Do not activate without owner review, validators, and oracle PASS/no_ship=false.\n`);
  }
}

export function renderTeamKickoff(candidate) {
  return `# ${candidate.team_name} Kickoff\n\nPurpose: ${candidate.purpose}\n\nEntry agent: ${candidate.entry_agent}\n\nRoles:\n${candidate.roles.map((role) => `- ${role}`).join("\n")}\n\nRules:\n- Keep all outputs under the run directory.\n- Preserve parent-visible coordination.\n- Do not activate generated artifacts automatically.\n- Cite evidence refs for each important claim.\n`;
}

export function renderGeneratedAgent(role, candidate) {
  return `---\nname: ${role}\ndescription: Generated quarantine role proposal for ${candidate.team_name}. Review before activation.\ntools: read,grep,find,ls,bash\n---\nYou are ${role}, a proposed ZOB harness-intake team role.\n\nMission: support ${candidate.purpose}\n\nRules:\n- Read only approved run artifacts and approved source refs.\n- Do not read secrets.\n- Do not mutate source project files.\n- Keep conclusions evidence-backed and cite artifact refs.\n- Return blockers instead of inventing missing evidence.\n\nOutput:\n- findings\n- evidence_refs\n- risks_blockers\n- recommended_next_steps\n- deliverable_delivered: yes/no\n`;
}
