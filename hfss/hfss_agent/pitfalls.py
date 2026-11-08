"""任务做完后自动查一遍常见的坑, 结果放进 get_job / list_jobs 的 pitfalls。

这些都是"数字看起来正常, 其实不能信"的情况, 来自原项目踩过的坑。warnings 是求解时就知道的问题,
pitfalls 是拿到结果后才看得出来的问题。每条都说清楚怎么改。
"""
from functools import lru_cache

from . import jobs
from .curves import conv_passes
from .recipes.common import MESH

FEW_PASSES = 3  # 加密次数这么少就判收敛, 多半是碰巧
FEW_TETS = 3000  # 网格这么粗, 数字可能偏得厉害
OFF_TUNE = 0.01  # 自适应频点离谐振超过 1%: 网格加密在了错误的频率上
EDGE = 0.02  # 谐振点离扫频边界不到频段宽度的 2%


def _f0_ghz(job, metrics):
    """这次的谐振 / 通带中心 (GHz) 和自适应频点 (GHz)。不是驱动模或找不到时返回 (None, None)。"""
    req = job["request"]
    f_solve = metrics.get("f_solve_ghz") or req.get("f0_ghz")
    s = metrics.get("s") or {}
    passband = s.get("passband") or (metrics if "f0_mhz" in metrics else None)
    if passband and passband.get("f0_mhz"):
        return passband["f0_mhz"] / 1e3, f_solve
    dips = [v["min"][0] for k, v in s.items() if isinstance(v, dict) and "min" in v]
    if len(dips) == 1:  # 单端口 (天线): 看 S11 谷点
        return dips[0] / 1e3, f_solve
    return None, f_solve


def review(job):
    """返回这个已完成任务的坑 (中文, 每条带改法)。"""
    result = job.get("result")
    if job["state"] != "done" or not result or result.get("converged") is None:
        return []
    out = []
    req, metrics, conv = job["request"], result.get("metrics") or {}, result.get("convergence") or {}
    cap = req.get("max_passes") or MESH.get(job["mesh"], {}).get("passes")
    passes = conv.get("passes")

    if not result.get("converged") and passes and cap and passes >= cap:
        out.append(f"加密到上限 {cap} 次还没收敛: 用 max_passes 加大上限, 或检查模型里有没有极细的结构、端口设置是否合理")
    if result.get("converged") and passes and passes <= FEW_PASSES:
        out.append(f"只加密 {passes} 次就判了收敛, 可能是碰巧: 下结论前用 fine 档再算一次确认")
    if conv.get("tets") and conv["tets"] < FEW_TETS:
        out.append(f"最终网格只有 {conv['tets']} 个四面体, 很粗: 数字可能偏差很大, 只能看非常粗的趋势")

    rows = _passes(job["id"])
    deltas = [r["delta"] for r in rows if r["delta"] is not None]
    if len(deltas) >= 3 and deltas[-1] > deltas[-2]:
        out.append(f"最后一次加密的 Δ 从 {deltas[-2]} 变大到 {deltas[-1]}: 收敛还在抖动, 结果可能还会变, 用更严的档位确认")

    f0, f_solve = _f0_ghz(job, metrics)
    if f0 and f_solve and abs(f0 - f_solve) / f_solve > OFF_TUNE:
        out.append(f"谐振 / 通带中心在 {f0:.4g} GHz, 但网格是在 {f_solve:.4g} GHz 加密的 (差 {abs(f0 - f_solve) / f_solve:.1%}): "
                   f"把 f0_ghz 设成 {f0:.4g} 重跑, 否则谐振附近的网格不够细")
    band = metrics.get("band_ghz") or req.get("band_ghz")
    if f0 and band and len(band) == 2 and band[1] > band[0]:
        width = band[1] - band[0]
        if min(f0 - band[0], band[1] - f0) < EDGE * width:
            out.append(f"谐振点 {f0:.4g} GHz 贴着扫频边界 {band}: 扫频外可能还有更好的谐振或通带没扫全, 用 band_ghz 放宽频段")

    modes = metrics.get("modes_ghz_q") or metrics.get("modes_ghz")
    if modes is not None and len(modes) <= 2:
        out.append(f"只求了 {len(modes)} 个模式: 不能用它判断模式间隔或寄生模; 要看寄生模, 用模式数更多的设计 (或在工程里把 NumModes 调大)")
    return out


def _passes(job_id):
    path = jobs.RUNS / job_id / "conv.prof"
    try:
        return conv_passes(path.read_text(errors="ignore"))
    except OSError:
        return []


@lru_cache(maxsize=512)
def _cached(job_id, finished):
    job = jobs.get(job_id)
    return tuple(review(job)) if job else ()


def for_job(job):
    """完成的任务不会再变, 按 (id, 完成时间) 缓存: list_jobs 每几秒查一次, 不要每次都读文件。"""
    if job["state"] != "done":
        return []
    return list(_cached(job["id"], job["finished"]))
