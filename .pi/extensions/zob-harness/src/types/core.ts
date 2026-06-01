export type ModeName = "explore" | "plan" | "implement" | "oracle" | "factory" | "orchestrator";
export type AgentScope = "project" | "user" | "both";
export type ChildThinkingLevel = "low" | "medium" | "high" | "xhigh";

export interface ChildChangedPathRef {
  path: string;
  pathHash: string;
  status: string;
  contentHash?: string;
}

export type TextBlock = { type: "text"; text: string };
export type AssistantLikeMessage = {
  role?: string;
  content?: Array<TextBlock | { type: string; [key: string]: unknown }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
};

export type JsonEvent = {
  type?: string;
  message?: AssistantLikeMessage;
  messages?: AssistantLikeMessage[];
  assistantMessageEvent?: { type?: string; delta?: string };
  toolName?: string;
};

export interface HarnessAgent {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: ChildThinkingLevel | string;
  prompt: string;
  source: "project" | "user";
  filePath: string;
}
