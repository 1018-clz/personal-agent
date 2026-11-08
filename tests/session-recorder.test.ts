import { describe, expect, it, vi } from "vitest";

import type { ChatMessage, HistoryUpdate } from "../src/main/agent/model";
import { SessionRecorder } from "../src/main/session-recorder";
import type { SessionStore } from "../src/main/session-store";
import type { AppEvent, SessionSummary, TurnView } from "../src/shared/types";

const MESSAGE: ChatMessage = { role: "user", content: "你好" };

function setup(overrides: { appendTurn?: SessionStore["appendTurn"]; messages?: () => ChatMessage[] } = {}) {
  const saved: Array<{ sessionId: string; turn: TurnView; update: HistoryUpdate }> = [];
  const emitted: AppEvent[] = [];
  const sessions: SessionSummary[] = [];
  const store = {
    appendTurn:
      overrides.appendTurn ??
      (async (sessionId: string, turn: TurnView, update: HistoryUpdate) => {
        saved.push({ sessionId, turn, update });
      }),
    list: async () => sessions,
  } as unknown as SessionStore;
  const take = overrides.messages ?? (() => [MESSAGE]);
  const recorder = new SessionRecorder(store, () => ({ kind: "messages", messages: take() }), (event) =>
    emitted.push(event),
  );
  recorder.observe({ type: "session-started", sessionId: "s1" });
  return { recorder, saved, emitted };
}

const started = (turnId: string): AppEvent => ({ type: "turn-started", turnId, userText: "你好" });

describe("SessionRecorder", () => {
  it("saves the finished turn with its whole reply", async () => {
    const { recorder, saved } = setup();

    recorder.observe(started("t1"));
    recorder.observe({ type: "message-chunk", turnId: "t1", text: "你" });
    recorder.observe({ type: "message-chunk", turnId: "t1", text: "好" });
    recorder.observe({ type: "turn-ended", turnId: "t1", stopReason: "end_turn" });
    await recorder.flush();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      sessionId: "s1",
      turn: { id: "t1", reply: "你好", state: "done" },
      update: { messages: [MESSAGE] },
    });
  });

  it("saves nothing until a turn finishes", async () => {
    const { recorder, saved } = setup();

    recorder.observe(started("t1"));
    await recorder.flush();

    expect(saved).toEqual([]);
  });

  it("saves failed turns, so the error is still there when reopened", async () => {
    const { recorder, saved } = setup({ messages: () => [] });

    recorder.observe(started("t1"));
    recorder.observe({ type: "turn-failed", turnId: "t1", message: "余额不足" });
    await recorder.flush();

    expect(saved[0]).toMatchObject({ turn: { state: "failed", error: "余额不足" }, update: { messages: [] } });
  });

  it("keeps turns in order even when an earlier save is slow", async () => {
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { recorder } = setup({
      appendTurn: async (_id, turn) => {
        if (turn.id === "t1") await gate;
        order.push(turn.id);
      },
    });

    recorder.observe(started("t1"));
    recorder.observe({ type: "turn-ended", turnId: "t1", stopReason: "end_turn" });
    recorder.observe(started("t2"));
    recorder.observe({ type: "turn-ended", turnId: "t2", stopReason: "end_turn" });
    release();
    await recorder.flush();

    expect(order).toEqual(["t1", "t2"]);
  });

  it("files a turn under its own session when the session changes straight after", async () => {
    const { recorder, saved } = setup();

    recorder.observe(started("t1"));
    recorder.observe({ type: "turn-ended", turnId: "t1", stopReason: "end_turn" });
    recorder.observe({ type: "session-started", sessionId: "s2" });
    await recorder.flush();

    expect(saved[0]?.sessionId).toBe("s1");
  });

  it("takes the turn's messages immediately, not when the queue gets to it", async () => {
    let unsaved = [MESSAGE];
    const take = vi.fn(() => {
      const messages = unsaved;
      unsaved = [];
      return messages;
    });
    const { recorder, saved } = setup({ messages: take });

    recorder.observe(started("t1"));
    recorder.observe({ type: "turn-ended", turnId: "t1", stopReason: "end_turn" });

    expect(take).toHaveBeenCalledOnce();
    await recorder.flush();
    expect(saved[0]?.update).toMatchObject({ messages: [MESSAGE] });
  });

  it("tells the user when saving fails, and keeps working", async () => {
    const { recorder, emitted } = setup({
      appendTurn: () => Promise.reject(new Error("磁盘已满")),
    });

    recorder.observe(started("t1"));
    recorder.observe({ type: "turn-ended", turnId: "t1", stopReason: "end_turn" });
    await recorder.flush();

    expect(emitted).toContainEqual({ type: "notice", message: "会话保存失败：磁盘已满" });
  });

  it("publishes the session list after each save", async () => {
    const { recorder, emitted } = setup();

    recorder.observe(started("t1"));
    recorder.observe({ type: "turn-ended", turnId: "t1", stopReason: "end_turn" });
    await recorder.flush();

    expect(emitted.at(-1)).toEqual({ type: "sessions-changed", sessions: [] });
  });
});
