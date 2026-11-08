import type { AppEvent, PermissionAnswer, RememberScope } from "../shared/types";
import type { PermissionNeed } from "./agent/tools";

export interface UserDecision {
  allowed: boolean;
  /** Set only when the user allowed and chose to stop being asked. */
  remember?: RememberScope;
}

const DENIED: UserDecision = { allowed: false };

/** Parks tool permission requests until the user answers in the UI. */
export class PermissionBroker {
  private readonly pending = new Map<string, { remembers: boolean; resolve: (decision: UserDecision) => void }>();

  constructor(
    private readonly emit: (event: AppEvent) => void,
    private readonly newId: () => string,
  ) {}

  /** rememberRule is shown to the user; the rule itself stays here and is never sent back. */
  request(need: PermissionNeed, signal: AbortSignal, rememberRule?: string): Promise<UserDecision> {
    if (signal.aborted) return Promise.resolve(DENIED);

    const requestId = this.newId();
    return new Promise((resolve) => {
      const onAbort = () => this.settle(requestId, DENIED);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, {
        remembers: rememberRule !== undefined,
        resolve: (decision) => {
          signal.removeEventListener("abort", onAbort);
          resolve(decision);
        },
      });
      this.emit({
        type: "permission-requested",
        prompt: { requestId, ...need, ...(rememberRule ? { rememberRule } : {}) },
      });
    });
  }

  answer({ requestId, allowed, remember }: PermissionAnswer): void {
    // Only a literal true approves: a malformed answer must never run a tool.
    if (allowed !== true) return this.settle(requestId, DENIED);
    const remembers = this.pending.get(requestId)?.remembers ?? false;
    const scope = remember === "session" || remember === "always" ? remember : undefined;
    this.settle(requestId, remembers && scope ? { allowed: true, remember: scope } : { allowed: true });
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, DENIED);
  }

  private settle(requestId: string, decision: UserDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.resolve(decision);
    this.emit({ type: "permission-resolved", requestId });
  }
}
