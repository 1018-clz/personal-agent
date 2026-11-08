import type { ToolStatus } from "../../shared/types";
import {
  compactionPolicy,
  DEFAULT_TRIGGER_TOKENS,
  estimateTokens,
  splitForCompaction,
  summarize,
  withContextSummary,
  type CompactionPolicy,
} from "./compaction";
import type { ChatMessage, FinishReason, HistoryUpdate, ModelClient, ToolCall } from "./model";
import type { PermissionNeed, Tool } from "./tools";

const MAX_MODEL_CALLS_PER_TURN = 25;
/** A turn that keeps refilling the context would otherwise pay for a summary on every call. */
const MAX_COMPACTIONS_PER_TURN = 2;

export type AgentUpdate =
  | { kind: "message"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool-call"; toolCallId: string; title: string; status: ToolStatus; detail?: string }
  | { kind: "tool-update"; toolCallId: string; status: ToolStatus; autoApproved?: string; error?: string }
  /** What a call returned, as the model sees it: for the app's own bookkeeping, not the transcript. */
  | {
      kind: "tool-result";
      toolCallId: string;
      name: string;
      args: Record<string, unknown> | null;
      ok: boolean;
      content: string;
    }
  | { kind: "compaction"; status: "running" | "failed" }
  | { kind: "compaction"; status: "done"; beforeTokens: number; afterTokens: number };

export interface PermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
  /** Null for a tool that only reads, which still goes through deny rules. */
  need: PermissionNeed | null;
}

/** Allowed without asking the user, which needs approval, and why: shown next to the call. */
export interface AutoApproved {
  autoApproved: string;
}

export interface AgentCallbacks {
  onUpdate(update: AgentUpdate): void;
  /**
   * Called for every tool call. True runs it, AutoApproved runs it and says why nobody was asked,
   * false means the user refused, and a string refuses it with that message for the model.
   */
  requestPermission(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<boolean | string | AutoApproved>;
}

export type StopReason = "end_turn" | "max_tokens" | "max_turns" | "refusal" | "cancelled";

const STOP_REASONS: Record<Exclude<FinishReason, "tool_calls">, StopReason> = {
  stop: "end_turn",
  length: "max_tokens",
  content_filter: "refusal",
};

const MAX_FAILURE_TEXT = 600;

/** A failure as the transcript shows it: without the "错误：" the model needs, and not a page long. */
export function failureText(content: string): string {
  const text = content.replace(/^错误：/, "").trim();
  return text.length > MAX_FAILURE_TEXT ? `${text.slice(0, MAX_FAILURE_TEXT)}…` : text;
}

function parseArguments(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text || "{}");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("工具参数必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/** The agent itself: calls the model, runs the tools it asks for, and repeats. */
export class Agent {
  private systemPrompt = "";
  private contextSummary: string | null = null;
  private messages: ChatMessage[] = [];
  private savedLength = 0;
  private compactedSinceSave = false;
  /** The real size of the context, as of the last reply, and how much of it that covered. */
  private measured: { tokens: number; length: number } | null = null;
  private turnStart = 0;
  private compactionFailed = false;
  private compactionsThisTurn = 0;

  constructor(
    private readonly model: ModelClient,
    private readonly tools: Tool[],
    private readonly callbacks: AgentCallbacks,
    private policy: CompactionPolicy = compactionPolicy(DEFAULT_TRIGGER_TOKENS),
  ) {}

  /** A model with a different context window needs different limits; applies from the next call. */
  setCompactionPolicy(policy: CompactionPolicy): void {
    this.policy = policy;
  }

  newSession(systemPrompt: string): void {
    this.resumeSession(systemPrompt, [], null);
  }

  resumeSession(systemPrompt: string, history: ChatMessage[], contextSummary: string | null): void {
    this.systemPrompt = systemPrompt;
    this.contextSummary = contextSummary;
    this.messages = [{ role: "system", content: withContextSummary(systemPrompt, contextSummary) }, ...history];
    this.savedLength = this.messages.length;
    this.compactedSinceSave = false;
    this.measured = null;
  }

  /** Swaps the instructions and keeps the conversation, e.g. once memory comes online. */
  setSystemPrompt(systemPrompt: string): void {
    this.systemPrompt = systemPrompt;
    this.messages[0] = { role: "system", content: withContextSummary(systemPrompt, this.contextSummary) };
  }

  /** What changed since the last call. A dropped turn has already been taken back out. */
  takeUnsavedHistory(): HistoryUpdate {
    const unsaved = this.messages.slice(this.savedLength);
    this.savedLength = this.messages.length;
    if (!this.compactedSinceSave) return { kind: "messages", messages: unsaved };

    this.compactedSinceSave = false;
    return { kind: "compaction", summary: this.contextSummary ?? "", tail: this.messages.slice(1) };
  }

  async runTurn(userText: string, signal: AbortSignal): Promise<StopReason> {
    const checkpoint = {
      contextSummary: this.contextSummary,
      messages: [...this.messages],
      compactedSinceSave: this.compactedSinceSave,
      measured: this.measured,
    };
    const restore = () => Object.assign(this, checkpoint);

    this.compactionFailed = false;
    this.compactionsThisTurn = 0;
    try {
      const stopReason = await this.loop(userText, signal);
      if (stopReason === "max_turns") restore();
      return stopReason;
    } catch (error) {
      // A half-finished turn can leave tool calls unanswered, and DeepSeek rejects any
      // later request carrying them, so the whole turn is dropped from the history.
      restore();
      if (signal.aborted) return "cancelled";
      throw error;
    }
  }

  private async loop(userText: string, signal: AbortSignal): Promise<StopReason> {
    this.messages.push({ role: "user", content: userText });
    this.turnStart = this.messages.length - 1;

    for (let call = 0; call < MAX_MODEL_CALLS_PER_TURN; call++) {
      // Checked before every call, not every turn: one turn of file reads can fill the window.
      await this.compactIfNeeded(call === 0 ? this.policy.triggerTokens : this.policy.midTurnTokens, signal);

      const completion = await this.model.complete(
        { messages: this.messages, tools: this.tools.map((tool) => tool.definition) },
        {
          onText: (text) => this.callbacks.onUpdate({ kind: "message", text }),
          onThought: (text) => this.callbacks.onUpdate({ kind: "thought", text }),
        },
        signal,
      );

      this.messages.push({
        role: "assistant",
        content: completion.content || null,
        reasoningContent: completion.reasoningContent || undefined,
        toolCalls: completion.toolCalls,
      });
      this.measured = completion.usage
        ? {
            tokens: completion.usage.promptTokens + completion.usage.completionTokens,
            length: this.messages.length,
          }
        : null;

      if (completion.finishReason !== "tool_calls") return STOP_REASONS[completion.finishReason];

      for (const toolCall of completion.toolCalls) {
        const content = await this.runTool(toolCall, signal);
        this.messages.push({ role: "tool", toolCallId: toolCall.id, content });
      }
    }
    return "max_turns";
  }

  private contextTokens(): number {
    if (!this.measured) return estimateTokens(this.messages);
    return this.measured.tokens + estimateTokens(this.messages.slice(this.measured.length));
  }

  private async compactIfNeeded(limit: number, signal: AbortSignal): Promise<void> {
    const beforeTokens = this.contextTokens();
    if (beforeTokens < limit || this.compactionFailed) return;
    if (this.compactionsThisTurn >= MAX_COMPACTIONS_PER_TURN) return;

    // The system prompt is not part of the split, hence the offsets by one.
    const split = splitForCompaction(this.messages.slice(1), this.policy.tailTokens, this.turnStart - 1);
    if (!split) return;

    const { onUpdate } = this.callbacks;
    onUpdate({ kind: "compaction", status: "running" });
    let summary: string;
    try {
      summary = await summarize(this.model, this.contextSummary, split.old, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // The context is still valid, only large, so the turn goes on and the next one retries.
      this.compactionFailed = true;
      onUpdate({ kind: "compaction", status: "failed" });
      return;
    }

    this.contextSummary = summary;
    const system: ChatMessage = { role: "system", content: withContextSummary(this.systemPrompt, summary) };
    this.messages = [system, ...split.tail];
    this.turnStart = split.turnStart + 1;
    this.measured = null;
    this.compactedSinceSave = true;
    this.compactionsThisTurn++;
    onUpdate({ kind: "compaction", status: "done", beforeTokens, afterTokens: this.contextTokens() });
  }

  /** Tool failures go back to the model as text, so it can correct itself and carry on. */
  private async runTool(toolCall: ToolCall, signal: AbortSignal): Promise<string> {
    const { onUpdate, requestPermission } = this.callbacks;
    const toolCallId = toolCall.id;
    const tool = this.tools.find((candidate) => candidate.definition.name === toolCall.name);

    // Parsed before the call is shown, so the transcript can say what it works on.
    let args: Record<string, unknown> | null = null;
    let argsError: Error | null = null;
    try {
      args = parseArguments(toolCall.arguments);
    } catch (error) {
      argsError = error as Error;
    }
    let detail: string | undefined;
    try {
      detail = args ? tool?.summarize?.(args) : undefined;
    } catch {
      // A summary is only for display and must never stop the call.
    }
    onUpdate({
      kind: "tool-call",
      toolCallId,
      title: toolCall.name,
      status: "pending",
      ...(detail ? { detail } : {}),
    });

    const finish = (status: ToolStatus, content: string) => {
      // A failure shows the user what the model is told, so neither has to guess what went wrong.
      const error = status === "failed" ? failureText(content) : undefined;
      onUpdate({ kind: "tool-update", toolCallId, status, ...(error ? { error } : {}) });
      onUpdate({ kind: "tool-result", toolCallId, name: toolCall.name, args, ok: status === "completed", content });
      return content;
    };

    if (!tool) return finish("failed", `错误：没有名为 ${toolCall.name} 的工具`);
    if (!args) return finish("failed", `错误：工具参数无效：${argsError?.message}`);

    // A call that cannot succeed (an edit whose text is not in the file) fails without asking.
    let need: PermissionNeed | null;
    try {
      need = await tool.describePermission(args);
    } catch (error) {
      return finish("failed", `错误：${(error as Error).message}`);
    }
    const verdict = await requestPermission({ toolName: toolCall.name, args, need }, signal);
    if (verdict !== true && typeof verdict !== "object") {
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      return finish("failed", typeof verdict === "string" ? verdict : "用户拒绝了这次工具调用。");
    }

    const autoApproved = typeof verdict === "object" ? verdict.autoApproved : undefined;
    onUpdate({
      kind: "tool-update",
      toolCallId,
      status: "in_progress",
      ...(autoApproved ? { autoApproved } : {}),
    });
    try {
      return finish("completed", await tool.run(args, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      return finish("failed", `错误：${(error as Error).message}`);
    }
  }
}
