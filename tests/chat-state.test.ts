import { describe, expect, it } from "vitest";

import { chatReducer, initialChatState, isTurnRunning, turnParts, type ChatState } from "../src/shared/chat-state";
import type { AppEvent, TurnView } from "../src/shared/types";

function reduce(events: AppEvent[], start: ChatState = initialChatState): ChatState {
  return events.reduce(chatReducer, start);
}

const STARTED: AppEvent = { type: "turn-started", turnId: "t1", userText: "你好" };

describe("chatReducer", () => {
  it("builds a turn from streamed events", () => {
    const state = reduce([
      STARTED,
      { type: "message-chunk", turnId: "t1", text: "你" },
      { type: "message-chunk", turnId: "t1", text: "好" },
      { type: "tool-call", turnId: "t1", toolCallId: "c1", title: "读文件", status: "pending" },
      { type: "tool-update", turnId: "t1", toolCallId: "c1", status: "completed" },
    ]);

    expect(state.turns[0]).toMatchObject({
      reply: "你好",
      tools: [{ id: "c1", title: "读文件", status: "completed" }],
    });
    expect(isTurnRunning(state)).toBe(true);
  });

  it("tracks whether a model is set up", () => {
    expect(initialChatState.modelConfigured).toBeNull();
    const state = reduce([{ type: "model-status", configured: true, label: "DeepSeek · deepseek-flash" }]);
    expect(state).toMatchObject({ modelConfigured: true, modelLabel: "DeepSeek · deepseek-flash" });
  });

  it("keeps what a call works on and why it was not asked", () => {
    const state = reduce([
      STARTED,
      {
        type: "tool-call",
        turnId: "t1",
        toolCallId: "c1",
        title: "run_command",
        status: "pending",
        detail: "Get-ChildItem",
      },
      {
        type: "tool-update",
        turnId: "t1",
        toolCallId: "c1",
        status: "in_progress",
        autoApproved: "只读命令，自动运行",
      },
      { type: "tool-update", turnId: "t1", toolCallId: "c1", status: "completed" },
    ]);

    expect(state.turns[0]?.tools).toEqual([
      {
        id: "c1",
        title: "run_command",
        status: "completed",
        detail: "Get-ChildItem",
        autoApproved: "只读命令，自动运行",
        textBefore: 0,
      },
    ]);
  });

  it("shows the app's own turns, evidence, the job list and install progress", () => {
    const evidence = { jobs: [{ id: "j1", mesh: "coarse", converged: true, grade: "trend" as const }], unmatched: [], missingCaveat: false };
    const state = reduce([
      { type: "turn-started", turnId: "t1", userText: "任务结束", auto: true },
      { type: "turn-evidence", turnId: "t1", evidence },
      { type: "hfss-jobs", jobs: [{ id: "j1", recipe: "project", analysis: "run", mesh: "coarse", state: "done", changed: {}, created: 1 }], autoAnalyze: false },
      { type: "setup-install", target: "install-hfss", line: "a" },
      { type: "setup-install", target: "install-hfss", line: "b" },
      { type: "setup-install", target: "install-hfss", done: { ok: true, message: "安装完成" } },
    ]);

    expect(state.turns[0]).toMatchObject({ auto: true, evidence });
    expect(state.hfssJobs).toHaveLength(1);
    expect(state.autoAnalyze).toBe(false);
    expect(state.install).toEqual({ target: "install-hfss", lines: ["a", "b"], done: { ok: true, message: "安装完成" } });
    const again = reduce([{ type: "setup-install", target: "install-hfss", line: "c" }], state);
    expect(again.install).toEqual({ target: "install-hfss", lines: ["c"] });
  });

  it("keeps why a call failed", () => {
    const state = reduce([
      STARTED,
      { type: "tool-call", turnId: "t1", toolCallId: "c1", title: "hfss__inspect_project", status: "pending" },
      { type: "tool-update", turnId: "t1", toolCallId: "c1", status: "failed", error: "找不到工程" },
    ]);

    expect(state.turns[0]?.tools[0]).toMatchObject({ status: "failed", error: "找不到工程" });
  });

  it("marks calls a stopped or failed turn left unfinished, and leaves finished ones alone", () => {
    const calls: AppEvent[] = [
      STARTED,
      { type: "tool-call", turnId: "t1", toolCallId: "c1", title: "a", status: "pending" },
      { type: "tool-update", turnId: "t1", toolCallId: "c1", status: "completed" },
      { type: "tool-call", turnId: "t1", toolCallId: "c2", title: "b", status: "pending" },
      { type: "tool-update", turnId: "t1", toolCallId: "c2", status: "in_progress" },
      { type: "tool-call", turnId: "t1", toolCallId: "c3", title: "c", status: "pending" },
    ];
    const statuses = (state: ChatState) => state.turns[0]?.tools.map((tool) => tool.status);

    const stopped = reduce([...calls, { type: "turn-ended", turnId: "t1", stopReason: "cancelled" }]);
    expect(statuses(stopped)).toEqual(["completed", "cancelled", "cancelled"]);
    const failed = reduce([...calls, { type: "turn-failed", turnId: "t1", message: "连接中断" }]);
    expect(statuses(failed)).toEqual(["completed", "cancelled", "cancelled"]);
  });

  it("puts the reply and the calls in the order they happened", () => {
    const state = reduce([
      STARTED,
      { type: "message-chunk", turnId: "t1", text: "先查一下。" },
      { type: "tool-call", turnId: "t1", toolCallId: "c1", title: "a", status: "pending" },
      { type: "tool-call", turnId: "t1", toolCallId: "c2", title: "b", status: "pending" },
      { type: "message-chunk", turnId: "t1", text: "还在跑。" },
      { type: "tool-call", turnId: "t1", toolCallId: "c3", title: "c", status: "pending" },
      { type: "message-chunk", turnId: "t1", text: "跑完了。" },
    ]);

    expect(turnParts(state.turns[0]!).map((part) => (part.kind === "text" ? part.text : part.tool.id))).toEqual([
      "先查一下。",
      "c1",
      "c2",
      "还在跑。",
      "c3",
      "跑完了。",
    ]);
  });

  it("shows a turn saved before calls knew their place as before: calls, then the reply", () => {
    const saved: TurnView = {
      id: "t1",
      userText: "x",
      memories: [],
      thought: "",
      reply: "答复",
      tools: [{ id: "c1", title: "a", status: "completed" }],
      state: "done",
    };

    expect(turnParts(saved).map((part) => part.kind)).toEqual(["tool", "text"]);
  });

  it("ends a turn as cancelled or done from its stop reason", () => {
    const cancelled = reduce([STARTED, { type: "turn-ended", turnId: "t1", stopReason: "cancelled" }]);
    const done = reduce([STARTED, { type: "turn-ended", turnId: "t1", stopReason: "end_turn" }]);

    expect(cancelled.turns[0]?.state).toBe("cancelled");
    expect(done.turns[0]?.state).toBe("done");
    expect(isTurnRunning(done)).toBe(false);
  });

  it("clears the transcript for a new session", () => {
    const state = reduce([{ type: "session-started", sessionId: "s1" }, STARTED]);

    expect(chatReducer(state, { type: "session-started", sessionId: "s2" }).turns).toEqual([]);
  });

  it("restores the transcript of a reopened session", () => {
    const opened = reduce([
      STARTED,
      { type: "turn-ended", turnId: "t1", stopReason: "end_turn" },
    ]).turns;

    const state = chatReducer(initialChatState, { type: "session-started", sessionId: "s1", turns: opened });

    expect(state.turns).toEqual(opened);
    expect(isTurnRunning(state)).toBe(false);
  });

  it("restores the transcript for a page reload, keeping an open permission prompt", () => {
    const prompt = { requestId: "r1", title: "运行命令" };
    const state = reduce([
      { type: "session-started", sessionId: "s1" },
      STARTED,
      { type: "permission-requested", prompt },
    ]);

    const replayed = chatReducer(state, { type: "session-started", sessionId: "s1", turns: state.turns });

    expect(replayed.turns).toHaveLength(1);
    expect(replayed.permissions).toEqual([prompt]);
  });

  it("shows compaction on its turn, and keeps the final numbers", () => {
    const state = reduce([
      STARTED,
      { type: "compaction", turnId: "t1", compaction: { status: "running" } },
      { type: "compaction", turnId: "t1", compaction: { status: "done", beforeTokens: 9, afterTokens: 3 } },
    ]);

    expect(state.turns[0]?.compaction).toEqual({ status: "done", beforeTokens: 9, afterTokens: 3 });
  });

  it("keeps the session list and shows notices", () => {
    const sessions = [{ id: "s1", title: "你好", createdAt: "", updatedAt: "", turnCount: 1 }];

    const state = reduce([
      { type: "sessions-changed", sessions },
      { type: "notice", message: "会话保存失败" },
    ]);

    expect(state.sessions).toEqual(sessions);
    expect(state.notice).toBe("会话保存失败");
  });

  it("removes a permission prompt once it is resolved", () => {
    const prompt = { requestId: "r1", title: "运行命令", detail: "dir" };
    const state = reduce([
      { type: "permission-requested", prompt },
      { type: "permission-resolved", requestId: "r1" },
    ]);

    expect(state.permissions).toEqual([]);
  });
});
