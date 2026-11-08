import type {
  ChatMessage,
  Completion,
  CompletionHandlers,
  CompletionRequest,
  FinishReason,
  ModelClient,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "./model";

export interface OpenAIClientConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Shown in error messages, e.g. "DeepSeek" or "通义千问". */
  label?: string;
  /** Sends DeepSeek's thinking switch; other providers reject fields they do not know. */
  thinkingToggle?: boolean;
  /** Waits before each retry of a request that failed for a passing reason; one retry per entry. */
  retryDelaysMs?: readonly number[];
}

/** A dropped connection or a busy server usually passes within seconds; a turn should not end on it. */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];
/** Busy, overloaded or briefly broken: worth asking again. 529 is "overloaded" at some providers. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
/** A server may ask for a longer wait than ours, but not for one that stalls the turn. */
const MAX_RETRY_AFTER_MS = 20_000;

/** An HTTP failure, with what is needed to decide whether to ask again. */
class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Retry-After in seconds or as a date; anything else is ignored. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

/** fetch reports every network failure as a TypeError: "fetch failed", or "terminated" mid-reply. */
function isNetworkError(error: unknown): error is TypeError {
  return error instanceof TypeError;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface ChunkToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface Chunk {
  error?: { message?: string };
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ChunkToolCall[];
    };
  }>;
}

function friendlyHttpError(status: number, label: string): string | undefined {
  return {
    401: `${label} 拒绝了 API Key：请在「模型设置」里检查 Key 和接口地址`,
    402: `${label} 账户余额不足，请到平台充值`,
    404: `${label} 找不到这个接口或模型：请在「模型设置」里检查接口地址和模型名`,
    429: `${label} 请求过于频繁或额度用完，请稍后再试`,
    500: `${label} 服务器错误，请稍后再试`,
    503: `${label} 服务器繁忙，请稍后再试`,
  }[status];
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        // With tools present, DeepSeek returns 400 unless every earlier thinking turn
        // sends its reasoning_content back.
        ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
  }
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    // stream: true keeps a multi-byte character intact when a read splits it.
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      // Everything else on the stream is a blank separator or a keep-alive comment.
      if (line.startsWith("data:")) yield line.slice("data:".length).trim();
    }
  }
}

function normalizeFinishReason(reason: string | null | undefined, label: string): FinishReason {
  switch (reason) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return reason;
    // Some providers end a tool call with "function_call", the field's older name.
    case "function_call":
      return "tool_calls";
    case "insufficient_system_resource":
      throw new Error(`${label} 推理资源不足，回复被中断，请重试`);
    case "aborted":
      throw new Error(`${label} 中断了这次生成，请重试`);
    default:
      throw new Error(`${label} 的回复意外中断，请重试`);
  }
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Any OpenAI-compatible Chat Completions API: DeepSeek, Qwen, Kimi, GLM, OpenAI, local servers. */
export class OpenAICompatibleClient implements ModelClient {
  constructor(private readonly config: OpenAIClientConfig) {}

  private get label(): string {
    return this.config.label ?? "模型服务";
  }

  /** The models the key can use, from GET /models, which most providers offer. */
  async listModels(signal: AbortSignal): Promise<string[]> {
    let response: Response;
    try {
      response = await fetch(`${trimBase(this.config.baseUrl)}/models`, {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        signal,
      });
    } catch (error) {
      if (error instanceof TypeError && !signal.aborted) {
        throw new Error(`连不上 ${this.label}：请检查接口地址、网络或代理（${error.message}）`);
      }
      throw error;
    }
    if (!response.ok) throw await this.describeFailure(response);
    const body = (await response.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    if (!Array.isArray(body?.data)) throw new Error(`${this.label} 没有返回模型列表，请手动填写模型名`);
    const ids = body.data.map((entry) => entry.id).filter((id): id is string => typeof id === "string");
    return [...new Set(ids)].sort();
  }

  /**
   * Streams one reply. A dropped connection, a rate limit or a server error is retried a few
   * times, but only before anything was shown: text already on screen cannot be taken back.
   */
  async complete(
    request: CompletionRequest,
    handlers: CompletionHandlers,
    signal: AbortSignal,
  ): Promise<Completion> {
    const delays = this.config.retryDelaysMs ?? RETRY_DELAYS_MS;
    let shown = false;
    const watched: CompletionHandlers = {
      onText: (text) => {
        shown = true;
        handlers.onText(text);
      },
      onThought: (text) => {
        shown = true;
        handlers.onThought(text);
      },
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.stream(request, watched, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const passing = isNetworkError(error) || (error instanceof HttpError && RETRYABLE_STATUS.has(error.status));
        if (!passing || shown || attempt >= delays.length) throw this.explain(error, attempt);
        const asked = error instanceof HttpError ? error.retryAfterMs : undefined;
        await sleep(Math.max(delays[attempt] ?? 0, asked ?? 0), signal);
      }
    }
  }

  /** The error the user sees, saying when it was already retried so they need not retry at once. */
  private explain(error: unknown, retries: number): unknown {
    const note = retries ? `（已自动重试 ${retries} 次）` : "";
    if (isNetworkError(error)) {
      return new Error(`与 ${this.label} 的连接中断，请检查网络或代理后重发这条消息${note}（${error.message}）`);
    }
    if (error instanceof HttpError && note) return new Error(`${error.message}${note}`);
    return error;
  }

  private async stream(
    { messages, tools, thinking }: CompletionRequest,
    handlers: CompletionHandlers,
    signal: AbortSignal,
  ): Promise<Completion> {
    const response = await fetch(`${trimBase(this.config.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: messages.map(toWireMessage),
        ...(tools.length ? { tools: tools.map(toWireTool) } : {}),
        ...(thinking === false && this.config.thinkingToggle ? { thinking: { type: "disabled" } } : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });

    if (!response.ok || !response.body) throw await this.describeFailure(response);

    let content = "";
    let reasoningContent = "";
    let finishReason: string | null | undefined;
    let usage: TokenUsage | undefined;
    const toolCalls = new Map<number, ToolCall>();

    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") break;

      const chunk = JSON.parse(data) as Chunk;
      if (chunk.error) throw new Error(`${this.label} 返回错误：${chunk.error.message ?? data}`);
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      finishReason = choice.finish_reason ?? finishReason;

      const delta = choice.delta;
      if (delta?.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        handlers.onThought(delta.reasoning_content);
      }
      if (delta?.content) {
        content += delta.content;
        handlers.onText(delta.content);
      }
      for (const part of delta?.tool_calls ?? []) {
        const call = toolCalls.get(part.index) ?? { id: "", name: "", arguments: "" };
        call.id = part.id ?? call.id;
        call.name = part.function?.name ?? call.name;
        call.arguments += part.function?.arguments ?? "";
        toolCalls.set(part.index, call);
      }
    }

    return {
      content,
      reasoningContent,
      toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
      finishReason: normalizeFinishReason(finishReason, this.label),
      usage,
    };
  }

  private async describeFailure(response: Response): Promise<Error> {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const friendly = friendlyHttpError(response.status, this.label);
    if (friendly) return new HttpError(friendly, response.status, retryAfterMs);
    const body = await response.text().catch(() => "");
    return new HttpError(`${this.label} 请求失败（${response.status}）：${body.slice(0, 500)}`, response.status, retryAfterMs);
  }
}
