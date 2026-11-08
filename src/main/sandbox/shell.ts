import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import runnerSource from "../../../native/sandbox-runner.cs?raw";

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;
/** CreateProcess takes at most 32,767 characters, and the rest of the line needs some. */
const MAX_COMMAND_LINE_CHARS = 30_000;
const CONTAINER_NAME = "PersonalAgent.Sandbox";
const SETUP_FAILED_EXIT_CODE = 125;

/** Windows reads these case-insensitively, so filtering by exact name is not enough. */
const ALLOWED_ENV = new Set(
  [
    "ComSpec",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "PSModulePath",
    "SystemDrive",
    "SystemRoot",
    "windir",
  ].map((name) => name.toUpperCase()),
);

/** Commands run with an allowlist, never process.env, which holds the API keys. */
export function commandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => ALLOWED_ENV.has(name.toUpperCase())),
  );
}

function quotePowerShell(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * Wraps a script so it survives the command line without any quoting.
 *
 * This is not -EncodedCommand because that forces CLIXML on stderr, whatever -OutputFormat says.
 * Windows PowerShell defaults to the OEM code page, which would garble non-ASCII output.
 */
export function powershellCommand(script: string, workspaceDir: string): string {
  const full = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$OutputEncoding = [Console]::OutputEncoding",
    // Set-Location checks every parent directory, which the sandbox cannot read, and
    // PowerShell then falls back to C:\. A drive rooted at the workspace needs no parents.
    `New-PSDrive -Name Work -PSProvider FileSystem -Root ${quotePowerShell(workspaceDir)} -ErrorAction Stop | Out-Null`,
    "Set-Location Work:\\ -ErrorAction Stop",
    script,
  ].join("\n");
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  return `& ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
}

export interface Shell {
  /** Shown to the user before they approve a command. */
  readonly description: string;
  run(command: string, signal: AbortSignal): Promise<string>;
}

function collectOutput(
  child: ChildProcess,
  kill: () => void,
  signal: AbortSignal,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let output = "";
    const append = (chunk: string) => {
      output = (output + chunk).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout?.setEncoding("utf8").on("data", append);
    child.stderr?.setEncoding("utf8").on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, COMMAND_TIMEOUT_MS);
    signal.addEventListener("abort", kill, { once: true });

    const cleanUp = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
    };
    child.on("error", (error) => {
      cleanUp();
      reject(error);
    });
    child.on("close", (code) => {
      cleanUp();
      if (signal.aborted) reject(new DOMException("命令已取消", "AbortError"));
      else resolve({ code, output, timedOut });
    });
  });
}

function formatResult(code: number | null, output: string, timedOut: boolean): string {
  if (timedOut) return `命令超时，已终止。\n${output}`;
  return `退出码 ${code}\n${output}`;
}

/** Runs PowerShell inside an AppContainer and Job Object, via native/sandbox-runner.cs. */
export class SandboxedShell implements Shell {
  private runner: Promise<string> | null = null;

  constructor(
    private readonly workspaceDir: string,
    private readonly network: boolean,
    private readonly cacheDir: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  get description(): string {
    return this.network
      ? "将在沙箱中运行：只能访问工作目录，允许联网"
      : "将在沙箱中运行：只能访问工作目录，不能联网";
  }

  async run(command: string, signal: AbortSignal): Promise<string> {
    const script = powershellCommand(command, this.workspaceDir);
    if (script.length > MAX_COMMAND_LINE_CHARS) throw new Error("命令过长，请写入脚本文件后再运行");

    const runner = await this.ensureRunner();
    const child = spawn(
      runner,
      [CONTAINER_NAME, this.workspaceDir, this.network ? "network" : "no-network", script],
      {
        cwd: this.workspaceDir,
        env: commandEnvironment(this.env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    // Killing the runner closes its job, and the job takes the whole process tree with it.
    const { code, output, timedOut } = await collectOutput(child, () => child.kill(), signal);
    if (code === SETUP_FAILED_EXIT_CODE) throw new Error(`沙箱启动失败，命令没有运行：${output.trim()}`);
    return formatResult(code, output, timedOut);
  }

  private ensureRunner(): Promise<string> {
    this.runner ??= this.compileRunner().catch((error: unknown) => {
      this.runner = null;
      throw error;
    });
    return this.runner;
  }

  private async compileRunner(): Promise<string> {
    if (process.platform !== "win32") throw new Error("命令沙箱目前只支持 Windows");

    const hash = createHash("sha256").update(runnerSource).digest("hex").slice(0, 16);
    const path = join(this.cacheDir, `sandbox-runner-${hash}.exe`);
    if (await exists(path)) return path;

    await mkdir(this.cacheDir, { recursive: true });
    const source = join(this.cacheDir, `sandbox-runner-${hash}.cs`);
    await writeFile(source, runnerSource);

    const csc = join(this.env.windir ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const output = `${path}.tmp`;
    try {
      await promisify(execFile)(
        csc,
        ["/nologo", "/optimize+", "/target:exe", "/reference:System.Core.dll", `/out:${output}`, source],
        { windowsHide: true },
      );
    } catch (error) {
      throw new Error(`沙箱编译失败，命令没有运行：${(error as Error).message}`);
    }
    await rename(output, path);
    return path;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Only used when the user turns the sandbox off in config.json. */
export class UnsandboxedShell implements Shell {
  readonly description = "警告：沙箱已关闭，命令将以你的用户权限运行";

  constructor(
    private readonly workspaceDir: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async run(command: string, signal: AbortSignal): Promise<string> {
    const windows = process.platform === "win32";
    const child = windows
      ? spawn(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-Command",
            powershellCommand(command, this.workspaceDir),
          ],
          { cwd: this.workspaceDir, env: commandEnvironment(this.env), windowsHide: true },
        )
      : spawn("sh", ["-c", command], { cwd: this.workspaceDir, env: commandEnvironment(this.env) });

    const kill = () => {
      if (windows && child.pid !== undefined) {
        // child.kill() on Windows would leave anything the shell started running.
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill();
      }
    };
    const { code, output, timedOut } = await collectOutput(child, kill, signal);
    return formatResult(code, output, timedOut);
  }
}
