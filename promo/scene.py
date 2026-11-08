"""搭 Blender 场景：blender -b --factory-startup -P scene.py

读 timeline.py，生成 D:\\clawd_promo_build\\promo.blend。
"""
import math
import os
import random
import sys

import bpy
import bmesh
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from timeline import *  # noqa

bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
sc = bpy.context.scene
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

sc.render.fps = FPS
sc.frame_start, sc.frame_end = 1, FRAMES
sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
sc.render.engine = 'CYCLES'
sc.cycles.device = 'GPU'
sc.cycles.samples = 64
sc.cycles.use_adaptive_sampling = True
sc.cycles.adaptive_threshold = 0.02
sc.cycles.use_denoising = True
sc.cycles.denoiser = 'OPTIX'
sc.cycles.max_bounces = 6
sc.cycles.glossy_bounces = 3
sc.cycles.transmission_bounces = 6
sc.cycles.sample_clamp_indirect = 4.0
sc.cycles.caustics_reflective = False
sc.cycles.caustics_refractive = False
sc.render.use_motion_blur = True
sc.render.motion_blur_shutter = 0.5
sc.render.use_persistent_data = True
sc.view_settings.view_transform = 'AgX'
sc.view_settings.look = 'AgX - Medium High Contrast'
sc.view_settings.exposure = 0.15
sc.render.image_settings.file_format = 'PNG'
sc.render.image_settings.color_depth = '8'
sc.render.filepath = os.path.join(BUILD, "render", "f_")

U = 0.1 / 12          # Clawd 的 1 个单位

# ---------------------------------------------------------------- 工具函数
def ease(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def ease_out(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3


def ease_out_back(x, k=1.9):
    x = min(max(x, 0.0), 1.0)
    return 1 + (k + 1) * (x - 1) ** 3 + k * (x - 1) ** 2


def ui3(x, y, z=0.0):
    mx, my = ui_to_m(x, y)
    return Vector((mx, my, z))


def frames():
    return range(1, FRAMES + 1)


def key_obj(o, f, loc=None, quat=None, scale=None, rot=None):
    if loc is not None:
        o.location = loc
        o.keyframe_insert("location", frame=f)
    if quat is not None:
        o.rotation_quaternion = quat
        o.keyframe_insert("rotation_quaternion", frame=f)
    if rot is not None:
        o.rotation_euler = rot
        o.keyframe_insert("rotation_euler", frame=f)
    if scale is not None:
        o.scale = scale
        o.keyframe_insert("scale", frame=f)


def key_hide(o, f, hidden):
    o.hide_render = hidden
    o.hide_viewport = hidden
    o.keyframe_insert("hide_render", frame=f)
    o.keyframe_insert("hide_viewport", frame=f)


_vis_state = {}


def key_vis(o, f, visible):
    """只在可见性改变（以及第 1 帧）时插关键帧。"""
    if f == 1 or _vis_state.get(o.name) != visible:
        key_hide(o, f, not visible)
        _vis_state[o.name] = visible


def key_prop(o, name, f, v):
    o[name] = v
    o.keyframe_insert('["%s"]' % name, frame=f)


def link(o):
    sc.collection.objects.link(o)
    return o


# ---------------------------------------------------------------- 材质
def load_seq(name):
    path = os.path.join(BUILD, "tex", name, "%s_0001.png" % name)
    img = bpy.data.images.load(path)
    img.source = 'SEQUENCE'
    img.name = name
    return img


def screen_material(name, img):
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bs = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bs.inputs["Base Color"].default_value = (0.004, 0.004, 0.005, 1)
    bs.inputs["Roughness"].default_value = 0.32
    bs.inputs["Specular IOR Level"].default_value = 0.1
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = 'Cubic'
    tex.extension = 'EXTEND'
    tex.image_user.frame_duration = FRAMES
    tex.image_user.frame_start = 1
    tex.image_user.frame_offset = 0
    tex.image_user.use_auto_refresh = True
    uv = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_type = 'OBJECT'
    attr.attribute_name = "power"
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = 1.35
    nt.links.new(attr.outputs["Fac"], mul.inputs[0])
    nt.links.new(tex.outputs["Color"], bs.inputs["Emission Color"])
    nt.links.new(mul.outputs[0], bs.inputs["Emission Strength"])
    nt.links.new(bs.outputs[0], out.inputs[0])
    return m


def plain_material(name, color, rough=0.4, emit=None, estr=0.0, transmission=0.0, coat=0.0, sss=0.0):
    m = bpy.data.materials.new(name)
    bs = m.node_tree.nodes.get("Principled BSDF")
    bs.inputs["Base Color"].default_value = (*color, 1)
    bs.inputs["Roughness"].default_value = rough
    if emit:
        bs.inputs["Emission Color"].default_value = (*emit, 1)
        bs.inputs["Emission Strength"].default_value = estr
    bs.inputs["Transmission Weight"].default_value = transmission
    bs.inputs["Coat Weight"].default_value = coat
    bs.inputs["Subsurface Weight"].default_value = sss
    return m


M_BODY = plain_material("slab_body", (0.010, 0.010, 0.012), rough=0.35)

# ---------------------------------------------------------------- 玻璃板
def make_slab(name, rect, ztop, thick, mat, uv_rect, tex_wh):
    x0, y0, x1, y1 = rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w, h = (x1 - x0) * PX, (y1 - y0) * PX
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    vs = []
    for z in (-thick, 0.0):
        for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            vs.append(bm.verts.new((sx * w / 2, sy * h / 2, z)))
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    uvl = bm.loops.layers.uv.new("UV")
    for i, fi in enumerate(faces):
        f = bm.faces.new([vs[j] for j in fi])
        f.material_index = 0 if i == 1 else 1
        if i == 1:
            ux0, uy0, ux1, uy1 = uv_rect
            tw, th = tex_wh
            for loop in f.loops:
                px = ux0 + (loop.vert.co.x / w + 0.5) * (ux1 - ux0)
                py = uy0 + (0.5 - loop.vert.co.y / h) * (uy1 - uy0)
                loop[uvl].uv = (px / tw, 1 - py / th)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    me.materials.append(M_BODY)
    o = link(bpy.data.objects.new(name, me))
    o.location = ui3(cx, cy, ztop)
    o["power"] = 1.0
    bv = o.modifiers.new("bevel", 'BEVEL')
    bv.width = 0.0015
    bv.segments = 2
    bv.limit_method = 'ANGLE'
    bv.harden_normals = True
    for p in me.polygons:
        p.use_smooth = True
    return o


IMG = {n: load_seq(n) for n in ("main", "settings", "dialog", "tip", "end")}
MAT = {n: screen_material("screen_" + n, IMG[n]) for n in IMG}
SLABS = {}
for name, r in MAIN_PANELS.items():
    SLABS[name] = make_slab(name, r, PANEL_Z[name], PANEL_THICK, MAT["main"], r, (UI_W, UI_H))


def local_rect(r):
    return (0, 0, r[2] - r[0], r[3] - r[1])


SLABS["SET"] = make_slab("SET", SET_RECT, PANEL_Z["SET"], 0.012, MAT["settings"], local_rect(SET_RECT),
                         (SET_RECT[2] - SET_RECT[0], SET_RECT[3] - SET_RECT[1]))
SLABS["DLG"] = make_slab("DLG", DLG_RECT, PANEL_Z["DLG"], 0.012, MAT["dialog"], local_rect(DLG_RECT),
                         (DLG_RECT[2] - DLG_RECT[0], DLG_RECT[3] - DLG_RECT[1]))
SLABS["END"] = make_slab("END", END_RECT, PANEL_Z["END"], 0.02, MAT["end"], local_rect(END_RECT),
                         (END_RECT[2] - END_RECT[0], END_RECT[3] - END_RECT[1]))
tw, th = TIP_SIZE
SLABS["TIP"] = make_slab("TIP", (0, 0, tw, th), PANEL_Z["TIP"], 0.008, MAT["tip"], (0, 0, tw, th), (tw, th))

# ---- 面板动画：开机、弹出、断电掉落
rng = random.Random(3)
boot = dict(zip(["TOP", "SIDE", "CHAT", "MODEL", "JOBS", "PLOT"], T["boot"]))
fall = dict(SHUTDOWN)


def flicker_on(t, t0):
    if t < t0:
        return 0.0
    d = t - t0
    seq = [0.7, 0.15, 0.9, 0.4, 1.0]
    if d < 0.25:
        return seq[min(int(d / 0.05), 4)]
    return 1.0


def flicker_off(t, t0):
    if t < t0:
        return 1.0
    d = t - t0
    seq = [1.6, 0.3, 1.0, 0.1, 0.5, 0.0]
    if d < 0.3:
        return seq[min(int(d / 0.05), 5)]
    return 0.0


for name in MAIN_PANELS:
    o = SLABS[name]
    base = o.location.copy()
    tilt_axis = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized()
    spin = rng.uniform(0.5, 0.9) * (1 if rng.random() < 0.5 else -1)
    td = fall[name]
    o.rotation_mode = 'QUATERNION'
    for f in frames():
        t = time_of(f)
        p = min(flicker_on(t, boot[name]), flicker_off(t, td))
        key_prop(o, "power", f, p)
        d = t - td - 0.25
        if d > 0:
            loc = base + Vector((0, 0, -0.5 * 3.2 * d * d - 0.05 * d))
            q = Quaternion(tilt_axis, spin * d * d * 1.5)
        else:
            loc, q = base, Quaternion()
        key_obj(o, f, loc=loc, quat=q)
        key_vis(o, f, t <= td + 2.5)


def pop_slab(o, t_open, t_close, base_loc, f_power=None):
    for f in frames():
        t = time_of(f)
        if t < t_open or t > t_close + 0.25:
            s = 0.001
        elif t < t_close:
            s = max(0.001, ease_out_back((t - t_open) / 0.28))
        else:
            s = max(0.001, 1 - ease((t - t_close) / 0.22))
        rise = (1 - min(1, s)) * -0.04
        key_obj(o, f, loc=base_loc + Vector((0, 0, rise)), scale=(s, s, s))
        key_prop(o, "power", f, 1.0 if f_power is None else f_power(t))
        key_vis(o, f, t_open - 0.04 <= t <= t_close + 0.3)


pop_slab(SLABS["SET"], T["settings_open"], T["settings_close"], SLABS["SET"].location.copy(),
         lambda t: 1.0 + 0.6 * max(0, 1 - abs(t - T["save"]) / 0.3))
DLG_CLOSE = HOPS[13][0] + 0.05
pop_slab(SLABS["DLG"], T["dialog_open"], DLG_CLOSE, SLABS["DLG"].location.copy(),
         lambda t: 1.0 + 0.8 * max(0, 1 - abs(t - T["allow"]) / 0.3))

# 提示条：每次在新位置弹出
tip = SLABS["TIP"]
for f in frames():
    t = time_of(f)
    cur = None
    for tp in TIPS:
        if tp[1] - 0.05 <= t <= tp[1] + TIP_DUR + 0.25:
            cur = tp
    if cur is None:
        key_obj(tip, f, loc=ui3(960, 540, -1), scale=(0.001,) * 3)
        continue
    _, t0, (cx, cy), _ = cur
    if t < t0 + TIP_DUR:
        s = max(0.001, ease_out_back((t - t0) / 0.25))
    else:
        s = max(0.001, 1 - ease((t - t0 - TIP_DUR) / 0.2))
    key_obj(tip, f, loc=ui3(cx, cy, PANEL_Z["TIP"] + 0.02 * (1 - min(s, 1))), scale=(s, s, s))
    key_prop(tip, "power", f, 1.15)

# 片尾卡：从下面升起
end = SLABS["END"]
end.rotation_mode = 'QUATERNION'
end_base = end.location.copy()
for f in frames():
    t = time_of(f)
    a, b = T["end_rise"]
    k = ease_out_back((t - a) / (b - a), 1.2)
    loc = end_base + Vector((0, 0, -1.4 * (1 - k)))
    q = Quaternion((1, 0, 0), math.radians(35) * (1 - min(1, k)))
    key_obj(end, f, loc=loc, quat=q)
    key_prop(end, "power", f, flicker_on(t, a + 0.3) * (1 - 0.0))
    key_vis(end, f, t >= a - 0.05)

# ---------------------------------------------------------------- Clawd
M_CLAWD = plain_material("clawd", (0.5, 0.085, 0.03), rough=0.42, coat=0.15, sss=0.04)
M_EYE = plain_material("eye", (0.006, 0.005, 0.005), rough=0.18)


def add_flat_control(m):
    """flat=1 时只剩自发光，颜色和界面贴图里的 2D Clawd 完全一样（贴图强度也是 1.35）。"""
    nt = m.node_tree
    bs = nt.nodes.get("Principled BSDF")
    v = nt.nodes.new("ShaderNodeValue")
    v.name = "flat"
    v.outputs[0].default_value = 0.0
    mixc = nt.nodes.new("ShaderNodeMix")
    mixc.data_type = 'RGBA'
    nt.links.new(v.outputs[0], mixc.inputs["Factor"])
    mixc.inputs[6].default_value = bs.inputs["Base Color"].default_value[:]
    mixc.inputs[7].default_value = (0.0, 0.0, 0.0, 1)
    nt.links.new(mixc.outputs[2], bs.inputs["Base Color"])
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = 1.35
    nt.links.new(v.outputs[0], mul.inputs[0])
    nt.links.new(mul.outputs[0], bs.inputs["Emission Strength"])
    bs.inputs["Emission Color"].default_value = (0.693, 0.184, 0.0953, 1)   # #D97757 的线性值
    inv = nt.nodes.new("ShaderNodeMath")
    inv.operation = 'SUBTRACT'
    inv.inputs[0].default_value = 1.0
    nt.links.new(v.outputs[0], inv.inputs[1])
    coat = nt.nodes.new("ShaderNodeMath")
    coat.operation = 'MULTIPLY'
    coat.inputs[1].default_value = bs.inputs["Coat Weight"].default_value
    nt.links.new(inv.outputs[0], coat.inputs[0])
    nt.links.new(coat.outputs[0], bs.inputs["Coat Weight"])
    return v


FLAT = add_flat_control(M_CLAWD)


def box(name, size, center, mat, parent, bevel):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(mat)
    o = link(bpy.data.objects.new(name, me))
    o.location = center
    o.parent = parent
    if bevel:
        bv = o.modifiers.new("bevel", 'BEVEL')
        bv.width = bevel
        bv.segments = 5
        bv.harden_normals = True
        bv.limit_method = 'NONE'
    return o


root = link(bpy.data.objects.new("ClawdRoot", None))
root.rotation_mode = 'QUATERNION'
body = box("body", (12 * U, 6 * U, 8 * U), Vector((0, 0, 6 * U)), M_CLAWD, root, 1.3 * U)
arm_l = box("arm_l", (2.4 * U, 2.2 * U, 2.0 * U), Vector((-6.6 * U, 0, 5.8 * U)), M_CLAWD, root, 0.6 * U)
# 右手：枢轴在贴身体的地方，方便挥手
arm_pivot = link(bpy.data.objects.new("arm_r_pivot", None))
arm_pivot.parent = root
arm_pivot.location = Vector((5.6 * U, 0, 5.8 * U))
arm_r = box("arm_r", (2.4 * U, 2.2 * U, 2.0 * U), Vector((1.0 * U, 0, 0)), M_CLAWD, arm_pivot, 0.6 * U)
for lx in (-4.0, -2.0, 2.0, 4.0):
    box("leg", (1.3 * U, 1.6 * U, 2.6 * U), Vector((lx * U, 0, 1.2 * U)), M_CLAWD, root, 0.35 * U)
eyes = []
for ex in (-3.0, 3.0):
    e = box("eye", (0.95 * U, 0.4 * U, 2.2 * U), Vector((ex * U, -3.02 * U, 7.1 * U)), M_EYE, root, 0.3 * U)
    eyes.append(e)
happy = []
for ex in (-3.0, 3.0):
    hp = link(bpy.data.objects.new("happy", None))
    hp.parent = root
    hp.location = Vector((ex * U, -3.05 * U, 7.2 * U))
    for sgn in (-1, 1):
        b = box("happy_bar", (1.5 * U, 0.4 * U, 0.45 * U), Vector((sgn * 0.5 * U, 0, 0)), M_EYE, hp, 0.15 * U)
        b.rotation_euler = (0, math.radians(sgn * 40), 0)
    happy.append(hp)
BODY_PARTS = [o for o in root.children_recursive if o.type == 'MESH' and o.name.split(".")[0] in ("body", "arm_l", "arm_r", "leg")]
HC = 6 * U            # 翻跟头的枢轴高度（身体中心）

# ---- 路线
legs_, prev = [], (CLAWD_START[0], CLAWD_START[1], "CHAT")
for h in HOPS:
    t0, t1, x, y, surf, apex, flips = h
    legs_.append(dict(t0=t0, t1=t1, p0=prev, p1=(x, y, surf), apex=apex, flips=flips))
    prev = (x, y, surf)
    if abs(t1 - SURF[0]) < 1e-6:
        prev = (SURF[3], SURF[4], "PLOT")


def surf_z(name):
    return PANEL_Z[name] + (0.003 if name == "PLOT" else 0.0)


def ground_at(t):
    """站着时的位置（不在空中）。"""
    pos = (CLAWD_START[0], CLAWD_START[1], "CHAT")
    for lg in legs_:
        if t >= lg["t1"]:
            pos = lg["p1"]
            if abs(lg["t1"] - SURF[0]) < 1e-6 and t >= SURF[0]:
                pos = (surf_x(t), SURF[4], "PLOT")
    return pos


def clawd_pos(t):
    for lg in legs_:
        if lg["t0"] <= t < lg["t1"]:
            s = (t - lg["t0"]) / (lg["t1"] - lg["t0"])
            x0, y0, s0 = lg["p0"]
            x1, y1, s1 = lg["p1"]
            p0, p1 = ui3(x0, y0, surf_z(s0)), ui3(x1, y1, surf_z(s1))
            p = p0.lerp(p1, s)
            p.z += lg["apex"] * 4 * s * (1 - s)
            return p, lg, s
    x, y, s0 = ground_at(t)
    return ui3(x, y, surf_z(s0)), None, 0.0


def squash(t):
    a = 0.0
    for lg in legs_:
        d = t - lg["t1"]
        if 0 <= d < 0.45:
            a += 0.26 * math.exp(-d / 0.08) * math.cos(d * 28)
        d = lg["t0"] - t
        if 0 <= d < 0.1:
            a += 0.18 * (1 - d / 0.1)
        d = t - lg["t0"]
        if 0 <= d < 0.25:
            a -= 0.16 * math.exp(-d / 0.07)
    if T["peel"] <= t < T["pop"]:
        a = 0
    # 呼吸
    a += 0.012 * math.sin(t * math.tau / (BEAT * 2))
    return 1 - a, 1 + a * 0.5


# ---- 摄像机（先算，Clawd 站着时朝向它）
CAM_KEYS = [
    (0.0, (960, 560, 0.0), 0.0, 2.15, -6, 58, 30, 8),
    (2.0, (880, 540, 0.0), 0.0, 1.8, -3, 50, 32, 8),
    (3.3, (698, 430, 0.04), 0.0, 0.85, 0, 40, 40, 4),
    (4.0, (698, 430, 0.06), 0.5, 0.6, 4, 30, 40, 2.8),
    (4.7, None, 1.0, 0.55, 8, 24, 40, 2.8),
    (5.5, None, 1.0, 1.25, 0, 50, 40, 4),
    (6.4, (940, 420, 0.11), 0.12, 1.1, -4, 46, 40, 4),
    (8.5, (940, 420, 0.11), 0.3, 1.0, 2, 44, 40, 4),
    (10.8, (940, 420, 0.11), 0.4, 0.95, 6, 40, 40, 4),
    (11.6, None, 1.0, 0.95, 0, 38, 40, 4),
    (12.4, (660, 1005, 0.04), 0.5, 0.7, -10, 34, 40, 2.8),
    (13.8, (720, 1005, 0.04), 0.5, 0.7, -4, 36, 40, 2.8),
    (14.6, None, 1.0, 0.6, 8, 30, 40, 2.8),
    (15.1, (820, 640, 0.04), 0.25, 1.25, 2, 46, 40, 4),
    (15.7, (640, 330, 0.04), 0.4, 0.8, 0, 38, 40, 3.5),
    (17.2, (660, 400, 0.04), 0.2, 0.95, -4, 42, 40, 4),
    (18.5, None, 1.0, 0.65, 4, 32, 40, 2.8),
    (19.6, None, 1.0, 0.9, 10, 36, 40, 3.5),
    (20.5, (1500, 290, 0.03), 0.4, 0.85, 12, 40, 40, 3.5),
    (21.3, (700, 730, 0.1), 0.2, 1.05, -4, 42, 40, 4),
    (22.6, None, 1.0, 0.62, 0, 28, 40, 2.8),
    (23.6, None, 1.0, 0.9, 10, 36, 40, 3.5),
    (25.0, (1580, 590, 0.04), 0.5, 0.8, 14, 38, 40, 3.5),
    (26.0, (1530, 900, 0.03), 0.6, 0.85, -32, 26, 40, 3.2),
    (29.0, (1530, 900, 0.03), 0.6, 0.85, -26, 28, 40, 3.2),
    (30.2, (1530, 860, 0.03), 0.3, 0.9, -8, 38, 40, 3.5),
    (31.6, (1100, 620, 0.0), 0.0, 1.9, 0, 46, 35, 5.6),
    (32.6, (1100, 620, 0.0), 0.0, 1.85, 3, 45, 35, 5.6),
    (33.6, (1290, 230, 0.03), 0.15, 1.3, 0, 56, 40, 4),
    (38.6, (1400, 230, 0.03), 0.15, 1.3, 4, 56, 40, 4),
    (39.9, (800, 560, 0.0), 0.3, 2.0, 0, 50, 35, 5.6),
    (40.8, (500, 1030, 0.02), 0.5, 0.9, -8, 36, 40, 3.5),
    (42.2, (500, 1030, 0.02), 0.5, 0.95, -4, 38, 40, 3.5),
    (43.1, (300, 120, 0.03), 0.5, 1.0, -10, 40, 40, 4),
    (44.2, (960, 540, -0.1), 0.0, 2.8, -4, 50, 32, 8),
    (45.6, (1000, 560, 0.06), 0.0, 1.5, 0, 40, 40, 5.6),
    (50.0, (1000, 560, 0.06), 0.0, 1.38, 2, 38, 40, 5.6),
]

# Clawd 的平滑位置（摄像机跟拍用）
raw = [clawd_pos(time_of(f))[0] for f in frames()]
sig = 0.22 * FPS
kern = [math.exp(-0.5 * (i / sig) ** 2) for i in range(-int(3 * sig), int(3 * sig) + 1)]
smooth = []
for i in range(FRAMES):
    acc, wsum = Vector((0, 0, 0)), 0.0
    for j, kw in enumerate(kern):
        k = min(max(i + j - len(kern) // 2, 0), FRAMES - 1)
        acc += raw[k] * kw
        wsum += kw
    smooth.append(acc / wsum)


def hermite(keys_t, vals, t):
    n = len(keys_t)
    if t <= keys_t[0]:
        return vals[0]
    if t >= keys_t[-1]:
        return vals[-1]
    i = max(j for j in range(n - 1) if keys_t[j] <= t)
    t0, t1 = keys_t[i], keys_t[i + 1]
    h = t1 - t0
    s = (t - t0) / h

    def tan(j):
        if j == 0 or j == n - 1:
            return 0 * vals[j]
        return (vals[j + 1] - vals[j - 1]) / (keys_t[j + 1] - keys_t[j - 1]) * 0.8

    m0, m1 = tan(i) * h, tan(i + 1) * h
    h00, h10, h01, h11 = 2 * s ** 3 - 3 * s ** 2 + 1, s ** 3 - 2 * s ** 2 + s, -2 * s ** 3 + 3 * s ** 2, s ** 3 - s ** 2
    return vals[i] * h00 + m0 * h10 + vals[i + 1] * h01 + m1 * h11


kt = [k[0] for k in CAM_KEYS]
fixed = []
for k in CAM_KEYS:
    if k[1] is None:
        fixed.append(smooth[frame_of(k[0]) - 1] + Vector((0, 0, 0.04)))
    else:
        fixed.append(ui3(*k[1]))

cam_data = bpy.data.cameras.new("cam")
cam = link(bpy.data.objects.new("cam", cam_data))
sc.camera = cam
cam.rotation_mode = 'QUATERNION'
cam_data.dof.use_dof = True
cam_data.sensor_width = 36
cam_data.clip_start = 0.02
cam_yaw = []
for f in frames():
    t = time_of(f)
    fx = Vector([hermite(kt, [p[i] for p in fixed], t) for i in range(3)])
    w = min(1, max(0, hermite(kt, [k[2] for k in CAM_KEYS], t)))
    target = fx.lerp(smooth[f - 1] + Vector((0, 0, 0.045)), w)
    dist = hermite(kt, [k[3] for k in CAM_KEYS], t)
    yaw = math.radians(hermite(kt, [k[4] for k in CAM_KEYS], t))
    pitch = math.radians(hermite(kt, [k[5] for k in CAM_KEYS], t))
    lens = hermite(kt, [k[6] for k in CAM_KEYS], t)
    fst = hermite(kt, [k[7] for k in CAM_KEYS], t)
    off = Vector((dist * math.cos(pitch) * math.sin(yaw), -dist * math.cos(pitch) * math.cos(yaw), dist * math.sin(pitch)))
    loc = target + off
    q = (target - loc).to_track_quat('-Z', 'Y')
    key_obj(cam, f, loc=loc, quat=q)
    cam_data.lens = lens
    cam_data.keyframe_insert("lens", frame=f)
    cam_data.dof.focus_distance = (target - loc).length
    cam_data.dof.keyframe_insert("focus_distance", frame=f)
    cam_data.dof.aperture_fstop = fst
    cam_data.dof.keyframe_insert("aperture_fstop", frame=f)
    cam_yaw.append(yaw)

# ---- Clawd 逐帧
BLINKS = [5.6, 9.3, 13.0, 17.0, 20.8, 27.5, 34.8, 39.0, 42.0]
yaw_s, prev_q = None, None
for f in frames():
    t = time_of(f)
    p, lg, s = clawd_pos(t)
    # 朝向：站着时看镜头，空中朝前进方向（限制在 ±70°）
    cy = cam_yaw[f - 1]
    want = cy
    if lg is not None:
        a0, a1 = ui3(*lg["p0"][:2]), ui3(*lg["p1"][:2])
        d = a1 - a0
        if d.length > 0.02:
            tv = math.atan2(d.x, -d.y)
            dd = (tv - cy + math.pi) % math.tau - math.pi
            want = cy + max(-1.2, min(1.2, dd))
    if SURF[0] <= t < SURF[1]:
        want = cy + max(-1.0, min(1.0, ((math.pi / 2) - cy + math.pi) % math.tau - math.pi))
    if yaw_s is None:
        yaw_s = want
    dd = (want - yaw_s + math.pi) % math.tau - math.pi
    yaw_s += dd * (1 - math.exp(-(1 / FPS) / 0.09))

    sz, sxy = squash(t)
    depth, tilt, flip = 1.0, 0.0, 0.0
    if t < T["pop"]:
        tp = t - T["peel"]
        lift = ease(tp / 0.45)                   # 从头部揭起来
        wind = ease((tp - 0.45) / 0.22)          # 往后压一点蓄力
        tilt = math.radians(-90 + 34 * lift - 8 * wind)
        depth = 0.03 + 0.17 * ease((tp - 0.1) / 0.45) + 0.15 * wind   # 一边揭一边鼓起来
        p = ui3(*CLAWD_START, PANEL_Z["CHAT"] + 0.0006)
        sz, sxy = 1 - 0.08 * wind, 1 + 0.04 * wind
        yaw_use = 0.0
    else:
        d = t - T["pop"]
        depth = 0.35 + 0.65 * ease_out_back(d / 0.24, 1.6)
        tilt = math.radians(-64) * (1 - ease_out_back(d / 0.22, 1.2))
        yaw_use = yaw_s * ease(d / 0.25)
    if lg is not None and lg["flips"]:
        flip = -math.tau * lg["flips"] * ease(s)
    depth_lift = 3 * U * depth * abs(math.sin(tilt))
    M = (Matrix.Translation(p + Vector((0, 0, depth_lift)))
         @ Matrix.Rotation(yaw_use, 4, 'Z')
         @ Matrix.Translation((0, 0, HC)) @ Matrix.Rotation(flip, 4, 'X') @ Matrix.Translation((0, 0, -HC))
         @ Matrix.Rotation(tilt, 4, 'X')
         @ Matrix.Diagonal((sxy, sxy * depth, sz, 1)))
    loc, q, scl = M.decompose()
    if prev_q is not None and q.dot(prev_q) < 0:
        q.negate()
    prev_q = q.copy()
    key_obj(root, f, loc=loc, quat=q, scale=scl)
    if T["peel"] - 0.1 <= t <= T["pop"] + 0.1 or f == 1:
        FLAT.outputs[0].default_value = 1.0 - ease((t - T["peel"] - 0.05) / 0.35)
        FLAT.outputs[0].keyframe_insert("default_value", frame=f)
    # 挥手
    wv = 0.0
    if t >= T["wave"]:
        wv = ease((t - T["wave"]) / 0.3)
    ang = -wv * (math.radians(92) + math.radians(24) * math.sin((t - T["wave"]) * math.tau * 2.0))
    key_obj(arm_pivot, f, rot=(0, ang, 0), scale=(1 + 1.2 * wv, 1, 1),
            loc=Vector((5.6 * U, -2.1 * U * wv, (5.8 + 1.2 * wv) * U)))
    # 眨眼 / 笑眼
    bl = any(0 <= t - b < 0.12 for b in BLINKS)
    hap = t >= T["end_land"] + 0.15
    for e in eyes:
        key_obj(e, f, scale=(1, 1, 0.12 if bl else 1.0))
    for e in eyes:
        key_vis(e, f, (not hap) and t >= T["peel"])
    for hp in happy:
        for ch in hp.children:
            key_vis(ch, f, hap)
    for ob in BODY_PARTS:
        key_vis(ob, f, t >= T["peel"])

# ---------------------------------------------------------------- 碎玻璃 + 火花
M_SHARD = plain_material("shard", (0.8, 0.9, 1.0), rough=0.05, emit=(0.6, 0.75, 1.0), estr=1.2, transmission=0.9)
M_SPARK = plain_material("spark", (1, 0.5, 0.2), rough=0.5, emit=(1.0, 0.45, 0.15), estr=25)
M_SPARK2 = plain_material("spark2", (1, 1, 1), rough=0.5, emit=(1.0, 0.9, 0.7), estr=30)


def burst(name, n, t0, origin, mat_list, size, speed, up, life, g=3.0, tri=True, seed=1):
    r = random.Random(seed)
    for i in range(n):
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        if tri:
            a = [bm.verts.new((r.uniform(-1, 1) * size, r.uniform(-1, 1) * size, 0)) for _ in range(3)]
            b = [bm.verts.new((v.co.x, v.co.y, 0.0008)) for v in a]
            bm.faces.new(a)
            bm.faces.new(b[::-1])
            for j in range(3):
                bm.faces.new((a[j], a[(j + 1) % 3], b[(j + 1) % 3], b[j]))
        else:
            bmesh.ops.create_icosphere(bm, subdivisions=1, radius=size * r.uniform(0.5, 1.0))
        bm.to_mesh(me)
        bm.free()
        me.materials.append(r.choice(mat_list))
        o = link(bpy.data.objects.new(name, me))
        ang = r.uniform(0, math.tau)
        v = Vector((math.cos(ang) * speed * r.uniform(0.4, 1.0), math.sin(ang) * speed * r.uniform(0.4, 1.0),
                    up * r.uniform(0.5, 1.0)))
        axis = Vector((r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-1, 1))).normalized()
        w = r.uniform(6, 16)
        lf = life * r.uniform(0.6, 1.0)
        o.rotation_mode = 'QUATERNION'
        f0, f1 = frame_of(t0) - 1, frame_of(t0 + lf) + 1
        key_hide(o, 1, True)
        key_hide(o, f0, True)
        key_hide(o, f0 + 1, False)
        key_hide(o, f1, True)
        for f in range(f0 + 1, f1 + 1):
            d = time_of(f) - t0
            pos = origin + v * d + Vector((0, 0, -0.5 * g * d * d))
            s = max(0.001, 1 - (d / lf) ** 3)
            key_obj(o, f, loc=pos, quat=Quaternion(axis, w * d), scale=(s, s, s))


SHARD_COLL = bpy.data.collections.new("shards")
sc.collection.children.link(SHARD_COLL)
M_GLASS = bpy.data.materials.new("glass")
_g = M_GLASS.node_tree.nodes.get("Principled BSDF")
_g.inputs["Base Color"].default_value = (0.93, 0.97, 1.0, 1)
_g.inputs["Transmission Weight"].default_value = 1.0
_g.inputs["Roughness"].default_value = 0.03
_g.inputs["IOR"].default_value = 1.52
_g.inputs["Specular IOR Level"].default_value = 0.8


def prism(name, poly_m, thick, mat):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    top = [bm.verts.new((x, y, 0.0)) for x, y in poly_m]
    bot = [bm.verts.new((x, y, -thick)) for x, y in poly_m]
    bm.faces.new(top)
    bm.faces.new(bot[::-1])
    n = len(top)
    for i in range(n):
        bm.faces.new((bot[i], bot[(i + 1) % n], top[(i + 1) % n], top[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    SHARD_COLL.objects.link(o)
    o.rotation_mode = 'QUATERNION'
    return o


def simulate(o, p0, v0, w0, t0, floor, g=6.0, t_end=None):
    """简单刚体：抛出、落回面板、弹两下、躺平；发送消息时缩没。"""
    t_end = t_end or T["send"]
    p, v, q = p0.copy(), v0.copy(), Quaternion()
    w = w0.copy()
    resting = False
    key_vis(o, 1, False)
    sub = 8
    for f in range(frame_of(t0) - 1, frame_of(t_end + 0.3) + 1):
        t = time_of(f)
        if t < t0:
            key_vis(o, f, False)
            key_obj(o, f, loc=p0, quat=Quaternion(), scale=(1, 1, 1))
            continue
        for _ in range(sub):
            dt = 1 / FPS / sub
            if not resting:
                v.z -= g * dt
                p += v * dt
                if w.length > 1e-6:
                    q = Quaternion(w.normalized(), w.length * dt) @ q
                if p.z < floor and v.z < 0:
                    p.z = floor
                    v.z = -v.z * 0.28
                    v.x *= 0.5
                    v.y *= 0.5
                    w *= 0.45
                    if v.z < 0.12:
                        resting = True
            else:
                p.x += v.x * dt
                p.y += v.y * dt
                v *= 0.9
        if resting:
            up = q @ Vector((0, 0, 1))
            tgt = up.rotation_difference(Vector((0, 0, 1 if up.z >= 0 else -1))) @ q
            q = q.slerp(tgt, 0.35)
        s = 1.0
        if t > t_end:
            s = max(0.001, 1 - ease((t - t_end) / 0.22))
        key_vis(o, f, t <= t_end + 0.25)
        key_obj(o, f, loc=p, quat=q, scale=(s, s, s))


rs = random.Random(17)
ZC = PANEL_Z["CHAT"]
C0 = ui3(*SHATTER_C, ZC)
for poly, cen, area, ej, dist in shatter_cells():
    if not ej:
        continue
    pts = []
    for x, y in poly:                                  # 往里缩 1.4 px，碎块之间有缝
        dx, dy = x - cen[0], y - cen[1]
        L = math.hypot(dx, dy) + 1e-6
        k = max(0.0, (L - 1.4) / L)
        pts.append(((dx * k) * PX, -(dy * k) * PX))
    o = prism("shard", pts, 0.0024, M_GLASS)
    pos = ui3(*cen, ZC + 0.0024 + 0.0003)
    dirv = Vector((cen[0] - SHATTER_C[0], -(cen[1] - SHATTER_C[1]), 0))
    dirv = dirv.normalized() if dirv.length > 1e-6 else Vector((1, 0, 0))
    u = dist / EJECT_R
    size = math.sqrt(area)
    v0 = dirv * rs.uniform(0.12, 0.32) * (0.6 + u) + Vector((0, 0, rs.uniform(0.45, 0.95) * (1.25 - 0.5 * u)))
    ax = Vector((rs.uniform(-1, 1), rs.uniform(-1, 1), rs.uniform(-0.3, 0.3))).normalized()
    w0 = ax * rs.uniform(7, 16) * min(1.6, 28 / max(size, 8))
    simulate(o, pos, v0, w0, T["pop"] + dist / 1800, ZC + 0.0027)
# 细小的玻璃渣
for i in range(46):
    a = rs.uniform(0, math.tau)
    rr = rs.uniform(0, EJECT_R * 0.9)
    n = rs.randint(3, 5)
    sz_ = rs.uniform(0.0009, 0.0028)
    pts = [(math.cos(j / n * math.tau + rs.uniform(-0.4, 0.4)) * sz_ * rs.uniform(0.6, 1.2),
            math.sin(j / n * math.tau + rs.uniform(-0.4, 0.4)) * sz_ * rs.uniform(0.6, 1.2)) for j in range(n)]
    o = prism("dust", pts, 0.0012, M_GLASS)
    pos = C0 + Vector((math.cos(a) * rr * PX, math.sin(a) * rr * PX, 0.0015))
    v0 = Vector((math.cos(a), math.sin(a), 0)) * rs.uniform(0.2, 0.6) + Vector((0, 0, rs.uniform(0.7, 1.5)))
    ax = Vector((rs.uniform(-1, 1), rs.uniform(-1, 1), rs.uniform(-1, 1))).normalized()
    simulate(o, pos, v0, ax * rs.uniform(15, 35), T["pop"] + rs.uniform(0, 0.04), ZC + 0.0013)

# 冲击的一下闪光
fl = bpy.data.lights.new("flash", 'POINT')
fl.color = (0.8, 0.9, 1.0)
fl.shadow_soft_size = 0.02
flo = link(bpy.data.objects.new("flash", fl))
flo.location = C0 + Vector((0, -0.03, 0.07))
for t_, e_ in ((0.0, 0), (T["pop"] - 1 / FPS, 0), (T["pop"], 1.2), (T["pop"] + 0.04, 0.4), (T["pop"] + 0.1, 0)):
    fl.energy = e_
    fl.keyframe_insert("energy", frame=frame_of(t_))
# 只照玻璃的一盏小灯：让碎片有高光（灯光链接，不影响界面）
gl_ = bpy.data.lights.new("glint", 'AREA')
gl_.size = 0.35
gl_.energy = 45
gl_.color = (1.0, 0.95, 0.9)
glo = link(bpy.data.objects.new("glint", gl_))
glo.location = C0 + Vector((-0.35, -0.55, 0.75))
glo.rotation_mode = 'QUATERNION'
glo.rotation_quaternion = (C0 - glo.location).to_track_quat('-Z', 'Y')
glo.light_linking.receiver_collection = SHARD_COLL
burst("spark", 36, T["marker"], ui3(f_to_x(F0), db_to_y(-IL), PANEL_Z["PLOT"] + 0.02), [M_SPARK, M_SPARK2],
      0.003, 0.45, 1.0, 1.1, g=2.5, tri=False, seed=8)
burst("spark", 40, T["end_land"] + 0.3, ui3(1400, 735, PANEL_Z["END"] + 0.05), [M_SPARK, M_SPARK2],
      0.0035, 0.5, 1.2, 1.4, g=2.5, tri=False, seed=11)

# ---------------------------------------------------------------- 灯光（不进 UI 的反射）
def area(name, loc, target, size, power, color):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.size = size
    ld.energy = power
    ld.color = color
    o = link(bpy.data.objects.new(name, ld))
    o.location = loc
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y')
    o.visible_glossy = False
    return o


area("key", (-1.2, -1.6, 2.2), (0, 0, 0), 1.6, 260, (1.0, 0.86, 0.74))
area("rim", (1.4, 2.4, 1.0), (0, 0, 0.05), 1.2, 220, (1.0, 0.62, 0.38))
area("top", (0.0, 0.3, 2.6), (0, 0, 0), 2.0, 120, (0.9, 0.92, 1.0))

world = bpy.data.worlds.new("studio")
sc.world = world
bg = world.node_tree.nodes.get("Background")
bg.inputs["Color"].default_value = (0.010, 0.0065, 0.0045, 1)
bg.inputs["Strength"].default_value = 1.0

# ---------------------------------------------------------------- 合成：辉光
tree = bpy.data.node_groups.new("Comp", "CompositorNodeTree")
tree.interface.new_socket(name="Image", in_out='OUTPUT', socket_type='NodeSocketColor')
rl = tree.nodes.new("CompositorNodeRLayers")
gl = tree.nodes.new("CompositorNodeGlare")
out = tree.nodes.new("NodeGroupOutput")
try:
    gl.inputs["Type"].default_value = 'Bloom'
    gl.inputs["Quality"].default_value = 'High'
except Exception as e:
    print("glare enum", e)
gl.inputs["Threshold"].default_value = 0.85
gl.inputs["Strength"].default_value = 0.45
gl.inputs["Size"].default_value = 0.6
tree.links.new(rl.outputs["Image"], gl.inputs["Image"])
tree.links.new(gl.outputs["Image"], out.inputs[0])
sc.compositing_node_group = tree
sc.render.use_compositing = True

os.makedirs(BUILD, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, "promo.blend"))
print("SAVED")
