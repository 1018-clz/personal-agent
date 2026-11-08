// Runs the real Hindsight client over real HTTP against a local server.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryService } from "../src/main/memory-service";
import type { MemoryStatus } from "../src/shared/types";

let server: Server | null = null;

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = null;
});

async function serve(status: number, body: unknown) {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const statuses: MemoryStatus[] = [];
  const memory = new MemoryService(
    { enabled: true, baseUrl: `http://127.0.0.1:${port}`, bankId: "new-bank", autoStart: false },
    (status) => statuses.push(status),
  );
  return { memory, statuses };
}

const memoryRow = (index: number) => ({ id: `m${index}`, text: `记忆 ${index}`, type: "world" });

describe("MemoryService", () => {
  it("treats a bank that does not exist yet as empty, not as offline", async () => {
    const { memory, statuses } = await serve(404, { detail: "Bank 'new-bank' not found" });

    await expect(memory.recall("你好")).resolves.toEqual([]);
    expect(statuses).toEqual(["online"]);
  });

  it("reports a real server failure as offline without breaking the turn", async () => {
    const { memory, statuses } = await serve(500, { detail: "boom" });

    await expect(memory.recall("你好")).resolves.toEqual([]);
    expect(statuses).toEqual(["offline"]);
  });

  it("keeps only the top memories for each turn", async () => {
    const { memory } = await serve(200, { results: Array.from({ length: 12 }, (_, index) => memoryRow(index)) });

    const memories = await memory.recall("你好");

    expect(memories.map((item) => item.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("gives the model every match when it searches on purpose", async () => {
    const { memory } = await serve(200, { results: Array.from({ length: 12 }, (_, index) => memoryRow(index)) });

    await expect(memory.search("你好")).resolves.toHaveLength(12);
  });
});
