import { open, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Script, createContext } from "node:vm";

/** Folders that are huge, generated, or both, and almost never what the user means. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_MATCHES = 200;
const MAX_PATHS = 500;
const MAX_LINE_CHARS = 300;
/** A model-supplied regex can backtrack forever, so matching runs in a vm with a deadline. */
const MATCH_BUDGET_MS = 10_000;

export interface SearchOptions {
  /** The workspace root, already resolved with realpath. */
  root: string;
  /** Folder or file to search, already checked to be inside the root. */
  start: string;
  query?: string;
  regex: boolean;
  ignoreCase: boolean;
  filePattern?: string;
  signal: AbortSignal;
}

function toSlashes(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Supports *, ?, ** and {a,b}. A pattern without / matches the file name alone. */
export function globToRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        source += "\\{";
      } else {
        source += `(?:${pattern.slice(i + 1, end).split(",").map(escapeRegex).join("|")})`;
        i = end;
      }
    } else {
      source += escapeRegex(char);
    }
  }
  // Windows paths are case-insensitive, so names are too.
  return new RegExp(`^${source}$`, "i");
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8_000).includes(0);
}

async function readHead(path: string, size: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Lists files under start, skipping links so a junction cannot lead out of the workspace. */
async function* walk(start: string, signal: AbortSignal): AsyncGenerator<string> {
  if ((await stat(start)).isFile()) {
    yield start;
    return;
  }
  const stack = [start];
  while (stack.length) {
    signal.throwIfAborted();
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) subdirs.push(path);
      } else if (entry.isFile()) {
        yield path;
      }
    }
    stack.push(...subdirs.reverse()); // popped last in, so subfolders come out A to Z
  }
}

class LineMatcher {
  private readonly context: Record<string, unknown>;
  private readonly script = new Script(
    "found = []; for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) found.push(i);",
  );
  private readonly deadline = Date.now() + MATCH_BUDGET_MS;

  constructor(query: string, regex: boolean, ignoreCase: boolean) {
    const source = regex ? query : escapeRegex(query);
    try {
      new RegExp(source);
    } catch (error) {
      throw new Error(`正则表达式无效：${(error as Error).message}`);
    }
    this.context = createContext({ source, flags: ignoreCase ? "i" : "", lines: [], found: [] });
    new Script("re = new RegExp(source, flags);").runInContext(this.context);
  }

  match(lines: string[]): number[] {
    const timeout = this.deadline - Date.now();
    if (timeout <= 0) throw new Error("搜索超时，请缩小范围");
    this.context.lines = lines;
    try {
      this.script.runInContext(this.context, { timeout });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw new Error("搜索超时：正则表达式可能回溯过多，请换一个更简单的表达式或缩小范围");
      }
      throw error;
    }
    return [...(this.context.found as number[])];
  }
}

function clip(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed;
}

export async function searchWorkspace(options: SearchOptions): Promise<string> {
  const { root, start, query, filePattern, signal } = options;
  const nameFilter = filePattern ? globToRegex(filePattern) : null;
  const matchPath = filePattern?.includes("/") ?? false;
  const matcher = query ? new LineMatcher(query, options.regex, options.ignoreCase) : null;

  const results: string[] = [];
  const notes: string[] = [];
  let scanned = 0;
  let skippedLarge = 0;

  for await (const path of walk(start, signal)) {
    signal.throwIfAborted();
    const rel = toSlashes(relative(root, path));
    if (nameFilter && !nameFilter.test(matchPath ? rel : rel.slice(rel.lastIndexOf("/") + 1))) continue;

    if (++scanned > MAX_FILES) {
      notes.push(`文件超过 ${MAX_FILES} 个，只搜索了前 ${MAX_FILES} 个，请缩小范围`);
      break;
    }

    if (!matcher) {
      results.push(rel);
      if (results.length >= MAX_PATHS) {
        notes.push(`结果过多，只显示前 ${MAX_PATHS} 个`);
        break;
      }
      continue;
    }

    const { size } = await stat(path);
    if (size > MAX_FILE_BYTES) {
      skippedLarge++;
      continue;
    }
    const bytes = await readHead(path, size);
    if (isBinary(bytes)) continue;

    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (const index of matcher.match(lines)) {
      results.push(`${rel}:${index + 1}: ${clip(lines[index]!)}`);
      if (results.length >= MAX_MATCHES) break;
    }
    if (results.length >= MAX_MATCHES) {
      notes.push(`结果过多，只显示前 ${MAX_MATCHES} 条，请缩小范围`);
      break;
    }
  }

  if (skippedLarge) notes.push(`跳过了 ${skippedLarge} 个超过 1 MB 的文件`);
  const body = results.length ? results.join("\n") : matcher ? "没有找到匹配的内容" : "没有找到匹配的文件";
  return [body, ...notes.map((note) => `（${note}）`)].join("\n");
}
