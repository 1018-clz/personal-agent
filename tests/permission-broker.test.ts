import { describe, expect, it } from "vitest";

import { PermissionBroker } from "../src/main/permission-broker";
import type { AppEvent, PermissionAnswer } from "../src/shared/types";

const NEED = { title: "运行命令", detail: "rm notes.txt" };
const RULE = "run_command(git status *)";

function setup() {
  const events: AppEvent[] = [];
  const broker = new PermissionBroker((event) => events.push(event), () => "req-1");
  return { broker, events };
}

describe("PermissionBroker", () => {
  it("shows the prompt and resolves with the user's answer", async () => {
    const { broker, events } = setup();
    const response = broker.request(NEED, new AbortController().signal);

    broker.answer({ requestId: "req-1", allowed: true });

    await expect(response).resolves.toEqual({ allowed: true });
    expect(events).toEqual([
      { type: "permission-requested", prompt: { requestId: "req-1", ...NEED } },
      { type: "permission-resolved", requestId: "req-1" },
    ]);
  });

  it("denies on rejection", async () => {
    const { broker } = setup();
    const response = broker.request(NEED, new AbortController().signal);

    broker.answer({ requestId: "req-1", allowed: false });

    await expect(response).resolves.toEqual({ allowed: false });
  });

  it("treats a malformed answer as a denial", async () => {
    const { broker } = setup();
    const response = broker.request(NEED, new AbortController().signal);

    broker.answer({ requestId: "req-1", allowed: "yes" } as unknown as PermissionAnswer);

    await expect(response).resolves.toEqual({ allowed: false });
  });

  it("denies pending requests on cancelAll", async () => {
    const { broker } = setup();
    const response = broker.request(NEED, new AbortController().signal);

    broker.cancelAll();

    await expect(response).resolves.toEqual({ allowed: false });
  });

  it("denies when the turn is aborted", async () => {
    const { broker, events } = setup();
    const controller = new AbortController();
    const response = broker.request(NEED, controller.signal);

    controller.abort();

    await expect(response).resolves.toEqual({ allowed: false });
    expect(events.at(-1)).toEqual({ type: "permission-resolved", requestId: "req-1" });
  });

  it("shows the rule to remember and passes the chosen scope back", async () => {
    const { broker, events } = setup();
    const response = broker.request(NEED, new AbortController().signal, RULE);

    broker.answer({ requestId: "req-1", allowed: true, remember: "always" });

    await expect(response).resolves.toEqual({ allowed: true, remember: "always" });
    expect(events[0]).toEqual({
      type: "permission-requested",
      prompt: { requestId: "req-1", ...NEED, rememberRule: RULE },
    });
  });

  it("ignores remember when no rule was offered or the scope is unknown", async () => {
    const { broker } = setup();
    const withoutRule = broker.request(NEED, new AbortController().signal);
    broker.answer({ requestId: "req-1", allowed: true, remember: "session" });
    await expect(withoutRule).resolves.toEqual({ allowed: true });

    const badScope = broker.request(NEED, new AbortController().signal, RULE);
    broker.answer({ requestId: "req-1", allowed: true, remember: "forever" } as unknown as PermissionAnswer);
    await expect(badScope).resolves.toEqual({ allowed: true });
  });

  it("never remembers a refusal as an approval", async () => {
    const { broker } = setup();
    const response = broker.request(NEED, new AbortController().signal, RULE);

    broker.answer({ requestId: "req-1", allowed: false, remember: "always" });

    await expect(response).resolves.toEqual({ allowed: false });
  });
});
