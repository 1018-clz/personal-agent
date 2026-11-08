import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatMessage, HistoryUpdate } from "../src/main/agent/model";
import { SessionStore } from "../src/main/session-store";
import type { TurnView } from "../src/shared/types";

let root: string;
let sessionsDir: string;
let store: SessionStore;

function turn(userText: string, overrides: Partial<TurnView> = {}): TurnView {
  return {
    id: randomUUID(),
    userText,
    memories: [],
    thought: "",
    reply: "好的",
    tools: [],
    state: "done",
    ...overrides,
  };
}

const MESSAGES: ChatMessage[] = [
  { role: "user", content: "读文件" },
  {
    role: "assistant",
    content: null,
    reasoningContent: "要先读文件",
    toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
  },
  { role: "tool", toolCallId: "c1", content: "内容" },
  { role: "assistant", content: "读完了", reasoningContent: "可以回答了" },
];

function messagesUpdate(messages: ChatMessage[]): HistoryUpdate {
  return { kind: "messages", messages };
}

const NOTHING = messagesUpdate([]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
  sessionsDir = join(root, "sessions");
  store = new SessionStore(sessionsDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("has no sessions before anything is saved", async () => {
    await expect(store.list()).resolves.toEqual([]);
  });

  it("round-trips turns and the model history, including reasoning_content", async () => {
    const id = randomUUID();
    const saved = turn("读文件", { thought: "想", tools: [{ id: "c1", title: "read_file", status: "completed" }] });

    await store.appendTurn(id, saved, messagesUpdate(MESSAGES));
    const session = await store.load(id);

    expect(session.turns).toEqual([saved]);
    expect(session.history).toEqual(MESSAGES);
  });

  it("appends later turns in order and keeps the first title", async () => {
    const id = randomUUID();
    await store.appendTurn(id, turn("第一条"), messagesUpdate([{ role: "user", content: "第一条" }]));
    await store.appendTurn(id, turn("第二条"), messagesUpdate([{ role: "user", content: "第二条" }]));

    const session = await store.load(id);

    expect(session.summary).toMatchObject({ title: "第一条", turnCount: 2 });
    expect(session.history.map((message) => message.content)).toEqual(["第一条", "第二条"]);
  });

  it("keeps cancelled turns in the transcript but not in the model history", async () => {
    const id = randomUUID();
    await store.appendTurn(id, turn("被取消的", { state: "cancelled" }), NOTHING);

    const session = await store.load(id);

    expect(session.turns).toHaveLength(1);
    expect(session.history).toEqual([]);
  });

  it("makes a short single-line title from the first message", async () => {
    const id = randomUUID();
    await store.appendTurn(id, turn(`第一行\n第二行 ${"很长".repeat(40)}`), NOTHING);

    const [summary] = await store.list();

    expect(summary?.title).not.toContain("\n");
    expect(summary?.title.length).toBeLessThanOrEqual(41);
    expect(summary?.title.endsWith("…")).toBe(true);
  });

  it("lists the most recently used session first", async () => {
    const older = randomUUID();
    const newer = randomUUID();
    await store.appendTurn(older, turn("旧的"), NOTHING);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.appendTurn(newer, turn("新的"), NOTHING);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.appendTurn(older, turn("旧的又用了"), NOTHING);

    const sessions = await store.list();

    expect(sessions.map((session) => session.id)).toEqual([older, newer]);
  });

  it("drops only the torn line after a crash, keeping every whole turn", async () => {
    const id = randomUUID();
    await store.appendTurn(id, turn("完整的"), messagesUpdate(MESSAGES));
    appendFileSync(join(sessionsDir, id, "chat_history.jsonl"), '[{"role":"assistant","tool_ca');
    appendFileSync(join(sessionsDir, id, "turns.jsonl"), '{"id":"x","userTe');

    const session = await store.load(id);

    expect(session.history).toEqual(MESSAGES);
    expect(session.turns).toHaveLength(1);
  });

  it("skips a session with a damaged summary instead of failing the list", async () => {
    const good = randomUUID();
    const bad = randomUUID();
    await store.appendTurn(good, turn("好的"), NOTHING);
    await store.appendTurn(bad, turn("坏的"), NOTHING);
    writeFileSync(join(sessionsDir, bad, "summary.json"), "{ not json");

    const sessions = await store.list();

    expect(sessions.map((session) => session.id)).toEqual([good]);
  });

  it("ignores anything in the folder that is not a session", async () => {
    await store.appendTurn(randomUUID(), turn("好的"), NOTHING);
    writeFileSync(join(sessionsDir, "notes.txt"), "x");

    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("resumes from the latest compaction, keeping what came after it", async () => {
    const id = randomUUID();
    const tail: ChatMessage[] = [{ role: "user", content: "保留的" }];
    await store.appendTurn(id, turn("第一轮"), messagesUpdate(MESSAGES));
    await store.appendTurn(id, turn("压缩"), { kind: "compaction", summary: "第一次摘要", tail: [] });
    await store.appendTurn(id, turn("压缩"), { kind: "compaction", summary: "第二次摘要", tail });
    await store.appendTurn(id, turn("之后"), messagesUpdate([{ role: "user", content: "之后的" }]));

    const session = await store.load(id);

    expect(session.contextSummary).toBe("第二次摘要");
    expect(session.history.map((message) => message.content)).toEqual(["保留的", "之后的"]);
    expect(session.turns).toHaveLength(4);
  });

  it("loads sessions saved before compaction existed", async () => {
    const id = randomUUID();
    await store.appendTurn(id, turn("旧会话"), messagesUpdate(MESSAGES));

    const session = await store.load(id);

    expect(session.contextSummary).toBeNull();
    expect(session.history).toEqual(MESSAGES);
  });

  it("falls back to the previous state when a checkpoint was torn by a crash", async () => {
    const id = randomUUID();
    await store.appendTurn(id, turn("第一轮"), messagesUpdate(MESSAGES));
    appendFileSync(join(sessionsDir, id, "chat_history.jsonl"), '{"compaction":{"summary":"写到一半');

    const session = await store.load(id);

    expect(session.contextSummary).toBeNull();
    expect(session.history).toEqual(MESSAGES);
  });

  it("keeps the full history on disk after compaction", async () => {
    const id = randomUUID();
    await store.appendTurn(id, turn("第一轮"), messagesUpdate(MESSAGES));
    await store.appendTurn(id, turn("压缩"), { kind: "compaction", summary: "摘要", tail: [] });

    const text = readFileSync(join(sessionsDir, id, "chat_history.jsonl"), "utf8");

    expect(text).toContain("要先读文件");
  });

  it("reports a session that no longer exists", async () => {
    await expect(store.load(randomUUID())).rejects.toThrow(/不存在/);
  });

  it("deletes a session and everything in it", async () => {
    const keep = randomUUID();
    const remove = randomUUID();
    await store.appendTurn(keep, turn("留下"), messagesUpdate(MESSAGES));
    await store.appendTurn(remove, turn("删除"), messagesUpdate(MESSAGES));

    await store.delete(remove);

    expect(readdirSync(sessionsDir)).toEqual([keep]);
    await expect(store.list()).resolves.toHaveLength(1);
  });

  describe("session ids come from the renderer", () => {
    const outside = () => join(root, "outside.txt");

    it.each(["..", "../outside.txt", "..\\outside.txt", "C:\\Windows", "", "abc"])(
      "refuses to delete %j",
      async (id) => {
        writeFileSync(outside(), "must survive");

        await expect(store.delete(id)).rejects.toThrow(/无效/);
        expect(existsSync(outside())).toBe(true);
      },
    );

    it("refuses to read outside the sessions folder", async () => {
      await expect(store.load("../../secret")).rejects.toThrow();
    });
  });
});
