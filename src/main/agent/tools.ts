import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Shell } from "../sandbox/shell";
import { unifiedDiff } from "./diff";
import type { ToolDefinition } from "./model";
import { searchWorkspace } from "./search";

const MAX_READ_BYTES = 200_000;

export interface PermissionNeed {
  title: string;
  detail?: string;
  /** A diff is shown with added and removed lines marked. */
  detailFormat?: "text" | "diff";
}

export interface Tool {
  definition: ToolDefinition;
  /**
   * Null means the tool only reads and runs without asking. Throwing reports the error to the
   * model without asking the user, for a call that could never succeed.
   */
  describePermission(
    args: Record<string, unknown>,
  ): PermissionNeed | null | Promise<PermissionNeed | null>;
  /** One line on what the call works on, shown in the transcript whether or not it asked. */
  summarize?(args: Record<string, unknown>): string | undefined;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface ToolContext {
  workspaceDir: string;
  shell: Shell;
  searchMemory(query: string): Promise<string[]>;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`参数 ${name} 必须是字符串`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`参数 ${name} 必须是字符串`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`参数 ${name} 必须是布尔值`);
  return value;
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Resolves a model-supplied path, following symlinks so one cannot lead out of the workspace. */
export async function resolveInWorkspace(workspaceDir: string, path: string): Promise<string> {
  const root = await realpath(workspaceDir);
  const target = resolve(root, path);

  let existing = target;
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }

  if (!isInside(root, target) || !isInside(root, existing)) {
    throw new Error(`路径不在工作目录内：${path}`);
  }
  return target;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Reads a file to edit, refusing encodings it would corrupt by writing back as UTF-8. */
async function readForEdit(path: string): Promise<string> {
  const { size } = await stat(path);
  if (size > MAX_READ_BYTES) throw new Error(`文件过大（${size} 字节）`);
  try {
    return utf8.decode(await readFile(path));
  } catch {
    throw new Error("文件不是 UTF-8 编码，不能用 edit_file 修改");
  }
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (let at = text.indexOf(search); at !== -1; at = text.indexOf(search, at + search.length)) {
    count++;
  }
  return count;
}

export interface EditPlan {
  after: string;
  replacements: number;
}

/** Applies an exact string replacement, failing when the target is missing or ambiguous. */
export function planEdit(
  before: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditPlan {
  if (oldString === "") throw new Error("old_string 不能为空；新建文件请用 write_file");
  if (oldString === newString) throw new Error("old_string 和 new_string 相同，没有要修改的内容");

  // Models write \n, but files on Windows often use \r\n: match and write in the file's style.
  if (before.includes("\r\n") && !oldString.includes("\r")) {
    oldString = oldString.replace(/\n/g, "\r\n");
    newString = newString.replace(/\r?\n/g, "\r\n");
  }

  const count = countOccurrences(before, oldString);
  if (count === 0) {
    throw new Error("没有找到 old_string。请先用 read_file 确认原文，注意空格、缩进和换行要完全一致");
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string 出现了 ${count} 次。请加上更多上下文让它唯一，或者设置 replace_all 替换全部`,
    );
  }

  // Splicing, not String.replace, so $& and $1 in the new text stay literal.
  const after = before.split(oldString).join(newString);
  return { after, replacements: count };
}

const MAX_SUMMARY_CHARS = 2_000;

/** The named arguments that are strings, joined; a model can send anything, so others are skipped. */
function summarizeArgs(...values: unknown[]): string | undefined {
  const parts = values.filter((value): value is string => typeof value === "string" && value !== "");
  if (!parts.length) return undefined;
  const text = parts.join(" · ");
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（输出过长，已截断，共 ${text.length} 字符）`;
}

export function createTools({ workspaceDir, shell, searchMemory }: ToolContext): Tool[] {
  const pathParameter = { type: "string", description: "相对于工作目录的路径" };

  /**
   * The exact change the user approved, keyed by the call's arguments, so run writes what the
   * dialog showed and refuses if the file changed while the dialog was open.
   */
  const approvedEdits = new WeakMap<Record<string, unknown>, { path: string; before: string; after: string }>();

  async function prepareEdit(args: Record<string, unknown>) {
    const path = await resolveInWorkspace(workspaceDir, stringArg(args, "path"));
    const before = await readForEdit(path);
    const plan = planEdit(
      before,
      stringArg(args, "old_string"),
      stringArg(args, "new_string"),
      optionalBoolean(args, "replace_all"),
    );
    return { path, before, ...plan };
  }

  return [
    {
      definition: {
        name: "list_directory",
        description: "列出工作目录内某个目录的内容。",
        parameters: {
          type: "object",
          properties: { path: { ...pathParameter, description: "目录路径，根目录用 ." } },
          required: ["path"],
        },
      },
      describePermission: () => null,
      summarize: (args) => summarizeArgs(args.path),
      async run(args) {
        const path = await resolveInWorkspace(workspaceDir, stringArg(args, "path"));
        const entries = await readdir(path, { withFileTypes: true });
        if (entries.length === 0) return "（空目录）";
        return entries
          .map((entry) => `${entry.isDirectory() ? "[目录]" : "[文件]"} ${entry.name}`)
          .join("\n");
      },
    },
    {
      definition: {
        name: "read_file",
        description: "读取工作目录内的文本文件。",
        parameters: {
          type: "object",
          properties: { path: pathParameter },
          required: ["path"],
        },
      },
      describePermission: () => null,
      summarize: (args) => summarizeArgs(args.path),
      async run(args) {
        const path = await resolveInWorkspace(workspaceDir, stringArg(args, "path"));
        const { size } = await stat(path);
        if (size > MAX_READ_BYTES) throw new Error(`文件过大（${size} 字节）`);
        return readFile(path, "utf8");
      },
    },
    {
      definition: {
        name: "write_file",
        description: "在工作目录内创建或覆盖文本文件。",
        parameters: {
          type: "object",
          properties: {
            path: pathParameter,
            content: { type: "string", description: "文件的完整内容" },
          },
          required: ["path", "content"],
        },
      },
      describePermission: (args) => ({
        title: `写入文件：${String(args.path)}`,
        detail: truncate(String(args.content), 2_000),
      }),
      summarize: (args) => summarizeArgs(args.path),
      async run(args) {
        const path = await resolveInWorkspace(workspaceDir, stringArg(args, "path"));
        const content = stringArg(args, "content");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf8");
        return `已写入 ${Buffer.byteLength(content)} 字节`;
      },
    },
    {
      definition: {
        name: "edit_file",
        description:
          "修改工作目录内已有的文本文件：把 old_string 精确替换成 new_string。" +
          "修改前先用 read_file 看原文。old_string 必须和文件内容完全一致（包括缩进），并且在文件中唯一；" +
          "不唯一时加上前后几行让它唯一，或者设置 replace_all。只改一部分时用它，不要用 write_file 重写整个文件。",
        parameters: {
          type: "object",
          properties: {
            path: pathParameter,
            old_string: { type: "string", description: "要替换的原文" },
            new_string: { type: "string", description: "替换后的内容，可以为空字符串表示删除" },
            replace_all: { type: "boolean", description: "替换所有出现的地方，默认 false" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
      async describePermission(args) {
        const edit = await prepareEdit(args);
        approvedEdits.set(args, edit);
        const count = edit.replacements > 1 ? `，${edit.replacements} 处` : "";
        return {
          title: `修改文件：${String(args.path)}${count}`,
          detail: truncate(unifiedDiff(edit.before, edit.after), 6_000),
          detailFormat: "diff",
        };
      },
      summarize: (args) => summarizeArgs(args.path),
      async run(args) {
        const approved = approvedEdits.get(args);
        const edit = await prepareEdit(args);
        if (approved && (approved.before !== edit.before || approved.path !== edit.path)) {
          throw new Error("文件在批准之后被改动过，没有写入。请重新读取文件后再修改");
        }
        await writeFile(edit.path, edit.after, "utf8");
        return `已修改，替换了 ${edit.replacements} 处`;
      },
    },
    {
      definition: {
        name: "search_files",
        description:
          "在工作目录内搜索。给 query 时按内容搜索，返回“路径:行号: 内容”；只给 file_pattern 时按文件名查找。" +
          "跳过 .git、node_modules、二进制文件和链接。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "要查找的文字，regex 为 true 时是 JavaScript 正则表达式" },
            path: { ...pathParameter, description: "在哪个目录或文件里搜索，默认是整个工作目录" },
            file_pattern: {
              type: "string",
              description: "只搜索匹配的文件，例如 *.md、src/**/*.ts、*.{js,ts}；不含 / 时只匹配文件名",
            },
            regex: { type: "boolean", description: "query 是否是正则表达式，默认 false" },
            ignore_case: { type: "boolean", description: "是否忽略大小写，默认 false" },
          },
        },
      },
      describePermission: () => null,
      summarize: (args) => summarizeArgs(args.query, args.file_pattern, args.path),
      async run(args, signal) {
        const query = optionalString(args, "query");
        const filePattern = optionalString(args, "file_pattern");
        if (!query && !filePattern) throw new Error("query 和 file_pattern 至少要给一个");
        return truncate(
          await searchWorkspace({
            root: await realpath(workspaceDir),
            start: await resolveInWorkspace(workspaceDir, optionalString(args, "path") ?? "."),
            query,
            filePattern,
            regex: optionalBoolean(args, "regex"),
            ignoreCase: optionalBoolean(args, "ignore_case"),
            signal,
          }),
          30_000,
        );
      },
    },
    {
      definition: {
        name: "run_command",
        description:
          `在工作目录中运行 PowerShell 命令，并返回输出。工作目录映射为 Work:\\ 盘。${shell.description}。` +
          "优先使用 PowerShell cmdlet，例如用 Get-ChildItem 而不是 cmd /c dir。",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "要运行的命令" } },
          required: ["command"],
        },
      },
      describePermission: (args) => ({
        title: `运行命令（${shell.description}）`,
        detail: String(args.command),
      }),
      summarize: (args) => summarizeArgs(args.command),
      run: (args, signal) => shell.run(stringArg(args, "command"), signal),
    },
    {
      definition: {
        name: "memory_search",
        description: "搜索长期记忆。当前对话已自动附带相关记忆，只有需要更多信息时才调用。",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "要查找的内容" } },
          required: ["query"],
        },
      },
      describePermission: () => null,
      summarize: (args) => summarizeArgs(args.query),
      async run(args) {
        const memories = await searchMemory(stringArg(args, "query"));
        return memories.length ? memories.map((text) => `- ${text}`).join("\n") : "没有找到相关记忆";
      },
    },
  ];
}
