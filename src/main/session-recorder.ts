import { chatReducer, initialChatState, type ChatState } from "../shared/chat-state";
import type { AppEvent, TurnView } from "../shared/types";
import type { HistoryUpdate } from "./agent/model";
import type { SessionStore } from "./session-store";

/**
 * Watches the same events the renderer gets and saves each turn when it finishes.
 *
 * Running the renderer's own reducer here is what guarantees that a reopened session looks
 * exactly like the one the user saw.
 */
export class SessionRecorder {
  private state: ChatState = initialChatState;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SessionStore,
    private readonly takeUnsavedHistory: () => HistoryUpdate,
    private readonly emit: (event: AppEvent) => void,
  ) {}

  get sessionId(): string | null {
    return this.state.sessionId;
  }

  get turns(): TurnView[] {
    return this.state.turns;
  }

  observe(event: AppEvent): void {
    this.state = chatReducer(this.state, event);
    if (event.type === "turn-ended" || event.type === "turn-failed") this.save(event.turnId);
  }

  /** Resolves once everything observed so far is on disk. */
  flush(): Promise<void> {
    return this.queue;
  }

  async publishSessions(): Promise<void> {
    this.emit({ type: "sessions-changed", sessions: await this.store.list() });
  }

  private save(turnId: string): void {
    const sessionId = this.state.sessionId;
    const turn = this.state.turns.find((candidate) => candidate.id === turnId);
    if (!sessionId || !turn) return;

    // Taken now, in step with the turn: by the time the queue runs, the next turn may have begun.
    const history = this.takeUnsavedHistory();
    this.queue = this.queue
      .then(() => this.store.appendTurn(sessionId, turn, history))
      .then(() => this.publishSessions())
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.emit({ type: "notice", message: `会话保存失败：${reason}` });
      });
  }
}
