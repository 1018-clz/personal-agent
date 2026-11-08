import type {
  AgentStatus,
  AppEvent,
  HfssJob,
  InstallTarget,
  MemoryStatus,
  PermissionPrompt,
  SessionSummary,
  ToolServerStatus,
  ToolView,
  TurnView,
} from "./types";

export interface ChatState {
  agentStatus: AgentStatus;
  agentMessage?: string;
  memoryStatus: MemoryStatus;
  memoryMessage?: string;
  /** Null until the main process says, so the settings page does not flash open on startup. */
  modelConfigured: boolean | null;
  modelLabel?: string;
  toolServers: ToolServerStatus[];
  sessionId: string | null;
  sessions: SessionSummary[];
  turns: TurnView[];
  permissions: PermissionPrompt[];
  notice?: string;
  hfssJobs: HfssJob[];
  /** Finished jobs are reported back to the model by themselves. */
  autoAnalyze: boolean;
  /** The install running from the setup dialog, or the last one. */
  install: InstallLog | null;
}

export interface InstallLog {
  target: InstallTarget;
  lines: string[];
  done?: { ok: boolean; message: string };
}

/** The setup dialog shows the end of a long pip log, not all of it. */
const MAX_INSTALL_LINES = 200;

export const initialChatState: ChatState = {
  agentStatus: "stopped",
  memoryStatus: "offline",
  modelConfigured: null,
  toolServers: [],
  sessionId: null,
  sessions: [],
  turns: [],
  permissions: [],
  hfssJobs: [],
  autoAnalyze: true,
  install: null,
};

function updateTurn(
  state: ChatState,
  turnId: string,
  change: (turn: TurnView) => TurnView,
): ChatState {
  return {
    ...state,
    turns: state.turns.map((turn) => (turn.id === turnId ? change(turn) : turn)),
  };
}

export function isTurnRunning(state: ChatState): boolean {
  return state.turns.at(-1)?.state === "running";
}

/** A call the turn ended without: it will never finish, so it must not keep saying it runs. */
function settleTools(turn: TurnView): TurnView {
  const unfinished = (tool: ToolView) => tool.status === "pending" || tool.status === "in_progress";
  if (!turn.tools.some(unfinished)) return turn;
  return {
    ...turn,
    tools: turn.tools.map((tool) => (unfinished(tool) ? { ...tool, status: "cancelled" } : tool)),
  };
}

export type TurnPart = { kind: "text"; text: string } | { kind: "tool"; tool: ToolView };

/**
 * The reply and the tool calls in the order they happened: what the model said before a call
 * shows above it. Turns saved before calls knew their place show all calls first, as they used to.
 */
export function turnParts(turn: TurnView): TurnPart[] {
  const parts: TurnPart[] = [];
  let shown = 0;
  const addText = (end: number) => {
    const text = turn.reply.slice(shown, end);
    if (text.trim()) parts.push({ kind: "text", text });
    shown = Math.max(shown, end);
  };
  for (const tool of turn.tools) {
    addText(Math.min(tool.textBefore ?? 0, turn.reply.length));
    parts.push({ kind: "tool", tool });
  }
  addText(turn.reply.length);
  return parts;
}

export function chatReducer(state: ChatState, event: AppEvent): ChatState {
  switch (event.type) {
    case "agent-status":
      return { ...state, agentStatus: event.status, agentMessage: event.message };
    case "memory-status":
      return { ...state, memoryStatus: event.status, memoryMessage: event.message };
    case "model-status":
      return { ...state, modelConfigured: event.configured, modelLabel: event.label };
    case "tool-servers":
      return { ...state, toolServers: event.servers };
    case "session-started":
      return {
        ...state,
        sessionId: event.sessionId,
        turns: event.turns ?? [],
        permissions: event.sessionId === state.sessionId ? state.permissions : [],
      };
    case "sessions-changed":
      return { ...state, sessions: event.sessions };
    case "notice":
      return { ...state, notice: event.message };
    case "turn-started":
      return {
        ...state,
        turns: [
          ...state.turns,
          {
            id: event.turnId,
            userText: event.userText,
            ...(event.auto ? { auto: true } : {}),
            memories: [],
            thought: "",
            reply: "",
            tools: [],
            state: "running",
          },
        ],
      };
    case "turn-memories":
      return updateTurn(state, event.turnId, (turn) => ({ ...turn, memories: event.memories }));
    case "message-chunk":
      return updateTurn(state, event.turnId, (turn) => ({
        ...turn,
        reply: turn.reply + event.text,
      }));
    case "thought-chunk":
      return updateTurn(state, event.turnId, (turn) => ({
        ...turn,
        thought: turn.thought + event.text,
      }));
    case "tool-call":
      return updateTurn(state, event.turnId, (turn) => ({
        ...turn,
        tools: [
          ...turn.tools,
          {
            id: event.toolCallId,
            title: event.title,
            status: event.status,
            ...(event.detail ? { detail: event.detail } : {}),
            textBefore: turn.reply.length,
          },
        ],
      }));
    case "tool-update":
      return updateTurn(state, event.turnId, (turn) => ({
        ...turn,
        tools: turn.tools.map((tool) =>
          tool.id === event.toolCallId
            ? {
                ...tool,
                status: event.status,
                ...(event.autoApproved ? { autoApproved: event.autoApproved } : {}),
                ...(event.error ? { error: event.error } : {}),
              }
            : tool,
        ),
      }));
    case "compaction":
      return updateTurn(state, event.turnId, (turn) => ({ ...turn, compaction: event.compaction }));
    case "turn-ended":
      return updateTurn(state, event.turnId, (turn) => ({
        ...settleTools(turn),
        state: event.stopReason === "cancelled" ? "cancelled" : "done",
      }));
    case "turn-failed":
      return updateTurn(state, event.turnId, (turn) => ({
        ...settleTools(turn),
        state: "failed",
        error: event.message,
      }));
    case "turn-evidence":
      return updateTurn(state, event.turnId, (turn) => ({ ...turn, evidence: event.evidence }));
    case "hfss-jobs":
      return { ...state, hfssJobs: event.jobs, autoAnalyze: event.autoAnalyze };
    case "setup-install": {
      const fresh = !state.install || state.install.target !== event.target || state.install.done;
      const log: InstallLog = fresh ? { target: event.target, lines: [] } : state.install!;
      const lines = event.line === undefined ? log.lines : [...log.lines, event.line].slice(-MAX_INSTALL_LINES);
      return { ...state, install: { ...log, lines, ...(event.done ? { done: event.done } : {}) } };
    }
    case "permission-requested":
      return { ...state, permissions: [...state.permissions, event.prompt] };
    case "permission-resolved":
      return {
        ...state,
        permissions: state.permissions.filter((prompt) => prompt.requestId !== event.requestId),
      };
  }
}
