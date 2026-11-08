import type { ToolServerStatus } from "../../shared/types";
import type { Tool } from "../agent/tools";
import { McpClient, type McpServerInfo, type McpServerSpec, type McpToolInfo, type SpawnFn } from "./client";

const MAX_RESULT_CHARS = 30_000;
const MAX_SUMMARY_CHARS = 300;
/** OpenAI-compatible APIs accept tool names of letters, digits, _ and -, up to 64 characters. */
const MAX_TOOL_NAME = 64;

export interface McpServerConfig extends McpServerSpec {
  /** Shown in the top bar and the system prompt, e.g. "HFSS". */
  label: string;
  /** Tools that only read, so they run without asking. Others ask unless a rule allows them. */
  readOnlyTools?: readonly string[];
  /** Added after the server's own instructions: what the app knows about using it well. Read at each use. */
  extraInstructions?: string | (() => string);
  /**
   * Why the server cannot start at all, e.g. its Python environment is not installed. A function
   * is asked again at every start, so installing it and restarting the server works without a relaunch.
   */
  unavailable?: string | (() => string | undefined);
  /** Tools the app calls itself (data for its panels) and the model never sees. */
  appOnlyTools?: readonly string[];
}

interface Entry {
  config: McpServerConfig;
  client: McpClient;
  info: McpServerInfo | null;
  status: ToolServerStatus;
  /** One automatic restart after a crash; more would hide a server that keeps dying. */
  restarted: boolean;
}

/**
 * Arguments as people read them: `name: value`, with text as it is (a Windows path keeps single
 * backslashes) and anything else as compact JSON, so a number and the text "1" still differ.
 */
export function describeArgs(args: Record<string, unknown>, separator: string): string {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(separator);
}

/** The agent-facing name of a server's tool: hfss__run_project. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${clean(server)}__${clean(tool)}`.slice(0, MAX_TOOL_NAME);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（结果过长，已截断，共 ${text.length} 字符）`;
}

function parameters(tool: McpToolInfo): Record<string, unknown> {
  const schema = tool.inputSchema;
  return schema && schema.type === "object" ? schema : { type: "object", properties: {} };
}

/** Starts the configured MCP servers and offers their tools to the agent. */
export class McpHub {
  private readonly entries: Entry[];

  constructor(
    configs: McpServerConfig[],
    private readonly onStatus: (servers: ToolServerStatus[]) => void,
    private readonly spawnFn?: SpawnFn,
  ) {
    this.entries = configs.map((config) => ({
      config,
      client: new McpClient(config, spawnFn),
      info: null,
      restarted: false,
      status: { name: config.name, label: config.label, state: "stopped", toolCount: 0 },
    }));
  }

  get statuses(): ToolServerStatus[] {
    return this.entries.map((entry) => entry.status);
  }

  /** Starts every server at once. Resolves when all have started or failed; never rejects. */
  async start(): Promise<void> {
    await Promise.all(this.entries.map((entry) => this.startOne(entry)));
  }

  /** Tools of the servers that started, as the agent sees them. */
  tools(): Tool[] {
    return this.entries.flatMap((entry) =>
      (entry.info?.tools ?? [])
        .filter((tool) => !(entry.config.appOnlyTools ?? []).includes(tool.name))
        .map((tool) => this.adapt(entry, tool)),
    );
  }

  /** For the system prompt: how each connected server wants its tools used. */
  instructions(): Array<{ label: string; text: string }> {
    return this.entries.flatMap((entry) => {
      if (!entry.info) return [];
      const extra = entry.config.extraInstructions;
      const text = [entry.info.instructions, typeof extra === "function" ? extra() : extra].filter(Boolean).join("\n\n");
      return text ? [{ label: entry.config.label, text }] : [];
    });
  }

  /** Whether a server is up and answering. */
  isReady(server: string): boolean {
    return this.find(server)?.status.state === "ready";
  }

  /** The app's own call of a server's tool, e.g. to fill the task panel. Same restart rules as the agent's. */
  callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const entry = this.find(server);
    if (!entry) return Promise.reject(new Error(`没有工具服务 ${server}`));
    return this.call(entry, tool, args, signal ?? new AbortController().signal);
  }

  /** Stops and starts one server, e.g. after its environment was installed. Its tools may change. */
  async restart(server: string): Promise<void> {
    const entry = this.find(server);
    if (!entry) return;
    await entry.client.stop();
    entry.restarted = false;
    await this.startOne(entry);
  }

  private find(server: string): Entry | undefined {
    return this.entries.find((entry) => entry.config.name === server);
  }

  async stop(): Promise<void> {
    await Promise.all(this.entries.map((entry) => entry.client.stop()));
    for (const entry of this.entries) this.setStatus(entry, { state: "stopped", message: undefined });
  }

  private async startOne(entry: Entry): Promise<void> {
    const { unavailable } = entry.config;
    const why = typeof unavailable === "function" ? unavailable() : unavailable;
    if (why) {
      entry.info = null;
      this.setStatus(entry, { state: "failed", message: why, toolCount: 0 });
      return;
    }
    this.setStatus(entry, { state: "starting", message: undefined });
    try {
      entry.info = await entry.client.start();
      this.setStatus(entry, { state: "ready", toolCount: entry.info.tools.length, message: undefined });
    } catch (error) {
      entry.info = null;
      this.setStatus(entry, { state: "failed", message: (error as Error).message });
    }
  }

  private adapt(entry: Entry, tool: McpToolInfo): Tool {
    const { config } = entry;
    const readOnly = tool.annotations?.readOnlyHint === true || (config.readOnlyTools ?? []).includes(tool.name);
    return {
      definition: {
        name: mcpToolName(config.name, tool.name),
        description: `[${config.label}] ${tool.description ?? tool.name}`.trim(),
        parameters: parameters(tool),
      },
      describePermission: (args) =>
        readOnly
          ? null
          : {
              title: `${config.label}：${tool.annotations?.title ?? tool.name}`,
              detail: truncate(describeArgs(args, "\n") || "（没有参数）", 4_000),
            },
      summarize: (args) => {
        const text = describeArgs(args, " · ");
        if (!text) return undefined;
        return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text;
      },
      run: async (args, signal) => truncate(await this.call(entry, tool.name, args, signal), MAX_RESULT_CHARS),
    };
  }

  private async call(entry: Entry, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    if (!entry.client.alive) {
      if (entry.restarted) {
        throw new Error(`${entry.config.label} 工具服务已退出，重启过一次仍不可用：${entry.status.message ?? ""}`);
      }
      entry.restarted = true;
      await entry.client.stop();
      await this.startOne(entry);
      if (!entry.client.alive) throw new Error(`${entry.config.label} 工具服务无法重启：${entry.status.message ?? ""}`);
    }
    try {
      return await entry.client.callTool(tool, args, signal);
    } catch (error) {
      if (!entry.client.alive) {
        this.setStatus(entry, { state: "failed", message: (error as Error).message });
      }
      throw error;
    }
  }

  private setStatus(entry: Entry, change: Partial<ToolServerStatus>): void {
    entry.status = { ...entry.status, ...change };
    if (entry.status.message === undefined) delete entry.status.message;
    this.onStatus(this.statuses);
  }
}
