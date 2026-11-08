"""MCP 服务: 把配方和任务队列包成工具, 任何支持 MCP 的客户端都能调 (Claude Code、自己写的 DeepSeek 循环 ...)。

启动: python -m hfss_agent.server  (stdio, 由客户端拉起)
这个进程不碰 AEDT, 也不加载 pyaedt; stdout 是 MCP 通信用的, 不能 print。
"""
import functools
import inspect
import sys
import time
import traceback
import uuid
from typing import Any, Literal

import anyio
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from . import doctor, jobs, pitfalls
from .curves import curves
from .recipes import ALL, RECIPES
from .recipes import project as project_recipe
from .recipes.common import MESH

INSTRUCTIONS = """HFSS 仿真工具。每个任务都在新建的工程里跑, 不会动用户自己的 .aedt 文件。

两种用法:
A. 现成配方 (给尺寸就能自己建模): list_recipes → submit_simulation → get_job。
B. 任意工程 (用户在 HFSS 里画好的模型, 滤波器、天线都行): inspect_project 看里面有什么 → get_job 拿到变量和设置 →
   run_project 改变量并求解 → get_job 拿结果。这种用法只能调尺寸和材料, 不能换结构。

必须遵守:
1. 用 dr_filter 配方时, 改了尺寸或材料, 先跑 analysis=eigenmode, 再把 te01d_ghz 填进 driven 的 f0_ghz。
2. 看结果里的 use 字段。mesh=coarse 的数字只能看趋势; 写进文档或用来做决定的数字必须是 fine 且 converged=true,
   最终标称点还要跑一次 verify 对比。converged=false 的数字不可信。
3. 调尺寸不要一次猜一个: 想看某个参数的影响, 用 sweep_project / sweep_recipe 一次提交一组, 后台会排队并行;
   算完用 compare_jobs 把它们放在一张表里比较。
4. warnings 和 pitfalls 不为空时要先处理, 不要忽略: pitfalls 是结果出来后才看得出的坑, 每条都写了怎么改。
6. 跑不起来 (找不到 AEDT、许可证、PyAEDT) 时用 check_setup 查环境, 把查出的问题和改法告诉用户。
5. 一次仿真要几分钟到几十分钟, 不要频繁查询; get_job 的 wait_seconds 可以替你等。"""

mcp = MCPServer("hfss", instructions=INSTRUCTIONS)


def _unexpected(name, error):
    """意外异常也要把原因交给大模型: SDK 只会说 "Error executing tool", 模型就只能瞎猜 (比如以为是路径没权限)。"""
    traceback.print_exc(file=sys.stderr)  # 完整堆栈写到 stderr, 客户端在服务崩溃时会带上它
    return ToolError(f"{name} 内部出错 ({type(error).__name__}): {error}。这是工具本身的问题, 不是参数或路径权限的问题, 请把原文告诉用户。")


def tool(fn):
    """@mcp.tool() 加上一层: ToolError 原样抛出, 其它异常换成带原因的 ToolError。"""
    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def wrapped(*args, **kwargs):
            try:
                return await fn(*args, **kwargs)
            except ToolError:
                raise
            except Exception as e:
                raise _unexpected(fn.__name__, e) from e
    else:
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except ToolError:
                raise
            except Exception as e:
                raise _unexpected(fn.__name__, e) from e
    return mcp.tool()(wrapped)


def _changed(job):
    """只列出和默认值不同的参数, 一眼看出这个任务改了什么。"""
    specs = getattr(ALL[job["recipe"]], "PARAMS", {})
    return {k: v for k, v in job["request"]["params"].items() if k not in specs or v != specs[k]["default"]}


def _brief(job):
    out = {"job_id": job["id"], "recipe": job["recipe"], "analysis": job["analysis"], "mesh": job["mesh"],
           "state": job["state"], "changed": _changed(job)}
    for k in ("f0_ghz", "project", "design", "sweep"):
        if job["request"].get(k):
            out[k] = job["request"][k]
    return out


def _progress(job):
    """任务进行到哪了: 排第几、在做什么、跑了多久、为什么失败。给 list_jobs 和应用的任务面板用。"""
    out = {"created": job["created"]}
    if job["state"] == "queued":
        queued = [j["id"] for j in jobs.with_state("queued")]
        if job["id"] in queued:
            out["position"] = queued.index(job["id"]) + 1
    if job["state"] == "running":
        out.update(stage=job["stage"], cores=job["cores"], started=job["started"],
                   elapsed_s=round(time.time() - (job["started"] or time.time())))
    if job["finished"]:
        out["finished"] = job["finished"]
        if job["started"]:
            out["elapsed_s"] = round(job["finished"] - job["started"])
    if job["error"]:
        out["error"] = job["error"][-600:]
    return out


def _key(job):
    return getattr(ALL[job["recipe"]], "headline", lambda r: r["metrics"])(job["result"])


@tool
def list_recipes() -> dict[str, Any]:
    """列出能仿真的结构 (配方): 参数含义、默认值、范围、几何约束, 以及网格档位。提交之前先看这个。"""
    return {"recipes": [{"name": m.NAME, "description": m.DESCRIPTION, "analyses": m.ANALYSES, "params": m.PARAMS,
                         "constraints": m.CONSTRAINTS} for m in RECIPES.values()],
            "mesh_levels": {k: v["desc"] for k, v in MESH.items()}}


@tool
def submit_simulation(recipe: str, analysis: str, params: dict[str, Any] | None = None,
                      mesh: Literal["coarse", "fine", "verify"] = "coarse", f0_ghz: float | None = None,
                      band_ghz: list[float] | None = None, step_mhz: float = 1.0, force: bool = False) -> dict[str, Any]:
    """提交一次仿真, 立刻返回 job_id, 不等仿真结束。

    recipe, analysis: 见 list_recipes。
    params: 要改的参数, 没写的用默认值, 例如 {"g": 9, "Lx": 3.5}。单位见 list_recipes。
    mesh: coarse 看趋势, fine 出能用的数字, verify 复核。
    f0_ghz: driven 必填, 用 eigenmode 算出的 te01d_ghz。HFSS 在这个频率上加密网格, 通带也在它附近找。
    band_ghz: driven 的扫频范围 [起, 止], 默认约 0.86–1.31 倍 f0_ghz。
    step_mhz: 扫频步长。
    force: 一模一样的请求默认直接复用已有结果 (reused=true), 想重算才设为 true。
    """
    if recipe not in RECIPES:
        raise ToolError(f"没有配方 {recipe!r}, 可选 {list(RECIPES)}")
    try:
        req = RECIPES[recipe].prepare(analysis, params or {}, f0_ghz, band_ghz, step_mhz)
    except ValueError as e:
        raise ToolError(str(e)) from e  # 只有 ToolError 的文字能传给大模型, 其它异常它只看到 "Error executing tool"
    req.update(recipe=recipe, analysis=analysis, mesh=mesh)
    return _submit(req, MESH[mesh]["timeout_min"], force, [])


def _submit(request, timeout_min, force, warnings):
    job, reused = jobs.submit(request, timeout_min, force)
    if job["state"] == "queued":
        jobs.ensure_runner()
    out = {**_brief(job), "reused": reused, "warnings": warnings}
    if job["state"] == "done":
        out["result"] = job["result"]
    return out


@tool
def inspect_project(project: str, force: bool = False) -> dict[str, Any]:
    """查看任意 .aedt 工程里有什么: 设计、变量、端口、边界、求解设置、扫频。用 run_project 之前先看这个。

    project: .aedt 文件的完整路径。提交后用 get_job 取结果, 打开 AEDT 大约要半分钟。
    不会打开或改动原文件, 只读取它的一份副本; 文件没变时直接复用上次的结果。
    """
    try:
        req, warn = project_recipe.prepare_inspect(project)
    except ValueError as e:
        raise ToolError(str(e)) from e
    return _submit(req, 30, force, warn)


@tool
def run_project(project: str, design: str, variables: dict[str, Any] | None = None,
                mesh: Literal["coarse", "fine", "verify"] = "coarse", setup: str | None = None,
                f0_ghz: float | None = None, band_ghz: list[float] | None = None, step_mhz: float | None = None,
                far_field: bool = True, ff_sweep_ghz: list[float] | None = None,
                ff_direction_deg: list[float] | None = None, max_passes: int | None = None,
                force: bool = False) -> dict[str, Any]:
    """改变量后求解任意工程的一个设计, 立刻返回 job_id。不会动原文件, 只在副本上改。

    project, design: 工程路径和设计名, 先用 inspect_project 查。
    variables: 要改的变量, 带单位的变量必须写单位, 例如 {"w": "24mm", "$er_d": "28"}。$ 开头的是工程变量。
    mesh: coarse 看趋势, fine 出能用的数字, verify 复核。会覆盖工程里原来的收敛设置。
    setup: 设计里只有一个求解设置时不用填。
    f0_ghz: 自适应频点, 默认用工程里的。真实谐振移动后要跟着改, 否则网格加密在错误的频率上。
    band_ghz, step_mhz: 扫频范围和步长, 默认用工程里最宽的那个扫频。
    far_field: 有辐射边界时取远场 (默认在 f0_ghz 上, 不额外花时间)。
    ff_sweep_ghz: [起, 止, 步长], 要看增益或轴比随频率的变化时才用, 每个频点都要完整解一遍。
    ff_direction_deg: [theta, phi], 报告这个方向上的增益、圆极化和轴比, 默认正上方, 对齐到 5 度网格。
    max_passes: 自适应次数上限, 大模型算不收敛时加大。
    force: 一模一样的请求默认直接复用已有结果, 想重算才设为 true。
    """
    try:
        req, warn = project_recipe.prepare_run(project, design, variables, mesh, setup, f0_ghz, band_ghz, step_mhz,
                                               far_field, ff_sweep_ghz, ff_direction_deg or [0, 0], max_passes)
    except ValueError as e:
        raise ToolError(str(e)) from e
    return _submit(req, MESH[mesh]["timeout_min"], force, warn)


@tool
async def get_job(job_id: str, wait_seconds: int = 0) -> dict[str, Any]:
    """查一个任务。结束了就返回完整结果 (result) 或错误 (error); 没结束就返回当前进度。

    wait_seconds: 任务没结束时最多等多少秒再返回 (上限 50), 用它代替反复查询。
    """
    deadline = anyio.current_time() + min(max(wait_seconds, 0), 50)
    while True:
        job = jobs.get(job_id)
        if job is None:
            raise ToolError(f"没有任务 {job_id}")
        if job["state"] not in ("queued", "running"):
            break
        jobs.ensure_runner()  # runner 恰好刚退出, 或者机器重启过: 把它拉起来, 它会接着排队, 并把丢失的任务标成失败
        if anyio.current_time() >= deadline:
            break
        await anyio.sleep(1)
    out = _brief(job)
    if job["state"] == "queued":
        out["position"] = [j["id"] for j in jobs.with_state("queued")].index(job_id) + 1
    if job["state"] == "running":
        out.update(stage=job["stage"], cores=job["cores"], elapsed_s=round(time.time() - job["started"]))
    if job["state"] == "done":
        out["result"] = job["result"]
        found = pitfalls.for_job(job)
        if found:
            out["pitfalls"] = found
    if job["error"]:
        out["error"] = job["error"]
    return out


@tool
def list_jobs(limit: int = 20, recipe: str | None = None, state: str | None = None) -> dict[str, Any]:
    """列出最近的任务和要点 (新的在前), 用来回顾算过什么。完整结果用 get_job 取。

    state: queued/running/done/failed/cancelled。
    """
    out = []
    for j in jobs.listing(min(max(limit, 1), 100), recipe, state):
        b = {**_brief(j), **_progress(j)}
        if j["result"]:
            b.update(converged=j["result"]["converged"], key=_key(j))
            if j["result"].get("use"):
                b["use"] = j["result"]["use"]
            found = pitfalls.for_job(j)
            if found:
                b["pitfalls"] = found
        out.append(b)
    return {"jobs": out}


@tool
def check_setup() -> dict[str, Any]:
    """检查仿真环境: AEDT 版本和路径、许可证服务器连不连得上、PyAEDT、数据目录空间、后台 runner、本机核数和内存。
    任务跑不起来或用户问环境时用。每项都有 level (ok/warn/fail), 没过的项带 fix (怎么修)。不启动 AEDT, 几秒就好。"""
    return doctor.check()


@tool
def job_curves(job_id: str) -> dict[str, Any]:
    """给桌面应用画图: S 参数曲线 (抽稀后)、每次加密的收敛过程、本征模表。数字结论以 get_job 为准。"""
    job = jobs.get(job_id)
    if job is None:
        raise ToolError(f"没有任务 {job_id}")
    return curves(job)


MAX_SWEEP = 12


def _sweep_id():
    return time.strftime("s%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]


def _check_values(values):
    if not values:
        raise ToolError("values 不能为空")
    if len(values) > MAX_SWEEP:
        raise ToolError(f"一次最多扫 {MAX_SWEEP} 个点 (收到 {len(values)} 个): 先粗扫, 再在好的区间细扫")
    if len(set(map(str, values))) != len(values):
        raise ToolError("values 里有重复的值")


@tool
def sweep_project(project: str, design: str, variable: str, values: list[str], variables: dict[str, Any] | None = None,
                  mesh: Literal["coarse", "fine", "verify"] = "coarse", setup: str | None = None,
                  f0_ghz: float | None = None, band_ghz: list[float] | None = None, step_mhz: float | None = None,
                  far_field: bool = True, max_passes: int | None = None) -> dict[str, Any]:
    """扫一个变量: 每个值提交一个 run_project 任务, 立刻返回 sweep_id 和各任务的 job_id。

    variable: 要扫的变量名; values: 它的取值, 带单位的变量要写单位, 例如 ["4mm", "4.5mm", "5mm"]。最多 12 个。
    variables: 其他要改的变量 (所有点都一样)。其余参数同 run_project。
    算完用 compare_jobs(sweep_id=...) 一次比较所有点。和以前算过的点一模一样的直接复用。
    """
    _check_values(values)
    sid, out, warnings = _sweep_id(), [], []
    for v in values:
        merged = {**(variables or {}), variable: v}
        try:
            req, warn = project_recipe.prepare_run(project, design, merged, mesh, setup, f0_ghz, band_ghz, step_mhz,
                                                   far_field, None, [0, 0], max_passes)
        except ValueError as e:
            raise ToolError(str(e)) from e
        req["sweep"] = {"id": sid, "variable": variable, "value": str(v)}
        r = _submit(req, MESH[mesh]["timeout_min"], False, [])
        out.append(r)
        warnings += [w for w in warn if w not in warnings]
    return {"sweep_id": sid, "variable": variable, "jobs": out, "warnings": warnings}


@tool
def sweep_recipe(recipe: str, analysis: str, param: str, values: list[float | str], params: dict[str, Any] | None = None,
                 mesh: Literal["coarse", "fine", "verify"] = "coarse", f0_ghz: float | None = None,
                 band_ghz: list[float] | None = None, step_mhz: float = 1.0) -> dict[str, Any]:
    """用现成配方扫一个参数: 每个值提交一个 submit_simulation 任务, 立刻返回 sweep_id 和各任务的 job_id。

    param: 要扫的参数名 (见 list_recipes); values: 它的取值, 最多 12 个。params: 其他参数 (所有点都一样)。
    其余参数同 submit_simulation。算完用 compare_jobs(sweep_id=...) 比较。
    """
    if recipe not in RECIPES:
        raise ToolError(f"没有配方 {recipe!r}, 可选 {list(RECIPES)}")
    _check_values(values)
    sid, reqs, bad = _sweep_id(), [], []
    for v in values:  # 先全部检查完再提交: 不要提交了一半才发现某个点几何撞车
        try:
            req = RECIPES[recipe].prepare(analysis, {**(params or {}), param: v}, f0_ghz, band_ghz, step_mhz)
        except ValueError as e:
            bad.append(f"{param}={v}: {e}")
            continue
        # 3 arrives as 3.0 (the argument is typed float | str): label it as people wrote it.
        label = f"{v:g}" if isinstance(v, float) else str(v)
        req.update(recipe=recipe, analysis=analysis, mesh=mesh, sweep={"id": sid, "variable": param, "value": label})
        reqs.append(req)
    if bad:
        raise ToolError("有的点不合法, 一个都没提交: " + "; ".join(bad))
    out = [_submit(req, MESH[mesh]["timeout_min"], False, []) for req in reqs]
    return {"sweep_id": sid, "variable": param, "jobs": out}


@tool
def compare_jobs(job_ids: list[str] | None = None, sweep_id: str | None = None) -> dict[str, Any]:
    """把几个任务放进一张表比较: 改了什么、要点指标、网格档位、是否收敛、pitfalls。

    给 job_ids, 或给 sweep_id 比较一次扫参的所有点 (按扫的值排序)。没完成的任务只列状态。
    """
    if sweep_id:
        found = [j for j in jobs.listing(500) if (j["request"].get("sweep") or {}).get("id") == sweep_id]
        if not found:
            raise ToolError(f"没有扫参 {sweep_id}")
        found.sort(key=lambda j: _sort_key(j["request"]["sweep"]["value"]))
    elif job_ids:
        found = []
        for jid in job_ids:
            j = jobs.get(jid)
            if j is None:
                raise ToolError(f"没有任务 {jid}")
            found.append(j)
    else:
        raise ToolError("要给 job_ids 或 sweep_id")
    rows = []
    for j in found:
        row = {"job_id": j["id"], "state": j["state"], "mesh": j["mesh"], "changed": _changed(j)}
        if j["request"].get("sweep"):
            row["value"] = j["request"]["sweep"]["value"]
        if j["result"]:
            row.update(converged=j["result"]["converged"], key=_key(j))
            found_pitfalls = pitfalls.for_job(j)
            if found_pitfalls:
                row["pitfalls"] = found_pitfalls
        if j["error"]:
            row["error"] = j["error"][-300:]
        rows.append(row)
    done = sum(r["state"] == "done" for r in rows)
    return {"rows": rows, "done": done, "total": len(rows),
            "note": "coarse 或未收敛的行只能看趋势" if any(r.get("mesh") == "coarse" or r.get("converged") is False for r in rows) else ""}


def _sort_key(value):
    """'4.5mm' 和 '10mm' 按数值排, 不按字符串排。"""
    import re

    m = re.match(r"\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)", str(value))
    return (0, float(m.group(1))) if m else (1, str(value))


@tool
def cancel_job(job_id: str) -> dict[str, Any]:
    """取消任务: 排队中的直接取消, 正在跑的几秒内被终止 (连同它的 AEDT)。"""
    job = jobs.cancel(job_id)
    if job is None:
        raise ToolError(f"没有任务 {job_id}")
    return {"job_id": job_id, "state": job["state"], "cancel_requested": bool(job["cancel_requested"])}


def main():
    mcp.run()


if __name__ == "__main__":
    main()
