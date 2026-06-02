import type { FactoryDefinition, FactoryInputManifest, FactoryManifestItem } from "../../types.js";

function detectCanonicalPatterns(text: string): string[] {
  const patterns = new Set<string>();
  if (/TASK\s*:|EXPECTED\s+OUTCOME\s*:|MUST\s+NOT/i.test(text)) patterns.add("delegation.contract.structured");
  if (/delegate_(agent|task)|sub-?agent|oracle|explore/i.test(text)) patterns.add("routing.subagent.specialized");
  if (/PASS|FAIL|WARN|verdict/i.test(text)) patterns.add("verification.verdict_first");
  if (/evidence|preuve|preuves|sentinel|DONE/i.test(text)) patterns.add("verification.evidence_required");
  if (/factory_run|software factory|factory|manifest|checkpoint/i.test(text)) patterns.add("factory.workflow.manifest_checkpoint");
  if (/damage-control|destructive|secret|zero-access|sandbox/i.test(text)) patterns.add("safety.damage_control");
  if (/truncat|output cut|silent response/i.test(text)) patterns.add("failure.output.truncation");
  if (/scope drift|multi-task|too broad/i.test(text)) patterns.add("failure.scope.drift");
  return [...patterns].sort();
}

function renderFactoryTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, key: string) => values[key] ?? match);
}

export function buildFactoryAgenticPlan(
  repoRoot: string,
  definition: FactoryDefinition,
  manifest: FactoryInputManifest,
  selectedItems: FactoryManifestItem[],
  run: { runId: string; runDir: string; mode: string; checkpointsDir: string; outputsDir: string },
): { factory: string; runId: string; mode: string; tasks: Array<Record<string, unknown>>; stageCount: number; itemCount: number } {
  const tasks: Array<Record<string, unknown>> = [];
  for (const stage of definition.stages ?? []) {
    const stageItems = stage.type === "map" ? selectedItems : [undefined];
    for (const item of stageItems) {
      const values: Record<string, string> = {
        "factory.name": definition.name,
        "factory.version": definition.version,
        "manifest.factory": manifest.factory,
        "run.id": run.runId,
        "run.dir": run.runDir,
        "run.mode": run.mode,
        "checkpoints.dir": run.checkpointsDir,
        "outputs.dir": run.outputsDir,
        "stage.name": stage.name,
        "stage.type": stage.type,
        "item.id": item?.id ?? "all-items",
        "item.path": item?.path ?? "outputs/",
      };
      tasks.push({
        stage: stage.name,
        stageType: stage.type,
        itemId: item?.id,
        agent: stage.agent,
        task: renderFactoryTemplate(stage.promptTemplate, values),
        expected_outcome: stage.expectedOutcome ?? `Complete factory stage ${stage.name}`,
        required_tools: stage.requiredTools,
        must_do: stage.mustDo ?? ["Follow the factory output contract", "Cite evidence", "Respect sentinels and validation gates"],
        must_not_do: stage.mustNotDo ?? ["No secrets", "No destructive commands", "No commits"],
        context: renderFactoryTemplate(stage.context ?? `Factory {factory.name}, run {run.id}, stage {stage.name}, item {item.id}: {item.path}`, values),
        output_contract: stage.outputContract,
        run_in_background: false,
        load_skills: [],
      });
    }
  }
  return { factory: definition.name, runId: run.runId, mode: run.mode, tasks, stageCount: definition.stages?.length ?? 0, itemCount: selectedItems.length };
}

export { detectCanonicalPatterns };
