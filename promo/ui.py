"""逐帧画出界面贴图（PIL）。

python ui.py            渲染全部帧（多进程，相同的帧用硬链接）
python ui.py 15.6 30.2  只画这几个时刻，存成预览图
"""
import hashlib
import math
import os
import sys
from multiprocessing import Pool

from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from timeline import *  # noqa

S = TEX_SCALE
FONT_DIR = r"C:\Windows\Fonts"
_fonts = {}

# 深色主题
C_BG = (14, 15, 19)
C_PANEL = (24, 26, 32)
C_HEAD = (30, 33, 40)
C_FIELD = (17, 19, 24)
C_BORDER = (46, 52, 66)
C_TEXT = (232, 234, 238)
C_DIM = (139, 145, 158)
C_FAINT = (84, 90, 104)
C_ORANGE = (217, 119, 87)
C_ORANGE_HI = (255, 160, 110)
C_BLUE = (76, 141, 255)
C_GREEN = (62, 207, 142)
C_AMBER = (240, 180, 41)
C_RED = (240, 90, 90)


def font(size, bold=False, mono=False):
    key = (size, bold, mono)
    if key not in _fonts:
        if mono:
            f = ImageFont.truetype(os.path.join(FONT_DIR, "consolab.ttf" if bold else "consola.ttf"), int(size * S))
        else:
            f = ImageFont.truetype(os.path.join(FONT_DIR, "msyhbd.ttc" if bold else "msyh.ttc"), int(size * S))
        _fonts[key] = f
    return _fonts[key]


def clamp01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def ease_out(x):
    x = clamp01(x)
    return 1 - (1 - x) ** 3


def ease_out_back(x, k=1.7):
    x = clamp01(x)
    return 1 + (k + 1) * (x - 1) ** 3 + k * (x - 1) ** 2


def mix(a, b, s):
    s = clamp01(s)
    return tuple(int(round(a[i] + (b[i] - a[i]) * s)) for i in range(len(a)))


def pulse(t, t0, dur=0.35):
    """按下高亮：t0 时为 1，之后衰减。"""
    if t < t0 - 0.04:
        return 0.0
    if t < t0:
        return (t - t0 + 0.04) / 0.04
    return max(0.0, 1 - (t - t0) / dur)


class Canvas:
    def __init__(self, w, h, bg=C_BG):
        self.img = Image.new("RGB", (int(w * S), int(h * S)), bg)
        self.d = ImageDraw.Draw(self.img)

    def rect(self, r, fill=None, radius=0, outline=None, width=1):
        x0, y0, x1, y1 = r
        self.d.rounded_rectangle([x0 * S, y0 * S, x1 * S - 1, y1 * S - 1], radius=radius * S,
                                 fill=fill, outline=outline, width=max(1, int(width * S)))

    def text(self, x, y, s, size=18, color=C_TEXT, bold=False, mono=False, anchor="lm"):
        self.d.text((x * S, y * S), s, font=font(size, bold, mono), fill=color, anchor=anchor)

    def tw(self, s, size=18, bold=False, mono=False):
        return self.d.textlength(s, font=font(size, bold, mono)) / S

    def line(self, pts, color, width=2):
        self.d.line([(x * S, y * S) for x, y in pts], fill=color, width=max(1, int(width * S)), joint="curve")

    def circle(self, x, y, r, fill=None, outline=None, width=1):
        self.d.ellipse([(x - r) * S, (y - r) * S, (x + r) * S, (y + r) * S], fill=fill, outline=outline,
                       width=max(1, int(width * S)))

    def glow(self, r, color, radius=14, strength=1.0, rr=10):
        """在矩形周围画一圈柔光（先模糊再相加）。"""
        pad = radius * 3
        x0, y0, x1, y1 = r
        box = (int((x0 - pad) * S), int((y0 - pad) * S), int((x1 + pad) * S), int((y1 + pad) * S))
        w, h = box[2] - box[0], box[3] - box[1]
        layer = Image.new("RGB", (w, h), (0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle([pad * S, pad * S, w - pad * S, h - pad * S], radius=rr * S,
                                                fill=tuple(int(c * strength) for c in color))
        layer = layer.filter(ImageFilter.GaussianBlur(radius * S))
        self.add(layer, box[0], box[1])

    def add(self, layer, x, y):
        from PIL import ImageChops
        bx0, by0 = max(0, x), max(0, y)
        bx1, by1 = min(self.img.width, x + layer.width), min(self.img.height, y + layer.height)
        if bx1 <= bx0 or by1 <= by0:
            return
        crop = layer.crop((bx0 - x, by0 - y, bx1 - x, by1 - y))
        base = self.img.crop((bx0, by0, bx1, by1))
        self.img.paste(ImageChops.add(base, crop), (bx0, by0))

    def wrap(self, s, size, width, bold=False):
        lines, cur = [], ""
        for ch in s:
            if self.tw(cur + ch, size, bold) > width and ch not in "，。、；：？！）":
                lines.append(cur)
                cur = ch
            else:
                cur += ch
        if cur:
            lines.append(cur)
        return lines


# ---------------------------------------------------------------- 小部件
def panel(c, r, title=None, active=0.0):
    c.rect(r, fill=C_PANEL, radius=10, outline=mix(C_BORDER, C_BLUE, active), width=2 if active > 0.3 else 1.5)
    if title:
        c.text(r[0] + 18, r[1] + 26, title, 17, C_TEXT, bold=True)


def chip(c, r, label, dot=None, hi=0.0, fill=C_HEAD, color=C_TEXT, size=15):
    if hi > 0:
        c.glow(r, C_ORANGE, radius=8, strength=0.6 * hi, rr=18)
    c.rect(r, fill=mix(fill, (60, 45, 40), hi), radius=(r[3] - r[1]) / 2,
           outline=mix(C_BORDER, C_ORANGE_HI, hi), width=1.5)
    x = r[0] + 16
    if dot:
        c.circle(x + 4, (r[1] + r[3]) / 2, 5, fill=dot)
        x += 16
    c.text(x, (r[1] + r[3]) / 2, label, size, color)


def button(c, r, label, primary=False, press=0.0, size=16, color=None):
    base = C_ORANGE if primary else (44, 48, 58)
    fill = mix(base, (255, 214, 170) if primary else (90, 98, 118), press)
    if press > 0:
        c.glow(r, C_ORANGE if primary else C_BLUE, radius=10, strength=0.9 * press)
    c.rect(r, fill=fill, radius=8, outline=mix(base, (255, 255, 255), 0.25 + 0.5 * press), width=1.2)
    c.text((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, label, size,
           color or ((30, 16, 10) if primary else C_TEXT), bold=primary, anchor="mm")


def clawd_2d(c, cx, cy, w, color=C_ORANGE, eyes=(10, 8, 6), flat=False):
    """正面 Clawd：12x8 的身体，两侧小手，四条短腿，两条竖眼缝。flat=True 时单色，和 3D 自发光卡片一致。"""
    u = w / 12
    body = (cx - 6 * u, cy - 5 * u, cx + 6 * u, cy + 3 * u)
    dark = color if flat else mix(color, (0, 0, 0), 0.25)
    for lx in (-4.6, -2.6, 1.4, 3.4):
        c.rect((cx + lx * u, cy + 2.5 * u, cx + (lx + 1.2) * u, cy + 5 * u), fill=dark, radius=u * 0.3)
    c.rect((cx - 7.6 * u, cy - 1.8 * u, cx - 5.5 * u, cy + 0.2 * u), fill=dark, radius=u * 0.4)
    c.rect((cx + 5.5 * u, cy - 1.8 * u, cx + 7.6 * u, cy + 0.2 * u), fill=dark, radius=u * 0.4)
    c.rect(body, fill=color, radius=u * 1.2)
    if not flat:
        c.rect((body[0], body[1], body[2], body[1] + 1.4 * u), fill=mix(color, (255, 255, 255), 0.12), radius=u * 1.2)
    for ex in (-3.5, 2.5):
        c.rect((cx + ex * u, cy - 3.2 * u, cx + (ex + 1) * u, cy - 1.0 * u), fill=eyes, radius=u * 0.3)


def spinner(c, x, y, t, r=8, color=C_BLUE):
    a0 = (t * 540) % 360
    c.d.arc([(x - r) * S, (y - r) * S, (x + r) * S, (y + r) * S], a0, a0 + 260, fill=color, width=int(2.4 * S))


def check(c, x, y, color=C_GREEN, s=1.0):
    c.line([(x - 7 * s, y), (x - 2 * s, y + 5 * s), (x + 8 * s, y - 6 * s)], color, 3 * s)


# ---------------------------------------------------------------- 主界面
def draw_main(t):
    c = Canvas(UI_W, UI_H)
    sent = t >= T["send"]

    # ---- 顶栏
    panel(c, MAIN_PANELS["TOP"])
    lg = pulse(t, T["logo"], 0.8)
    c.rect((LOGO[0] + 6, 22, LOGO[0] + 30, 46), fill=mix(C_ORANGE, C_ORANGE_HI, lg), radius=6)
    if lg > 0:
        c.glow((LOGO[0] + 6, 22, LOGO[0] + 30, 46), C_ORANGE, 10, lg)
    c.text(LOGO[0] + 42, 34, "Personal Agent", 19, C_TEXT, bold=True)
    c.text(LOGO[0] + 210, 35, "~/PersonalAgent/workspace", 13, C_FAINT, mono=True)

    def tip_hi(name):
        for n, t0, _, _ in TIPS:
            if n == name and t0 - 0.05 <= t <= t0 + TIP_DUR:
                return max(pulse(t, t0, 0.6), 0.55)
        return 0.0

    chip(c, CHIP_HFSS, "HFSS：已连接 · 7 个工具", dot=C_GREEN, hi=tip_hi("hfss"))
    mem_hi = max(tip_hi("mem"), 0.7 * pulse(t, T["memory"], 1.0))
    chip(c, CHIP_MEM, "记忆：在线", dot=C_GREEN, hi=mem_hi)
    if t < T["save"]:
        chip(c, CHIP_MODEL, "未设置模型", dot=C_AMBER, color=C_AMBER)
    else:
        chip(c, CHIP_MODEL, "DeepSeek · deepseek-flash", dot=C_BLUE,
             hi=max(tip_hi("model"), pulse(t, T["save"] + 0.3, 1.2)))
    sp = pulse(t, T["settings_press"], 0.5)
    button(c, BTN_SETTINGS, "模型设置", press=sp, size=15)

    # ---- 侧栏
    panel(c, MAIN_PANELS["SIDE"])
    button(c, BTN_NEW, "+  新建会话", size=15)
    c.text(28, 154, "今天", 13, C_FAINT)
    items = [("DR 滤波器 7.86 GHz" if sent else "新会话", True), ("贴片天线 2.4 GHz 扫参", False),
             ("喇叭天线远场方向图", False)]
    y = 186
    for name, act in items:
        if act:
            c.rect((18, y - 20, 282, y + 20), fill=(40, 44, 56), radius=8)
            c.rect((18, y - 20, 22, y + 20), fill=C_ORANGE, radius=2)
        c.text(34, y, name, 15, C_TEXT if act else C_DIM)
        y += 46
    c.text(28, y + 4, "本周", 13, C_FAINT)
    y += 36
    for name in ["微带线阻抗匹配", "Wilkinson 功分器", "dr6g 粗网格验证", "Hindsight 中文记忆调参"]:
        c.text(34, y, name, 15, C_DIM)
        y += 46
    sb = tip_hi("sandbox")
    if sb:
        c.glow(SANDBOX, C_GREEN, 8, 0.5 * sb)
    c.rect(SANDBOX, fill=mix(C_HEAD, (30, 60, 48), sb), radius=8, outline=mix(C_BORDER, C_GREEN, sb))
    # 小盾牌
    sx, sy = SANDBOX[0] + 22, (SANDBOX[1] + SANDBOX[3]) / 2
    c.d.polygon([((sx - 8) * S, (sy - 9) * S), ((sx + 8) * S, (sy - 9) * S), ((sx + 8) * S, (sy + 1) * S),
                 (sx * S, (sy + 10) * S), ((sx - 8) * S, (sy + 1) * S)], fill=C_GREEN)
    c.text(SANDBOX[0] + 42, sy, "沙箱：已启用 · 断网", 15, C_TEXT)

    # ---- 聊天
    chat_active = 1.0 if T["type_start"] <= t < T["send"] + 0.3 else 0.0
    panel(c, MAIN_PANELS["CHAT"], active=chat_active)
    c.rect((300, 68, 1096, 116), fill=C_HEAD, radius=10)
    c.rect((300, 100, 1096, 116), fill=C_HEAD)
    c.text(322, 92, "DR 滤波器 7.86 GHz" if sent else "新会话", 17, C_TEXT, bold=True)
    c.text(1076, 92, "HFSS 工具 7 · 记忆 在线", 13, C_FAINT, anchor="rm")

    # 欢迎页 + 平面 Clawd + 碎屏
    wfade = 1 - clamp01((t - T["send"]) / 0.25)
    if t >= T["welcome"] and wfade > 0:
        a = ease_out((t - T["welcome"]) / 0.4) * wfade
        cx, cy = WELCOME_C
        c.text(cx, 520, "你好，我是你的 HFSS 助手", 26, mix(C_PANEL, C_TEXT, a), bold=True, anchor="mm")
        c.text(cx, 562, "建模 · 仿真 · 扫参 · 读结果，说一句就行", 17, mix(C_PANEL, C_DIM, a), anchor="mm")
        if t < T["peel"] + 0.3:
            sel = a * (1 - clamp01((t - T["peel"]) / 0.3))
            bump = sum(max(0.0, 1 - abs(t - k) / 0.1) for k in T["knocks"])
            w = CLAWD_W_PX
            box = (cx - w * 0.68, cy - w * 0.48, cx + w * 0.68, cy + w * 0.47)
            c.rect(box, outline=mix(C_PANEL, C_BLUE, sel), width=1.5)
            for hx in (box[0], (box[0] + box[2]) / 2, box[2]):
                for hy in (box[1], (box[1] + box[3]) / 2, box[3]):
                    if hx == (box[0] + box[2]) / 2 and hy == (box[1] + box[3]) / 2:
                        continue
                    c.rect((hx - 5, hy - 5, hx + 5, hy + 5), fill=mix(C_PANEL, C_BLUE, sel))
            if t < T["peel"]:
                # 敲击时整张贴图往上一顶
                clawd_2d(c, cx, cy - 3 * bump, w * (1 + 0.035 * bump), color=mix(C_PANEL, C_ORANGE, a), flat=True)
        draw_damage(c, t, wfade)

    # 输入框
    c.rect(INPUT, fill=C_FIELD, radius=12, outline=mix(C_BORDER, C_ORANGE, chat_active * 0.8), width=1.5)
    typed = ""
    if T["type_start"] <= t < T["send"]:
        n = int(len(USER_TEXT) * clamp01((t - T["type_start"]) / (T["type_end"] - T["type_start"])) + 0.999)
        typed = USER_TEXT[:n]
    if typed:
        lines = c.wrap(typed, 19, 620)
        for i, ln in enumerate(lines):
            c.text(340, 990 + i * 30, ln, 19, C_TEXT)
        if (t * 2) % 1 < 0.6:
            lx = 340 + c.tw(lines[-1], 19)
            c.rect((lx + 2, 978 + (len(lines) - 1) * 30, lx + 4, 1002 + (len(lines) - 1) * 30), fill=C_ORANGE)
    else:
        c.text(340, 990, "描述你的 HFSS 任务…", 19, C_FAINT)
    button(c, BTN_SEND, "发送", primary=True, press=pulse(t, T["send"], 0.5), size=17)

    # 用户气泡
    if sent:
        k = ease_out((t - T["send"]) / 0.25)
        dy = (1 - k) * 30
        lines = c.wrap(USER_TEXT, 18, 500)
        w = max(c.tw(ln, 18) for ln in lines) + 36
        r = (1076 - w, USER_BUBBLE[1] + dy, 1076, USER_BUBBLE[1] + 22 + 30 * len(lines) + dy)
        c.rect(r, fill=mix(C_PANEL, (58, 44, 40), k), radius=14)
        for i, ln in enumerate(lines):
            c.text(r[0] + 18, r[1] + 26 + 30 * i, ln, 18, mix(C_PANEL, C_TEXT, k))

    # 记忆卡片
    if t >= T["memory"] - 0.5:
        k = ease_out((t - (T["memory"] - 0.5)) / 0.25)
        land = pulse(t, T["memory"], 0.8)
        r = MEM_CARD
        if land:
            c.glow(r, C_GREEN, 10, 0.5 * land)
        c.rect(r, fill=mix(C_PANEL, (24, 38, 34), k), radius=10, outline=mix(C_PANEL, mix(C_BORDER, C_GREEN, 0.5 + 0.5 * land), k))
        title = "记忆 · 召回 3 条" if t >= T["memory"] else "记忆 · 正在召回…"
        c.text(r[0] + 18, r[1] + 24, title, 15, mix(C_PANEL, C_GREEN, k), bold=True)
        if t < T["memory"]:
            spinner(c, r[2] - 26, r[1] + 24, t, 7, C_GREEN)
        for i, it in enumerate(MEM_ITEMS):
            ti = T["memory"] + 0.25 * (i + 1)
            if t >= ti:
                a = ease_out((t - ti) / 0.2)
                y = r[1] + 58 + 28 * i
                check(c, r[0] + 30, y, mix(C_PANEL, C_GREEN, a), 0.8)
                c.text(r[0] + 48 + (1 - a) * 12, y, it, 15, mix(C_PANEL, C_TEXT, a))

    # 回复
    if t >= T["reply_start"]:
        n = int(len(REPLY_TEXT) * clamp01((t - T["reply_start"]) / (T["reply_end"] - T["reply_start"])) + 0.999)
        c.rect((320, REPLY_Y - 2, 344, REPLY_Y + 22), fill=C_ORANGE, radius=6)
        lines = c.wrap(REPLY_TEXT[:n], 18, 700)
        for i, ln in enumerate(lines):
            c.text(358, REPLY_Y + 10 + 30 * i, ln, 18, C_TEXT)

    def tool_card(r, name, state, t_show, hi=0.0):
        k = ease_out((t - t_show) / 0.2)
        if hi:
            c.glow(r, C_BLUE, 8, 0.6 * hi)
        c.rect(r, fill=mix(C_PANEL, C_FIELD, k), radius=8, outline=mix(C_PANEL, mix(C_BORDER, C_BLUE, hi), k))
        cy = (r[1] + r[3]) / 2
        c.rect((r[0] + 14, cy - 8, r[0] + 30, cy + 8), outline=mix(C_PANEL, C_BLUE, k), radius=4, width=2)
        c.rect((r[0] + 19, cy - 3, r[0] + 25, cy + 3), fill=mix(C_PANEL, C_BLUE, k), radius=1)
        c.text(r[0] + 42, cy, name, 15, mix(C_PANEL, C_TEXT, k), mono=True)
        label, col, spin = state
        if spin:
            spinner(c, r[2] - 150, cy, t, 7, col)
        elif col == C_GREEN:
            check(c, r[2] - 150, cy, col, 0.8)
        c.text(r[2] - 134, cy, label, 14, mix(C_PANEL, col, k))

    if t >= T["tool1_show"]:
        st = ("运行中…", C_BLUE, True) if t < T["tool1_done"] else ("完成 · 0.8 s", C_GREEN, False)
        tool_card(TOOL1, "hfss__build_dr_filter", st, T["tool1_show"], pulse(t, T["tool1_done"], 0.6))
    if t >= T["dialog_open"]:
        st = ("等待批准…", C_AMBER, False) if t < T["allow"] else ("已批准 · 3 个任务", C_GREEN, False)
        tool_card(TOOL2, "hfss__submit_simulation", st, T["dialog_open"], pulse(t, T["allow"], 0.6))

    # 结果卡片
    if t >= T["result"]:
        k = ease_out_back((t - T["result"]) / 0.35)
        fl = pulse(t, T["result"], 1.2)
        r = RESULT_CARD
        r2 = (r[0], r[1] + (1 - k) * 40, r[2], r[3] + (1 - k) * 40)
        c.glow(r2, C_ORANGE, 16, 0.25 + 0.8 * fl)
        c.rect(r2, fill=(34, 28, 26), radius=12, outline=mix(C_ORANGE, (255, 230, 200), fl), width=2)
        check(c, r2[0] + 30, r2[1] + 30, C_GREEN, 1.0)
        c.text(r2[0] + 50, r2[1] + 30, "仿真完成 · fine 网格已收敛", 18, C_TEXT, bold=True)
        cols = [("中心频率 f0", "7862.5", "MHz"), ("插损", "0.56", "dB"), ("3 dB 带宽", "14.6", "MHz")]
        for i, (lab, val, unit) in enumerate(cols):
            x = r2[0] + 30 + i * 236
            c.text(x, r2[1] + 70, lab, 14, C_DIM)
            c.text(x, r2[1] + 108, val, 34, mix(C_ORANGE_HI, (255, 240, 220), fl), bold=True)
            c.text(x + c.tw(val, 34, True) + 8, r2[1] + 114, unit, 15, C_DIM)
        c.text(r2[0] + 30, r2[1] + 146, "数字都来自已收敛的任务 · 14578 个网格", 13, C_FAINT)

    # ---- 模型视图
    panel(c, MAIN_PANELS["MODEL"], "模型 · dr_filter.aedt", active=pulse(t, T["model_spin"], 1.5))
    c.text(1892, 94, "介质谐振器 εr 45 · 两腔", 13, C_FAINT, anchor="rm")
    c.rect(VIEWPORT, fill=(12, 14, 18), radius=8)
    draw_filter(c, t)

    # ---- 任务
    panel(c, MAIN_PANELS["JOBS"], "仿真任务", active=1.0 if T["jobs_start"] <= t < T["job_done"][2] + 0.4 else 0.0)
    c.text(1892, 486, "并行 3 · 16 核 · 64 GB", 13, C_FAINT, anchor="rm")
    if t < T["jobs_start"]:
        c.text(1508, 590, "暂无任务", 16, C_FAINT, anchor="mm")
    else:
        for i, (name, res) in enumerate(JOBS):
            y = JOB_ROWS_Y[i]
            td = T["job_done"][i]
            k = ease_out((t - T["jobs_start"] - 0.1 * i) / 0.25)
            col = mix(C_PANEL, C_TEXT, k)
            c.text(1124, y, name, 15, col)
            rate = (0.42, 0.33, 0.27)[i]
            p = min(0.9, (t - T["jobs_start"]) * rate)
            if t >= td:
                p = p + (1 - p) * ease_out((t - td) / 0.15)
            x0, x1 = JOB_BAR_X
            c.rect((x0, y - 5, x1, y + 5), fill=mix(C_PANEL, (40, 44, 54), k), radius=5)
            done = t >= td
            bc = C_GREEN if done else C_BLUE
            fl = pulse(t, td, 0.7)
            if fl:
                c.glow((x0, y - 5, x1, y + 5), C_GREEN, 8, fl)
            c.rect((x0, y - 5, x0 + max(10, (x1 - x0) * p * k), y + 5), fill=mix(bc, (220, 255, 235), fl), radius=5)
            if done:
                check(c, 1782, y, C_GREEN, 0.8)
                c.text(1796, y, "已收敛", 14, C_GREEN)
            else:
                spinner(c, 1782, y, t + i * 0.3, 6, C_BLUE)
                c.text(1796, y, "%d%%" % int(p * 100), 14, C_DIM)

    # ---- S 参数
    panel(c, MAIN_PANELS["PLOT"], "S 参数 · dB", active=1.0 if SURF[0] - 0.3 <= t < T["marker"] + 0.6 else 0.0)
    c.line([(1700, 724), (1726, 724)], C_ORANGE, 3)
    c.text(1734, 724, "S21", 14, C_DIM)
    c.line([(1786, 724), (1812, 724)], C_BLUE, 3)
    c.text(1820, 724, "S11", 14, C_DIM)
    draw_plot(c, t)
    return c.img


C_CRACK = (205, 216, 238)


def draw_damage(c, t, fade):
    """敲击的小裂纹，以及 pop 时的碎屏：沃罗诺伊裂纹、掉出去的碎块留下的洞、漏墨、彩色坏线。"""
    from PIL import ImageChops
    import random as _r
    if t < T["knocks"][0] or fade <= 0:
        return
    cx, cy = SHATTER_C
    R = SHATTER_R + 120
    box = (int((cx - R) * S), int((cy - R) * S), int((cx + R) * S), int((cy + R) * S))
    W, H = box[2] - box[0], box[3] - box[1]

    def P(x, y):
        return ((x - cx + R) * S, (y - cy + R) * S)

    lines = Image.new("L", (W, H), 0)          # 裂纹亮线
    ld = ImageDraw.Draw(lines)
    dark = Image.new("L", (W, H), 0)           # 变黑的区域（洞 + 漏墨）
    dd = ImageDraw.Draw(dark)

    def seg(pts, val, width):
        ld.line([P(*p) for p in pts], fill=int(255 * clamp01(val)), width=max(1, int(width * S)), joint="curve")

    for k, tk in enumerate(T["knocks"]):
        if t < tk:
            continue
        (kx, ky), cr = knock_cracks(k)
        g = ease_out((t - tk) / 0.05)
        for pts in cr:
            n = max(2, int(len(pts) * g + 0.999))
            for i in range(n - 1):
                seg(pts[i:i + 2], 0.85 * (1 - i / len(pts) * 0.6), 1.3)
        fl = pulse(t, tk, 0.15)
        if fl:
            ld.ellipse([P(kx - 5, ky - 5), P(kx + 5, ky + 5)], fill=int(110 * fl))

    if t >= T["pop"]:
        g = ease_out((t - T["pop"]) / 0.07)
        cells = shatter_cells()
        for poly, cen, area, ej, dist in cells:
            n = len(poly)
            for i in range(n):
                p, q = poly[i], poly[(i + 1) % n]
                rp = math.hypot(p[0] - cx, p[1] - cy)
                rq = math.hypot(q[0] - cx, q[1] - cy)
                if rp > SHATTER_R - 1 and rq > SHATTER_R - 1:
                    continue                    # 外圈的人为边界不画
                rm = (rp + rq) / 2
                if rm > SHATTER_R * g + 10:
                    continue
                # 真的玻璃以放射状裂纹为主：远处只留顺着半径方向的边
                ex, ey = q[0] - p[0], q[1] - p[1]
                mx, my = (p[0] + q[0]) / 2 - cx, (p[1] + q[1]) / 2 - cy
                al = abs(ex * mx + ey * my) / (math.hypot(ex, ey) * math.hypot(mx, my) + 1e-6)
                h = (int(p[0] * 7 + q[0] * 13 + p[1] * 3 + q[1] * 5) % 100) / 100
                if not ej and rm > EJECT_R * 1.25:
                    if al < 0.55 and h > 0.15:
                        continue
                    if al >= 0.55 and h > 0.75:
                        continue
                val = (1 - (rm / SHATTER_R) ** 1.6) * (1.0 if ej else 0.75)
                seg([p, q], val, 1.5 if ej else 1.1)
            if ej:
                dd.polygon([P(*pp) for pp in poly], fill=255)
        for pts in radial_cracks():
            n = max(2, int(len(pts) * ease_out((t - T["pop"]) / 0.12) + 0.999))
            for i in range(n - 1):
                seg(pts[i:i + 2], 0.7 * (1 - i / len(pts)), 1.2)
        # 漏墨：洞的边缘往外渗，0.6 s 内慢慢长大
        ink = ease_out((t - T["pop"]) / 0.6)
        rr = _r.Random(13)
        for i in range(9):
            a = rr.uniform(0, math.tau)
            d = rr.uniform(EJECT_R * 0.6, EJECT_R * 1.15)
            bx, by = cx + math.cos(a) * d, cy + math.sin(a) * d
            rad = rr.uniform(14, 38) * (0.4 + 0.6 * ink)
            dd.ellipse([P(bx - rad, by - rad * 0.8), P(bx + rad, by + rad * 0.8)], fill=200)
        dark = dark.filter(ImageFilter.GaussianBlur(5 * S))
        # 洞本身保持锐利的边
        sharp = Image.new("L", (W, H), 0)
        sd = ImageDraw.Draw(sharp)
        for poly, cen, area, ej, dist in cells:
            if ej:
                sd.polygon([P(*pp) for pp in poly], fill=255)
        dark = ImageChops.lighter(dark, sharp)

    region = c.img.crop(box)
    if t >= T["pop"]:
        black = Image.new("RGB", (W, H), (5, 6, 8))
        m = dark.point(lambda v: int(v * fade))
        region = Image.composite(black, region, m)
    glow = lines.filter(ImageFilter.GaussianBlur(3 * S)).point(lambda v: int(v * 0.55 * fade))
    lit = Image.merge("RGB", [lines.point(lambda v, k=k: int(v * k / 255 * fade)) for k in C_CRACK])
    gl = Image.merge("RGB", [glow.point(lambda v, k=k: int(v * k / 255)) for k in (150, 180, 255)])
    region = ImageChops.add(region, ImageChops.add(lit, gl))
    c.img.paste(region, box[:2])

    if t >= T["pop"]:
        # 彩色坏线：从上到下贯穿聊天面板，逐帧闪烁
        f = int(round(t * FPS))
        rr = _r.Random(9)
        cols = [(255, 40, 190), (40, 255, 150), (90, 150, 255), (255, 255, 255), (255, 200, 40)]
        for i in range(5):
            x = cx + rr.uniform(-80, 80)
            w = rr.choice([1, 1.5, 2.5])
            col = cols[i]
            if (f * 7 + i * 3) % 11 == 0:
                continue
            a = 0.75 * fade * (0.7 + 0.3 * ((f + i) % 3) / 2)
            c.line([(x, 118), (x, 948)], mix(C_PANEL, col, a), w)
        y = cy + rr.uniform(-40, 40)
        if f % 4 != 1:
            c.line([(304, y), (1092, y)], mix(C_PANEL, (120, 200, 255), 0.5 * fade), 1.2)
        fl = pulse(t, T["pop"], 0.16)
        if fl:
            c.glow((cx - 30, cy - 30, cx + 30, cy + 30), (220, 235, 255), 22, 0.55 * fl, rr=30)


def draw_filter(c, t):
    if t < T["model_draw"]:
        c.text(1508, 274, "还没有模型", 16, C_FAINT, anchor="mm")
        return
    reveal = ease_out((t - T["model_draw"]) / 1.2)
    spin = ease_out((t - T["model_spin"]) / 1.3) if t >= T["model_spin"] else 0.0
    yaw = math.radians(-35 + 360 * spin + 6 * math.sin(t * 0.6))
    pitch = math.radians(28)
    cx, cy, sc = 1508, 290, 7.6

    def P(x, y, z):
        xr = x * math.cos(yaw) - y * math.sin(yaw)
        yr = x * math.sin(yaw) + y * math.cos(yaw)
        return (cx + xr * sc, cy - (z * math.cos(pitch) - yr * math.sin(pitch)) * sc)

    segs = []
    L, Wd, H = 22, 11, 8
    corners = [(x, y, z) for x in (-L, L) for y in (-Wd, Wd) for z in (-H, H)]
    for a in corners:
        for b in corners:
            if a < b and sum(1 for i in range(3) if a[i] != b[i]) == 1:
                segs.append((a, b, (110, 130, 160), 1.6))
    # 中间的耦合窗
    for y0, y1 in ((-Wd, -3), (3, Wd)):
        for z in (-H, H):
            segs.append(((0, y0, z), (0, y1, z), (90, 110, 140), 1.2))
        segs.append(((0, y0, -H), (0, y0, H), (90, 110, 140), 1.2))
        segs.append(((0, y1, -H), (0, y1, H), (90, 110, 140), 1.2))
    # 两个介质谐振器（圆柱）
    for px in (-11, 11):
        n = 28
        for zz in (-1.0, 3.5):
            pts = [(px + 6 * math.cos(i / n * math.tau), 6 * math.sin(i / n * math.tau), zz) for i in range(n + 1)]
            for i in range(n):
                segs.append((pts[i], pts[i + 1], C_ORANGE, 2.2))
        for i in range(0, 28, 7):
            a = i / 28 * math.tau
            segs.append(((px + 6 * math.cos(a), 6 * math.sin(a), -1), (px + 6 * math.cos(a), 6 * math.sin(a), 3.5), C_ORANGE, 2.0))
        segs.append(((px, 0, -H), (px, 0, -1), (150, 150, 160), 1.2))
    # 两个同轴探针
    for px in (-L, L):
        segs.append(((px, 0, -2), (px * 1.25, 0, -2), C_BLUE, 3))
        segs.append(((px, 0, -2), (px * 0.9, 0, -2), C_BLUE, 2))
    n = len(segs)
    shown = int(n * reveal)
    for i, (a, b, col, w) in enumerate(segs[:shown]):
        c.line([P(*a), P(*b)], col, w)
    if t >= T["model_spin"]:
        k = ease_out((t - T["model_spin"] - 0.9) / 0.5)
        if k > 0:
            c.text(1140, 420, "网格 fine · 14578 个四面体", 14, mix((12, 14, 18), C_GREEN, k))
    c.text(1880, 420, "端口 1 · 端口 2", 13, C_FAINT, anchor="rm")


def draw_plot(c, t):
    g = GRAPH
    for db in range(0, -41, -10):
        y = db_to_y(db)
        c.line([(g[0], y), (g[2], y)], (40, 44, 54), 1)
        c.text(g[0] - 10, y, str(db), 13, C_FAINT, anchor="rm")
    f = F_MIN
    while f <= F_MAX + 0.001:
        x = f_to_x(f)
        c.line([(x, g[1]), (x, g[3])], (36, 40, 50), 1)
        c.text(x, g[3] + 20, "%.2f" % f, 13, C_FAINT, anchor="mm")
        f += 0.01
    c.text(g[2], g[3] + 20, "GHz", 13, C_FAINT, anchor="rm")
    if t < SURF[0] - 0.6:
        c.text((g[0] + g[2]) / 2, (g[1] + g[3]) / 2, "等待仿真结果…", 16, C_FAINT, anchor="mm")
        return
    xc = cursor_x(t) if t < SURF[1] + 0.01 else g[2]
    n = 360
    p21, p11 = [], []
    for i in range(n + 1):
        f = F_MIN + (F_MAX - F_MIN) * i / n
        x = f_to_x(f)
        if x > xc:
            break
        p21.append((x, db_to_y(max(s21_db(f), DB_MIN))))
        p11.append((x, db_to_y(max(s11_db(f), DB_MIN))))
    if len(p21) > 1:
        c.line(p11, C_BLUE, 2.4)
        c.line(p21, C_ORANGE_HI, 3.2)
    if t < T["marker"] - 0.8:
        # 频率光标
        a = ease_out((t - (SURF[0] - 0.6)) / 0.3)
        c.line([(xc, g[1] - 6), (xc, g[3])], mix(C_PANEL, (210, 230, 255), a), 2)
        c.rect((xc - 12, g[3] - 2, xc + 12, g[3] + 10), fill=mix(C_PANEL, (210, 230, 255), a), radius=4)
        f = F_MIN + (xc - g[0]) / (g[2] - g[0]) * (F_MAX - F_MIN)
        lab = "%.4f GHz   S21 %.2f dB" % (f, s21_db(f))
        w = c.tw(lab, 14, mono=True) + 20
        bx = min(max(xc - w / 2, g[0]), g[2] - w)
        c.rect((bx, g[1] - 4, bx + w, g[1] + 24), fill=mix(C_PANEL, (36, 42, 58), a), radius=6)
        c.text(bx + 10, g[1] + 10, lab, 14, mix(C_PANEL, C_TEXT, a), mono=True)
    if t >= T["marker"] - 0.2:
        k = ease_out_back((t - T["marker"] + 0.2) / 0.3)
        fl = pulse(t, T["marker"], 1.0)
        x0 = f_to_x(F0)
        y0 = db_to_y(-IL)
        # -3 dB 带宽
        y3 = db_to_y(-3 - IL)
        xl, xr = f_to_x(F0 - BW / 2), f_to_x(F0 + BW / 2)
        c.line([(xl, y3), (xr, y3)], mix(C_PANEL, C_GREEN, k), 2)
        c.line([(xl, y3 - 8), (xl, y3 + 8)], mix(C_PANEL, C_GREEN, k), 2)
        c.line([(xr, y3 - 8), (xr, y3 + 8)], mix(C_PANEL, C_GREEN, k), 2)
        c.text(xl - 12, y3, "BW 14.6 MHz", 14, mix(C_PANEL, C_GREEN, k), anchor="rm")
        if fl:
            c.glow((x0 - 10, y0 - 10, x0 + 10, y0 + 10), C_ORANGE, 14, 1.2 * fl, rr=10)
        c.circle(x0, y0, 7 * k, fill=mix(C_ORANGE_HI, (255, 255, 255), fl))
        lab = "f0 7862.5 MHz · IL 0.56 dB"
        c.rect((x0 + 120, y0 + 14, x0 + 130 + c.tw(lab, 15) + 20, y0 + 46), fill=mix(C_PANEL, (60, 40, 34), k), radius=6)
        c.text(x0 + 140, y0 + 30, lab, 15, mix(C_PANEL, C_TEXT, k))


# ---------------------------------------------------------------- 浮起的面板
def draw_settings(t):
    W, H = SET_RECT[2] - SET_RECT[0], SET_RECT[3] - SET_RECT[1]
    c = Canvas(W, H, bg=(22, 24, 30))
    c.rect((0, 0, W, H), fill=(26, 28, 35), radius=14, outline=C_BLUE, width=2)
    c.text(32, 44, "模型设置", 22, C_TEXT, bold=True)
    saved = t >= T["save"]
    if saved:
        check(c, W - 140, 44, C_GREEN, 0.9)
        c.text(W - 124, 44, "已保存", 15, C_GREEN)
    else:
        c.text(W - 32, 44, "×", 22, C_DIM, anchor="rm")
    c.text(32, 98, "厂商", 14, C_DIM)
    picked = t >= T["pick_deepseek"]
    for i, (name, x0, x1) in enumerate(SET_CHIPS):
        sel = picked and i == 0
        hi = pulse(t, T["pick_deepseek"], 0.6) if i == 0 else 0
        r = (x0, SET_CHIP_Y[0], x1, SET_CHIP_Y[1])
        if hi:
            c.glow(r, C_ORANGE, 8, hi)
        c.rect(r, fill=mix((34, 37, 46), (70, 46, 36), 1 if sel else 0), radius=20,
               outline=C_ORANGE if sel else C_BORDER, width=2 if sel else 1)
        c.text((x0 + x1) / 2, 140, name, 15, C_ORANGE_HI if sel else C_TEXT, bold=sel, anchor="mm")

    def field(r, label, value, ly, hi=0.0, mono=True, color=C_TEXT):
        c.text(32, ly, label, 14, C_DIM)
        if hi:
            c.glow(r, C_BLUE, 8, 0.7 * hi)
        c.rect(r, fill=C_FIELD, radius=8, outline=mix(C_BORDER, C_BLUE, hi), width=1.5)
        if value:
            c.text(r[0] + 14, (r[1] + r[3]) / 2, value, 15, color, mono=mono)

    field(SET_ADDR, "接口地址", "https://api.deepseek.com" if picked else "", 190,
          pulse(t, T["pick_deepseek"] + 0.1, 0.6))
    if picked:
        c.text(728, 190, "上下文 100 万 token", 13, C_FAINT, anchor="rm")
    nkey = 0
    if t >= T["key_in"]:
        nkey = min(12, int((t - T["key_in"]) / 0.05) + 1)
    kv = "•" * max(0, nkey - 4) + ("3f9a" if nkey >= 12 else "")
    if saved:
        kv = "•••••••• 3f9a"
    field(SET_KEY, "API Key", kv, 270, pulse(t, T["key_in"], 0.9), mono=False)
    button(c, SET_GETKEY, "获取 Key", size=14)
    field(SET_MODEL, "模型", "deepseek-flash" if t >= T["list_models"] + 0.15 else "", 350,
          pulse(t, T["list_models"] + 0.15, 0.6))
    button(c, SET_LIST, "获取模型列表", press=pulse(t, T["list_models"], 0.5), size=14)
    button(c, SET_TEST, "测试连接", press=pulse(t, T["test"], 0.5), size=16)
    if T["test"] <= t < T["test_ok"]:
        spinner(c, 280, 465, t, 8)
        c.text(298, 465, "测试中…", 15, C_DIM)
    elif t >= T["test_ok"]:
        k = ease_out((t - T["test_ok"]) / 0.2)
        check(c, 278, 465, mix((26, 28, 35), C_GREEN, k), 0.9)
        c.text(294, 465, "连接成功 · 支持工具调用", 15, mix((26, 28, 35), C_GREEN, k))
    button(c, SET_SAVE, "保存", primary=True, press=pulse(t, T["save"], 0.6), size=17)
    c.text(32, 526, "Key 用 Windows DPAPI 加密保存，只发给保存时的接口地址", 13, C_FAINT)
    return c.img


def draw_dialog(t):
    W, H = DLG_RECT[2] - DLG_RECT[0], DLG_RECT[3] - DLG_RECT[1]
    c = Canvas(W, H, bg=(22, 24, 30))
    c.rect((0, 0, W, H), fill=(30, 30, 36), radius=14, outline=C_AMBER, width=2)
    c.circle(38, 40, 13, fill=C_AMBER)
    c.text(38, 40, "!", 18, (30, 20, 0), bold=True, anchor="mm")
    c.text(62, 40, "允许运行 ", 19, C_TEXT, bold=True)
    c.text(62 + c.tw("允许运行 ", 19, True), 40, "hfss__submit_simulation", 18, C_ORANGE_HI, mono=True)
    c.text(62 + c.tw("允许运行 ", 19, True) + c.tw("hfss__submit_simulation", 18, mono=True) + 4, 40, "？", 19, C_TEXT, bold=True)
    c.text(28, 86, "提交 3 个仿真任务：本征模 · 驱动模扫频 · gap 参数扫描", 15, C_TEXT)
    c.text(28, 120, "只读取工程副本，原来的 .aedt 不会被打开", 14, C_DIM)
    c.text(28, 148, "会改变东西的工具，每次都要你批准", 14, C_DIM)
    ap = pulse(t, T["allow"], 0.6)
    button(c, DLG_DENY, "拒绝", size=15)
    button(c, DLG_SESSION, "本会话内都允许", size=15)
    button(c, DLG_ALLOW, "允许", primary=True, press=ap, size=17)
    return c.img


def draw_tip(t):
    W, H = TIP_SIZE
    c = Canvas(W, H, bg=(22, 24, 30))
    cur = TIPS[0]
    for tp in TIPS:
        if t >= tp[1] - 0.3:
            cur = tp
    name, t0, _, text = cur
    col = C_GREEN if name in ("sandbox", "mem", "hfss") else C_BLUE
    c.rect((0, 0, W, H), fill=(28, 30, 38), radius=14, outline=col, width=2)
    c.rect((0, 0, 10, H), fill=col, radius=4)
    k = clamp01((t - t0) / 0.5)
    n = int(len(text) * k + 0.999)
    c.text(34, H / 2, text[:n], 21, C_TEXT, bold=True)
    return c.img


def draw_end(t):
    W, H = END_RECT[2] - END_RECT[0], END_RECT[3] - END_RECT[1]
    c = Canvas(W, H, bg=(14, 12, 12))
    c.rect((0, 0, W, H), fill=(20, 17, 17), radius=18, outline=(120, 70, 50), width=2)
    t0 = T["end_text"]
    # 背后一条 S21 曲线的光带
    k = ease_out((t - t0 - 0.1) / 1.0)
    if k > 0:
        pts = []
        n = 200
        for i in range(int(n * k) + 1):
            u = i / n
            f = F0 + (u - 0.5) * 0.10
            db = max(s21_db(f), -40)
            pts.append((60 + u * (W - 120), 300 - (db + 40) / 40 * 200 + 90))
        if len(pts) > 1:
            layer = Image.new("RGB", c.img.size)
            ImageDraw.Draw(layer).line([(x * S, y * S) for x, y in pts], fill=(200, 90, 50), width=int(10 * S))
            c.add(layer.filter(ImageFilter.GaussianBlur(12 * S)), 0, 0)
            c.line(pts, (255, 150, 100), 2.5)
    title = "Personal Agent"
    n = int(len(title) * clamp01((t - t0) / 0.7) + 0.999) if t >= t0 else 0
    if n:
        ttl = title[:n]
        w = c.tw(title, 92, bold=True)
        x0 = W / 2 - w / 2
        layer = Image.new("RGB", c.img.size)
        ImageDraw.Draw(layer).text((x0 * S, 170 * S), ttl, font=font(92, True), fill=(217, 119, 87), anchor="lm")
        c.add(layer.filter(ImageFilter.GaussianBlur(18 * S)), 0, 0)
        c.text(x0, 170, ttl, 92, (255, 214, 190), bold=True)
    lines = [(0.6, 268, "专精 Ansys HFSS 的桌面 Agent", 34, C_TEXT, True),
             (1.0, 330, "一句话：建模 → 仿真 → 收敛 → 结果", 26, C_DIM, False),
             (1.5, 470, "自带 API Key · DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI 兼容", 20, C_FAINT, False),
             (1.8, 510, "长期记忆 · Windows 沙箱 · 每次改动都要你批准", 20, C_FAINT, False)]
    for dt, y, s, size, col, bold in lines:
        a = ease_out((t - t0 - dt) / 0.5)
        if a > 0:
            c.text(W / 2, y + (1 - a) * 14, s, size, mix((20, 17, 17), col, a), bold=bold, anchor="mm")
    return c.img


SEQS = {
    "main": draw_main,
    "settings": draw_settings,
    "dialog": draw_dialog,
    "tip": draw_tip,
    "end": draw_end,
}


def _work(args):
    name, frames = args
    out = os.path.join(BUILD, "tex", name)
    os.makedirs(out, exist_ok=True)
    fn = SEQS[name]
    prev_hash, prev_path, made = None, None, 0
    for f in frames:
        img = fn(time_of(f))
        h = hashlib.md5(img.tobytes()).hexdigest()
        path = os.path.join(out, "%s_%04d.png" % (name, f))
        if os.path.exists(path):
            os.remove(path)
        if h == prev_hash:
            os.link(prev_path, path)
        else:
            img.save(path, compress_level=1)
            prev_hash, prev_path = h, path
            made += 1
    return name, frames[0], made


def render_all(only=None):
    jobs = []
    for name in SEQS:
        if only and name not in only:
            continue
        chunk = 40
        for i in range(1, FRAMES + 1, chunk):
            jobs.append((name, list(range(i, min(FRAMES, i + chunk - 1) + 1))))
    with Pool(28) as p:
        for name, f0, made in p.imap_unordered(_work, jobs):
            print(name, f0, "unique", made, flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "all":
        render_all(sys.argv[2:] or None)
    else:
        os.makedirs(os.path.join(BUILD, "preview"), exist_ok=True)
        for a in sys.argv[1:]:
            t = float(a)
            for name, fn in SEQS.items():
                fn(t).save(os.path.join(BUILD, "preview", "%s_%05.2f.png" % (name, t)))
