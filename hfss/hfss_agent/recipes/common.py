"""所有配方共用: 网格档位和收敛判定。

收敛规则来自这个项目踩过的坑: 同一个滤波器换一套网格, S11 谷底能差好几 dB。
所以每个结果都要带上"这个数字能用来干什么", 不能只给数字。
"""
import os
import re
from pathlib import Path

from ..jobs import settings


def installed_aedt_versions(env=None):
    """装了哪些 AEDT, 新的在前, 例如 ["2025.2", "2024.2"]。安装程序为每个版本设一个 ANSYSEM_ROOT<年后两位><版本号>。"""
    env = os.environ if env is None else env
    found = []
    for key, value in env.items():
        m = re.fullmatch(r"ANSYSEM_ROOT(\d{2})(\d)", key.upper())
        if m and value and Path(value).exists():
            found.append(f"20{m.group(1)}.{m.group(2)}")
    return sorted(set(found), reverse=True)


def aedt_version():
    """用哪个 AEDT: settings.json 里写的 aedt_version, 否则装了的最新版。一个都没找到就报错, 不让 pyaedt 去猜。"""
    chosen = settings().get("aedt_version")
    if chosen:
        return str(chosen)
    versions = installed_aedt_versions()
    if not versions:
        raise RuntimeError("没找到 Ansys Electronics Desktop: 环境变量里没有 ANSYSEM_ROOTxxx。请先安装 AEDT, "
                           "或在数据目录的 settings.json 里写 aedt_version")
    return versions[0]

# dS: 驱动模 ΔS 判据; dfreq: 本征模频率判据 (%); minconv: 连续几次达标才算收敛; passes: 最多加密几次
MESH = {
    "coarse": {"dS": 0.02, "dfreq": 0.2, "minconv": 1, "passes": 15, "timeout_min": 60,
               "desc": "粗网格: 扫参数、看趋势"},
    "fine": {"dS": 0.005, "dfreq": 0.05, "minconv": 2, "passes": 20, "timeout_min": 240,
             "desc": "细网格: 写进文档或用来做决定的数字"},
    "verify": {"dS": 0.002, "dfreq": 0.02, "minconv": 2, "passes": 25, "timeout_min": 480,
               "desc": "复核: 在标称点上检查 fine 的结果是否已经收敛"},
}


def export_modes(hfss, setup, path):
    """导出本征模结果, 返回 [(f_GHz, Q), ...]。解析方法和 dr_model.export_modes 相同, 这里 setup 名字可以变。"""
    path = Path(path)
    hfss.osolution.ExportEigenmodes(f"{setup} : LastAdaptive", "", str(path))
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
            out.append((round(f, 4), nums[-1] if len(nums) >= 3 else None))
    return out


def parse_convergence(txt):
    """解析 hfss.export_convergence 导出的文本。"""
    rows = [ln.split("|") for ln in txt.splitlines() if ln.strip()[:1].isdigit() and "|" in ln]
    conv = re.search(r"Converged\s*:\s*(\w+)", txt)
    cur = re.search(r"Current\s*:\s*([\d.eE+-]+)", txt)
    crit = re.search(r"Criterion\s*:\s*(.+)", txt)
    target = re.search(r"Target\s*:\s*([\d.eE+-]+)", txt)
    return {"converged": bool(conv) and conv.group(1).lower() == "yes", "passes": len(rows),
            "tets": int(rows[-1][1]) if rows else None, "criterion": crit.group(1).strip() if crit else None,
            "target": float(target.group(1)) if target else None, "final_delta": float(cur.group(1)) if cur else None}


def judge(conv, criterion, target):
    """核对求解器真的按要求的判据收敛了 (pyaedt 1.x 会悄悄丢掉 MaxDeltaS, 不查发现不了)。返回 (可信吗, 警告)。"""
    if criterion not in (conv["criterion"] or "") or conv["target"] != target:
        return False, [f"求解器实际用的判据是 {conv['criterion']} = {conv['target']}, 不是要求的 {criterion} = {target}"]
    if not conv["converged"]:
        return False, [f"加密 {conv['passes']} 次还没收敛: 最后 {conv['final_delta']}, 目标 {target}"]
    return True, []


def verdict(mesh, converged):
    """这次结果能用来干什么。"""
    if not converged:
        return "未收敛: 数字不可信, 不能用于任何判断"
    return {"coarse": "粗网格已收敛: 只能看趋势, 不能写进文档或用来做决定",
            "fine": "细网格已收敛: 可以用于决定; 最终标称点还要用 verify 档复核一次",
            "verify": "复核档已收敛: 和同参数的 fine 结果对比, 差得不多才算真正收敛"}[mesh]
