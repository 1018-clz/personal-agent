// A small MCP server over stdio for the client tests. Its tools misbehave on purpose.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const tools = [
  { name: "echo", description: "回显", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "fail", description: "报错", inputSchema: { type: "object", properties: {} } },
  { name: "soft_fail", description: "返回 ok:false", inputSchema: { type: "object", properties: {} } },
  { name: "hang", description: "不回应", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "退出", inputSchema: { type: "object", properties: {} } },
  { name: "peek", description: "只读", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "opaque", description: "只在日志里说原因", inputSchema: { type: "object", properties: {} } },
];
const cancelled = [];

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === "initialize") {
    // A stray print, as a careless server might make: the client must skip it.
    process.stdout.write("debug: starting up\n");
    send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake" }, instructions: "先调用 echo。" } });
    // A request from the server: the client must answer ping.
    send({ id: "srv-1", method: "ping" });
  } else if (method === "tools/list") {
    // Two pages, to exercise nextCursor.
    if (!params?.cursor) send({ id, result: { tools: tools.slice(0, 3), nextCursor: "p2" } });
    else send({ id, result: { tools: tools.slice(3) } });
  } else if (method === "notifications/cancelled") {
    cancelled.push(params.requestId);
  } else if (method === "tools/call") {
    const { name, arguments: args } = params;
    if (name === "echo") send({ id, result: { content: [{ type: "text", text: `echo:${args.text}` }, { type: "image", data: "" }] } });
    else if (name === "fail") send({ id, result: { content: [{ type: "text", text: "参数不对：缺少 f0_ghz" }], isError: true } });
    else if (name === "soft_fail") send({ id, result: { content: [{ type: "text", text: '{"ok": false, "error": "出图失败"}' }] } });
    else if (name === "opaque") {
      // What the Python SDK does with an unexpected exception: the cause goes to the log only.
      process.stderr.write("Traceback (most recent call last):\nFileNotFoundError: [WinError 3] 找不到路径: snapshots\n");
      process.stderr.write("mcp.server.exceptions.UnexpectedToolError: Error executing tool opaque\n");
      send({ id, result: { content: [{ type: "text", text: "Error executing tool opaque" }], isError: true } });
    } else if (name === "peek") send({ id, result: { content: [{ type: "text", text: JSON.stringify({ cancelled }) }] } });
    else if (name === "crash") {
      process.stderr.write("Traceback: 模拟的崩溃\n");
      process.exit(3);
    }
    // hang: never answers
  } else if (id === "srv-1" || (id === undefined && message.result)) {
    // the answer to our ping
    if (message.result) process.stderr.write("got pong\n");
  }
});
