import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { formatGoalTodoSummary, summarizeGoalTodos, type GoalTodoNode } from "../goal-todos.js";
import type { HarnessRuntimeState } from "./state.js";

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function statusIcon(status: GoalTodoNode["status"]): string {
  if (status === "done") return "✓";
  if (status === "skipped") return "↷";
  if (status === "blocked") return "▲";
  if (status === "delegated") return "⇄";
  if (status === "claim_returned") return "◇";
  if (status === "needs_oracle") return "◆";
  if (status === "needs_user") return "?";
  if (status === "in_progress") return "●";
  return "○";
}

function statusColor(status: GoalTodoNode["status"]): "success" | "warning" | "error" | "muted" {
  if (status === "done" || status === "skipped") return "success";
  if (status === "blocked" || status === "needs_user") return "error";
  if (status === "delegated" || status === "claim_returned" || status === "needs_oracle" || status === "in_progress") return "warning";
  return "muted";
}

function goalNodes(state: HarnessRuntimeState): GoalTodoNode[] {
  const goalId = state.runtimeGoal?.goalId;
  if (!goalId) return [];
  return state.goalTodos.nodes
    .filter((node) => node.goalId === goalId)
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }) || left.createdAt - right.createdAt);
}

export class GoalTodoOverlayComponent implements Component {
  private selectedTodoId?: string;
  private listScroll = 0;
  private detailScroll = 0;
  private filter = "";
  private filterEditing = false;
  private readonly height = 22;

  constructor(
    private readonly runtimeState: HarnessRuntimeState,
    private readonly theme: Theme,
    private readonly done: () => void,
    initialTodoId?: string,
  ) {
    this.selectedTodoId = initialTodoId;
    this.ensureSelection();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      if (this.filterEditing || this.filter) {
        this.filterEditing = false;
        this.filter = "";
        this.listScroll = 0;
        this.ensureSelection();
        return;
      }
      this.done();
      return;
    }
    if (this.filterEditing) {
      if (matchesKey(data, "enter")) {
        this.filterEditing = false;
        return;
      }
      if (matchesKey(data, "backspace") || data === "\x7f") {
        this.filter = this.filter.slice(0, -1);
        this.listScroll = 0;
        this.ensureSelection();
        return;
      }
      if (data.length === 1 && data >= " " && data !== "\x7f") {
        this.filter += data;
        this.listScroll = 0;
        this.ensureSelection();
      }
      return;
    }
    if (data === "/") {
      this.filterEditing = true;
      return;
    }
    if (matchesKey(data, "up")) this.moveSelection(-1);
    else if (matchesKey(data, "down")) this.moveSelection(1);
    else if (data === "\x1b[5~") this.detailScroll = Math.max(0, this.detailScroll - 8);
    else if (data === "\x1b[6~") this.detailScroll += 8;
    else if (data === "r") this.ensureSelection();
  }

  invalidate(): void {
    this.ensureSelection();
  }

  render(width: number): string[] {
    const th = this.theme;
    const w = Math.max(60, width);
    const inner = Math.max(1, w - 2);
    const leftWidth = Math.min(48, Math.max(28, Math.floor(inner * 0.46)));
    const rightWidth = Math.max(20, inner - leftWidth - 1);
    const rows = this.filteredRows();
    this.ensureSelection();
    this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, rows.length - this.height)));
    const selected = rows.find((node) => node.id === this.selectedTodoId) ?? rows[0];
    const detail = this.detailLines(selected, rightWidth);
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, detail.length - this.height)));

    const title = ` ZOB Goal TODOs · ${this.runtimeState.runtimeGoal?.goalId ?? "no-goal"} `;
    const leftRule = "─".repeat(Math.max(0, Math.floor((inner - visibleWidth(title)) / 2)));
    const rightRule = "─".repeat(Math.max(0, inner - visibleWidth(title) - leftRule.length));
    const lines: string[] = [th.fg("border", `╭${leftRule}`) + th.fg("accent", title) + th.fg("border", `${rightRule}╮`)];
    const summary = this.runtimeState.runtimeGoal ? formatGoalTodoSummary(summarizeGoalTodos(this.runtimeState.goalTodos, this.runtimeState.runtimeGoal.goalId)) : "no active goal";
    lines.push(this.row(th.fg("accent", padToWidth(summary, leftWidth)) + th.fg("dim", "│") + padToWidth(selected ? `${selected.path} ${selected.title}` : "No TODO selected", rightWidth), inner));
    lines.push(th.fg("border", `├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`));

    const visibleRows = rows.slice(this.listScroll, this.listScroll + this.height);
    const visibleDetail = detail.slice(this.detailScroll, this.detailScroll + this.height);
    for (let index = 0; index < this.height; index++) {
      const node = visibleRows[index];
      const left = node ? this.renderNode(node, leftWidth) : index === 0 && rows.length === 0 ? th.fg("warning", "No TODOs match") : "";
      const right = visibleDetail[index] ?? "";
      lines.push(this.row(`${padToWidth(left, leftWidth)}${th.fg("dim", "│")}${padToWidth(right, rightWidth)}`, inner));
    }

    const filterInfo = this.filter || this.filterEditing ? ` · filter=${this.filterEditing ? ">" : ""}${this.filter || "<type>"}` : "";
    const footer = `${rows.length} TODO rows${filterInfo} · / filter · ↑↓ select · PgUp/PgDn detail · Esc close`;
    lines.push(th.fg("border", `├${"─".repeat(inner)}┤`));
    lines.push(this.row(th.fg("dim", truncateToWidth(footer, inner, "…")), inner));
    lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));
    return lines.map((line) => truncateToWidth(line, w, ""));
  }

  private row(content: string, width: number): string {
    return this.theme.fg("border", "│") + padToWidth(content, width) + this.theme.fg("border", "│");
  }

  private renderNode(node: GoalTodoNode, width: number): string {
    const prefix = "  ".repeat(Math.max(0, node.depth - 1));
    const selected = node.id === this.selectedTodoId ? "›" : " ";
    const required = node.required ? "req" : "opt";
    const text = `${selected}${prefix}${statusIcon(node.status)} ${node.path} ${node.title} [${required}]`;
    return this.theme.fg(statusColor(node.status), truncateToWidth(text, width, "…"));
  }

  private detailLines(node: GoalTodoNode | undefined, width: number): string[] {
    if (!node) return ["No TODO selected."];
    return [
      `${node.path} ${node.title}`,
      `id: ${node.id}`,
      `status: ${node.status}`,
      `owner: ${node.owner}`,
      `required: ${node.required}`,
      `priority: ${node.priority}`,
      `depth: ${node.depth}`,
      node.parentId ? `parent: ${node.parentId}` : "parent: root",
      node.delegation ? `delegation: ${node.delegation.status} run=${node.delegation.runId ?? "n/a"} agent=${node.delegation.agent ?? "n/a"} depth=${node.delegation.delegationDepth}` : "delegation: none",
      node.blocker ? `blocker: ${node.blocker}` : "blocker: none",
      node.skipReason ? `skip: ${node.skipReason}` : undefined,
      "acceptance:",
      ...(node.acceptanceCriteria.length ? node.acceptanceCriteria.map((item) => `- ${item}`) : ["- none"]),
      "evidence_refs:",
      ...(node.evidenceRefs.length ? node.evidenceRefs.map((item) => `- ${item}`) : ["- none"]),
      "validation_commands:",
      ...(node.validationCommands.length ? node.validationCommands.map((item) => `- ${item}`) : ["- none"]),
    ].filter((line): line is string => typeof line === "string").map((line) => truncateToWidth(line, width, "…"));
  }

  private filteredRows(): GoalTodoNode[] {
    const filter = this.filter.toLowerCase().trim();
    const rows = goalNodes(this.runtimeState);
    if (!filter) return rows;
    return rows.filter((node) => `${node.id} ${node.path} ${node.title} ${node.status} ${node.owner}`.toLowerCase().includes(filter));
  }

  private ensureSelection(): void {
    const rows = this.filteredRows();
    if (rows.length === 0) {
      this.selectedTodoId = undefined;
      return;
    }
    if (!this.selectedTodoId || !rows.some((node) => node.id === this.selectedTodoId)) this.selectedTodoId = rows[0].id;
    const selectedIndex = rows.findIndex((node) => node.id === this.selectedTodoId);
    if (selectedIndex < this.listScroll) this.listScroll = selectedIndex;
    if (selectedIndex >= this.listScroll + this.height) this.listScroll = selectedIndex - this.height + 1;
  }

  private moveSelection(delta: number): void {
    const rows = this.filteredRows();
    if (rows.length === 0) return;
    const current = Math.max(0, rows.findIndex((node) => node.id === this.selectedTodoId));
    const next = Math.max(0, Math.min(rows.length - 1, current + delta));
    this.selectedTodoId = rows[next].id;
    this.detailScroll = 0;
    this.ensureSelection();
  }
}

export async function showGoalTodoOverlay(ctx: ExtensionContext, state: HarnessRuntimeState, initialTodoId?: string): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Goal TODO overlay requires an interactive UI; use /goal todo tree instead.", "warning");
    return;
  }
  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => new GoalTodoOverlayComponent(state, theme, done, initialTodoId), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 2 },
  });
}
