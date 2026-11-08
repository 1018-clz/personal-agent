"""从 S 参数曲线提取滤波器指标。不依赖 AEDT, 离线也能测。"""
import numpy as np

WIN_FRAC = 0.043  # 通带搜索窗: f0 ± 4.3% (3.5 GHz 时就是 filter/dr_single/02_filter.py 的 3.35–3.65 GHz)


def filter_metrics(f, s11, s21, f_solve):
    """f: GHz, s11 / s21: dB, f_solve: 自适应频点 (GHz), 只用来定通带搜索窗。返回 (指标, 警告列表)。

    f0_mhz = 窗内 S21 峰值频率, il_db = 峰值插损, bw3_mhz = 比峰值低 3 dB 的带宽,
    spurious = 通带以外所有高于 -20 dB 的 S21 局部峰 [[MHz, dB], ...] (多余的谐振)。
    """
    f, s11, s21 = (np.asarray(a, dtype=float) for a in (f, s11, s21))
    win = (f > f_solve * (1 - WIN_FRAC)) & (f < f_solve * (1 + WIN_FRAC))
    idx = np.flatnonzero(win)
    if idx.size == 0:
        raise ValueError(f"扫频范围 {f[0]}–{f[-1]} GHz 没有覆盖通带搜索窗 (f0 = {f_solve} GHz)")
    warn = []
    k = int(idx[np.argmax(s21[win])])
    if k in (idx[0], idx[-1]):
        warn.append("S21 峰值贴着搜索窗边缘: 真实谐振可能不在 f0_ghz 附近, 先跑 eigenmode 确认")
    pk = s21[k]
    if 0 < k < len(f) - 1:  # 三点抛物线细化峰值
        a, b, c = s21[k - 1], s21[k], s21[k + 1]
        den = a - 2 * b + c
        d = 0.5 * (a - c) / den if den < 0 else 0.0
        f0, pk = f[k] + d * (f[1] - f[0]), b - (a - c) ** 2 / (8 * den) if den < 0 else b
    else:
        f0 = f[k]
    if pk < -10:
        warn.append(f"窗内 S21 峰值只有 {pk:.1f} dB: 可能没有通带 (谐振不在窗内, 或耦合太弱)")
    thr = pk - 3.0
    lo = k
    while lo > 0 and s21[lo] >= thr:
        lo -= 1
    hi = k
    while hi < len(f) - 1 and s21[hi] >= thr:
        hi += 1
    if s21[lo] >= thr or s21[hi] >= thr:  # 扫到频段尽头还没降 3 dB
        bw3 = None
        warn.append("扫频范围内 S21 没有从峰值降下 3 dB, 量不出带宽: 把 band_ghz 放宽")
    else:
        flo = np.interp(thr, [s21[lo], s21[lo + 1]], [f[lo], f[lo + 1]])
        fhi = np.interp(thr, [s21[hi], s21[hi - 1]], [f[hi], f[hi - 1]])
        bw3 = round((fhi - flo) * 1e3, 1)
    # 整个扫频段里所有高于 -20 dB 的 S21 局部峰, 去掉主峰, 剩下的都是多余的谐振
    peaks = [[round(f[i] * 1e3), round(float(s21[i]), 1)] for i in range(1, len(f) - 1)
             if s21[i] > s21[i - 1] and s21[i] >= s21[i + 1] and s21[i] > -20 and i != k]
    return {"f0_mhz": round(f0 * 1e3, 1), "il_db": round(-pk, 3), "bw3_mhz": bw3,
            "s11_at_f0_db": round(float(np.interp(f0, f, s11)), 1),
            "s11_min": [round(f[int(np.argmin(np.where(win, s11, 0)))] * 1e3, 1), round(float(np.min(s11[win])), 1)],
            "spurious": peaks}, warn


def dips(f, y, thr=-3.0, top=6):
    """所有低于 thr 的局部最小点 [[MHz, dB], ...], 三点抛物线细化, 最深的排前面。"""
    out = []
    for k in range(1, len(y) - 1):
        if y[k] < y[k - 1] and y[k] <= y[k + 1] and y[k] < thr:
            a, b, c = y[k - 1], y[k], y[k + 1]
            den = a - 2 * b + c
            df = 0.5 * (a - c) / den if den > 0 else 0.0
            out.append([round((f[k] + df * (f[1] - f[0])) * 1e3, 1),
                        round(b - (a - c) ** 2 / (8 * den) if den > 0 else b, 2)])
    return sorted(out, key=lambda p: p[1])[:top]


def bands_below(f, y, level=-10.0):
    """y 低于 level 的连续频段 [[起 MHz, 止 MHz], ...], 边界线性插值。碰到扫频范围的两端就算到端点为止。"""
    out, start = [], f[0] if y[0] < level else None
    for i in range(len(f) - 1):
        if (y[i] < level) != (y[i + 1] < level):
            x = f[i] + (level - y[i]) / (y[i + 1] - y[i]) * (f[i + 1] - f[i])
            if start is None:
                start = x
            else:
                out.append([round(start * 1e3, 1), round(x * 1e3, 1)])
                start = None
    if start is not None:
        out.append([round(start * 1e3, 1), round(f[-1] * 1e3, 1)])
    return out


def peaks(f, y, floor=-20.0, top=6):
    """高于 floor 的局部峰 [[MHz, dB], ...], 最高的排前面。"""
    out = [[round(f[i] * 1e3, 1), round(float(y[i]), 2)] for i in range(1, len(y) - 1)
           if y[i] > y[i - 1] and y[i] >= y[i + 1] and y[i] > floor]
    return sorted(out, key=lambda p: -p[1])[:top]


def s_summary(f, s, f_solve, z=None):
    """任意端口数的 S 参数小结。s: {"S(1,1)": dB 数组, "S(2,1)": ...}, z: {"S(1,1)": 复阻抗数组} (可选)。

    反射项看谷点和 -10 dB 频段, 传输项看峰值; 正好两个端口时再按滤波器算一遍通带。
    """
    f = np.asarray(f, dtype=float)
    out = {}
    for name, y in s.items():
        y = np.asarray(y, dtype=float)
        a, b = name[name.index("(") + 1:-1].split(",")
        k = int(np.argmin(np.abs(f - f_solve)))
        r = {"at_f_solve_db": round(float(y[k]), 2)}
        if a == b:
            i = int(np.argmin(y))
            r.update(min=[round(f[i] * 1e3, 1), round(float(y[i]), 2)], dips=dips(f, y), bands_10db_mhz=bands_below(f, y))
            if z and name in z:
                r["z_at_min_ohm"] = [round(float(z[name][i].real), 1), round(float(z[name][i].imag), 1)]
                r["z_at_f_solve_ohm"] = [round(float(z[name][k].real), 1), round(float(z[name][k].imag), 1)]
        else:
            i = int(np.argmax(y))
            r.update(max=[round(f[i] * 1e3, 1), round(float(y[i]), 2)], peaks=peaks(f, y))
        out[name] = r
    mutual = [n for n in out if "max" in out[n]]
    if len(mutual) == 1:  # 两端口: 按滤波器再看一遍。不一定是滤波器, 所以它的提醒留在这里, 不算全局警告
        name = mutual[0]
        q, inner = name[:-1].split("(")
        a = inner.split(",")[1]
        try:
            m, notes = filter_metrics(f, s[f"{q}({a},{a})"], s[name], f_solve)
            out["passband"] = {**m, "notes": notes}
        except (KeyError, ValueError):
            pass
    return out
