import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";

export type ServerState = "starting" | "running" | "failed" | "stopped";

/** The parts of a child process the server needs, so tests can stand one in. */
export interface ServerProcess {
  readonly pid?: number;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  once(event: "exit", listener: (code: number | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface HindsightServerOptions {
  launch: () => ServerProcess;
  /** True once the service answers. */
  probe: () => Promise<boolean>;
  killTree: (pid: number) => void;
  onState: (state: ServerState, message?: string) => void;
  logFile: string;
  pollIntervalMs?: number;
  stopTimeoutMs?: number;
  restartDelayMs?: number;
}

/** Only a crash after a good start is retried: a failed start would just fail again. */
const MAX_RESTARTS = 3;
const LOG_TAIL_LINES = 20;
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs Hindsight as a child of the app, for as long as the app runs. */
export class HindsightServer {
  private child: ServerProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  private stopping = false;
  private restarts = 0;
  private tail: string[] = [];
  private log: Writable | null = null;

  constructor(private readonly options: HindsightServerOptions) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    await this.openLog();
    this.launch();
  }

  /** Asks the service to shut down cleanly, and kills it if it does not. */
  async stop(): Promise<void> {
    const child = this.child;
    this.stopping = true;
    if (!child) return;

    // Closing stdin is the shutdown request: see scripts/hindsight-launcher.py.
    child.stdin?.end();
    const timeout = sleep(this.options.stopTimeoutMs ?? 10_000).then(() => "timeout" as const);
    if ((await Promise.race([this.exited, timeout])) === "timeout" && child.pid) {
      this.options.killTree(child.pid);
    }
  }

  private launch(message?: string): void {
    this.options.onState("starting", message);
    let child: ServerProcess;
    try {
      child = this.options.launch();
    } catch (error) {
      this.options.onState("failed", `Hindsight 无法启动：${(error as Error).message}`);
      return;
    }
    this.child = child;

    let running = false;
    let settled = false;
    this.exited = new Promise<void>((resolve) => {
      const finish = (reason: string) => {
        if (settled) return;
        settled = true;
        if (this.child === child) this.child = null;
        resolve();
        this.handleExit(reason, running);
      };
      child.once("exit", (code) => finish(`退出码 ${code ?? "未知"}`));
      child.once("error", (error) => finish(error.message));
    });

    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => this.record(chunk));
    }

    void (async () => {
      const interval = this.options.pollIntervalMs ?? 1_000;
      while (!settled && !this.stopping) {
        if (await this.options.probe()) {
          if (settled || this.stopping) return;
          running = true;
          this.options.onState("running");
          return;
        }
        await sleep(interval);
      }
    })();
  }

  private handleExit(reason: string, wasRunning: boolean): void {
    if (this.stopping) {
      this.log?.end();
      this.options.onState("stopped");
      return;
    }
    if (wasRunning && this.restarts < MAX_RESTARTS) {
      this.restarts += 1;
      void sleep(this.options.restartDelayMs ?? 2_000).then(() => {
        if (!this.stopping) this.launch(`Hindsight 意外退出（${reason}），正在重启`);
      });
      return;
    }
    const lastLine = this.tail.at(-1);
    const detail = lastLine ? `：${lastLine}` : "";
    this.options.onState(
      "failed",
      `Hindsight 已退出（${reason}）${detail}。日志：${this.options.logFile}`,
    );
  }

  private record(chunk: Buffer): void {
    this.log?.write(chunk);
    const lines = chunk
      .toString("utf8")
      .replace(ANSI_ESCAPE, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    this.tail = [...this.tail, ...lines].slice(-LOG_TAIL_LINES);
  }

  /** One log per run, and the one before it. */
  private async openLog(): Promise<void> {
    const { logFile } = this.options;
    await mkdir(dirname(logFile), { recursive: true });
    if (existsSync(logFile)) await rename(logFile, logFile.replace(/\.log$/, ".previous.log"));
    this.log = createWriteStream(logFile);
    // A log that cannot be written must not take the app down with it.
    this.log.on("error", () => (this.log = null));
  }
}

export interface InstalledHindsight {
  python: string;
  launcher: string;
}

/** Where install-hindsight.ps1 puts it, or null if it has not been run. */
/** runtimeDir: where install-hindsight.ps1 put it; resourcesDir: where the app's scripts are. */
export function findHindsight(runtimeDir: string, resourcesDir: string = runtimeDir): InstalledHindsight | null {
  const python = join(runtimeDir, ".hindsight", "env", "Scripts", "python.exe");
  const launcher = join(resourcesDir, "scripts", "hindsight-launcher.py");
  return existsSync(python) && existsSync(launcher) ? { python, launcher } : null;
}

/** The model Hindsight extracts facts with: the one the user chose for the agent. */
export interface HindsightLlm {
  /** Hindsight's own name for DeepSeek, or "openai" for any OpenAI-compatible API. */
  provider: "deepseek" | "openai";
  model: string;
  apiKey: string;
  /** Only for "openai": where the API is. */
  baseUrl?: string;
}

export function launchHindsight(
  { python, launcher }: InstalledHindsight,
  { llm, port, env }: { llm: HindsightLlm; port: string; env: NodeJS.ProcessEnv },
): ServerProcess {
  return spawn(python, [launcher, "--exit-on-stdin-close"], {
    env: {
      ...env,
      HINDSIGHT_API_LLM_PROVIDER: llm.provider,
      HINDSIGHT_API_LLM_MODEL: llm.model,
      HINDSIGHT_API_LLM_API_KEY: llm.apiKey,
      ...(llm.baseUrl ? { HINDSIGHT_API_LLM_BASE_URL: llm.baseUrl } : {}),
      HINDSIGHT_API_PORT: port,
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    // Node kills its children when the app dies, which would leave PostgreSQL running.
    // Detached, Hindsight outlives a crash just long enough to see stdin close and stop it.
    detached: true,
    windowsHide: true,
  });
}

export function killProcessTree(pid: number): void {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
}
