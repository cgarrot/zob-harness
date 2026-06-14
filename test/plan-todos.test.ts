import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  PLAN_TODOS_BLOCK_END,
  PLAN_TODOS_BLOCK_START,
  capturePlanArtifact,
  createHarnessRuntimeState,
  extractAndNormalizePlanTodoManifest,
  extractPlanTodosJson,
  launchCapturedPlan,
  listCapturedPlanEntries,
  previewCapturedPlanLaunch,
  readPlanTodoSidecar,
  redactPlanTodosBlockForDisplay,
} from "../.pi/extensions/zob-harness/index.ts";

const pi = { appendEntry: () => undefined } as any;

function repo(): string {
  return mkdtempSync(join(tmpdir(), "zob-plan-todos-"));
}

function planText(): string {
  return [
    "# Plan d’implémentation",
    "",
    "## Scope",
    "Créer un mécanisme robuste où le mode plan sauvegarde les TODO machine et où une commande les lance sans les recréer depuis la prose.",
    "",
    "## Étapes",
    "1. Ajouter le schéma.",
    "2. Écrire le sidecar.",
    "3. Lancer le plan.",
    "",
    "## Validation",
    "Tests unitaires et npm run check.",
    "",
    PLAN_TODOS_BLOCK_START,
    "```json",
    JSON.stringify({
      schema: "zob.plan-todos.v1",
      objective: "Implémenter le lancement de plans sauvegardés",
      todos: [
        {
          key: "schema",
          title: "Définir le schéma TODO de plan",
          done_when: ["Le schéma accepte des enfants"],
          children: [
            { key: "schema_child", title: "Normaliser les enfants", checks: ["node --test"] },
          ],
        },
        { key: "launch", title: "Ajouter le tool de lancement", checks: ["npm run check -- --pretty false"] },
      ],
    }, null, 2),
    "```",
    PLAN_TODOS_BLOCK_END,
  ].join("\n");
}

function planTextWithFenceInfoString(): string {
  return planText().replace("```json", "```json zob.plan-todos.v1");
}

function planTextVariant(label: string): string {
  return planText()
    .replace("# Plan d’implémentation", `# Plan d’implémentation ${label}`)
    .replace("Implémenter le lancement de plans sauvegardés", `Implémenter le lancement de plans sauvegardés ${label}`);
}

function realMarkdownOnlyCapturedPlan(): string {
  return [
    "# Ajouter cwd optionnel au lancement des sub-agents",
    "",
    "1. API",
    "   - Ajouter cwd à delegate_agent.",
    "   - Valider les chemins relatifs.",
    "   - Documenter le contrat.",
    "2. Validation",
    "   - Couvrir les entrées invalides.",
    "   - Tester le cwd absent.",
    "   - Tester le cwd relatif.",
    "3. Spawn",
    "   - Transmettre cwd au processus enfant.",
    "   - Préserver l'environnement existant.",
    "   - Gérer les erreurs de spawn.",
    "4. Affichage",
    "   - Montrer cwd dans l'overlay.",
    "   - Résumer le dossier cible.",
    "   - Masquer les chemins sensibles.",
    "5. Docs / prompts",
    "   - Mettre à jour l'aide.",
    "   - Ajuster les prompts.",
    "   - Ajouter un exemple.",
    "6. Tests",
    "   - Ajouter un smoke ciblé.",
    "   - Vérifier la régression.",
    "   - `npm run check -- --pretty false`",
    "   - `npm run smoke:harness`",
    "   - `npm run pi:check`",
  ].join("\n");
}

function seedLegacyNeedsManifestPlan(root: string): { planId: string; relativePath: string; sidecarPath: string } {
  const planId = "plan-20260612092042-e423f33d";
  const relativePath = "plans/2026-06-12/plan-20260612092042-e423f33d-plan-d-impl-mentation.md";
  const sidecarPath = relativePath.replace(/\.md$/, ".todos.json");
  mkdirSync(join(root, "plans/2026-06-12"), { recursive: true });
  writeFileSync(join(root, relativePath), realMarkdownOnlyCapturedPlan(), "utf8");
  writeFileSync(join(root, "plans/index.json"), `${JSON.stringify({
    schema: "zob.plan-index.v1",
    updated_at: "2026-06-12T09:20:42.396Z",
    entries: [{
      plan_id: planId,
      title: "Plan d’implémentation",
      created_at: "2026-06-12T09:20:42.396Z",
      mode: "plan",
      status: "draft",
      relative_path: relativePath,
      body_hash: "e423f33d671b6cb47e34ff6dcf1f8645a6352edd28f2f9b3be5d3bb438ff13ee",
      user_request_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      assistant_output_hash: "02debdf6d59fb2f06fb3ef5fbdc368f524e1404458c6a7db10401b4796e76602",
      launch_status: "needs_manifest",
    }],
  }, null, 2)}\n`, "utf8");
  return { planId, relativePath, sidecarPath };
}

test("extractAndNormalizePlanTodoManifest: converts simple LLM tree to canonical TODO refs", () => {
  const result = extractAndNormalizePlanTodoManifest(planText(), { defaultObjective: "fallback" });
  assert.equal(result.found, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.manifest);
  assert.equal(result.manifest.objective, "Implémenter le lancement de plans sauvegardés");
  assert.equal(result.manifest.todo_count, 3);
  assert.equal(result.manifest.max_depth, 2);
  assert.equal(result.manifest.todos.find((todo) => todo.ref === "schema_child")?.parent_ref, "schema");
  assert.equal(result.source, "explicit_block");
  assert.equal(result.quality, "explicit");
});

test("extractPlanTodosJson: accepts fenced manifests with an info string", () => {
  const block = extractPlanTodosJson(planTextWithFenceInfoString());
  assert.equal(block.found, true);
  assert.deepEqual(block.errors, []);
  assert.ok(block.jsonText?.startsWith("{"));
  const result = extractAndNormalizePlanTodoManifest(planTextWithFenceInfoString(), { defaultObjective: "fallback" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.manifest?.todo_count, 3);
});

test("redactPlanTodosBlockForDisplay: replaces raw manifest JSON with compact launchable card", () => {
  const redacted = redactPlanTodosBlockForDisplay(planTextWithFenceInfoString(), {
    planPath: ".pi/plans/2026-06-12/example.md",
    sidecarPath: ".pi/plans/2026-06-12/example.todos.json",
  });
  assert.equal(redacted.changed, true);
  assert.ok(redacted.text.includes("ZOB plan launchable"));
  assert.ok(redacted.text.includes("TODO sidecar"));
  assert.ok(redacted.text.includes("Définir le schéma TODO de plan"));
  assert.doesNotMatch(redacted.text, /"todos"\s*:/);
  assert.doesNotMatch(redacted.text, /ZOB_PLAN_TODOS_START/);
});

test("extractAndNormalizePlanTodoManifest: deterministic Markdown fallback handles real captured needs_manifest plan", () => {
  const result = extractAndNormalizePlanTodoManifest(realMarkdownOnlyCapturedPlan(), { defaultObjective: "Ajouter cwd optionnel au lancement des sub-agents" });
  assert.equal(result.found, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.manifest);
  assert.equal(result.source, "markdown_fallback");
  assert.equal(result.quality, "fallback_structured");
  assert.equal(result.manifest.todo_count, 23);
  assert.equal(result.manifest.max_depth, 2);
  assert.deepEqual(result.manifest.todos.filter((todo) => !todo.parent_ref).map((todo) => todo.title), ["API", "Validation", "Spawn", "Affichage", "Docs / prompts", "Tests"]);
  assert.ok(result.manifest.todos.some((todo) => todo.parent_ref === "t1" && /delegate_agent/.test(todo.title)));
  assert.ok(result.manifest.todos.some((todo) => todo.parent_ref === "t4" && /overlay/.test(todo.title)));
  assert.deepEqual(result.manifest.todos.find((todo) => todo.title === "Tests")?.validation_commands, ["npm run check -- --pretty false", "npm run smoke:harness", "npm run pi:check"]);
});

test("capturePlanArtifact: writes launchable fallback sidecar for real markdown-only plan shape", () => {
  const root = repo();
  const capture = capturePlanArtifact(root, { assistantText: realMarkdownOnlyCapturedPlan(), userText: "fais le plan cwd subagents", mode: "plan", now: new Date("2026-06-12T11:00:00.000Z") });
  assert.equal(capture.captured, true);
  const entry = listCapturedPlanEntries(root)[0]!;
  assert.equal(entry.launch_status, "launchable");
  assert.equal(entry.todo_manifest_source, "markdown_fallback");
  assert.equal(entry.todo_manifest_quality, "fallback_structured");
  assert.ok(entry.relative_path.startsWith(".pi/plans/"));
  assert.ok(entry.todo_manifest_path?.startsWith(".pi/plans/"));
  assert.ok(entry.todo_manifest_path?.endsWith(".todos.json"));
  assert.equal(entry.todo_count, 23);
  const loaded = readPlanTodoSidecar(root, entry.todo_manifest_path!);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.sidecar?.manifest_source, "markdown_fallback");
  assert.equal(loaded.sidecar?.todo_count, 23);
});

test("launchCapturedPlan: materializes fallback-generated sidecar from real markdown-only plan", () => {
  const root = repo();
  const capture = capturePlanArtifact(root, { assistantText: realMarkdownOnlyCapturedPlan(), userText: "fais le plan cwd subagents", mode: "plan", now: new Date("2026-06-12T11:05:00.000Z") });
  assert.equal(capture.captured, true);
  const state = createHarnessRuntimeState();
  const ctx = { cwd: root, ui: { notify: () => undefined } } as any;
  const dryRun = previewCapturedPlanLaunch(root, { selector: "latest_launchable", dry_run: true });
  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.todoCount, 23);
  const result = launchCapturedPlan(pi, state, ctx, { selector: "latest_launchable", queue_continuation: false });
  assert.equal(result.status, "launched");
  assert.equal(state.goalTodos.nodes.length, 23);
  const api = state.goalTodos.nodes.find((node) => node.title === "API");
  const apiChild = state.goalTodos.nodes.find((node) => /delegate_agent/.test(node.title));
  assert.ok(api);
  assert.ok(apiChild);
  assert.equal(apiChild.parentId, api.id);
});

test("zob_plan_launch preview/launch lazily repairs legacy needs_manifest plans with Markdown fallback", () => {
  const root = repo();
  const legacy = seedLegacyNeedsManifestPlan(root);
  const dryRun = previewCapturedPlanLaunch(root, { selector: "latest_launchable", dry_run: true });
  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.todoCount, 23);
  assert.equal(existsSync(join(root, legacy.sidecarPath)), false);

  const state = createHarnessRuntimeState();
  const ctx = { cwd: root, ui: { notify: () => undefined } } as any;
  const result = launchCapturedPlan(pi, state, ctx, { selector: "latest_launchable", queue_continuation: false });
  assert.equal(result.status, "launched");
  assert.equal(result.planId, legacy.planId);
  assert.equal(state.goalTodos.nodes.length, 23);
  assert.equal(existsSync(join(root, legacy.sidecarPath)), true);
  const loaded = readPlanTodoSidecar(root, legacy.sidecarPath);
  assert.equal(loaded.sidecar?.manifest_source, "markdown_fallback");
});

test("capturePlanArtifact: writes launchable .todos.json sidecar and index metadata", () => {
  const root = repo();
  const capture = capturePlanArtifact(root, { assistantText: planText(), userText: "fais un plan", mode: "plan", now: new Date("2026-06-12T10:00:00.000Z") });
  assert.equal(capture.captured, true);
  const entries = listCapturedPlanEntries(root);
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.launch_status, "launchable");
  assert.equal(entry.todo_count, 3);
  assert.ok(entry.relative_path.startsWith(".pi/plans/"));
  assert.ok(entry.todo_manifest_path?.startsWith(".pi/plans/"));
  assert.ok(entry.todo_manifest_path?.endsWith(".todos.json"));
  const sidecarText = readFileSync(join(root, entry.todo_manifest_path!), "utf8");
  assert.match(sidecarText, /zob\.plan-todos\.sidecar\.v1/);
  const capturedMarkdown = readFileSync(join(root, entry.relative_path), "utf8");
  assert.match(capturedMarkdown, /ZOB plan launchable/);
  assert.doesNotMatch(capturedMarkdown, /ZOB_PLAN_TODOS_START/);
  assert.doesNotMatch(capturedMarkdown, /"todos"\s*:/);
  const loaded = readPlanTodoSidecar(root, entry.todo_manifest_path!);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.sidecar?.todo_count, 3);
});

test("launchCapturedPlan: materializes saved TODO/sub-TODO sidecar without re-planning", () => {
  const root = repo();
  const capture = capturePlanArtifact(root, { assistantText: planText(), userText: "fais un plan", mode: "plan", now: new Date("2026-06-12T10:00:00.000Z") });
  assert.equal(capture.captured, true);
  const state = createHarnessRuntimeState();
  const ctx = { cwd: root, ui: { notify: () => undefined } } as any;
  const dryRun = previewCapturedPlanLaunch(root, { selector: "latest_launchable", dry_run: true });
  assert.equal(dryRun.status, "dry_run");
  assert.equal(state.goalTodos.nodes.length, 0);
  const result = launchCapturedPlan(pi, state, ctx, { selector: "latest_launchable", queue_continuation: false });
  assert.equal(result.status, "launched");
  assert.ok(result.goalId);
  assert.equal(state.goalTodos.nodes.length, 3);
  const parent = state.goalTodos.nodes.find((node) => node.title === "Définir le schéma TODO de plan");
  const child = state.goalTodos.nodes.find((node) => node.title === "Normaliser les enfants");
  assert.ok(parent);
  assert.ok(child);
  assert.equal(child.parentId, parent.id);
  const entry = listCapturedPlanEntries(root)[0]!;
  assert.equal(entry.launch_status, "launched");
  assert.equal(entry.launched_goal_id, result.goalId);
});

test("launchCapturedPlan: auto-attaches latest launchable plan to an active goal by default", () => {
  const root = repo();
  capturePlanArtifact(root, { assistantText: planTextVariant("initial"), userText: "premier plan", mode: "plan", now: new Date("2026-06-12T10:10:00.000Z") });
  const firstEntry = listCapturedPlanEntries(root)[0]!;
  const state = createHarnessRuntimeState();
  const ctx = { cwd: root, ui: { notify: () => undefined } } as any;
  const first = launchCapturedPlan(pi, state, ctx, { plan_id: firstEntry.plan_id, queue_continuation: false });
  assert.equal(first.status, "launched");
  assert.ok(first.goalId);
  assert.equal(state.goalTodos.nodes.length, 3);

  capturePlanArtifact(root, { assistantText: planTextVariant("followup"), userText: "plan suivant", mode: "plan", now: new Date("2026-06-12T10:11:00.000Z") });
  const secondEntry = listCapturedPlanEntries(root)[0]!;
  const second = launchCapturedPlan(pi, state, ctx, { selector: "latest_launchable", queue_continuation: false });
  assert.equal(second.status, "launched");
  assert.equal(second.goalId, first.goalId);
  assert.match(second.summary, /plan attached to active goal/);
  assert.equal(state.goalTodos.nodes.length, 6);
  const loaded = readPlanTodoSidecar(root, secondEntry.todo_manifest_path!);
  assert.equal(loaded.sidecar?.launched_goal_id, first.goalId);
});

test("launchCapturedPlan: active_goal_strategy=block preserves strict active-goal blocking", () => {
  const root = repo();
  capturePlanArtifact(root, { assistantText: planTextVariant("initial"), userText: "premier plan", mode: "plan", now: new Date("2026-06-12T10:20:00.000Z") });
  const firstEntry = listCapturedPlanEntries(root)[0]!;
  const state = createHarnessRuntimeState();
  const ctx = { cwd: root, ui: { notify: () => undefined } } as any;
  const first = launchCapturedPlan(pi, state, ctx, { plan_id: firstEntry.plan_id, queue_continuation: false });
  assert.equal(first.status, "launched");

  capturePlanArtifact(root, { assistantText: planTextVariant("blocked"), userText: "plan suivant", mode: "plan", now: new Date("2026-06-12T10:21:00.000Z") });
  const secondEntry = listCapturedPlanEntries(root)[0]!;
  const blocked = launchCapturedPlan(pi, state, ctx, { selector: "latest_launchable", active_goal_strategy: "block", queue_continuation: false });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.summary, /active_goal_strategy=block/);
  assert.equal(state.goalTodos.nodes.length, 3);
  const loaded = readPlanTodoSidecar(root, secondEntry.todo_manifest_path!);
  assert.equal(loaded.sidecar?.launch_status, "launchable");
  assert.equal(loaded.sidecar?.launched_goal_id, undefined);
});

test("launchCapturedPlan: relaunching a plan already launched in the active goal is idempotent", () => {
  const root = repo();
  capturePlanArtifact(root, { assistantText: planTextVariant("idempotent"), userText: "fais un plan", mode: "plan", now: new Date("2026-06-12T10:30:00.000Z") });
  const entry = listCapturedPlanEntries(root)[0]!;
  const state = createHarnessRuntimeState();
  const ctx = { cwd: root, ui: { notify: () => undefined } } as any;
  const first = launchCapturedPlan(pi, state, ctx, { plan_id: entry.plan_id, queue_continuation: false });
  assert.equal(first.status, "launched");
  assert.equal(state.goalTodos.nodes.length, 3);

  const second = launchCapturedPlan(pi, state, ctx, { plan_id: entry.plan_id, queue_continuation: false });
  assert.equal(second.status, "already_launched");
  assert.equal(second.goalId, first.goalId);
  assert.deepEqual(second.createdTodos, []);
  assert.match(second.summary, /no TODOs duplicated/);
  assert.equal(state.goalTodos.nodes.length, 3);
});

test("launchCapturedPlan: blocks a launched plan when the active goal is different", () => {
  const root = repo();
  capturePlanArtifact(root, { assistantText: planTextVariant("first"), userText: "premier plan", mode: "plan", now: new Date("2026-06-12T10:40:00.000Z") });
  const firstEntry = listCapturedPlanEntries(root)[0]!;
  const stateA = createHarnessRuntimeState();
  const ctx = { cwd: root, ui: { notify: () => undefined } } as any;
  const first = launchCapturedPlan(pi, stateA, ctx, { plan_id: firstEntry.plan_id, queue_continuation: false });
  assert.equal(first.status, "launched");

  capturePlanArtifact(root, { assistantText: planTextVariant("second"), userText: "second plan", mode: "plan", now: new Date("2026-06-12T10:41:00.000Z") });
  const secondEntry = listCapturedPlanEntries(root)[0]!;
  const stateB = createHarnessRuntimeState();
  const second = launchCapturedPlan(pi, stateB, ctx, { plan_id: secondEntry.plan_id, queue_continuation: false });
  assert.equal(second.status, "launched");
  assert.notEqual(second.goalId, first.goalId);

  const blocked = launchCapturedPlan(pi, stateB, ctx, { plan_id: firstEntry.plan_id, queue_continuation: false });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.goalId, first.goalId);
  assert.match(blocked.summary, /already launched/);
  assert.equal(stateB.goalTodos.nodes.length, 3);
});
