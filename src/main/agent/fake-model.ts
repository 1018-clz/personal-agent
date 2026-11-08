// A scripted model for `npm run dev:fake`, so the app runs without a DeepSeek key.
// Everything around it (the agent loop, tools, permissions) stays real.
//   tool    -> asks to write fake-note.txt, which needs permission
//   command -> asks to run a command in the sandbox, which needs permission
//   edit    -> asks to edit fake-note.txt (send "tool" first), which shows a diff
//   search  -> searches the workspace for 模拟, which runs without asking
//   slow    -> streams slowly so a turn can be cancelled
//   fail    -> the request fails
import { setTimeout as sleep } from "node:timers/promises";

import type { Completion, CompletionHandlers, CompletionRequest, ModelClient } from "./model";

export class FakeModel implements ModelClient {
  async complete(
    { messages, tools }: CompletionRequest,
    handlers: CompletionHandlers,
    signal: AbortSignal,
  ): Promise<Completion> {
    if (tools.length === 0) {
      const content = "模拟摘要：用户此前的对话已被压缩。";
      return { content, reasoningContent: "", toolCalls: [], finishReason: "stop" };
    }

    const last = messages.at(-1);
    const user = messages.findLast((message) => message.role === "user");
    const text = user?.content ?? "";
    if (text.includes("fail")) throw new Error("模拟的请求失败");

    const reasoningContent = "这是模拟模型的思考。";
    handlers.onThought(reasoningContent);

    if (text.includes("tool") && last?.role === "user") {
      return {
        content: "",
        reasoningContent,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_1",
            name: "write_file",
            arguments: JSON.stringify({ path: "fake-note.txt", content: "模拟写入" }),
          },
        ],
      };
    }

    if (text.includes("command") && last?.role === "user") {
      return {
        content: "",
        reasoningContent,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_2",
            name: "run_command",
            arguments: JSON.stringify({
              command: "\"key=[$env:DEEPSEEK_API_KEY]\"; Get-ChildItem | ForEach-Object Name",
            }),
          },
        ],
      };
    }

    if (text.includes("edit") && last?.role === "user") {
      return {
        content: "",
        reasoningContent,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_3",
            name: "edit_file",
            arguments: JSON.stringify({
              path: "fake-note.txt",
              old_string: "模拟写入",
              new_string: "模拟修改",
            }),
          },
        ],
      };
    }

    if (text.includes("search") && last?.role === "user") {
      return {
        content: "",
        reasoningContent,
        finishReason: "tool_calls",
        toolCalls: [{ id: "call_4", name: "search_files", arguments: JSON.stringify({ query: "模拟" }) }],
      };
    }

    const toolNote = last?.role === "tool" ? `工具结果：${last.content}。` : "";
    const system = messages[0]?.role === "system" ? messages[0].content : "";
    const content =
      `${toolNote}收到（模拟回复）。本轮记忆注入：${text.includes("<memory_context>") ? "有" : "无"}；` +
      `系统提示：${system.includes("memory_context") ? "有" : "无"}。`;

    for (const char of content) {
      signal.throwIfAborted();
      handlers.onText(char);
      await sleep(text.includes("slow") ? 200 : 5);
    }
    return { content, reasoningContent, toolCalls: [], finishReason: "stop" };
  }
}
