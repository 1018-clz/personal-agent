import { readFile, rename, writeFile } from "node:fs/promises";

import type { AutoApproved, PermissionRequest } from "../agent/agent";
import type { PermissionNeed } from "../agent/tools";
import type { UserDecision } from "../permission-broker";
import { isReadOnlyCommand } from "./command";
import { matchesRule, parseRule, suggestRule, workspacePath, type Rule } from "./rules";

const FILE_TOOLS = new Set(["write_file", "edit_file"]);

export interface PermissionGateOptions {
  workspaceDir: string;
  toolNames: readonly string[];
  /** From config.json, written by the user. */
  allow: readonly string[];
  deny: readonly string[];
  /** Only meaningful inside the sandbox, which limits what a command can read. */
  autoAllowReadOnly: boolean;
  /** Rules the user chose to always allow. Outside the workspace, so the agent cannot edit it. */
  savedRulesPath: string;
  /**
   * Workspace files that are always asked about, whatever the allow rules say, with nothing to
   * remember: changing them changes what the agent does in every later session.
   */
  protectedPaths?: readonly string[];
  ask(need: PermissionNeed, signal: AbortSignal, rememberRule?: string): Promise<UserDecision>;
  log?(message: string): void;
}

/**
 * Decides each tool call in layers: a deny rule always wins, then read-only tools run, then
 * allow rules (config, saved, this session) and read-only commands, and anything else is asked.
 */
export class PermissionGate {
  private readonly allow: Rule[];
  private readonly deny: Rule[];
  private readonly sessionRules: Rule[] = [];
  private saved: Promise<Rule[]> | null = null;
  /** A saved file that could not be read is never overwritten, so the user can fix it. */
  private savedUnreadable = false;

  constructor(private readonly options: PermissionGateOptions) {
    const parse = (text: string) => {
      try {
        return parseRule(text, options.toolNames);
      } catch (error) {
        throw new Error(`配置文件里的权限规则无效：${(error as Error).message}`);
      }
    };
    this.allow = options.allow.map(parse);
    this.deny = options.deny.map(parse);
  }

  /**
   * True runs the tool, AutoApproved runs it without asking and says why, false means the user
   * refused, and a string is a rule's refusal.
   */
  async check(
    { toolName, args, need }: PermissionRequest,
    signal: AbortSignal,
  ): Promise<boolean | string | AutoApproved> {
    const { workspaceDir } = this.options;
    const denied = this.deny.find((rule) => matchesRule(rule, "deny", toolName, args, workspaceDir));
    if (denied) return `权限规则 ${denied.text} 禁止了这次调用，没有执行。不要换一种写法重试。`;
    if (!need) return true;

    if (this.isProtected(toolName, args)) {
      const warned = { ...need, title: `${need.title}（agent 的规则文件，修改后从下一个新会话起生效）` };
      return (await this.options.ask(warned, signal)).allowed;
    }

    const allowRules = [...this.allow, ...(await this.loadSaved()), ...this.sessionRules];
    const allowed = allowRules.find((rule) => matchesRule(rule, "allow", toolName, args, workspaceDir));
    if (allowed) return { autoApproved: `规则 ${allowed.text} 允许` };
    if (
      this.options.autoAllowReadOnly &&
      toolName === "run_command" &&
      typeof args.command === "string" &&
      isReadOnlyCommand(args.command)
    ) {
      return { autoApproved: "只读命令，自动运行" };
    }

    const suggestion = suggestRule(toolName, args, workspaceDir) ?? undefined;
    const decision = await this.options.ask(need, signal, suggestion);
    if (decision.allowed && decision.remember && suggestion) {
      await this.remember(parseRule(suggestion, this.options.toolNames), decision.remember);
    }
    return decision.allowed;
  }

  private isProtected(toolName: string, args: Record<string, unknown>): boolean {
    if (!FILE_TOOLS.has(toolName) || typeof args.path !== "string") return false;
    const path = workspacePath(this.options.workspaceDir, args.path)?.toLowerCase();
    // Windows paths ignore case, so AGENTS.md and agents.md are the same file.
    return (this.options.protectedPaths ?? []).some((protectedPath) => protectedPath.toLowerCase() === path);
  }

  /** Session rules belong to one conversation. */
  clearSession(): void {
    this.sessionRules.length = 0;
  }

  private async remember(rule: Rule, scope: "session" | "always"): Promise<void> {
    if (scope === "session") {
      this.sessionRules.push(rule);
      return;
    }
    const saved = await this.loadSaved();
    if (this.savedUnreadable) {
      // Still honored for now, but not written over the file the user needs to fix.
      this.sessionRules.push(rule);
      this.options.log?.(`没有保存规则 ${rule.text}：${this.options.savedRulesPath} 无法读取`);
      return;
    }
    if (saved.some((existing) => existing.text === rule.text)) return;
    saved.push(rule);
    try {
      await this.writeSaved(saved.map((existing) => existing.text));
    } catch (error) {
      this.options.log?.(`保存权限规则失败：${(error as Error).message}`);
    }
  }

  private loadSaved(): Promise<Rule[]> {
    this.saved ??= this.readSaved();
    return this.saved;
  }

  private async readSaved(): Promise<Rule[]> {
    const path = this.options.savedRulesPath;
    let text: string;
    try {
      text = (await readFile(path, "utf8")).replace(/^﻿/, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      this.savedUnreadable = true;
      this.options.log?.(`无法读取 ${path}：${(error as Error).message}`);
      return [];
    }
    try {
      const data = JSON.parse(text) as { allow?: unknown };
      if (!Array.isArray(data.allow) || !data.allow.every((rule) => typeof rule === "string")) {
        throw new Error("allow 必须是字符串数组");
      }
      return data.allow.map((rule: string) => parseRule(rule, this.options.toolNames));
    } catch (error) {
      this.savedUnreadable = true;
      this.options.log?.(`${path} 无效，已忽略其中的规则：${(error as Error).message}`);
      return [];
    }
  }

  /** Written whole and renamed into place, so a crash cannot leave half a file. */
  private async writeSaved(rules: string[]): Promise<void> {
    const path = this.options.savedRulesPath;
    const temp = `${path}.tmp`;
    await writeFile(temp, `${JSON.stringify({ allow: rules }, null, 2)}\n`, "utf8");
    await rename(temp, path);
  }
}
