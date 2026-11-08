import { HindsightClient, HindsightError } from "@vectorize-io/hindsight-client";

import type { MemorySnippet, MemoryStatus } from "../shared/types";
import type { HindsightConfig } from "./config";

const RECALL_TIMEOUT_MS = 4_000;
const HEALTH_TIMEOUT_MS = 2_000;
const TURN_RECALL_TOKENS = 1_024;
const PROFILE_RECALL_TOKENS = 512;
const PROFILE_QUERY = "用户的身份、偏好、长期目标和工作习惯";
/**
 * Without limits, recall fills its token budget even for "你好". No score floor can fix that
 * on its own: on Chinese memories, a related paraphrase can score 0.008 while "1+1 等于几？"
 * scores 0.05. The ranking is what holds up, so turns take the top few and the floor only
 * drops what is plainly unrelated. The model still has memory_search for anything missed.
 */
const TURN_RECALL_LIMIT = 5;
const TURN_RECALL_MIN_SCORES = { reranker: 0.001 };

export interface CompletedTurn {
  turnId: string;
  sessionId: string;
  userText: string;
  assistantText: string;
}

export interface MemoryPort {
  checkHealth(): Promise<boolean>;
  /** Automatic recall for each turn: only what is clearly relevant. */
  recall(query: string): Promise<MemorySnippet[]>;
  /** Deliberate lookup by the model, which can judge weaker matches itself. */
  search(query: string): Promise<MemorySnippet[]>;
  recallProfile(): Promise<MemorySnippet[]>;
  retain(turn: CompletedTurn): Promise<void>;
}

/** Memory must never take the chat down: every failure degrades to "no memories". */
export class MemoryService implements MemoryPort {
  private readonly client: HindsightClient | null;

  constructor(
    private readonly config: HindsightConfig,
    private readonly onStatus: (status: MemoryStatus, message?: string) => void,
  ) {
    this.client = config.enabled
      ? new HindsightClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, maxAttempts: 1 })
      : null;
    if (!this.client) onStatus("disabled");
  }

  async checkHealth(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.getVersion({ signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      this.onStatus("online");
      return true;
    } catch (error) {
      this.reportFailure(error);
      return false;
    }
  }

  async recall(query: string): Promise<MemorySnippet[]> {
    const memories = await this.fetchMemories(query, TURN_RECALL_TOKENS, TURN_RECALL_MIN_SCORES);
    return memories.slice(0, TURN_RECALL_LIMIT);
  }

  search(query: string): Promise<MemorySnippet[]> {
    return this.fetchMemories(query, TURN_RECALL_TOKENS);
  }

  recallProfile(): Promise<MemorySnippet[]> {
    return this.fetchMemories(PROFILE_QUERY, PROFILE_RECALL_TOKENS);
  }

  async retain(turn: CompletedTurn): Promise<void> {
    if (!this.client) return;
    const content = `User: ${turn.userText}\n\nAssistant: ${turn.assistantText}`;
    try {
      // Extraction runs an LLM server-side, so queue it instead of waiting.
      // Reusing the turn id as operationId makes a retried turn idempotent.
      await this.client.retain(this.config.bankId, content, {
        async: true,
        operationId: turn.turnId,
        timestamp: new Date(),
        context: "conversation between the user and their personal agent",
        metadata: { sessionId: turn.sessionId },
      });
      this.onStatus("online");
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private async fetchMemories(
    query: string,
    maxTokens: number,
    minScores?: { reranker: number },
  ): Promise<MemorySnippet[]> {
    if (!this.client) return [];
    try {
      const { results } = await this.client.recall(this.config.bankId, query, {
        maxTokens,
        minScores,
        signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
      });
      this.onStatus("online");
      return results.map((result) => ({
        id: result.id,
        text: result.text,
        type: result.type ?? null,
      }));
    } catch (error) {
      // The bank is only created by the first retain, so a new user starts here. The health
      // check has already passed by then, which rules out talking to the wrong server.
      if (error instanceof HindsightError && error.statusCode === 404) {
        this.onStatus("online");
        return [];
      }
      this.reportFailure(error);
      return [];
    }
  }

  private reportFailure(error: unknown): void {
    this.onStatus("offline", error instanceof Error ? error.message : String(error));
  }
}
