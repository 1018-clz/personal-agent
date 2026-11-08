import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { findPreset } from "../shared/providers";
import type {
  AgentStatus,
  AppEvent,
  HfssCurves,
  InstallTarget,
  MemoryStatus,
  ModelSettingsInput,
  ModelSettingsView,
  ModelTestResult,
  PermissionAnswer,
  SetupItem,
  SetupReport,
  ToolServerStatus,
} from "../shared/types";
import { Agent } from "./agent/agent";
import { compactionPolicy } from "./agent/compaction";
import { FakeModel } from "./agent/fake-model";
import {
  formatInstructions,
  loadInstructions,
  WORKSPACE_INSTRUCTIONS_FILE,
  type InstructionSource,
} from "./agent/instructions";
import { SwitchableModel } from "./agent/switchable-model";
import { buildSystemPrompt } from "./agent/system-prompt";
import { createTools, type Tool } from "./agent/tools";
import type { AppConfig } from "./config";
import {
  findHindsight,
  HindsightServer,
  killProcessTree,
  launchHindsight,
  type HindsightLlm,
  type ServerState,
} from "./hindsight-server";
import { HFSS_SERVER, hfssGuidance, HfssService } from "./hfss/hfss-service";
import { McpHub, type McpServerConfig } from "./mcp/hub";
import { MemoryService } from "./memory-service";
import { createModelClient, ModelSettings, type ActiveModel } from "./model-settings";
import { PermissionBroker } from "./permission-broker";
import { PermissionGate } from "./permissions/gate";
import { PreferenceStore } from "./preferences";
import { SandboxedShell, UnsandboxedShell } from "./sandbox/shell";
import type { Cipher } from "./secrets";
import { SecretStore } from "./secrets";
import { SessionRecorder } from "./session-recorder";
import { SessionStore } from "./session-store";
import { TurnOrchestrator } from "./turn-orchestrator";

const MEMORY_NEEDS_MODEL = "记忆需要模型 API 提取事实：请先在「模型设置」里填写";
const MEMORY_LABEL: Record<MemoryStatus, string> = { disabled: "已关闭", starting: "启动中", online: "在线", offline: "离线" };
/** The first session waits this long for the tool servers, so its prompt can describe them. */
const TOOL_SERVERS_WAIT_MS = 20_000;

/** Secrets never reach a tool server: it is a separate program and does not need them. */
function serverEnvironment(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([name]) => !/(API_KEY|SECRET|TOKEN|PASSWORD)/i.test(name)),
  );
  return { ...clean, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...extra };
}

export interface AppPaths {
  sandboxCacheDir: string;
  sessionsDir: string;
  /** The app's own files it runs but never writes: hfss/ (the tool server) and scripts/. */
  resourcesDir: string;
  /** Where the installers put the Python environments: .hfss\env and .hindsight. Writable. */
  runtimeDir: string;
  /** Choices made in the app's UI, such as reporting finished jobs back to the model. */
  preferencesFile: string;
  /** Jobs the model submitted and has not been told about, kept across restarts. */
  awaitedJobsFile: string;
  logsDir: string;
  /** Rules the user chose to always allow; outside the workspace, so the agent cannot edit it. */
  permissionsFile: string;
  /** The user's own AGENTS.md, outside the workspace, so the agent cannot edit it. */
  globalInstructionsFile: string;
  /** config.json, which the settings page writes the model section of. */
  configFile: string;
  /** Encrypted API keys. */
  secretsFile: string;
  /** Where HFSS jobs, results and snapshots go unless config.json says otherwise. Local, not roaming. */
  hfssDataDir: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The port to start Hindsight on, or null when baseUrl points at another machine. */
function localPort(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return null;
  }
}

/** Hindsight extracts facts with the same model the user chose for the agent. */
function hindsightLlm({ config, apiKey }: ActiveModel): HindsightLlm | null {
  if (!apiKey) return null;
  const provider = findPreset(config.provider).hindsightProvider;
  return { provider, model: config.model, apiKey, ...(provider === "openai" ? { baseUrl: config.baseUrl } : {}) };
}

function sameLlm(a: HindsightLlm | null, b: HindsightLlm | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Wires the services together and remembers what a reloaded renderer needs. */
export class AppController {
  private readonly broker: PermissionBroker;
  private readonly gate: PermissionGate;
  private readonly store: SessionStore;
  private readonly orchestrator: TurnOrchestrator;
  private readonly recorder: SessionRecorder;
  private readonly memory: MemoryService;
  /** Not readonly: installing Hindsight from the setup dialog creates it. */
  private memoryServer: HindsightServer | null = null;
  private readonly model = new SwitchableModel();
  private readonly modelSettings: ModelSettings;
  private readonly agent: Agent;
  private readonly toolServers: McpHub;
  private readonly hfss: HfssService;
  private readonly preferences: PreferenceStore;
  /** The agent's tool list. Tool servers add theirs once they have started. */
  private readonly tools: Tool[];
  private toolServerStatus: ToolServerStatus[] = [];
  /** Why the app cannot start Hindsight itself, when it was meant to. */
  private memoryServerProblem: string | null = null;
  private memoryServerState: ServerState | null = null;
  /** The model the running Hindsight was started with, to know when it needs a restart. */
  private memoryServerLlm: HindsightLlm | null = null;
  private agentStatus: { status: AgentStatus; message?: string } = { status: "stopped" };
  private memoryStatus: { status: MemoryStatus; message?: string } = { status: "offline" };
  /** Null until the saved settings are read: saying "not configured" before that opens the settings page for nothing. */
  private modelStatus: { configured: boolean; label?: string } | null = null;
  private booted = false;

  constructor(
    private readonly config: AppConfig,
    private readonly send: (event: AppEvent) => void,
    private readonly fakeModel: boolean,
    paths: AppPaths,
    cipher: Cipher,
  ) {
    const emit = (event: AppEvent) => this.emit(event);
    this.store = new SessionStore(paths.sessionsDir);
    this.recorder = new SessionRecorder(this.store, () => this.agent.takeUnsavedHistory(), emit);
    this.broker = new PermissionBroker(emit, randomUUID);
    this.modelSettings = new ModelSettings({
      configPath: paths.configFile,
      secrets: new SecretStore(paths.secretsFile, cipher),
      initial: config.model,
    });
    if (fakeModel) this.model.set(new FakeModel());

    this.paths = paths;
    this.preferences = new PreferenceStore(paths.preferencesFile);
    const memory = new MemoryService(config.hindsight, (status, message) => {
      // Until the service the app started answers, a refused connection only means it is loading.
      if (status === "offline" && this.memoryServerState === "starting") return;
      this.setMemoryStatus(status, message);
    });
    this.memory = memory;
    this.memoryServer = this.createMemoryServer(paths);

    const { enabled, network } = config.sandbox;
    this.toolServers = new McpHub(this.toolServerConfigs(paths), (servers) => {
      this.toolServerStatus = servers;
      this.send({ type: "tool-servers", servers });
    });
    const tools = createTools({
      workspaceDir: config.workspaceDir,
      shell: enabled
        ? new SandboxedShell(config.workspaceDir, network, paths.sandboxCacheDir, process.env)
        : new UnsandboxedShell(config.workspaceDir, process.env),
      searchMemory: async (query) => (await memory.search(query)).map((result) => result.text),
    });
    this.tools = tools;
    this.gate = new PermissionGate({
      workspaceDir: config.workspaceDir,
      toolNames: tools.map((tool) => tool.definition.name),
      allow: config.permissions.allow,
      deny: config.permissions.deny,
      // Outside the sandbox a "read-only" command could read any of the user's files.
      autoAllowReadOnly: config.permissions.autoAllowReadOnly && enabled,
      savedRulesPath: paths.permissionsFile,
      // The agent's own instructions: never changed without the user seeing the edit.
      protectedPaths: [WORKSPACE_INSTRUCTIONS_FILE],
      ask: (need, signal, rememberRule) => this.broker.request(need, signal, rememberRule),
      log: (message) => this.emit({ type: "notice", message }),
    });
    const gate = this.gate;
    this.agent = new Agent(
      this.model,
      tools,
      {
        onUpdate: (update) => {
          this.hfss.observe(update);
          this.orchestrator.handleUpdate(update);
        },
        requestPermission: (request, signal) => gate.check(request, signal),
      },
      compactionPolicy(config.model.compactAtTokens, config.model.contextWindow),
    );
    this.orchestrator = new TurnOrchestrator(
      this.agent,
      memory,
      (memoryRules) => this.buildSystemPrompt(memoryRules, paths.globalInstructionsFile),
      emit,
      randomUUID,
      {
        onTurnStart: (userText) => this.hfss.beginTurn(userText),
        onTurnEnd: (turnId, reply) => this.hfss.endTurn(turnId, reply),
      },
    );
    this.hfss = new HfssService({
      ready: () => this.toolServers.isReady(HFSS_SERVER),
      call: (tool, args) => this.toolServers.callTool(HFSS_SERVER, tool, args),
      restartServer: () => this.restartHfss(),
      emit,
      sessionId: () => this.orchestrator.currentSessionId,
      busy: () => this.orchestrator.busy || this.agentStatus.status !== "ready" || !this.modelStatus?.configured,
      startAutoTurn: (text) => this.runTurn(text, true),
      refreshPrompt: () => void this.orchestrator.refreshSystemPrompt(),
      autoAnalyze: {
        get: () => this.preferences.current.hfssAutoAnalyze,
        set: (on) => this.preferences.set({ hfssAutoAnalyze: on }),
      },
      localChecks: () => this.localChecks(),
      installer: (target) => this.installer(target),
      afterInstall: (target) => this.afterInstall(target),
      awaitedStore: {
        load: async () => {
          const parsed: unknown = JSON.parse(await readFile(paths.awaitedJobsFile, "utf8"));
          return Array.isArray(parsed) ? (parsed as Array<[string, string]>) : [];
        },
        save: async (entries) => {
          await mkdir(dirname(paths.awaitedJobsFile), { recursive: true });
          await writeFile(paths.awaitedJobsFile, `${JSON.stringify(entries)}\n`, "utf8");
        },
      },
    });
  }

  private readonly paths: AppPaths;

  /** The HFSS environment's Python: config.json may point elsewhere. */
  private get hfssPython(): string {
    return this.config.hfss.python ?? join(this.paths.runtimeDir, ".hfss", "env", "Scripts", "python.exe");
  }

  /** Read afresh for every session, so an edited AGENTS.md applies from the next one. */
  private async buildSystemPrompt(memoryRules: string, globalInstructionsFile: string): Promise<string> {
    const { workspaceDir } = this.config;
    const sources: InstructionSource[] = [
      { scope: "global", path: globalInstructionsFile },
      { scope: "workspace", path: join(workspaceDir, WORKSPACE_INSTRUCTIONS_FILE) },
    ];
    const { loaded, problems } = await loadInstructions(sources);
    for (const message of problems) this.emit({ type: "notice", message });
    return buildSystemPrompt({
      workspaceDir,
      memoryRules,
      now: new Date(),
      instructions: formatInstructions(loaded),
      toolInstructions: this.toolServers.instructions(),
    });
  }

  /** The bundled HFSS tools, then whatever else the user configured. */
  private toolServerConfigs(paths: AppPaths): McpServerConfig[] {
    const configs: McpServerConfig[] = [];
    const { hfss } = this.config;
    if (hfss.enabled) {
      const python = this.config.hfss.python ?? join(paths.runtimeDir, ".hfss", "env", "Scripts", "python.exe");
      configs.push({
        name: HFSS_SERVER,
        label: "HFSS",
        command: python,
        args: ["-m", "hfss_agent.server"],
        cwd: join(paths.resourcesDir, "hfss"),
        env: serverEnvironment(process.env, { HFSS_AGENT_DATA: hfss.dataDir ?? paths.hfssDataDir }),
        // Reading never changes anything; inspect_project only opens a copy of the user's file.
        readOnlyTools: ["list_recipes", "inspect_project", "get_job", "list_jobs", "compare_jobs", "check_setup"],
        // Curves are for the app's charts: hundreds of points the model has no use for.
        appOnlyTools: ["job_curves"],
        extraInstructions: () => hfssGuidance(this.preferences.current.hfssAutoAnalyze),
        // Starting AEDT's Python and importing the server's dependencies can take a while the first time.
        startupTimeoutMs: 90_000,
        // get_job waits up to 50 seconds by itself.
        callTimeoutMs: 180_000,
        // Asked at every start, so installing from the setup dialog works without restarting the app.
        unavailable: () =>
          existsSync(python) ? undefined : "HFSS 环境还没装：点顶栏的「环境检查」，再点「安装 HFSS 环境」",
      });
    }
    for (const [name, entry] of Object.entries(this.config.mcpServers)) {
      if (entry.enabled === false) continue;
      configs.push({
        name,
        label: name,
        command: entry.command,
        args: entry.args ?? [],
        cwd: entry.cwd ?? this.config.workspaceDir,
        env: serverEnvironment(process.env, entry.env ?? {}),
        readOnlyTools: entry.readOnlyTools ?? [],
      });
    }
    return configs;
  }

  /** Starts the tool servers and hands their tools to the agent. Never rejects. */
  private async startToolServers(): Promise<void> {
    await this.toolServers.start();
    this.adoptServerTools();
    this.hfss.start();
  }

  private adoptServerTools(): void {
    const known = new Set(this.tools.map((tool) => tool.definition.name));
    for (const tool of this.toolServers.tools()) {
      if (!known.has(tool.definition.name)) this.tools.push(tool);
    }
  }

  /** After the HFSS environment was installed: start the server, give its tools to the agent. */
  private async restartHfss(): Promise<void> {
    await this.toolServers.restart(HFSS_SERVER);
    if (!this.toolServers.isReady(HFSS_SERVER)) {
      const status = this.toolServerStatus.find((server) => server.name === HFSS_SERVER);
      throw new Error(`HFSS 工具服务没能启动：${status?.message ?? "原因不明"}`);
    }
    this.adoptServerTools();
    this.hfss.start();
    await this.orchestrator.refreshSystemPrompt();
  }

  /** What the app can check without the HFSS server: what it installed itself, and the model. */
  private localChecks(): SetupItem[] {
    const items: SetupItem[] = [];
    items.push(
      this.modelStatus?.configured
        ? { name: "模型", level: "ok", detail: this.modelStatus.label ?? "已设置" }
        : { name: "模型", level: "fail", detail: "还没有设置模型 API", fix: "点顶栏的「模型设置」，填写厂商、Key 和模型名" },
    );
    if (this.config.hfss.enabled) {
      const python = this.hfssPython;
      if (!existsSync(python)) {
        const aedt = Object.keys(process.env).some((name) => /^ANSYSEM_ROOT\d{3}$/i.test(name));
        items.push({
          name: "HFSS 环境",
          level: "fail",
          detail: `HFSS 工具的 Python 环境还没装（应在 ${python}）`,
          fix: aedt
            ? "点下面的「安装」：用 AEDT 自带的 Python 建环境并装 PyAEDT，要几分钟，需要联网"
            : "先安装 Ansys Electronics Desktop，重启本应用后再点「安装」",
          ...(aedt ? { action: "install-hfss" as const } : {}),
        });
      } else if (!this.toolServers.isReady(HFSS_SERVER)) {
        const status = this.toolServerStatus.find((server) => server.name === HFSS_SERVER);
        items.push({
          name: "HFSS 工具服务",
          level: "fail",
          detail: status?.message ?? "没有启动",
          fix: "环境可能装坏了：点「安装 HFSS 环境」重新装一遍，或运行 npm.cmd run install-hfss",
          action: "install-hfss",
        });
      } else {
        items.push({ name: "HFSS 工具服务", level: "ok", detail: `已连接：${python}` });
      }
    }
    if (this.config.hindsight.enabled) {
      if (this.memoryStatus.status === "online") {
        items.push({ name: "记忆", level: "ok", detail: "Hindsight 在线" });
      } else if (!findHindsight(this.paths.runtimeDir, this.paths.resourcesDir)) {
        items.push({
          name: "记忆",
          level: "warn",
          detail: "Hindsight 记忆服务没装，agent 照常工作，只是记不住以前的对话",
          fix: "点「安装」（要先装 Python 3，体积较大，需要联网）；不需要记忆可以在 config.json 里关掉 hindsight.enabled",
          action: "install-memory",
        });
      } else {
        items.push({
          name: "记忆",
          level: "warn",
          detail: `Hindsight 不在线：${this.memoryStatus.message ?? MEMORY_LABEL[this.memoryStatus.status]}`,
        });
      }
    }
    return items;
  }

  private installer(target: InstallTarget): { script: string; args: string[] } | null {
    const scripts = join(this.paths.resourcesDir, "scripts");
    if (target === "install-hfss") {
      return {
        script: join(scripts, "install-hfss.ps1"),
        args: [
          "-EnvDir",
          join(this.paths.runtimeDir, ".hfss", "env"),
          "-Requirements",
          join(this.paths.resourcesDir, "hfss", "requirements.txt"),
        ],
      };
    }
    return { script: join(scripts, "install-hindsight.ps1"), args: ["-Root", join(this.paths.runtimeDir, ".hindsight")] };
  }

  private async afterInstall(target: InstallTarget): Promise<void> {
    if (target === "install-hfss") {
      await this.restartHfss();
      return;
    }
    this.memoryServerProblem = null;
    this.memoryServer ??= this.createMemoryServer(this.paths);
    await this.startMemoryServer();
  }

  getHfssCurves(jobId: string): Promise<HfssCurves> {
    return this.hfss.curves(jobId);
  }

  cancelHfssJob(jobId: string): Promise<void> {
    return this.hfss.cancel(jobId);
  }

  setAutoAnalyze(on: boolean): Promise<void> {
    return this.hfss.setAutoAnalyze(on);
  }

  checkSetup(): Promise<SetupReport> {
    return this.hfss.checkSetup();
  }

  install(target: InstallTarget): Promise<void> {
    return this.hfss.install(target);
  }

  /** Called on every renderer load: the first boots the agent, later ones catch up. */
  rendererReady(): void {
    this.send({ type: "agent-status", ...this.agentStatus });
    this.send({ type: "memory-status", ...this.memoryStatus });
    if (this.modelStatus) this.send({ type: "model-status", ...this.modelStatus });
    this.send({ type: "tool-servers", servers: this.toolServerStatus });
    this.hfss.publish();
    const sessionId = this.orchestrator.currentSessionId;
    if (sessionId) this.send({ type: "session-started", sessionId, turns: this.recorder.turns });
    void this.recorder.publishSessions();
    if (!this.booted) {
      this.booted = true;
      void this.boot();
    }
  }

  private createMemoryServer(paths: AppPaths): HindsightServer | null {
    const { enabled, autoStart, baseUrl } = this.config.hindsight;
    const port = localPort(baseUrl);
    if (!enabled || !autoStart || !port) return null;

    const installed = findHindsight(paths.runtimeDir, paths.resourcesDir);
    if (!installed) {
      this.memoryServerProblem = "Hindsight 未安装：点顶栏的「环境检查」可以安装";
      return null;
    }
    return new HindsightServer({
      // Read at every launch, so a restart after a settings change uses the new model.
      launch: () => {
        const llm = hindsightLlm(this.modelSettings.active);
        if (!llm) throw new Error(MEMORY_NEEDS_MODEL);
        this.memoryServerLlm = llm;
        return launchHindsight(installed, { llm, port, env: process.env });
      },
      probe: () => this.memory.checkHealth(),
      killTree: killProcessTree,
      onState: (state, message) => this.onMemoryServerState(state, message),
      logFile: join(paths.logsDir, "hindsight.log"),
    });
  }

  /** Reuses a Hindsight that is already running, e.g. one started with npm.cmd run hindsight. */
  private async startMemoryServer(): Promise<void> {
    if (!this.config.hindsight.enabled) return;
    // Set before the first await, so the check below does not flash "offline".
    this.memoryServerState = this.memoryServer ? "starting" : null;
    if (await this.memory.checkHealth()) {
      this.memoryServerState = null;
      return;
    }
    if (this.memoryServer && !hindsightLlm(this.modelSettings.active)) {
      this.memoryServerState = null;
      this.setMemoryStatus("offline", MEMORY_NEEDS_MODEL);
      return;
    }
    if (this.memoryServer) await this.memoryServer.start();
    else if (this.memoryServerProblem) this.setMemoryStatus("offline", this.memoryServerProblem);
  }

  /** After the model changed: start Hindsight if it was waiting for one, restart it on the new one. */
  private async followModelWithMemory(): Promise<void> {
    if (!this.memoryServer || !this.config.hindsight.enabled) return;
    const wanted = hindsightLlm(this.modelSettings.active);
    if (this.memoryServerState === "running" || this.memoryServerState === "starting") {
      if (sameLlm(wanted, this.memoryServerLlm)) return;
      await this.memoryServer.stop();
    }
    await this.startMemoryServer();
  }

  private onMemoryServerState(state: ServerState, message?: string): void {
    this.memoryServerState = state;
    if (state === "starting") this.setMemoryStatus("starting", message);
    if (state === "failed") this.setMemoryStatus("offline", message);
    // The session may have started without memory, so its prompt is missing the rules.
    if (state === "running") void this.orchestrator.refreshSystemPrompt();
  }

  private async boot(): Promise<void> {
    this.setAgentStatus("starting");
    await this.preferences.load();
    await this.hfss.loadAwaited();
    try {
      this.applyModel(await this.modelSettings.load());
    } catch (error) {
      this.emit({ type: "notice", message: `读取模型设置失败：${(error as Error).message}` });
      this.applyModel(this.modelSettings.active);
    }
    void this.startMemoryServer().catch((error: unknown) =>
      this.setMemoryStatus("offline", error instanceof Error ? error.message : String(error)),
    );
    const toolsStarted = this.startToolServers();
    try {
      await mkdir(this.config.workspaceDir, { recursive: true });
      // The system prompt is fixed for a session, so give the tool servers a moment to say how
      // their tools work. A slow one is added when it comes up, and the prompt refreshed then.
      const inTime = await Promise.race([toolsStarted.then(() => true), sleep(TOOL_SERVERS_WAIT_MS, false)]);
      if (!inTime) void toolsStarted.then(() => this.orchestrator.refreshSystemPrompt());
      await this.orchestrator.startSession();
      this.setAgentStatus("ready");
      // Jobs that finished while the app was closed are reported once their session is open again.
      void this.hfss.maybeReport();
    } catch (error) {
      this.setAgentStatus("error", error instanceof Error ? error.message : String(error));
    }
  }

  /** Points the agent at the model, from the next model call on: the conversation carries over. */
  private applyModel(active: ActiveModel): void {
    const { config } = active;
    this.agent.setCompactionPolicy(compactionPolicy(config.compactAtTokens, config.contextWindow));
    if (this.fakeModel) {
      this.setModelStatus(true, "模拟模型");
      return;
    }
    const configured = this.modelSettings.configured;
    this.model.set(configured ? createModelClient(active) : null);
    this.setModelStatus(configured, configured ? `${findPreset(config.provider).label} · ${config.model}` : undefined);
  }

  getModelSettings(): ModelSettingsView {
    return this.modelSettings.view();
  }

  async saveModelSettings(input: ModelSettingsInput): Promise<void> {
    this.applyModel(await this.modelSettings.save(input));
    void this.followModelWithMemory().catch((error: unknown) =>
      this.setMemoryStatus("offline", error instanceof Error ? error.message : String(error)),
    );
  }

  testModelSettings(input: ModelSettingsInput): Promise<ModelTestResult> {
    return this.modelSettings.test(input);
  }

  listModels(input: Pick<ModelSettingsInput, "provider" | "baseUrl" | "apiKey">): Promise<string[]> {
    return this.modelSettings.listModels(input);
  }

  newSession(): Promise<void> {
    return this.orchestrator.startSession();
  }

  async openSession(sessionId: string): Promise<void> {
    await this.recorder.flush();
    await this.orchestrator.resumeSession(sessionId, await this.store.load(sessionId));
    void this.hfss.maybeReport();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.recorder.flush();
    if (sessionId === this.recorder.sessionId) await this.orchestrator.startSession();
    await this.store.delete(sessionId);
    await this.recorder.publishSessions();
  }

  sendPrompt(text: string): Promise<void> {
    return this.runTurn(text, false);
  }

  /** Every turn ends by checking whether finished jobs wait to be reported, which needs an idle agent. */
  private async runTurn(text: string, auto: boolean): Promise<void> {
    try {
      await this.orchestrator.send(text, { auto });
    } finally {
      void this.hfss.maybeReport();
    }
  }

  cancelTurn(): void {
    this.orchestrator.cancel();
  }

  answerPermission(answer: PermissionAnswer): void {
    this.broker.answer(answer);
  }

  /** Stops the running turn and waits until everything is on disk. */
  shutdown(): Promise<void> {
    this.orchestrator.cancel();
    this.broker.cancelAll();
    return this.recorder.flush();
  }

  /** Separate from shutdown: Hindsight takes a few seconds and needs no window. */
  stopMemoryServer(): Promise<void> {
    return this.memoryServer?.stop() ?? Promise.resolve();
  }

  /**
   * Stops the tool servers. HFSS jobs keep running: they belong to a runner process of their own,
   * and the next start picks up their results.
   */
  stopToolServers(): Promise<void> {
    this.hfss.stop();
    return this.toolServers.stop();
  }

  private emit(event: AppEvent): void {
    // "Allow for this session" ends with the session, whether new or reopened.
    if (event.type === "session-started") this.gate.clearSession();
    this.recorder.observe(event);
    this.send(event);
  }

  private setMemoryStatus(status: MemoryStatus, message?: string): void {
    this.memoryStatus = { status, message };
    this.emit({ type: "memory-status", status, message });
  }

  private setModelStatus(configured: boolean, label?: string): void {
    this.modelStatus = { configured, ...(label ? { label } : {}) };
    this.send({ type: "model-status", ...this.modelStatus });
  }

  private setAgentStatus(status: AgentStatus, message?: string): void {
    this.agentStatus = { status, message };
    this.send({ type: "agent-status", status, message });
  }
}
