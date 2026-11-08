import type { Completion, CompletionHandlers, CompletionRequest, ModelClient } from "./model";

export const MODEL_NOT_CONFIGURED = "还没有设置模型：请点右上角的「模型设置」，选择厂商并填写 API Key";

/**
 * Stands in for the model, so the user can change provider, model or key in the settings page
 * without restarting the app or losing the conversation, which is the same shape for all of them.
 */
export class SwitchableModel implements ModelClient {
  private current: ModelClient | null = null;

  set(model: ModelClient | null): void {
    this.current = model;
  }

  get configured(): boolean {
    return this.current !== null;
  }

  complete(request: CompletionRequest, handlers: CompletionHandlers, signal: AbortSignal): Promise<Completion> {
    // Read once: a change during a call applies from the next one.
    const model = this.current;
    if (!model) return Promise.reject(new Error(MODEL_NOT_CONFIGURED));
    return model.complete(request, handlers, signal);
  }
}
