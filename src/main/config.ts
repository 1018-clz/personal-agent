import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_PROVIDER_ID, findPreset } from "../shared/providers";
import { DEFAULT_TRIGGER_TOKENS } from "./agent/compaction";

/** Which model the agent talks to. The key is not here: it lives encrypted in secrets.json. */
export interface ModelConfig {
  /** A preset id from shared/providers.ts, or "custom". */
  provider: string;
  baseUrl: string;
  model: string;
  /** Tokens the model accepts. Compaction stays well below it. */
  contextWindow: number;
  /** Older conversation is summarized once the context reaches this many tokens. */
  compactAtTokens: number;
  /**
   * Only from before the settings page: deepseek.apiKey in config.json or DEEPSEEK_API_KEY.
   * Still honored, and moved into secrets.json the first time the settings are saved.
   */
  legacyApiKey?: string;
}

/** The pre-settings-page section, still read so existing installs keep working. */
interface LegacyDeepSeekSection {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  compactAtTokens?: number;
}

export interface HindsightConfig {
  enabled: boolean;
  baseUrl: string;
  bankId: string;
  apiKey?: string;
  /** Starts the local install with the app when baseUrl points at this machine. */
  autoStart: boolean;
}

export interface SandboxConfig {
  /** Off means commands run with the user's full permissions. */
  enabled: boolean;
  network: boolean;
}

export interface PermissionsConfig {
  /** Rules such as "run_command(git status *)" that run without asking. */
  allow: string[];
  /** Rules that are refused without asking. They win over allow rules. */
  deny: string[];
  /** Runs commands that only read, like Get-ChildItem, without asking. Only with the sandbox on. */
  autoAllowReadOnly: boolean;
}

export interface HfssConfig {
  /** Starts the bundled HFSS tool server (hfss/hfss_agent) with the app. */
  enabled: boolean;
  /** The Python with pyaedt; default .hfss\env from npm run install-hfss. */
  python?: string;
  /** Jobs, results and snapshots; default %LOCALAPPDATA%\personal-agent\hfss. Can grow to many GB. */
  dataDir?: string;
}

/** Any other MCP server, started over stdio like Claude Desktop's mcpServers. */
export interface McpServerEntry {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Tools that only read and run without asking. */
  readOnlyTools?: string[];
  enabled?: boolean;
}

export interface AppConfig {
  model: ModelConfig;
  hfss: HfssConfig;
  mcpServers: Record<string, McpServerEntry>;
  workspaceDir: string;
  hindsight: HindsightConfig;
  sandbox: SandboxConfig;
  permissions: PermissionsConfig;
}

export interface ConfigPaths {
  userDataDir: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}

type ConfigFile = Partial<Pick<AppConfig, "workspaceDir">> & {
  model?: Partial<Omit<ModelConfig, "legacyApiKey">>;
  deepseek?: LegacyDeepSeekSection;
  hindsight?: Partial<HindsightConfig>;
  sandbox?: Partial<SandboxConfig>;
  permissions?: Partial<PermissionsConfig>;
  hfss?: Partial<HfssConfig>;
  mcp?: { servers?: Record<string, unknown> };
};

function mcpServers(raw: Record<string, unknown> | undefined): Record<string, McpServerEntry> {
  const servers: Record<string, McpServerEntry> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    const entry = value as Partial<McpServerEntry> | null;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`MCP 服务名 ${name} 只能用字母、数字、_ 和 -`);
    if (name === "hfss") throw new Error("MCP 服务名 hfss 是内置的 HFSS 工具，请换一个名字");
    if (!entry || typeof entry.command !== "string" || !entry.command) {
      throw new Error(`MCP 服务 ${name} 缺少 command`);
    }
    servers[name] = {
      command: entry.command,
      args: stringList(entry.args, `mcp.servers.${name}.args`),
      ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
      ...(entry.env && typeof entry.env === "object" ? { env: entry.env } : {}),
      readOnlyTools: stringList(entry.readOnlyTools, `mcp.servers.${name}.readOnlyTools`),
      enabled: entry.enabled !== false,
    };
  }
  return servers;
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`配置项 ${name} 必须是字符串数组`);
  }
  return value;
}

export function configFilePath(userDataDir: string): string {
  return join(userDataDir, "config.json");
}

function modelConfig(file: ConfigFile, env: NodeJS.ProcessEnv): ModelConfig {
  if (file.model) {
    const preset = findPreset(file.model.provider ?? DEFAULT_PROVIDER_ID);
    // The old key sources were DeepSeek's, so they only stand in for a DeepSeek setup.
    const legacyApiKey = preset.id === DEFAULT_PROVIDER_ID ? (file.deepseek?.apiKey ?? env.DEEPSEEK_API_KEY) : undefined;
    return {
      provider: preset.id,
      baseUrl: file.model.baseUrl ?? preset.baseUrl,
      model: file.model.model ?? preset.modelHint ?? "",
      contextWindow: file.model.contextWindow ?? preset.contextWindow,
      compactAtTokens: file.model.compactAtTokens ?? DEFAULT_TRIGGER_TOKENS,
      ...(legacyApiKey ? { legacyApiKey } : {}),
    };
  }
  // Before the settings page there was only DeepSeek, configured here or by environment variable.
  const legacy = file.deepseek ?? {};
  const preset = findPreset(DEFAULT_PROVIDER_ID);
  const legacyApiKey = legacy.apiKey ?? env.DEEPSEEK_API_KEY;
  return {
    provider: preset.id,
    baseUrl: legacy.baseUrl ?? preset.baseUrl,
    model: legacy.model ?? preset.modelHint ?? "",
    contextWindow: preset.contextWindow,
    compactAtTokens: legacy.compactAtTokens ?? DEFAULT_TRIGGER_TOKENS,
    ...(legacyApiKey ? { legacyApiKey } : {}),
  };
}

export async function loadConfig({ userDataDir, homeDir, env }: ConfigPaths): Promise<AppConfig> {
  const file = await readConfigFile(configFilePath(userDataDir));
  return {
    workspaceDir: file.workspaceDir ?? join(homeDir, "PersonalAgent", "workspace"),
    model: modelConfig(file, env),
    hfss: { enabled: true, ...file.hfss },
    mcpServers: mcpServers(file.mcp?.servers),
    hindsight: {
      enabled: true,
      baseUrl: "http://localhost:8888",
      bankId: "personal",
      autoStart: true,
      ...file.hindsight,
    },
    sandbox: { enabled: true, network: false, ...file.sandbox },
    permissions: {
      allow: stringList(file.permissions?.allow, "permissions.allow"),
      deny: stringList(file.permissions?.deny, "permissions.deny"),
      autoAllowReadOnly: file.permissions?.autoAllowReadOnly ?? true,
    },
  };
}

async function readConfigFile(path: string): Promise<ConfigFile> {
  try {
    // Notepad and Windows PowerShell can both save a BOM, which JSON.parse rejects.
    const text = (await readFile(path, "utf8")).replace(/^﻿/, "");
    return JSON.parse(text) as ConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`无法读取配置文件 ${path}：${(error as Error).message}`);
  }
}

/**
 * Writes the model section and leaves everything else the user wrote alone. The legacy
 * deepseek section goes: its settings are in model now, and its plaintext key in secrets.json.
 */
export async function saveModelConfig(
  path: string,
  model: Omit<ModelConfig, "legacyApiKey">,
): Promise<void> {
  const file = (await readConfigFile(path)) as Record<string, unknown>;
  file.model = model;
  delete file.deepseek;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
