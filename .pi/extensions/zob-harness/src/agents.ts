import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentScope, HarnessAgent } from "./types.js";
import { readableZobResourcePaths } from "./utils/resources.js";

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: {}, body: raw };
  const yaml = raw.slice(4, end);
  const body = raw.slice(end + 5).trim();
  const frontmatter: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    frontmatter[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['\"]|['\"]$/g, "");
  }
  return { frontmatter, body };
}

function loadAgentsFromDir(dir: string, source: "project" | "user"): HarnessAgent[] {
  if (!existsSync(dir)) return [];
  const agents: HarnessAgent[] = [];
  const entries = readDirSafe(dir);
  for (const fileName of entries) {
    if (!fileName.endsWith(".md")) continue;
    const filePath = join(dir, fileName);
    let raw = "";
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const name = frontmatter.name ?? basename(fileName, ".md");
    if (!name) continue;
    const tools = frontmatter.tools
      ?.split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
    agents.push({
      name,
      description: frontmatter.description ?? "",
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      prompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function loadProjectAgents(cwd: string): HarnessAgent[] {
  return readableZobResourcePaths(cwd, "agents").flatMap((dir) => loadAgentsFromDir(dir, "project"));
}

function discoverAgents(cwd: string, scope: AgentScope): HarnessAgent[] {
  const projectAgents = scope === "user" ? [] : loadProjectAgents(cwd);
  const userAgents = scope === "project" ? [] : loadAgentsFromDir(join(getAgentDir(), "agents"), "user");
  const ordered = scope === "both" ? [...userAgents, ...projectAgents] : scope === "user" ? userAgents : projectAgents;
  const byName = new Map<string, HarnessAgent>();
  for (const agent of ordered) byName.set(agent.name.toLowerCase(), agent);
  return [...byName.values()];
}

function formatAgentList(agents: HarnessAgent[]): string {
  if (agents.length === 0) return "No agents found.";
  return agents.map((agent) => `- ${agent.name} [${agent.source}] tools=${agent.tools?.join(",") ?? "default"}: ${agent.description}`).join("\n");
}

export { discoverAgents, formatAgentList, loadAgentsFromDir, loadProjectAgents };
