import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compactionPolicy } from "../src/main/agent/compaction";
import { MODEL_NOT_CONFIGURED, SwitchableModel } from "../src/main/agent/switchable-model";
import { loadConfig, saveModelConfig, type ModelConfig } from "../src/main/config";
import { ModelSettings } from "../src/main/model-settings";
import { SecretStore, type Cipher } from "../src/main/secrets";
import type { ModelSettingsInput } from "../src/shared/types";

/** Reversible, and visibly not plaintext, so a test can tell the file holds no raw key. */
const cipher: Cipher = {
  available: async () => true,
  encrypt: async (text) => Buffer.from(`enc:${[...text].reverse().join("")}`),
  decrypt: async (data) => {
    const text = data.toString();
    if (!text.startsWith("enc:")) throw new Error("not ours");
    return { text: [...text.slice(4)].reverse().join("") };
  },
};

let dir: string;
let server: Server | null = null;
const configPath = () => join(dir, "config.json");
const secretsPath = () => join(dir, "secrets.json");
const secrets = () => new SecretStore(secretsPath(), cipher);

const DEEPSEEK: ModelConfig = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  contextWindow: 1_000_000,
  compactAtTokens: 200_000,
};

const input = (change: Partial<ModelSettingsInput> = {}): ModelSettingsInput => ({
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  contextWindow: 1_000_000,
  ...change,
});

function settings(initial: ModelConfig = DEEPSEEK) {
  return new ModelSettings({ configPath: configPath(), secrets: secrets(), initial });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-settings-"));
});

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("SecretStore", () => {
  it("keeps values encrypted on disk and reads them back", async () => {
    const store = secrets();
    await store.set("model.apiKey", "sk-secret-1234");

    expect(readFileSync(secretsPath(), "utf8")).not.toContain("sk-secret-1234");
    await expect(store.get("model.apiKey")).resolves.toBe("sk-secret-1234");
    await store.delete("model.apiKey");
    await expect(store.get("model.apiKey")).resolves.toBeUndefined();
  });

  it("treats a value it cannot decrypt as not saved", async () => {
    writeFileSync(secretsPath(), JSON.stringify({ "model.apiKey": Buffer.from("garbage").toString("base64") }));
    await expect(secrets().get("model.apiKey")).resolves.toBeUndefined();
  });

  it("encrypts a value again when the system says its key changed", async () => {
    await secrets().set("model.apiKey", "sk-1");
    const before = readFileSync(secretsPath(), "utf8");
    let calls = 0;
    const rotating: Cipher = {
      ...cipher,
      encrypt: async (text) => Buffer.from(`new:${text}`),
      decrypt: async (data) => {
        calls += 1;
        const text = data.toString();
        return text.startsWith("new:") ? { text: text.slice(4) } : { ...(await cipher.decrypt(data)), stale: true };
      },
    };
    const store = new SecretStore(secretsPath(), rotating);

    await expect(store.get("model.apiKey")).resolves.toBe("sk-1");
    expect(readFileSync(secretsPath(), "utf8")).not.toBe(before);
    await expect(store.get("model.apiKey")).resolves.toBe("sk-1");
    expect(calls).toBe(2);
  });

  it("refuses to save when encryption is unavailable", async () => {
    const store = new SecretStore(secretsPath(), { ...cipher, available: async () => false });
    await expect(store.set("k", "v")).rejects.toThrow(/加密不可用/);
  });
});

describe("config", () => {
  const load = (env: NodeJS.ProcessEnv = {}) => loadConfig({ userDataDir: dir, homeDir: dir, env });

  it("reads a model section", async () => {
    writeFileSync(configPath(), JSON.stringify({ model: { provider: "qwen", model: "qwen-plus" } }));

    const { model } = await load();

    expect(model).toMatchObject({
      provider: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      contextWindow: 128_000,
    });
    expect(model.legacyApiKey).toBeUndefined();
  });

  it("still reads the old deepseek section and its key", async () => {
    writeFileSync(configPath(), JSON.stringify({ deepseek: { apiKey: "sk-old", model: "deepseek-v4-pro" } }));

    await expect(load()).resolves.toMatchObject({
      model: { provider: "deepseek", model: "deepseek-v4-pro", legacyApiKey: "sk-old" },
    });
  });

  it("uses DEEPSEEK_API_KEY only for the old setup", async () => {
    await expect(load({ DEEPSEEK_API_KEY: "sk-env" })).resolves.toMatchObject({ model: { legacyApiKey: "sk-env" } });

    writeFileSync(configPath(), JSON.stringify({ model: { provider: "openai", model: "x" } }));
    expect((await load({ DEEPSEEK_API_KEY: "sk-env" })).model.legacyApiKey).toBeUndefined();
  });

  it("saves the model section, keeps the rest and drops the old plaintext key", async () => {
    writeFileSync(
      configPath(),
      `\uFEFF${JSON.stringify({ workspaceDir: "W:\\work", deepseek: { apiKey: "sk-old" }, sandbox: { network: true } })}`,
    );

    await saveModelConfig(configPath(), { ...DEEPSEEK, provider: "moonshot" });

    const saved = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(saved).toEqual({
      workspaceDir: "W:\\work",
      sandbox: { network: true },
      model: { ...DEEPSEEK, provider: "moonshot" },
    });
  });
});

describe("ModelSettings", () => {
  it("is not configured without a key, and the view never carries one", async () => {
    const current = settings();
    await current.load();

    expect(current.configured).toBe(false);
    expect(current.view()).toMatchObject({ hasKey: false, configured: false });
  });

  it("saves a new key encrypted and shows only its end", async () => {
    const current = settings();

    await current.save(input({ apiKey: "  sk-abcdefgh1234  " }));

    expect(current.configured).toBe(true);
    expect(current.active.apiKey).toBe("sk-abcdefgh1234");
    expect(current.view()).toMatchObject({ hasKey: true, keyHint: "…1234", configured: true });
    expect(JSON.stringify(current.view())).not.toContain("abcdefgh");
    expect(readFileSync(secretsPath(), "utf8")).not.toContain("sk-abcdefgh1234");
    expect(JSON.parse(readFileSync(configPath(), "utf8")).model).not.toHaveProperty("apiKey");

    const reloaded = settings();
    await reloaded.load();
    expect(reloaded.active.apiKey).toBe("sk-abcdefgh1234");
  });

  it("keeps the saved key when the field is left empty", async () => {
    const current = settings();
    await current.save(input({ apiKey: "sk-first" }));

    await current.save(input({ model: "deepseek-v4-pro" }));

    expect(current.active).toMatchObject({ apiKey: "sk-first", config: { model: "deepseek-v4-pro" } });
  });

  it("never sends a saved key to a different address", async () => {
    const current = settings();
    await current.save(input({ apiKey: "sk-first" }));

    await expect(
      current.save(input({ provider: "custom", baseUrl: "https://evil.example.com/v1" })),
    ).rejects.toThrow(/接口地址换了/);
    await expect(current.listModels({ provider: "custom", baseUrl: "https://evil.example.com/v1" })).rejects.toThrow(
      /接口地址换了/,
    );
    expect(current.active.config.baseUrl).toBe("https://api.deepseek.com");
  });

  it("moves a key from before the settings page into secrets.json on save", async () => {
    const current = settings({ ...DEEPSEEK, legacyApiKey: "sk-legacy" });
    await current.load();
    expect(current.configured).toBe(true);

    await current.save(input());

    const reloaded = settings();
    await reloaded.load();
    expect(reloaded.active.apiKey).toBe("sk-legacy");
  });

  it.each([
    [{ provider: "nope" }, /厂商/],
    [{ baseUrl: "not a url" }, /有效的网址/],
    [{ baseUrl: "http://api.example.com/v1" }, /https/],
    [{ baseUrl: "https://user:pass@api.example.com" }, /账号密码/],
    [{ model: "  " }, /模型名/],
    [{ model: "deep seek" }, /空格/],
    [{ contextWindow: 100 }, /上下文窗口/],
    [{ apiKey: "sk-abc def" }, /空格/],
    [{ apiKey: "sk-中文" }, /中文/],
  ])("rejects %o", async (change, message) => {
    await expect(settings().save(input(change as Partial<ModelSettingsInput>))).rejects.toThrow(message);
  });

  it("asks for a key unless the server is on this machine", async () => {
    await expect(settings().save(input())).rejects.toThrow(/请填写 API Key/);

    const local = settings();
    await local.save(input({ provider: "custom", baseUrl: "http://localhost:11434/v1", model: "qwen3:8b" }));
    expect(local.configured).toBe(true);
    expect(local.active.apiKey).toBe("");
  });

  describe("against a local server", () => {
    async function serve(handler: (url: string, body: string) => { status: number; body: string; type?: string }) {
      const seen: Array<{ url: string; body: string; auth?: string }> = [];
      server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          seen.push({ url: request.url ?? "", body, auth: request.headers.authorization });
          const reply = handler(request.url ?? "", body);
          response.writeHead(reply.status, { "content-type": reply.type ?? "application/json" });
          response.end(reply.body);
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      return { baseUrl: `http://127.0.0.1:${port}/v1`, seen };
    }

    const local = (baseUrl: string, change: Partial<ModelSettingsInput> = {}) =>
      input({ provider: "custom", baseUrl, model: "m1", contextWindow: 128_000, ...change });

    it("lists the provider's models", async () => {
      const { baseUrl, seen } = await serve(() => ({
        status: 200,
        body: JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }, { id: "b-model" }] }),
      }));

      await expect(settings().listModels({ ...local(baseUrl), apiKey: "sk-list" })).resolves.toEqual([
        "a-model",
        "b-model",
      ]);
      expect(seen[0]).toMatchObject({ url: "/v1/models", auth: "Bearer sk-list" });
    });

    it("passes a test once the model starts answering, sending a tool and no DeepSeek-only fields", async () => {
      const { baseUrl, seen } = await serve(() => ({
        status: 200,
        type: "text/event-stream",
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: null }] })}\n\n`,
      }));

      const result = await settings().test({ ...local(baseUrl), apiKey: "sk-test" });

      expect(result).toMatchObject({ ok: true, message: expect.stringContaining("连接成功") });
      const body = JSON.parse(seen[0]!.body);
      expect(body.tools).toHaveLength(1);
      expect(body).not.toHaveProperty("thinking");
    });

    it("explains a failed test, mentioning tool support", async () => {
      const { baseUrl } = await serve(() => ({ status: 401, body: "{}" }));

      const result = await settings().test({ ...local(baseUrl), apiKey: "sk-bad" });

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/拒绝了 API Key/);
      expect(result.message).toMatch(/工具调用/);
    });

    it("reports invalid settings as a failed test instead of throwing", async () => {
      await expect(settings().test(input({ model: "" }))).resolves.toMatchObject({ ok: false });
    });
  });
});

describe("SwitchableModel", () => {
  it("explains that no model is set, then uses the one it is given", async () => {
    const model = new SwitchableModel();
    const request = { messages: [], tools: [] };
    const handlers = { onText: () => {}, onThought: () => {} };

    await expect(model.complete(request, handlers, new AbortController().signal)).rejects.toThrow(MODEL_NOT_CONFIGURED);

    const completion = { content: "hi", reasoningContent: "", toolCalls: [], finishReason: "stop" as const };
    model.set({ complete: async () => completion });
    await expect(model.complete(request, handlers, new AbortController().signal)).resolves.toBe(completion);
    expect(model.configured).toBe(true);
  });
});

describe("compactionPolicy", () => {
  it("is unchanged for a huge window", () => {
    expect(compactionPolicy(200_000, 1_000_000)).toEqual({
      triggerTokens: 200_000,
      midTurnTokens: 600_000,
      tailTokens: 20_000,
    });
  });

  it("stays inside a 128k window, also within a turn", () => {
    const policy = compactionPolicy(200_000, 128_000);
    expect(policy.triggerTokens).toBe(64_000);
    expect(policy.midTurnTokens).toBe(102_400);
    expect(policy.midTurnTokens).toBeLessThan(128_000);
  });
});
