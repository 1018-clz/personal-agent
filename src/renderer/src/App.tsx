import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";

import { chatReducer, initialChatState, isTurnRunning, turnParts } from "../../shared/chat-state";
import type {
  AgentStatus,
  CompactionView,
  MemoryStatus,
  PermissionPrompt,
  RememberScope,
  SessionSummary,
  ToolServerStatus,
  EvidenceView,
  ToolView,
  TurnView,
} from "../../shared/types";
import { Markdown } from "./Markdown";
import { ModelSettingsDialog } from "./ModelSettings";
import { SetupDialog } from "./SetupDialog";
import { TaskPanel } from "./TaskPanel";

const AGENT_LABELS: Record<AgentStatus, string> = {
  stopped: "未启动",
  starting: "启动中",
  ready: "就绪",
  error: "异常",
};

const MEMORY_LABELS: Record<MemoryStatus, string> = {
  disabled: "已关闭",
  starting: "启动中",
  online: "在线",
  offline: "离线",
};

const TOOL_SERVER_LABELS: Record<ToolServerStatus["state"], string> = {
  starting: "启动中",
  ready: "已连接",
  failed: "不可用",
  stopped: "未启动",
};

const TURN_STATE_LABELS: Partial<Record<TurnView["state"], string>> = {
  cancelled: "已停止",
};

/** Below this window width the task panel starts closed. */
const PANEL_MIN_WINDOW = 1100;

const TOOL_STATUS_LABELS = {
  pending: "等待",
  in_progress: "运行中",
  completed: "完成",
  failed: "失败",
  cancelled: "已停止",
} as const;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function App() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  // On a narrow window the conversation needs the room: the panel starts closed, one click opens it.
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= PANEL_MIN_WINDOW);
  const askedForSettings = useRef(false);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  useEffect(() => window.desktop.onEvent(dispatch), []);
  useEffect(() => {
    // First run: nothing works without a model, so the settings open once by themselves.
    if (state.modelConfigured === false && !askedForSettings.current) {
      askedForSettings.current = true;
      setSettingsOpen(true);
    }
  }, [state.modelConfigured]);
  useEffect(() => {
    // Braces matter: scrollIntoView can return a promise, which React would call as cleanup.
    // An approval card counts too: a request the user cannot see would wait forever.
    transcriptEnd.current?.scrollIntoView({ block: "end" });
  }, [state.turns, state.permissions.length]);

  const running = isTurnRunning(state);
  const modelMissing = state.modelConfigured === false;
  const canSend = state.agentStatus === "ready" && !modelMissing && !running && draft.trim().length > 0;

  function run(action: Promise<void>) {
    setActionError(null);
    action.catch((error: unknown) => setActionError(errorMessage(error)));
  }

  function send() {
    if (!canSend) return;
    const text = draft;
    setDraft("");
    run(window.desktop.sendPrompt(text));
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // isComposing: Enter that confirms an IME candidate must not send the message.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  const sessionsLocked = state.agentStatus !== "ready" || running;
  const hfssServer = state.toolServers.find((server) => server.name === "hfss");
  const activeJobs = state.hfssJobs.filter((job) => job.state === "running" || job.state === "queued").length;

  return (
    <div className="app">
      <aside className="sidebar">
        <button
          type="button"
          className="new-session"
          disabled={sessionsLocked}
          onClick={() => run(window.desktop.newSession())}
        >
          新建会话
        </button>
        <nav className="session-list" aria-label="历史会话">
          {state.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === state.sessionId}
              disabled={sessionsLocked}
              onOpen={() => run(window.desktop.openSession(session.id))}
              onDelete={() => run(window.desktop.deleteSession(session.id))}
            />
          ))}
        </nav>
      </aside>

      <div className="workspace">
      <header className="topbar">
        <h1>Personal Agent</h1>
        <div className="status-group">
          <StatusPill label="Agent" value={AGENT_LABELS[state.agentStatus]} tone={agentTone(state.agentStatus)} />
          <StatusPill
            label="模型"
            value={state.modelLabel ?? (modelMissing ? "未设置" : "…")}
            tone={modelMissing ? "bad" : state.modelConfigured ? "good" : "muted"}
          />
          <StatusPill
            label="记忆"
            value={MEMORY_LABELS[state.memoryStatus]}
            tone={state.memoryStatus === "online" ? "good" : "muted"}
            title={state.memoryMessage}
          />
          {state.toolServers.map((server) => (
            <StatusPill
              key={server.name}
              label={server.label}
              value={TOOL_SERVER_LABELS[server.state]}
              tone={server.state === "ready" ? "good" : server.state === "failed" ? "bad" : "muted"}
              title={server.message ?? (server.state === "ready" ? `${server.toolCount} 个工具` : undefined)}
            />
          ))}
        </div>
        {hfssServer && (
          <button type="button" onClick={() => setPanelOpen((open) => !open)} aria-pressed={panelOpen}>
            任务{activeJobs ? `（${activeJobs}）` : ""}
          </button>
        )}
        <button type="button" onClick={() => setSetupOpen(true)}>
          环境检查
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)}>
          模型设置
        </button>
      </header>

      {settingsOpen && <ModelSettingsDialog firstRun={modelMissing} onClose={() => setSettingsOpen(false)} />}
      {setupOpen && <SetupDialog install={state.install} onClose={() => setSetupOpen(false)} />}

      {hfssServer?.state === "failed" && !setupOpen && (
        <div className="banner banner-action banner-warn" role="alert">
          HFSS 工具不可用：{hfssServer.message ?? "原因不明"}
          <button type="button" onClick={() => setSetupOpen(true)}>
            环境检查
          </button>
        </div>
      )}

      {modelMissing && !settingsOpen && (
        <div className="banner banner-action" role="alert">
          还没有设置模型，agent 无法回复。
          <button type="button" className="primary" onClick={() => setSettingsOpen(true)}>
            打开模型设置
          </button>
        </div>
      )}

      {state.agentStatus === "error" && state.agentMessage && (
        <div className="banner" role="alert">
          {state.agentMessage}
        </div>
      )}
      {(actionError ?? state.notice) && (
        <div className="banner" role="alert">
          {actionError ?? state.notice}
        </div>
      )}

      <main className="transcript">
        {state.turns.length === 0 && (
          <div className="empty">
            <p>有什么可以帮你？</p>
            <span>每轮对话会自动召回相关记忆，并在回复后写入 Hindsight。</span>
          </div>
        )}
        {state.turns.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
        {state.permissions.map((prompt) => (
          <PermissionCard key={prompt.requestId} prompt={prompt} />
        ))}
        <div ref={transcriptEnd} />
      </main>

      <footer className="composer">
        <textarea
          value={draft}
          placeholder={
            modelMissing
              ? "先在模型设置里填写 API"
              : state.agentStatus === "ready"
                ? "输入消息，Enter 发送，Shift+Enter 换行"
                : "等待 agent 就绪…"
          }
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerKeyDown}
        />
        {running ? (
          <button type="button" className="danger" onClick={() => run(window.desktop.cancelTurn())}>
            停止
          </button>
        ) : (
          <button type="button" className="primary" disabled={!canSend} onClick={send}>
            发送
          </button>
        )}
      </footer>
      </div>
      {hfssServer && panelOpen && (
        <TaskPanel
          jobs={state.hfssJobs}
          autoAnalyze={state.autoAnalyze}
          onError={setActionError}
          onOpenSetup={() => setSetupOpen(true)}
        />
      )}
    </div>
  );
}

function formatSessionTime(iso: string): string {
  const time = new Date(iso);
  const now = new Date();
  const sameDay = time.toDateString() === now.toDateString();
  const pad = (value: number) => String(value).padStart(2, "0");
  return sameDay
    ? `${pad(time.getHours())}:${pad(time.getMinutes())}`
    : `${time.getMonth() + 1}月${time.getDate()}日`;
}

function SessionRow(props: {
  session: SessionSummary;
  active: boolean;
  disabled: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { session, active, disabled, onOpen, onDelete } = props;
  // Deleting cannot be undone, so it takes a second click, and clicking away cancels it.
  const [confirming, setConfirming] = useState(false);

  return (
    <div className={active ? "session active" : "session"}>
      <button
        type="button"
        className="session-open"
        disabled={disabled}
        aria-current={active ? "true" : undefined}
        onClick={onOpen}
      >
        <span>{session.title}</span>
        <small>{formatSessionTime(session.updatedAt)}</small>
      </button>
      <button
        type="button"
        className={confirming ? "session-delete confirming" : "session-delete"}
        disabled={disabled}
        aria-label={confirming ? `确认删除“${session.title}”` : `删除“${session.title}”`}
        onBlur={() => setConfirming(false)}
        onClick={() => (confirming ? onDelete() : setConfirming(true))}
      >
        {confirming ? "确认" : "×"}
      </button>
    </div>
  );
}

function agentTone(status: AgentStatus): "good" | "bad" | "muted" {
  if (status === "ready") return "good";
  return status === "error" ? "bad" : "muted";
}

function StatusPill(props: {
  label: string;
  value: string;
  tone: "good" | "bad" | "muted";
  title?: string;
}) {
  return (
    <span className={`pill pill-${props.tone}`} title={props.title}>
      <i aria-hidden="true" />
      {props.label}：{props.value}
    </span>
  );
}

const GRADE_LABELS = {
  final: "细网格已收敛，可以用于结论",
  trend: "粗网格，只能看趋势",
  untrusted: "未收敛，数字不可信",
  unknown: "状态未知",
} as const;

/** Where the reply's numbers came from: shown under every reply that used simulation results. */
function EvidenceNote({ evidence }: { evidence: EvidenceView }) {
  const weak = evidence.jobs.some((job) => job.grade === "trend" || job.grade === "untrusted");
  const trouble = evidence.missingCaveat || evidence.unmatched.length > 0 || evidence.unbackedClaim === true;
  const tone = trouble ? "evidence-bad" : weak ? "evidence-weak" : "evidence-good";
  return (
    <details className={`evidence ${tone}`} open={trouble}>
      <summary>
        证据检查：
        {trouble
          ? evidence.unbackedClaim
            ? "回复说提交了仿真，但这一轮并没有调用提交工具：实际上什么都没有提交"
            : evidence.missingCaveat
            ? "回复用了粗网格或未收敛的结果，却没有说明只能看趋势"
            : `${evidence.unmatched.length} 个数字在本轮的仿真结果里找不到`
          : weak
            ? "数字来自粗网格或未收敛的任务，只能看趋势"
            : "数字都能对上仿真结果"}
      </summary>
      <ul>
        {evidence.jobs.map((job) => (
          <li key={job.id}>
            <code>{job.id}</code>：{GRADE_LABELS[job.grade]}
          </li>
        ))}
        {evidence.unmatched.length > 0 && (
          <li>
            找不到来源的数字：{evidence.unmatched.join("、")}（可能是模型推算或编造的，也可能是它换了写法）
          </li>
        )}
      </ul>
    </details>
  );
}

function ToolCard({ tool }: { tool: ToolView }) {
  return (
    <div className={`tool tool-${tool.status}`}>
      <div className="tool-main">
        <span>{tool.title}</span>
        {tool.detail && <code className="tool-detail">{tool.detail}</code>}
        {tool.autoApproved && (
          <span className="tool-auto" title="这次调用没有询问你">
            未询问：{tool.autoApproved}
          </span>
        )}
        {tool.error && <span className="tool-error">{tool.error}</span>}
      </div>
      <em>{TOOL_STATUS_LABELS[tool.status]}</em>
    </div>
  );
}

function Turn({ turn }: { turn: TurnView }) {
  const stateLabel = TURN_STATE_LABELS[turn.state];
  const parts = turnParts(turn);
  return (
    <section className="turn">
      {turn.auto ? (
        <details className="bubble auto">
          <summary>任务结束，应用自动把结果交给模型分析</summary>
          <div>{turn.userText}</div>
        </details>
      ) : (
        <div className="bubble user">{turn.userText}</div>
      )}
      {turn.compaction && <CompactionNote compaction={turn.compaction} />}

      {turn.memories.length > 0 && (
        <details className="trace">
          <summary>召回了 {turn.memories.length} 条记忆</summary>
          <ul>
            {turn.memories.map((memory) => (
              <li key={memory.id}>{memory.text}</li>
            ))}
          </ul>
        </details>
      )}

      {turn.thought && (
        <details className="trace">
          <summary>思考过程</summary>
          <p>{turn.thought}</p>
        </details>
      )}

      {parts.map((part, index) =>
        part.kind === "tool" ? (
          <ToolCard key={part.tool.id} tool={part.tool} />
        ) : (
          <div key={`text-${index}`} className="bubble agent">
            <Markdown text={part.text} />
          </div>
        ),
      )}
      {turn.state === "running" && parts.at(-1)?.kind !== "text" && <div className="thinking">正在处理…</div>}
      {turn.evidence && <EvidenceNote evidence={turn.evidence} />}
      {stateLabel && <div className="turn-note">{stateLabel}</div>}
      {turn.error && (
        <div className="turn-note error" role="alert">
          {turn.error}
        </div>
      )}
    </section>
  );
}

function formatTokens(tokens: number): string {
  return tokens >= 10_000 ? `${Math.round(tokens / 1_000)}K` : String(tokens);
}

function CompactionNote({ compaction }: { compaction: CompactionView }) {
  if (compaction.status === "running") return <div className="turn-note">正在整理较早的对话…</div>;
  if (compaction.status === "failed") {
    return <div className="turn-note">整理较早的对话失败，下一轮会重试</div>;
  }
  return (
    <div className="turn-note">
      已整理较早的对话（上下文 {formatTokens(compaction.beforeTokens ?? 0)} →{" "}
      {formatTokens(compaction.afterTokens ?? 0)} token）
    </div>
  );
}

function diffLineClass(line: string): string | undefined {
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-remove";
  return undefined;
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="diff" aria-label="改动内容">
      {diff.split("\n").map((line, index) => (
        // Block spans already break lines, so no newline is added between them.
        <span key={index} className={diffLineClass(line)}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function PermissionCard({ prompt }: { prompt: PermissionPrompt }) {
  const answer = (allowed: boolean, remember?: RememberScope) =>
    void window.desktop.answerPermission({ requestId: prompt.requestId, allowed, remember });

  return (
    <section className="permission" aria-label="权限请求">
      <h2>Agent 请求执行操作</h2>
      <p>{prompt.title}</p>
      {prompt.detail &&
        (prompt.detailFormat === "diff" ? (
          <DiffView diff={prompt.detail} />
        ) : (
          <pre>{prompt.detail}</pre>
        ))}
      {prompt.rememberRule && (
        <p className="remember-rule">
          记住后同类操作不再询问，规则：<code>{prompt.rememberRule}</code>
        </p>
      )}
      <div className="actions">
        <button type="button" className="primary" onClick={() => answer(true)}>
          允许
        </button>
        {prompt.rememberRule && (
          <>
            <button type="button" onClick={() => answer(true, "session")}>
              本会话内都允许
            </button>
            <button type="button" onClick={() => answer(true, "always")}>
              始终允许
            </button>
          </>
        )}
        <button type="button" onClick={() => answer(false)}>
          拒绝
        </button>
      </div>
    </section>
  );
}
