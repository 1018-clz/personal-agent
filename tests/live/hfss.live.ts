// Runs a real HFSS simulation through the app's own MCP client and the bundled server, the way
// the agent would. Needs AEDT and `npm.cmd run install-hfss`; takes a few minutes.
//
// The numbers must match what the original project recorded for dr6g FILTER at coarse mesh:
// f0 7862.5 MHz, insertion loss 0.56 dB, 3 dB bandwidth 14.6 MHz, 14578 tetrahedra.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { McpClient } from "../../src/main/mcp/client";

const ROOT = resolve(__dirname, "..", "..");
const PROJECT = join(ROOT, "hfss", "hfss_agent", "tests", "fixtures", "dr6g", "dr6g.aedt");
const dataDir = mkdtempSync(join(tmpdir(), "hfss-live-"));
const client = new McpClient({
  name: "hfss",
  command: join(ROOT, ".hfss", "env", "Scripts", "python.exe"),
  args: ["-m", "hfss_agent.server"],
  cwd: join(ROOT, "hfss"),
  env: { ...process.env, HFSS_AGENT_DATA: dataDir, PYTHONIOENCODING: "utf-8" },
  startupTimeoutMs: 60_000,
  callTimeoutMs: 120_000,
});

type Job = { job_id: string; state: string; stage?: string; error?: string; result?: Record<string, any> };

async function call(name: string, args: Record<string, unknown>): Promise<Job> {
  return JSON.parse(await client.callTool(name, args)) as Job;
}

async function finished(jobId: string): Promise<Job> {
  for (;;) {
    const job = await call("get_job", { job_id: jobId, wait_seconds: 50 });
    console.log(`  ${jobId} ${job.state} ${job.stage ?? ""}`);
    if (job.state !== "queued" && job.state !== "running") return job;
  }
}

afterAll(async () => {
  await client.stop();
  // The runner stays idle for two minutes after the last job, holding its lock and log in the
  // data directory, so the folder may not be removable yet. That is not a test failure.
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    console.log(`临时数据目录还被后台 runner 占用，没有删除：${dataDir}`);
  }
});

// The project is the author's own design and is not in the public repository.
describe.skipIf(!existsSync(PROJECT))("real HFSS", () => {
  it("inspects and solves a project, matching the recorded results", async () => {
    await client.start();

    const inspected = await finished((await call("inspect_project", { project: PROJECT })).job_id);
    expect(inspected.state).toBe("done");
    const designs = inspected.result!.metrics.designs.map((design: { design: string }) => design.design);
    console.log("设计:", designs);
    expect(designs).toContain("FILTER");

    const job = await finished((await call("run_project", { project: PROJECT, design: "FILTER", mesh: "coarse" })).job_id);
    if (job.state !== "done") console.log(job.error);
    expect(job.state).toBe("done");
    const result = job.result!;
    const passband = result.metrics.s.passband;
    console.log("通带:", JSON.stringify(passband), "网格:", result.convergence.tets, "核数:", result.cores);
    expect(result.converged).toBe(true);
    expect(passband.f0_mhz).toBeCloseTo(7862.5, 0);
    expect(passband.il_db).toBeCloseTo(0.56, 1);
    expect(passband.bw3_mhz).toBeCloseTo(14.6, 0);
    expect(result.convergence.tets).toBe(14578);

    // Everything the run wrote is in the data directory given to the server, not next to the code.
    const log = readFileSync(join(dataDir, "runner.log"), "utf8");
    console.log(log.trim().split("\n")[0]);
    expect(log).toContain(dataDir);
  }, 1_800_000);
});
