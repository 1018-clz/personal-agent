"""合成配乐和音效（numpy/scipy，不用采样），事件全部读 timeline.py。

python sound.py  ->  D:\\clawd_promo_build\\sound.wav
"""
import os
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from timeline import *  # noqa

SR = 48000
N = int(DURATION * SR)
rng = np.random.default_rng(4)
L = np.zeros(N)
R = np.zeros(N)


def tt(d):
    return np.arange(int(d * SR)) / SR


def env(d, a=0.005, r=None, curve=6.0):
    t = tt(d)
    e = np.minimum(1, t / max(a, 1e-4))
    if r is None:
        e *= np.exp(-curve * t / d)
    return e


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def lp(x, f, order=2):
    return sosfilt(butter(order, min(f, SR / 2 - 100) / (SR / 2), 'low', output='sos'), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f / (SR / 2), 'high', output='sos'), x)


def bp(x, f0, f1, order=2):
    return sosfilt(butter(order, [f0 / (SR / 2), min(f1, SR / 2 - 100) / (SR / 2)], 'band', output='sos'), x)


def noise(d):
    return rng.standard_normal(int(d * SR))


def add(sig, t, gain=1.0, pan=0.0, bus=None):
    i = int(t * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    gl, gr = np.sqrt((1 - pan) / 2), np.sqrt((1 + pan) / 2)
    (bus or (L, R))[0][i:i + len(sig)] += sig * gl * 1.41
    (bus or (L, R))[1][i:i + len(sig)] += sig * gr * 1.41


def sweep(f0, f1, d, shape='exp'):
    t = tt(d)
    if shape == 'exp':
        f = f0 * (f1 / f0) ** (t / d)
    else:
        f = f0 + (f1 - f0) * t / d
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


# ---------------------------------------------------------------- 乐器
def kick():
    d = 0.35
    t = tt(d)
    f = 50 + 120 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9) + 0.15 * lp(noise(d), 3000) * np.exp(-t * 80)


def snare():
    d = 0.25
    t = tt(d)
    return 0.5 * bp(noise(d), 1200, 8000) * np.exp(-t * 18) + 0.4 * np.sin(2 * np.pi * 190 * t) * np.exp(-t * 25)


def hat(open_=False):
    d = 0.18 if open_ else 0.05
    t = tt(d)
    return hp(noise(d), 7000) * np.exp(-t * (14 if open_ else 70))


def bass(m, d):
    t = tt(d)
    f = mtof(m)
    x = np.sin(2 * np.pi * f * t + 1.6 * np.sin(2 * np.pi * f * t) * np.exp(-t * 6))
    e = np.minimum(1, t / 0.01) * np.exp(-t * 1.2) * np.minimum(1, (d - t) / 0.03)
    return lp(x, 900) * e


def fm_key(m, d):
    t = tt(d)
    f = mtof(m)
    x = np.sin(2 * np.pi * f * t + 2.2 * np.exp(-t * 7) * np.sin(2 * np.pi * f * 3.5 * t))
    return x * np.minimum(1, t / 0.004) * np.exp(-t * 4.5)


def glock(m, d=1.2):
    t = tt(d)
    f = mtof(m)
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 6) + 0.15 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 12)
    return x * np.minimum(1, t / 0.002) * np.exp(-t * 3.2)


def pad(notes, d, cutoff=1400):
    t = tt(d)
    x = np.zeros(len(t))
    for m in notes:
        for det in (-0.08, 0.0, 0.08):
            f = mtof(m + det)
            x += 2 * ((f * t + rng.random()) % 1.0) - 1
    x = lp(x / (len(notes) * 3), cutoff, 2)
    e = np.minimum(1, t / 0.4) * np.minimum(1, (d - t) / 0.4)
    return x * e


def brass(notes, d):
    t = tt(d)
    x = np.zeros(len(t))
    for m in notes:
        for det in (-0.06, 0.06):
            f = mtof(m + det)
            x += 2 * ((f * t) % 1.0) - 1
    cut = 600 + 4000 * np.exp(-t * 3)
    # 时变低通：分段处理
    out = np.zeros_like(x)
    seg = 2048
    for i in range(0, len(x), seg):
        out[i:i + seg] = lp(x[i:i + seg], float(cut[i]), 1)
    e = np.minimum(1, t / 0.02) * np.exp(-t * 1.0)
    return out / len(notes) * e


# ---------------------------------------------------------------- 配乐
CHORDS = [(53, [65, 69, 72]), (55, [67, 71, 74]), (57, [69, 72, 76]), (48, [64, 67, 72])]  # F G Am C
BAR = 4 * BEAT
music = (np.zeros(N), np.zeros(N))
kick_env = np.zeros(N)
DROP = T["pop"]
BREAK = 43.0
FINAL = T["end_land"]

nbars = int(np.ceil(DURATION / BAR))
for b in range(nbars):
    t0 = b * BAR
    root, ch = CHORDS[b % 4]
    if t0 >= FINAL - 0.01:
        continue
    if t0 < BREAK:
        add(pad(ch, BAR + 0.3, 900 if t0 < DROP else 1600), t0, 0.16 if t0 < DROP else 0.12, bus=music)
    else:
        add(pad(ch, BAR + 0.3, 2200), t0, 0.16, bus=music)
    for i in range(8):
        tb = t0 + i * BEAT / 2 + (0.03 if i % 2 else 0)        # 稍带摇摆
        if tb >= FINAL:
            break
        if tb < BREAK or tb >= FINAL:
            add(hat(i == 7), tb, 0.10 if tb < DROP else 0.16, pan=0.3, bus=music)
    if DROP <= t0 < BREAK:
        for i, kt in enumerate([0, 1.5 * BEAT, 2 * BEAT, 3.5 * BEAT if b % 2 else 99]):
            if kt > 10:
                continue
            add(kick(), t0 + kt, 0.75, bus=music)
            k = int((t0 + kt) * SR)
            e = np.exp(-tt(0.3) * 12)
            kick_env[k:k + len(e)] = np.maximum(kick_env[k:k + len(e)], e[: N - k])
        for sb in (1, 3):
            add(snare(), t0 + sb * BEAT, 0.42, pan=-0.05, bus=music)
        for i, (bt, bd) in enumerate([(0, 0.7), (0.75 * 2 * BEAT, 0.25), (2 * BEAT, 0.6), (3 * BEAT, 0.25), (3.5 * BEAT, 0.4)]):
            add(bass(root - 12 + (12 if i == 3 else 0), bd), t0 + bt, 0.42, bus=music)
        for i in range(4):
            add(fm_key(ch[i % 3] + 12, 0.35), t0 + i * BEAT + BEAT / 2, 0.08, pan=0.35 if i % 2 else -0.35, bus=music)
# 拍子不在小节线上的 drop：在 pop 处补一个重拍
add(kick(), DROP, 0.9, bus=music)
# 结尾和弦
add(pad([60, 64, 67, 72], 4.2, 2600), FINAL, 0.22, bus=music)
add(brass([60, 64, 67], 2.5), FINAL, 0.25, bus=music)
for i, m in enumerate([72, 76, 79, 84]):
    add(glock(m, 2.5), FINAL + 0.08 * i, 0.10, pan=-0.3 + 0.2 * i, bus=music)
for i in range(6):
    add(hat(), FINAL + i * BEAT / 2, 0.07, bus=music)
# 30 s：C 大调铜管
add(brass([60, 64, 67, 72], 1.6), T["marker"], 0.32, bus=music)
# 侧链：音乐床跟着底鼓压一压
duck = 1 - 0.35 * kick_env
for ch_ in music:
    pass
mL, mR = music

# 前奏只有 pad 和 hats，低一点；结尾淡出
fade = np.ones(N)
f0, f1 = T["fade"]
idx = np.arange(N) / SR
fade[idx >= f0] = np.clip(1 - (idx[idx >= f0] - f0) / (f1 - f0), 0, 1) ** 1.5

# ---------------------------------------------------------------- 音效
def s_knock():
    d = 0.25
    t = tt(d)
    return (0.6 * np.sin(2 * np.pi * 1350 * t) * np.exp(-t * 40) + 0.5 * np.sin(2 * np.pi * 900 * t) * np.exp(-t * 30)
            + 0.4 * bp(noise(d), 2000, 6000) * np.exp(-t * 90))


def s_crack(k=1.0):
    """玻璃开裂：一串极短的高频噼啪 + 一点玻璃的鸣响。"""
    d = 0.35
    x = np.zeros(int(d * SR))
    n = int(6 + 10 * k)
    for i in range(n):
        tp = rng.uniform(0, 0.03 + 0.06 * k) * (i / n) ** 0.7
        g = tt(rng.uniform(0.002, 0.006))
        seg = hp(noise(len(g) / SR), 3000) * rng.uniform(0.4, 1.0)
        j = int(tp * SR)
        x[j:j + len(seg)] += seg[: len(x) - j]
    t = tt(d)
    x += 0.15 * k * np.sin(2 * np.pi * rng.uniform(3800, 5200) * t) * np.exp(-t * 25)
    return x


def s_tinkle():
    """碎块落回面板：一串零碎的玻璃叮当，越来越稀。"""
    d = 0.9
    x = np.zeros(int(d * SR))
    for i in range(28):
        tp = d * 0.85 * rng.random() ** 1.6
        f = rng.uniform(3000, 8000)
        g = tt(0.05)
        seg = (np.sin(2 * np.pi * f * g) + 0.5 * np.sin(2 * np.pi * f * 1.7 * g)) * np.exp(-g * rng.uniform(60, 140))
        seg += 0.3 * hp(noise(0.05), 4000) * np.exp(-g * 200)
        j = int(tp * SR)
        x[j:j + len(seg)] += seg[: len(x) - j] * rng.uniform(0.15, 0.5) * (1 - tp / d) ** 0.5
    return x


def s_inflate():
    """鼓起来：低沉往上滑的一声。"""
    d = 0.55
    t = tt(d)
    return lp(sweep(90, 260, d), 800) * np.sin(np.pi * t / d) ** 1.5


def s_peel():
    d = 0.6
    t = tt(d)
    x = bp(noise(d), 1500, 9000) * (t / d) ** 1.5 * (1 + 0.6 * np.sin(2 * np.pi * 37 * t))
    return x + 0.25 * sweep(200, 900, d) * (t / d)


def s_pop():
    d = 1.6
    t = tt(d)
    pop = sweep(700, 70, 0.18)
    x = np.zeros(len(t))
    x[:len(pop)] += pop * np.exp(-tt(0.18) * 10)
    x += 0.9 * np.sin(2 * np.pi * np.cumsum(45 + 40 * np.exp(-t * 6)) / SR) * np.exp(-t * 3)
    x += 0.5 * hp(noise(d), 3000) * np.exp(-t * 7)
    for _ in range(26):                                    # 碎玻璃
        tp = rng.uniform(0.0, 0.7)
        f = rng.uniform(2500, 7500)
        i = int(tp * SR)
        g = tt(0.12)
        seg = np.sin(2 * np.pi * f * g) * np.exp(-g * 50) * rng.uniform(0.1, 0.3)
        x[i:i + len(seg)] += seg[: len(x) - i]
    return x


def s_boing(big=False):
    d = 0.4 if big else 0.28
    t = tt(d)
    f0 = 180 if big else 260
    f = f0 * (1 + 0.9 * t / d) * (1 + 0.12 * np.sin(2 * np.pi * 22 * t) * np.exp(-t * 6))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.minimum(1, t / 0.005) * np.exp(-t * 7)


def s_whoosh(d=0.45, up=True):
    t = tt(d)
    x = noise(d)
    out = np.zeros_like(x)
    seg = 1024
    for i in range(0, len(x), seg):
        u = i / len(x)
        fc = (400 + 3000 * u) if up else (3400 - 3000 * u)
        out[i:i + seg] = bp(x[i:i + seg], fc * 0.7, fc * 1.3, 1)
    return out * np.sin(np.pi * t / d) ** 2


def s_land():
    d = 0.18
    t = tt(d)
    return 0.8 * np.sin(2 * np.pi * np.cumsum(140 * np.exp(-t * 8) + 60) / SR) * np.exp(-t * 28) + 0.4 * lp(noise(d), 900) * np.exp(-t * 35)


def s_click():
    d = 0.08
    t = tt(d)
    return 0.7 * hp(noise(d), 1800) * np.exp(-t * 120) + 0.5 * np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 90) + 0.4 * np.sin(2 * np.pi * 320 * t) * np.exp(-t * 60)


def s_key():
    d = 0.04
    t = tt(d)
    return hp(noise(d), 2500) * np.exp(-t * 180) * rng.uniform(0.6, 1.0)


def s_blip(f=1400, d=0.09):
    t = tt(d)
    return np.sin(2 * np.pi * f * t) * np.exp(-t * 35)


def s_pop_ui():
    return sweep(380, 1300, 0.07) * np.exp(-tt(0.07) * 25)


def s_close_ui():
    return sweep(1100, 300, 0.12) * np.exp(-tt(0.12) * 18)


def s_scribble():
    d = 1.0
    t = tt(d)
    am = 0.5 + 0.5 * np.sign(np.sin(2 * np.pi * (9 + 4 * np.sin(2 * np.pi * 1.3 * t)) * t))
    return bp(noise(d), 2500, 7000) * am * np.minimum(1, (d - t) / 0.1) * 0.5


def s_skate():
    d = SURF[1] - SURF[0]
    t = tt(d)
    x = lp(noise(d), 500) * 0.7 + bp(noise(d), 1500, 3000) * 0.15
    x *= np.minimum(1, t / 0.1) * np.minimum(1, (d - t) / 0.2)
    for k in np.arange(0, d, 0.1):                      # 扫频刻度声
        i = int(k * SR)
        g = tt(0.02)
        seg = np.sin(2 * np.pi * 3200 * g) * np.exp(-g * 300) * 0.35
        x[i:i + len(seg)] += seg[: len(x) - i]
    return x


def s_sparkle(d=1.4):
    x = np.zeros(int(d * SR))
    for _ in range(30):
        tp = rng.uniform(0, d * 0.7)
        m = rng.choice([84, 88, 91, 96, 100, 103])
        g = glock(m, 0.5) * rng.uniform(0.15, 0.35)
        i = int(tp * SR)
        x[i:i + len(g)] += g[: len(x) - i]
    return x


def s_power_on():
    d = 0.35
    t = tt(d)
    return sweep(80, 520, d) * np.minimum(1, t / 0.02) * np.exp(-t * 5) * 0.6 + lp(noise(d), 300) * np.exp(-t * 10) * 0.3


def s_power_down():
    d = 0.4
    t = tt(d)
    return sweep(900, 50, d) * np.exp(-t * 4) * 0.6 + hp(noise(d), 4000) * np.exp(-t * 30) * 0.3


def s_riser():
    d = 1.8
    t = tt(d)
    return (s_whoosh(d, True) * 0.7 + sweep(200, 1200, d) * 0.25) * (t / d) ** 2


def s_yay():
    x = np.zeros(int(0.9 * SR))
    for k, (a, b) in enumerate([(700, 1400), (900, 1800), (1100, 2300)]):
        c = sweep(a, b, 0.12) * np.exp(-tt(0.12) * 10)
        i = int(k * 0.16 * SR)
        x[i:i + len(c)] += c
    return x


DING = [72, 76, 79, 84]
for t, kind in sound_events():
    pan = float(rng.uniform(-0.35, 0.35))
    if kind == "knock":
        add(s_knock(), t, 0.55, pan)
        add(s_crack(0.5 if t < T["knocks"][-1] else 1.0), t + 0.01, 0.45, pan)
    elif kind == "peel":
        add(s_peel(), t, 0.40)
        add(s_inflate(), t + 0.15, 0.22)
    elif kind == "pop":
        add(s_pop(), t, 0.70)
        add(s_crack(1.6), t, 0.5)
        add(s_tinkle(), t + 0.18, 0.45)
    elif kind == "boing":
        add(s_boing(), t, 0.22, pan)
    elif kind == "boing_big":
        add(s_boing(True), t, 0.26, pan)
    elif kind == "whoosh":
        add(s_whoosh(), t, 0.30, pan)
    elif kind == "land":
        add(s_land(), t, 0.45, pan)
    elif kind == "click":
        add(s_click(), t, 0.45, pan)
        add(s_blip(1600), t + 0.02, 0.12, pan)
    elif kind == "key":
        add(s_key(), t, 0.22, pan * 0.5)
    elif kind == "pop_ui":
        add(s_pop_ui(), t, 0.30)
    elif kind == "close_ui":
        add(s_close_ui(), t, 0.25)
    elif kind == "success":
        add(glock(88, 0.6), t, 0.18)
        add(glock(95, 0.8), t + 0.09, 0.18)
    elif kind == "send":
        add(s_whoosh(0.25), t, 0.25)
    elif kind.startswith("chime"):
        add(glock(84 + [0, 4, 7][int(kind[-1])], 0.8), t, 0.16, pan)
    elif kind.startswith("ding"):
        add(glock(DING[int(kind[-1])], 1.5), t, 0.30)
    elif kind == "scribble":
        add(s_scribble(), t, 0.30, 0.3)
    elif kind == "spin":
        add(s_whoosh(0.9, True), t, 0.30, 0.3)
    elif kind == "approve":
        add(glock(79, 0.5), t, 0.15)
        add(glock(86, 0.7), t + 0.08, 0.18)
    elif kind == "skate":
        add(s_skate(), t, 0.40, 0.2)
    elif kind == "sparkle":
        add(s_sparkle(), t, 0.40)
    elif kind == "brass":
        pass
    elif kind == "tip":
        add(s_pop_ui(), t, 0.22)
        add(s_blip(1900, 0.06), t + 0.05, 0.10)
    elif kind == "power_on":
        add(s_power_on(), t, 0.30, pan)
    elif kind == "power_down":
        add(s_power_down(), t, 0.40, pan)
    elif kind == "fall":
        add(s_whoosh(0.6, False), t, 0.25, pan)
    elif kind == "riser":
        add(s_riser(), t, 0.40)
    elif kind == "final":
        add(s_sparkle(1.8), t + 0.3, 0.35)
    elif kind == "yay":
        add(s_yay(), t, 0.22)
    elif kind == "blip":
        add(s_blip(1200, 0.12), t, 0.15)

# ---------------------------------------------------------------- 混音和母线
mL = mL * duck * fade
mR = mR * duck * fade
L = L * fade + mL
R = R * fade + mR


def compress(x, thr_db=-16, ratio=3.0, att=0.005, rel=0.12):
    a = np.abs(x)
    ga, gr = np.exp(-1 / (att * SR)), np.exp(-1 / (rel * SR))
    envv = np.zeros_like(a)
    e = 0.0
    for i in range(0, len(a), 32):                     # 32 个采样一块，够用且快
        v = a[i:i + 32].max()
        e = ga * e + (1 - ga) * v if v > e else gr * e + (1 - gr) * v
        envv[i:i + 32] = e
    db = 20 * np.log10(envv + 1e-9)
    over = np.maximum(0, db - thr_db)
    return 10 ** (-(over - over / ratio) / 20)


link_ = np.maximum(np.abs(L), np.abs(R))
g = compress(link_)
L, R = L * g, R * g
ceil = 10 ** (-1 / 20)
# 把 4–43 s 的律动段推到约 -14 dB RMS，再软削顶到 -1 dBFS
a, b = int(4 * SR), int(43 * SR)
rms = np.sqrt(((L[a:b] ** 2 + R[a:b] ** 2) / 2).mean())
k = 10 ** (-14.5 / 20) / rms
L, R = L * k, R * k
L, R = np.tanh(L / ceil) * ceil, np.tanh(R / ceil) * ceil
out = np.stack([L, R], 1)
wavfile.write(os.path.join(BUILD, "sound.wav"), SR, (out * 32767).astype(np.int16))

# 每半秒响度
for k in range(0, int(DURATION * 2), 4):
    seg = out[int(k * SR / 2): int((k + 1) * SR / 2)]
    print("%5.1fs %6.1f dB" % (k / 2, 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-9)))
print("written")
