import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";

import { isOpenableUrl } from "../shared/links";
import { IPC, type AppEvent, type InstallTarget, type ModelSettingsInput, type PermissionAnswer } from "../shared/types";
import { AppController } from "./app-controller";
import { configFilePath, loadConfig } from "./config";
import type { Cipher } from "./secrets";

const QUIT_SAVE_TIMEOUT_MS = 3_000;

let window: BrowserWindow | null = null;
let controller: AppController | null = null;
let quitting = false;

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    title: "Personal Agent",
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The transcript shows untrusted model output, so it must never become a browser.
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  created.webContents.on("will-navigate", (event) => event.preventDefault());

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void created.loadURL(devUrl);
  else void created.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  return created;
}

/** Windows DPAPI through Electron: only this Windows account can decrypt what it encrypts. */
const cipher: Cipher = {
  available: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptStringAsync(text),
  decrypt: async (data) => {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(data);
    return { text: result, stale: shouldReEncrypt };
  },
};

/** Job ids go to the HFSS server as arguments: only its own format passes. */
function checkedJobId(jobId: unknown): string {
  if (typeof jobId !== "string" || !/^j\d{8}-\d{6}-[0-9a-f]{4}$/.test(jobId)) throw new Error("任务号不对");
  return jobId;
}

/** The renderer is not trusted to send well-formed settings; the controller validates the fields. */
function settingsInput(input: unknown): ModelSettingsInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("设置格式不对");
  return input as ModelSettingsInput;
}

function registerIpc(current: AppController): void {
  ipcMain.handle(IPC.sendPrompt, (_event, text: unknown) => {
    if (typeof text !== "string" || !text.trim()) throw new Error("消息不能为空");
    return current.sendPrompt(text);
  });
  ipcMain.handle(IPC.cancelTurn, () => current.cancelTurn());
  ipcMain.handle(IPC.newSession, () => current.newSession());
  ipcMain.handle(IPC.openSession, (_event, sessionId: string) => current.openSession(sessionId));
  ipcMain.handle(IPC.deleteSession, (_event, sessionId: string) =>
    current.deleteSession(sessionId),
  );
  ipcMain.handle(IPC.answerPermission, (_event, answer: PermissionAnswer) =>
    current.answerPermission(answer),
  );
  ipcMain.handle(IPC.getModelSettings, () => current.getModelSettings());
  ipcMain.handle(IPC.saveModelSettings, (_event, input: unknown) => current.saveModelSettings(settingsInput(input)));
  ipcMain.handle(IPC.testModelSettings, (_event, input: unknown) => current.testModelSettings(settingsInput(input)));
  ipcMain.handle(IPC.listModels, (_event, input: unknown) => current.listModels(settingsInput(input)));
  // Checked again here: the renderer shows untrusted text and must not widen this.
  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => {
    if (typeof url !== "string" || !isOpenableUrl(url)) throw new Error("只能打开 http 或 https 链接");
    return shell.openExternal(url);
  });
  ipcMain.handle(IPC.cancelHfssJob, (_event, jobId: unknown) => current.cancelHfssJob(checkedJobId(jobId)));
  ipcMain.handle(IPC.getHfssCurves, (_event, jobId: unknown) => current.getHfssCurves(checkedJobId(jobId)));
  ipcMain.handle(IPC.setAutoAnalyze, (_event, on: unknown) => current.setAutoAnalyze(on === true));
  ipcMain.handle(IPC.checkSetup, () => current.checkSetup());
  ipcMain.handle(IPC.install, (_event, target: unknown) => {
    if (target !== "install-hfss" && target !== "install-memory") throw new Error("不知道要安装什么");
    return current.install(target as InstallTarget);
  });
  ipcMain.on(IPC.rendererReady, () => current.rendererReady());
}

async function main(): Promise<void> {
  await app.whenReady();

  const config = await loadConfig({
    userDataDir: app.getPath("userData"),
    homeDir: homedir(),
    env: process.env,
  });

  controller = new AppController(
    config,
    (event: AppEvent) => {
      if (window && !window.isDestroyed()) window.webContents.send(IPC.event, event);
    },
    process.argv.includes("--fake-model"),
    {
      sandboxCacheDir: join(app.getPath("userData"), "sandbox"),
      sessionsDir: join(app.getPath("userData"), "sessions"),
      // In development both are the project folder. Installed, the program folder is read-only, so
      // the code ships as resources and the Python environments go to the local profile.
      resourcesDir: app.isPackaged ? process.resourcesPath : app.getAppPath(),
      runtimeDir: app.isPackaged
        ? join(process.env.LOCALAPPDATA ?? app.getPath("userData"), "personal-agent", "runtime")
        : app.getAppPath(),
      preferencesFile: join(app.getPath("userData"), "preferences.json"),
      awaitedJobsFile: join(app.getPath("userData"), "hfss-awaited.json"),
      logsDir: join(app.getPath("userData"), "logs"),
      permissionsFile: join(app.getPath("userData"), "permissions.json"),
      globalInstructionsFile: join(app.getPath("userData"), "AGENTS.md"),
      configFile: configFilePath(app.getPath("userData")),
      secretsFile: join(app.getPath("userData"), "secrets.json"),
      // Simulation results can reach many GB: keep them out of the roaming profile.
      hfssDataDir: join(process.env.LOCALAPPDATA ?? app.getPath("userData"), "personal-agent", "hfss"),
    },
    cipher,
  );
  registerIpc(controller);
  window = createWindow();
}

// One data folder for the installed app and development: Electron would otherwise name it after
// the product name ("Personal Agent") once installed, and the settings would not carry over.
// Set before the single-instance lock, which lives in this folder.
app.setPath("userData", join(app.getPath("appData"), "personal-agent"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting || !controller) return;
    // Held open for the last save, but never for long: a stuck disk must not block quitting.
    event.preventDefault();
    quitting = true;
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_SAVE_TIMEOUT_MS));
    void Promise.all([
      Promise.race([controller.shutdown(), timeout]),
      // Bounded on its own: it kills Hindsight if a clean stop takes too long.
      controller.stopMemoryServer(),
      controller.stopToolServers(),
    ]).finally(() => app.quit());
  });

  main().catch((error: unknown) => {
    dialog.showErrorBox("Personal Agent 启动失败", String(error));
    app.quit();
  });
}
