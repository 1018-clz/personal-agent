import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HindsightServer, type ServerProcess, type ServerState } from "../src/main/hindsight-server";

class FakeProcess extends EventEmitter {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  stdinClosed = false;

  constructor() {
    super();
    this.stdin.on("finish", () => (this.stdinClosed = true));
  }

  exit(code: number | null): void {
    this.emit("exit", code);
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { ready?: () => boolean; stopTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hindsight-server-"));
  dirs.push(dir);
  const logFile = join(dir, "logs", "hindsight.log");
  const processes: FakeProcess[] = [];
  const states: Array<[ServerState, string | undefined]> = [];
  const killTree = vi.fn<(pid: number) => void>();
  const server = new HindsightServer({
    launch: () => {
      const child = new FakeProcess();
      processes.push(child);
      return child as unknown as ServerProcess;
    },
    probe: async () => options.ready?.() ?? true,
    killTree,
    onState: (state, message) => states.push([state, message]),
    logFile,
    pollIntervalMs: 5,
    restartDelayMs: 5,
    stopTimeoutMs: options.stopTimeoutMs ?? 1_000,
  });
  const lastState = () => states.at(-1)?.[0];
  return { server, processes, states, lastState, killTree, logFile };
}

describe("HindsightServer", () => {
  it("is running once the service answers", async () => {
    let ready = false;
    const { server, lastState } = setup({ ready: () => ready });

    await server.start();
    expect(lastState()).toBe("starting");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lastState()).toBe("starting");

    ready = true;
    await vi.waitFor(() => expect(lastState()).toBe("running"));
  });

  it("stops by closing stdin, and only kills what does not stop", async () => {
    const { server, processes, lastState, killTree } = setup();
    await server.start();
    await vi.waitFor(() => expect(lastState()).toBe("running"));

    const stopped = server.stop();
    await vi.waitFor(() => expect(processes[0]?.stdinClosed).toBe(true));
    processes[0]?.exit(0);
    await stopped;

    expect(killTree).not.toHaveBeenCalled();
    expect(lastState()).toBe("stopped");
  });

  it("kills the process tree when a clean stop takes too long", async () => {
    const { server, killTree } = setup({ stopTimeoutMs: 20 });
    await server.start();

    await server.stop();

    expect(killTree).toHaveBeenCalledWith(4242);
  });

  it("restarts after a crash, but not forever", async () => {
    const { server, processes, states, lastState } = setup();
    await server.start();

    for (let crash = 1; crash <= 4; crash++) {
      await vi.waitFor(() => expect(lastState()).toBe("running"));
      processes.at(-1)?.exit(1);
      if (crash <= 3) await vi.waitFor(() => expect(processes).toHaveLength(crash + 1));
    }

    await vi.waitFor(() => expect(lastState()).toBe("failed"));
    expect(processes).toHaveLength(4);
    expect(states.some(([, message]) => message?.includes("正在重启"))).toBe(true);
  });

  it("gives up on a failed start and says why", async () => {
    const { server, processes, states, logFile } = setup({ ready: () => false });
    await server.start();

    processes[0]?.stderr.write("\x1b[31mERROR: [Errno 10048] address already in use\x1b[0m\r\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    processes[0]?.exit(1);

    await vi.waitFor(() => expect(states.at(-1)?.[0]).toBe("failed"));
    expect(processes).toHaveLength(1);
    expect(states.at(-1)?.[1]).toContain("address already in use");
    expect(states.at(-1)?.[1]).not.toContain("\x1b");
    expect(states.at(-1)?.[1]).toContain(logFile);
  });

  it("reports a process that cannot be launched", async () => {
    const { server, processes, lastState } = setup({ ready: () => false });
    await server.start();

    processes[0]?.emit("error", new Error("spawn ENOENT"));

    await vi.waitFor(() => expect(lastState()).toBe("failed"));
  });

  it("writes the output to a log and keeps the previous run's", async () => {
    const { server, processes, logFile } = setup();
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, "上一次");

    await server.start();
    processes[0]?.stdout.write("本次输出\n");
    const stopped = server.stop();
    processes[0]?.exit(0);
    await stopped;

    await vi.waitFor(() => expect(readFileSync(logFile, "utf8")).toContain("本次输出"));
    expect(readFileSync(logFile.replace(/\.log$/, ".previous.log"), "utf8")).toBe("上一次");
  });
});
