import { isAbsolute, relative, resolve, sep } from "node:path";

import { globToRegex } from "../agent/search";
import { isSingleCommand, normalizeCommand, splitSimpleCommand } from "./command";

// A rule is a tool name, optionally with a pattern: run_command(git status *), edit_file(notes/**).
// Only the tools that change things take a pattern, because only their arguments say what changes.
const COMMAND_TOOL = "run_command";
const PATH_TOOLS = new Set(["write_file", "edit_file"]);

export interface Rule {
  text: string;
  tool: string;
  pattern?: string;
}

/** server__tool: an MCP tool, which only exists once its server has started. */
export function isMcpToolName(name: string): boolean {
  return /^[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(name);
}

export function parseRule(text: string, toolNames: readonly string[]): Rule {
  const match = /^\s*([A-Za-z0-9_-]+)\s*(?:\((.*)\))?\s*$/s.exec(text);
  if (!match) throw new Error(`权限规则格式不对：${text}，应该是 工具名 或 工具名(模式)`);
  const tool = match[1]!;
  const pattern = match[2]?.trim();
  // MCP tools are checked by shape: they are not known yet when the rules are read at startup.
  if (!toolNames.includes(tool) && !isMcpToolName(tool)) throw new Error(`权限规则里的工具不存在：${text}`);
  if (pattern !== undefined) {
    if (!pattern) throw new Error(`权限规则的括号里不能为空：${text}`);
    if (tool !== COMMAND_TOOL && !PATH_TOOLS.has(tool)) {
      throw new Error(`只有 run_command、write_file 和 edit_file 的规则可以带模式：${text}`);
    }
  }
  return { text: text.trim(), tool, ...(pattern === undefined ? {} : { pattern }) };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** * matches anything, and a trailing " *" also matches nothing, so "git status *" covers "git status". */
function commandRegex(pattern: string): RegExp {
  let body = normalizeCommand(pattern);
  const optionalTail = body.endsWith(" *");
  if (optionalTail) body = body.slice(0, -2);
  const source = body.split("*").map(escapeRegex).join(".*");
  // PowerShell ignores case, so a deny rule must too.
  return new RegExp(`^${source}${optionalTail ? "(?: .*)?" : ""}$`, "is");
}

/** The path relative to the workspace with / separators, or null when it points outside. */
export function workspacePath(workspaceDir: string, path: string): string | null {
  const root = resolve(workspaceDir);
  const rel = relative(root, resolve(root, path));
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join("/");
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, "/").replace(/^\.\//, "");
}

export type RuleKind = "allow" | "deny";

/**
 * An allow rule with a wildcard only covers a single command: "git status *" must not approve
 * "git status; Remove-Item x". A deny rule is checked against every statement it can find.
 */
export function matchesRule(
  rule: Rule,
  kind: RuleKind,
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir: string,
): boolean {
  if (rule.tool !== toolName) return false;
  if (rule.pattern === undefined) return true;

  if (toolName === COMMAND_TOOL) {
    if (typeof args.command !== "string") return false;
    const command = normalizeCommand(args.command);
    const regex = commandRegex(rule.pattern);
    if (kind === "allow") {
      if (!rule.pattern.includes("*")) return command.toLowerCase() === normalizeCommand(rule.pattern).toLowerCase();
      return isSingleCommand(command) && regex.test(command);
    }
    // Best effort: PowerShell has aliases and many ways to hide a command. The sandbox is the
    // boundary; a deny rule only stops the obvious forms.
    const parts = command.split(/[;|&\r\n]+/).map((part) => part.trim().replace(/^[&.(\s]+/, ""));
    return regex.test(command) || parts.some((part) => regex.test(normalizeCommand(part)));
  }

  if (typeof args.path !== "string") return false;
  const path = workspacePath(workspaceDir, args.path);
  if (path === null) return false;
  return globToRegex(normalizePattern(rule.pattern)).test(path);
}

/** Starting programs this way can run anything, so a remembered rule names the exact command. */
const INTERPRETERS = new Set(
  [
    "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe",
    "python", "python3", "py", "node", "bash", "sh", "wsl",
    "Invoke-Expression", "iex", "Invoke-Command", "icm", "Start-Process", "saps", "start",
  ].map((name) => name.toLowerCase()),
);

/** The rule offered when the user chooses to stop being asked, or null when none is safe. */
export function suggestRule(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir: string,
): string | null {
  if (toolName === COMMAND_TOOL) {
    if (typeof args.command !== "string") return null;
    const command = normalizeCommand(args.command);
    const segments = splitSimpleCommand(command);
    if (segments?.length !== 1) return null;

    const [program, second] = command.split(" ");
    const exact = `${COMMAND_TOOL}(${command})`;
    if (INTERPRETERS.has(program!.toLowerCase())) return command.includes("*") ? null : exact;
    if (second === undefined) return `${COMMAND_TOOL}(${program} *)`;
    // "git commit -m x" becomes "git commit *"; "git -c x=y status" stays exact.
    if (/^[A-Za-z][\w.-]*$/.test(second)) return `${COMMAND_TOOL}(${program} ${second} *)`;
    return command.includes("*") ? null : exact;
  }

  // An MCP tool takes whatever arguments its server defines, so the whole tool is what can be remembered.
  if (isMcpToolName(toolName)) return toolName;

  if (PATH_TOOLS.has(toolName) && typeof args.path === "string") {
    const path = workspacePath(workspaceDir, args.path);
    if (path === null || /[*?{}]/.test(path)) return null;
    return `${toolName}(${path})`;
  }
  return null;
}
