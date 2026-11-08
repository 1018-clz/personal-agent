"""给桌面应用画图的数据: S 参数曲线、每次加密的收敛过程、本征模表。

只给应用用, 不给大模型: 几百个点的曲线对模型没用, 还占上下文。数字结论仍然以 get_job 的 metrics 为准。
"""
import math
import re
from pathlib import Path

from . import jobs

MAX_POINTS = 800  # 一条曲线最多给这么多点; 抽稀时保留每段的最高和最低点, 窄带谐振的谷底不会被抽掉


def conv_passes(text):
    """conv.prof 里每次加密的 (第几次, 四面体数, Δ)。第一次没有 Δ。"""
    rows = []
    for ln in text.splitlines():
        parts = [p.strip() for p in ln.split("|")]
        if len(parts) < 3 or not parts[0].isdigit():
            continue
        try:
            delta = float(parts[2])
        except ValueError:
            delta = None
        rows.append({"pass": int(parts[0]), "tets": int(parts[1]) if parts[1].isdigit() else None, "delta": delta})
    return rows


def trace_name(column):
    """CSV 列名 → 曲线名: S1_1_dB / S11_dB → S(1,1), St2_1_dB → St(2,1)。不是 S 参数的列返回 None。"""
    m = re.fullmatch(r"(St|S)(\w+?)_(\w+?)_dB", column) or re.fullmatch(r"(St|S)(\d)(\d)_dB", column)
    return f"{m.group(1)}({m.group(2)},{m.group(3)})" if m else None


def downsample(x, ys, limit=MAX_POINTS):
    """按段抽稀, 每段留最高点和最低点 (按所有曲线一起看), 返回下标列表。"""
    n = len(x)
    if n <= limit:
        return list(range(n))
    buckets = max(1, limit // (2 * max(1, len(ys))))  # 每段每条曲线留 2 个点, 总数不超过 limit
    keep = {0, n - 1}
    for b in range(buckets):
        lo, hi = b * n // buckets, max((b + 1) * n // buckets, b * n // buckets + 1)
        for y in ys:
            seg = range(lo, min(hi, n))
            keep.add(min(seg, key=lambda i: y[i]))
            keep.add(max(seg, key=lambda i: y[i]))
    return sorted(keep)


def read_s(path):
    """S 参数 CSV → {"f_ghz": [...], "traces": {"S(1,1)": [...]}}; 读不了返回 None。"""
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    if len(lines) < 2:
        return None
    head = lines[0].split(",")
    cols = [(i, trace_name(h)) for i, h in enumerate(head)]
    cols = [(i, name) for i, name in cols if name]
    f, traces = [], {name: [] for _, name in cols}
    for ln in lines[1:]:
        cells = ln.split(",")
        try:
            f.append(float(cells[0]))
            for i, name in cols:
                traces[name].append(float(cells[i]))
        except (ValueError, IndexError):
            continue
    if not f:
        return None
    keep = downsample(f, list(traces.values()))
    clean = lambda v: None if math.isnan(v) or math.isinf(v) else round(v, 4)  # noqa: E731
    return {"f_ghz": [round(f[i], 6) for i in keep],
            "traces": {name: [clean(y[i]) for i in keep] for name, y in traces.items()}}


def curves(job):
    """一个任务能画的东西。任务没完成或没有曲线时对应字段为空。"""
    run_dir = jobs.RUNS / job["id"]
    result = job.get("result") or {}
    metrics = result.get("metrics") or {}
    out = {"job_id": job["id"], "s": None, "convergence": [], "modes": None}
    s_csv = run_dir / "s_params.csv"
    if s_csv.exists():
        out["s"] = read_s(s_csv)
    conv = result.get("convergence") or {}
    for prof in sorted(run_dir.glob("*conv.prof")):
        try:
            rows = conv_passes(prof.read_text(errors="ignore"))
        except OSError:
            continue
        name = prof.stem.removesuffix("_conv").removesuffix("conv") or "Setup"
        out["convergence"].append({"name": name, "passes": rows, "criterion": conv.get("criterion"),
                                   "target": conv.get("target")})
    if "modes_ghz_q" in metrics:
        out["modes"] = [{"f_ghz": f, "q": q} for f, q in metrics["modes_ghz_q"]]
    elif "modes_ghz" in metrics:
        out["modes"] = [{"f_ghz": f, "q": None} for f in metrics["modes_ghz"]]
    return out
