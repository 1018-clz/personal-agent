"""环境自检: 用户装好之后, 第一个问题总是"为什么跑不了"。逐项查, 哪项不过就说怎么修。

只查不改, 也不启动 AEDT (那要半分钟, 还占许可证)。许可证只能查到服务器连不连得上,
有没有空闲的 HFSS 许可要真正求解时才知道。
"""
import importlib.metadata
import importlib.util
import os
import re
import shutil
import socket
from pathlib import Path

from . import jobs
from .recipes.common import installed_aedt_versions

LOW_DISK_GB, NO_DISK_GB = 20, 5
LICENSE_TIMEOUT_S = 3


def _item(name, level, detail, fix=None):
    return {"name": name, "level": level, "detail": detail, **({"fix": fix} if fix else {})}


def _aedt_root(version, env):
    """'2025.2' → ANSYSEM_ROOT252 的值。"""
    y, r = version.split(".")
    return env.get(f"ANSYSEM_ROOT{y[2:]}{r}")


def check_aedt(env):
    versions = installed_aedt_versions(env)
    if not versions:
        return _item("AEDT", "fail", "没找到 Ansys Electronics Desktop (环境变量里没有 ANSYSEM_ROOTxxx)",
                     "安装 AEDT; 装好后重启本应用, 让它读到安装程序设置的环境变量")
    chosen = str(jobs.settings().get("aedt_version") or versions[0])
    root = _aedt_root(chosen, env) if re.fullmatch(r"20\d\d\.\d", chosen) else None
    if not root:
        return _item("AEDT", "fail", f"settings.json 指定了 {chosen}, 但本机装的是 {', '.join(versions)}",
                     f"把数据目录 settings.json 里的 aedt_version 改成 {versions[0]}, 或删掉这一项")
    exe = Path(root) / "ansysedt.exe"
    if not exe.exists():
        return _item("AEDT", "fail", f"{chosen} 的目录里没有 ansysedt.exe: {root}", "AEDT 可能没装完整, 重新安装或修复")
    others = f" (本机还有 {', '.join(v for v in versions if v != chosen)})" if len(versions) > 1 else ""
    return _item("AEDT", "ok", f"用 {chosen}: {root}{others}")


def license_servers(env, aedt_root=None):
    """FlexLM 许可证服务器 [(端口, 主机)]: 先看环境变量, 再看 Ansys 的 ansyslmd.ini。"""
    text = ";".join(env.get(k, "") for k in ("ANSYSLMD_LICENSE_FILE", "LM_LICENSE_FILE"))
    if not text.strip(";") and aedt_root:
        for parent in Path(aedt_root).parents:
            ini = parent / "Shared Files" / "Licensing" / "ansyslmd.ini"
            if ini.exists():
                text = ";".join(ln.split("=", 1)[1] for ln in ini.read_text(errors="ignore").splitlines()
                                if ln.upper().startswith("SERVER="))
                break
    out = []
    for part in re.split(r"[;,]", text):
        m = re.fullmatch(r"\s*(\d+)@([\w.-]+)\s*", part)
        if m:
            out.append((int(m.group(1)), m.group(2)))
    return out


def check_license(env):
    versions = installed_aedt_versions(env)
    root = _aedt_root(versions[0], env) if versions else None
    servers = license_servers(env, root)
    if not servers:
        return _item("许可证", "warn", "没找到许可证服务器设置 (ANSYSLMD_LICENSE_FILE 或 ansyslmd.ini)",
                     "用 Ansys License Settings 工具设好许可证服务器; 如果是本机节点锁定许可, 可以忽略这条")
    reached, failed = [], []
    for port, host in servers:
        try:
            with socket.create_connection((host, port), timeout=LICENSE_TIMEOUT_S):
                reached.append(f"{port}@{host}")
        except OSError as e:
            failed.append(f"{port}@{host} ({e.__class__.__name__})")
    if reached:
        return _item("许可证", "ok", f"许可证服务器连得上: {', '.join(reached)} (有没有空闲的 HFSS 许可, 求解时才知道)")
    return _item("许可证", "fail", f"许可证服务器都连不上: {', '.join(failed)}",
                 "检查网络或 VPN, 确认许可证服务器开着; 在公司外面通常要先连 VPN")


def check_pyaedt():
    if importlib.util.find_spec("ansys.aedt.core") is None:
        return _item("PyAEDT", "fail", "这个 Python 环境里没有 PyAEDT", "在应用里点「安装 HFSS 环境」, 或运行 npm.cmd run install-hfss")
    try:
        version = importlib.metadata.version("pyaedt")
    except importlib.metadata.PackageNotFoundError:
        version = "未知版本"
    return _item("PyAEDT", "ok", f"PyAEDT {version}")


def check_disk():
    try:
        jobs.DATA.mkdir(parents=True, exist_ok=True)
        probe = jobs.DATA / ".write-test"
        probe.write_text("ok")
        probe.unlink()
    except OSError as e:
        return _item("数据目录", "fail", f"{jobs.DATA} 写不进去: {e}", "在 config.json 里用 hfss.dataDir 换一个能写的目录")
    free = shutil.disk_usage(jobs.DATA).free / 2**30
    detail = f"{jobs.DATA}, 剩余 {free:.0f} GB"
    if free < NO_DISK_GB:
        return _item("数据目录", "fail", detail, "磁盘快满了: 清理旧任务 (数据目录的 runs/), 或用 hfss.dataDir 换到空间大的盘")
    if free < LOW_DISK_GB:
        return _item("数据目录", "warn", detail, "一次仿真可能写几 GB, 建议清理旧任务或换到空间大的盘")
    return _item("数据目录", "ok", detail)


def check_runner():
    queued, running = jobs.with_state("queued"), jobs.with_state("running")
    alive = jobs.runner_alive()
    if (queued or running) and not alive:
        return _item("后台任务", "warn", f"有 {len(queued)} 个排队、{len(running)} 个运行中的任务, 但后台 runner 没在跑",
                     "查一次任务 (get_job) 会自动把它拉起来; 运行中的任务会被标成失败, 需要重新提交")
    state = "运行中" if alive else "空闲 (有任务时自动启动)"
    return _item("后台任务", "ok", f"runner {state}; 排队 {len(queued)} 个, 运行中 {len(running)} 个")


def check_machine():
    try:
        import psutil

        from .runner import parallel_limits

        cores, gb = psutil.cpu_count(logical=False), psutil.virtual_memory().total / 2**30
        max_jobs, alone, shared, _ = parallel_limits(cores, gb, jobs.settings())
        return _item("本机", "ok", f"{cores} 个物理核, {gb:.0f} GB 内存: 单个任务用 {alone} 核, 最多同时 {max_jobs} 个任务 (各 {shared} 核)")
    except Exception as e:  # noqa: BLE001 只是信息, 查不到不影响仿真
        return _item("本机", "warn", f"查不到核数和内存: {e}")


def check(env=None):
    env = os.environ if env is None else env
    items = [check_aedt(env), check_license(env), check_pyaedt(), check_disk(), check_runner(), check_machine()]
    return {"ok": all(i["level"] != "fail" for i in items), "items": items}
