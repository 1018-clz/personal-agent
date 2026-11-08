import { useEffect, useMemo, useState } from "react";

import type { HfssCurves, HfssJob } from "../../shared/types";
import { Chart, type Series } from "./Chart";
import { useEscape } from "./useEscape";

const STATE_LABELS: Record<HfssJob["state"], string> = {
  queued: "排队",
  running: "运行中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
};

const MESH_LABELS: Record<string, string> = { coarse: "粗网格", fine: "细网格", verify: "复核", "-": "" };

type Key = Record<string, unknown>;
const isObject = (value: unknown): value is Key => typeof value === "object" && value !== null && !Array.isArray(value);
const n = (value: unknown, digits = 4) => (typeof value === "number" ? String(Number(value.toPrecision(digits))) : "?");

/** The few numbers worth showing on a job's card, from whatever its recipe reports. */
export function keyLines(key: unknown): string[] {
  if (!isObject(key)) return [];
  const lines: string[] = [];
  const passband = isObject(key.passband) ? key.passband : typeof key.f0_mhz === "number" ? key : null;
  if (passband) lines.push(`f0 ${n(passband.f0_mhz, 6)} MHz · 插损 ${n(passband.il_db, 3)} dB · 带宽 ${n(passband.bw3_mhz, 3)} MHz`);
  if ("te01d_ghz" in key) {
    lines.push(`TE01δ ${n(key.te01d_ghz, 6)} GHz · Q0 ${n(key.q0, 4)} · 最近模式差 ${n(key.mode_spacing_mhz, 4)} MHz`);
  }
  if (Array.isArray(key.modes_ghz_q)) {
    const modes = (key.modes_ghz_q as unknown[][]).map(([f, q]) => `${n(f, 6)} GHz${typeof q === "number" ? ` (Q ${n(q, 4)})` : ""}`);
    lines.push(`模式 ${modes.join("、")}`);
  }
  if (Array.isArray(key.designs)) lines.push(`设计 ${(key.designs as unknown[]).join("、")}`);
  if (!passband) {
    for (const [name, value] of Object.entries(key)) {
      // A reflection minimum: [MHz, dB], e.g. an antenna's S11.
      if (/^S\w*\((\d+),\1\)$/.test(name) && Array.isArray(value)) lines.push(`${name} 谷 ${n(value[0], 6)} MHz ${n(value[1], 3)} dB`);
    }
  }
  if (isObject(key.far_field)) {
    lines.push(`增益 ${n(key.far_field.peak_realized_gain_dbi, 3)} dBi · 效率 ${n(key.far_field.total_efficiency, 2)}`);
  }
  return lines;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

function title(job: HfssJob): string {
  if (job.design) return job.analysis === "inspect" ? "查看工程" : job.design;
  return `${job.recipe} · ${job.analysis}`;
}

function changedText(job: HfssJob): string {
  const entries = Object.entries(job.changed).filter(([name]) => name !== job.sweep?.variable);
  return entries.map(([name, value]) => `${name}=${String(value)}`).join(" ");
}

/** Seconds of the clock, ticking once a second while something runs. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

interface TaskPanelProps {
  jobs: HfssJob[];
  autoAnalyze: boolean;
  onError: (message: string) => void;
  onOpenSetup: () => void;
}

/** The simulations, live: what runs, what waits, what came out. Fed by the main process, not the model. */
export function TaskPanel({ jobs, autoAnalyze, onError, onOpenSetup }: TaskPanelProps) {
  const now = useNow(jobs.some((job) => job.state === "running"));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<HfssJob | null>(null);
  const [comparing, setComparing] = useState<HfssJob[] | null>(null);

  const visible = jobs.filter((job) => job.analysis !== "inspect" || job.state !== "done");
  const running = jobs.filter((job) => job.state === "running").length;
  const queued = jobs.filter((job) => job.state === "queued").length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function act(action: Promise<void>) {
    action.catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
  }

  return (
    <aside className="task-panel" aria-label="仿真任务">
      <div className="task-panel-head">
        <h2>仿真任务</h2>
        <span className="task-counts">
          {running ? `${running} 个运行中` : ""}
          {running && queued ? "，" : ""}
          {queued ? `${queued} 个排队` : ""}
          {!running && !queued ? "空闲" : ""}
        </span>
      </div>
      <label className="task-toggle" title="开着时，模型提交的任务全部结束后，应用会自动把结果交给模型分析（会调用一次模型）">
        <input type="checkbox" checked={autoAnalyze} onChange={(event) => act(window.desktop.setAutoAnalyze(event.target.checked))} />
        任务结束后自动分析
      </label>
      {selected.size >= 2 && (
        <div className="task-compare-bar">
          <button type="button" className="primary" onClick={() => setComparing(jobs.filter((job) => selected.has(job.id)))}>
            对比 {selected.size} 个任务
          </button>
          <button type="button" onClick={() => setSelected(new Set())}>
            清除
          </button>
        </div>
      )}
      <div className="task-list">
        {visible.length === 0 && (
          <p className="task-empty">
            还没有仿真任务。让 agent 查看或仿真一个 .aedt 工程，任务会出现在这里。
            <button type="button" onClick={onOpenSetup}>
              检查仿真环境
            </button>
          </p>
        )}
        {visible.map((job, index) => {
          const previous = visible[index - 1];
          const groupStart = job.sweep && job.sweep.id !== previous?.sweep?.id;
          const group = groupStart ? visible.filter((other) => other.sweep?.id === job.sweep!.id) : [];
          return (
            <div key={job.id}>
              {groupStart && (
                <div className="task-group">
                  <span>
                    扫参 {job.sweep!.variable}：{group.length} 个点
                  </span>
                  {group.filter((g) => g.state === "done").length >= 2 && (
                    <button type="button" onClick={() => setComparing(group.filter((g) => g.state === "done"))}>
                      对比这组
                    </button>
                  )}
                </div>
              )}
              <JobCard
                job={job}
                now={now}
                selected={selected.has(job.id)}
                onToggle={() => toggle(job.id)}
                onOpen={() => setDetail(job)}
                onCancel={() => act(window.desktop.cancelHfssJob(job.id))}
              />
            </div>
          );
        })}
      </div>
      {detail && <JobDetail job={jobs.find((job) => job.id === detail.id) ?? detail} onClose={() => setDetail(null)} />}
      {comparing && <CompareDialog jobs={comparing} onClose={() => setComparing(null)} />}
    </aside>
  );
}

function JobCard(props: {
  job: HfssJob;
  now: number;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const { job, now, selected, onToggle, onOpen, onCancel } = props;
  const elapsed = job.state === "running" && job.started ? now - job.started : job.elapsedS;
  const changed = changedText(job);
  const lines = job.state === "done" ? keyLines(job.key) : [];
  const canChart = job.state === "done" && job.analysis !== "inspect";
  return (
    <div className={`task-card task-${job.state}`}>
      <div className="task-card-head">
        {canChart && (
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`选中 ${job.id} 用来对比`} />
        )}
        <strong>{title(job)}</strong>
        {MESH_LABELS[job.mesh] && <span className={`tag mesh-${job.mesh}`}>{MESH_LABELS[job.mesh]}</span>}
        <span className={`tag state-${job.state}`}>{STATE_LABELS[job.state]}</span>
      </div>
      {(job.sweep || changed) && (
        <div className="task-meta">
          {job.sweep && (
            <b>
              {job.sweep.variable}={job.sweep.value}{" "}
            </b>
          )}
          {changed}
        </div>
      )}
      {job.state === "queued" && <div className="task-meta">排队第 {job.position ?? "?"} 位</div>}
      {job.state === "running" && (
        <div className="task-meta">
          {job.stage ?? "运行中"}
          {elapsed !== undefined ? ` · ${formatDuration(elapsed)}` : ""}
          {job.cores ? ` · ${job.cores} 核` : ""}
        </div>
      )}
      {job.state === "done" && job.converged !== null && job.converged !== undefined && (
        <div className={job.converged ? "task-converged" : "task-unconverged"}>
          {job.converged ? "已收敛" : "未收敛：数字不可信"}
          {elapsed !== undefined ? ` · 用时 ${formatDuration(elapsed)}` : ""}
        </div>
      )}
      {lines.map((line) => (
        <div key={line} className="task-key">
          {line}
        </div>
      ))}
      {job.pitfalls && job.pitfalls.length > 0 && (
        <div className="task-pitfalls" title={job.pitfalls.join("\n")}>
          ⚠ {job.pitfalls.length} 个需要注意的问题
        </div>
      )}
      {job.state === "failed" && job.error && <div className="task-error">{job.error.split("\n").filter(Boolean).at(-1)}</div>}
      <div className="task-actions">
        <code>{job.id}</code>
        {canChart && (
          <button type="button" onClick={onOpen}>
            详情和曲线
          </button>
        )}
        {(job.state === "queued" || job.state === "running") && (
          <button type="button" className="danger" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </div>
  );
}

function useCurves(ids: string[]): { curves: Map<string, HfssCurves>; error: string | null; loading: boolean } {
  const [curves, setCurves] = useState<Map<string, HfssCurves>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const key = ids.join(",");
  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all(ids.map((id) => window.desktop.getHfssCurves(id).then((c) => [id, c] as const)))
      .then((entries) => live && setCurves(new Map(entries)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { curves, error, loading };
}

const freq = (x: number) => String(Number(x.toPrecision(5)));

function JobDetail({ job, onClose }: { job: HfssJob; onClose: () => void }) {
  useEscape(onClose);
  const { curves, error, loading } = useCurves([job.id]);
  const data = curves.get(job.id);
  const sSeries: Series[] = data?.s
    ? Object.entries(data.s.traces).map(([name, y]) => ({ name, x: data.s!.fGhz, y }))
    : [];
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label={`任务 ${job.id}`}>
        <h2>
          {title(job)} <small>{job.id}</small>
        </h2>
        <p className="modal-intro">
          {MESH_LABELS[job.mesh] || job.mesh}
          {job.converged === true ? " · 已收敛" : job.converged === false ? " · 未收敛" : ""}
          {job.use ? ` · ${job.use}` : ""}
        </p>
        {job.pitfalls && job.pitfalls.length > 0 && (
          <ul className="pitfall-list">
            {job.pitfalls.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        )}
        {keyLines(job.key).map((line) => (
          <div key={line} className="task-key">
            {line}
          </div>
        ))}
        {loading && <p className="modal-note">正在读取曲线…</p>}
        {error && <p className="modal-status bad">{error}</p>}
        {sSeries.length > 0 && (
          <>
            <h3>S 参数</h3>
            <Chart series={sSeries} xLabel="频率 (GHz)" yLabel="dB" formatX={freq} />
          </>
        )}
        {data?.convergence.map((conv) => (
          <div key={conv.name}>
            <h3>
              收敛过程{data.convergence.length > 1 ? `（${conv.name}）` : ""}
              {conv.passes.at(-1)?.tets ? <small> 最终 {conv.passes.at(-1)!.tets} 个四面体</small> : null}
            </h3>
            <Chart
              series={[{ name: conv.criterion ?? "Δ", x: conv.passes.map((p) => p.pass), y: conv.passes.map((p) => p.delta) }]}
              xLabel="第几次加密"
              yLabel="Δ"
              height={200}
              logY
              points
              reference={conv.target ? { y: conv.target, label: `目标 ${conv.target}` } : undefined}
              formatX={(x) => String(Math.round(x))}
            />
          </div>
        ))}
        {data?.modes && data.modes.length > 0 && (
          <>
            <h3>本征模</h3>
            <table className="md-table mode-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>频率 (GHz)</th>
                  <th>Q</th>
                </tr>
              </thead>
              <tbody>
                {data.modes.map((mode, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{mode.fGhz}</td>
                    <td>{mode.q === null ? "—" : Number(mode.q.toPrecision(5))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function label(job: HfssJob): string {
  if (job.sweep) return `${job.sweep.variable}=${job.sweep.value}`;
  const changed = changedText(job);
  return changed ? `${job.id.slice(-4)} ${changed}` : job.id;
}

function CompareDialog({ jobs, onClose }: { jobs: HfssJob[]; onClose: () => void }) {
  useEscape(onClose);
  const ids = jobs.map((job) => job.id);
  const { curves, error, loading } = useCurves(ids);
  const traces = useMemo(() => {
    const names = new Set<string>();
    for (const c of curves.values()) for (const name of Object.keys(c.s?.traces ?? {})) names.add(name);
    return [...names];
  }, [curves]);
  const [trace, setTrace] = useState<string | null>(null);
  const chosen = trace ?? traces.find((name) => /\((\d+),(?!\1)\d+\)/.test(name)) ?? traces[0] ?? null;
  const series: Series[] = chosen
    ? jobs.flatMap((job) => {
        const s = curves.get(job.id)?.s;
        const y = s?.traces[chosen];
        return s && y ? [{ name: label(job), x: s.fGhz, y }] : [];
      })
    : [];
  const withModes = jobs.filter((job) => curves.get(job.id)?.modes?.length);
  const mixed = new Set(jobs.map((job) => job.mesh)).size > 1;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="对比任务">
        <h2>对比 {jobs.length} 个任务</h2>
        {mixed && <p className="modal-status bad">这些任务的网格档位不同，曲线之间的差别有一部分来自网格。</p>}
        {loading && <p className="modal-note">正在读取曲线…</p>}
        {error && <p className="modal-status bad">{error}</p>}
        {traces.length > 0 && (
          <label>
            曲线
            <select value={chosen ?? ""} onChange={(event) => setTrace(event.target.value)}>
              {traces.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        )}
        {series.length > 0 && <Chart series={series} xLabel="频率 (GHz)" yLabel={`${chosen} (dB)`} formatX={freq} height={300} />}
        {withModes.length > 0 && (
          <table className="md-table mode-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>模式频率 (GHz)</th>
              </tr>
            </thead>
            <tbody>
              {withModes.map((job) => (
                <tr key={job.id}>
                  <td>{label(job)}</td>
                  <td>{curves.get(job.id)!.modes!.map((m) => m.fGhz).join("、")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <table className="md-table">
          <thead>
            <tr>
              <th>任务</th>
              <th>网格</th>
              <th>收敛</th>
              <th>要点</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{label(job)}</td>
                <td>{MESH_LABELS[job.mesh] || job.mesh}</td>
                <td>{job.converged ? "是" : job.converged === false ? "否" : "—"}</td>
                <td>{keyLines(job.key).join("；")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
