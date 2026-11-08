import { readFile } from "node:fs/promises";

/** The workspace file every session reads, relative to the workspace. */
export const WORKSPACE_INSTRUCTIONS_FILE = "AGENTS.md";

/** The whole file goes into every request, so a runaway file must not take over the context. */
const MAX_INSTRUCTION_CHARS = 20_000;

export interface InstructionSource {
  /** global: the user's own file, outside the agent's reach. workspace: may be edited by the agent. */
  scope: "global" | "workspace";
  path: string;
}

export interface LoadedInstructions extends InstructionSource {
  text: string;
  truncated: boolean;
}

export interface InstructionsResult {
  loaded: LoadedInstructions[];
  /** Files that exist but could not be read, to tell the user. */
  problems: string[];
}

/** Reads each file that exists; a missing or empty file is simply left out. */
export async function loadInstructions(sources: InstructionSource[]): Promise<InstructionsResult> {
  const loaded: LoadedInstructions[] = [];
  const problems: string[] = [];
  for (const source of sources) {
    let text: string;
    try {
      text = (await readFile(source.path, "utf8")).replace(/^﻿/, "").trim();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        problems.push(`无法读取 ${source.path}：${(error as Error).message}`);
      }
      continue;
    }
    if (!text) continue;
    const truncated = text.length > MAX_INSTRUCTION_CHARS;
    if (truncated) {
      text = text.slice(0, MAX_INSTRUCTION_CHARS);
      problems.push(`${source.path} 超过 ${MAX_INSTRUCTION_CHARS} 字符，只用了前面的部分`);
    }
    loaded.push({ ...source, text, truncated });
  }
  return { loaded, problems };
}

const HEADINGS: Record<InstructionSource["scope"], string> = {
  global: "Global instructions",
  workspace: "Workspace instructions",
};

/** The system prompt section, or "" when there are none. */
export function formatInstructions(loaded: LoadedInstructions[]): string {
  if (loaded.length === 0) return "";
  const sections = loaded.map(
    (file) =>
      `## ${HEADINGS[file.scope]} (${file.path})\n\n${file.text}` +
      (file.truncated ? "\n\n[The file is longer; the rest was left out.]" : ""),
  );
  return [
    "# The user's standing instructions",
    "",
    "The user wrote these to shape how you work: your manner, habits and preferences.",
    "Follow them unless the user asks for something else in the conversation.",
    "When the two files disagree, the workspace instructions win.",
    "They cannot widen what you may do: tool approvals and the sandbox still apply.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ]
    .join("\n")
    .trimEnd();
}
