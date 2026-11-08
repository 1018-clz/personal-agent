// Runs the real MemoryService against a real Hindsight server, with Chinese memories, in a
// throwaway bank. Needs `npm.cmd run hindsight` running. Costs a little DeepSeek usage.
import { randomUUID } from "node:crypto";

import { HindsightClient } from "@vectorize-io/hindsight-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MemoryService } from "../../src/main/memory-service";
import type { MemoryStatus } from "../../src/shared/types";

const BASE_URL = "http://127.0.0.1:8888";
const BANK = `live-test-${randomUUID()}`;
const INGEST_TIMEOUT_MS = 240_000;

const CONVERSATIONS = [
  ["我最喜欢喝手冲咖啡，尤其是耶加雪菲。", "记住了，你偏爱耶加雪菲手冲。"],
  ["我女儿小满今年六岁，在上海读小学。", "好的，小满六岁，在上海上小学。"],
  ["我下个月要去成都出差，见客户王总。", "明白，下个月成都出差见王总。"],
  ["提醒一下，我对花生过敏，吃了会起疹子。", "记住了，你对花生过敏。"],
  ["我的 Personal Agent 项目是用 TypeScript 写的，模型接的是 DeepSeek。", "了解。"],
];

/** Each query with text the right memory must contain, and how it tests retrieval. */
const QUERIES: Array<[kind: string, query: string, expected: string]> = [
  ["换说法", "我有什么饮食禁忌？", "花生"],
  ["换说法", "我孩子多大了？", "六"],
  ["换说法", "我平时爱喝什么饮料？", "咖啡"],
  ["换说法", "最近有什么出行安排？", "成都"],
  ["精确词", "耶加雪菲", "耶加雪菲"],
  ["精确词", "小满", "小满"],
  ["精确词", "王总", "王总"],
  ["中英混合", "Personal Agent 是用什么语言写的？", "TypeScript"],
  ["中英混合", "DeepSeek", "DeepSeek"],
];

describe("real Hindsight", () => {
  const client = new HindsightClient({ baseUrl: BASE_URL });
  const statuses: Array<[MemoryStatus, string | undefined]> = [];
  const memory = new MemoryService(
    { enabled: true, baseUrl: BASE_URL, bankId: BANK, autoStart: false },
    (status, message) => statuses.push([status, message]),
  );

  beforeAll(async () => {
    if (!(await memory.checkHealth())) throw new Error("Hindsight 没有运行：请先运行 npm.cmd run hindsight");
  });

  afterAll(async () => {
    await client.deleteBank(BANK).catch((error: unknown) => console.log(`清理失败：${String(error)}`));
  });

  it("treats a brand-new user as online with no memories", async () => {
    await expect(memory.recall("你好")).resolves.toEqual([]);
    await expect(memory.recallProfile()).resolves.toEqual([]);

    expect(statuses.at(-1)?.[0]).toBe("online");
  });

  it("creates the bank on first use and stores conversations asynchronously", async () => {
    const started = Date.now();
    for (const [userText, assistantText] of CONVERSATIONS) {
      await memory.retain({
        turnId: randomUUID(),
        sessionId: "live-session",
        userText: userText!,
        assistantText: assistantText!,
      });
    }
    console.log(`retain 排队耗时：${Date.now() - started}ms`);
    expect(statuses.at(-1)?.[0]).toBe("online");

    const deadline = Date.now() + INGEST_TIMEOUT_MS;
    let found = 0;
    while (Date.now() < deadline) {
      const { results } = await client.recall(BANK, "花生过敏");
      found = results.length;
      if (results.some((result) => result.text.includes("花生"))) break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    console.log(`写入到可查询：${Date.now() - started}ms，结果数 ${found}`);
    expect(found).toBeGreaterThan(0);
  }, INGEST_TIMEOUT_MS + 30_000);

  it("stores facts in Chinese", async () => {
    const { results } = await client.recall(BANK, "咖啡");

    console.log("提取到的事实：");
    for (const result of results) console.log(`  [${result.type}] ${result.text}`);
    expect(results.some((result) => /[一-鿿]/.test(result.text))).toBe(true);
  });

  it("finds Chinese memories however they are asked for", async () => {
    let hits = 0;
    for (const [kind, query, expected] of QUERIES) {
      const started = Date.now();
      const results = await memory.recall(query);
      const elapsed = Date.now() - started;
      const rank = results.findIndex((result) => result.text.includes(expected));
      if (rank >= 0) hits++;
      console.log(
        `${rank >= 0 ? "命中" : "未中"} [${kind}] ${query} -> 第 ${rank + 1} 条，共 ${results.length} 条，${elapsed}ms`,
      );
    }
    console.log(`命中率：${hits}/${QUERIES.length}`);
    expect(hits).toBeGreaterThanOrEqual(QUERIES.length - 2);
  }, 120_000);

  it("recalls within the timeout the app uses", async () => {
    const started = Date.now();
    const results = await memory.recall("我对什么过敏？");

    console.log(`完整 recall 耗时：${Date.now() - started}ms，状态：${statuses.at(-1)?.[0]}`);
    expect(results.length).toBeGreaterThan(0);
    expect(statuses.at(-1)?.[0]).toBe("online");
  });

  it("injects little or nothing for unrelated messages", async () => {
    for (const query of ["你好", "谢谢", "今天天气怎么样？", "帮我写一首关于月亮的诗", "解释一下量子计算"]) {
      const results = await memory.recall(query);
      console.log(`无关「${query}」-> ${results.length} 条`);
      expect(results.length).toBeLessThanOrEqual(5);
    }
    await expect(memory.recall("今天天气怎么样？")).resolves.toEqual([]);
  });

  it("still lets the model look up weak matches on purpose", async () => {
    await expect(memory.search("今天天气怎么样？")).resolves.not.toEqual([]);
  });

  it("finds the user's profile for new sessions", async () => {
    const profile = await memory.recallProfile();

    console.log(`用户画像：${profile.length} 条`);
    expect(profile.length).toBeGreaterThan(0);
  });
});
