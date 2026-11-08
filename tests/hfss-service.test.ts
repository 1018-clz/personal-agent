import { describe, expect, it } from "vitest";

import { checkEvidence, grade, jobIdsIn, rfNumbers } from "../src/main/hfss/evidence";
import { HfssService, hfssGuidance, reportText, submittedJobs, type HfssServiceDeps } from "../src/main/hfss/hfss-service";
import { JobWatcher, parseCurves, parseJobList, toJob } from "../src/main/hfss/job-watcher";
import type { AgentUpdate } from "../src/main/agent/agent";
import type { AppEvent, HfssJob } from "../src/shared/types";

const J1 = "j20261108-211222-db09";
const J2 = "j20261108-211423-1338";
const J3 = "j20261108-211458-f8fb";

function raw(id: string, state: string, extra: Record<string, unknown> = {}) {
  return { job_id: id, recipe: "project", analysis: "run", mesh: "coarse", state, changed: {}, created: 1, ...extra };
}

const listing = (...jobs: unknown[]) => JSON.stringify({ jobs });

describe("job list from the server", () => {
  it("keeps what the panel needs and drops what is malformed", () => {
    const jobs = parseJobList(
      listing(
        raw(J1, "running", { stage: "求解", cores: 16, started: 100, elapsed_s: 30, design: "FILTER" }),
        raw(J2, "done", { converged: true, key: { passband: { f0_mhz: 7862.5 } }, pitfalls: ["a", 3], sweep: { id: "s1", variable: "g", value: "5mm" } }),
        { job_id: "x", state: "exploded" },
        "nonsense",
      ),
    );

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ id: J1, state: "running", stage: "求解", cores: 16, elapsedS: 30, design: "FILTER" });
    expect(jobs[1]).toMatchObject({ converged: true, pitfalls: ["a"], sweep: { id: "s1", variable: "g", value: "5mm" } });
    expect(toJob({ job_id: J3, state: "done", converged: null })?.converged).toBeNull();
    expect(() => parseJobList("{}")).toThrow(/jobs/);
  });

  it("reads curves into the renderer's shape", () => {
    const curves = parseCurves(
      JSON.stringify({
        job_id: J1,
        s: { f_ghz: [7.8, 7.9], traces: { "S(1,1)": [-3, -20] } },
        convergence: [{ name: "Setup", passes: [{ pass: 1, tets: 500, delta: null }, { pass: 2, tets: 900, delta: 0.1 }], criterion: "Max Mag. Delta S", target: 0.02 }],
        modes: [{ f_ghz: 7.86, q: 8792 }],
      }),
    );

    expect(curves.s?.fGhz).toEqual([7.8, 7.9]);
    expect(curves.convergence[0]?.passes[1]).toEqual({ pass: 2, tets: 900, delta: 0.1 });
    expect(curves.modes).toEqual([{ fGhz: 7.86, q: 8792 }]);
  });
});

describe("JobWatcher", () => {
  function watcherWith(responses: string[]) {
    const calls: string[] = [];
    const lists: HfssJob[][] = [];
    const finished: HfssJob[][] = [];
    const watcher = new JobWatcher(
      {
        ready: () => true,
        call: async (tool) => {
          calls.push(tool);
          return responses.shift() ?? listing();
        },
      },
      (jobs) => lists.push(jobs),
      (jobs) => finished.push(jobs),
    );
    return { watcher, calls, lists, finished };
  }

  it("reports jobs it saw running once they end, and only list changes", async () => {
    const { watcher, lists, finished } = watcherWith([
      listing(raw(J1, "running"), raw(J2, "done")),
      listing(raw(J1, "running"), raw(J2, "done")),
      listing(raw(J1, "done", { converged: true }), raw(J2, "done")),
    ]);

    await watcher.poll();
    await watcher.poll();
    await watcher.poll();

    expect(lists).toHaveLength(2);
    expect(finished).toEqual([[expect.objectContaining({ id: J1, state: "done" })]]);
  });

  it("keeps the last list when the server fails, and waits while it is not ready", async () => {
    const lists: HfssJob[][] = [];
    let ready = false;
    let fail = false;
    const watcher = new JobWatcher(
      {
        ready: () => ready,
        call: async () => {
          if (fail) throw new Error("服务崩了");
          return listing(raw(J1, "queued"));
        },
      },
      (jobs) => lists.push(jobs),
      () => {},
    );

    await watcher.poll();
    expect(lists).toHaveLength(0);
    ready = true;
    await watcher.poll();
    fail = true;
    await watcher.poll();
    expect(watcher.snapshot.map((job) => job.id)).toEqual([J1]);
  });
});

describe("evidence", () => {
  const known = new Map<string, HfssJob>([
    [J1, { id: J1, recipe: "project", analysis: "run", mesh: "coarse", state: "done", changed: {}, created: 1, converged: true }],
    [J2, { id: J2, recipe: "project", analysis: "run", mesh: "fine", state: "done", changed: {}, created: 1, converged: true }],
    [J3, { id: J3, recipe: "project", analysis: "run", mesh: "fine", state: "done", changed: {}, created: 1, converged: false }],
  ]);
  const result = JSON.stringify({ passband: { f0_mhz: 7862.5, il_db: 0.56, bw3_mhz: 14.6, s11_at_f0_db: -18.2 }, f_solve_ghz: 7.87 });

  it("grades jobs by mesh and convergence", () => {
    expect([...known.values()].map(grade)).toEqual(["trend", "final", "untrusted"]);
    expect(grade({ state: "running", mesh: "fine", converged: undefined })).toBe("unknown");
  });

  it("finds RF numbers however they are written", () => {
    expect(rfNumbers("f0 7.86 GHz，插损 0.56 dB，带宽14.6MHz，S11 −18.2 dB，增益 5 dBi").map((n) => n.value)).toEqual([
      7.86, 0.56, 14.6, -18.2, 5,
    ]);
  });

  it("matches numbers to results across units, signs, rounding and differences", () => {
    const reply = `${J2}（fine，已收敛）：中心 7.86 GHz（7862.5 MHz），插损 0.56 dB，带宽 14.6 MHz，S11 −18.2 dB，比自适应频点低 7.5 MHz。`;
    const evidence = checkEvidence({ reply, sources: [result], jobIds: [J2], known });

    expect(evidence).toEqual({ jobs: [{ id: J2, mesh: "fine", converged: true, grade: "final" }], unmatched: [], missingCaveat: false });
  });

  it("names numbers no result contains", () => {
    const evidence = checkEvidence({ reply: `${J2} 的带宽是 22.3 MHz，插损 0.56 dB。`, sources: [result], jobIds: [], known });
    expect(evidence?.unmatched).toEqual(["22.3 MHz"]);
  });

  it("flags coarse or unconverged numbers used without saying so", () => {
    const bare = checkEvidence({ reply: "中心频率 7.86 GHz，插损 0.56 dB。", sources: [result], jobIds: [J1], known });
    expect(bare?.missingCaveat).toBe(true);
    const careful = checkEvidence({ reply: "粗网格结果，只能看趋势：中心 7.86 GHz。", sources: [result], jobIds: [J1], known });
    expect(careful?.missingCaveat).toBe(false);
    const unconverged = checkEvidence({ reply: "中心 7.86 GHz。", sources: [result], jobIds: [J3], known });
    expect(unconverged?.jobs[0]?.grade).toBe("untrusted");
    expect(unconverged?.missingCaveat).toBe(true);
  });

  it("stays out of a reply that only lists queued jobs", () => {
    expect(checkEvidence({ reply: `已经排上队了：${J1}、${J2}`, sources: [], jobIds: [J1, J2], known, submitted: true })).toBeNull();
  });

  it("catches a reply that says it submitted when nothing was", () => {
    // Seen with a real model: "另外提交了两件事", and no tool call behind it.
    const claim = checkEvidence({ reply: "为了区分两种可能，我另外提交了两件事，等结果回来再说。", sources: [], jobIds: [], known, submitted: false });
    expect(claim).toEqual({ jobs: [], unmatched: [], missingCaveat: false, unbackedClaim: true });
    expect(checkEvidence({ reply: "我另外提交了两件事。", sources: [], jobIds: [], known, submitted: true })).toBeNull();
    expect(checkEvidence({ reply: "要不要我提交 fine 档？", sources: [], jobIds: [], known, submitted: false })).toBeNull();
  });

  it("has nothing to say about a reply that used no simulation", () => {
    expect(checkEvidence({ reply: "TE01δ 模式一般在 5 GHz 附近。", sources: [], jobIds: [], known })).toBeNull();
    expect(jobIdsIn(`{"job_id":"${J1}"} and ${J1}`)).toEqual([J1]);
  });
});

describe("reporting finished jobs", () => {
  function setup({
    auto = true,
    busy = false,
    saved = [],
    duringTurn,
    refuse = false,
  }: {
    auto?: boolean;
    busy?: boolean;
    /** What the awaited-jobs file held when the app started. */
    saved?: Array<[string, string]>;
    /** Runs inside the automatic turn, as if the model did something. */
    duringTurn?: () => Promise<void>;
    /** The automatic turn cannot start. */
    refuse?: boolean;
  } = {}) {
    const events: AppEvent[] = [];
    const turns: string[] = [];
    const store = { entries: saved };
    let session = "s1";
    let isBusy = busy;
    let response = listing();
    const deps: HfssServiceDeps = {
      ready: () => true,
      call: async () => response,
      restartServer: async () => {},
      emit: (event) => events.push(event),
      sessionId: () => session,
      busy: () => isBusy,
      startAutoTurn: async (text) => {
        if (refuse) throw new Error("上一回合还在进行中");
        turns.push(text);
        isBusy = true;
        await duringTurn?.();
        isBusy = false;
      },
      refreshPrompt: () => {},
      autoAnalyze: { get: () => auto, set: async (on) => void (auto = on) },
      localChecks: () => [],
      installer: () => null,
      afterInstall: async () => {},
      awaitedStore: {
        load: async () => store.entries,
        save: async (entries) => void (store.entries = entries),
      },
    };
    const service = new HfssService(deps);
    const submit = (content: object, name = "hfss__run_project") =>
      service.observe({ kind: "tool-result", toolCallId: "c", name, args: {}, ok: true, content: JSON.stringify(content) } as AgentUpdate);
    // Polls through the public path the watcher uses: list, then report.
    const poll = async (...jobs: object[]) => {
      response = listing(...jobs);
      await (service as unknown as { watcher: JobWatcher }).watcher.poll();
      await service.maybeReport();
    };
    const setResponse = (...jobs: object[]) => (response = listing(...jobs));
    return {
      service,
      events,
      turns,
      store,
      submit,
      poll,
      setResponse,
      setSession: (id: string) => (session = id),
      setBusy: (on: boolean) => (isBusy = on),
    };
  }

  it("waits until every job the session submitted has ended, then reports them once", async () => {
    const { submit, poll, turns } = setup();
    submit({ sweep_id: "s9", jobs: [{ job_id: J1, state: "queued" }, { job_id: J2, state: "queued" }, { job_id: J3, state: "done" }] });

    await poll(raw(J1, "running"), raw(J2, "queued"));
    await poll(raw(J1, "done", { converged: true }), raw(J2, "running"));
    expect(turns).toHaveLength(0);
    await poll(raw(J1, "done", { converged: true }), raw(J2, "failed", { error: "Traceback\n许可证不够" }));
    await poll(raw(J1, "done", { converged: true }), raw(J2, "failed", { error: "许可证不够" }));

    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain("自动消息");
    expect(turns[0]).toContain(J1);
    expect(turns[0]).toContain("许可证不够");
    expect(turns[0]).not.toContain(J3);
  });

  it("does not report into another session, a busy agent, or when switched off", async () => {
    const off = setup({ auto: false });
    off.submit({ job_id: J1, state: "queued" });
    await off.poll(raw(J1, "done"));
    expect(off.turns).toHaveLength(0);
    await off.service.setAutoAnalyze(true);
    expect(off.turns).toHaveLength(1);

    const other = setup();
    other.submit({ job_id: J1, state: "queued" });
    other.setSession("s2");
    await other.poll(raw(J1, "done"));
    expect(other.turns).toHaveLength(0);
    other.setSession("s1");
    await other.service.maybeReport();
    expect(other.turns).toHaveLength(1);

    const busy = setup({ busy: true });
    busy.submit({ job_id: J1, state: "queued" });
    await busy.poll(raw(J1, "done"));
    expect(busy.turns).toHaveLength(0);
    busy.setBusy(false);
    await busy.service.maybeReport();
    expect(busy.turns).toHaveLength(1);
  });

  it("remembers the jobs it waits for across a restart, and decides nothing before the first list", async () => {
    const before = setup();
    before.submit({ job_id: J1, state: "queued" });
    expect(before.store.entries).toEqual([[J1, "s1"]]);

    // The app restarts; the job failed while it was closed.
    const after = setup({ saved: before.store.entries });
    await after.service.loadAwaited();
    await after.service.maybeReport(); // no list yet: J1 must not be dropped as "gone"
    expect(after.store.entries).toEqual([[J1, "s1"]]);
    await after.poll(raw(J1, "failed", { error: "工程里没有设计 NOPE" }));

    expect(after.turns).toHaveLength(1);
    expect(after.turns[0]).toContain("工程里没有设计 NOPE");
    expect(after.store.entries).toEqual([]);
  });

  it("does not report a job the user cancelled", async () => {
    const { service, submit, poll, turns, store } = setup();
    submit({ job_id: J1, state: "queued" });
    await poll(raw(J1, "running"));

    await service.cancel(J1);
    await poll(raw(J1, "cancelled"));

    expect(turns).toHaveLength(0);
    expect(store.entries).toEqual([]);
  });

  it("keeps the jobs when the report cannot start, and reports what ended during a report", async () => {
    const refused = setup({ refuse: true });
    refused.submit({ job_id: J1, state: "queued" });
    await refused.poll(raw(J1, "done"));
    expect(refused.store.entries).toEqual([[J1, "s1"]]);

    // During the first report the model submits J2, which ends before the report does.
    let first = true;
    const chained = setup({
      duringTurn: async () => {
        if (!first) return;
        first = false;
        chained.submit({ job_id: J2, state: "queued" });
        chained.setResponse(raw(J1, "done"), raw(J2, "done"));
        // A real turn takes a while: the poll that started it has finished by the next one.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await (chained.service as unknown as { watcher: JobWatcher }).watcher.poll();
      },
    });
    chained.submit({ job_id: J1, state: "queued" });
    await chained.poll(raw(J1, "done"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chained.turns).toHaveLength(2);
    expect(chained.turns[1]).toContain(J2);
  });

  it("does not report what the model waited for itself", async () => {
    const { submit, poll, turns } = setup();
    submit({ job_id: J1, state: "queued" }, "hfss__inspect_project");
    await poll(raw(J1, "done"));
    expect(turns).toHaveLength(0);
  });

  it("checks the evidence of a reply that used results", () => {
    const { service, events } = setup();
    service.beginTurn("看一下结果");
    service.observe({
      kind: "tool-result",
      toolCallId: "c",
      name: "hfss__get_job",
      args: { job_id: J1 },
      ok: true,
      content: JSON.stringify({ job_id: J1, result: { metrics: { s: { passband: { f0_mhz: 7862.5 } } } } }),
    });
    service.endTurn("t1", "中心频率 7862.5 MHz，带宽 99 MHz");

    expect(events).toContainEqual({
      type: "turn-evidence",
      turnId: "t1",
      evidence: { jobs: [{ id: J1, mesh: "?", converged: null, grade: "unknown" }], unmatched: ["99 MHz"], missingCaveat: false },
    });
  });

  it("reads which jobs a submission queued, and writes a report the model can act on", () => {
    expect(submittedJobs(JSON.stringify({ job_id: J1, state: "queued" }))).toEqual([J1]);
    expect(submittedJobs(JSON.stringify({ job_id: J1, state: "done", reused: true }))).toEqual([]);
    expect(submittedJobs("not json")).toEqual([]);
    const text = reportText([
      { id: J1, recipe: "project", analysis: "run", mesh: "coarse", state: "done", changed: {}, created: 1, converged: true, sweep: { id: "s7", variable: "g", value: "5mm" }, pitfalls: ["x"] },
    ]);
    expect(text).toContain('compare_jobs(sweep_id="s7")');
    expect(text).toContain("1 条 pitfalls");
  });

  it("tells the model not to wait, and how the results come back", () => {
    expect(hfssGuidance(true)).toContain("自动消息");
    expect(hfssGuidance(false)).not.toContain("自动消息");
    expect(hfssGuidance(true)).toContain("do not wait for them");
  });
});
