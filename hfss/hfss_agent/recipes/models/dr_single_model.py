"""单腔 TE01δ 介质谐振器滤波器 — 几何建模 (本征模 / 驱动模共用)。

结构: 方形镀银金属腔 (内尺寸 W x W x H, 壁厚 t), 腔中心一个陶瓷圆柱 (Φ D x L, εr 18),
      立在 PTFE 支撑柱上 (支撑柱高 (H-L)/2, 使陶瓷柱正好居中)。
驱动模另加两个侧壁同轴馈电 (端口 1 在 -x 壁, 端口 2 在 +x 壁, 关于 z 轴 180° 旋转对称), 两种耦合方式:
  coupling="loop" (采用): 水平耦合环, 位于陶瓷柱中间高度 z = H/2。同轴内导体伸进腔 Lx,
      横走 g, 再折回接到腔壁, 和腔壁围成一个 Lx x g 的水平小环。TE01δ 在中间平面上的磁场是竖直的,
      正好穿过这个环; HEM11δ / TM01δ 在中间平面上没有竖直磁场, 所以环几乎只和 TE01δ 耦合。
      Lx (离陶瓷柱多近) 和 g (环多宽) 决定耦合强弱 = 带宽。
  coupling="probe" (淘汰, 留作对比): 直探针, 横向偏移 yp, 伸入 Lp。探针沿 x 方向,
      会同时强烈激励 4.0 GHz 的 HEM11δ, 带外抑制很差。

坐标: 腔内壁 x, y ∈ [-W/2, W/2], z ∈ [0, H]; 陶瓷柱轴线 = z 轴。
"""
from pathlib import Path

import os

WORK = Path(__file__).resolve().parent  # 脚本所在目录, 文件夹整体搬家后不用改
# 环境变量 DR_PRJ 可指定别的工程文件 (例如复制品), 避免动到用户正在用的 dr_single.aedt
PRJ = os.environ.get("DR_PRJ", str(WORK / "dr_single.aedt"))
VERSION = "2025.2"  # 本机 AEDT 2025 R2

PROJ_VARS = {"$er_dr": "18", "$tand_dr": "1e-4"}
V = {
    "D": "24.25mm", "L": "9.5mm",     # 陶瓷柱直径 / 高度
    "W": "34mm", "H": "22mm",         # 方腔内尺寸 (压矮腔高可把箱体寄生模推离通带)
    "t": "3mm",                       # 腔壁厚
    "Ds": "8mm",                      # PTFE 支撑柱直径
    "Lx": "3mm", "g": "7mm",          # 耦合环: 伸入腔内深度 / 环宽 (两条腿中心距)
    "yp": "11mm", "Lp": "8mm",        # (直探针方案) 横向偏移 / 伸入长度
    "rp": "0.635mm", "rc": "2.1mm",   # 同轴内导体 (= 环导线) 半径 / PTFE 外半径 (≈50 Ω)
}


def ensure_unlocked(prj=PRJ):
    """工程有 .lock 时: 若有 AEDT 进程在跑 (用户可能正开着这个工程) 就拒绝运行; 否则是残留锁, 删掉。"""
    import subprocess

    lock = Path(prj + ".lock")
    if not lock.exists():
        return
    tasks = subprocess.run(["tasklist"], capture_output=True, text=True, errors="ignore").stdout.lower()
    if "ansysedt" in tasks:
        raise SystemExit(f"{lock.name} 存在且 AEDT 正在运行 —— 工程可能正被界面打开, 请先在界面里关闭工程再运行脚本。")
    lock.unlink()


def add_materials(hfss):
    for k, v in PROJ_VARS.items():
        hfss[k] = v
    cer = hfss.materials.add_material("Ceramic_er18")
    cer.permittivity = "$er_dr"
    cer.dielectric_loss_tangent = "$tand_dr"
    ptfe = hfss.materials.add_material("PTFE")
    ptfe.permittivity = 2.1
    ptfe.dielectric_loss_tangent = 2e-4


def feed_y(coupling):
    """两个同轴 (端口 1, 端口 2) 的 y 位置表达式。"""
    return ("g/2", "-g/2") if coupling == "loop" else ("yp", "-yp")


def build(hfss, kind, vars_override=None, coupling="loop", layout="90"):
    """kind: 'eig' 全模型本征模, 'eig_q' 1/4 模型 (x>0, y>0, 两个切面自动为 PEC), 'drv' 两端口驱动模。
    layout: '180' 端口 2 在 +x 壁 (正对端口 1); '90' 端口 2 在 +y 壁 (与端口 1 成 90°)。"""
    m = hfss.modeler
    m.model_units = "mm"
    for k, v in dict(V, **(vars_override or {})).items():
        hfss[k] = v

    air = m.create_box(["-W/2", "-W/2", "0mm"], ["W", "W", "H"], name="Cavity", material="vacuum")
    wall = m.create_box(["-W/2-t", "-W/2-t", "-t"], ["W+2*t", "W+2*t", "H+2*t"], name="Wall",
                        material="silver")
    m.subtract(wall, [air], keep_originals=True)
    sup = m.create_cylinder("Z", ["0mm", "0mm", "0mm"], "Ds/2", "(H-L)/2", name="Support", material="PTFE")
    puck = m.create_cylinder("Z", ["0mm", "0mm", "(H-L)/2"], "D/2", "L", name="Puck",
                             material="Ceramic_er18")
    m.subtract(air, [sup, puck], keep_originals=True)

    if kind == "drv":
        y1, y2 = feed_y(coupling)
        # 每侧所有圆柱都写成 "起点 + 正长度"。键: 同轴起点, 热腿起点, 接地腿起点, 横杆 x, 热端 y, 接地腿 y, 探针起点
        sides = (
            dict(cx="-W/2-t", hx="-W/2-t", gx="-W/2", xb="-W/2+Lx", yh=y1, yg=y2, px="-W/2-t"),
            dict(cx="W/2", hx="W/2-Lx", gx="W/2-Lx", xb="W/2-Lx", yh=y2, yg=y1, px="W/2-Lp"),
        )
        if layout == "90":
            # 端口 2 = 端口 1 关于竖直平面 y = -x 的镜像 → 端口 2 在 +y 壁, 两端口成 90°
            sides = (sides[0], sides[0])
        for i, s in enumerate(sides, start=1):
            coax = m.create_cylinder("X", [s["cx"], s["yh"], "H/2"], "rc", "t", name=f"Coax{i}", material="PTFE")
            if coupling == "loop":
                # 热腿: 同轴外端 -> 横杆 (长 t+Lx); 接地腿: 腔壁 -> 横杆 (长 Lx); 横杆: 沿 y 长 g; 拐角补球
                hot = m.create_cylinder("X", [s["hx"], s["yh"], "H/2"], "rp", "t+Lx", name=f"Loop{i}",
                                        material="pec")
                gnd = m.create_cylinder("X", [s["gx"], s["yg"], "H/2"], "rp", "Lx", name=f"LoopG{i}",
                                        material="pec")
                bar = m.create_cylinder("Y", [s["xb"], "-g/2", "H/2"], "rp", "g", name=f"LoopB{i}",
                                        material="pec")
                balls = [m.create_sphere([s["xb"], y, "H/2"], "rp", name=f"LoopC{i}{j}", material="pec")
                         for j, y in enumerate((s["yh"], s["yg"]))]
                m.unite([hot, gnd, bar] + balls)
                pin = hot
            else:
                pin = m.create_cylinder("X", [s["px"], s["yh"], "H/2"], "rp", "t+Lp", name=f"Pin{i}",
                                        material="pec")
            if layout == "90" and i == 2:
                m.mirror([coax, pin], [0, 0, 0], [1, 1, 0])
            m.subtract(wall, [coax], keep_originals=True)
            m.subtract(coax, [pin], keep_originals=True)
            m.subtract(air, [pin], keep_originals=True)

    if kind == "eig_q":
        names = list(m.object_names)
        m.split(names, plane="YZ", sides="PositiveOnly")
        m.split(names, plane="ZX", sides="PositiveOnly")

    m["Wall"].solve_inside = False
    air.display_wireframe = True
    m["Wall"].transparency = 0.8


def ev_mm(hfss, name):
    return float(hfss.get_evaluated_value(name)) * 1e3


def add_ports(hfss, coupling="loop", layout="90"):
    """波端口放在两个同轴的外端面 (PTFE 圆环面)。"""
    m = hfss.modeler
    W, t, H = (ev_mm(hfss, k) for k in ("W", "t", "H"))
    yo = ev_mm(hfss, "g") / 2 if coupling == "loop" else ev_mm(hfss, "yp")
    zc = H / 2
    e = W / 2 + t
    # (端面中心 x, y, 端面法向轴 0=x / 1=y)
    ends = [(-e, yo, 0), (e, -yo, 0)] if layout == "180" else [(-e, yo, 0), (-yo, e, 1)]
    for i, (xc, yc, ax) in enumerate(ends, start=1):
        face = [f for f in m[f"Coax{i}"].faces
                if abs(f.center[ax] - (xc, yc)[ax]) < 1e-3 and abs(f.center[2] - zc) < 1e-3]
        assert len(face) == 1, [f.center for f in m[f"Coax{i}"].faces]
        # 同轴是单模 TEM, 不需要积分线 (写死坐标的积分线在 g / W 变化后会偏离端口面)
        hfss.wave_port(face[0].id, impedance=50, name=str(i), renormalize=True)


def export_modes(hfss, path):
    """导出本征模结果, 返回 [(f_GHz, Q), ...]。"""
    path = Path(path)
    if path.exists():
        path.unlink()
    hfss.osolution.ExportEigenmodes("Setup1 : LastAdaptive", "", str(path))
    out = []
    for ln in path.read_text(errors="ignore").splitlines():
        parts = ln.split()
        if not parts or not parts[0].isdigit():
            continue
        nums = []
        for p in parts[1:]:
            try:
                nums.append(float(p.replace("j", "")))
            except ValueError:
                pass
        if nums:
            f = nums[0] / 1e9 if nums[0] > 1e6 else nums[0]
            q = None
            if len(nums) >= 3:
                q = nums[-1]
            out.append((round(f, 4), q))
    return out
