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

const VALID_MODES: readonly ModeName[] = ["explore", "plan", "implement", "oracle", "factory", "orchestrator", "vanilla"];

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
  if ((sample.match(/^\s*(?:#{1,4}\s*)?(?:phase|patch|step)\s+\d+/gim) ?? []).length >= 1) score += 1;
  if ((sample.match(/^\s*\d+[.)]\s+/gm) ?? []).length >= 3) score += 1;
  if ((sample.match(/^\s*[-*]\s+/gm) ?? []).length >= 4) score += 1;
  if (/\b(validation|tests?|risks?|files|scope|objectives?|success looks like|expected result)\b/i.test(sample)) score += 1;
  if (/\b(implementation|patch|tdd|recommended order|roadmap|architecture|phases?)\b/i.test(sample)) score += 1;
  if (/<answer>|<files>|<next_steps>/i.test(sample)) score += 1;
  return score >= 3;
}

const DESTRUCTIVE_COMMAND_PATTERN = /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\b|shutdown\b|reboot\b|mkfs\b)\b/i;
const SECRET_REF_PATTERN = /(?:\.env\b|~\/\.ssh|~\/\.aws|\bssh\b|\baws\b|\b(?:api[_-]?key|private key|secret key|keys?|credentials?|secrets?)\b)/i;
const SECRET_TOUCH_ACTION_PATTERN = /\b(read|open|cat|print|show|copy|upload|exfiltrate|inspect|touch|modify|edit|write|access|use|load|source|dump|list)\b/i;
const NEGATIVE_SAFETY_INSTRUCTION_PATTERN = /\b(?:do not|don't|must not|never|avoid|without|forbidden_paths?|forbidden|deny(?:list)?|no secrets?)\b/i;
const PROMPT_INJECTION_NEGATIVE_PATTERN = /\b(?:do not|don't|must not|never)\s+(?:ignore|obey|follow|respect|comply|listen|refuse|decline)\b/i;
const NEGATIVE_SECRET_CLAUSE_SPLIT_PATTERN = /\b(?:but|however|except|unless|then|also|or|and)\b|[:,]/i;

function hasSecretTouchAction(part: string): boolean {
  return SECRET_REF_PATTERN.test(part) && SECRET_TOUCH_ACTION_PATTERN.test(part);
}

function isBenignNegativeSecretInstruction(part: string): boolean {
  if (!NEGATIVE_SAFETY_INSTRUCTION_PATTERN.test(part) || !hasSecretTouchAction(part)) return false;
  if (PROMPT_INJECTION_NEGATIVE_PATTERN.test(part)) return false;

  const [, ...tails] = part.split(NEGATIVE_SECRET_CLAUSE_SPLIT_PATTERN);
  return !tails.some((tail) => hasSecretTouchAction(tail) && !NEGATIVE_SAFETY_INSTRUCTION_PATTERN.test(tail));
}

function looksSecretTouching(text: string): boolean {
  return text
    .split(/[!?;\n]+|(?<=\S)\.(?=\s|$)/)
    .some((part) => hasSecretTouchAction(part) && !isBenignNegativeSecretInstruction(part));
}

function looksDestructive(text: string): boolean {
  return DESTRUCTIVE_COMMAND_PATTERN.test(text) || looksSecretTouching(text);
}

function hasModeEvidence(mode: ModeName, text: string): boolean {
  if (mode === "orchestrator") return /\b(orchestrator|orchestrat(?:e|ion|or)|multi[- ]?agent|lead(?:s)?|worker(?:s)?|chief vision|delegat(?:e|ion)|sub[- ]?agents?|subtasks?|work graph|todo graph)\b/i.test(text);
  if (mode === "factory") return /\b(factory|factory_run|pilot|batch|sentinel|manifest|quarantine|software factory)\b/i.test(text);
  if (mode === "implement") return /\b(update|modify|change|fix|patch|implement|edit|write|add|create|refactor)\b/i.test(text);
  if (mode === "vanilla") return /\b(vanilla|vania|pi\s+base|base\s+pi|codex|external\s+(?:command|tool|agent)|unrestricted|arbitrary\s+command|no\s+guardrails?)\b/i.test(text);
  if (mode === "oracle") return /\b(review|validate|validation|oracle|no[_-]?ship|verify|audit|qa|risks?|blocker)\b/i.test(text);
  if (mode === "plan") return /\b(plan|design|architecture|propose|roadmap|specify|how would|strategy)\b/i.test(text);
  return /\b(read|explore|inspect|analy[sz]e|understand|find|diagnostic)\b/i.test(text);
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
  if (intent.mode === "vanilla" && !evidence) {
    return { accepted: false, reason: "vanilla mode requires explicit user-text evidence for Pi base/unrestricted external-command behavior" };
  }
  if (intent.mode === "oracle" && intent.confidence === "medium" && !evidence) {
    return { accepted: false, reason: "oracle mode requires review/validation evidence" };
  }
  return { accepted: true, reason: evidence ? "accepted with user-text evidence" : "accepted high-confidence same-agent intent" };
}
