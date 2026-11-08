// IPC contract shared by the main process, the preload script and the renderer.

export type AgentStatus = "stopped" | "starting" | "ready" | "error";

export type MemoryStatus = "disabled" | "starting" | "online" | "offline";

export interface MemorySnippet {
  id: string;
  text: string;
  type: string | null;
}

export interface PermissionPrompt {
  requestId: string;
  title: string;
  /** What exactly will run or be written, shown in full before the user decides. */
  detail?: string;
  /** A diff is shown with added and removed lines marked. */
  detailFormat?: "text" | "diff";
  /** The rule that stops these questions, when one can be offered. Shown, never sent back. */
  rememberRule?: string;
}

/** session: until a new or other session starts. always: saved to permissions.json. */
export type RememberScope = "session" | "always";

/** What the settings page shows. The API key itself never reaches the renderer. */
export interface ModelSettingsView {
  provider: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  hasKey: boolean;
  /** The last characters of the saved key, so the user can tell which one it is. */
  keyHint?: string;
  configured: boolean;
}

export interface ModelSettingsInput {
  provider: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  /** Only when the user typed a new one; empty keeps the saved key for the same address. */
  apiKey?: string;
}

export interface ModelTestResult {
  ok: boolean;
  message: string;
}

/** An external tool server (MCP), such as the HFSS tools. */
export interface ToolServerStatus {
  name: string;
  label: string;
  state: "starting" | "ready" | "failed" | "stopped";
  /** Why it failed, for the tooltip. */
  message?: string;
  toolCount: number;
}

/** cancelled: the turn was stopped before the call finished. */
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface ToolView {
  id: string;
  title: string;
  status: ToolStatus;
  /** What the call works on, such as the command or the path, so nothing runs unseen. */
  detail?: string;
  /** Set when it ran without asking: which rule allowed it, or that the command only reads. */
  autoApproved?: string;
  /** Why it failed, as the model was told, so the user is not left guessing either. */
  error?: string;
  /** How much of the reply came before this call, so the text and the calls show in the order they happened. */
  textBefore?: number;
}

export type TurnState = "running" | "done" | "cancelled" | "failed";

export interface CompactionView {
  status: "running" | "done" | "failed";
  beforeTokens?: number;
  afterTokens?: number;
}

export interface TurnView {
  id: string;
  userText: string;
  /** Started by the app, not the user: finished simulations reported back to the model. */
  auto?: boolean;
  memories: MemorySnippet[];
  thought: string;
  reply: string;
  tools: ToolView[];
  state: TurnState;
  error?: string;
  compaction?: CompactionView;
  evidence?: EvidenceView;
}

/** How far a simulated number can be trusted, from its job's mesh level and convergence. */
export type EvidenceGrade = "final" | "trend" | "untrusted" | "unknown";

export interface EvidenceJob {
  id: string;
  mesh: string;
  converged: boolean | null;
  grade: EvidenceGrade;
}

/** Checked after a reply that used simulation results: where its numbers came from. */
export interface EvidenceView {
  jobs: EvidenceJob[];
  /** Numbers with RF units in the reply that no result, input or argument of the turn contains. */
  unmatched: string[];
  /** The reply uses coarse or unconverged results without saying they only show a trend. */
  missingCaveat: boolean;
  /** The reply says it submitted simulations, but no submit call in the turn did. */
  unbackedClaim?: boolean;
}

export type HfssJobState = "queued" | "running" | "done" | "failed" | "cancelled";

/** One simulation, as the task panel shows it. */
export interface HfssJob {
  id: string;
  recipe: string;
  analysis: string;
  mesh: string;
  state: HfssJobState;
  design?: string;
  project?: string;
  changed: Record<string, unknown>;
  sweep?: { id: string; variable: string; value: string };
  /** Place in the queue, from 1. */
  position?: number;
  stage?: string;
  cores?: number;
  /** Seconds since the epoch, as the server's clock says. */
  created: number;
  started?: number;
  finished?: number;
  elapsedS?: number;
  converged?: boolean | null;
  /** What the result is good for: "only a trend", "can be used for decisions"… */
  use?: string;
  /** The key numbers, as the server summarizes them. */
  key?: unknown;
  pitfalls?: string[];
  error?: string;
}

export interface HfssCurves {
  jobId: string;
  s: { fGhz: number[]; traces: Record<string, Array<number | null>> } | null;
  convergence: Array<{
    name: string;
    passes: Array<{ pass: number; tets: number | null; delta: number | null }>;
    criterion?: string | null;
    target?: number | null;
  }>;
  modes: Array<{ fGhz: number; q: number | null }> | null;
}

export type SetupLevel = "ok" | "warn" | "fail";

export interface SetupItem {
  name: string;
  level: SetupLevel;
  detail: string;
  fix?: string;
  /** Something the app can do about it from the dialog. */
  action?: InstallTarget;
}

/** What the setup dialog can install: the HFSS tools' Python environment, or the memory service. */
export type InstallTarget = "install-hfss" | "install-memory";

export interface SetupReport {
  ok: boolean;
  items: SetupItem[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

export type AppEvent =
  | { type: "agent-status"; status: AgentStatus; message?: string }
  | { type: "memory-status"; status: MemoryStatus; message?: string }
  /** label: the provider and model in use, shown in the top bar. */
  | { type: "model-status"; configured: boolean; label?: string }
  | { type: "tool-servers"; servers: ToolServerStatus[] }
  /** With turns, the transcript is replaced by them: a resumed session or a reloaded page. */
  | { type: "session-started"; sessionId: string; turns?: TurnView[] }
  | { type: "sessions-changed"; sessions: SessionSummary[] }
  | { type: "notice"; message: string }
  | { type: "turn-started"; turnId: string; userText: string; auto?: boolean }
  | { type: "turn-memories"; turnId: string; memories: MemorySnippet[] }
  | { type: "message-chunk"; turnId: string; text: string }
  | { type: "thought-chunk"; turnId: string; text: string }
  | {
      type: "tool-call";
      turnId: string;
      toolCallId: string;
      title: string;
      status: ToolStatus;
      detail?: string;
    }
  | {
      type: "tool-update";
      turnId: string;
      toolCallId: string;
      status: ToolStatus;
      autoApproved?: string;
      error?: string;
    }
  | { type: "compaction"; turnId: string; compaction: CompactionView }
  | { type: "turn-ended"; turnId: string; stopReason: string }
  | { type: "turn-failed"; turnId: string; message: string }
  | { type: "turn-evidence"; turnId: string; evidence: EvidenceView }
  /** autoAnalyze: finished jobs are reported back to the model by themselves. */
  | { type: "hfss-jobs"; jobs: HfssJob[]; autoAnalyze: boolean }
  /** Output of an install started from the setup dialog, line by line; done when it ends. */
  | { type: "setup-install"; target: InstallTarget; line?: string; done?: { ok: boolean; message: string } }
  | { type: "permission-requested"; prompt: PermissionPrompt }
  | { type: "permission-resolved"; requestId: string };

export interface PermissionAnswer {
  requestId: string;
  allowed: boolean;
  /** Adds the prompt's rememberRule, so the same kind of call no longer asks. */
  remember?: RememberScope;
}

export interface DesktopApi {
  sendPrompt(text: string): Promise<void>;
  cancelTurn(): Promise<void>;
  newSession(): Promise<void>;
  openSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  answerPermission(answer: PermissionAnswer): Promise<void>;
  getModelSettings(): Promise<ModelSettingsView>;
  saveModelSettings(input: ModelSettingsInput): Promise<void>;
  testModelSettings(input: ModelSettingsInput): Promise<ModelTestResult>;
  listModels(input: Pick<ModelSettingsInput, "provider" | "baseUrl" | "apiKey">): Promise<string[]>;
  /** Opens an http(s) link from the transcript in the user's browser. */
  openExternal(url: string): Promise<void>;
  cancelHfssJob(jobId: string): Promise<void>;
  getHfssCurves(jobId: string): Promise<HfssCurves>;
  setAutoAnalyze(on: boolean): Promise<void>;
  checkSetup(): Promise<SetupReport>;
  /** Installs an environment; progress arrives as setup-install events. */
  install(target: InstallTarget): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

export const IPC = {
  sendPrompt: "agent:send-prompt",
  cancelTurn: "agent:cancel-turn",
  newSession: "agent:new-session",
  openSession: "agent:open-session",
  deleteSession: "agent:delete-session",
  answerPermission: "agent:answer-permission",
  getModelSettings: "settings:get-model",
  saveModelSettings: "settings:save-model",
  testModelSettings: "settings:test-model",
  listModels: "settings:list-models",
  openExternal: "app:open-external",
  cancelHfssJob: "hfss:cancel-job",
  getHfssCurves: "hfss:curves",
  setAutoAnalyze: "hfss:auto-analyze",
  checkSetup: "hfss:check-setup",
  install: "setup:install",
  event: "app:event",
  rendererReady: "app:renderer-ready",
} as const;
