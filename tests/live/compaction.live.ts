// Drives real compaction against the real DeepSeek API, with a tiny threshold so it happens
// quickly. Facts are planted early, then asked for after the turns holding them are gone.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Agent, type AgentUpdate } from "../../src/main/agent/agent";
import type { CompactionPolicy } from "../../src/main/agent/compaction";
import { OpenAICompatibleClient } from "../../src/main/agent/openai-client";
import type { ChatMessage, Completion, CompletionRequest, ModelClient } from "../../src/main/agent/model";
import { buildSystemPrompt } from "../../src/main/agent/system-prompt";
import { createTools } from "../../src/main/agent/tools";
import { loadConfig } from "../../src/main/config";
import { MEMORY_RULES } from "../../src/main/memory-prompt";
import { SessionStore } from "../../src/main/session-store";
import type { TurnView } from "../../src/shared/types";

const SIGNAL = new AbortController().signal;
const POLICY: CompactionPolicy = { triggerTokens: 4_000, midTurnTokens: 12_000, tailTokens: 800 };

let root: string;
let workspace: string;
let client: OpenAICompatibleClient;

/** Records what the API says about each request, on top of the real client. */
function measuring(promptTokens: number[]): ModelClient {
  return {
    complete: async (request: CompletionRequest, handlers, signal): Promise<Completion> => {
      const completion = await client.complete(request, handlers, signal);
      if (request.tools.length > 0 && completion.usage) promptTokens.push(completion.usage.promptTokens);
      return completion;
    },
  };
}

function createAgent(policy: CompactionPolicy = POLICY) {
  const updates: AgentUpdate[] = [];
  const promptTokens: number[] = [];
  const tools = createTools({
    workspaceDir: workspace,
    shell: { description: "不可用", run: async () => "" },
    searchMemory: async () => [],
  });
  const agent = new Agent(
    measuring(promptTokens),
    tools,
    { onUpdate: (update) => updates.push(update), requestPermission: async () => true },
    policy,
  );
  const system = buildSystemPrompt({ workspaceDir: workspace, memoryRules: MEMORY_RULES, now: new Date() });
  agent.newSession(system);

  const compactions = () => updates.filter((update) => update.kind === "compaction" && update.status === "done");
  const replyFrom = (start: number) =>
    updates
      .slice(start)
      .flatMap((update) => (update.kind === "message" ? [update.text] : []))
      .join("");
  return { agent, updates, promptTokens, compactions, replyFrom, system };
}

const FACTS: Array<[plant: string, question: string, answer: string]> = [
  ["我的项目代号是青石计划。", "我的项目代号是什么？", "青石"],
  ["以后代码注释一律用英文，这是我的硬性要求。", "我对代码注释的语言有什么要求？", "英文"],
  ["配置文件放在 D:\\configs\\prod.toml，别动别的位置。", "配置文件的完整路径是什么？", "prod.toml"],
];

describe("real compaction", () => {
  beforeAll(async () => {
    const { model } = await loadConfig({
      userDataDir: join(process.env.APPDATA ?? "", "personal-agent"),
      homeDir: homedir(),
      env: process.env,
    });
    // The app's key is encrypted for Electron; tests outside it use DEEPSEEK_API_KEY or set-key.
    if (!model.legacyApiKey) throw new Error("未找到 API Key：请设置环境变量 DEEPSEEK_API_KEY，或运行 npm run set-key");
    client = new OpenAICompatibleClient({
      apiKey: model.legacyApiKey,
      baseUrl: model.baseUrl,
      model: model.model,
      label: "DeepSeek",
      thinkingToggle: true,
    });

    root = mkdtempSync(join(homedir(), ".agent-compaction-test-"));
    workspace = join(root, "workspace");
    mkdirSync(workspace);
    for (const name of ["a", "b", "c"]) {
      writeFileSync(join(workspace, `${name}.txt`), `这是填充用的文件 ${name}。今天的天气很好，适合散步。`.repeat(90));
    }
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("accepts the shapes compaction can produce", async () => {
    const handlers = { onText: () => {}, onThought: () => {} };
    const shapes: Record<string, ChatMessage[]> = {
      "assistant right after system": [
        { role: "system", content: "你是助手。" },
        { role: "assistant", content: "之前的回答。" },
        { role: "user", content: "回答：好" },
      ],
      "tool call right after system": [
        { role: "system", content: "你是助手。" },
        {
          role: "assistant",
          content: null,
          reasoningContent: "需要读文件",
          toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' }],
        },
        { role: "tool", toolCallId: "call_1", content: "文件内容" },
        { role: "user", content: "回答：好" },
      ],
    };
    const tools = [{ name: "read_file", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } }];

    for (const [name, messages] of Object.entries(shapes)) {
      const completion = await client.complete({ messages, tools }, handlers, SIGNAL);
      console.log(`${name}: ${completion.finishReason}`);
      expect(completion.finishReason).not.toBe("length");
    }
  });

  it("keeps early facts after the turns holding them are compacted away", async () => {
    const { agent, updates, promptTokens, compactions, replyFrom } = createAgent();

    for (const [plant] of FACTS) await agent.runTurn(plant, SIGNAL);
    for (const name of ["a", "b", "c"]) {
      await agent.runTurn(`用 read_file 读 ${name}.txt，只回答“读完了”。`, SIGNAL);
    }
    await agent.runTurn("好的，继续。", SIGNAL);

    console.log(`压缩次数：${compactions().length}；每次请求的 prompt_tokens：${promptTokens.join(", ")}`);
    console.log(`压缩记录：${JSON.stringify(compactions())}`);
    expect(compactions().length).toBeGreaterThan(0);

    const drops = promptTokens.filter((tokens, index) => index > 0 && tokens < promptTokens[index - 1]!);
    expect(drops.length).toBeGreaterThan(0);

    let remembered = 0;
    for (const [, question, answer] of FACTS) {
      const start = updates.length;
      await agent.runTurn(`${question}不要调用工具，只回答内容。`, SIGNAL);
      const reply = replyFrom(start);
      if (reply.includes(answer)) remembered++;
      console.log(`${reply.includes(answer) ? "记得" : "忘了"}：${question} -> ${reply.slice(0, 50)}`);
    }
    console.log(`压缩后记住：${remembered}/${FACTS.length}`);
    expect(remembered).toBe(FACTS.length);
  });

  it("reads three files in one turn without thrashing at the normal limit", async () => {
    const { agent, compactions, promptTokens } = createAgent();

    await agent.runTurn("依次用 read_file 读 a.txt、b.txt、c.txt，一次只读一个。全部读完后，回答“读完了”。", SIGNAL);

    console.log(`普通阈值：压缩 ${compactions().length} 次，模型调用 ${promptTokens.length} 次`);
    expect(compactions()).toEqual([]);
    expect(promptTokens.length).toBeLessThanOrEqual(5);
  });

  it("compacts in the middle of one turn and still finishes the task", async () => {
    const { agent, compactions, replyFrom, promptTokens } = createAgent({
      triggerTokens: 1_000,
      midTurnTokens: 3_500,
      tailTokens: 800,
    });

    const stopReason = await agent.runTurn(
      "依次用 read_file 读 a.txt、b.txt、c.txt，一次只读一个。全部读完后，回答“三个文件都读完了”。",
      SIGNAL,
    );

    console.log(`一轮内压缩：${compactions().length} 次；模型调用 ${promptTokens.length} 次；prompt_tokens：${promptTokens.join(", ")}`);
    console.log(`回复：${replyFrom(0).slice(0, 80)}`);
    expect(stopReason).toBe("end_turn");
    expect(compactions().length).toBeGreaterThan(0);
    expect(compactions().length).toBeLessThanOrEqual(2);
    expect(promptTokens.length).toBeLessThanOrEqual(10);
    expect(replyFrom(0)).toContain("读完");
  });

  it("resumes a compacted session after a restart", async () => {
    const store = new SessionStore(join(root, "sessions"));
    const sessionId = randomUUID();
    const first = createAgent({ triggerTokens: 2_000, midTurnTokens: 12_000, tailTokens: 800 });
    const turn = (userText: string): TurnView => ({
      id: randomUUID(),
      userText,
      memories: [],
      thought: "",
      reply: "",
      tools: [],
      state: "done",
    });

    const script = [FACTS[0]![0], "用 read_file 读 a.txt，只回答“读完了”。", "用 read_file 读 b.txt，只回答“读完了”。", "用 read_file 读 c.txt，只回答“读完了”。"];
    for (const text of script) {
      await first.agent.runTurn(text, SIGNAL);
      await store.appendTurn(sessionId, turn(text), first.agent.takeUnsavedHistory());
    }

    const { history, contextSummary } = await store.load(sessionId);
    console.log(`恢复：摘要 ${contextSummary?.length ?? 0} 字，尾部 ${history.length} 条消息`);
    expect(contextSummary).not.toBeNull();

    const second = createAgent();
    second.agent.resumeSession(second.system, history, contextSummary);
    const stopReason = await second.agent.runTurn("我的项目代号是什么？不要调用工具，只回答代号。", SIGNAL);

    console.log(`恢复后回复：${second.replyFrom(0)}`);
    expect(stopReason).toBe("end_turn");
    expect(second.replyFrom(0)).toContain("青石");
  });
});
