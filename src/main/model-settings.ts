import { findPreset, isLocalUrl, PROVIDER_PRESETS, urlOrigin } from "../shared/providers";
import type { ModelSettingsInput, ModelSettingsView, ModelTestResult } from "../shared/types";
import { OpenAICompatibleClient } from "./agent/openai-client";
import { saveModelConfig, type ModelConfig } from "./config";
import type { SecretStore } from "./secrets";

const KEY_SECRET = "model.apiKey";
/** The origin the key was entered for. A saved key is only ever sent there. */
const KEY_ORIGIN_SECRET = "model.apiKeyOrigin";
const TEST_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 15_000;

export type SavedModelConfig = Omit<ModelConfig, "legacyApiKey">;

export interface ActiveModel {
  config: SavedModelConfig;
  /** Undefined until the user enters one; empty for a local server that needs none. */
  apiKey: string | undefined;
}

export interface ModelSettingsOptions {
  configPath: string;
  secrets: SecretStore;
  initial: ModelConfig;
}

function clientLabel(config: SavedModelConfig): string {
  const preset = findPreset(config.provider);
  if (preset.id !== "custom") return preset.label;
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return "模型服务";
  }
}

/** retry: false for the settings page, where a wrong address should say so at once, not after retries. */
export function createModelClient({ config, apiKey }: ActiveModel, retry = true): OpenAICompatibleClient {
  return new OpenAICompatibleClient({
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: apiKey ?? "",
    label: clientLabel(config),
    thinkingToggle: findPreset(config.provider).thinkingToggle ?? false,
    ...(retry ? {} : { retryDelaysMs: [] }),
  });
}

/** Checks what the settings page sent. The renderer shows untrusted model output, so nothing is assumed. */
function validate(input: ModelSettingsInput): Omit<SavedModelConfig, "compactAtTokens"> {
  if (!input || typeof input !== "object") throw new Error("设置格式不对");
  const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === input.provider);
  if (!preset) throw new Error("请选择模型厂商");

  const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("接口地址不是有效的网址，例如 https://api.deepseek.com");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalUrl(baseUrl))) {
    throw new Error("接口地址必须是 https；只有本机的服务（localhost）可以用 http");
  }
  if (url.username || url.password) throw new Error("接口地址里不要写账号密码，Key 填在下面");

  const model = String(input.model ?? "").trim();
  if (!model) throw new Error("请填写模型名，或点「获取模型列表」选一个");
  if (model.length > 200 || /\s/.test(model)) throw new Error("模型名不能有空格");

  const contextWindow = Number(input.contextWindow);
  if (!Number.isInteger(contextWindow) || contextWindow < 8_000 || contextWindow > 10_000_000) {
    throw new Error("上下文窗口要填 8000 到 10000000 之间的整数（单位 token）");
  }
  return { provider: preset.id, baseUrl, model, contextWindow };
}

function validateKey(raw: unknown): string | undefined {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return undefined;
  // Printable ASCII only: a pasted line break or full-width character would break the header.
  if (!/^[\x21-\x7e]+$/.test(key) || key.length > 1_000) {
    throw new Error("API Key 里有空格、换行或中文字符，请重新复制");
  }
  return key;
}

/** The model settings the user entered on the settings page, with the key kept encrypted. */
export class ModelSettings {
  private config: SavedModelConfig;
  private apiKey: string | undefined;
  private keyOrigin: string | null;

  constructor(private readonly options: ModelSettingsOptions) {
    const { legacyApiKey, ...config } = options.initial;
    this.config = config;
    this.apiKey = legacyApiKey;
    this.keyOrigin = legacyApiKey ? urlOrigin(config.baseUrl) : null;
  }

  /** Reads the saved key. A key from secrets.json wins over one from before the settings page. */
  async load(): Promise<ActiveModel> {
    const [key, origin] = await Promise.all([
      this.options.secrets.get(KEY_SECRET),
      this.options.secrets.get(KEY_ORIGIN_SECRET),
    ]);
    if (key && origin) {
      this.apiKey = key;
      this.keyOrigin = origin;
    }
    return this.active;
  }

  /** The model to use now, or null when it cannot work yet (no key, or a key for another address). */
  get active(): ActiveModel {
    return { config: this.config, apiKey: this.keyFor(this.config.baseUrl) };
  }

  get configured(): boolean {
    const { config, apiKey } = this.active;
    return Boolean(config.baseUrl && config.model && apiKey !== undefined);
  }

  /** What the settings page shows. The key itself never leaves the main process. */
  view(): ModelSettingsView {
    const key = this.keyFor(this.config.baseUrl);
    return {
      provider: this.config.provider,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      contextWindow: this.config.contextWindow,
      hasKey: Boolean(key),
      ...(key ? { keyHint: `…${key.slice(-4)}` } : {}),
      configured: this.configured,
    };
  }

  async save(input: ModelSettingsInput): Promise<ActiveModel> {
    const fields = validate(input);
    const apiKey = this.resolveKey(fields.baseUrl, input.apiKey);
    const config: SavedModelConfig = { ...fields, compactAtTokens: this.config.compactAtTokens };
    const origin = urlOrigin(config.baseUrl);
    if (apiKey && origin) {
      await this.options.secrets.set(KEY_SECRET, apiKey);
      await this.options.secrets.set(KEY_ORIGIN_SECRET, origin);
    } else {
      await this.options.secrets.delete(KEY_SECRET);
      await this.options.secrets.delete(KEY_ORIGIN_SECRET);
    }
    await saveModelConfig(this.options.configPath, config);
    this.config = config;
    this.apiKey = apiKey || undefined;
    this.keyOrigin = apiKey ? origin : null;
    return { config, apiKey };
  }

  /**
   * Sends a tiny request with a tool attached, because the agent cannot work with a model that
   * does not support tool calls. Stops at the first token, so it costs almost nothing.
   */
  async test(input: ModelSettingsInput): Promise<ModelTestResult> {
    let client: OpenAICompatibleClient;
    try {
      const fields = validate(input);
      const apiKey = this.resolveKey(fields.baseUrl, input.apiKey);
      client = createModelClient({ config: { ...fields, compactAtTokens: 0 }, apiKey }, false);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let answered = false;
    const stop = () => {
      answered = true;
      controller.abort();
    };
    try {
      await client.complete(
        {
          messages: [{ role: "user", content: "这是连接测试，请只回复 OK。" }],
          tools: [{ name: "ping", description: "连接测试用，不要调用", parameters: { type: "object", properties: {} } }],
          thinking: false,
        },
        { onText: stop, onThought: stop },
        controller.signal,
      );
      answered = true;
    } catch (error) {
      if (!answered) {
        const message = controller.signal.aborted
          ? `${TEST_TIMEOUT_MS / 1000} 秒内没有回复，请检查网络或代理`
          : (error as Error).message;
        return { ok: false, message: `${message}。注意：agent 需要模型支持工具调用（function calling）` };
      }
    } finally {
      clearTimeout(timer);
    }
    return { ok: true, message: `连接成功，模型已回复（${Date.now() - started} ms）` };
  }

  async listModels(input: Pick<ModelSettingsInput, "provider" | "baseUrl" | "apiKey">): Promise<string[]> {
    const fields = validate({ ...input, model: "list", contextWindow: 128_000 });
    const apiKey = this.resolveKey(fields.baseUrl, input.apiKey);
    const client = createModelClient({ config: { ...fields, compactAtTokens: 0 }, apiKey });
    return client.listModels(AbortSignal.timeout(LIST_TIMEOUT_MS));
  }

  private keyFor(baseUrl: string): string | undefined {
    if (this.apiKey && urlOrigin(baseUrl) === this.keyOrigin) return this.apiKey;
    return isLocalUrl(baseUrl) ? "" : undefined;
  }

  /** A new key if one was typed, else the saved one, but only for the address it was saved for. */
  private resolveKey(baseUrl: string, typed: unknown): string {
    const key = validateKey(typed);
    if (key) return key;
    const saved = this.keyFor(baseUrl);
    if (saved !== undefined) return saved;
    throw new Error(
      this.apiKey
        ? "接口地址换了：保存的 Key 只会发给原来的地址，请为新地址填写 API Key"
        : "请填写 API Key",
    );
  }
}
