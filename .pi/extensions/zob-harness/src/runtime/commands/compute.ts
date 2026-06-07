import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { buildComputePreview, resolveComputeProfile, type ComputeRequestedProfile } from "../../domains/compute/compute-profile.js";
import { buildComputeWorkflowShape } from "../../domains/compute/compute-workflow-shape.js";
import { sha256 } from "../../core/utils/hashing.js";
import type { HarnessRuntimeState } from "../state.js";
import { renderHarnessWidget } from "../widget.js";

const COMPUTE_PROFILES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
const COMPUTE_DOMAINS = ["generic", "project-dna", "factory", "orchestration"] as const;
function computeArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [
    { value: "auto", label: "auto", description: "preview then choose low/medium/high/xhigh/max" },
    { value: "low", label: "low", description: "fast single-agent/deterministic effort" },
    { value: "medium", label: "medium", description: "balanced default effort" },
    { value: "high", label: "high", description: "multi-lane + stronger validation" },
    { value: "xhigh", label: "xhigh", description: "extra-high quality + adversarial checks" },
    { value: "max", label: "max", description: "approval-gated maximum effort" },
    { value: "--domain project-dna", label: "--domain project-dna", description: "score as ProjectDNA/reference-project work" },
    { value: "--domain factory", label: "--domain factory", description: "score as factory workflow work" },
    { value: "--domain orchestration", label: "--domain orchestration", description: "score as orchestration work" },
    { value: "help", label: "help", description: "show compute command template" },
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function parseComputeCommandArgs(args: string): { requestedProfile: ComputeRequestedProfile; domain: string; targetPath: string; maxProfile?: string; riskHints: string[]; help: boolean } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let requestedProfile: ComputeRequestedProfile = "auto";
  let domain = "generic";
  let targetPath = ".";
  let maxProfile: string | undefined;
  const riskHints: string[] = [];
  let positionalTargetSeen = false;
  let help = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "help" || part === "--help" || part === "-h") {
      help = true;
      continue;
    }
    if (part === "--domain" && parts[index + 1]) {
      const next = parts[++index];
      domain = COMPUTE_DOMAINS.includes(next as typeof COMPUTE_DOMAINS[number]) ? next : "generic";
      continue;
    }
    if ((part === "--max" || part === "--max-profile") && parts[index + 1]) {
      maxProfile = parts[++index];
      continue;
    }
    if ((part === "--risk" || part === "--risk-hint") && parts[index + 1]) {
      riskHints.push(parts[++index]);
      continue;
    }
    if (COMPUTE_PROFILES.includes(part as ComputeRequestedProfile)) {
      requestedProfile = part as ComputeRequestedProfile;
      continue;
    }
    if (!positionalTargetSeen) {
      targetPath = part;
      positionalTargetSeen = true;
    }
  }
  return { requestedProfile, domain, targetPath, maxProfile, riskHints, help };
}

function computeHelpTemplate(): string {
  return [
    "# ZOB compute profile",
    "",
    "Usage examples:",
    "/compute auto .",
    "/compute high . --domain generic",
    "/compute xhigh . --risk durable --max-profile xhigh",
    "/effort medium .",
    "",
    "Profiles: auto | low | medium | high | xhigh | max",
    "Domains: generic | project-dna | factory | orchestration",
    "",
    "Notes:",
    "- preview/resolve only; no child dispatch",
    "- max remains approval-gated",
    "- childDirectDispatch=false",
  ].join("\n");
}

export function registerComputeCommands(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  const handleComputeCommand = async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): Promise<void> => {
    const parsed = parseComputeCommandArgs(args);
    if (parsed.help || args.trim().length === 0) {
      ctx.ui.setEditorText(computeHelpTemplate());
      ctx.ui.notify("ZOB compute command template inserted. Use /compute auto . or /effort high .", "info");
      return;
    }
    const preview = buildComputePreview(ctx.cwd, {
      domain: parsed.domain,
      requestedProfile: parsed.requestedProfile,
      targetPath: parsed.targetPath,
      maxProfile: parsed.maxProfile,
      riskHints: parsed.riskHints,
    });
    const resolution = resolveComputeProfile(ctx.cwd, {
      domain: parsed.domain,
      requestedProfile: parsed.requestedProfile,
      targetPath: parsed.targetPath,
      maxProfile: parsed.maxProfile,
      riskHints: parsed.riskHints,
    });
    const workflow = buildComputeWorkflowShape(ctx.cwd, {
      domain: parsed.domain,
      requestedProfile: parsed.requestedProfile,
      targetPath: parsed.targetPath,
      maxProfile: parsed.maxProfile,
      riskHints: parsed.riskHints,
    });
    const caps = resolution.caps && typeof resolution.caps === "object" ? resolution.caps as Record<string, unknown> : {};
    const effectiveProfile = typeof resolution.effectiveProfile === "string" ? resolution.effectiveProfile : "unknown";
    const recommendedProfile = typeof preview.recommendedProfile === "string" ? preview.recommendedProfile : "unknown";
    const laneCount = Array.isArray(workflow.lanes) ? workflow.lanes.length : 0;
    pi.appendEntry("zob-compute-profile", {
      schema: "zob.compute-command-preview.v1",
      requestedProfile: parsed.requestedProfile,
      recommendedProfile,
      effectiveProfile,
      domain: parsed.domain,
      targetPathHash: sha256(parsed.targetPath),
      targetPathStored: false,
      maxProfile: parsed.maxProfile,
      riskHints: parsed.riskHints,
      caps,
      laneCount,
      noShip: resolution.noShip === true,
      parentOwnedDispatch: true,
      childDirectDispatch: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
      generatedAt: new Date().toISOString(),
    });
    renderHarnessWidget(pi, state, ctx);
    const maxAgents = typeof caps.maxAgents === "number" ? caps.maxAgents : "?";
    const maxDepth = typeof caps.maxDelegationDepth === "number" ? caps.maxDelegationDepth : "?";
    const maxParallel = typeof caps.maxParallel === "number" ? caps.maxParallel : "?";
    const oracleRequired = caps.oracleRequired === true ? "oracle required" : "oracle conditional/off";
    const noShip = resolution.noShip === true ? " · no_ship=true" : "";
    ctx.ui.notify(`ZOB compute ${parsed.requestedProfile}→${effectiveProfile} (recommended ${recommendedProfile}) · agents≤${maxAgents} depth≤${maxDepth} parallel≤${maxParallel} · lanes=${laneCount} · ${oracleRequired}${noShip}`, resolution.noShip === true ? "warning" : "info");
  };

  pi.registerCommand("compute", {
    description: "Preview/resolve ZOB compute effort: /compute auto|low|medium|high|xhigh|max [target_path]",
    getArgumentCompletions: computeArgumentCompletions,
    handler: handleComputeCommand,
  });

  pi.registerCommand("effort", {
    description: "Alias for /compute. Example: /effort auto .",
    getArgumentCompletions: computeArgumentCompletions,
    handler: handleComputeCommand,
  });
}
