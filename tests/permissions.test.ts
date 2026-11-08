import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PermissionRequest } from "../src/main/agent/agent";
import type { UserDecision } from "../src/main/permission-broker";
import { isReadOnlyCommand, isSingleCommand } from "../src/main/permissions/command";
import { PermissionGate, type PermissionGateOptions } from "../src/main/permissions/gate";
import { matchesRule, parseRule, suggestRule, workspacePath } from "../src/main/permissions/rules";

const TOOLS = ["list_directory", "read_file", "write_file", "edit_file", "search_files", "run_command", "memory_search"];
const WORKSPACE = join(tmpdir(), "agent-workspace");
const SIGNAL = new AbortController().signal;

describe("isReadOnlyCommand", () => {
  it.each([
    "Get-ChildItem",
    "ls -Recurse",
    "Get-Content notes.md",
    "Get-Content 'my notes.md' | Select-String TODO",
    "Get-ChildItem -Recurse -Filter *.md | Measure-Object",
    "Get-ChildItem | Where-Object Length -gt 100 | Sort-Object Length; pwd",
    'Select-String -Path "a b.txt" -Pattern "x;y"',
  ])("runs %s without asking", (command) => {
    expect(isReadOnlyCommand(command)).toBe(true);
  });

  it.each([
    ["a writing cmdlet", "Remove-Item notes.md"],
    ["a writer later in a pipeline", "Get-ChildItem | Remove-Item"],
    ["a writer after a semicolon", "Get-ChildItem; Remove-Item x"],
    ["a writer on the next line", "Get-ChildItem\nRemove-Item x"],
    ["output redirection", "Get-Content a > b"],
    ["a subexpression", "Get-Content $(Remove-Item x)"],
    ["parentheses", "Get-Content (Remove-Item x)"],
    ["a script block", "Get-ChildItem | Where-Object { Remove-Item $_ }"],
    ["a call operator", "& Remove-Item x"],
    ["a variable", "Get-Content $env:USERPROFILE"],
    ["a variable in double quotes", 'Get-Content "$(Remove-Item x)"'],
    ["a backtick escape", "Get-Content a`; Remove-Item x"],
    ["a type literal", "[IO.File]::Delete('x')"],
    ["ForEach-Object", "Get-ChildItem | % Delete"],
    ["stop parsing", "Get-ChildItem --% ; Remove-Item x"],
    ["a comment that hides a quote", "Get-ChildItem # '\nRemove-Item x '"],
    ["curly quotes", "Get-Content 'a\u2019; Remove-Item x; \u2018'"],
    ["the registry", "Get-ChildItem HKCU:\\Environment"],
    ["the registry in quotes", "Get-ChildItem 'HKCU:\\Environment'"],
    ["an absolute path", "Get-Content C:\\Users\\me\\secret.txt"],
    ["the home directory", "Get-Content ~\\.ssh\\id_rsa"],
    ["a network path", "Get-ChildItem \\\\server\\share"],
    ["an unterminated quote", "Get-Content 'a"],
    ["a quoted command name", "'Get-Content' x"],
    ["an empty command", "  "],
  ])("asks for %s", (_name, command) => {
    expect(isReadOnlyCommand(command)).toBe(false);
  });
});

describe("isSingleCommand", () => {
  it("accepts one command with quoted arguments", () => {
    expect(isSingleCommand("git commit -m 'fix: a; b | c (d)'")).toBe(true);
  });

  it("rejects statements, pipelines and anything that can run code", () => {
    for (const command of ["git status; Remove-Item x", "git log | Out-File x", "git status $(x)", "git status > x"]) {
      expect(isSingleCommand(command)).toBe(false);
    }
  });
});

describe("parseRule", () => {
  it("reads a tool name with or without a pattern", () => {
    expect(parseRule("run_command", TOOLS)).toEqual({ text: "run_command", tool: "run_command" });
    expect(parseRule(" run_command(git status *) ", TOOLS)).toEqual({
      text: "run_command(git status *)",
      tool: "run_command",
      pattern: "git status *",
    });
  });

  it("rejects mistakes instead of silently ignoring them", () => {
    expect(() => parseRule("run_comand(git *)", TOOLS)).toThrow(/不存在/);
    expect(() => parseRule("read_file(notes/**)", TOOLS)).toThrow(/可以带模式/);
    expect(() => parseRule("run_command()", TOOLS)).toThrow(/不能为空/);
    expect(() => parseRule("run_command(git", TOOLS)).toThrow(/格式不对/);
  });
});

describe("matchesRule", () => {
  const matches = (rule: string, kind: "allow" | "deny", tool: string, args: Record<string, unknown>) =>
    matchesRule(parseRule(rule, TOOLS), kind, tool, args, WORKSPACE);

  it("matches a command prefix, with or without arguments", () => {
    expect(matches("run_command(git status *)", "allow", "run_command", { command: "git status" })).toBe(true);
    expect(matches("run_command(git status *)", "allow", "run_command", { command: "git  status -s" })).toBe(true);
    expect(matches("run_command(git status *)", "allow", "run_command", { command: "git statusx" })).toBe(false);
    expect(matches("run_command(git status *)", "allow", "run_command", { command: "git log" })).toBe(false);
  });

  it("never lets a prefix rule approve a second command", () => {
    for (const command of [
      "git status; Remove-Item x",
      "git status | Remove-Item",
      "git status\nRemove-Item x",
      "git status $(Remove-Item x)",
      "git status > x",
    ]) {
      expect(matches("run_command(git status *)", "allow", "run_command", { command })).toBe(false);
    }
  });

  it("matches an exact command rule only exactly", () => {
    expect(matches("run_command(npm test)", "allow", "run_command", { command: "npm test" })).toBe(true);
    expect(matches("run_command(npm test)", "allow", "run_command", { command: "npm test; rm x" })).toBe(false);
  });

  it("finds a denied command anywhere in a compound command, ignoring case", () => {
    const deny = (command: string) => matches("run_command(Remove-Item *)", "deny", "run_command", { command });
    expect(deny("Remove-Item x")).toBe(true);
    expect(deny("Get-ChildItem; remove-item x")).toBe(true);
    expect(deny("Get-ChildItem | & Remove-Item")).toBe(true);
    expect(deny("Get-ChildItem")).toBe(false);
  });

  it("matches paths relative to the workspace, however the model wrote them", () => {
    const allow = (path: string) => matches("edit_file(notes/**)", "allow", "edit_file", { path });
    expect(allow("notes/a.md")).toBe(true);
    expect(allow("./notes/deep/b.md")).toBe(true);
    expect(allow("notes\\a.md")).toBe(true);
    expect(allow(join(WORKSPACE, "notes", "a.md"))).toBe(true);
    expect(allow("notes/../secret.md")).toBe(false);
    expect(allow("../notes/a.md")).toBe(false);
  });

  it("only applies a rule to its own tool", () => {
    expect(matches("edit_file(notes/**)", "allow", "write_file", { path: "notes/a.md" })).toBe(false);
    expect(matches("memory_search", "deny", "memory_search", { query: "x" })).toBe(true);
  });
});

describe("suggestRule", () => {
  const suggest = (tool: string, args: Record<string, unknown>) => suggestRule(tool, args, WORKSPACE);

  it("offers a prefix for ordinary commands", () => {
    expect(suggest("run_command", { command: "git commit -m 'x'" })).toBe("run_command(git commit *)");
    expect(suggest("run_command", { command: "npm   test" })).toBe("run_command(npm test *)");
    expect(suggest("run_command", { command: "ls" })).toBe("run_command(ls *)");
  });

  it("offers only the exact command when a prefix would allow too much", () => {
    expect(suggest("run_command", { command: "python build.py" })).toBe("run_command(python build.py)");
    expect(suggest("run_command", { command: "powershell -c Remove-Item x" })).toBe(
      "run_command(powershell -c Remove-Item x)",
    );
    expect(suggest("run_command", { command: "git -c a=b status" })).toBe("run_command(git -c a=b status)");
  });

  it("offers nothing for commands a rule cannot describe safely", () => {
    expect(suggest("run_command", { command: "git status; Remove-Item x" })).toBeNull();
    expect(suggest("run_command", { command: "python *.py" })).toBeNull();
  });

  it("offers the file for edits", () => {
    expect(suggest("edit_file", { path: "./notes\\a.md" })).toBe("edit_file(notes/a.md)");
    expect(suggest("write_file", { path: "../x" })).toBeNull();
  });
});

describe("workspacePath", () => {
  it("treats the workspace itself as outside any file rule", () => {
    expect(workspacePath(WORKSPACE, ".")).toBeNull();
  });
});

describe("PermissionGate", () => {
  let dir: string;
  let ask: ReturnType<typeof vi.fn<PermissionGateOptions["ask"]>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-permissions-"));
    ask = vi.fn<PermissionGateOptions["ask"]>(async (): Promise<UserDecision> => ({ allowed: true }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const savedPath = () => join(dir, "permissions.json");

  function gate(options: Partial<PermissionGateOptions> = {}) {
    return new PermissionGate({
      workspaceDir: WORKSPACE,
      toolNames: TOOLS,
      allow: [],
      deny: [],
      autoAllowReadOnly: true,
      savedRulesPath: savedPath(),
      ask,
      ...options,
    });
  }

  const command = (text: string): PermissionRequest => ({
    toolName: "run_command",
    args: { command: text },
    need: { title: "运行命令", detail: text },
  });

  it("runs read-only tools without asking", async () => {
    await expect(gate().check({ toolName: "read_file", args: { path: "a" }, need: null }, SIGNAL)).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks for anything else, offering a rule to remember", async () => {
    await expect(gate().check(command("npm test"), SIGNAL)).resolves.toBe(true);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: "运行命令" }), SIGNAL, "run_command(npm test *)");
  });

  it("says when a remembered rule let a call through", async () => {
    ask.mockResolvedValueOnce({ allowed: true, remember: "session" });
    const current = gate();

    await expect(current.check(command("npm test"), SIGNAL)).resolves.toBe(true);
    await expect(current.check(command("npm test"), SIGNAL)).resolves.toEqual({
      autoApproved: "规则 run_command(npm test *) 允许",
    });
  });

  describe("protected files", () => {
    const edit = (path: string): PermissionRequest => ({
      toolName: "edit_file",
      args: { path, old_string: "a", new_string: "b" },
      need: { title: `修改文件：${path}`, detail: "diff", detailFormat: "diff" },
    });
    const strict = () =>
      gate({ allow: ["edit_file", "write_file(**)"], protectedPaths: ["AGENTS.md"] });

    it("always asks about AGENTS.md, whatever the allow rules say, and offers nothing to remember", async () => {
      ask.mockResolvedValue({ allowed: true, remember: "always" });
      const current = strict();

      await expect(current.check(edit("AGENTS.md"), SIGNAL)).resolves.toBe(true);
      await expect(current.check(edit("./agents.md"), SIGNAL)).resolves.toBe(true);

      expect(ask).toHaveBeenCalledTimes(2);
      expect(ask.mock.calls[0]?.[0].title).toContain("规则文件");
      expect(ask.mock.calls[0]?.[2]).toBeUndefined();
    });

    it("reports a refusal of a protected edit", async () => {
      ask.mockResolvedValue({ allowed: false });
      await expect(strict().check(edit("AGENTS.md"), SIGNAL)).resolves.toBe(false);
    });

    it("still lets deny rules refuse it without asking", async () => {
      const denied = gate({ deny: ["edit_file(AGENTS.md)"], protectedPaths: ["AGENTS.md"] });
      await expect(denied.check(edit("AGENTS.md"), SIGNAL)).resolves.toMatch(/禁止/);
      expect(ask).not.toHaveBeenCalled();
    });

    it("leaves other files and nested AGENTS.md files to the rules", async () => {
      await expect(strict().check(edit("notes/AGENTS.md"), SIGNAL)).resolves.toEqual({
        autoApproved: "规则 edit_file 允许",
      });
      expect(ask).not.toHaveBeenCalled();
    });
  });

  it("reports the user's refusal", async () => {
    ask.mockResolvedValue({ allowed: false });
    await expect(gate().check(command("npm test"), SIGNAL)).resolves.toBe(false);
  });

  it("runs read-only commands without asking, unless turned off", async () => {
    await expect(gate().check(command("Get-ChildItem | Select-String x"), SIGNAL)).resolves.toEqual({
      autoApproved: "只读命令，自动运行",
    });
    expect(ask).not.toHaveBeenCalled();

    await gate({ autoAllowReadOnly: false }).check(command("Get-ChildItem"), SIGNAL);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("follows allow rules from the config", async () => {
    await expect(gate({ allow: ["run_command(npm test *)"] }).check(command("npm test -- x"), SIGNAL)).resolves.toEqual({
      autoApproved: "规则 run_command(npm test *) 允许",
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("lets deny rules win, even over allow rules and read-only tools", async () => {
    const strict = gate({
      allow: ["run_command"],
      deny: ["run_command(Get-ChildItem *)", "memory_search"],
    });

    await expect(strict.check(command("Get-ChildItem"), SIGNAL)).resolves.toMatch(/禁止/);
    await expect(
      strict.check({ toolName: "memory_search", args: { query: "x" }, need: null }, SIGNAL),
    ).resolves.toMatch(/memory_search/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("refuses to start with an invalid rule in the config", () => {
    expect(() => gate({ deny: ["rm_rf"] })).toThrow(/配置文件里的权限规则无效/);
  });

  it("remembers a session answer until the session changes", async () => {
    ask.mockResolvedValueOnce({ allowed: true, remember: "session" });
    const current = gate();

    await current.check(command("npm test"), SIGNAL);
    await current.check(command("npm test -- --watch"), SIGNAL);
    expect(ask).toHaveBeenCalledTimes(1);

    current.clearSession();
    await current.check(command("npm test"), SIGNAL);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("saves an always answer, and a new gate reads it back", async () => {
    ask.mockResolvedValueOnce({ allowed: true, remember: "always" });
    await gate().check(command("npm test"), SIGNAL);

    expect(JSON.parse(readFileSync(savedPath(), "utf8"))).toEqual({ allow: ["run_command(npm test *)"] });
    await gate().check(command("npm test"), SIGNAL);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a saved file it cannot read", async () => {
    writeFileSync(savedPath(), "{ not json");
    const log = vi.fn();
    ask.mockResolvedValueOnce({ allowed: true, remember: "always" });

    const current = gate({ log });
    await current.check(command("npm test"), SIGNAL);

    expect(readFileSync(savedPath(), "utf8")).toBe("{ not json");
    expect(log).toHaveBeenCalled();
    // Still honored for the rest of the session.
    await current.check(command("npm test"), SIGNAL);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("remembers nothing when no rule could be offered", async () => {
    ask.mockResolvedValue({ allowed: true, remember: "session" });
    const current = gate();

    await current.check(command("npm test; npm run build"), SIGNAL);
    await current.check(command("npm test; npm run build"), SIGNAL);

    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[0]?.[2]).toBeUndefined();
  });
});
