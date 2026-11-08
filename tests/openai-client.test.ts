// Runs the real client over real HTTP against a local server speaking the OpenAI SSE format.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { OpenAICompatibleClient, parseRetryAfter } from "../src/main/agent/openai-client";
import type { ChatMessage, CompletionHandlers } from "../src/main/agent/model";

let server: Server | null = null;

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = null;
});

interface Captured {
  body?: Record<string, unknown>;
  url?: string;
  authorization?: string;
}

async function serve(status: number, payload: string, captured: Captured = {}, thinkingToggle = true) {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      captured.body = JSON.parse(body) as Record<string, unknown>;
      captured.url = request.url;
      captured.authorization = request.headers.authorization;
      response.writeHead(status, { "content-type": "text/event-stream" });
      response.end(payload);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return new OpenAICompatibleClient({
    baseUrl: `http://127.0.0.1:${port}/`,
    model: "deepseek-flash",
    apiKey: "test-key",
    label: "DeepSeek",
    thinkingToggle,
  });
}

function sse(...chunks: unknown[]): string {
  const events = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  return `${events.join(": keep-alive\n\n")}data: [DONE]\n\n`;
}

const delta = (fields: object, finish_reason: string | null = null) => ({
  choices: [{ delta: fields, finish_reason }],
});

const SILENT: CompletionHandlers = { onText: () => {}, onThought: () => {} };
const SIGNAL = new AbortController().signal;
const REQUEST = { messages: [{ role: "user", content: "hi" } as ChatMessage], tools: [] };

describe("OpenAICompatibleClient", () => {
  it("streams thinking and text separately", async () => {
    const client = await serve(
      200,
      sse(
        delta({ reasoning_content: "想" }),
        delta({ reasoning_content: "一想" }),
        delta({ content: "你" }),
        delta({ content: "好" }, "stop"),
      ),
    );
    const text: string[] = [];
    const thoughts: string[] = [];

    const completion = await client.complete(
      REQUEST,
      { onText: (chunk) => text.push(chunk), onThought: (chunk) => thoughts.push(chunk) },
      SIGNAL,
    );

    expect(text).toEqual(["你", "好"]);
    expect(thoughts).toEqual(["想", "一想"]);
    expect(completion).toMatchObject({
      content: "你好",
      reasoningContent: "想一想",
      finishReason: "stop",
    });
  });

  it("reassembles tool calls whose arguments arrive in pieces", async () => {
    const client = await serve(
      200,
      sse(
        delta({ tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: "" } }] }),
        delta({ tool_calls: [{ index: 1, id: "b", function: { name: "list_directory", arguments: "{}" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"x.txt"}' } }] }, "tool_calls"),
      ),
    );

    const completion = await client.complete(REQUEST, SILENT, SIGNAL);

    expect(completion.finishReason).toBe("tool_calls");
    expect(completion.toolCalls).toEqual([
      { id: "a", name: "read_file", arguments: '{"path":"x.txt"}' },
      { id: "b", name: "list_directory", arguments: "{}" },
    ]);
  });

  it("handles an event split across network reads", async () => {
    const payload = Buffer.from(sse(delta({ content: "好" }, "stop")));
    // Cuts inside the three bytes of 好, so the character itself spans two reads.
    const splitAt = payload.indexOf(Buffer.from("好")) + 1;
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(payload.subarray(0, splitAt));
        setTimeout(() => response.end(payload.subarray(splitAt)), 20);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = new OpenAICompatibleClient({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "deepseek-flash",
      apiKey: "k",
    });

    await expect(client.complete(REQUEST, SILENT, SIGNAL)).resolves.toMatchObject({ content: "好" });
  });

  it("sends the key, the tools and reasoning_content from earlier turns", async () => {
    const captured: Captured = {};
    const client = await serve(200, sse(delta({ content: "好" }, "stop")), captured);

    await client.complete(
      {
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "u" },
          {
            role: "assistant",
            content: null,
            reasoningContent: "r",
            toolCalls: [{ id: "c", name: "read_file", arguments: "{}" }],
          },
          { role: "tool", toolCallId: "c", content: "结果" },
        ],
        tools: [{ name: "read_file", description: "d", parameters: { type: "object" } }],
      },
      SILENT,
      SIGNAL,
    );

    expect(captured.url).toBe("/chat/completions");
    expect(captured.authorization).toBe("Bearer test-key");
    expect(captured.body).toMatchObject({
      model: "deepseek-flash",
      stream: true,
      tools: [{ type: "function", function: { name: "read_file" } }],
      messages: [
        { role: "system" },
        { role: "user" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "r",
          tool_calls: [
            { id: "c", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c", content: "结果" },
      ],
    });
  });

  it("asks for usage and reports it from the last chunk", async () => {
    const captured: Captured = {};
    const usage = { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 };
    const client = await serve(
      200,
      sse({ ...delta({ content: "好" }), usage: null }, { ...delta({}, "stop"), usage }),
      captured,
    );

    const completion = await client.complete(REQUEST, SILENT, SIGNAL);

    expect(captured.body?.stream_options).toEqual({ include_usage: true });
    expect(completion.usage).toEqual({ promptTokens: 120, completionTokens: 8 });
  });

  it("turns thinking off only when asked", async () => {
    const captured: Captured = {};
    let client = await serve(200, sse(delta({ content: "好" }, "stop")), captured);

    await client.complete({ ...REQUEST, thinking: false }, SILENT, SIGNAL);
    expect(captured.body?.thinking).toEqual({ type: "disabled" });

    await client.complete(REQUEST, SILENT, SIGNAL);
    expect(captured.body?.thinking).toBeUndefined();
  });

  it("never sends DeepSeek's thinking switch to other providers, which reject unknown fields", async () => {
    const captured: Captured = {};
    const client = await serve(200, sse(delta({ content: "好" }, "stop")), captured, false);

    await client.complete({ ...REQUEST, thinking: false }, SILENT, SIGNAL);

    expect(captured.body).not.toHaveProperty("thinking");
  });

  it("accepts the older function_call finish reason as a tool call", async () => {
    const client = await serve(
      200,
      sse(delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "{}" } }] }, "function_call")),
    );

    await expect(client.complete(REQUEST, SILENT, SIGNAL)).resolves.toMatchObject({ finishReason: "tool_calls" });
  });

  it("names the provider in errors", async () => {
    const client = await serve(401, "{}");
    await expect(client.complete(REQUEST, SILENT, SIGNAL)).rejects.toThrow(/DeepSeek 拒绝了 API Key/);
  });

  it("explains the common HTTP errors", async () => {
    const client = await serve(402, '{"error":{"message":"Insufficient Balance"}}');

    await expect(client.complete(REQUEST, SILENT, SIGNAL)).rejects.toThrow(/余额不足/);
  });

  it("includes the response body for other HTTP errors", async () => {
    const client = await serve(400, '{"error":{"message":"bad messages"}}');

    await expect(client.complete(REQUEST, SILENT, SIGNAL)).rejects.toThrow(/400.*bad messages/);
  });

  it("fails when the server runs out of resources mid-reply", async () => {
    const client = await serve(200, sse(delta({}, "insufficient_system_resource")));

    await expect(client.complete(REQUEST, SILENT, SIGNAL)).rejects.toThrow(/资源不足/);
  });

  it("explains a connection dropped in the middle of a reply", async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(delta({ content: "半" }))}\n\n`, () => {
          setTimeout(() => response.socket?.destroy(), 20);
        });
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = new OpenAICompatibleClient({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "deepseek-flash",
      apiKey: "k",
    });

    await expect(client.complete(REQUEST, SILENT, SIGNAL)).rejects.toThrow(/连接中断/);
  });

  it("explains a server that cannot be reached, after retrying", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "http://127.0.0.1:1",
      model: "deepseek-flash",
      apiKey: "k",
      retryDelaysMs: [0, 0],
    });

    await expect(client.complete(REQUEST, SILENT, SIGNAL)).rejects.toThrow(/连接中断.*已自动重试 2 次/);
  });

  it("retries a busy server and a dropped connection before anything was shown", async () => {
    let requests = 0;
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        if (requests === 1) {
          response.writeHead(503, { "retry-after": "0" });
          response.end("busy");
        } else if (requests === 2) {
          response.socket?.destroy();
        } else {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(sse(delta({ content: "好" }, "stop")));
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = new OpenAICompatibleClient({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "deepseek-flash",
      apiKey: "k",
      retryDelaysMs: [0, 0, 0],
    });
    const text: string[] = [];

    const completion = await client.complete(REQUEST, { onText: (t) => text.push(t), onThought: () => {} }, SIGNAL);

    expect(requests).toBe(3);
    expect(completion.content).toBe("好");
    expect(text).toEqual(["好"]);
  });

  it("does not retry what asking again cannot fix", async () => {
    let requests = 0;
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.writeHead(401);
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = new OpenAICompatibleClient({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "m",
      apiKey: "k",
      retryDelaysMs: [0, 0],
    });

    await expect(client.complete(REQUEST, SILENT, SIGNAL)).rejects.toThrow(/拒绝了 API Key/);
    expect(requests).toBe(1);
  });

  it("stops waiting to retry when the turn is stopped", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "http://127.0.0.1:1",
      model: "m",
      apiKey: "k",
      retryDelaysMs: [60_000],
    });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const started = Date.now();

    await expect(client.complete(REQUEST, SILENT, abort.signal)).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reads Retry-After in seconds or as a date, within a limit", () => {
    expect(parseRetryAfter("2")).toBe(2_000);
    expect(parseRetryAfter("3600")).toBe(20_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 5_000)).toBe(5_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("reports a cancelled request as an abort, not as a network problem", async () => {
    const abort = new AbortController();
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(delta({ content: "半" }))}\n\n`);
        setTimeout(() => abort.abort(), 20);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = new OpenAICompatibleClient({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "deepseek-flash",
      apiKey: "k",
    });

    const failure = await client.complete(REQUEST, SILENT, abort.signal).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/连接中断/);
    expect(abort.signal.aborted).toBe(true);
  });

  it("fails when the stream ends without a finish reason", async () => {
    const client = await serve(200, `data: ${JSON.stringify(delta({ content: "半" }))}\n\n`);

    await expect(client.complete(REQUEST, SILENT, SIGNAL)).rejects.toThrow(/意外中断/);
  });
});
