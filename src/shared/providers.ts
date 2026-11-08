// Model providers the settings page offers. All of them speak OpenAI-compatible Chat Completions;
// the preset only fills in the address and a sensible context window. Model names change too
// often to hard-code, so the settings page lists them from the provider instead.

export interface ProviderPreset {
  id: string;
  label: string;
  /** Empty for "custom", where the user types it. */
  baseUrl: string;
  /** Where the user creates a key. Opened in the system browser. */
  keyUrl?: string;
  /** Tokens the model accepts; compaction stays well below it. */
  contextWindow: number;
  /** Shown as a placeholder: a model known to work, not a recommendation. */
  modelHint?: string;
  /**
   * DeepSeek's own switch for thinking mode. Other providers reject unknown request fields, so
   * the switch is only sent where it is known to exist.
   */
  thinkingToggle?: boolean;
  /** How Hindsight should reach the same model: its own provider name, or plain OpenAI-compatible. */
  hindsightProvider: "deepseek" | "openai";
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    contextWindow: 1_000_000,
    modelHint: "deepseek-flash",
    thinkingToggle: true,
    hindsightProvider: "deepseek",
  },
  {
    id: "qwen",
    label: "通义千问（阿里云百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyUrl: "https://bailian.console.aliyun.com/",
    contextWindow: 128_000,
    hindsightProvider: "openai",
  },
  {
    id: "moonshot",
    label: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    contextWindow: 128_000,
    hindsightProvider: "openai",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    contextWindow: 128_000,
    hindsightProvider: "openai",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    contextWindow: 128_000,
    hindsightProvider: "openai",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    contextWindow: 128_000,
    hindsightProvider: "openai",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    contextWindow: 128_000,
    hindsightProvider: "openai",
  },
  {
    id: "custom",
    label: "其他（OpenAI 兼容）",
    baseUrl: "",
    contextWindow: 128_000,
    hindsightProvider: "openai",
  },
];

export const DEFAULT_PROVIDER_ID = "deepseek";

export function findPreset(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? PROVIDER_PRESETS.at(-1)!;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Ollama and LM Studio on this machine need no key and may use plain http. */
export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The part a key is bound to: a saved key is never sent anywhere else. */
export function urlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
