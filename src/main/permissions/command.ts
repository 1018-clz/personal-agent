// A deliberately small reading of PowerShell, used to decide what may run without asking.
// It never has to understand a command: anything it is unsure about is "not simple", and a
// command that is not simple is always put to the user.

/**
 * Outside quotes, these can run code, redirect output or hide the real command:
 * & call, > < redirection, $ variables and $(…), (…) and @(…) subexpressions, {…} script blocks,
 * […] type literals, ` escapes, # comments, % (ForEach-Object and --% stop parsing).
 */
const UNSAFE_OUTSIDE_QUOTES = new Set([..."&<>$(){}[]@`#%"]);
/** Inside double quotes, PowerShell still expands $ and ` escapes. */
const UNSAFE_IN_DOUBLE_QUOTES = new Set(["$", "`"]);
/** PowerShell also accepts curly quotes as quotes, which would let a string end where we did not expect. */
const CURLY_QUOTES = new Set([..."‘’‚‛“”„"]);

/**
 * Splits a command at unquoted ; | and line breaks, or returns null when it holds anything that
 * is not plain words, quoted strings and those separators.
 */
export function splitSimpleCommand(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (CURLY_QUOTES.has(char)) return null;

    if (quote === "'") {
      if (char === "'") quote = null;
    } else if (quote === '"') {
      if (UNSAFE_IN_DOUBLE_QUOTES.has(char)) return null;
      if (char === '"') quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ";" || char === "|" || char === "\n" || char === "\r") {
      segments.push(current);
      current = "";
      continue;
    } else if (UNSAFE_OUTSIDE_QUOTES.has(char)) {
      return null;
    }
    current += char;
  }

  if (quote) return null;
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** One command with no pipeline or second statement, so a prefix rule describes all of it. */
export function isSingleCommand(command: string): boolean {
  return splitSimpleCommand(command)?.length === 1;
}

/** Cmdlets and their built-in aliases that only read and print. None of them writes or deletes. */
const READ_ONLY_COMMANDS = new Set(
  [
    "Get-ChildItem", "gci", "ls", "dir",
    "Get-Content", "gc", "cat", "type",
    "Get-Item", "gi",
    "Test-Path",
    "Resolve-Path", "rvpa",
    "Split-Path",
    "Join-Path",
    "Get-Location", "gl", "pwd",
    "Select-String", "sls",
    "Select-Object", "select",
    "Sort-Object", "sort",
    "Measure-Object", "measure",
    "Group-Object", "group",
    "Where-Object", "where",
    "Format-Table", "ft",
    "Format-List", "fl",
    "Format-Wide", "fw",
    "Out-String",
    "Get-FileHash",
    "Get-Date",
    "Get-Unique",
    "Compare-Object", "compare",
    "Write-Output", "echo", "write",
    "Get-Member", "gm",
  ].map((name) => name.toLowerCase()),
);

/**
 * True when every statement and pipeline stage is a read-only cmdlet. Script blocks are
 * rejected by splitSimpleCommand, so Where-Object and Sort-Object cannot carry code in.
 */
export function isReadOnlyCommand(command: string): boolean {
  // Reading is only harmless inside the sandbox's view of the workspace. Anywhere in the command,
  // quoted or not: : names a drive (HKCU:, Env:, C:), ~ the user's home, \\ another machine.
  if (/[:~]|\\\\/.test(command)) return false;
  const segments = splitSimpleCommand(command);
  if (!segments?.length) return false;
  return segments.every((segment) => {
    const name = segment.split(/\s+/, 1)[0]!.toLowerCase();
    return READ_ONLY_COMMANDS.has(name);
  });
}

/** Collapses runs of spaces, so rules do not depend on how the model spaced a command. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/[ \t]+/g, " ");
}
