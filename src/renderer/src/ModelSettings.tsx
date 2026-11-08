import { useEffect, useId, useState } from "react";

import { findPreset, isLocalUrl, PROVIDER_PRESETS } from "../../shared/providers";
import type { ModelSettingsInput, ModelSettingsView, ModelTestResult } from "../../shared/types";

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

interface Form {
  provider: string;
  baseUrl: string;
  model: string;
  contextWindow: string;
  apiKey: string;
}

function formFrom(view: ModelSettingsView): Form {
  return {
    provider: view.provider,
    baseUrl: view.baseUrl,
    model: view.model,
    contextWindow: String(view.contextWindow),
    apiKey: "",
  };
}

function inputFrom(form: Form): ModelSettingsInput {
  return {
    provider: form.provider,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    contextWindow: Number(form.contextWindow),
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
  };
}

/** Provider, address, model and key. The saved key is never shown, only its last characters. */
export function ModelSettingsDialog({ onClose, firstRun }: { onClose: () => void; firstRun: boolean }) {
  const [saved, setSaved] = useState<ModelSettingsView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<ModelTestResult | null>(null);
  const [busy, setBusy] = useState<"list" | "test" | "save" | null>(null);
  const ids = { provider: useId(), baseUrl: useId(), model: useId(), models: useId(), key: useId(), window: useId() };

  useEffect(() => {
    window.desktop
      .getModelSettings()
      .then((view) => {
        setSaved(view);
        setForm(formFrom(view));
      })
      .catch((error: unknown) => setStatus({ ok: false, message: errorMessage(error) }));
  }, []);

  if (!form) {
    return (
      <div className="modal-backdrop">
        <section className="modal" role="dialog" aria-modal="true" aria-label="模型设置">
          <p>{status?.message ?? "正在读取设置…"}</p>
          <div className="actions">
            <button type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </section>
      </div>
    );
  }

  const preset = findPreset(form.provider);
  const update = (change: Partial<Form>) => {
    setForm({ ...form, ...change });
    setStatus(null);
  };

  function chooseProvider(id: string) {
    const next = findPreset(id);
    // A preset fills in its address and window; "custom" keeps what was typed, to edit from there.
    update({
      provider: next.id,
      ...(next.baseUrl ? { baseUrl: next.baseUrl } : {}),
      model: next.id === saved?.provider ? saved.model : (next.modelHint ?? ""),
      contextWindow: String(next.contextWindow),
    });
    setModels([]);
  }

  // A saved key is only sent to the address it was saved for, so changing the address needs a new one.
  const keyKept = Boolean(saved?.hasKey && form.baseUrl.trim() === saved.baseUrl);
  const keyOptional = isLocalUrl(form.baseUrl.trim());

  async function act<T>(kind: "list" | "test" | "save", action: () => Promise<T>, done: (value: T) => void) {
    setBusy(kind);
    setStatus(null);
    try {
      done(await action());
    } catch (error) {
      setStatus({ ok: false, message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  const listModels = () =>
    act("list", () => window.desktop.listModels(inputFrom(form)), (list) => {
      setModels(list);
      setStatus({ ok: true, message: list.length ? `找到 ${list.length} 个模型，在模型名里选一个` : "没有列出模型，请手动填写" });
    });
  const test = () => act("test", () => window.desktop.testModelSettings(inputFrom(form)), setStatus);
  const save = () => act("save", () => window.desktop.saveModelSettings(inputFrom(form)), onClose);

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby={`${ids.provider}-title`}>
        <h2 id={`${ids.provider}-title`}>模型设置</h2>
        {firstRun && (
          <p className="modal-intro">
            选择模型厂商并填写你自己的 API Key。费用由厂商直接向你收取，Key 用 Windows 加密保存在本机，只会发给下面这个接口地址。
          </p>
        )}

        <label htmlFor={ids.provider}>厂商</label>
        <select id={ids.provider} value={form.provider} onChange={(event) => chooseProvider(event.target.value)}>
          {PROVIDER_PRESETS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>

        <label htmlFor={ids.baseUrl}>接口地址</label>
        <input
          id={ids.baseUrl}
          value={form.baseUrl}
          placeholder="https://…/v1"
          spellCheck={false}
          onChange={(event) => update({ baseUrl: event.target.value })}
        />

        <label htmlFor={ids.key}>API Key</label>
        <div className="field-row">
          <input
            id={ids.key}
            type="password"
            value={form.apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              keyKept ? `已保存（${saved?.keyHint ?? ""}），不改就留空` : keyOptional ? "本机服务可以不填" : "sk-…"
            }
            onChange={(event) => update({ apiKey: event.target.value })}
          />
          {preset.keyUrl && (
            <button type="button" onClick={() => void window.desktop.openExternal(preset.keyUrl!)}>
              获取 Key
            </button>
          )}
        </div>

        <label htmlFor={ids.model}>模型</label>
        <div className="field-row">
          <input
            id={ids.model}
            list={ids.models}
            value={form.model}
            placeholder={preset.modelHint ?? "点右边获取，或直接填写模型名"}
            spellCheck={false}
            onChange={(event) => update({ model: event.target.value })}
          />
          <button type="button" disabled={busy !== null} onClick={() => void listModels()}>
            {busy === "list" ? "获取中…" : "获取模型列表"}
          </button>
        </div>
        <datalist id={ids.models}>
          {models.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>

        <details className="modal-advanced">
          <summary>高级</summary>
          <label htmlFor={ids.window}>上下文窗口（token）</label>
          <input
            id={ids.window}
            inputMode="numeric"
            value={form.contextWindow}
            onChange={(event) => update({ contextWindow: event.target.value.replace(/[^\d]/g, "") })}
          />
          <small>模型一次能接收的长度。对话超过一半时会自动压缩较早的内容；填大了会被厂商拒绝请求。</small>
        </details>

        <p className="modal-note">
          长期记忆也用这个模型提取事实，会产生少量额外费用。agent 需要模型支持工具调用（function calling）。
        </p>

        {status && (
          <p className={status.ok ? "modal-status ok" : "modal-status bad"} role="status">
            {status.message}
          </p>
        )}

        <div className="actions">
          <button type="button" className="primary" disabled={busy !== null} onClick={() => void save()}>
            {busy === "save" ? "保存中…" : "保存"}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void test()}>
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
          <button type="button" disabled={busy === "save"} onClick={onClose}>
            {firstRun ? "稍后设置" : "取消"}
          </button>
        </div>
      </section>
    </div>
  );
}
