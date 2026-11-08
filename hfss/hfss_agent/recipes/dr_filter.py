"""配方: 单腔 TE01δ 介质谐振器滤波器。

几何全部来自 models/dr_single_model.py (原项目 filter/dr_single/dr_model.py 的原样副本), 这里只负责把它变成"给尺寸, 出指标"的函数:
每个任务都在数据目录的 runs/<job_id>/ 里新建工程, 绝不碰用户自己的 dr_single.aedt。

  eigenmode  本征模 (快): TE01δ 频率、无载 Q、离它最近的模式
  driven     驱动模: S 参数, f0 / 插损 / 带宽 / 寄生通带
"""
import hashlib
import importlib.util
import math
from pathlib import Path

import numpy as np

from ..metrics import filter_metrics
from .common import MESH, aedt_version, export_modes, judge, parse_convergence, verdict

NAME = "dr_filter"
DESCRIPTION = ("单腔 TE01δ 介质谐振器滤波器: 方形镀银腔, 中心陶瓷圆柱立在 PTFE 支撑柱上, "
               "两个同轴耦合环分别在相邻两壁 (layout=90) 或相对两壁 (layout=180)。")
ANALYSES = {"eigenmode": "本征模, 快。得到 te01d_ghz、q0 和最近模式的间隔。改尺寸后先跑这个",
            "driven": "驱动模, 慢。得到 f0、插损、带宽、寄生通带。必须给 f0_ghz (用 eigenmode 的 te01d_ghz)"}

# 几何来自原项目 filter/dr_single/dr_model.py, 原样复制过来 (内容没改, 所以 MODEL_SHA 和以前一样)
_path = Path(__file__).resolve().parent / "models" / "dr_single_model.py"
_spec = importlib.util.spec_from_file_location("dr_single_model", _path)  # 不用 import: dr6g 也有个同名的 dr_model
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)
MODEL_SHA = hashlib.sha1(_path.read_bytes()).hexdigest()[:12]  # 模型改过之后, 旧结果不能再当缓存用

RP, RC = (float(M.V[k].removesuffix("mm")) for k in ("rp", "rc"))  # 同轴内导体 / PTFE 外半径, 定了 50 Ω, 不开放
GAP = 0.3  # 金属件之间至少留这么多 (mm)


def _mm(name, lo, hi, desc):
    return {"default": float(M.V[name].removesuffix("mm")), "unit": "mm", "min": lo, "max": hi, "desc": desc}


PARAMS = {
    "D": _mm("D", 2, 80, "陶瓷柱直径"),
    "L": _mm("L", 1, 40, "陶瓷柱高度"),
    "W": _mm("W", 5, 120, "方腔内边长"),
    "H": _mm("H", 3, 80, "方腔内高度"),
    "t": _mm("t", 1, 10, "腔壁厚"),
    "Ds": _mm("Ds", 1, 30, "PTFE 支撑柱直径"),
    "Lx": _mm("Lx", 0.8, 15, "耦合环伸入腔内的深度 (越深耦合越强, 带宽越宽)"),
    "g": _mm("g", 3, 40, "耦合环宽度 (两条腿中心距)"),
    "er": {"default": float(M.PROJ_VARS["$er_dr"]), "unit": "", "min": 1, "max": 100, "desc": "陶瓷相对介电常数"},
    "tand": {"default": float(M.PROJ_VARS["$tand_dr"]), "unit": "", "min": 0, "max": 0.01, "desc": "陶瓷损耗角正切"},
    "layout": {"default": "90", "choices": ["90", "180"], "desc": "两端口夹角: 90 相邻两壁, 180 相对两壁"},
}
GEOM = ("D", "L", "W", "H", "t", "Ds", "Lx", "g")
CONSTRAINTS = ["Ds < D", "L + 1 <= H (支撑柱至少 0.5 mm 高)", "耦合环横杆和陶瓷柱之间至少留 0.3 mm",
               "耦合环接地腿和同轴孔之间至少留 0.3 mm", "同轴孔不能超出腔壁范围", "layout=90 时两个耦合环不能相碰"]


def check_geometry(p):
    """HFSS 跑之前先查几何, 省得一个撞车的模型白跑几分钟。返回问题列表。"""
    bad = []
    if p["Ds"] >= p["D"]:
        bad.append(f"支撑柱 Ds={p['Ds']} 要小于陶瓷柱 D={p['D']}")
    if p["H"] - p["L"] < 1:
        bad.append(f"腔高 H={p['H']} 要比陶瓷柱 L={p['L']} 至少高 1 mm")
    gap = p["W"] / 2 - p["D"] / 2 - p["Lx"] - RP
    if gap < GAP:
        bad.append(f"耦合环横杆离陶瓷柱只有 {gap:.2f} mm (至少 {GAP}): 减小 Lx 或 D, 或加大 W")
    if p["g"] - RC - RP < GAP:
        bad.append(f"耦合环接地腿离同轴孔只有 {p['g'] - RC - RP:.2f} mm (至少 {GAP}): 加大 g")
    if p["g"] / 2 + RC + GAP > p["W"] / 2:
        bad.append(f"g={p['g']} 太大, 同轴孔超出腔壁范围")
    if RC + GAP > p["H"] / 2:
        bad.append(f"H={p['H']} 太矮, 放不下同轴孔")
    if p["layout"] == "90" and p["g"] / 2 + p["Lx"] + 2 * RP + GAP > p["W"] / 2:
        bad.append("layout=90 时两个耦合环会相碰: 减小 g 或 Lx")
    return bad


def prepare(analysis, params, f0_ghz, band_ghz, step_mhz):
    """校验请求, 补全默认值。有问题就一次全部说清楚 (ValueError), 让调用方一次改完。"""
    bad, p = [], {}
    if analysis not in ANALYSES:
        bad.append(f"没有分析类型 {analysis!r}, 可选 {list(ANALYSES)}")
    for k in params:
        if k not in PARAMS:
            bad.append(f"没有参数 {k!r}, 可选 {list(PARAMS)}")
    for k, spec in PARAMS.items():
        v = params.get(k, spec["default"])
        if "choices" in spec:
            p[k] = str(v)
            if p[k] not in spec["choices"]:
                bad.append(f"{k} 只能是 {spec['choices']}, 收到 {v!r}")
            continue
        try:
            p[k] = float(v)
        except (TypeError, ValueError):
            bad.append(f"{k} 要填数字 (单位 {spec['unit'] or '无'}), 收到 {v!r}")
            continue
        if not spec["min"] <= p[k] <= spec["max"]:
            bad.append(f"{k}={p[k]} 超出范围 {spec['min']}–{spec['max']} {spec['unit']}")
    if not bad:
        bad += check_geometry(p)
    req = {"params": p, "f0_ghz": None, "band_ghz": None, "step_mhz": None, "model_sha": MODEL_SHA}
    if analysis == "driven":
        if f0_ghz is None:
            bad.append("driven 必须给 f0_ghz: 先跑 eigenmode, 把 te01d_ghz 填进来 (HFSS 在这个频率上加密网格)")
        else:
            # 默认频段按比例缩放, 3.5 GHz 时就是 02_filter.py 的 3.0–4.6 GHz
            band = list(band_ghz) if band_ghz else [round(f0_ghz * 6 / 7, 3), round(f0_ghz * 46 / 35, 3)]
            if len(band) != 2 or not band[0] < f0_ghz < band[1]:
                bad.append(f"band_ghz={band} 要写成 [起, 止] 并且包住 f0_ghz={f0_ghz}")
            req.update(f0_ghz=float(f0_ghz), band_ghz=band, step_mhz=float(step_mhz))
    if bad:
        raise ValueError("; ".join(bad))
    return req


def run(req, ctx):
    return {"eigenmode": _eigenmode, "driven": _driven}[req["analysis"]](req, ctx)


def _open(ctx, design, solution_type):
    from ansys.aedt.core import Hfss  # 只有 worker 才走到这里, MCP 服务不加载 pyaedt

    return Hfss(project=str(ctx.project), design=design, solution_type=solution_type, version=aedt_version(),
                non_graphical=True, new_desktop=True, close_on_exit=True)


def _vars(p):
    return {k: f"{p[k]}mm" for k in GEOM}


def _materials(hfss, p):
    M.add_materials(hfss)
    hfss["$er_dr"], hfss["$tand_dr"] = str(p["er"]), str(p["tand"])


def _convergence(hfss, path):
    hfss.export_convergence("Setup1", output_file=str(path))
    return parse_convergence(path.read_text(errors="ignore"))


def _fmin_ghz(p):
    """本征模起始频率: TE01δ 经验公式估值的 0.64 倍, 默认几何正好是 01_eig.py 用的 2 GHz。

    它要低于 TE01δ, 否则目标模式会被漏掉; 它还决定初始网格的粗细, 所以粗网格下改它, 结果会飘几 MHz。
    """
    a = p["D"] / 2
    return round(0.64 * 34 / (a * math.sqrt(p["er"])) * (a / p["L"] + 3.45), 1)


def _eig_setup(hfss, nmodes, fmin, mesh):
    s = hfss.create_setup("Setup1")
    s.props["MinimumFrequency"] = f"{fmin}GHz"
    s.props["NumModes"] = nmodes
    s.props["MaximumPasses"] = mesh["passes"]
    s.props["MinimumPasses"] = 2
    s.props["MinimumConvergedPasses"] = 2
    s.props["MaxDeltaFreq"] = mesh["dfreq"]
    s.props["ConvergeOnRealFreq"] = True
    s.update()


def _eigenmode(req, ctx):
    """EIG_Q 是 1/4 模型, 两个切面是金属壁, 只有 TE01δ 这类模式能活下来, 它的最低模就是 TE01δ;
    再到全模型 EIG 的模式表里对号入座, 看离其它模式有多远。"""
    p, mesh = req["params"], MESH[req["mesh"]]
    hfss = _open(ctx, "EIG", "Eigenmode")
    try:
        ctx.stage("建模")
        _materials(hfss, p)
        M.build(hfss, "eig", vars_override=_vars(p))
        _eig_setup(hfss, 6, _fmin_ghz(p), mesh)
        hfss.insert_design("EIG_Q", solution_type="Eigenmode")
        M.build(hfss, "eig_q", vars_override=_vars(p))
        _eig_setup(hfss, 2, _fmin_ghz(p), mesh)
        modes, conv = {}, {}
        for des in ("EIG_Q", "EIG"):
            ctx.stage(f"求解 {des}")
            hfss.set_active_design(des)
            if not hfss.analyze_setup("Setup1", cores=ctx.cores):
                raise RuntimeError(f"{des} 求解失败")
            modes[des] = export_modes(hfss, "Setup1", ctx.dir / f"{des}.eig")
            conv[des] = _convergence(hfss, ctx.dir / f"{des}_conv.prof")
        hfss.save_project()
    finally:
        hfss.release_desktop(close_projects=True, close_desktop=True)

    te, full = modes["EIG_Q"][0], modes["EIG"]
    i = min(range(len(full)), key=lambda k: abs(full[k][0] - te[0]))
    others = [m for j, m in enumerate(full) if j != i]
    near = min(others, key=lambda m: abs(m[0] - full[i][0]))
    ok, warn = judge(conv["EIG"], "Delta Freq", mesh["dfreq"])
    ok_q, warn_q = judge(conv["EIG_Q"], "Delta Freq", mesh["dfreq"])
    ok, warn = ok and ok_q, warn + warn_q
    if abs(full[i][0] - te[0]) > 0.01 * te[0]:
        warn.append(f"1/4 模型的 TE01δ ({te[0]} GHz) 在全模型里找不到对应模式, 模式识别可能错了")
    return {"metrics": {"te01d_ghz": full[i][0], "q0": full[i][1], "nearest_mode_ghz": near[0],
                        "mode_spacing_mhz": round(abs(near[0] - full[i][0]) * 1e3, 1),
                        "modes_ghz": [m[0] for m in full]},
            "convergence": conv["EIG"], "converged": ok, "use": verdict(req["mesh"], ok), "warnings": warn,
            "files": {"project": str(ctx.project)}}


def _driven(req, ctx):
    p, mesh, f0, band = req["params"], MESH[req["mesh"]], req["f0_ghz"], req["band_ghz"]
    hfss = _open(ctx, "FILTER", "Modal")
    try:
        ctx.stage("建模")
        _materials(hfss, p)
        M.build(hfss, "drv", vars_override=_vars(p), coupling="loop", layout=p["layout"])
        M.add_ports(hfss, "loop", p["layout"])
        s = hfss.create_setup("Setup1")
        s.props["Frequency"] = f"{f0}GHz"
        s.props["MaximumPasses"] = mesh["passes"]
        s.props.pop("MaxDeltaE", None)  # pyaedt 1.x 的模板可能默认按场能量收敛, 这里要按 S 参数收敛
        s.props["MaxDeltaS"] = mesh["dS"]
        s.props["MinimumConvergedPasses"] = mesh["minconv"]
        s.update()
        s.create_linear_step_sweep(unit="GHz", start_frequency=band[0], stop_frequency=band[1],
                                   step_size=req["step_mhz"] / 1e3, name="Sweep", save_fields=False,
                                   sweep_type="Interpolating")
        if not hfss.validate_simple():
            raise RuntimeError("模型校验没通过 (几何或端口有问题)")
        ctx.stage("求解")
        if not hfss.analyze_setup("Setup1", cores=ctx.cores):
            raise RuntimeError("求解失败")
        ctx.stage("提取结果")
        d = hfss.post.get_solution_data(expressions=["dB(S(1,1))", "dB(S(2,1))"], setup_sweep_name="Setup1 : Sweep",
                                        primary_sweep_variable="Freq")
        f, s11 = d.get_expression_data("dB(S(1,1))")  # (频率 GHz, 值)
        s21 = d.get_expression_data("dB(S(2,1))")[1]
        csv = ctx.dir / "s_params.csv"
        np.savetxt(csv, np.column_stack([f, s11, s21]), delimiter=",", header="f_GHz,S11_dB,S21_dB", comments="")
        conv = _convergence(hfss, ctx.dir / "conv.prof")
        hfss.save_project()
    finally:
        hfss.release_desktop(close_projects=True, close_desktop=True)

    metrics, warn = filter_metrics(f, s11, s21, f0)
    ok, warn2 = judge(conv, "Delta S", mesh["dS"])
    return {"metrics": metrics, "convergence": conv, "converged": ok,
            "use": verdict(req["mesh"], ok), "warnings": warn2 + warn,
            "files": {"s_params_csv": str(csv), "project": str(ctx.project)}}
