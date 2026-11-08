// A Model Context Protocol client over stdio: one JSON-RPC 2.0 message per line.
// Written by hand rather than pulling in the SDK: the transport is small, and owning it means
// owning the failure modes below, which are where MCP integrations quietly go wrong.
//
// Lessons taken from rongke's mcp_client.py (design only, no code):
// - A tool that reports failure must become a failed call. isError is the protocol's way, and a
//   result whose JSON says "ok": false is treated the same, or a failure reads as evidence.
// - When the server dies, every waiting call fails at once with the server's last stderr lines,
//   instead of hanging until a timeout with nothing to go on.
// - Stray non-JSON lines on stdout (a print in the server) are kept for diagnosis, not parsed.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const PROTOCOL_VERSION = "2025-06-18";
const STARTUP_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 120_000;
const TAIL_LINES = 20;

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpServerInfo {
  /** What the server tells the model about using its tools. */
  instructions?: string;
  tools: McpToolInfo[];
}

/** The part of a child process the client needs, so tests can stand in a fake. */
export type SpawnFn = (spec: McpServerSpec) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFn = (spec) =>
  spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: string;
}

/** The text a tool call returns. Non-text content is named, so the model knows something was there. */
export function contentText(result: { content?: ContentBlock[]; structuredContent?: unknown }): string {
  const parts = (result.content ?? []).map((block) =>
    block.type === "text" && typeof block.text === "string" ? block.text : `[非文本内容：${block.type ?? "未知"}]`,
  );
  if (parts.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join("\n");
}

/** A result that says it failed, even though the call itself succeeded. */
/** What the Python MCP SDK says for an exception it did not expect: the cause is only in its log. */
const BARE_FAILURE = /^Error executing tool \S+$/;
/** How long to wait for the server's log of a failure to arrive after the answer. */
const STDERR_SETTLE_MS = 150;

/**
 * The cause of a failure the server only logged: the last exception line of a Python traceback
 * (not the SDK's own wrapper), or else the last lines it printed.
 */
export function causeFromLog(lines: string[]): string {
  const exceptions = lines.filter(
    (line) => /^[\w.]*(Error|Exception)\b[^:]*:/.test(line) && !/(UnexpectedToolError|ToolError):/.test(line),
  );
  if (exceptions.length) return exceptions.at(-1)!;
  return lines.slice(-3).join("\n");
}

export function reportsFailure(text: string): boolean {
  if (!text.trimStart().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
}

export class McpError extends Error {}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private readonly stderrTail: string[] = [];
  /** Every stderr line so far, to tell which ones a call produced. */
  private stderrCount = 0;
  private readonly junkTail: string[] = [];
  private exitReason: string | null = null;

  constructor(
    readonly spec: McpServerSpec,
    private readonly spawnFn: SpawnFn = defaultSpawn,
  ) {}

  get alive(): boolean {
    return this.child !== null && this.exitReason === null;
  }

  /** Starts the server, shakes hands and lists its tools. */
  async start(): Promise<McpServerInfo> {
    if (this.child) throw new McpError(`${this.spec.name} 已经启动`);
    this.exitReason = null;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(this.spec);
    } catch (error) {
      throw new McpError(`无法启动 ${this.spec.name}：${(error as Error).message}`);
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrCount += this.remember(this.stderrTail, chunk);
    });
    child.once("error", (error) => this.onExit(`启动失败：${error.message}`));
    child.once("exit", (code, signal) => this.onExit(`进程退出（${signal ?? `退出码 ${code ?? "未知"}`}）`));
    // A closed stdin or stdout after exit must not crash the app.
    child.stdin.on("error", () => {});

    const timeout = this.spec.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    try {
      const init = (await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "personal-agent", version: "0.1.0" },
        },
        timeout,
      )) as { instructions?: unknown };
      this.notify("notifications/initialized");
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = (await this.request("tools/list", cursor ? { cursor } : {}, timeout)) as {
          tools?: McpToolInfo[];
          nextCursor?: string;
        };
        tools.push(...(page.tools ?? []));
        cursor = page.nextCursor;
      } while (cursor);
      return {
        ...(typeof init.instructions === "string" && init.instructions.trim() ? { instructions: init.instructions } : {}),
        tools,
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** Calls a tool and returns its text. A failure the tool reports is thrown, with its message. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const stderrBefore = this.stderrCount;
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      this.spec.callTimeoutMs ?? CALL_TIMEOUT_MS,
      signal,
    )) as { content?: ContentBlock[]; structuredContent?: unknown; isError?: boolean };
    const text = contentText(result);
    if (result.isError || reportsFailure(text)) {
      let message = text || `${name} 失败，但没有说明原因`;
      // Without the cause the model guesses, and guesses wrong: add what the server logged.
      if (!text.trim() || BARE_FAILURE.test(text.trim())) {
        await new Promise((resolve) => setTimeout(resolve, STDERR_SETTLE_MS));
        const fresh = Math.min(this.stderrCount - stderrBefore, this.stderrTail.length);
        const cause = fresh > 0 ? causeFromLog(this.stderrTail.slice(-fresh)) : "";
        if (cause) message += `\n服务端日志：${cause}`;
      }
      throw new McpError(message);
    }
    return text;
  }

  /** Closes stdin, which stdio servers treat as the request to exit, then kills it if it lingers. */
  async stop(graceMs = 3_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.exitReason === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.stdin.end();
      const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), graceMs));
      if ((await Promise.race([exited, timer])) === "timeout") child.kill();
    }
    this.onExit("已停止");
    this.child = null;
  }

  /** What went wrong lately, for error messages and the status tooltip. */
  diagnosis(): string {
    const lines = [...this.stderrTail.slice(-8), ...this.junkTail.slice(-4).map((line) => `stdout: ${line}`)];
    return lines.length ? lines.join("\n") : "";
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.child || this.exitReason !== null) {
      return Promise.reject(new McpError(this.describeExit(method)));
    }
    if (signal?.aborted) return Promise.reject(new DOMException("已取消", "AbortError"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.settle(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "用户取消" });
        reject(new DOMException("已取消", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        this.settle(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "超时" });
        reject(new McpError(`${this.spec.name} 的 ${method} 超过 ${Math.round(timeoutMs / 1000)} 秒没有回应`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        timer,
        resolve: (result) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: RpcMessage): void {
    if (!this.child || this.exitReason !== null) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        this.remember(this.junkTail, line);
        continue;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: RpcMessage): void {
    // A response to one of ours.
    if (message.method === undefined && typeof message.id === "number") {
      const entry = this.settle(message.id);
      if (!entry) return;
      if (message.error) {
        entry.reject(new McpError(`${this.spec.name} 拒绝了 ${entry.method}：${message.error.message ?? "未知错误"}`));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    // A request from the server. Only ping is part of what this client offers.
    if (message.method !== undefined && message.id !== undefined && message.id !== null) {
      if (message.method === "ping") {
        this.write({ jsonrpc: "2.0", id: message.id, result: {} });
      } else {
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `不支持 ${message.method}` } });
      }
    }
    // Notifications (logging, progress, list changes) need no answer.
  }

  private onExit(reason: string): void {
    if (this.exitReason !== null) return;
    this.exitReason = reason;
    for (const id of [...this.pending.keys()]) {
      const entry = this.settle(id);
      entry?.reject(new McpError(this.describeExit(entry.method)));
    }
  }

  private describeExit(method: string): string {
    const why = this.diagnosis();
    return `${this.spec.name} 不可用（${this.exitReason ?? "未启动"}），${method} 没有完成${why ? `：\n${why}` : ""}`;
  }

  /** Keeps the last lines of a stream; returns how many it added. */
  private remember(tail: string[], chunk: string): number {
    let added = 0;
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) {
        tail.push(line.trimEnd());
        added += 1;
      }
    }
    tail.splice(0, Math.max(0, tail.length - TAIL_LINES));
    return added;
  }
}
