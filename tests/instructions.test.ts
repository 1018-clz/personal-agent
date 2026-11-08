import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatInstructions, loadInstructions } from "../src/main/agent/instructions";
import { buildSystemPrompt } from "../src/main/agent/system-prompt";

let dir: string;
const globalFile = () => join(dir, "global.md");
const workspaceFile = () => join(dir, "AGENTS.md");
const sources = () => [
  { scope: "global" as const, path: globalFile() },
  { scope: "workspace" as const, path: workspaceFile() },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-instructions-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadInstructions", () => {
  it("reads both files, global first", async () => {
    writeFileSync(globalFile(), "说话简短。");
    writeFileSync(workspaceFile(), "\uFEFF# 项目\n用中文写注释。\n");

    const { loaded, problems } = await loadInstructions(sources());

    expect(loaded.map((file) => [file.scope, file.text])).toEqual([
      ["global", "说话简短。"],
      ["workspace", "# 项目\n用中文写注释。"],
    ]);
    expect(problems).toEqual([]);
  });

  it("leaves out missing and empty files without complaint", async () => {
    writeFileSync(workspaceFile(), "  \n");

    await expect(loadInstructions(sources())).resolves.toEqual({ loaded: [], problems: [] });
  });

  it("reports a file it cannot read", async () => {
    mkdirSync(workspaceFile()); // a folder where the file should be

    const { loaded, problems } = await loadInstructions(sources());

    expect(loaded).toEqual([]);
    expect(problems[0]).toContain("无法读取");
  });

  it("cuts a very long file and says so", async () => {
    writeFileSync(workspaceFile(), "很".repeat(30_000));

    const { loaded, problems } = await loadInstructions(sources());

    expect(loaded[0]?.text).toHaveLength(20_000);
    expect(loaded[0]?.truncated).toBe(true);
    expect(problems[0]).toContain("超过");
    expect(formatInstructions(loaded)).toContain("the rest was left out");
  });
});

describe("formatInstructions", () => {
  it("is empty when there is nothing to say", () => {
    expect(formatInstructions([])).toBe("");
  });

  it("labels each file and says the instructions cannot widen permissions", () => {
    const text = formatInstructions([
      { scope: "global", path: "G:\\AGENTS.md", text: "说话简短。", truncated: false },
      { scope: "workspace", path: "W:\\AGENTS.md", text: "用中文写注释。", truncated: false },
    ]);

    expect(text).toContain("## Global instructions (G:\\AGENTS.md)\n\n说话简短。");
    expect(text).toContain("## Workspace instructions (W:\\AGENTS.md)\n\n用中文写注释。");
    expect(text).toContain("tool approvals and the sandbox still apply");
    expect(text.indexOf("说话简短")).toBeLessThan(text.indexOf("用中文写注释"));
  });
});

describe("buildSystemPrompt", () => {
  const base = { workspaceDir: "W:\\work", memoryRules: "MEMORY RULES", now: new Date("2026-11-08T00:00:00Z") };

  it("puts the instructions after the fixed rules", () => {
    const prompt = buildSystemPrompt({ ...base, instructions: "# The user's standing instructions\n..." });

    expect(prompt.indexOf("MEMORY RULES")).toBeLessThan(prompt.indexOf("standing instructions\n"));
    expect(prompt.endsWith("...")).toBe(true);
  });

  it("tells the agent where its instructions live, even before the file exists", () => {
    const prompt = buildSystemPrompt(base);

    expect(prompt).toContain("W:\\work");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt.endsWith("MEMORY RULES")).toBe(true);
  });
});
