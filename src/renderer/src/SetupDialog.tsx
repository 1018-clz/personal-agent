import { useCallback, useEffect, useRef, useState } from "react";

import type { InstallLog } from "../../shared/chat-state";
import type { InstallTarget, SetupReport } from "../../shared/types";
import { useEscape } from "./useEscape";

const LEVEL_ICONS = { ok: "✓", warn: "!", fail: "✕" } as const;
const ACTION_LABELS: Record<InstallTarget, string> = { "install-hfss": "安装 HFSS 环境", "install-memory": "安装记忆服务" };

/** Checks everything a simulation needs, says how to fix what fails, and installs what the app can. */
export function SetupDialog({ install, onClose }: { install: InstallLog | null; onClose: () => void }) {
  useEscape(onClose);
  const [report, setReport] = useState<SetupReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logEnd = useRef<HTMLSpanElement>(null);
  const installing = install !== null && !install.done;

  const check = useCallback(() => {
    setChecking(true);
    setError(null);
    window.desktop
      .checkSetup()
      .then(setReport)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setChecking(false));
  }, []);

  useEffect(check, [check]);
  // A finished install changes what the checks find.
  const doneOk = install?.done?.ok;
  useEffect(() => {
    if (doneOk) check();
  }, [doneOk, check]);
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [install?.lines.length]);

  function start(target: InstallTarget) {
    setError(null);
    window.desktop.install(target).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="环境检查">
        <h2>环境检查</h2>
        <p className="modal-intro">
          逐项检查仿真需要的东西。许可证只能查到服务器连不连得上，有没有空闲的 HFSS 许可要真正求解时才知道。
        </p>
        {checking && !report && <p className="modal-note">正在检查…（几秒钟）</p>}
        {error && <p className="modal-status bad">{error}</p>}
        {report && (
          <ul className="setup-list">
            {report.items.map((item) => (
              <li key={item.name} className={`setup-${item.level}`}>
                <span className="setup-icon" aria-label={item.level}>
                  {LEVEL_ICONS[item.level]}
                </span>
                <div>
                  <strong>{item.name}</strong>
                  <div className="setup-detail">{item.detail}</div>
                  {item.fix && <div className="setup-fix">{item.fix}</div>}
                  {item.action && (
                    <button type="button" className="primary" disabled={installing} onClick={() => start(item.action!)}>
                      {ACTION_LABELS[item.action]}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {install && (
          <div className="setup-log-box">
            <strong>
              {ACTION_LABELS[install.target]}
              {installing ? "：进行中…（可能要几分钟，可以关掉这个窗口）" : ""}
            </strong>
            <pre className="setup-log">
              {install.lines.join("\n")}
              <span ref={logEnd} />
            </pre>
            {install.done && (
              <p className={install.done.ok ? "modal-status ok" : "modal-status bad"}>{install.done.message}</p>
            )}
          </div>
        )}
        <div className="actions">
          <button type="button" disabled={checking} onClick={check}>
            {checking ? "检查中…" : "重新检查"}
          </button>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
