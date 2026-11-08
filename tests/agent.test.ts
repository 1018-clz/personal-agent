import { describe, expect, it, vi } from "vitest";

import { Agent, type AgentCallbacks, type AgentUpdate } from "../src/main/agent/agent";
import { compactionPolicy } from "../src/main/agent/compaction";
import type { ChatMessage, Completion, CompletionRequest, HistoryUpdate, ModelClient } from "../src/main/agent/model";
import type { Tool } from "../src/main/agent/tools";

const SIGNAL = new AbortController().signal;

function unsaved(update: HistoryUpdate): ChatMessage[] {
  if (update.kind !== "messages") throw new Error("expected plain messages");
  return update.messages;
}

function reply(content: string): Completion {
  return { content, reasoningContent: "", toolCalls: [], finishReason: "stop" };
}

function callTool(name: string, args = "{}", id = "c1"): Completion {
  return {
    content: "",
    reasoningContent: "思考",
    toolCalls: [{ id, name, arguments: args }],
    finishReason: "tool_calls",
  };
}

function tool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    definition: { name, description: "", parameters: { type: "object" } },
    describePermission: () => null,
    run: async () => "工具结果",
    ...overrides,
  };
}

function setup(script: Completion[], tools: Tool[], callbacks: Partial<AgentCallbacks> = {}) {
  const updates: AgentUpdate[] = [];
  const requests: ChatMessage[][] = [];
  const model: ModelClient = {
    complete: async ({ messages }, handlers) => {
      requests.push(structuredClone(messages));
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      if (next.content) handlers.onText(next.content);
      return next;
    },
  };
  const agent = new Agent(model, tools, {
    onUpdate: (update) => updates.push(update),
    requestPermission: async () => true,
    ...callbacks,
  });
  agent.newSession("系统提示");
  return { agent, updates, requests };
}

describe("Agent", () => {
  it("returns the reply when no tool is needed", async () => {
    const { agent, updates } = setup([reply("你好")], []);

    await expect(agent.runTurn("hi", SIGNAL)).resolves.toBe("end_turn");
    expect(updates).toEqual([{ kind: "message", text: "你好" }]);
  });

  it("swaps the system prompt and keeps the conversation", async () => {
    const { agent, requests } = setup([reply("一"), reply("二")], []);
    await agent.runTurn("第一句", SIGNAL);

    agent.setSystemPrompt("新的系统提示");
    await agent.runTurn("第二句", SIGNAL);

    expect(requests[1]?.map((message) => message.content)).toEqual(["新的系统提示", "第一句", "一", "第二句"]);
    expect(unsaved(agent.takeUnsavedHistory()).some((message) => message.role === "system")).toBe(false);
  });

  it("feeds tool results back to the model and keeps reasoning_content", async () => {
    const { agent, requests } = setup([callTool("read_file"), reply("读完了")], [tool("read_file")]);

    await agent.runTurn("读文件", SIGNAL);

    expect(requests[1]?.slice(-2)).toEqual([
      {
        role: "assistant",
        content: null,
        reasoningContent: "思考",
        toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "c1", content: "工具结果" },
    ]);
  });

  it("keeps history across turns", async () => {
    const { agent, requests } = setup([reply("一"), reply("二")], []);

    await agent.runTurn("第一轮", SIGNAL);
    await agent.runTurn("第二轮", SIGNAL);

    expect(requests[1]?.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("does not run a tool the user rejects, and tells the model", async () => {
    const run = vi.fn(async () => "不应运行");
    const write = tool("write_file", {
      describePermission: () => ({ title: "写入" }),
      run,
    });
    const { agent, requests } = setup([callTool("write_file"), reply("好的")], [write], {
      requestPermission: async () => false,
    });

    await agent.runTurn("写文件", SIGNAL);

    expect(run).not.toHaveBeenCalled();
    expect(requests[1]?.at(-1)).toMatchObject({ role: "tool", content: "用户拒绝了这次工具调用。" });
  });

  it("marks read-only tools as needing no approval, so deny rules can still see them", async () => {
    const requestPermission = vi.fn(async () => true);
    const { agent } = setup([callTool("read_file"), reply("好")], [tool("read_file")], {
      requestPermission,
    });

    await agent.runTurn("读", SIGNAL);

    expect(requestPermission).toHaveBeenCalledWith(
      { toolName: "read_file", args: {}, need: null },
      expect.anything(),
    );
  });

  it("shows what each call works on, and why it ran without asking", async () => {
    const command = tool("run_command", {
      summarize: (args: Record<string, unknown>) => String(args.command),
    });
    const { agent, updates } = setup(
      [callTool("run_command", JSON.stringify({ command: "Get-ChildItem" })), reply("好")],
      [command],
      { requestPermission: async () => ({ autoApproved: "只读命令，自动运行" }) },
    );

    await agent.runTurn("看看", SIGNAL);

    expect(updates).toContainEqual({
      kind: "tool-call",
      toolCallId: "c1",
      title: "run_command",
      status: "pending",
      detail: "Get-ChildItem",
    });
    expect(updates).toContainEqual({
      kind: "tool-update",
      toolCallId: "c1",
      status: "in_progress",
      autoApproved: "只读命令，自动运行",
    });
    expect(updates).toContainEqual({ kind: "tool-update", toolCallId: "c1", status: "completed" });
  });

  it("still runs a call whose summary throws", async () => {
    const run = vi.fn(async () => "结果");
    const broken = tool("read_file", {
      summarize: () => {
        throw new Error("坏了");
      },
      run,
    });
    const { agent } = setup([callTool("read_file"), reply("好")], [broken]);

    await agent.runTurn("读", SIGNAL);

    expect(run).toHaveBeenCalled();
  });

  it("passes a rule's refusal to the model", async () => {
    const run = vi.fn(async () => "不该运行");
    const { agent, requests } = setup([callTool("run_command"), reply("好")], [tool("run_command", { run })], {
      requestPermission: async () => "权限规则 run_command 禁止了这次调用",
    });

    await agent.runTurn("跑", SIGNAL);

    expect(run).not.toHaveBeenCalled();
    expect(requests[1]?.at(-1)).toMatchObject({ content: "权限规则 run_command 禁止了这次调用" });
  });

  it("reports a call that cannot apply without asking the user", async () => {
    const requestPermission = vi.fn(async () => true);
    const run = vi.fn(async () => "不该运行");
    const edit = tool("edit_file", {
      describePermission: async () => {
        throw new Error("没有找到 old_string");
      },
      run,
    });
    const { agent, requests } = setup([callTool("edit_file"), reply("好")], [edit], {
      requestPermission,
    });

    await agent.runTurn("改", SIGNAL);

    expect(requestPermission).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(requests[1]?.at(-1)).toMatchObject({ content: "错误：没有找到 old_string" });
  });

  it("reports hallucinated tools and bad arguments to the model instead of failing", async () => {
    const { agent, requests } = setup(
      [
        callTool("no_such_tool"),
        callTool("read_file", "{not json", "c2"),
        reply("抱歉"),
      ],
      [tool("read_file")],
    );

    await expect(agent.runTurn("hi", SIGNAL)).resolves.toBe("end_turn");
    expect(requests[1]?.at(-1)).toMatchObject({ content: expect.stringContaining("no_such_tool") });
    expect(requests[2]?.at(-1)).toMatchObject({ content: expect.stringContaining("参数无效") });
  });

  it("reports a failing tool to the model", async () => {
    const broken = tool("read_file", { run: () => Promise.reject(new Error("文件不存在")) });
    const { agent, requests, updates } = setup([callTool("read_file"), reply("好")], [broken]);

    await agent.runTurn("读", SIGNAL);

    expect(requests[1]?.at(-1)).toMatchObject({ content: "错误：文件不存在" });
    // The user sees the same reason, without the "错误：" the model needs.
    expect(updates).toContainEqual({ kind: "tool-update", toolCallId: "c1", status: "failed", error: "文件不存在" });
  });

  it("stops a model that keeps calling tools forever", async () => {
    const endless = Array.from({ length: 40 }, () => callTool("read_file"));
    const { agent, requests } = setup(endless, [tool("read_file")]);

    await expect(agent.runTurn("hi", SIGNAL)).resolves.toBe("max_turns");
    expect(requests).toHaveLength(25);
  });

  it("drops a cancelled turn so the next request has no unanswered tool calls", async () => {
    const abort = new AbortController();
    const slow = tool("run_command", {
      run: async (_args, signal) => {
        abort.abort();
        signal.throwIfAborted();
        return "不会到这里";
      },
    });
    const { agent, requests } = setup([callTool("run_command"), reply("下一轮")], [slow]);

    await expect(agent.runTurn("跑", abort.signal)).resolves.toBe("cancelled");
    await agent.runTurn("继续", SIGNAL);

    expect(requests[1]?.map((message) => message.role)).toEqual(["system", "user"]);
  });

  it("hands over each turn's new messages exactly once", async () => {
    const { agent } = setup([callTool("read_file"), reply("读完了"), reply("二")], [tool("read_file")]);

    await agent.runTurn("读", SIGNAL);
    expect(unsaved(agent.takeUnsavedHistory()).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(unsaved(agent.takeUnsavedHistory())).toEqual([]);

    await agent.runTurn("第二轮", SIGNAL);
    expect(unsaved(agent.takeUnsavedHistory()).map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("never hands over a turn that was dropped", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockRejectedValueOnce(new Error("402"));
    const agent = new Agent({ complete }, [], {
      onUpdate: () => {},
      requestPermission: async () => true,
    });
    agent.newSession("s");

    await expect(agent.runTurn("失败", SIGNAL)).rejects.toThrow();

    expect(unsaved(agent.takeUnsavedHistory())).toEqual([]);
  });

  it("continues a restored session with a new system prompt and the old history", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "旧问题" },
      { role: "assistant", content: "旧回答", reasoningContent: "旧思考" },
    ];
    const { agent, requests } = setup([reply("新回答")], []);

    agent.resumeSession("新的系统提示", history, null);
    await agent.runTurn("新问题", SIGNAL);

    expect(requests[0]).toEqual([
      { role: "system", content: "新的系统提示" },
      ...history,
      { role: "user", content: "新问题" },
    ]);
    expect(unsaved(agent.takeUnsavedHistory()).map((message) => message.content)).toEqual(["新问题", "新回答"]);
  });

  it("rejects a failed model call and drops that turn from the history", async () => {
    const requests: ChatMessage[][] = [];
    const complete = vi
      .fn<ModelClient["complete"]>()
      .mockRejectedValueOnce(new Error("402"))
      .mockImplementationOnce(async ({ messages }) => {
        requests.push(structuredClone(messages));
        return reply("好");
      });
    const agent = new Agent({ complete }, [], {
      onUpdate: () => {},
      requestPermission: async () => true,
    });
    agent.newSession("s");

    await expect(agent.runTurn("失败的一轮", SIGNAL)).rejects.toThrow("402");
    await agent.runTurn("下一轮", SIGNAL);

    expect(requests[0]).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "下一轮" },
    ]);
  });
});

describe("Agent compaction", () => {
  const LONG = "字".repeat(400);
  const SUMMARY: Completion = { content: "这是摘要", reasoningContent: "", toolCalls: [], finishReason: "stop" };

  /** Answers summary requests by itself and everything else from the script. */
  function compacting(script: Completion[], overrides: { summary?: () => Promise<Completion> } = {}) {
    const updates: AgentUpdate[] = [];
    const calls: CompletionRequest[] = [];
    const summaries: CompletionRequest[] = [];
    const model: ModelClient = {
      complete: async (request) => {
        if (request.tools.length === 0) {
          summaries.push(structuredClone(request));
          return overrides.summary ? overrides.summary() : SUMMARY;
        }
        calls.push(structuredClone(request));
        const next = script.shift();
        if (!next) throw new Error("script exhausted");
        return next;
      },
    };
    const agent = new Agent(
      model,
      [tool("read_file")],
      { onUpdate: (update) => updates.push(update), requestPermission: async () => true },
      { triggerTokens: 500, midTurnTokens: 1_500, tailTokens: 300 },
    );
    agent.newSession("系统提示");
    return { agent, updates, calls, summaries };
  }

  const statuses = (updates: AgentUpdate[]) =>
    updates.flatMap((update) => (update.kind === "compaction" ? [update.status] : []));

  it("does nothing while the context is small", async () => {
    const { agent, summaries } = compacting([reply("好")]);

    await agent.runTurn("你好", SIGNAL);

    expect(summaries).toEqual([]);
  });

  it("summarizes old turns once the context is too big, and keeps going", async () => {
    const { agent, calls, summaries, updates } = compacting([reply(LONG), reply("第二轮回答"), reply("好")]);

    await agent.runTurn("第一轮" + LONG, SIGNAL);
    expect(summaries).toEqual([]);

    await agent.runTurn("第二轮" + LONG, SIGNAL);
    expect(summaries).toHaveLength(1);
    expect(statuses(updates)).toEqual(["running", "done"]);

    await agent.runTurn("第三轮", SIGNAL);
    const last = calls.at(-1)!;
    expect(last.messages[0]?.content).toContain("这是摘要");
    expect(last.messages.at(-1)).toEqual({ role: "user", content: "第三轮" });
    expect(last.messages.some((message) => String(message.content).startsWith("第一轮"))).toBe(false);
  });

  it("trusts the size the API reports over its own estimate", async () => {
    const usage = { promptTokens: 400, completionTokens: 90 };
    const { agent, summaries } = compacting([{ ...reply(LONG), usage }, reply("好")]);

    await agent.runTurn("你好", SIGNAL);
    await agent.runTurn("再来", SIGNAL);

    expect(summaries).toEqual([]);
  });

  /** Every tool call returns 600 tokens, and the model keeps asking for more. */
  function readingAgent(toolCallCount: number, midTurnTokens: number) {
    const huge = tool("read_file", { run: async () => "字".repeat(1_200) });
    const script = [
      ...Array.from({ length: toolCallCount }, (_, index) => callTool("read_file", "{}", `c${index}`)),
      reply("完成"),
    ];
    const calls: CompletionRequest[] = [];
    const summaries: CompletionRequest[] = [];
    const model: ModelClient = {
      complete: async (request) => {
        if (request.tools.length === 0) {
          summaries.push(request);
          return SUMMARY;
        }
        calls.push(structuredClone(request));
        return script.shift()!;
      },
    };
    const agent = new Agent(
      model,
      [huge],
      { onUpdate: () => {}, requestPermission: async () => true },
      { triggerTokens: 500, midTurnTokens, tailTokens: 300 },
    );
    agent.newSession("系统提示");
    return { agent, calls, summaries };
  }

  it("compacts in the middle of a turn that fills the context", async () => {
    const { agent, calls } = readingAgent(2, 1_000);

    await expect(agent.runTurn("读两个大文件", SIGNAL)).resolves.toBe("end_turn");

    const last = calls.at(-1)!;
    expect(last.messages[0]?.content).toContain("这是摘要");
    expect(last.messages[1]).toEqual({ role: "user", content: "读两个大文件" });
    expect(last.messages[2]?.role).toBe("assistant");
  });

  it("leaves a running turn alone between the two limits", async () => {
    const { agent, summaries } = readingAgent(2, 5_000);

    await expect(agent.runTurn("读两个大文件", SIGNAL)).resolves.toBe("end_turn");

    expect(summaries).toEqual([]);
  });

  it("gives up compacting after two rounds in one turn instead of thrashing", async () => {
    const { agent, summaries } = readingAgent(12, 800);

    await expect(agent.runTurn("读很多大文件", SIGNAL)).resolves.toBe("end_turn");

    expect(summaries).toHaveLength(2);
  });

  it("carries on with the full context when summarizing fails, and retries next turn", async () => {
    let attempts = 0;
    const { agent, updates, calls } = compacting([reply(LONG), reply("这轮照常"), reply("下一轮")], {
      summary: async () => {
        attempts++;
        if (attempts === 1) throw new Error("断网");
        return SUMMARY;
      },
    });
    await agent.runTurn("第一轮" + LONG, SIGNAL);

    await expect(agent.runTurn("第二轮" + LONG, SIGNAL)).resolves.toBe("end_turn");
    expect(attempts).toBe(1);
    expect(statuses(updates)).toContain("failed");
    expect(calls.at(-1)?.messages[0]?.content).toBe("系统提示");

    await agent.runTurn("第三轮", SIGNAL);
    expect(attempts).toBe(2);
    expect(calls.at(-1)?.messages[0]?.content).toContain("这是摘要");
  });

  it("restores the context from before compaction when the turn is cancelled", async () => {
    const abort = new AbortController();
    let cancel = true;
    const { agent, updates, calls } = compacting([reply(LONG), reply("恢复后")], {
      summary: async () => {
        if (!cancel) return SUMMARY;
        abort.abort();
        throw new DOMException("已取消", "AbortError");
      },
    });
    await agent.runTurn("第一轮" + LONG, SIGNAL);
    agent.takeUnsavedHistory();

    await expect(agent.runTurn("第二轮" + LONG, abort.signal)).resolves.toBe("cancelled");

    expect(statuses(updates)).toEqual(["running"]);
    expect(agent.takeUnsavedHistory()).toEqual({ kind: "messages", messages: [] });

    cancel = false;
    await agent.runTurn("第三轮", SIGNAL);
    const sent = calls.at(-1)!.messages;
    expect(sent.some((message) => String(message.content).startsWith("第二轮"))).toBe(false);
    expect(sent.at(-1)).toEqual({ role: "user", content: "第三轮" });
  });

  it("undoes a compaction when the turn that made it then fails", async () => {
    const script = [reply(LONG)];
    const { agent, calls, updates } = compacting(script);
    await agent.runTurn("第一轮" + LONG, SIGNAL);
    agent.takeUnsavedHistory();

    await expect(agent.runTurn("第二轮" + LONG, SIGNAL)).rejects.toThrow("script exhausted");

    expect(statuses(updates)).toEqual(["running", "done"]);
    expect(calls.at(-1)?.messages[0]?.content).toContain("这是摘要");
    expect(agent.takeUnsavedHistory()).toEqual({ kind: "messages", messages: [] });

    script.push(reply("好"));
    await agent.runTurn("短", SIGNAL);
    const sent = calls.at(-1)!.messages;
    expect(sent.some((message) => String(message.content).startsWith("第二轮"))).toBe(false);
    expect(sent.at(-1)).toEqual({ role: "user", content: "短" });
  });

  it("saves a compaction as a checkpoint holding the summary and what is left", async () => {
    const { agent } = compacting([reply(LONG), reply("好")]);
    await agent.runTurn("第一轮" + LONG, SIGNAL);
    agent.takeUnsavedHistory();

    await agent.runTurn("第二轮" + LONG, SIGNAL);
    const update = agent.takeUnsavedHistory();

    expect(update.kind).toBe("compaction");
    if (update.kind === "compaction") {
      expect(update.summary).toBe("这是摘要");
      expect(update.tail.at(-1)).toMatchObject({ role: "assistant", content: "好" });
    }
    expect(agent.takeUnsavedHistory()).toEqual({ kind: "messages", messages: [] });
  });

  it("restores a compacted session with its summary", async () => {
    const { agent, calls } = compacting([reply("好")]);

    agent.resumeSession("新系统提示", [{ role: "user", content: "尾部" }], "旧摘要");
    await agent.runTurn("继续", SIGNAL);

    expect(calls[0]?.messages[0]?.content).toContain("新系统提示");
    expect(calls[0]?.messages[0]?.content).toContain("旧摘要");
  });

  it("feeds the previous summary into the next compaction", async () => {
    const script = Array.from({ length: 6 }, () => reply(LONG));
    const { agent, summaries } = compacting(script);

    for (let turn = 0; turn < 6; turn++) await agent.runTurn(`第${turn}轮${LONG}`, SIGNAL);

    expect(summaries.length).toBeGreaterThanOrEqual(2);
    expect(summaries.at(-1)?.messages[1]?.content).toContain("这是摘要");
  });

  it("uses a 200K threshold unless told otherwise", () => {
    expect(compactionPolicy(200_000).triggerTokens).toBe(200_000);
  });
});

