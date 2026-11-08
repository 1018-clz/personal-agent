import type { HfssCurves, HfssJob, HfssJobState } from "../../shared/types";

/** How the watcher reaches the HFSS server: the app's own calls, never the model's. */
export interface JobSource {
  ready(): boolean;
  call(tool: string, args: Record<string, unknown>): Promise<string>;
}

export interface JobWatcherOptions {
  /** Poll interval while a job is queued or running. */
  activeMs?: number;
  /** Poll interval otherwise: jobs can also come from another client of the same data directory. */
  idleMs?: number;
  /** How many recent jobs the panel shows. */
  limit?: number;
}

const ACTIVE: ReadonlySet<HfssJobState> = new Set(["queued", "running"]);
const STATES: ReadonlySet<string> = new Set(["queued", "running", "done", "failed", "cancelled"]);

export function isActive(job: Pick<HfssJob, "state">): boolean {
  return ACTIVE.has(job.state);
}

type Raw = Record<string, unknown>;

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** One row of list_jobs, checked: the server is another program, so nothing is taken on trust. */
export function toJob(raw: Raw): HfssJob | null {
  const id = str(raw.job_id);
  const state = str(raw.state);
  if (!id || !state || !STATES.has(state)) return null;
  const sweep = raw.sweep as Raw | undefined;
  const job: HfssJob = {
    id,
    recipe: str(raw.recipe) ?? "?",
    analysis: str(raw.analysis) ?? "?",
    mesh: str(raw.mesh) ?? "-",
    state: state as HfssJobState,
    changed: raw.changed && typeof raw.changed === "object" ? (raw.changed as Record<string, unknown>) : {},
    created: num(raw.created) ?? 0,
  };
  const optional: Partial<HfssJob> = {
    design: str(raw.design),
    project: str(raw.project),
    position: num(raw.position),
    stage: str(raw.stage),
    cores: num(raw.cores),
    started: num(raw.started),
    finished: num(raw.finished),
    elapsedS: num(raw.elapsed_s),
    use: str(raw.use),
    error: str(raw.error),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (job as unknown as Raw)[key] = value;
  }
  if (sweep && typeof sweep === "object" && str(sweep.id) && str(sweep.variable)) {
    job.sweep = { id: str(sweep.id)!, variable: str(sweep.variable)!, value: String(sweep.value ?? "") };
  }
  if (typeof raw.converged === "boolean" || raw.converged === null) job.converged = raw.converged as boolean | null;
  if (raw.key !== undefined) job.key = raw.key;
  if (Array.isArray(raw.pitfalls)) job.pitfalls = raw.pitfalls.filter((item): item is string => typeof item === "string");
  return job;
}

export function parseJobList(text: string): HfssJob[] {
  const parsed = JSON.parse(text) as { jobs?: unknown };
  if (!Array.isArray(parsed.jobs)) throw new Error("list_jobs 的结果里没有 jobs");
  return parsed.jobs.flatMap((raw) => {
    const job = raw && typeof raw === "object" ? toJob(raw as Raw) : null;
    return job ? [job] : [];
  });
}

export function parseCurves(text: string): HfssCurves {
  const raw = JSON.parse(text) as Raw;
  const s = raw.s as { f_ghz?: number[]; traces?: Record<string, Array<number | null>> } | null;
  const convergence = Array.isArray(raw.convergence) ? (raw.convergence as Raw[]) : [];
  const modes = Array.isArray(raw.modes) ? (raw.modes as Raw[]) : null;
  return {
    jobId: String(raw.job_id ?? ""),
    s: s && Array.isArray(s.f_ghz) && s.traces ? { fGhz: s.f_ghz, traces: s.traces } : null,
    convergence: convergence.map((entry) => ({
      name: String(entry.name ?? ""),
      passes: Array.isArray(entry.passes)
        ? (entry.passes as Raw[]).map((row) => ({
            pass: Number(row.pass),
            tets: num(row.tets) ?? null,
            delta: num(row.delta) ?? null,
          }))
        : [],
      criterion: str(entry.criterion) ?? null,
      target: num(entry.target) ?? null,
    })),
    modes: modes ? modes.map((mode) => ({ fGhz: Number(mode.f_ghz), q: num(mode.q) ?? null })) : null,
  };
}

/**
 * Keeps the task panel current and notices when jobs end, without the model: a simulation can run
 * for hours, and polling it through the model costs a model call each time and ends with the turn.
 */
export class JobWatcher {
  private jobs: HfssJob[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling: Promise<void> | null = null;
  private running = false;
  /** The list has been read at least once: until then, a job missing from it means nothing. */
  private loadedOnce = false;
  private readonly activeMs: number;
  private readonly idleMs: number;
  private readonly limit: number;

  constructor(
    private readonly source: JobSource,
    /** Every change of the list, for the panel. */
    private readonly onJobs: (jobs: HfssJob[]) => void,
    /** Jobs seen queued or running that have now ended. */
    private readonly onFinished: (jobs: HfssJob[]) => void,
    options: JobWatcherOptions = {},
  ) {
    this.activeMs = options.activeMs ?? 4_000;
    this.idleMs = options.idleMs ?? 30_000;
    this.limit = options.limit ?? 40;
  }

  get snapshot(): HfssJob[] {
    return this.jobs;
  }

  get loaded(): boolean {
    return this.loadedOnce;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Something was just submitted or cancelled: look soon instead of at the next idle poll. */
  nudge(delayMs = 300): void {
    if (this.running) this.schedule(delayMs);
  }

  /** Polls now; resolves when the list is current. Concurrent calls share one poll. */
  async poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  async cancel(jobId: string): Promise<void> {
    await this.source.call("cancel_job", { job_id: jobId });
    this.nudge(0);
  }

  async curves(jobId: string): Promise<HfssCurves> {
    return parseCurves(await this.source.call("job_curves", { job_id: jobId }));
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => {
        if (this.running && !this.timer) this.schedule(this.jobs.some(isActive) ? this.activeMs : this.idleMs);
      });
    }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.source.ready()) return;
    let next: HfssJob[];
    try {
      next = parseJobList(await this.source.call("list_jobs", { limit: this.limit }));
    } catch {
      // The panel keeps the last list; the server's own status shows in the top bar.
      return;
    }
    const before = new Map(this.jobs.map((job) => [job.id, job]));
    const finished = next.filter((job) => {
      const previous = before.get(job.id);
      return previous !== undefined && isActive(previous) && !isActive(job);
    });
    const changed = JSON.stringify(next) !== JSON.stringify(this.jobs) || !this.loadedOnce;
    this.jobs = next;
    this.loadedOnce = true;
    if (changed) this.onJobs(next);
    if (finished.length) this.onFinished(finished);
  }
}
