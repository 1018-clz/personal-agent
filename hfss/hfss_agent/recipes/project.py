"""通用工程: 不管什么结构, 只要是你在 HFSS 里画好、带变量的模型 (滤波器、天线都行), 就能改变量、仿真、取指标。

几何、端口、边界都是工程里现成的, 这里不建模, 所以只能调尺寸和材料, 不能换结构。

提交时先给 .aedt 存一份快照 (snapshots/<内容指纹>.aedt), 任务只用快照的副本:
你的原文件绝不会被 AEDT 打开; 任务排队期间你改了原文件, 也不会影响已经提交的任务。

  inspect  看工程里有什么: 设计、变量、端口、求解设置、扫频
  run      改变量后求解。驱动模给 S 参数 (任意端口数), 有辐射边界时再给远场; 本征模给模式表
"""
import hashlib
import re
import shutil
from pathlib import Path

import numpy as np

from ..jobs import DATA
from ..metrics import s_summary
from .common import MESH, aedt_version, export_modes, judge, parse_convergence, verdict

NAME = "project"
SNAPSHOTS = DATA / "snapshots"
S_SWEEP, FF_SWEEP, SPHERE = "AgentS", "AgentFF", "AgentFF"
RADIATING = ("Radiation", "PML", "FE-BI")
MAX_FF_POINTS = 21  # 远场扫频每个频点都要完整解一遍, 点数要少
ANGLE_STEP = 5  # 远场球面的角度步长 (度)


def to_ghz(text):
    """'1.5GHz' / '800MHz' → GHz。"""
    m = re.fullmatch(r"\s*([-+\d.eE]+)\s*([kKmMgG]?)[hH][zZ]\s*", str(text))
    if not m:
        raise ValueError(f"看不懂频率 {text!r}")
    return float(m.group(1)) * {"": 1e-9, "k": 1e-6, "m": 1e-3, "g": 1.0}[m.group(2).lower()]


def is_plain(expr):
    """是不是直接写的数值 ('23.8mm', '29', '1e-4'), 而不是依赖别的变量的表达式 ('w', '2*b_h')。"""
    return re.fullmatch(r"[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*[a-zA-Z]*", str(expr).strip()) is not None


def has_unit(expr):
    return re.fullmatch(r"[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?", str(expr).strip()) is None


def _snapshot(project):
    """检查路径, 存快照。返回 (请求里要记的字段, 警告)。"""
    p = Path(project)
    if p.suffix.lower() != ".aedt" or not p.is_file():
        raise ValueError(f"找不到工程 {project}: 要写 .aedt 文件的完整路径")
    p = p.resolve()
    sha = hashlib.sha1(p.read_bytes()).hexdigest()[:12]
    # A fresh install has no data directory yet: create it along with the snapshots folder.
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    snap = SNAPSHOTS / f"{sha}.aedt"
    if not snap.exists():
        shutil.copy2(p, snap)
    warn = []
    if Path(str(p) + ".lock").exists():
        warn.append("这个工程正被 AEDT 打开, 用的是最后一次保存的版本, 没保存的改动不算数")
    return {"project": str(p), "filename": p.name, "project_sha": sha}, warn


def prepare_inspect(project):
    fields, warn = _snapshot(project)
    return {"recipe": NAME, "analysis": "inspect", "mesh": "-", "params": {}, **fields}, warn


def prepare_run(project, design, variables, mesh, setup, f0_ghz, band_ghz, step_mhz, far_field, ff_sweep_ghz,
                ff_direction_deg, max_passes):
    """能在不开 AEDT 的情况下查的都在这里查。变量名和单位要看工程内容, 开工时由 _set_vars 查。"""
    bad = []
    if band_ghz and (len(band_ghz) != 2 or not 0 < band_ghz[0] < band_ghz[1]):
        bad.append(f"band_ghz={band_ghz} 要写成 [起, 止]")
    if step_mhz is not None and step_mhz <= 0:
        bad.append("step_mhz 要大于 0")
    if ff_sweep_ghz:
        if len(ff_sweep_ghz) != 3 or not 0 < ff_sweep_ghz[0] <= ff_sweep_ghz[1] or ff_sweep_ghz[2] <= 0:
            bad.append(f"ff_sweep_ghz={ff_sweep_ghz} 要写成 [起, 止, 步长]")
        elif (ff_sweep_ghz[1] - ff_sweep_ghz[0]) / ff_sweep_ghz[2] + 1 > MAX_FF_POINTS:
            bad.append(f"ff_sweep_ghz 不能超过 {MAX_FF_POINTS} 个点: 每个点都要完整解一遍")
    if len(ff_direction_deg) != 2 or not 0 <= ff_direction_deg[0] <= 180:
        bad.append(f"ff_direction_deg={ff_direction_deg} 要写成 [theta, phi], theta 在 0–180 之间")
    if bad:
        raise ValueError("; ".join(bad))
    fields, warn = _snapshot(project)
    return {"recipe": NAME, "analysis": "run", "mesh": mesh, "design": design,
            "params": {k: str(v) for k, v in (variables or {}).items()}, "setup": setup, "f0_ghz": f0_ghz, "band_ghz": band_ghz, "step_mhz": step_mhz, "far_field": far_field,
            "ff_sweep_ghz": ff_sweep_ghz, "ff_direction_deg": list(ff_direction_deg), "max_passes": max_passes,
            **fields}, warn


def run(req, ctx):
    return {"inspect": _inspect, "run": _run}[req["analysis"]](req, ctx)


def headline(result):
    """list_jobs 用的要点: 一次列很多任务时, 不能把所有曲线特征点都灌给大模型。"""
    m = result["metrics"]
    if "designs" in m:
        return {"designs": [d["design"] for d in m["designs"]]}
    if "modes_ghz_q" in m:
        return {"modes_ghz_q": m["modes_ghz_q"][:3]}
    out = {k: v["min"] for k, v in m["s"].items() if "min" in v}
    if "passband" in m["s"]:
        out["passband"] = {k: m["s"]["passband"][k] for k in ("f0_mhz", "il_db", "bw3_mhz")}
    if "far_field" in m:
        ff = min(m["far_field"], key=lambda e: abs(e["f_ghz"] - m["f_solve_ghz"]))
        out["far_field"] = {k: ff[k] for k in ("f_ghz", "peak_realized_gain_dbi", "total_efficiency")}
    return out


def _open(req, ctx):
    """打开快照的副本。不在这里传 design: 名字写错时 pyaedt 会悄悄新建一个空设计。"""
    from ansys.aedt.core import Hfss

    shutil.copy2(SNAPSHOTS / f"{req['project_sha']}.aedt", ctx.project)
    return Hfss(project=str(ctx.project), version=aedt_version(), non_graphical=True, new_desktop=True,
                close_on_exit=True)


def _why(hfss, text):
    """失败时把 AEDT 自己的报错带上, 大模型和人才知道该改什么。"""
    msgs = [str(m) for m in hfss.logger.error_messages][-5:]
    return text + (": " + " | ".join(msgs) if msgs else "")


def _sweep_range(w):
    """工程里一个扫频的 (起, 止, 步长) GHz。看不懂的类型返回 None。"""
    p = w.props
    if p.get("RangeType") == "LinearStep":
        return to_ghz(p["RangeStart"]), to_ghz(p["RangeEnd"]), to_ghz(p["RangeStep"])
    if p.get("RangeType") == "LinearCount":
        a, b = to_ghz(p["RangeStart"]), to_ghz(p["RangeEnd"])
        return a, b, (b - a) / max(int(p["RangeCount"]) - 1, 1)
    return None


def _ports(hfss):
    """S 表达式里用的端口名。单模端口 '1:1' 写成 '1', 多模端口保留 '1:2'。"""
    names = sorted(hfss.excitation_names)
    return [n[:-2] for n in names] if all(n.endswith(":1") for n in names) else names


def _design_info(hfss):
    vm = hfss.variable_manager

    def show(variables):
        return {k: v.expression if is_plain(v.expression) else f"{v.expression} (= {v.evaluated_value})"
                for k, v in variables.items()}

    setups = []
    for name in hfss.setup_names:
        s = hfss.get_setup(name)
        keys = ("Frequency", "MaxDeltaS", "MaxDeltaFreq", "NumModes", "MinimumFrequency", "MaximumPasses",
                "MinimumConvergedPasses", "SolveType")
        setups.append({"name": name, **{k: s.props[k] for k in keys if k in s.props},
                       "sweeps": [{"name": w.name, "type": w.props.get("Type"), "range_ghz": _sweep_range(w)}
                                  for w in s.sweeps]})
    return {"design": hfss.design_name, "solution_type": hfss.solution_type, "variables": show(vm.design_variables),
            "project_variables": show(vm.project_variables), "ports": _ports(hfss),
            "boundaries": sorted({b.type for b in hfss.boundaries}), "radiating": _radiating(hfss),
            "far_field_spheres": list(hfss.field_setup_names), "setups": setups}


def _radiating(hfss):
    return any(b.type in RADIATING for b in hfss.boundaries)


def _inspect(req, ctx):
    hfss = _open(req, ctx)
    designs, warn = [], []
    try:
        ctx.stage("读取工程")
        for des in hfss.design_list:
            kind = hfss.oproject.SetActiveDesign(des).GetDesignType()
            if kind != "HFSS":
                warn.append(f"设计 {des} 是 {kind}, 暂不支持")
                continue
            hfss.set_active_design(des)
            designs.append(_design_info(hfss))
    finally:
        hfss.release_desktop(close_projects=True, close_desktop=True)
    return {"metrics": {"project": req["project"], "designs": designs}, "converged": None, "warnings": warn, "files": {}}


def _set_vars(hfss, variables):
    """设置变量, 返回实际写进去的值。名字不分大小写 (AEDT 就是这样), 带单位的变量必须写单位。"""
    vm = hfss.variable_manager
    known = {**vm.design_variables, **vm.project_variables}
    lower = {k.lower(): k for k in known}
    bad = []
    for k, v in variables.items():
        if k.lower() not in lower:
            bad.append(f"没有变量 {k}")
        elif known[lower[k.lower()]].units and not has_unit(v):
            bad.append(f"{k} 现在是 {known[lower[k.lower()]].expression}, 新值 {v} 没写单位 (不写会按米算)")
    if bad:
        raise ValueError("; ".join(bad) + f"。工程里的变量: {sorted(known)}")
    for k, v in variables.items():
        hfss[lower[k.lower()]] = v
    return {lower[k.lower()]: hfss[lower[k.lower()]] for k in variables}


def _pick_setup(hfss, name):
    names = list(hfss.setup_names)
    if name is None and len(names) == 1:
        return hfss.get_setup(names[0])
    if name not in names:
        raise ValueError(f"要指定 setup, 这个设计里有 {names}")
    return hfss.get_setup(name)


def _run(req, ctx):
    mesh = dict(MESH[req["mesh"]], **({"passes": req["max_passes"]} if req["max_passes"] else {}))
    hfss = _open(req, ctx)
    try:
        if req["design"] not in hfss.design_list:
            raise ValueError(f"工程里没有设计 {req['design']}, 有 {list(hfss.design_list)}")
        hfss.set_active_design(req["design"])
        ctx.stage("改变量")
        applied = _set_vars(hfss, req["params"])
        s = _pick_setup(hfss, req["setup"])
        if hfss.solution_type == "Eigenmode":
            out = _eigenmode(hfss, s, req, mesh, ctx)
        elif hfss.solution_type in ("Modal", "Terminal"):
            out = _driven(hfss, s, req, mesh, ctx)
        else:
            raise ValueError(f"暂不支持求解类型 {hfss.solution_type}")
        hfss.save_project()
    finally:
        hfss.release_desktop(close_projects=True, close_desktop=True)
    return {**out, "design": req["design"], "setup": s.name, "variables": applied,
            "source_project": req["project"]}


def _solve(hfss, s, ctx):
    if not hfss.validate_simple():
        raise RuntimeError(_why(hfss, "模型校验没通过, 多半是改变量后几何出了问题"))
    ctx.stage("求解")
    if not hfss.analyze_setup(s.name, cores=ctx.cores):
        raise RuntimeError(_why(hfss, "求解失败"))


def _convergence(hfss, s, ctx):
    path = ctx.dir / "conv.prof"
    hfss.export_convergence(s.name, output_file=str(path))
    return parse_convergence(path.read_text(errors="ignore"))


def _eigenmode(hfss, s, req, mesh, ctx):
    s.props["MaximumPasses"] = mesh["passes"]
    s.props["MinimumConvergedPasses"] = 2
    s.props["MaxDeltaFreq"] = mesh["dfreq"]
    s.update()
    _solve(hfss, s, ctx)
    ctx.stage("提取结果")
    modes = export_modes(hfss, s.name, ctx.dir / "modes.eig")
    conv = _convergence(hfss, s, ctx)
    ok, warn = judge(conv, "Delta Freq", mesh["dfreq"])
    return {"metrics": {"modes_ghz_q": modes}, "convergence": conv, "converged": ok, "use": verdict(req["mesh"], ok),
            "warnings": warn, "files": {"project": str(ctx.project)}}


def _driven(hfss, s, req, mesh, ctx):
    if s.props.get("SolveType", "Single") != "Single":
        raise ValueError(f"{s.name} 不是单频点自适应 ({s.props['SolveType']}), 暂不支持")
    f0 = req["f0_ghz"] or to_ghz(s.props["Frequency"])
    band, step = req["band_ghz"], req["step_mhz"]
    if not band:  # 没指定频段: 用工程里最宽的那个扫频
        ranges = [r for r in map(_sweep_range, s.sweeps) if r]
        if not ranges:
            raise ValueError("工程里没有能用的扫频, 请给 band_ghz")
        widest = max(ranges, key=lambda r: r[1] - r[0])
        band, step = widest[:2], step or round(widest[2] * 1e3, 6)

    s.props["Frequency"] = f"{f0}GHz"
    s.props["MaximumPasses"] = mesh["passes"]
    s.props.pop("MaxDeltaE", None)  # pyaedt 1.x 的模板可能默认按场能量收敛, 这里要按 S 参数收敛
    s.props["MaxDeltaS"] = mesh["dS"]
    s.props["MinimumConvergedPasses"] = mesh["minconv"]
    s.props["SaveAnyFields"] = True  # 远场要用最后一次自适应的场
    s.update()
    for n in list(s.get_sweep_names()):  # 工程里原来的扫频全换掉: 只解要用的, 不多花时间
        s.delete_sweep(n)
    s.create_linear_step_sweep(unit="GHz", start_frequency=band[0], stop_frequency=band[1],
                               step_size=(step or 1.0) / 1e3, name=S_SWEEP, save_fields=False,
                               sweep_type="Interpolating")
    radiating = req["far_field"] and _radiating(hfss)
    if radiating:
        if req["ff_sweep_ghz"]:
            a, b, ds = req["ff_sweep_ghz"]
            s.create_linear_step_sweep(unit="GHz", start_frequency=a, stop_frequency=b, step_size=ds, name=FF_SWEEP,
                                       save_fields=True, save_rad_fields=False, sweep_type="Discrete")
        hfss.insert_infinite_sphere(definition="Theta-Phi", phi_start=0, phi_stop=360 - ANGLE_STEP, phi_step=ANGLE_STEP,
                                    theta_start=0, theta_stop=180, theta_step=ANGLE_STEP, name=SPHERE)
    _solve(hfss, s, ctx)

    ctx.stage("提取结果")
    f, sp, z, csv = _s_params(hfss, s, ctx)
    metrics = {"f_solve_ghz": f0, "band_ghz": list(band), "s": s_summary(f, sp, f0, z)}
    if radiating:
        metrics["far_field"] = _far_field(hfss, s, f0, req)
    conv = _convergence(hfss, s, ctx)
    ok, warn = judge(conv, "Delta S", mesh["dS"])
    return {"metrics": metrics, "convergence": conv, "converged": ok, "use": verdict(req["mesh"], ok), "warnings": warn,
            "files": {"s_params_csv": str(csv), "project": str(ctx.project)}}


def _s_params(hfss, s, ctx):
    """取全部反射项和一半传输项 (互易, 另一半一样)。返回 (f, {名字: dB}, {名字: 复阻抗}, csv 路径)。"""
    q, zq = ("St", "Zt") if hfss.solution_type == "Terminal" else ("S", "Z")
    ports = _ports(hfss)
    pairs = [(b, a) for i, a in enumerate(ports) for b in ports[i:]]
    exprs = [f"dB({q}({b},{a}))" for b, a in pairs]
    zexprs = [f"{part}({zq}({a},{a}))" for a in ports for part in ("re", "im")]
    d = hfss.post.get_solution_data(expressions=exprs + zexprs, setup_sweep_name=f"{s.name} : {S_SWEEP}",
                                    primary_sweep_variable="Freq")
    f = np.asarray(d.get_expression_data(exprs[0])[0], dtype=float)
    sp = {f"{q}({b},{a})": np.asarray(d.get_expression_data(e)[1], dtype=float) for (b, a), e in zip(pairs, exprs)}
    z = {f"{q}({a},{a})": np.asarray(d.get_expression_data(f"re({zq}({a},{a}))")[1], dtype=float)
         + 1j * np.asarray(d.get_expression_data(f"im({zq}({a},{a}))")[1], dtype=float) for a in ports}
    csv = ctx.dir / "s_params.csv"
    cols = [f] + list(sp.values()) + [c for v in z.values() for c in (v.real, v.imag)]
    head = ["f_GHz"] + [f"{q}{b}_{a}_dB" for b, a in pairs] + [f"Re{zq}{a}_{a},Im{zq}{a}_{a}" for a in ports]
    np.savetxt(csv, np.column_stack(cols), delimiter=",", header=",".join(head), comments="")
    return f, sp, z, csv


def _far_field(hfss, s, f0, req):
    """每个频点算: 全向峰值增益和方向、效率; 再给 ff_direction_deg 方向上的增益、圆极化、轴比。

    效率用增益 ÷ 方向性算 (这就是它的定义): AEDT 2025 R2 的 Antenna Parameters 报告用 pyaedt 取不到数据。
    """
    if req["ff_sweep_ghz"]:
        a, b, ds = req["ff_sweep_ghz"]
        sol, freqs = f"{s.name} : {FF_SWEEP}", [round(x, 6) for x in np.arange(a, b + ds / 2, ds)]
    else:
        sol, freqs = f"{s.name} : LastAdaptive", [f0]
    want = {"rg": "dB(RealizedGainTotal)", "g": "dB(GainTotal)", "dir": "dB(DirTotal)", "rhcp": "dB(RealizedGainRHCP)",
            "lhcp": "dB(RealizedGainLHCP)", "ar": "dB(AxialRatioValue)"}
    theta, phi = req["ff_direction_deg"]
    theta, phi = round(theta / ANGLE_STEP) * ANGLE_STEP, (round(phi / ANGLE_STEP) * ANGLE_STEP) % 360  # 对齐到球面网格
    out = []
    for fq in freqs:
        d = hfss.post.get_solution_data(expressions=list(want.values()), setup_sweep_name=sol,
                                        variations={"Freq": [f"{fq}GHz"], "Theta": ["All"], "Phi": ["All"]},
                                        primary_sweep_variable="Theta", report_category="Far Fields", context=SPHERE)
        if not d:
            raise RuntimeError(_why(hfss, f"取不到 {fq} GHz 的远场"))
        data = {k: d.get_expression_data(e, sweeps=["Theta", "Phi"]) for k, e in want.items()}
        ang = np.asarray(data["rg"][0], dtype=float)  # [[theta, phi], ...]
        v = {k: np.asarray(y, dtype=float) for k, (_, y) in data.items()}
        k = int(np.nanargmax(v["rg"]))
        i = int(np.argmin(np.abs(ang[:, 0] - theta) + np.abs(ang[:, 1] - phi)))
        out.append({"f_ghz": fq, "peak_realized_gain_dbi": round(float(v["rg"][k]), 2),
                    "peak_direction_deg": [round(float(ang[k, 0]), 1), round(float(ang[k, 1]), 1)],
                    "radiation_efficiency": round(float(10 ** ((v["g"][k] - v["dir"][k]) / 10)), 3),
                    "total_efficiency": round(float(10 ** ((v["rg"][k] - v["dir"][k]) / 10)), 3),
                    "at_direction": {"theta_phi_deg": [theta, phi], "realized_gain_dbi": round(float(v["rg"][i]), 2),
                                     "rhcp_dbi": round(float(v["rhcp"][i]), 2), "lhcp_dbi": round(float(v["lhcp"][i]), 2),
                                     "axial_ratio_db": round(float(v["ar"][i]), 2)}})
    return out
