// Drives the real agent against the real DeepSeek API, with real tools in the real sandbox.
// Run with `npm run test:live`. The key comes from config.json and is never printed.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Agent, type AgentUpdate } from "../../src/main/agent/agent";
import { OpenAICompatibleClient } from "../../src/main/agent/openai-client";
import type { ModelClient } from "../../src/main/agent/model";
import { buildSystemPrompt } from "../../src/main/agent/system-prompt";
import { createTools } from "../../src/main/agent/tools";
import { loadConfig } from "../../src/main/config";
import { MEMORY_RULES } from "../../src/main/memory-prompt";
import { SandboxedShell } from "../../src/main/sandbox/shell";
import { SessionStore } from "../../src/main/session-store";
import type { TurnView } from "../../src/shared/types";

const SIGNAL = new AbortController().signal;

let root: string;
let workspace: string;
let model: ModelClient;

async function createSession(permission: boolean = true) {
  const updates: AgentUpdate[] = [];
  const permissions: string[] = [];
  const tools = createTools({
    workspaceDir: workspace,
    shell: new SandboxedShell(workspace, false, join(root, "cache"), process.env),
    searchMemory: async () => ["用户最喜欢的颜色是青色"],
  });
  const agent = new Agent(model, tools, {
    onUpdate: (update) => updates.push(update),
    requestPermission: async ({ need }) => {
      // Read-only tools never asked the user, so they are not refused here either.
      if (!need) return true;
      permissions.push(need.title);
      return permission;
    },
  });
  agent.newSession(
    buildSystemPrompt({ workspaceDir: workspace, memoryRules: MEMORY_RULES, now: new Date() }),
  );

  const reply = () =>
    updates.flatMap((update) => (update.kind === "message" ? [update.text] : [])).join("");
  const toolsUsed = () =>
    updates.flatMap((update) => (update.kind === "tool-call" ? [update.title] : []));
  const thought = () => updates.some((update) => update.kind === "thought");
  return { agent, updates, permissions, reply, toolsUsed, thought };
}

describe("real DeepSeek", () => {
  beforeAll(async () => {
    const config = await loadConfig({
      userDataDir: join(process.env.APPDATA ?? "", "personal-agent"),
      homeDir: homedir(),
      env: process.env,
    });
    // The app's key is encrypted for Electron; tests outside it use DEEPSEEK_API_KEY or set-key.
    const { legacyApiKey: apiKey, baseUrl, model: name } = config.model;
    if (!apiKey) throw new Error("未找到 API Key：请设置环境变量 DEEPSEEK_API_KEY，或运行 npm run set-key");
    model = new OpenAICompatibleClient({ apiKey, baseUrl, model: name, label: "DeepSeek", thinkingToggle: true });
    console.log(`模型：${name}`);

    root = mkdtempSync(join(homedir(), ".agent-live-test-"));
    workspace = join(root, "workspace");
    mkdirSync(workspace);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("streams a plain reply", async () => {
    const session = await createSession();

    const stopReason = await session.agent.runTurn("用一句话介绍你自己。", SIGNAL);

    console.log(`回复：${session.reply()}`);
    expect(stopReason).toBe("end_turn");
    expect(session.reply().length).toBeGreaterThan(0);
  });

  it("uses tools, and later turns survive the reasoning_content rule", async () => {
    const session = await createSession();

    await session.agent.runTurn(
      "用 write_file 创建 hello.txt，内容是 你好沙箱，然后用 read_file 读回来确认。",
      SIGNAL,
    );

    console.log(`工具：${session.toolsUsed().join(", ")}；思考：${session.thought()}`);
    console.log(`回复：${session.reply()}`);
    expect(session.toolsUsed()).toEqual(expect.arrayContaining(["write_file", "read_file"]));
    expect(readFileSync(join(workspace, "hello.txt"), "utf8")).toContain("你好沙箱");

    // DeepSeek answers 400 here if reasoning_content from the tool turns was not sent back.
    const stopReason = await session.agent.runTurn("刚才文件名是什么？只回答文件名。", SIGNAL);

    console.log(`第二轮回复：${session.reply()}`);
    expect(stopReason).toBe("end_turn");
    expect(session.reply()).toContain("hello.txt");
  });

  it("resumes a saved session after a restart, tool history and reasoning_content included", async () => {
    const store = new SessionStore(join(root, "sessions"));
    const sessionId = randomUUID();
    const turn = (userText: string): TurnView => ({
      id: randomUUID(),
      userText,
      memories: [],
      thought: "",
      reply: "",
      tools: [],
      state: "done",
    });

    const first = await createSession();
    const question = "用 write_file 创建 resume.txt，内容是 暗号蓝鲸，然后告诉我写好了。";
    await first.agent.runTurn(question, SIGNAL);
    await store.appendTurn(sessionId, turn(question), first.agent.takeUnsavedHistory());

    const { history } = await store.load(sessionId);
    const reasoning = history.filter((message) => message.role === "assistant" && message.reasoningContent);
    console.log(`恢复的消息：${history.length} 条，其中带思考内容 ${reasoning.length} 条`);
    expect(history.some((message) => message.role === "tool")).toBe(true);

    // A new agent, as after a restart, knows this only through the restored history.
    const second = await createSession();
    second.agent.resumeSession(
      buildSystemPrompt({ workspaceDir: workspace, memoryRules: MEMORY_RULES, now: new Date() }),
      history,
      null,
    );
    const stopReason = await second.agent.runTurn("刚才文件里的暗号是什么？只回答暗号，不要调用工具。", SIGNAL);

    console.log(`恢复后回复：${second.reply()}`);
    expect(stopReason).toBe("end_turn");
    expect(second.reply()).toContain("蓝鲸");
  });

  it("runs a command in the sandbox and reads the result", async () => {
    const session = await createSession();

    await session.agent.runTurn(
      "用 run_command 运行 PowerShell 命令计算 21*2，并告诉我结果。",
      SIGNAL,
    );

    console.log(`权限请求：${session.permissions.join(" | ")}`);
    console.log(`回复：${session.reply()}`);
    expect(session.toolsUsed()).toContain("run_command");
    expect(session.permissions[0]).toContain("沙箱");
    expect(session.reply()).toContain("42");
  });

  it("carries on when the user rejects a tool", async () => {
    const session = await createSession(false);

    const stopReason = await session.agent.runTurn(
      "用 write_file 创建 rejected.txt，内容随意。如果被拒绝，就告诉我被拒绝了，不要重试。",
      SIGNAL,
    );

    console.log(`回复：${session.reply()}`);
    expect(stopReason).toBe("end_turn");
    expect(existsSync(join(workspace, "rejected.txt"))).toBe(false);
  });

  it("searches memory when asked", async () => {
    const session = await createSession();

    await session.agent.runTurn("用 memory_search 查一下我最喜欢的颜色。", SIGNAL);

    console.log(`回复：${session.reply()}`);
    expect(session.toolsUsed()).toContain("memory_search");
    expect(session.reply()).toContain("青色");
  });
});
