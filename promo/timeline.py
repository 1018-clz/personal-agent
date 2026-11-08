"""宣传片的唯一数据源：界面布局（UI 像素）和所有事件的时间（秒）。

ui.py（贴图）、scene.py（Blender）、sound.py（音效）都只读这里的数字。
UI 坐标：1920x1080，左上角为原点，1 像素 = 1 毫米。
"""
import math

FPS = 30
DURATION = 50.0
FRAMES = int(DURATION * FPS)          # 1500
BPM = 120
BEAT = 60.0 / BPM                      # 0.5 s
BUILD = r"D:\clawd_promo_build"       # 大文件（逐帧贴图、渲染帧、音频）

UI_W, UI_H = 1920, 1080
TEX_SCALE = 2                          # 贴图是 UI 像素的 2 倍
PX = 0.001                             # 1 UI 像素 = 1 mm


def frame_of(t):
    return int(round(t * FPS)) + 1


def time_of(frame):
    return (frame - 1) / FPS


def ui_to_m(x, y):
    return ((x - UI_W / 2) * PX, (UI_H / 2 - y) * PX)


# ---------------------------------------------------------------- 面板（玻璃板）
# name: (UI 矩形, 顶面高度 m, 厚度 m, 贴图序列, 贴图内矩形)
MAIN_PANELS = {
    "TOP":   (8, 8, 1912, 60),
    "SIDE":  (8, 68, 292, 1072),
    "CHAT":  (300, 68, 1096, 1072),
    "MODEL": (1104, 68, 1912, 452),
    "JOBS":  (1104, 460, 1912, 690),
    "PLOT":  (1104, 698, 1912, 1072),
}
PANEL_Z = {"TOP": 0.030, "SIDE": 0.024, "CHAT": 0.036, "MODEL": 0.030,
           "JOBS": 0.040, "PLOT": 0.034, "SET": 0.115, "DLG": 0.100,
           "TIP": 0.05, "END": 0.060}
PANEL_THICK = 0.018

# 浮起来的面板：UI 位置 + 自己的贴图尺寸（UI 像素）
SET_RECT = (560, 140, 1320, 700)      # 模型设置 760x560
DLG_RECT = (380, 590, 1016, 850)      # 权限弹窗 636x260
END_RECT = (360, 200, 1560, 800)      # 片尾卡 1200x600
TIP_SIZE = (860, 84)                   # 提示条

# 顶栏
LOGO = (24, 14, 300, 54)
CHIP_HFSS = (1040, 16, 1290, 52)
CHIP_MEM = (1302, 16, 1446, 52)
CHIP_MODEL = (1458, 16, 1722, 52)
BTN_SETTINGS = (1734, 16, 1896, 52)
# 侧栏
BTN_NEW = (24, 84, 276, 128)
SANDBOX = (24, 1016, 276, 1056)
# 聊天
INPUT = (320, 962, 1076, 1052)
BTN_SEND = (968, 974, 1060, 1040)
WELCOME_C = (698, 400)                 # 平面 Clawd 中心
CLAWD_W_PX = 100                       # 平面 Clawd 身体宽度
USER_BUBBLE = (520, 136, 1076, 218)
MEM_CARD = (320, 236, 900, 376)
REPLY_Y = 396
TOOL1 = (320, 470, 900, 516)
TOOL2 = (320, 526, 900, 572)
RESULT_CARD = (320, 592, 1040, 760)
# 右侧
VIEWPORT = (1120, 108, 1896, 440)
JOB_ROWS_Y = (532, 590, 648)
JOB_BAR_X = (1470, 1760)
GRAPH = (1170, 760, 1890, 1030)
F_MIN, F_MAX = 7.83, 7.895             # GHz
DB_MIN = -40.0
F0, IL, BW = 7.8625, 0.56, 0.0146      # 来自 README 的真实结果


def f_to_x(f):
    return GRAPH[0] + (f - F_MIN) / (F_MAX - F_MIN) * (GRAPH[2] - GRAPH[0])


def db_to_y(db):
    return GRAPH[1] + (db / DB_MIN) * (GRAPH[3] - GRAPH[1])


def s21_db(f):
    """二阶切比雪夫带通，0.1 dB 纹波，加上插损。"""
    eps2 = 10 ** (0.1 / 10) - 1
    w = (f - F0) / (BW / 2) * 1.94
    t2 = 2 * w * w - 1
    p = 1.0 / (1.0 + eps2 * t2 * t2)
    return 10 * math.log10(p) - IL


def s11_db(f):
    eps2 = 10 ** (0.1 / 10) - 1
    w = (f - F0) / (BW / 2) * 1.94
    t2 = 2 * w * w - 1
    p = 1.0 / (1.0 + eps2 * t2 * t2)
    r = max(1 - p, 10 ** (-3.2))
    return max(10 * math.log10(r), -32.0)


# 设置弹窗内的控件（弹窗本地 UI 像素）
SET_CHIPS = [("DeepSeek", 32, 170), ("通义千问", 182, 320), ("Kimi", 332, 430),
             ("智谱", 442, 530), ("OpenAI 兼容", 542, 728)]
SET_CHIP_Y = (120, 160)
SET_ADDR = (32, 205, 728, 245)
SET_KEY = (32, 285, 560, 325)
SET_GETKEY = (572, 285, 728, 325)
SET_MODEL = (32, 365, 560, 405)
SET_LIST = (572, 365, 728, 405)
SET_TEST = (32, 440, 250, 490)
SET_SAVE = (540, 440, 728, 490)
# 权限弹窗（本地）
DLG_DENY = (24, 186, 144, 236)
DLG_SESSION = (160, 186, 400, 236)
DLG_ALLOW = (416, 186, 612, 236)


def set_to_ui(x, y):
    return (SET_RECT[0] + x, SET_RECT[1] + y)


def dlg_to_ui(x, y):
    return (DLG_RECT[0] + x, DLG_RECT[1] + y)


def center(r):
    return ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)


# ---------------------------------------------------------------- 事件时间
T = dict(
    boot=[0.25, 0.55, 0.85, 1.15, 1.45, 1.75],   # TOP SIDE CHAT MODEL JOBS PLOT 依次亮起
    welcome=2.0,
    knocks=[2.5, 3.0],
    peel=3.3, pop=4.0, pop_land=4.5,
    settings_press=6.0, settings_open=6.05,
    pick_deepseek=7.0, key_in=8.0, list_models=9.0, test=10.0, test_ok=10.4,
    save=11.0, settings_close=11.4,
    type_start=12.0, type_end=13.8, send=14.5,
    memory=15.5, reply_start=16.6, reply_end=17.6,
    tool1_show=17.6, tool1_done=18.5, model_draw=18.5, model_spin=20.0,
    dialog_open=21.0, allow=22.5,
    jobs_start=22.6, job_done=[24.0, 24.5, 25.0],
    surf_start=26.0, surf_end=29.0,
    marker=30.0, result=30.0,
    tip_hfss=33.5, tip_mem=35.75, tip_model=37.85, tip_sandbox=40.5,
    logo=43.0,
    shutdown=43.25,          # 之后依次掉落
    end_rise=(44.0, 45.6),
    end_land=46.0, end_text=46.2,
    wave=46.6, fade=(49.0, 50.0),
)
TIP_DUR = 1.55
TIPS = [
    ("hfss", T["tip_hfss"], (1240, 134), "HFSS：本征模 · 驱动模 · 远场 · 参数扫描，任意 .aedt 工程"),
    ("mem", T["tip_mem"], (1330, 134), "记忆：Hindsight 本地长期记忆，跨会话记住你的习惯"),
    ("model", T["tip_model"], (1470, 134), "自带 Key：DeepSeek · 通义千问 · Kimi · 智谱 · OpenAI 兼容"),
    ("sandbox", T["tip_sandbox"], (740, 1036), "沙箱：命令在 AppContainer 里运行，默认断网，改动都要你批准"),
]
# 掉落顺序：（面板, 断电时刻）
SHUTDOWN = [("SIDE", 43.25), ("JOBS", 43.45), ("MODEL", 43.65), ("CHAT", 43.85),
            ("PLOT", 44.05), ("TOP", 44.6)]

USER_TEXT = "帮我设计一个 7.86 GHz 的介质谐振器滤波器，插损小于 1 dB。"
REPLY_TEXT = "好的，按你的习惯：先用 dr_filter 配方建模，再提交本征模、驱动模扫频和 gap 扫描。"
MEM_ITEMS = ["你习惯先跑本征模，再跑驱动模", "结论只用 fine 网格且已收敛的结果", "上次 dr6g 工程的 gap = 1.4 mm"]
JOBS = [("本征模 · 2 个谐振模式", "Q = 3120"),
        ("驱动模 · 7.83–7.90 GHz 扫频", "ΔS = 0.012"),
        ("参数扫描 · gap 1.2 / 1.4 / 1.6 mm", "3 / 3")]


# ---------------------------------------------------------------- Clawd 的路线
# 每一跳：(起跳, 落地, 落点 UI 坐标, 落在哪块板, 最高点 m, 空翻圈数)
def _c(r):
    return center(r)


HOPS = [
    (4.0, 4.5, WELCOME_C[0], WELCOME_C[1] + 42, "CHAT", 0.11, 0),       # pop
    (5.0, 6.0, *_c(BTN_SETTINGS), "TOP", 0.24, 0),
    (6.45, 7.0, *set_to_ui(101, 140), "SET", 0.09, 0),
    (7.5, 8.0, *set_to_ui(300, 305), "SET", 0.08, 0),
    (8.5, 9.0, *set_to_ui(650, 385), "SET", 0.08, 0),
    (9.5, 10.0, *set_to_ui(141, 465), "SET", 0.09, 0),
    (10.5, 11.0, *set_to_ui(634, 465), "SET", 0.08, 0),
    (11.3, 12.0, 560, 974, "CHAT", 0.15, 0),
    (14.0, 14.5, *_c(BTN_SEND), "CHAT", 0.08, 0),
    (15.0, 15.5, 640, 306, "CHAT", 0.13, 0),
    (18.0, 18.5, 640, 493, "CHAT", 0.08, 0),
    (19.25, 20.0, 1500, 300, "MODEL", 0.16, 0),
    (21.5, 22.5, *dlg_to_ui(514, 211), "DLG", 0.20, 1),
    (23.25, 24.0, 1615, JOB_ROWS_Y[0], "JOBS", 0.15, 0),
    (24.15, 24.5, 1615, JOB_ROWS_Y[1], "JOBS", 0.05, 0),
    (24.65, 25.0, 1615, JOB_ROWS_Y[2], "JOBS", 0.05, 0),
    (25.4, 26.0, GRAPH[0] + 12, GRAPH[3] + 6, "PLOT", 0.12, 0),
    # 26–29 冲浪（单独处理）
    (29.2, 30.0, f_to_x(F0), 778, "PLOT", 0.18, 1),
    (30.5, 30.75, f_to_x(F0), 778, "PLOT", 0.035, 0),
    (31.0, 31.25, f_to_x(F0), 778, "PLOT", 0.035, 0),
    (31.5, 31.75, f_to_x(F0), 778, "PLOT", 0.035, 0),
    (32.75, 33.5, *_c(CHIP_HFSS), "TOP", 0.18, 0),
    (35.3, 35.75, *_c(CHIP_MEM), "TOP", 0.06, 0),
    (37.4, 37.85, *_c(CHIP_MODEL), "TOP", 0.06, 0),
    (39.4, 40.5, *_c(SANDBOX), "SIDE", 0.36, 1),
    (42.3, 43.0, *_c(LOGO), "TOP", 0.22, 0),
    (44.75, 46.0, 1400, 735, "END", 0.30, 0),
]
SURF = (26.0, 29.0, GRAPH[0] + 12, GRAPH[2] - 8, GRAPH[3] + 6)

CLAWD_START = (WELCOME_C[0], WELCOME_C[1] + 42)   # 平面时脚底所在的 UI 点


def surf_x(t):
    t0, t1, x0, x1, _ = SURF
    s = min(max((t - t0) / (t1 - t0), 0.0), 1.0)
    s = s * s * (3 - 2 * s) * 0.35 + s * 0.65      # 稍带缓入缓出
    return x0 + (x1 - x0) * s


def cursor_x(t):
    """频率光标：冲浪时跟着 Clawd，之前停在左端，之后停在右端。"""
    if t < SURF[0]:
        return SURF[2]
    return surf_x(t)


# ---------------------------------------------------------------- 声音事件
def sound_events():
    ev = []
    for t in T["boot"]:
        ev.append((t, "power_on"))
    ev.append((T["welcome"], "blip"))
    for t in T["knocks"]:
        ev.append((t, "knock"))
    ev.append((T["peel"], "peel"))
    ev.append((T["pop"], "pop"))
    for h in HOPS:
        t0, t1, *_rest, apex, flips = h
        if t0 > T["pop"]:
            ev.append((t0, "boing" if apex < 0.2 else "boing_big"))
        if apex >= 0.15:
            ev.append((t0 + 0.05, "whoosh"))
        ev.append((t1, "land"))
    ev += [(T["settings_press"], "click"), (T["settings_open"], "pop_ui"),
           (T["pick_deepseek"], "click"), (T["list_models"], "click"),
           (T["test"], "click"), (T["test_ok"], "success"),
           (T["save"], "click"), (T["settings_close"], "close_ui"),
           (T["send"], "click"), (T["send"] + 0.05, "send"),
           (T["memory"], "click")]
    for i in range(3):
        ev.append((T["memory"] + 0.25 * (i + 1), "chime%d" % i))
    n = len(USER_TEXT)
    for i in range(n):
        ev.append((T["type_start"] + (T["type_end"] - T["type_start"]) * i / n, "key"))
    for i in range(12):
        ev.append((T["key_in"] + 0.05 * i, "key"))
    ev += [(T["tool1_done"], "click"), (T["model_draw"], "scribble"), (T["model_spin"], "spin"),
           (T["dialog_open"], "pop_ui"), (T["allow"], "click"), (T["allow"] + 0.03, "approve")]
    for i, t in enumerate(T["job_done"]):
        ev.append((t, "ding%d" % i))
    ev.append((SURF[0], "ding3"))
    ev.append((SURF[0], "skate"))
    ev.append((T["marker"], "brass"))
    ev.append((T["marker"], "sparkle"))
    for _, t, _, _ in TIPS:
        ev.append((t + 0.05, "tip"))
    ev.append((T["logo"], "click"))
    for _, t in SHUTDOWN:
        ev.append((t, "power_down"))
        ev.append((t + 0.25, "fall"))
    ev.append((T["end_rise"][0], "riser"))
    ev.append((T["end_land"], "final"))
    ev.append((T["end_land"] + 0.4, "yay"))
    return sorted(ev)


# ---------------------------------------------------------------- 碎屏
SHATTER_C = (698, 405)        # 冲击中心（UI 像素）
SHATTER_R = 230               # 裂纹范围
EJECT_R = 92                  # 中心这一圈碎块会飞起来


def _clip(poly, a, b, c):
    """保留 a*x + b*y <= c 的那一半。"""
    out = []
    n = len(poly)
    for i in range(n):
        p, q = poly[i], poly[(i + 1) % n]
        fp, fq = a * p[0] + b * p[1] - c, a * q[0] + b * q[1] - c
        if fp <= 0:
            out.append(p)
        if (fp < 0) != (fq < 0) and fp != fq:
            k = fp / (fp - fq)
            out.append((p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k))
    return out


def _centroid(poly):
    A = cx = cy = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        cr = x0 * y1 - x1 * y0
        A += cr
        cx += (x0 + x1) * cr
        cy += (y0 + y1) * cr
    A *= 0.5
    if abs(A) < 1e-9:
        return (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)), 0.0
    return (cx / (6 * A), cy / (6 * A)), abs(A)


_CELLS = None


def shatter_cells():
    """沃罗诺伊碎裂：返回 [(多边形, 质心, 面积, 是否飞出, 到中心距离)]，确定性。"""
    global _CELLS
    if _CELLS is not None:
        return _CELLS
    import random
    r = random.Random(21)
    cx, cy = SHATTER_C
    seeds = [(cx + r.uniform(-6, 6), cy + r.uniform(-6, 6))]
    while len(seeds) < 78:
        rad = SHATTER_R * 1.1 * r.random() ** 0.85
        a = r.uniform(0, math.tau)
        # 沿径向拉长：冲击碎片是放射状的
        seeds.append((cx + math.cos(a) * rad, cy + math.sin(a) * rad * 0.92))
    circle = [(cx + math.cos(i / 40 * math.tau) * SHATTER_R, cy + math.sin(i / 40 * math.tau) * SHATTER_R)
              for i in range(40)]
    cells = []
    for i, sd in enumerate(seeds):
        poly = list(circle)
        for j, ot in enumerate(seeds):
            if i == j:
                continue
            a, b = ot[0] - sd[0], ot[1] - sd[1]
            mx, my = (sd[0] + ot[0]) / 2, (sd[1] + ot[1]) / 2
            poly = _clip(poly, a, b, a * mx + b * my)
            if len(poly) < 3:
                break
        if len(poly) < 3:
            continue
        cen, area = _centroid(poly)
        dist = math.hypot(cen[0] - cx, cen[1] - cy)
        cells.append((poly, cen, area, dist < EJECT_R, dist))
    _CELLS = cells
    return cells


def radial_cracks():
    """从碎裂区向外延伸的长裂纹（折线），确定性。"""
    import random
    r = random.Random(5)
    cx, cy = SHATTER_C
    out = []
    for i in range(11):
        a = i / 11 * math.tau + r.uniform(-0.2, 0.2)
        rad = r.uniform(70, 120)
        x, y = cx + math.cos(a) * rad, cy + math.sin(a) * rad
        pts = [(x, y)]
        L = r.uniform(110, 260)
        steps = 7
        for _ in range(steps):
            a += r.uniform(-0.28, 0.28)
            x += math.cos(a) * L / steps
            y += math.sin(a) * L / steps
            pts.append((x, y))
        out.append(pts)
    return out


def knock_cracks(k):
    """第 k 次敲击留下的小裂纹（k=0,1），以 Clawd 的头部为中心。"""
    import random
    r = random.Random(40 + k)
    cx, cy = SHATTER_C[0] + (-14 if k == 0 else 10), SHATTER_C[1] - 6
    n = 5 if k == 0 else 9
    L0, L1 = (12, 34) if k == 0 else (28, 80)
    out = []
    for i in range(n):
        a = i / n * math.tau + r.uniform(-0.3, 0.3)
        L = r.uniform(L0, L1)
        pts = [(cx, cy)]
        x, y = cx, cy
        for _ in range(4):
            a += r.uniform(-0.3, 0.3)
            x += math.cos(a) * L / 4
            y += math.sin(a) * L / 4
            pts.append((x, y))
        out.append(pts)
    return (cx, cy), out
