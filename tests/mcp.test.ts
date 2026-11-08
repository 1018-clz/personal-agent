import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { causeFromLog, contentText, McpClient, reportsFailure, type McpServerSpec } from "../src/main/mcp/client";
import { describeArgs, McpHub, mcpToolName, type McpServerConfig } from "../src/main/mcp/hub";
import { parseRule, suggestRule } from "../src/main/permissions/rules";
import type { ToolServerStatus } from "../src/shared/types";

const FAKE: McpServerSpec = {
  name: "fake",
  command: process.execPath,
  args: [resolve(__dirname, "fixtures", "fake-mcp-server.mjs")],
  startupTimeoutMs: 10_000,
  callTimeoutMs: 1_000,
};
const SIGNAL = new AbortController().signal;

const clients: McpClient[] = [];
const hubs: McpHub[] = [];

function client(spec: Partial<McpServerSpec> = {}) {
  const created = new McpClient({ ...FAKE, ...spec });
  clients.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all([...clients.splice(0).map((c) => c.stop()), ...hubs.splice(0).map((h) => h.stop())]);
});

describe("McpClient", () => {
  it("shakes hands, reads the instructions and every page of tools, skipping stray output", async () => {
    const info = await client().start();

    expect(info.instructions).toBe("先调用 echo。");
    expect(info.tools.map((tool) => tool.name)).toEqual(["echo", "fail", "soft_fail", "hang", "crash", "peek", "opaque"]);
  });

  it("returns a tool's text and names what is not text", async () => {
    const c = client();
    await c.start();

    await expect(c.callTool("echo", { text: "你好" })).resolves.toBe("echo:你好\n[非文本内容：image]");
  });

  it("turns a reported failure into a failed call, with the tool's own message", async () => {
    const c = client();
    await c.start();

    await expect(c.callTool("fail", {})).rejects.toThrow("参数不对：缺少 f0_ghz");
    // isError is false here, but the payload says it failed: it must not pass as a result.
    await expect(c.callTool("soft_fail", {})).rejects.toThrow("出图失败");
  });

  it("adds the cause the server only logged to a bare failure", async () => {
    const c = client();
    await c.start();

    // The Python SDK answers an unexpected exception with this sentence alone; the model then guesses.
    await expect(c.callTool("opaque", {})).rejects.toThrow(
      /Error executing tool opaque\n服务端日志：FileNotFoundError: \[WinError 3\] 找不到路径: snapshots/,
    );
  });

  it("gives up on a call that never answers, and tells the server", async () => {
    const c = client();
    await c.start();

    await expect(c.callTool("hang", {})).rejects.toThrow(/超过 1 秒没有回应/);
    expect(await c.callTool("peek", {})).toContain('"cancelled":[');
    expect(JSON.parse(await c.callTool("peek", {})).cancelled).toHaveLength(1);
  });

  it("cancels a call when the turn is stopped", async () => {
    const c = client({ callTimeoutMs: 10_000 });
    await c.start();
    const controller = new AbortController();

    const call = c.callTool("hang", {}, controller.signal);
    controller.abort();

    await expect(call).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails waiting calls at once when the server dies, with what it printed", async () => {
    const c = client();
    await c.start();

    await expect(c.callTool("crash", {})).rejects.toThrow(/退出码 3[\s\S]*模拟的崩溃/);
    expect(c.alive).toBe(false);
    await expect(c.callTool("echo", { text: "x" })).rejects.toThrow(/不可用/);
  });

  it("explains a server that cannot start", async () => {
    await expect(client({ command: join(__dirname, "没有这个程序.exe") }).start()).rejects.toThrow(/fake/);
  });

  it("reads failure payloads strictly", () => {
    expect(reportsFailure('{"ok": false}')).toBe(true);
    expect(reportsFailure('{"ok": true}')).toBe(false);
    expect(reportsFailure("ok: false")).toBe(false);
    expect(reportsFailure("{broken")).toBe(false);
    expect(contentText({ structuredContent: { a: 1 } })).toBe('{"a":1}');
  });

  it("finds the exception in a server's log, not the SDK's wrapper", () => {
    expect(
      causeFromLog([
        "Traceback (most recent call last):",
        '  File "x.py", line 1',
        "FileNotFoundError: [WinError 3] 系统找不到指定的路径。",
        "mcp.server.mcpserver.exceptions.UnexpectedToolError: Error executing tool inspect_project",
      ]),
    ).toBe("FileNotFoundError: [WinError 3] 系统找不到指定的路径。");
    expect(causeFromLog(["starting", "disk full", "bye"])).toBe("starting\ndisk full\nbye");
  });
});

describe("McpHub", () => {
  const config = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
    ...FAKE,
    label: "Fake",
    readOnlyTools: ["echo"],
    extraInstructions: "结果要注明来源。",
    ...extra,
  });

  function hub(configs: McpServerConfig[]) {
    const statuses: ToolServerStatus[][] = [];
    const created = new McpHub(configs, (servers) => statuses.push(servers));
    hubs.push(created);
    return { hub: created, statuses };
  }

  it("offers the tools under the server's name and asks only for the ones that change things", async () => {
    const { hub: h, statuses } = hub([config()]);
    await h.start();

    const tools = h.tools();
    expect(tools.map((tool) => tool.definition.name)).toContain("fake__echo");
    const byName = (name: string) => tools.find((tool) => tool.definition.name === name)!;
    expect(await byName("fake__echo").describePermission({ text: "x" })).toBeNull();
    expect(await byName("fake__peek").describePermission({})).toBeNull(); // readOnlyHint
    expect(await byName("fake__fail").describePermission({ a: 1 })).toMatchObject({ title: "Fake：fail" });
    expect(byName("fake__echo").definition.description).toBe("[Fake] 回显");
    expect(byName("fake__echo").summarize?.({ text: "x" })).toBe("text: x");
    await expect(byName("fake__echo").run({ text: "1" }, SIGNAL)).resolves.toContain("echo:1");
    expect(statuses.at(-1)).toEqual([{ name: "fake", label: "Fake", state: "ready", toolCount: 7 }]);
  });

  it("puts the server's instructions and the app's together", async () => {
    const { hub: h } = hub([config()]);
    await h.start();

    expect(h.instructions()).toEqual([{ label: "Fake", text: "先调用 echo。\n\n结果要注明来源。" }]);
  });

  it("restarts a crashed server once, on the next call", async () => {
    const { hub: h } = hub([config()]);
    await h.start();
    const tools = h.tools();
    const run = (name: string) => tools.find((tool) => tool.definition.name === name)!.run({ text: "again" }, SIGNAL);

    await expect(run("fake__crash")).rejects.toThrow(/模拟的崩溃/);
    await expect(run("fake__echo")).resolves.toContain("echo:again");
    await expect(run("fake__crash")).rejects.toThrow();
    await expect(run("fake__echo")).rejects.toThrow(/重启过一次/);
  });

  it("reports a server that is not installed, and still starts the others", async () => {
    const { hub: h, statuses } = hub([
      config({ name: "missing", label: "HFSS", unavailable: "HFSS 工具未安装" }),
      config(),
    ]);
    await h.start();

    expect(statuses.at(-1)).toEqual([
      { name: "missing", label: "HFSS", state: "failed", message: "HFSS 工具未安装", toolCount: 0 },
      { name: "fake", label: "Fake", state: "ready", toolCount: 7 },
    ]);
    expect(h.tools().every((tool) => tool.definition.name.startsWith("fake__"))).toBe(true);
  });

  it("keeps the app's own tools from the model, and lets the app call them", async () => {
    const { hub: h } = hub([config({ appOnlyTools: ["peek"] })]);
    await h.start();

    expect(h.tools().map((tool) => tool.definition.name)).not.toContain("fake__peek");
    expect(h.isReady("fake")).toBe(true);
    await expect(h.callTool("fake", "peek", {})).resolves.toContain("cancelled");
    await expect(h.callTool("nope", "peek", {})).rejects.toThrow(/没有工具服务/);
  });

  it("asks again whether a server can start, so installing it and restarting works", async () => {
    let installed = false;
    const { hub: h, statuses } = hub([config({ unavailable: () => (installed ? undefined : "还没装") })]);
    await h.start();
    expect(statuses.at(-1)?.[0]).toMatchObject({ state: "failed", message: "还没装" });
    expect(h.isReady("fake")).toBe(false);

    installed = true;
    await h.restart("fake");

    expect(statuses.at(-1)?.[0]).toMatchObject({ state: "ready", toolCount: 7 });
    expect(h.tools().length).toBe(7);
  });

  it("reads the app's instructions afresh, so a changed preference reaches the next prompt", async () => {
    let mode = "一";
    const { hub: h } = hub([config({ extraInstructions: () => `模式${mode}` })]);
    await h.start();

    expect(h.instructions()[0]?.text).toContain("模式一");
    mode = "二";
    expect(h.instructions()[0]?.text).toContain("模式二");
  });

  it("shows arguments the way people read them", () => {
    const args = { project: "D:\\work\\a.aedt", design: "FILTER", far_field: false, variables: { g: "5mm" }, n: 1, s: "1" };

    expect(describeArgs(args, " · ")).toBe(
      'project: D:\\work\\a.aedt · design: FILTER · far_field: false · variables: {"g":"5mm"} · n: 1 · s: 1',
    );
    expect(describeArgs({ a: "x", b: undefined }, "\n")).toBe("a: x");
  });

  it("makes names every model API accepts", () => {
    expect(mcpToolName("hfss", "run_project")).toBe("hfss__run_project");
    expect(mcpToolName("my server", "do.it")).toBe("my_server__do_it");
    expect(mcpToolName("s", "x".repeat(100))).toHaveLength(64);
  });
});

describe("permission rules for MCP tools", () => {
  it("accepts rules for tools that only exist once their server starts", () => {
    expect(parseRule("hfss__submit_simulation", ["read_file"])).toEqual({
      text: "hfss__submit_simulation",
      tool: "hfss__submit_simulation",
    });
    expect(() => parseRule("hfss_submit", ["read_file"])).toThrow(/不存在/);
    expect(() => parseRule("hfss__run_project(x)", ["read_file"])).toThrow(/可以带模式/);
  });

  it("offers to remember the whole tool", () => {
    expect(suggestRule("hfss__run_project", { project: "a.aedt" }, "W:\\work")).toBe("hfss__run_project");
  });
});

// The real HFSS tool server, without starting AEDT: it must come up from its own environment,
// describe its tools, and pass its errors through. Skipped until npm run install-hfss has run.
const HFSS_PYTHON = resolve(__dirname, "..", ".hfss", "env", "Scripts", "python.exe");
describe.skipIf(!existsSync(HFSS_PYTHON))("the bundled HFSS server", () => {
  it("starts, lists its tools and passes its errors through", async () => {
    const dataDir = join(tmpdir(), `hfss-agent-test-${process.pid}`);
    const c = client({
      name: "hfss",
      command: HFSS_PYTHON,
      args: ["-m", "hfss_agent.server"],
      cwd: resolve(__dirname, "..", "hfss"),
      env: { ...process.env, HFSS_AGENT_DATA: dataDir, PYTHONIOENCODING: "utf-8" },
      startupTimeoutMs: 60_000,
      callTimeoutMs: 30_000,
    });

    const info = await c.start();
    expect(info.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_job",
      "check_setup",
      "compare_jobs",
      "get_job",
      "inspect_project",
      "job_curves",
      "list_jobs",
      "list_recipes",
      "run_project",
      "submit_simulation",
      "sweep_project",
      "sweep_recipe",
    ]);
    expect(info.instructions).toContain("eigenmode");

    const recipes = JSON.parse(await c.callTool("list_recipes", {}));
    expect(recipes.recipes[0].name).toBe("dr_filter");
    await expect(c.callTool("submit_simulation", { recipe: "dr_filter", analysis: "driven" })).rejects.toThrow(
      /必须给 f0_ghz/,
    );
    await expect(c.callTool("get_job", { job_id: "不存在" })).rejects.toThrow(/没有任务/);
    await c.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});
