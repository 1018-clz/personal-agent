import { describe, expect, it, vi } from "vitest";

import type { AppEvent, MemorySnippet } from "../src/shared/types";
import type { CompletedTurn, MemoryPort } from "../src/main/memory-service";
import { TurnOrchestrator, type AgentPort, type TurnHooks } from "../src/main/turn-orchestrator";

const MEMORY: MemorySnippet = { id: "m1", text: "用户喜欢喝咖啡", type: "world" };

function setup(overrides: { agent?: Partial<AgentPort>; memory?: Partial<MemoryPort>; hooks?: TurnHooks } = {}) {
  const events: AppEvent[] = [];
  const retained: CompletedTurn[] = [];
  const prompts: string[] = [];
  const newSession = vi.fn<AgentPort["newSession"]>();
  const resumeSession = vi.fn<AgentPort["resumeSession"]>();
  const setSystemPrompt = vi.fn<AgentPort["setSystemPrompt"]>();

  const memory: MemoryPort = {
    checkHealth: async () => true,
    recall: async () => [MEMORY],
    search: async () => [MEMORY],
    recallProfile: async () => [],
    retain: async (turn) => void retained.push(turn),
    ...overrides.memory,
  };

  let id = 0;
  const orchestrator: TurnOrchestrator = new TurnOrchestrator(
    {
      newSession,
      resumeSession,
      setSystemPrompt,
      runTurn: async (text) => {
        prompts.push(text);
        orchestrator.handleUpdate({ kind: "message", text: "好的" });
        return "end_turn";
      },
      ...overrides.agent,
    },
    memory,
    (memoryRules) => `system: ${memoryRules}`,
    (event) => events.push(event),
    () => `id-${++id}`,
    overrides.hooks,
  );
  return { orchestrator, events, retained, prompts, newSession, resumeSession, setSystemPrompt };
}

describe("TurnOrchestrator", () => {
  it("marks a turn the app started, and tells the app when turns start and end", async () => {
    const seen: string[] = [];
    let busyAtEnd: boolean | null = null;
    const { orchestrator, events }: { orchestrator: TurnOrchestrator; events: AppEvent[] } = setup({
      hooks: {
        onTurnStart: (text) => seen.push(`start:${text}`),
        onTurnEnd: (turnId, reply, stopReason) => {
          seen.push(`end:${turnId}:${reply}:${stopReason}`);
          busyAtEnd = orchestrator.busy;
          // Whatever the hook adds must come before turn-ended: the session is saved at turn-ended.
          seen.push(`turn-ended already sent: ${events.some((event) => event.type === "turn-ended")}`);
        },
      },
    });
    await orchestrator.startSession();

    expect(orchestrator.busy).toBe(false);
    await orchestrator.send("任务结束了", { auto: true });

    expect(events).toContainEqual({ type: "turn-started", turnId: "id-2", userText: "任务结束了", auto: true });
    expect(seen).toEqual(["start:任务结束了", "end:id-2:好的:end_turn", "turn-ended already sent: false"]);
    // Still busy while the hook runs: a report it triggers must wait for the turn to clear.
    expect(busyAtEnd).toBe(true);
    expect(orchestrator.busy).toBe(false);
  });

  it("injects recalled memories into the prompt", async () => {
    const { orchestrator, prompts, events } = setup();
    await orchestrator.startSession();

    await orchestrator.send("今天喝什么？");

    expect(prompts[0]).toContain("<memory_context>");
    expect(prompts[0]).toContain(MEMORY.text);
    expect(prompts[0]).toContain("今天喝什么？");
    expect(events).toContainEqual({ type: "turn-memories", turnId: "id-2", memories: [MEMORY] });
  });

  it("retains the raw exchange, never the injected memories", async () => {
    const { orchestrator, retained } = setup();
    await orchestrator.startSession();

    await orchestrator.send("今天喝什么？");

    expect(retained).toEqual([
      { turnId: "id-2", sessionId: "id-1", userText: "今天喝什么？", assistantText: "好的" },
    ]);
  });

  it("passes on what a tool call works on and why it was not asked", async () => {
    const { orchestrator, events } = setup({
      agent: {
        runTurn: async () => {
          orchestrator.handleUpdate({
            kind: "tool-call",
            toolCallId: "c1",
            title: "run_command",
            status: "pending",
            detail: "Get-ChildItem",
          });
          orchestrator.handleUpdate({
            kind: "tool-update",
            toolCallId: "c1",
            status: "in_progress",
            autoApproved: "只读命令，自动运行",
          });
          return "end_turn";
        },
      },
    });
    await orchestrator.startSession();

    await orchestrator.send("看看");

    expect(events).toContainEqual({
      type: "tool-call",
      turnId: "id-2",
      toolCallId: "c1",
      title: "run_command",
      status: "pending",
      detail: "Get-ChildItem",
    });
    expect(events).toContainEqual({
      type: "tool-update",
      turnId: "id-2",
      toolCallId: "c1",
      status: "in_progress",
      autoApproved: "只读命令，自动运行",
    });
  });

  it("waits for a system prompt that is built asynchronously", async () => {
    const newSession = vi.fn<AgentPort["newSession"]>();
    const orchestrator = new TurnOrchestrator(
      { newSession, resumeSession: vi.fn(), setSystemPrompt: vi.fn(), runTurn: async () => "end_turn" },
      { checkHealth: async () => false, recall: async () => [], search: async () => [], recallProfile: async () => [], retain: async () => {} },
      async (memoryRules) => `system with AGENTS.md: ${memoryRules.length > 0}`,
      () => {},
      () => "id",
    );

    await orchestrator.startSession();

    expect(newSession).toHaveBeenCalledWith("system with AGENTS.md: true");
  });

  it("still answers when recall finds nothing", async () => {
    const { orchestrator, prompts, events } = setup({ memory: { recall: async () => [] } });
    await orchestrator.startSession();

    await orchestrator.send("你好");

    expect(prompts).toEqual(["你好"]);
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", stopReason: "end_turn" });
  });

  it("does not retain a cancelled turn", async () => {
    const { orchestrator, retained } = setup({ agent: { runTurn: async () => "cancelled" } });
    await orchestrator.startSession();

    await orchestrator.send("你好");

    expect(retained).toEqual([]);
  });

  it("skips the agent when cancelled during recall", async () => {
    let finishRecall = (_memories: MemorySnippet[]) => {};
    const recall = () => new Promise<MemorySnippet[]>((resolve) => (finishRecall = resolve));
    const { orchestrator, prompts, events } = setup({ memory: { recall } });
    await orchestrator.startSession();

    const sent = orchestrator.send("你好");
    orchestrator.cancel();
    finishRecall([]);
    await sent;

    expect(prompts).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", stopReason: "cancelled" });
  });

  it("aborts the running turn on cancel", async () => {
    const { orchestrator, events } = setup({
      agent: {
        runTurn: (_text, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve("cancelled"), { once: true }),
          ),
      },
    });
    await orchestrator.startSession();

    const sent = orchestrator.send("你好");
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "turn-memories")).toBe(true),
    );
    orchestrator.cancel();
    await sent;

    expect(events.at(-1)).toMatchObject({ type: "turn-ended", stopReason: "cancelled" });
  });

  it("reports a failed turn and accepts the next one", async () => {
    const runTurn = vi
      .fn<AgentPort["runTurn"]>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("end_turn");
    const { orchestrator, events } = setup({ agent: { runTurn } });
    await orchestrator.startSession();

    await orchestrator.send("第一条");
    expect(events.at(-1)).toEqual({ type: "turn-failed", turnId: "id-2", message: "boom" });

    await orchestrator.send("第二条");
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", turnId: "id-3" });
  });

  it("rejects a second prompt while a turn is running", async () => {
    let finish = () => {};
    const runTurn = () =>
      new Promise<string>((resolve) => {
        finish = () => resolve("end_turn");
      });
    const { orchestrator } = setup({ agent: { runTurn } });
    await orchestrator.startSession();

    const first = orchestrator.send("第一条");
    await expect(orchestrator.send("第二条")).rejects.toThrow(/进行中/);
    await vi.waitFor(() => finish());
    await first;
  });

  it("puts the user's profile into the system prompt", async () => {
    const { orchestrator, newSession } = setup({ memory: { recallProfile: async () => [MEMORY] } });

    await orchestrator.startSession();

    expect(newSession.mock.calls[0]?.[0]).toContain(MEMORY.text);
  });

  it("resumes a session under its own id, with a freshly built system prompt", async () => {
    const { orchestrator, resumeSession, events, retained } = setup({
      memory: { recallProfile: async () => [MEMORY] },
    });
    const history = [{ role: "user" as const, content: "旧问题" }];

    await orchestrator.resumeSession("old-session", { history, contextSummary: "摘要", turns: [] });

    expect(resumeSession.mock.calls[0]?.[0]).toContain(MEMORY.text);
    expect(resumeSession.mock.calls[0]?.[1]).toEqual(history);
    expect(resumeSession.mock.calls[0]?.[2]).toBe("摘要");
    expect(events.at(-1)).toEqual({ type: "session-started", sessionId: "old-session", turns: [] });

    await orchestrator.send("继续");
    expect(retained[0]?.sessionId).toBe("old-session");
  });

  it("refuses to switch sessions while a turn is running", async () => {
    let finish = () => {};
    const runTurn = () =>
      new Promise<string>((resolve) => {
        finish = () => resolve("end_turn");
      });
    const { orchestrator, resumeSession } = setup({ agent: { runTurn } });
    await orchestrator.startSession();

    const sent = orchestrator.send("你好");
    await expect(
      orchestrator.resumeSession("other", { history: [], contextSummary: null, turns: [] }),
    ).rejects.toThrow(/切换/);
    await expect(orchestrator.startSession()).rejects.toThrow(/新建/);
    expect(resumeSession).not.toHaveBeenCalled();
    await vi.waitFor(() => finish());
    await sent;
  });

  it("shows compaction progress on the running turn", async () => {
    const { orchestrator, events } = setup({
      agent: {
        runTurn: async () => {
          orchestrator.handleUpdate({ kind: "compaction", status: "done", beforeTokens: 9, afterTokens: 3 });
          return "end_turn";
        },
      },
    });
    await orchestrator.startSession();

    await orchestrator.send("你好");

    expect(events).toContainEqual({
      type: "compaction",
      turnId: "id-2",
      compaction: { status: "done", beforeTokens: 9, afterTokens: 3 },
    });
  });

  it("skips the profile when memory is offline", async () => {
    const recallProfile = vi.fn(async () => [MEMORY]);
    const { orchestrator } = setup({
      memory: { checkHealth: async () => false, recallProfile },
    });

    await orchestrator.startSession();

    expect(recallProfile).not.toHaveBeenCalled();
  });

  it("adds memory to the prompt once it comes online", async () => {
    let online = false;
    const { orchestrator, newSession, setSystemPrompt } = setup({
      memory: { checkHealth: async () => online, recallProfile: async () => [MEMORY] },
    });
    await orchestrator.startSession();
    expect(newSession.mock.calls[0]?.[0]).not.toContain(MEMORY.text);

    online = true;
    await orchestrator.refreshSystemPrompt();

    expect(setSystemPrompt.mock.calls[0]?.[0]).toContain(MEMORY.text);
    expect(setSystemPrompt.mock.calls[0]?.[0]).toContain("saved to long-term memory automatically");
  });

  it("waits for the running turn before changing the prompt", async () => {
    let finish = () => {};
    const runTurn = () =>
      new Promise<string>((resolve) => {
        finish = () => resolve("end_turn");
      });
    const { orchestrator, setSystemPrompt } = setup({ agent: { runTurn } });
    await orchestrator.startSession();

    const sent = orchestrator.send("你好");
    await orchestrator.refreshSystemPrompt();
    expect(setSystemPrompt).not.toHaveBeenCalled();

    await vi.waitFor(() => finish());
    await sent;
    await vi.waitFor(() => expect(setSystemPrompt).toHaveBeenCalledTimes(1));
  });

  it("has no prompt to refresh before a session starts", async () => {
    const { orchestrator, setSystemPrompt } = setup();
    await orchestrator.refreshSystemPrompt();
    expect(setSystemPrompt).not.toHaveBeenCalled();
  });
});
