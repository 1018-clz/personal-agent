import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

import type { AppEvent, HfssCurves, HfssJob, InstallTarget, SetupItem, SetupReport } from "../../shared/types";
import type { AgentUpdate } from "../agent/agent";
import { checkEvidence, jobIdsIn } from "./evidence";
import { isActive, JobWatcher } from "./job-watcher";

export const HFSS_SERVER = "hfss";
const PREFIX = `${HFSS_SERVER}__`;
/** Tools that put jobs in the queue: their results name the jobs to wait for. */
const SUBMITTING = new Set(["run_project", "submit_simulation", "sweep_project", "sweep_recipe", "inspect_project"]);
/** inspect_project takes half a minute: the model waits for it itself, so it is not reported back. */
const WAITED_BY_MODEL = new Set(["inspect_project"]);
const MAX_REPORTED_ERROR = 300;

/** What the app adds to the HFSS server's own instructions. */
export function hfssGuidance(autoAnalyze: boolean): string {
  return [
    "You specialize in Ansys HFSS simulation for antennas, filters and other RF structures.",
    "When you report a simulated number, say which job it came from, its mesh level and whether it converged.",
    "Never present a coarse or unconverged result as a final answer; say what it is good for instead.",
    "Read warnings and pitfalls in every result and act on them before drawing conclusions; each pitfall says how to fix it.",
    "Common pitfalls: the adaptive frequency far from the actual resonance (rerun with f0_ghz at the resonance);",
    "a resonance at the edge of the sweep (widen band_ghz); too few eigenmodes to judge mode spacing; convergence",
    "that stopped at the pass limit; very coarse meshes. Port and boundary setup errors show as no passband at all.",
    "To see how a parameter matters, use sweep_project or sweep_recipe instead of guessing one value at a time,",
    "and compare_jobs to read the sweep as one table.",
    "Never say you submitted, queued or ran a simulation unless a tool call in this same turn did it and returned",
    "its job id. If more runs are needed, call the tool now; if you only propose them, say they are not submitted.",
    "",
    "Waiting for simulations: a simulation takes minutes to hours.",
    autoAnalyze
      ? [
          "After you submit simulations (run_project, submit_simulation, sweeps), do not wait for them with get_job.",
          "Tell the user the job ids and what you will look at, then end your turn. The app watches the jobs in its",
          "task panel and, when all of them have finished, sends you a message marked 自动消息 listing them, so you",
          "can read the results with get_job or compare_jobs and analyze them then.",
        ].join("\n")
      : [
          "After you submit simulations, do not wait for them with get_job. Tell the user the job ids and end your",
          "turn; the user follows them in the app's task panel and will ask you about the results.",
        ].join("\n"),
    "Waiting with get_job's wait_seconds is fine for inspect_project, which takes about half a minute.",
    "",
    "The user's .aedt files are only ever read as copies; say so if they worry about their project.",
    "The HFSS tools run outside the sandbox and can read a project at any path the user gives, on any drive.",
    "Pass the path straight to the HFSS tool. Do not check it with run_command or the file tools first: those",
    "only see the workspace, so 'not found' or 'access denied' from them says nothing about the HFSS tools.",
    "Never ask the user to copy a project into the workspace. If an HFSS tool fails, tell the user its error",
    "message as it is, instead of guessing at a cause. When the environment seems broken, use check_setup.",
  ].join("\n");
}

export interface HfssServiceDeps {
  ready(): boolean;
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  restartServer(): Promise<void>;
  emit(event: AppEvent): void;
  sessionId(): string | null;
  /** A turn is running or the agent cannot take one: reports wait. */
  busy(): boolean;
  /** Starts a turn the app wrote, shown as such. */
  startAutoTurn(text: string): Promise<void>;
  refreshPrompt(): void;
  autoAnalyze: { get(): boolean; set(on: boolean): Promise<void> };
  /** Checks the app makes itself: the model, the memory service, the Python environments. */
  localChecks(): SetupItem[];
  installer(target: InstallTarget): { script: string; args: string[] } | null;
  /** After an install succeeded: start what it installed. */
  afterInstall(target: InstallTarget): Promise<void>;
  /** Where the jobs waited for are kept, so a restart does not forget them: [job id, session id]. */
  awaitedStore?: {
    load(): Promise<Array<[string, string]>>;
    save(entries: Array<[string, string]>): Promise<void>;
  };
}

interface TurnRecord {
  sources: string[];
  jobIds: Set<string>;
  /** A submit tool succeeded in this turn. */
  submitted: boolean;
}

/** The HFSS side of the app: the task panel, reports of finished jobs, evidence, setup checks. */
export class HfssService {
  private readonly watcher: JobWatcher;
  /** Jobs the model submitted and has not heard back about, with the session that submitted them. */
  private readonly awaited = new Map<string, string>();
  private turn: TurnRecord | null = null;
  private reporting = false;
  private installing: InstallTarget | null = null;

  constructor(private readonly deps: HfssServiceDeps) {
    this.watcher = new JobWatcher(
      { ready: () => deps.ready(), call: (tool, args) => deps.call(tool, args) },
      () => {
        this.publish();
        void this.maybeReport();
      },
      () => {},
    );
  }

  get jobs(): HfssJob[] {
    return this.watcher.snapshot;
  }

  start(): void {
    this.watcher.start();
    this.watcher.nudge(0);
  }

  stop(): void {
    this.watcher.stop();
  }

  publish(): void {
    this.deps.emit({ type: "hfss-jobs", jobs: this.watcher.snapshot, autoAnalyze: this.deps.autoAnalyze.get() });
  }

  async setAutoAnalyze(on: boolean): Promise<void> {
    await this.deps.autoAnalyze.set(on);
    this.publish();
    this.deps.refreshPrompt();
    if (on) void this.maybeReport();
  }

  /** The user cancelled it: there is nothing for the model to analyze, so no report for it. */
  async cancel(jobId: string): Promise<void> {
    await this.watcher.cancel(jobId);
    if (this.awaited.delete(jobId)) this.persist();
  }

  /** The jobs still waited for when the app last closed, so their results are reported after all. */
  async loadAwaited(): Promise<void> {
    try {
      for (const [job, session] of (await this.deps.awaitedStore?.load()) ?? []) {
        if (typeof job === "string" && typeof session === "string") this.awaited.set(job, session);
      }
    } catch {
      // A lost list only means these jobs are not reported by themselves; the panel still has them.
    }
  }

  private persist(): void {
    void this.deps.awaitedStore?.save([...this.awaited]).catch(() => {});
  }

  curves(jobId: string): Promise<HfssCurves> {
    return this.watcher.curves(jobId);
  }

  beginTurn(userText: string): void {
    this.turn = { sources: [userText], jobIds: new Set(), submitted: false };
  }

  /** Watches what the agent's HFSS tools return: submitted jobs and the numbers results contain. */
  observe(update: AgentUpdate): void {
    if (update.kind !== "tool-result" || !update.name.startsWith(PREFIX)) return;
    const tool = update.name.slice(PREFIX.length);
    if (this.turn) {
      this.turn.sources.push(update.content);
      if (update.args) this.turn.sources.push(JSON.stringify(update.args));
      if (update.ok && tool !== "list_jobs") for (const id of jobIdsIn(update.content)) this.turn.jobIds.add(id);
    }
    if (!update.ok || !SUBMITTING.has(tool)) return;
    if (this.turn && !WAITED_BY_MODEL.has(tool)) this.turn.submitted = true;
    this.watcher.nudge();
    if (WAITED_BY_MODEL.has(tool)) return;
    const session = this.deps.sessionId();
    if (!session) return;
    const jobs = submittedJobs(update.content);
    for (const job of jobs) this.awaited.set(job, session);
    if (jobs.length) this.persist();
  }

  /** After a turn: check its evidence, then report finished jobs if they were waiting for it. */
  endTurn(turnId: string, reply: string): void {
    const record = this.turn;
    this.turn = null;
    if (record) {
      const known = new Map(this.watcher.snapshot.map((job) => [job.id, job]));
      const evidence = checkEvidence({
        reply,
        sources: record.sources,
        jobIds: [...record.jobIds],
        known,
        submitted: record.submitted,
      });
      if (evidence) this.deps.emit({ type: "turn-evidence", turnId, evidence });
    }
    void this.maybeReport();
  }

  /** When every job a session waits for has ended, tell the model, in that session only. */
  async maybeReport(): Promise<void> {
    // Before the first list arrives every job looks missing: nothing can be decided yet.
    if (this.reporting || !this.watcher.loaded || !this.deps.autoAnalyze.get() || this.deps.busy()) return;
    const session = this.deps.sessionId();
    if (!session) return;
    const ids = [...this.awaited].filter(([, owner]) => owner === session).map(([id]) => id);
    if (!ids.length) return;
    const known = new Map(this.watcher.snapshot.map((job) => [job.id, job]));
    // Not in the recent list any more: so long ago that it cannot still be waited for.
    const gone = ids.filter((id) => !known.has(id));
    for (const id of gone) this.awaited.delete(id);
    const jobs = ids.flatMap((id) => (known.has(id) ? [known.get(id)!] : []));
    if (!jobs.length || jobs.some(isActive)) {
      if (gone.length) this.persist();
      return;
    }
    for (const job of jobs) this.awaited.delete(job.id);
    this.persist();
    this.reporting = true;
    let started = true;
    try {
      await this.deps.startAutoTurn(reportText(jobs));
    } catch {
      // The turn could not start (another one began first): keep the jobs for the next try.
      started = false;
      for (const job of jobs) this.awaited.set(job.id, session);
      this.persist();
    } finally {
      this.reporting = false;
    }
    // Jobs that ended during the report waited for it to finish: look again now.
    if (started) void this.maybeReport();
  }

  async checkSetup(): Promise<SetupReport> {
    const items = [...this.deps.localChecks()];
    if (this.deps.ready()) {
      try {
        const report = JSON.parse(await this.deps.call("check_setup", {})) as { items?: SetupItem[] };
        for (const item of report.items ?? []) {
          if (item && typeof item.name === "string" && ["ok", "warn", "fail"].includes(item.level)) {
            items.push({ name: item.name, level: item.level, detail: String(item.detail ?? ""), ...(item.fix ? { fix: String(item.fix) } : {}) });
          }
        }
      } catch (error) {
        items.push({ name: "HFSS 环境检查", level: "fail", detail: (error as Error).message });
      }
    }
    return { ok: items.every((item) => item.level !== "fail"), items };
  }

  /** Runs an install script, streaming its output to the setup dialog. One at a time. */
  async install(target: InstallTarget): Promise<void> {
    if (this.installing) throw new Error("已经在安装了，请等它结束");
    const plan = this.deps.installer(target);
    if (!plan) throw new Error("找不到安装脚本");
    if (!existsSync(plan.script)) throw new Error(`找不到安装脚本：${plan.script}`);
    this.installing = target;
    const send = (line?: string, done?: { ok: boolean; message: string }) =>
      this.deps.emit({ type: "setup-install", target, ...(line !== undefined ? { line } : {}), ...(done ? { done } : {}) });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", plan.script, ...plan.args],
          { windowsHide: true },
        );
        for (const stream of [child.stdout, child.stderr]) {
          createInterface({ input: stream }).on("line", (line) => {
            if (line.trim()) send(line);
          });
        }
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (code !== 0) {
        send(undefined, { ok: false, message: `安装没有成功（退出码 ${code ?? "未知"}），上面是它的输出` });
        return;
      }
      send("安装完成，正在启动…");
      await this.deps.afterInstall(target);
      send(undefined, { ok: true, message: "安装完成" });
    } catch (error) {
      send(undefined, { ok: false, message: (error as Error).message });
    } finally {
      this.installing = null;
    }
  }
}

/** Jobs a submitting tool queued: done ones (reused results) are already in the model's hands. */
export function submittedJobs(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as { job_id?: unknown; state?: unknown; jobs?: unknown };
    const rows = Array.isArray(parsed.jobs) ? (parsed.jobs as Array<Record<string, unknown>>) : [parsed];
    return rows.flatMap((row) =>
      typeof row.job_id === "string" && (row.state === "queued" || row.state === "running") ? [row.job_id] : [],
    );
  } catch {
    return [];
  }
}

function describe(job: HfssJob): string {
  const what = [job.design ?? `${job.recipe}/${job.analysis}`, job.mesh, job.sweep ? `${job.sweep.variable}=${job.sweep.value}` : ""]
    .filter(Boolean)
    .join("，");
  if (job.state === "done") {
    const converged = job.converged === false ? "未收敛" : job.converged ? "已收敛" : "完成";
    const pitfalls = job.pitfalls?.length ? `；有 ${job.pitfalls.length} 条 pitfalls` : "";
    return `- ${job.id}（${what}）：${converged}${pitfalls}；要点 ${JSON.stringify(job.key ?? {})}`;
  }
  if (job.state === "failed") return `- ${job.id}（${what}）：失败：${(job.error ?? "").slice(-MAX_REPORTED_ERROR)}`;
  return `- ${job.id}（${what}）：已取消`;
}

/** The message that hands finished jobs back to the model. */
export function reportText(jobs: HfssJob[]): string {
  const sweeps = [...new Set(jobs.flatMap((job) => (job.sweep ? [job.sweep.id] : [])))];
  const how = sweeps.length
    ? `用 compare_jobs(sweep_id=${sweeps.map((id) => `"${id}"`).join(" / ")}) 看整组结果，需要细节时再用 get_job。`
    : "用 get_job 取完整结果（看 use、warnings、pitfalls）。";
  return [
    "（自动消息，不是用户发的）你提交的仿真任务都结束了：",
    ...jobs.map(describe),
    "",
    `${how}然后告诉用户结论和下一步建议；每个数字注明来自哪个任务、网格档位、是否收敛。失败的任务说明原因和怎么改。`,
  ].join("\n");
}
