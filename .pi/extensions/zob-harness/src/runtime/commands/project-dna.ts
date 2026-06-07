import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { buildProjectDnaAgenticPlan, buildProjectDnaQueryResult, buildProjectDnaReadinessAudit } from "../../domains/project-dna/project-dna.js";
import { sha256 } from "../../core/utils/hashing.js";
import type { HarnessRuntimeState } from "../state.js";

function projectDnaArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [
    { value: "readiness", label: "readiness", description: "audit ProjectDNA repo-local readiness" },
    { value: "plan .pi/factories/project-dna/example-project-dna-manifest-v2.json reports/project-dna-scans/project-dna-factory-smoke", label: "plan workflow", description: "metadata-only agentic workflow plan from manifest v2" },
    { value: "query reports/project-dna-scans/project-dna-factory-smoke factory schema validation", label: "query smoke", description: "bounded cited query against smoke scan artifacts" },
    { value: "query reports/project-dna-scans/pi-real-20260529-v1 register tool extension command runtime", label: "query pi-real", description: "bounded cited query against existing real Pi scan artifacts" },
    { value: "help", label: "help", description: "show ProjectDNA command template" },
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function projectDnaHelpTemplate(): string {
  return [
    "# ZOB ProjectDNA",
    "",
    "Usage examples:",
    "/project-dna readiness",
    "/project-dna plan .pi/factories/project-dna/example-project-dna-manifest-v2.json reports/project-dna-scans/project-dna-factory-smoke",
    "/project-dna query reports/project-dna-scans/project-dna-factory-smoke factory schema validation",
    "/project-dna query reports/project-dna-scans/pi-real-20260529-v1 register tool extension command runtime",
    "",
    "Notes:",
    "- plan builds metadata-only agentic workflow shape from manifest v2",
    "- query reads repo-local ProjectDNA scan artifacts only",
    "- returns bounded cited context packs",
    "- raw query text is hashed in outputs and not persisted",
    "- no source scan, no backend write, no child dispatch",
  ].join("\n");
}

function parseProjectDnaCommandArgs(args: string): { mode: "help" | "readiness" | "plan" | "query"; manifestPath?: string; scanDir?: string; query?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0] === "help" || parts[0] === "--help" || parts[0] === "-h") return { mode: "help" };
  if (parts[0] === "readiness") return { mode: "readiness", scanDir: parts[1] };
  if (parts[0] === "plan") {
    const manifestPath = parts[1];
    const scanDir = parts[2]?.startsWith("reports/project-dna-scans/") ? parts[2] : undefined;
    return manifestPath ? { mode: "plan", manifestPath, scanDir } : { mode: "help" };
  }
  if (parts[0] === "query") {
    const maybeScanDir = parts[1];
    const hasScanDir = typeof maybeScanDir === "string" && maybeScanDir.startsWith("reports/project-dna-scans/");
    const scanDir = hasScanDir ? maybeScanDir : undefined;
    const queryText = parts.slice(hasScanDir ? 2 : 1).join(" ").trim();
    return { mode: queryText ? "query" : "help", scanDir, query: queryText };
  }
  return { mode: "query", query: parts.join(" ") };
}

export function registerProjectDnaCommand(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  const handleProjectDnaCommand = async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): Promise<void> => {
    const parsed = parseProjectDnaCommandArgs(args);
    if (parsed.mode === "help") {
      ctx.ui.setEditorText(projectDnaHelpTemplate());
      ctx.ui.notify("ZOB ProjectDNA command template inserted.", "info");
      return;
    }
    if (parsed.mode === "readiness") {
      const audit = buildProjectDnaReadinessAudit(ctx.cwd, { scanDir: parsed.scanDir });
      pi.appendEntry("zob-project-dna-command", {
        schema: "zob.project-dna-command-readiness.v1",
        scanDirHash: sha256(parsed.scanDir ?? "reports/project-dna-scans/project-dna-factory-smoke"),
        scanDirStored: false,
        verdict: audit.verdict,
        noShip: audit.no_ship === true,
        bodyStored: false,
        generatedAt: new Date().toISOString(),
      });
      ctx.ui.notify(`ZOB ProjectDNA readiness: ${String(audit.verdict)}${audit.no_ship === true ? " · no_ship=true" : ""}`, audit.no_ship === true ? "warning" : "info");
      return;
    }
    if (parsed.mode === "plan") {
      const plan = buildProjectDnaAgenticPlan(ctx.cwd, { manifestPath: parsed.manifestPath ?? "", scanDir: parsed.scanDir });
      const lanes = Array.isArray(plan.lanes) ? plan.lanes.length : 0;
      const effectiveProfile = typeof plan.effective_compute_profile === "string" ? plan.effective_compute_profile : "unknown";
      const effectiveCapture = typeof plan.effective_capture_mode === "string" ? plan.effective_capture_mode : "unknown";
      pi.appendEntry("zob-project-dna-command", {
        schema: "zob.project-dna-command-plan.v1",
        manifestPathHash: sha256(parsed.manifestPath ?? ""),
        manifestPathStored: false,
        scanDirHash: sha256(parsed.scanDir ?? ""),
        scanDirStored: false,
        effectiveProfile,
        effectiveCapture,
        laneCount: lanes,
        metadataOnly: true,
        childDispatchAllowed: false,
        knowledgeBackendWriteEnabled: false,
        bodyStored: false,
        generatedAt: new Date().toISOString(),
      });
      ctx.ui.notify(`ZOB ProjectDNA plan: profile=${effectiveProfile} capture=${effectiveCapture} lanes=${lanes}`, "info");
      return;
    }
    const result = buildProjectDnaQueryResult(ctx.cwd, { scanDir: parsed.scanDir, query: parsed.query ?? "project dna", maxFiles: 8 });
    const files = Array.isArray(result.files_to_read_first) ? result.files_to_read_first.length : 0;
    const citations = Array.isArray(result.citations) ? result.citations.length : 0;
    pi.appendEntry("zob-project-dna-command", {
      schema: "zob.project-dna-command-query.v1",
      sourceId: result.source_id,
      scanDirHash: sha256(String(result.scan_dir ?? parsed.scanDir ?? "")),
      scanDirStored: false,
      queryHash: result.query_hash,
      rawQueryStored: false,
      fileCount: files,
      citationCount: citations,
      childDispatchAllowed: false,
      knowledgeBackendWriteEnabled: false,
      bodyStored: false,
      generatedAt: new Date().toISOString(),
    });
    ctx.ui.notify(`ZOB ProjectDNA query: source=${String(result.source_id)} files=${files} citations=${citations}`, "info");
  };

  pi.registerCommand("project-dna", {
    description: "Plan/query/audit repo-local ProjectDNA context. Example: /project-dna plan .pi/factories/project-dna/example-project-dna-manifest-v2.json reports/project-dna-scans/project-dna-factory-smoke",
    getArgumentCompletions: projectDnaArgumentCompletions,
    handler: handleProjectDnaCommand,
  });
}
