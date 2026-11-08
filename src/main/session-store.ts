import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SessionSummary, TurnView } from "../shared/types";
import type { ChatMessage, HistoryUpdate } from "./agent/model";

const SUMMARY_FILE = "summary.json";
const TURNS_FILE = "turns.jsonl";
const HISTORY_FILE = "chat_history.jsonl";
const TITLE_LENGTH = 40;

/** Session ids come back from the renderer and become directory names. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StoredSession {
  summary: SessionSummary;
  /** What the user saw, including turns that were cancelled or failed. */
  turns: TurnView[];
  /** What the model sees, without the system prompt, which is rebuilt on resume. */
  history: ChatMessage[];
  /** The summary of everything before `history`, once the session has been compacted. */
  contextSummary: string | null;
}

type HistoryLine = ChatMessage[] | { compaction: { summary: string; tail: ChatMessage[] } };

function titleFrom(userText: string): string {
  const line = userText.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH)}…` : line;
}

async function readLines<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const rows: T[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // A crash mid-write can only damage the end of the file, so what came before is good.
      break;
    }
  }
  return rows;
}

/**
 * One directory per session, with the layout borrowed from grok-build:
 *   summary.json        the index entry
 *   turns.jsonl         one turn per line, for the transcript
 *   chat_history.jsonl  one line per turn, each holding all of that turn's model messages
 *
 * A whole turn sharing one line is what keeps the history valid: a crash cannot leave a tool
 * call without its result, and DeepSeek rejects any request carrying one.
 *
 * Compaction appends a checkpoint line instead of rewriting the file, so the full history
 * stays on disk and loading simply starts again from the latest checkpoint.
 */
export class SessionStore {
  constructor(private readonly rootDir: string) {}

  async list(): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const summaries = await Promise.all(
      names.filter((name) => SESSION_ID.test(name)).map((name) => this.readSummary(name)),
    );
    return summaries
      .filter((summary) => summary !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(sessionId: string): Promise<StoredSession> {
    const directory = this.directory(sessionId);
    const summary = await this.readSummary(sessionId);
    if (!summary) throw new Error("这个会话已不存在");

    const [turns, lines] = await Promise.all([
      readLines<TurnView>(join(directory, TURNS_FILE)),
      readLines<HistoryLine>(join(directory, HISTORY_FILE)),
    ]);

    let history: ChatMessage[] = [];
    let contextSummary: string | null = null;
    for (const line of lines) {
      if (Array.isArray(line)) {
        history.push(...line);
      } else {
        history = [...line.compaction.tail];
        contextSummary = line.compaction.summary;
      }
    }
    return { summary, turns, history, contextSummary };
  }

  async appendTurn(sessionId: string, turn: TurnView, update: HistoryUpdate): Promise<void> {
    const directory = this.directory(sessionId);
    await mkdir(directory, { recursive: true });

    const now = new Date().toISOString();
    const previous = await this.readSummary(sessionId);
    const summary: SessionSummary = {
      id: sessionId,
      title: previous?.title ?? titleFrom(turn.userText),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      turnCount: (previous?.turnCount ?? 0) + 1,
    };

    await appendFile(join(directory, TURNS_FILE), `${JSON.stringify(turn)}\n`);
    const line: HistoryLine | null =
      update.kind === "compaction"
        ? { compaction: { summary: update.summary, tail: update.tail } }
        : update.messages.length > 0
          ? update.messages
          : null;
    if (line) await appendFile(join(directory, HISTORY_FILE), `${JSON.stringify(line)}\n`);

    // Written last and replaced atomically, so a session is only listed once it can be loaded.
    const path = join(directory, SUMMARY_FILE);
    await writeFile(`${path}.tmp`, JSON.stringify(summary, null, 2));
    await rename(`${path}.tmp`, path);
  }

  async delete(sessionId: string): Promise<void> {
    await rm(this.directory(sessionId), { recursive: true, force: true });
  }

  private directory(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error("无效的会话 ID");
    return join(this.rootDir, sessionId);
  }

  private async readSummary(sessionId: string): Promise<SessionSummary | null> {
    try {
      const text = await readFile(join(this.directory(sessionId), SUMMARY_FILE), "utf8");
      return JSON.parse(text) as SessionSummary;
    } catch {
      return null;
    }
  }
}
