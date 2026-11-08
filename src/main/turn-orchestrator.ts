import type { AppEvent, TurnView } from "../shared/types";
import type { AgentUpdate } from "./agent/agent";
import type { ChatMessage } from "./agent/model";
import { buildPrompt, buildSessionRules } from "./memory-prompt";
import type { MemoryPort } from "./memory-service";

export interface AgentPort {
  newSession(systemPrompt: string): void;
  resumeSession(systemPrompt: string, history: ChatMessage[], contextSummary: string | null): void;
  setSystemPrompt(systemPrompt: string): void;
  runTurn(userText: string, signal: AbortSignal): Promise<string>;
}

interface ActiveTurn {
  turnId: string;
  sessionId: string;
  userText: string;
  reply: string;
  abort: AbortController;
}

const RETAINED_STOP_REASONS = new Set(["end_turn", "max_tokens"]);

/** For what the app does around turns: checking the evidence of a reply, reporting finished jobs. */
export interface TurnHooks {
  onTurnStart?(userText: string): void;
  /** After the turn ended normally (not when it failed). */
  onTurnEnd?(turnId: string, reply: string, stopReason: string): void;
}

/** Owns the recall → agent → retain loop around each user turn. */
export class TurnOrchestrator {
  private sessionId: string | null = null;
  private turn: ActiveTurn | null = null;
  private promptOutdated = false;

  constructor(
    private readonly agent: AgentPort,
    private readonly memory: MemoryPort,
    /** Async because it reads the user's AGENTS.md files afresh for every session. */
    private readonly buildSystemPrompt: (memoryRules: string) => string | Promise<string>,
    private readonly emit: (event: AppEvent) => void,
    private readonly newId: () => string,
    private readonly hooks: TurnHooks = {},
  ) {}

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  async startSession(): Promise<void> {
    if (this.turn) throw new Error("请等待当前回合结束后再新建会话");

    this.agent.newSession(await this.prepareSystemPrompt());
    this.sessionId = this.newId();
    this.emit({ type: "session-started", sessionId: this.sessionId });
  }

  async resumeSession(
    sessionId: string,
    { history, contextSummary, turns }: { history: ChatMessage[]; contextSummary: string | null; turns: TurnView[] },
  ): Promise<void> {
    if (this.turn) throw new Error("请等待当前回合结束后再切换会话");

    // Rebuilt rather than restored: the date and what is known about the user may have moved on.
    this.agent.resumeSession(await this.prepareSystemPrompt(), history, contextSummary);
    this.sessionId = sessionId;
    this.emit({ type: "session-started", sessionId, turns });
  }

  /** Memory came online after the session started, so its rules and profile were left out. */
  async refreshSystemPrompt(): Promise<void> {
    if (!this.sessionId) return;
    if (this.turn) {
      this.promptOutdated = true;
      return;
    }
    this.agent.setSystemPrompt(await this.prepareSystemPrompt());
  }

  private async prepareSystemPrompt(): Promise<string> {
    this.promptOutdated = false;
    const memoryOnline = await this.memory.checkHealth();
    const profile = memoryOnline ? await this.memory.recallProfile() : [];
    return this.buildSystemPrompt(buildSessionRules(profile, memoryOnline));
  }

  /** auto: the app wrote this message (finished jobs), not the user; the transcript shows it as such. */
  async send(userText: string, { auto = false }: { auto?: boolean } = {}): Promise<void> {
    if (!this.sessionId) throw new Error("agent 尚未就绪");
    if (this.turn) throw new Error("上一回合还在进行中");

    const turn: ActiveTurn = {
      turnId: this.newId(),
      sessionId: this.sessionId,
      userText,
      reply: "",
      abort: new AbortController(),
    };
    this.turn = turn;
    this.emit({ type: "turn-started", turnId: turn.turnId, userText, ...(auto ? { auto } : {}) });
    this.hooks.onTurnStart?.(userText);

    try {
      const memories = await this.memory.recall(userText);
      this.emit({ type: "turn-memories", turnId: turn.turnId, memories });

      if (turn.abort.signal.aborted) {
        this.emit({ type: "turn-ended", turnId: turn.turnId, stopReason: "cancelled" });
        return;
      }

      const stopReason = await this.agent.runTurn(
        buildPrompt(userText, memories),
        turn.abort.signal,
      );
      // Before turn-ended, so what it adds (the evidence check) is saved with the turn; and before the
      // turn is cleared, so a report it triggers waits; the app retries once it is.
      this.hooks.onTurnEnd?.(turn.turnId, turn.reply, stopReason);
      this.emit({ type: "turn-ended", turnId: turn.turnId, stopReason });

      if (RETAINED_STOP_REASONS.has(stopReason) && turn.reply.trim()) {
        // Retains the raw user text, not the prompt: storing the injected memories
        // again would feed recalled facts back into memory as if they were new.
        void this.memory.retain({
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          userText,
          assistantText: turn.reply,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "turn-failed", turnId: turn.turnId, message });
    } finally {
      this.turn = null;
      if (this.promptOutdated) void this.refreshSystemPrompt();
    }
  }

  cancel(): void {
    this.turn?.abort.abort();
  }

  handleUpdate(update: AgentUpdate): void {
    const turn = this.turn;
    if (!turn) return;
    const { turnId } = turn;

    switch (update.kind) {
      case "message":
        turn.reply += update.text;
        this.emit({ type: "message-chunk", turnId, text: update.text });
        break;
      case "thought":
        this.emit({ type: "thought-chunk", turnId, text: update.text });
        break;
      case "tool-call":
        this.emit({
          type: "tool-call",
          turnId,
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status,
          ...(update.detail ? { detail: update.detail } : {}),
        });
        break;
      case "tool-update":
        this.emit({
          type: "tool-update",
          turnId,
          toolCallId: update.toolCallId,
          status: update.status,
          ...(update.autoApproved ? { autoApproved: update.autoApproved } : {}),
          ...(update.error ? { error: update.error } : {}),
        });
        break;
      case "compaction": {
        const { kind: _kind, ...compaction } = update;
        this.emit({ type: "compaction", turnId, compaction });
        break;
      }
    }
  }
}
