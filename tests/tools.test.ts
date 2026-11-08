import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTools, planEdit, resolveInWorkspace, type Tool } from "../src/main/agent/tools";

let root: string;
let workspace: string;
let tools: Tool[];
const commands: string[] = [];

const SIGNAL = new AbortController().signal;

function byName(name: string): Tool {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(name);
  return tool;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-tools-"));
  workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(root, "secret.txt"), "secret");
  commands.length = 0;
  tools = createTools({
    workspaceDir: workspace,
    shell: {
      description: "将在沙箱中运行",
      run: async (command) => {
        commands.push(command);
        return "输出";
      },
    },
    searchMemory: async () => ["记忆一"],
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveInWorkspace", () => {
  it("accepts paths inside the workspace, including new ones", async () => {
    await expect(resolveInWorkspace(workspace, "a/b/new.txt")).resolves.toContain("new.txt");
  });

  it.each(["../secret.txt", "a/../../secret.txt"])("rejects %s", async (path) => {
    await expect(resolveInWorkspace(workspace, path)).rejects.toThrow(/不在工作目录内/);
  });

  it("rejects absolute paths outside the workspace", async () => {
    await expect(resolveInWorkspace(workspace, join(root, "secret.txt"))).rejects.toThrow(
      /不在工作目录内/,
    );
  });

  it("does not treat a sibling with the same prefix as inside", async () => {
    mkdirSync(join(root, "workspace-other"));
    await expect(resolveInWorkspace(workspace, "../workspace-other/x")).rejects.toThrow(
      /不在工作目录内/,
    );
  });

  it("rejects a link that leads outside the workspace", async () => {
    symlinkSync(root, join(workspace, "escape"), "junction");

    await expect(resolveInWorkspace(workspace, "escape/secret.txt")).rejects.toThrow(
      /不在工作目录内/,
    );
    await expect(resolveInWorkspace(workspace, "escape/new.txt")).rejects.toThrow(/不在工作目录内/);
  });
});

describe("file tools", () => {
  it("writes, reads and lists files", async () => {
    await byName("write_file").run({ path: "notes/a.txt", content: "你好" }, SIGNAL);

    expect(readFileSync(join(workspace, "notes", "a.txt"), "utf8")).toBe("你好");
    await expect(byName("read_file").run({ path: "notes/a.txt" }, SIGNAL)).resolves.toBe("你好");
    await expect(byName("list_directory").run({ path: "." }, SIGNAL)).resolves.toContain("[目录] notes");
  });

  it("refuses to read outside the workspace", async () => {
    await expect(byName("read_file").run({ path: "../secret.txt" }, SIGNAL)).rejects.toThrow();
  });

  it("refuses to read very large files", async () => {
    writeFileSync(join(workspace, "big.txt"), "x".repeat(300_000));

    await expect(byName("read_file").run({ path: "big.txt" }, SIGNAL)).rejects.toThrow(/过大/);
  });

  it("rejects arguments of the wrong type", async () => {
    await expect(byName("read_file").run({ path: 1 }, SIGNAL)).rejects.toThrow(/字符串/);
  });
});

describe("permissions", () => {
  it("requires approval for anything that changes the machine", async () => {
    writeFileSync(join(workspace, "a.txt"), "old");
    expect(await byName("write_file").describePermission({ path: "a", content: "b" })).not.toBeNull();
    expect(
      await byName("edit_file").describePermission({ path: "a.txt", old_string: "old", new_string: "new" }),
    ).not.toBeNull();
    expect(await byName("run_command").describePermission({ command: "dir" })).toMatchObject({
      detail: "dir",
    });
  });

  it("tells the user how a command will run", async () => {
    expect((await byName("run_command").describePermission({ command: "dir" }))?.title).toContain("沙箱");
  });

  it("lets read-only tools run without asking", async () => {
    for (const name of ["read_file", "list_directory", "memory_search", "search_files"]) {
      expect(await byName(name).describePermission({})).toBeNull();
    }
  });
});

describe("summaries", () => {
  it("says what each call works on", () => {
    expect(byName("run_command").summarize?.({ command: "git status" })).toBe("git status");
    expect(byName("edit_file").summarize?.({ path: "a.md", old_string: "x", new_string: "y" })).toBe("a.md");
    expect(byName("search_files").summarize?.({ query: "TODO", file_pattern: "*.md" })).toBe("TODO · *.md");
    expect(byName("memory_search").summarize?.({ query: "颜色" })).toBe("颜色");
  });

  it("skips arguments that are not strings and shortens very long ones", () => {
    expect(byName("read_file").summarize?.({ path: 3 })).toBeUndefined();
    expect(byName("run_command").summarize?.({ command: "x".repeat(5_000) })).toHaveLength(2_001);
  });
});

describe("run_command", () => {
  it("runs through the shell it was given", async () => {
    await expect(byName("run_command").run({ command: "dir" }, SIGNAL)).resolves.toBe("输出");
    expect(commands).toEqual(["dir"]);
  });
});

describe("memory_search", () => {
  it("formats results for the model", async () => {
    await expect(byName("memory_search").run({ query: "x" }, SIGNAL)).resolves.toBe("- 记忆一");
  });
});

describe("planEdit", () => {
  it("replaces a unique match", () => {
    expect(planEdit("a b c", "b", "x", false)).toEqual({ after: "a x c", replacements: 1 });
  });

  it("refuses a missing or ambiguous match", () => {
    expect(() => planEdit("a b c", "z", "x", false)).toThrow(/没有找到/);
    expect(() => planEdit("b b", "b", "x", false)).toThrow(/出现了 2 次/);
  });

  it("replaces every match when asked", () => {
    expect(planEdit("b b", "b", "x", true)).toEqual({ after: "x x", replacements: 2 });
  });

  it("keeps replacement patterns literal", () => {
    expect(planEdit("price", "price", "$& $1 $$", false).after).toBe("$& $1 $$");
  });

  it("matches and keeps Windows line endings", () => {
    expect(planEdit("one\r\ntwo\r\n", "one\ntwo", "1\n2", false).after).toBe("1\r\n2\r\n");
  });

  it("refuses edits that change nothing", () => {
    expect(() => planEdit("a", "", "x", false)).toThrow(/不能为空/);
    expect(() => planEdit("a", "a", "a", false)).toThrow(/相同/);
  });
});

describe("edit_file", () => {
  const args = (extra: Record<string, unknown> = {}) => ({
    path: "code.ts",
    old_string: "const b = 2;",
    new_string: "const b = 20;",
    ...extra,
  });

  beforeEach(() => {
    writeFileSync(join(workspace, "code.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  });

  it("shows the change as a diff before asking", async () => {
    const need = await byName("edit_file").describePermission(args());

    expect(need).toMatchObject({ title: "修改文件：code.ts", detailFormat: "diff" });
    expect(need?.detail).toBe(
      "@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 20;\n const c = 3;",
    );
  });

  it("writes the approved change", async () => {
    const edit = byName("edit_file");
    const call = args();
    await edit.describePermission(call);

    await expect(edit.run(call, SIGNAL)).resolves.toContain("1 处");
    expect(readFileSync(join(workspace, "code.ts"), "utf8")).toBe(
      "const a = 1;\nconst b = 20;\nconst c = 3;\n",
    );
  });

  it("does not write if the file changed after approval", async () => {
    const edit = byName("edit_file");
    const call = args();
    await edit.describePermission(call);
    writeFileSync(join(workspace, "code.ts"), "const b = 2;\n// 别人加的\n");

    await expect(edit.run(call, SIGNAL)).rejects.toThrow(/批准之后被改动/);
    expect(readFileSync(join(workspace, "code.ts"), "utf8")).toContain("别人加的");
  });

  it("fails before asking when the edit cannot apply", async () => {
    await expect(byName("edit_file").describePermission(args({ old_string: "不存在" }))).rejects.toThrow(
      /没有找到/,
    );
  });

  it("refuses files outside the workspace", async () => {
    await expect(
      byName("edit_file").describePermission(args({ path: "../secret.txt", old_string: "secret" })),
    ).rejects.toThrow(/不在工作目录内/);
  });

  it("refuses files that are not UTF-8 rather than corrupting them", async () => {
    // "中文" in GBK, which is not valid UTF-8.
    writeFileSync(join(workspace, "gbk.txt"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));

    await expect(
      byName("edit_file").describePermission(args({ path: "gbk.txt", old_string: "x" })),
    ).rejects.toThrow(/UTF-8/);
  });
});

describe("search_files", () => {
  const search = (args: Record<string, unknown>) => byName("search_files").run(args, SIGNAL);

  beforeEach(() => {
    mkdirSync(join(workspace, "src", "deep"), { recursive: true });
    mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(workspace, "notes.md"), "# 笔记\n记得买牛奶\nTODO: 回邮件\n");
    writeFileSync(join(workspace, "src", "app.ts"), "// todo: refactor\nexport const x = 1;\n");
    writeFileSync(join(workspace, "src", "deep", "util.ts"), "export const TODO = 2;\n");
    writeFileSync(join(workspace, "node_modules", "pkg", "index.js"), "TODO in a dependency\n");
    writeFileSync(join(workspace, "image.bin"), Buffer.from([0x54, 0x4f, 0x44, 0x4f, 0, 1, 2]));
  });

  it("finds text with file and line, skipping dependencies and binaries", async () => {
    await expect(search({ query: "TODO" })).resolves.toBe(
      "notes.md:3: TODO: 回邮件\nsrc/deep/util.ts:1: export const TODO = 2;",
    );
  });

  it("searches Chinese text", async () => {
    await expect(search({ query: "牛奶" })).resolves.toBe("notes.md:2: 记得买牛奶");
  });

  it("can ignore case", async () => {
    await expect(search({ query: "todo", ignore_case: true })).resolves.toContain("src/app.ts:1:");
  });

  it("treats the query as literal text unless asked for a regex", async () => {
    await expect(search({ query: "x = 1." })).resolves.toBe("没有找到匹配的内容");
    await expect(search({ query: "x = \\d", regex: true })).resolves.toContain("src/app.ts:2:");
  });

  it("filters by file name or path pattern", async () => {
    await expect(search({ query: "TODO", file_pattern: "*.md" })).resolves.toBe("notes.md:3: TODO: 回邮件");
    await expect(search({ file_pattern: "src/**/*.ts" })).resolves.toBe("src/app.ts\nsrc/deep/util.ts");
    await expect(search({ file_pattern: "*.{md,ts}" })).resolves.toBe(
      "notes.md\nsrc/app.ts\nsrc/deep/util.ts",
    );
  });

  it("searches inside a given folder", async () => {
    await expect(search({ query: "TODO", path: "src" })).resolves.toBe(
      "src/deep/util.ts:1: export const TODO = 2;",
    );
  });

  it("stays inside the workspace", async () => {
    await expect(search({ query: "secret", path: ".." })).rejects.toThrow(/不在工作目录内/);

    symlinkSync(root, join(workspace, "escape"), "junction");
    await expect(search({ query: "secret" })).resolves.toBe("没有找到匹配的内容");
  });

  it("stops a regex that backtracks forever", async () => {
    writeFileSync(join(workspace, "evil.txt"), `${"a".repeat(40)}!\n`);

    await expect(search({ query: "(a+)+$", regex: true, path: "evil.txt" })).rejects.toThrow(/超时/);
  }, 20_000);

  it("rejects invalid input", async () => {
    await expect(search({})).rejects.toThrow(/至少/);
    await expect(search({ query: "(", regex: true })).rejects.toThrow(/正则表达式无效/);
  });
});
