import type { ModeName } from "../types.js";

export type ZobModeIntentConfidence = "low" | "medium" | "high";
export type ZobModeIntentRisk = "low" | "medium" | "high";

export interface ZobModeIntent {
  mode: ModeName;
  confidence: ZobModeIntentConfidence;
  reason: string;
  risk?: ZobModeIntentRisk;
}

export interface ZobModeIntentValidation {
  accepted: boolean;
  reason: string;
}

const VALID_MODES: readonly ModeName[] = ["explore", "plan", "implement", "oracle", "factory", "orchestrator"];

function modeName(value: string | undefined): ModeName | undefined {
  return VALID_MODES.includes(value as ModeName) ? value as ModeName : undefined;
}

function confidence(value: string | undefined): ZobModeIntentConfidence | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function risk(value: string | undefined): ZobModeIntentRisk | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function attributes(source: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const match of source.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g)) {
    parsed[match[1]!] = decodeAttribute(match[2] ?? "");
  }
  return parsed;
}

export function extractModeIntent(text: string): ZobModeIntent | undefined {
  const match = text.match(/<zob_mode_intent\b([^>]*)\/?\s*>/i);
  if (!match) return undefined;
  const attrs = attributes(match[1] ?? "");
  const mode = modeName(attrs.mode);
  const intentConfidence = confidence(attrs.confidence);
  if (!mode || !intentConfidence) return undefined;
  const reason = (attrs.reason || "same-agent mode intent").slice(0, 240);
  return { mode, confidence: intentConfidence, reason, risk: risk(attrs.risk) };
}

export function stripModeIntentMarkup(text: string): string {
  return text
    .replace(/^\s*<zob_mode_intent\b[^>]*\/?\s*>\s*$\n?/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function looksLikeCompletePlanResponse(text: string): boolean {
  const visible = stripModeIntentMarkup(text);
  if (visible.length < 240) return false;
  const sample = visible.slice(0, 2_400);
  let score = 0;
  if (/^\s*#{1,3}\s+.*\bplan\b/im.test(sample) || /^\s*(?:plan|planning|roadmap)\b/im.test(sample)) score += 2;
  if ((sample.match(/^\s*(?:#{1,4}\s*)?(?:phase|patch|étape|etape|step)\s+\d+/gim) ?? []).length >= 1) score += 1;
  if ((sample.match(/^\s*\d+[.)]\s+/gm) ?? []).length >= 3) score += 1;
  if ((sample.match(/^\s*[-*]\s+/gm) ?? []).length >= 4) score += 1;
  if (/\b(validation|tests?|risques?|risks?|fichiers?|files|scope|p[eé]rim[eè]tre|objectifs?|success looks like|r[eé]sultat attendu)\b/i.test(sample)) score += 1;
  if (/\b(impl[eé]mentation|patch|tdd|ordre recommandé|roadmap|architecture|phases?)\b/i.test(sample)) score += 1;
  if (/<answer>|<files>|<next_steps>/i.test(sample)) score += 1;
  return score >= 3;
}

function looksDestructive(text: string): boolean {
  return /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\b|shutdown\b|reboot\b|mkfs\b)\b|\.env\b|~\/\.ssh|~\/\.aws/i.test(text);
}

function hasModeEvidence(mode: ModeName, text: string): boolean {
  if (mode === "orchestrator") return /\b(orchestrator|orchestrat(?:e|ion|or)|orchestrer|multi[- ]?agent|lead(?:s)?|worker(?:s)?|chief vision|coordonn(?:e|er|ation)|d[eé]l[eè]gu(?:e|er|ation)|delegat(?:e|ion)|sub[- ]?agents?|subtasks?|work graph|todo graph|graphe de travail|graphe todo)\b/i.test(text);
  if (mode === "factory") return /\b(factory|factory_run|pilot|batch|sentinel|manifest|quarantine|software factory)\b/i.test(text);
  if (mode === "implement") return /\b(update|modify|modifier|change|changer|fix|patch|implement|impl[eé]mente|edit|write|[eé]cris|ajoute|add|create|cr[eé]e|refactor|refactorise|remplace|am[eé]lior(?:e|er)|appliqu(?:e|er)|mets?|mettre|rends?|rendre|fais\s+en\s+sorte)\b/i.test(text);
  if (mode === "oracle") return /\b(review|validate|validation|oracle|no[_-]?ship|v[eé]rifie|audit|qa|risks?|blocker)\b/i.test(text);
  if (mode === "plan") return /\b(plan|design|architecture|propose|roadmap|spec|sp[eé]cifie|comment|how would|strat[eé]gie)\b/i.test(text);
  return /\b(read|explore|inspect|analy[sz]e|cherche|comprends?|trouve|diagnostic)\b/i.test(text);
}

export function validateModeIntent(intent: ZobModeIntent | undefined, currentMode: ModeName, lastUserText = "", assistantText = ""): ZobModeIntentValidation {
  if (!intent) return { accepted: false, reason: "missing or invalid mode intent" };
  if (intent.mode === currentMode) return { accepted: false, reason: "mode already active" };
  if (intent.confidence === "low") return { accepted: false, reason: "low confidence mode intent ignored" };
  if (intent.risk === "high") return { accepted: false, reason: "high-risk mode intent requires explicit user action" };
  if (looksDestructive(`${lastUserText}\n${intent.reason}`)) return { accepted: false, reason: "destructive or secret-touching intent cannot auto-switch mode" };
  if (intent.mode === "plan" && looksLikeCompletePlanResponse(assistantText)) {
    return { accepted: false, reason: "plan mode intent ignored because this response already includes a complete plan" };
  }

  const evidence = hasModeEvidence(intent.mode, `${lastUserText}\n${intent.reason}`);
  if ((intent.mode === "implement" || intent.mode === "factory" || intent.mode === "orchestrator") && intent.confidence !== "high" && !evidence) {
    return { accepted: false, reason: `mode ${intent.mode} requires high confidence or explicit evidence` };
  }
  if (intent.mode === "oracle" && intent.confidence === "medium" && !evidence) {
    return { accepted: false, reason: "oracle mode requires review/validation evidence" };
  }
  return { accepted: true, reason: evidence ? "accepted with user-text evidence" : "accepted high-confidence same-agent intent" };
}
