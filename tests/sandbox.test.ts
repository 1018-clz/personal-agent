// Attacks the real sandbox from the inside: every command here runs in a real AppContainer.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { commandEnvironment, SandboxedShell, UnsandboxedShell } from "../src/main/sandbox/shell";

const TIMEOUT_MS = 30_000;
const SIGNAL = new AbortController().signal;
const FAKE_SECRET = "sk-must-not-leak";

let root: string;
let workspace: string;
let outside: string;
let shell: SandboxedShell;

const env = { ...process.env, DEEPSEEK_API_KEY: FAKE_SECRET, HINDSIGHT_API_LLM_API_KEY: FAKE_SECRET };

/** Runs a check that prints ALLOWED or DENIED, so a crash can never pass as a denial. */
const attempt = (script: string) => `try { ${script}; 'ALLOWED' } catch { 'DENIED' }`;

// These call .NET directly. PowerShell's own cmdlets walk the parent directories first, so
// a cmdlet being refused would not prove that the file's own ACL is what stopped it.
const readFile = (path: string) => attempt(`[IO.File]::ReadAllText('${path}')`);
const writeFile = (path: string) => attempt(`[IO.File]::WriteAllText('${path}', 'x')`);
const listDirectory = (path: string) => attempt(`[IO.Directory]::GetFileSystemEntries('${path}')`);

describe("commandEnvironment", () => {
  it("keeps what commands need and drops everything else", () => {
    const result = commandEnvironment({
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      DEEPSEEK_API_KEY: FAKE_SECRET,
      deepseek_api_key: FAKE_SECRET,
      AWS_SECRET_ACCESS_KEY: FAKE_SECRET,
      USERPROFILE: "C:\\Users\\me",
    });

    expect(result).toEqual({ Path: "C:\\Windows", SystemRoot: "C:\\Windows" });
  });
});

describe.runIf(process.platform === "win32")("SandboxedShell", () => {
  beforeAll(async () => {
    // Under the home directory: Temp is not the point, the user's own files are.
    root = mkdtempSync(join(homedir(), ".agent-sandbox-test-"));
    workspace = join(root, "workspace");
    outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "top secret");
    shell = new SandboxedShell(workspace, false, join(root, "cache"), env);
  }, TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("compiles the runner and reports exit codes", async () => {
    const output = await shell.run("'hello'; exit 3", SIGNAL);

    expect(output).toContain("退出码 3");
    expect(output).toContain("hello");
  }, TIMEOUT_MS);

  it("runs at low integrity, without the user's admin rights", async () => {
    const output = await shell.run("whoami /groups /fo csv", SIGNAL);

    expect(output).toContain("S-1-16-4096"); // Low integrity
    expect(output).not.toContain("S-1-16-8192"); // Medium integrity, the normal level
    expect(output).not.toContain("S-1-16-12288"); // High integrity, an elevated admin
  }, TIMEOUT_MS);

  it("runs in the workspace and can use it", async () => {
    const output = await shell.run("(Get-Location).ProviderPath; Set-Content -Path made.txt -Value inside", SIGNAL);

    expect(output.toLowerCase()).toContain(workspace.toLowerCase());
    expect(readFileSync(join(workspace, "made.txt"), "utf8").trim()).toBe("inside");
  }, TIMEOUT_MS);

  it("runs native programs in the workspace, including subdirectories", async () => {
    mkdirSync(join(workspace, "sub"));
    writeFileSync(join(workspace, "sub", "note.txt"), "from-note");

    const output = await shell.run("Set-Location sub; cmd /c type note.txt", SIGNAL);

    expect(output).toContain("退出码 0");
    expect(output).toContain("from-note");
  }, TIMEOUT_MS);

  it("handles a workspace path containing a quote", async () => {
    const quoted = join(root, "it's a workspace");
    mkdirSync(quoted);
    const other = new SandboxedShell(quoted, false, join(root, "cache"), env);

    await other.run("Set-Content -Path made.txt -Value ok", SIGNAL);

    expect(existsSync(join(quoted, "made.txt"))).toBe(true);
  }, TIMEOUT_MS);

  it("reads files the app wrote into the workspace", async () => {
    writeFileSync(join(workspace, "from-app.txt"), "来自应用");

    const output = await shell.run("Get-Content -Encoding UTF8 from-app.txt", SIGNAL);

    expect(output).toContain("来自应用");
  }, TIMEOUT_MS);

  it("keeps Chinese output intact", async () => {
    await expect(shell.run("'你好，世界'", SIGNAL)).resolves.toContain("你好，世界");
  }, TIMEOUT_MS);

  it("gets a private temp directory it can write to", async () => {
    const output = await shell.run(
      "$env:TEMP; Set-Content -Path (Join-Path $env:TEMP 't.txt') -Value temp-ok; Get-Content (Join-Path $env:TEMP 't.txt')",
      SIGNAL,
    );

    expect(output).toContain("temp-ok");
    expect(output.toLowerCase()).toMatch(/packages\\personalagent\.sandbox\\ac\\temp/);
    expect(output.toLowerCase().match(/packages\\personalagent/g)).toHaveLength(1);
  }, TIMEOUT_MS);

  it("can reach the workspace by absolute path, which makes the denials below meaningful", async () => {
    writeFileSync(join(workspace, "control.txt"), "control");

    await expect(shell.run(readFile(join(workspace, "control.txt")), SIGNAL)).resolves.toContain("ALLOWED");
    await expect(shell.run(writeFile(join(workspace, "control-out.txt")), SIGNAL)).resolves.toContain("ALLOWED");
    await expect(shell.run(listDirectory(workspace), SIGNAL)).resolves.toContain("ALLOWED");
  }, TIMEOUT_MS);

  it("cannot read files outside the workspace", async () => {
    const output = await shell.run(readFile(join(outside, "secret.txt")), SIGNAL);

    expect(output).toContain("DENIED");
    expect(output).not.toContain("top secret");
  }, TIMEOUT_MS);

  it("cannot list or write the user's home", async () => {
    const target = join(outside, "pwned.txt");

    await expect(shell.run(listDirectory(homedir()), SIGNAL)).resolves.toContain("DENIED");
    await expect(shell.run(writeFile(target), SIGNAL)).resolves.toContain("DENIED");
    expect(existsSync(target)).toBe(false);
  }, TIMEOUT_MS);

  it("cannot escape through a junction inside the workspace", async () => {
    symlinkSync(outside, join(workspace, "escape"), "junction");

    const output = await shell.run(readFile(join(workspace, "escape", "secret.txt")), SIGNAL);

    expect(output).toContain("DENIED");
    expect(output).not.toContain("top secret");
  }, TIMEOUT_MS);

  it("cannot write into the system directories", async () => {
    await expect(shell.run(writeFile("C:\\Windows\\sandbox-test.txt"), SIGNAL)).resolves.toContain("DENIED");
  }, TIMEOUT_MS);

  it("sees no secrets in its environment", async () => {
    const output = await shell.run("Get-ChildItem Env: | % { $_.Name + '=' + $_.Value }", SIGNAL);

    expect(output).toContain("退出码 0");
    expect(output).toMatch(/SystemRoot=/i);
    expect(output).not.toContain(FAKE_SECRET);
    expect(output).not.toMatch(/DEEPSEEK_API_KEY/i);
    expect(output.toLowerCase()).not.toContain(`userprofile=${homedir().toLowerCase()}\r`);
  }, TIMEOUT_MS);

  it("cannot reach AppData, where config.json keeps the API key", async () => {
    const appData = join(homedir(), "AppData", "Roaming");

    await expect(shell.run(listDirectory(appData), SIGNAL)).resolves.toContain("DENIED");
  }, TIMEOUT_MS);

  // A known gap, pinned here so that a change in either direction gets noticed. Windows
  // grants this key to all app packages, which is why API keys must not be stored with setx.
  it("KNOWN GAP: can still read HKCU\\Environment", async () => {
    const output = await shell.run(
      attempt("Get-ItemProperty -ErrorAction Stop HKCU:\\Environment | Out-Null"),
      SIGNAL,
    );

    expect(output).toContain("ALLOWED");
  }, TIMEOUT_MS);

  it("cannot browse the user's registry", async () => {
    const output = await shell.run(
      attempt("Get-ChildItem -ErrorAction Stop HKCU:\\Software | Out-Null"),
      SIGNAL,
    );

    expect(output).toContain("DENIED");
  }, TIMEOUT_MS);

  it("reports errors as readable text", async () => {
    const output = await shell.run("Get-Item -Path no-such-file.txt", SIGNAL);

    expect(output).not.toContain("CLIXML");
    expect(output).toContain("no-such-file.txt");
  }, TIMEOUT_MS);

  describe("network", () => {
    let server: Server;
    let port: number;
    const connect = (host: string, target: number) =>
      attempt(
        `$c = New-Object Net.Sockets.TcpClient; $t = $c.ConnectAsync('${host}', ${target}); ` +
          `if (-not $t.Wait(5000)) { throw 'timeout' }`,
      );

    beforeAll(async () => {
      server = createServer((socket) => socket.end());
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(() => {
      server.close();
    });

    it("cannot reach the internet by default", async () => {
      await expect(shell.run(connect("1.1.1.1", 443), SIGNAL)).resolves.toContain("DENIED");
    }, TIMEOUT_MS);

    it("cannot reach local services such as Hindsight", async () => {
      await expect(shell.run(connect("127.0.0.1", port), SIGNAL)).resolves.toContain("DENIED");
    }, TIMEOUT_MS);

    it("can reach the internet only when configured to", async () => {
      const online = new SandboxedShell(workspace, true, join(root, "cache"), env);

      await expect(online.run(connect("1.1.1.1", 443), SIGNAL)).resolves.toContain("ALLOWED");
      await expect(online.run(connect("127.0.0.1", port), SIGNAL)).resolves.toContain("DENIED");
    }, TIMEOUT_MS);
  });

  it("kills background processes when the command ends", async () => {
    const start = (file: string, wait: string) =>
      `$p = Start-Process cmd -WorkingDirectory ([Environment]::CurrentDirectory) -WindowStyle Hidden -PassThru ` +
      `-ArgumentList '/c','ping -n 3 127.0.0.1 >nul & echo alive>${file}'; ${wait}`;

    // Control: a child that is waited for does finish, so a missing file below means killed.
    await shell.run(start("waited.txt", "$p.WaitForExit()"), SIGNAL);
    expect(existsSync(join(workspace, "waited.txt"))).toBe(true);

    await shell.run(start("survivor.txt", ""), SIGNAL);
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    expect(existsSync(join(workspace, "survivor.txt"))).toBe(false);
  }, TIMEOUT_MS);

  it("stops the whole process tree on cancel", async () => {
    const abort = new AbortController();
    const running = shell.run("Start-Sleep -Seconds 4; Set-Content -Path after-cancel.txt -Value alive", abort.signal);

    setTimeout(() => abort.abort(), 1_500);

    await expect(running).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(existsSync(join(workspace, "after-cancel.txt"))).toBe(false);
  }, TIMEOUT_MS);

  it("limits how many processes a command can start", async () => {
    const output = await shell.run(
      "$started = 0; try { 1..200 | % { Start-Process cmd -ArgumentList '/c','ping -n 20 127.0.0.1' -WindowStyle Hidden -ErrorAction Stop; $started++ } } catch {}; \"STARTED=$started\"",
      SIGNAL,
    );

    const started = Number(/STARTED=(\d+)/.exec(output)?.[1]);
    expect(started).toBeGreaterThan(10);
    expect(started).toBeLessThan(200);
  }, TIMEOUT_MS);

  it("fails closed instead of running without isolation", async () => {
    const missing = new SandboxedShell(join(root, "does-not-exist"), false, join(root, "cache"), env);

    await expect(missing.run("'should not run'", SIGNAL)).rejects.toThrow();
  }, TIMEOUT_MS);

  it("rejects commands too long for the command line", async () => {
    await expect(shell.run("x".repeat(20_000), SIGNAL)).rejects.toThrow(/过长/);
  }, TIMEOUT_MS);
});

describe.runIf(process.platform === "win32")("UnsandboxedShell", () => {
  it("still never passes API keys to commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-shell-"));
    try {
      const output = await new UnsandboxedShell(dir, env).run("Get-ChildItem Env: | % { $_.Name + '=' + $_.Value }", SIGNAL);

      expect(output).toContain("退出码 0");
      expect(output).not.toContain(FAKE_SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
