import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact, generateBranchSummary, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { MODE_PROMPTS, ZOB_COMPACTION_CONTINUITY_CONTRACT, ZOB_TOOL_ROUTING_CONTRACT } from "../constants.js";
import { buildCurrentZobLivePeerCard } from "../coms-v2/identity.js";
import { buildZobLiveAckEnvelope, buildZobLiveErrorEnvelope, buildZobLivePongEnvelope } from "../coms-v2/envelope.js";
import { appendLiveCompletedRef } from "../coms-v2/ledger-bridge.js";
import { bindZobLocalEndpoint, makeZobLocalEndpoint, sendZobLocalEnvelope } from "../coms-v2/local-transport.js";
import { readZobComsV2Policy } from "../coms-v2/policy.js";
import { registerCurrentZobLivePeer, touchCurrentZobLivePeer, unregisterCurrentZobLivePeer, writeZobLivePeerCard } from "../coms-v2/registry.js";
import { buildZobLiveResponseEnvelope } from "../coms-v2/response-capture.js";
import { writeZobComsRedactedCapture } from "../coms-v2/transcript-capture.js";
import { formatGoalActivationMode, runtimeGoalStatusLine } from "../goal-runtime.js";
import { formatInteractiveAutonomyPromptHint, formatMissionReadinessForUi, scoreMissionReadiness, toMissionReadinessLedgerEntry } from "../interactive-autonomy.js";
import { formatGoalTodoPromptHint } from "../goal-todos.js";
import { resolveRuleProfile } from "../rules.js";
import { loadDamageRules } from "../safety.js";
import { loadTeamDefinition, validateTeamDefinition } from "../topology/teams.js";
import type { AssistantLikeMessage } from "../types.js";
import { blockedFeedback } from "../utils/formatting.js";
import { sha256 } from "../utils/hashing.js";
import { pathMatches } from "../utils/paths.js";
import { isRecord, textFromMessage } from "../utils/records.js";
import { showDelegationOverlay } from "./delegation-overlay.js";
import { buildDeterministicZobCompactionResult, buildDeterministicZobCompactionSummary, buildZobCompactionInstructions, buildZobCompactionLedgerEntry, withZobCompactionDetails, ZOB_COMPACTION_ENTRY_TYPE, zobCompactionBodyFreeViolations } from "./compaction-policy.js";
import { disposeDelegationMouseSupport } from "./delegation-mouse.js";
import type { HarnessRuntimeState } from "./state.js";
import { bashLooksLikeFileMutation, inferModeFromUserIntent, restoreHarnessState } from "./state.js";
import { extractModeIntent, stripModeIntentMarkup, validateModeIntent, type ZobModeIntent } from "./mode-intent.js";
import { capturePlanArtifact } from "./plan-capture.js";
import { applyMode, renderHarnessWidget } from "./widget.js";

function safelyUpdateZobLivePeer(repoRoot: string, action: "register" | "touch" | "unregister"): void {
  try {
    if (action === "register") registerCurrentZobLivePeer(repoRoot);
    else if (action === "touch") touchCurrentZobLivePeer(repoRoot);
    else unregisterCurrentZobLivePeer(repoRoot);
  } catch {
    // Live presence is observe-only in this phase and must not break the harness runtime.
  }
}

const SAME_AGENT_MODE_INTENT_PROMPT = [
  "ZOB SAME-AGENT AUTO-MODE INTENT",
  "- If the current ZOB mode does not match the next required action, emit at most one standalone intent line:",
  "  <zob_mode_intent mode=\"explore|plan|implement|oracle|factory|orchestrator\" confidence=\"low|medium|high\" risk=\"low|medium|high\" reason=\"short reason\"/>",
  "- This is only a suggestion; the harness validates and applies mode changes.",
  "- Do not claim the mode switched unless the harness reports it.",
  "- SINGLE-PLAN RULE: if you produce a complete plan in this response, do not also emit a plan-mode intent.",
  "- Emit mode=plan only when deferring the actual detailed plan to a follow-up turn; in that case keep this response to a short handoff.",
  "- Never both: full plan content and mode=plan intent in the same response.",
  "- Prefer orchestrator for multi-agent decomposition, Chief Vision coordination, Lead/Worker orchestration, TODO/workgraph routing, and parent-owned dispatch.",
  "- Prefer implement for code/file edits, oracle for validation/review/no-ship, factory for reusable repeatable workflows/factories.",
  "- Do not emit an intent for ordinary discussion or when the current mode already fits.",
].join("\n");

function latestAssistantText(event: unknown): string {
  const messages = isRecord(event) && Array.isArray(event.messages) ? event.messages : [];
  const assistantMessages = messages.filter((message): message is AssistantLikeMessage => isRecord(message) && message.role === "assistant");
  return textFromMessage(assistantMessages.at(-1));
}

function stripModeIntentFromMessage<T extends { content?: unknown }>(message: T): T {
  const content = message.content;
  if (typeof content === "string") return { ...message, content: stripModeIntentMarkup(content) };
  if (!Array.isArray(content)) return message;
  const mapped = content.map((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
    return { ...part, text: stripModeIntentMarkup(part.text) };
  }).filter((part) => !(isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length === 0));
  return { ...message, content: mapped.length > 0 ? mapped : "" } as T;
}

function modeIntentContent(intent: ZobModeIntent, previousMode: string, accepted: boolean, validationReason: string): string {
  const status = accepted ? `${previousMode} → ${intent.mode}` : `${intent.mode} ignored`;
  return `${status} · ${intent.confidence}${intent.risk ? `/${intent.risk}` : ""} · ${intent.reason} · ${validationReason}`;
}

function handleSameAgentModeIntent(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: ExtensionContext, intent: ZobModeIntent, assistantText = ""): void {
  const previousMode = state.activeMode;
  const validation = validateModeIntent(intent, state.activeMode, state.lastUserInputText ?? "", assistantText);
  state.lastModeIntent = { ...intent, at: Date.now(), accepted: validation.accepted, validationReason: validation.reason };
  if (validation.accepted) {
    applyMode(pi, state, ctx, intent.mode);
    ctx.ui.notify(`ZOB same-agent auto-mode: ${previousMode} → ${intent.mode} (${intent.confidence}; ${intent.reason})`, "info");
  } else {
    renderHarnessWidget(pi, state, ctx);
  }
  pi.sendMessage({
    customType: "zob-mode-intent",
    content: modeIntentContent(intent, previousMode, validation.accepted, validation.reason),
    display: true,
    details: { intent, previousMode, accepted: validation.accepted, validationReason: validation.reason, at: new Date().toISOString() },
  }, { triggerTurn: false });
}

async function startOrRefreshZobLiveRuntime(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string): Promise<void> {
  const policy = readZobComsV2Policy(repoRoot);
  if (policy.mode !== "required_local") {
    safelyUpdateZobLivePeer(repoRoot, state.zobLive.peerCard ? "touch" : "register");
    return;
  }
  const team = loadTeamDefinition(repoRoot, "zob-core");
  const errors = [...team.errors, ...validateTeamDefinition(repoRoot, team.definition)];
  if (errors.length > 0 || !team.definition) throw new Error(errors.join("; "));
  const definition = team.definition;
  if (!state.zobLive.server || !state.zobLive.peerCard) {
    const basePeer = buildCurrentZobLivePeerCard(repoRoot, definition, policy);
    const endpoint = makeZobLocalEndpoint(basePeer.sessionId);
    const server = await bindZobLocalEndpoint(endpoint, async (envelope) => {
      if (envelope.type === "ping") return buildZobLivePongEnvelope(envelope);
      if (envelope.type === "response") {
        state.zobLive.pendingReplies.complete(envelope.msgId, envelope);
        const parentMsgId = envelope.runId && envelope.receiver && envelope.sender ? `${envelope.runId}:${envelope.receiver}:${envelope.sender}:${envelope.msgId}` : undefined;
        if (parentMsgId) {
          try { appendLiveCompletedRef(repoRoot, definition, parentMsgId, envelope); } catch { /* best-effort ledger correlation; await response still completes */ }
        }
        return buildZobLiveAckEnvelope(envelope);
      }
      if (envelope.type !== "prompt") return buildZobLiveErrorEnvelope(envelope, `Unsupported inbound envelope type: ${envelope.type}`, "unsupported_envelope");
      state.zobLive.inbound = { envelope, receivedAt: new Date().toISOString(), responseSent: false, repoRoot };
      void pi.sendMessage({
        customType: "zob-coms-inbound",
        content: envelope.transientPrompt ?? "",
        display: false,
        details: { kind: "zob-coms-inbound", msgId: envelope.msgId, runId: envelope.runId, sender: envelope.sender, receiver: envelope.receiver, taskHash: envelope.taskHash },
      }, { triggerTurn: true, deliverAs: "followUp" });
      return buildZobLiveAckEnvelope(envelope);
    });
    const peerCard = { ...basePeer, transport: "local_socket" as const, endpoint, endpointHash: sha256(endpoint), status: "online" as const };
    writeZobLivePeerCard(repoRoot, peerCard);
    state.zobLive.server = server;
    state.zobLive.peerCard = peerCard;
  } else {
    state.zobLive.peerCard = writeZobLivePeerCard(repoRoot, { ...state.zobLive.peerCard, heartbeatAt: new Date().toISOString(), status: "online" });
  }
}

async function stopZobLiveRuntime(state: HarnessRuntimeState, repoRoot: string): Promise<void> {
  try {
    if (state.zobLive.peerCard) writeZobLivePeerCard(repoRoot, { ...state.zobLive.peerCard, heartbeatAt: new Date().toISOString(), status: "offline" });
    if (state.zobLive.server) await state.zobLive.server.close();
  } finally {
    state.zobLive = { pendingReplies: state.zobLive.pendingReplies };
  }
}

function notifyWhenUi(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

async function compactionAuth(ctx: ExtensionContext): Promise<{ apiKey?: string; headers?: Record<string, string> } | undefined> {
  const model = ctx.model;
  if (!model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;
  return { apiKey: auth.apiKey, headers: auth.headers };
}

async function sendInboundZobLiveResponse(state: HarnessRuntimeState, event: unknown): Promise<void> {
  const inbound = state.zobLive.inbound;
  if (!inbound || inbound.responseSent || !inbound.envelope.replyEndpoint) return;
  const responseText = latestAssistantText(event);
  if (!responseText.trim()) return;
  const policy = readZobComsV2Policy(inbound.repoRoot);
  let responseCapture: ReturnType<typeof writeZobComsRedactedCapture>;
  try {
    responseCapture = writeZobComsRedactedCapture(inbound.repoRoot, policy.transcriptCapture, {
      runId: inbound.envelope.runId,
      msgId: inbound.envelope.msgId,
      sender: inbound.envelope.receiver,
      receiver: inbound.envelope.sender,
      team: inbound.envelope.team,
      kind: "live_exchange",
      taskHash: inbound.envelope.taskHash,
      outputHash: sha256(responseText),
      transientPrompt: inbound.envelope.transientPrompt,
      transientResponse: responseText,
      artifactRefs: inbound.envelope.artifactRefs,
    });
  } catch {
    responseCapture = undefined;
  }
  const artifactRefs = responseCapture ? [...(inbound.envelope.artifactRefs ?? []), responseCapture.artifactRef] : inbound.envelope.artifactRefs;
  const artifactHashes = responseCapture ? [...(inbound.envelope.artifactHashes ?? []), responseCapture.artifactHash] : inbound.envelope.artifactHashes;
  const responseEnvelope = buildZobLiveResponseEnvelope(inbound.envelope, responseText, artifactRefs, artifactHashes);
  await sendZobLocalEnvelope(inbound.envelope.replyEndpoint, responseEnvelope, { timeoutMs: 5_000 });
  state.zobLive.inbound = { ...inbound, responseSent: true };
}

export function registerHarnessEvents(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerMessageRenderer("zob-mode-intent", (message, { expanded }, theme) => {
    const details = isRecord(message.details) ? message.details : {};
    const intent = isRecord(details.intent) ? details.intent : {};
    const mode = typeof intent.mode === "string" ? intent.mode : "mode";
    const confidence = typeof intent.confidence === "string" ? intent.confidence : "?";
    const risk = typeof intent.risk === "string" ? intent.risk : "low";
    const previousMode = typeof details.previousMode === "string" ? details.previousMode : "current";
    const accepted = details.accepted === true;
    const validationReason = typeof details.validationReason === "string" ? details.validationReason : "validated";
    const reason = typeof intent.reason === "string" ? intent.reason : String(message.content ?? "");
    const icon = accepted ? "◆" : "◇";
    const color = accepted ? "success" : "dim";
    const status = accepted ? `${previousMode} → ${mode}` : `${mode} ignored`;
    const line = [
      theme.fg(color, `${icon} auto-mode`),
      theme.fg(accepted ? "accent" : "muted", status),
      theme.fg(confidence === "high" ? "success" : confidence === "medium" ? "warning" : "dim", confidence),
      theme.fg(risk === "high" ? "warning" : "dim", `risk ${risk}`),
      theme.fg("muted", reason),
    ].join(theme.fg("dim", " · "));
    const expandedLine = expanded ? `\n${theme.fg("dim", validationReason)}` : "";
    return new Text(`${line}${expandedLine}`, 0, 0);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") {
      const delegatesMatch = event.text.trim().match(/^\/(?:delegates?|view[_-]?delegates)(?:\s+(\S+))?$/i);
      if (delegatesMatch) {
        await showDelegationOverlay(ctx, state, delegatesMatch[1]);
        return { action: "handled" as const };
      }
      state.lastUserInputText = event.text;
      if (!event.text.trim().startsWith("/") && state.autonomy.enabled) {
        const readiness = scoreMissionReadiness(event.text, { mode: state.autonomy.mode, policy: state.autonomy.policy });
        state.autonomy.lastReadiness = readiness;
        state.autonomy.lastLaunchAuthorization = readiness.launchAuthorization;
        state.autonomy.updatedAt = readiness.generatedAt;
        pi.appendEntry("zob-mission-readiness", toMissionReadinessLedgerEntry(readiness));
        if (readiness.decision === "auto_launch") ctx.ui.notify(`${formatMissionReadinessForUi(readiness)} · launch authorized in-scope`, "info");
        else if (readiness.decision === "block") ctx.ui.notify(formatMissionReadinessForUi(readiness), "warning");
      }
    }
    if (event.source === "extension" || state.activeMode !== "explore") return { action: "continue" as const };
    const nextMode = inferModeFromUserIntent(event.text);
    if (!nextMode) return { action: "continue" as const };
    applyMode(pi, state, ctx, nextMode);
    const reason = nextMode === "orchestrator" ? "orchestration intent detected" : nextMode === "factory" ? "factory workflow intent detected" : "write/update intent detected";
    ctx.ui.notify(`ZOB auto-mode: explore → ${nextMode} (${reason})`, "info");
    return { action: "continue" as const };
  });

  pi.on("tool_call", async (event, ctx) => {
    let violation: string | undefined;
    let attempted = JSON.stringify(event.input);

    const pathInputs: string[] = [];
    if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      pathInputs.push(event.input.path);
    }
    if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
      pathInputs.push(event.input.path ?? ".");
    }

    for (const inputPath of pathInputs) {
      for (const protectedPattern of state.currentRules.zeroAccessPaths) {
        if (pathMatches(inputPath, protectedPattern, ctx.cwd)) violation = `zero-access path: ${protectedPattern}`;
      }
      if ((event.toolName === "write" || event.toolName === "edit") && state.activeMode === "explore" && !violation) {
        violation = "explore mode is read-only; switch to /zmode implement and use edit/write for file updates";
      }
      if ((event.toolName === "write" || event.toolName === "edit") && !violation) {
        for (const readOnly of state.currentRules.readOnlyPaths) {
          if (pathMatches(inputPath, readOnly, ctx.cwd)) violation = `read-only path: ${readOnly}`;
        }
      }
    }

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;
      attempted = command;
      if (state.activeMode === "explore" && bashLooksLikeFileMutation(command)) {
        violation = "explore mode is read-only; do not mutate files through bash/python/perl/node patch scripts";
      }
      for (const rule of state.currentRules.bashToolPatterns) {
        if (violation) break;
        if (new RegExp(rule.pattern, "i").test(command)) {
          if (rule.ask && ctx.hasUI) {
            const ok = await ctx.ui.confirm("ZOB damage-control", `${rule.reason}\n\n${command}\n\nAllow?`, { timeout: 30000 });
            if (ok) return;
          }
          violation = rule.reason;
          break;
        }
      }
      if (!violation) {
        for (const protectedPattern of state.currentRules.zeroAccessPaths) {
          if (command.includes(protectedPattern)) violation = `bash references zero-access path: ${protectedPattern}`;
        }
      }
      if (!violation) {
        for (const noDelete of state.currentRules.noDeletePaths) {
          if (command.includes(noDelete) && /\b(rm|mv)\b/.test(command)) violation = `delete/move protected path: ${noDelete}`;
        }
      }
    }

    if (violation) {
      pi.appendEntry("zob-damage-control", { tool: event.toolName, input: event.input, violation, timestamp: Date.now() });
      ctx.ui.notify(`Blocked ${event.toolName}: ${violation}`, "warning");
      return { block: true, reason: blockedFeedback(event.toolName, violation, attempted) };
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isRecord(event.message) || event.message.role !== "assistant") return undefined;
    const text = textFromMessage(event.message as AssistantLikeMessage);
    const visibleText = stripModeIntentMarkup(text);
    try {
      const capture = capturePlanArtifact(ctx.cwd, { assistantText: visibleText, userText: state.lastUserInputText, mode: state.activeMode });
      if (capture.captured && capture.relativePath) ctx.ui.notify(`ZOB plan saved: ${capture.relativePath}`, "info");
    } catch {
      // Plan capture is best-effort and must not break assistant message handling.
    }
    const intent = extractModeIntent(text);
    if (!intent) return undefined;
    handleSameAgentModeIntent(pi, state, ctx, intent, text);
    return { message: stripModeIntentFromMessage(event.message) };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const fallback = (reason: string) => {
      notifyWhenUi(ctx, `ZOB-aware deterministic compaction fallback: ${reason}`, "warning");
      return {
        compaction: buildDeterministicZobCompactionResult(state, event.preparation, {
          reason: event.customInstructions ? "manual" : "threshold",
          customInstructions: event.customInstructions,
          fileOps: event.preparation.fileOps,
        }),
      };
    };
    const auth = await compactionAuth(ctx);
    if (!ctx.model || !auth) return fallback("model/auth unavailable");
    const customInstructions = buildZobCompactionInstructions(state, {
      reason: event.customInstructions ? "manual" : "threshold",
      customInstructions: event.customInstructions,
      fileOps: event.preparation.fileOps,
    });
    try {
      const result = await compact(event.preparation, ctx.model, auth.apiKey, auth.headers, customInstructions, event.signal);
      if (!result.summary.trim()) return fallback("model returned empty summary");
      const compaction = withZobCompactionDetails(state, result, { fileOps: event.preparation.fileOps });
      const violations = zobCompactionBodyFreeViolations(compaction.details);
      if (violations.length > 0) return fallback(`body-free detail violation: ${violations.slice(0, 2).join(", ")}`);
      return { compaction };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fallback(message);
    }
  });

  pi.on("session_compact", async (event) => {
    const ledger = buildZobCompactionLedgerEntry(state, {
      event: "session_compact",
      summary: event.compactionEntry.summary,
      firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
      tokensBefore: event.compactionEntry.tokensBefore,
      fromExtension: event.fromExtension,
    });
    if (zobCompactionBodyFreeViolations(ledger).length === 0) pi.appendEntry(ZOB_COMPACTION_ENTRY_TYPE, ledger);
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (!event.preparation.userWantsSummary) return undefined;
    const fallback = (reason: string) => {
      notifyWhenUi(ctx, `ZOB-aware deterministic branch summary fallback: ${reason}`, "warning");
      const summary = buildDeterministicZobCompactionSummary(state, {
        reason: "branch_summary",
        customInstructions: event.preparation.customInstructions,
      });
      const details = buildZobCompactionLedgerEntry(state, {
        event: "session_tree",
        summary,
        fromExtension: true,
      });
      return { summary: { summary, details } };
    };
    const auth = await compactionAuth(ctx);
    if (!ctx.model || !auth) return fallback("model/auth unavailable");
    const customInstructions = buildZobCompactionInstructions(state, {
      reason: "branch_summary",
      customInstructions: event.preparation.customInstructions,
    });
    try {
      const result = await generateBranchSummary(event.preparation.entriesToSummarize, {
        model: ctx.model,
        apiKey: auth.apiKey ?? "",
        headers: auth.headers,
        signal: event.signal,
        customInstructions,
        replaceInstructions: event.preparation.replaceInstructions,
      });
      if (!result.summary?.trim()) return fallback("model returned empty summary");
      const details = buildZobCompactionLedgerEntry(state, {
        event: "session_tree",
        summary: result.summary,
        readFiles: result.readFiles,
        modifiedFiles: result.modifiedFiles,
        fromExtension: true,
      });
      const violations = zobCompactionBodyFreeViolations(details);
      if (violations.length > 0) return fallback(`body-free detail violation: ${violations.slice(0, 2).join(", ")}`);
      return { summary: { summary: result.summary, details } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fallback(message);
    }
  });

  pi.on("before_agent_start", async (event) => {
    const goalHint = state.activeGoal
      ? `\n\nZOB GOAL GATE\n- ORIGINAL_USER_ASK: ${state.activeGoal.originalUserAsk}\n- ACTIVE_GOAL: ${state.activeGoal.activeGoal}\n- EXPECTED_OUTPUT: ${state.activeGoal.expectedOutput}\n- CONSTRAINTS: ${state.activeGoal.constraints}\n- VALIDATION_EVIDENCE: ${state.activeGoal.validationEvidence}`
      : "\n\nZOB GOAL GATE\n- No active goal set. If the request is broad or multi-step, use /goal_gate first or restate ORIGINAL_USER_ASK / ACTIVE_GOAL explicitly before delegating.";
    const runtimeGoalHint = state.runtimeGoal
      ? `\n\nZOB RUNTIME GOAL\n- ${runtimeGoalStatusLine(state.runtimeGoal)}\n- activation_mode: ${formatGoalActivationMode(state.goalActivationMode)}\n- objective: ${state.runtimeGoal.objective}\n- completion policy: use resolve_goal_todo for TODO transitions; call propose_goal_completion when evidence is complete; update_goal complete is allowed only after oracle PASS/no_ship=false.\n- no_ship model: hard_no_ship blocks completion, review_no_ship is advisory review evidence, effective_no_ship is their union.\n\nZOB GOAL TODOS\n${formatGoalTodoPromptHint(state.goalTodos, state.runtimeGoal.goalId)}`
      : `\n\nZOB RUNTIME GOAL\n- No runtime /goal set. Use /goal <objective> for long-running looped work; use /goal gate for strict scope.\n- activation_mode: ${formatGoalActivationMode(state.goalActivationMode)}\n\nZOB GOAL TODOS\n${formatGoalTodoPromptHint(state.goalTodos, undefined)}`;
    const rules = state.activeRuleResolution;
    const rulesHint = rules
      ? `\n\nZOB RULE PROFILE\n- profile: ${rules.profile}\n- rule packs: ${rules.rulePacks.join(", ") || "none"}\n- required validation: ${rules.requiredValidation.join(" | ") || "not specified"}\n- oracle required: ${String(rules.oracleRequired)}\n- no-ship conditions: ${rules.noShipConditions.slice(0, 6).join(" | ") || "none"}`
      : "\n\nZOB RULE PROFILE\n- Not resolved yet. Use /rules_status for diagnostics when scope is unclear.";
    const autonomyHint = `\n\n${formatInteractiveAutonomyPromptHint(state.autonomy)}`;
    const contractHint = `\n\nZOB HARNESS OPERATING CONTRACT\n- Prefer Explore -> Plan -> Implement -> Oracle for non-trivial work.\n- Use the six-part contract for delegated work: TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT.\n- Do not claim completion without concrete evidence.\n- If output may truncate, prioritize verdict, blockers, and next steps over exhaustive listings.\n\n${SAME_AGENT_MODE_INTENT_PROMPT}\n\n${ZOB_TOOL_ROUTING_CONTRACT}\n\n${ZOB_COMPACTION_CONTINUITY_CONTRACT}\n\n${MODE_PROMPTS[state.activeMode]}${goalHint}${runtimeGoalHint}${rulesHint}${autonomyHint}`;
    return { systemPrompt: `${event.systemPrompt}${contractHint}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    disposeDelegationMouseSupport(state, { force: true });
    state.currentRules = loadDamageRules(ctx.cwd);
    state.delegations.runs = [];
    restoreHarnessState(state, ctx);
    state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
    await startOrRefreshZobLiveRuntime(pi, state, ctx.cwd);
    applyMode(pi, state, ctx, state.activeMode, false);
    renderHarnessWidget(pi, state, ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    await startOrRefreshZobLiveRuntime(pi, state, ctx.cwd);
    renderHarnessWidget(pi, state, ctx);
  });

  pi.on("agent_end", async (event) => {
    try {
      await sendInboundZobLiveResponse(state, event);
    } catch {
      // Response capture is best-effort until the full live await path is enabled.
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state.daemon.loopTimer) clearTimeout(state.daemon.loopTimer);
    state.daemon.loopTimer = undefined;
    state.daemon.loop = {
      ...state.daemon.loop,
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      blocker: state.daemon.loop.status === "running" ? "session_shutdown" : state.daemon.loop.blocker,
      autoStartDaemon: false,
      continuousLoop: false,
      cronEnabled: false,
    };
    await stopZobLiveRuntime(state, ctx.cwd);
    safelyUpdateZobLivePeer(ctx.cwd, "unregister");
    disposeDelegationMouseSupport(state, { force: true });
    ctx.ui.setWidget("zob-harness", undefined);
    ctx.ui.setStatus("zob-mode", undefined);
    ctx.ui.setStatus("zob-usage", undefined);
  });
}
