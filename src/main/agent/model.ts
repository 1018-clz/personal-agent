// The model-facing contract of the agent loop. Mirrors DeepSeek's Chat Completions shape.

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the model produced it. It is not guaranteed to parse. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; reasoningContent?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** False turns thinking mode off, for internal calls that do not need it. */
  thinking?: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CompletionHandlers {
  onText(text: string): void;
  onThought(text: string): void;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface Completion {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: TokenUsage;
}

/** What changed in a session's model history since it was last saved. */
export type HistoryUpdate =
  | { kind: "messages"; messages: ChatMessage[] }
  | { kind: "compaction"; summary: string; tail: ChatMessage[] };

export interface ModelClient {
  complete(
    request: CompletionRequest,
    handlers: CompletionHandlers,
    signal: AbortSignal,
  ): Promise<Completion>;
}
