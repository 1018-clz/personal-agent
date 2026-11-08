"""后台排队进程: 决定什么时候开新的 AEDT, 并处理取消、超时、内存不足。

有任务时由 jobs.ensure_runner 自动拉起, 空闲一会儿自己退出。状态全在 jobs.db 里, 随时重启都不丢任务。
启动方式: pythonw -m hfss_agent.runner --data <数据目录>。

并行参数按本机的核数和内存算 (见 parallel_limits), 规则来自一台 i9-14900K / 48 GB 的实测:
单个任务 16 核就到头了, 再多不会更快; 扫参数时 3 个任务各 8 核最划算,
3 × 8 跑 10 万网格时内存峰值 45 GB, 已经到边了, 所以大约每个并行任务要 16 GB 内存。
"""
import msvcrt
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# 在 import jobs 之前: jobs 在导入时就按 HFSS_AGENT_DATA 定好数据目录, 而 WMI 启动的 runner 没有这个环境变量
if "--data" in sys.argv:
    os.environ["HFSS_AGENT_DATA"] = sys.argv[sys.argv.index("--data") + 1]

import psutil  # noqa: E402

from . import jobs  # noqa: E402

GB_PER_JOB = 16  # 一个并行任务大约要的内存 (10 万网格、8 核)


def parallel_limits(physical_cores, total_gb, overrides=None):
    """(同时最多几个任务, 只有一个任务时几核, 多个任务时每个几核, 已有任务时开新任务至少要多少空闲内存 GB)。

    overrides: settings.json 里的 max_jobs / cores_alone / cores_shared / min_free_gb, 用户的机器用户最清楚。
    """
    o = overrides or {}
    cores = max(1, physical_cores or 1)
    alone = int(o.get("cores_alone") or min(16, cores))
    shared = int(o.get("cores_shared") or max(1, min(8, cores // 3)))
    # Windows reports a bit less than the installed memory (48 GB shows as 47.8), so allow for rounding.
    max_jobs = int(o.get("max_jobs") or max(1, min(3, cores // shared, int(total_gb / GB_PER_JOB + 0.1))))
    min_free = float(o.get("min_free_gb") or min(GB_PER_JOB, total_gb / 3))
    return max_jobs, alone, shared, min_free


MAX_JOBS, CORES_ALONE, CORES_SHARED, MIN_FREE_GB = parallel_limits(
    psutil.cpu_count(logical=False), psutil.virtual_memory().total / 2**30, jobs.settings())
KILL_FREE_GB = 1.5  # 空闲内存低于这个数: 杀掉最晚开始的任务, 不让机器卡死
START_GAP_S = 5  # 错开几个 AEDT 的启动
IDLE_EXIT_S = 120
POLL_S = 2

PYTHON = Path(sys.executable).with_name("python.exe")


def log(msg):
    with open(jobs.DATA / "runner.log", "a", encoding="utf-8") as fh:
        fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")


def kill_tree(pid):
    """连同它拉起来的 AEDT 和求解器一起杀掉。"""
    try:
        root = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return
    procs = root.children(recursive=True) + [root]
    for p in procs:
        try:
            p.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(procs, timeout=15)


def stop(job, error, state="failed"):
    """终止一个任务。没跑完的结果文件可能有几个 GB, 留着没用。"""
    kill_tree(job["pid"])
    for d in (jobs.RUNS / job["id"]).glob("*.aedtresults"):
        shutil.rmtree(d, ignore_errors=True)
    jobs.fail(job["id"], error, state)
    log(f"{job['id']} {error}")


def log_tail(job_id, n=15):
    p = jobs.RUNS / job_id / "worker.log"
    if not p.exists():
        return ""
    return "\n".join(p.read_text(encoding="utf-8", errors="replace").splitlines()[-n:])


def check_running():
    """收尾已经结束的任务, 处理取消和超时。"""
    for j in jobs.with_state("running"):
        if j["pid"] is None:
            continue
        if not psutil.pid_exists(j["pid"]):  # 正常结束时 worker 已经写好状态, 这里的 fail 不会生效
            jobs.fail(j["id"], "worker 进程意外退出:\n" + log_tail(j["id"]))
        elif j["cancel_requested"]:
            stop(j, "用户取消", state="cancelled")
        elif time.time() - j["started"] > j["timeout_min"] * 60:
            stop(j, f"超过 {j['timeout_min']} 分钟, 已终止")


def check_memory():
    running = [j for j in jobs.with_state("running") if j["pid"]]
    if running and psutil.virtual_memory().available / 2**30 < KILL_FREE_GB:
        stop(max(running, key=lambda r: r["started"]),
             f"机器空闲内存低于 {KILL_FREE_GB} GB, 已终止这个任务: 网格太大, 换低一档或减少并行")


def start_next(last_start):
    """条件允许就开一个新任务, 返回最后一次开任务的时间。"""
    running, queued = jobs.with_state("running"), jobs.with_state("queued")
    if not queued or len(running) >= MAX_JOBS or time.time() - last_start < START_GAP_S:
        return last_start
    if running and psutil.virtual_memory().available / 2**30 < MIN_FREE_GB:
        return last_start
    job = queued[0]
    cores = CORES_ALONE if len(running) + len(queued) == 1 else CORES_SHARED
    d = jobs.RUNS / job["id"]
    d.mkdir(parents=True, exist_ok=True)
    jobs.claim(job["id"], cores)
    try:
        with open(d / "worker.log", "ab") as fh:
            p = subprocess.Popen([str(PYTHON), "-m", "hfss_agent.worker", job["id"]], cwd=jobs.ROOT, stdout=fh,
                                 stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                 env=dict(os.environ, PYTHONIOENCODING="utf-8"),
                                 creationflags=subprocess.CREATE_NO_WINDOW)
    except OSError as e:
        jobs.fail(job["id"], f"启动 worker 失败: {e}")
        return last_start
    jobs.set_pid(job["id"], p.pid)
    log(f"{job['id']} 开始, {cores} 核, pid {p.pid}")
    return time.time()


def main():
    fd = open(jobs.RUNNER_LOCK, "a+b")
    try:
        fd.seek(0)
        msvcrt.locking(fd.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        return  # 已经有一个 runner 在跑
    log(f"runner 启动: 数据目录 {jobs.DATA}, 最多 {MAX_JOBS} 个任务, 单独 {CORES_ALONE} 核 / 并行各 {CORES_SHARED} 核, "
        f"开新任务至少要 {MIN_FREE_GB:.0f} GB 空闲内存")
    last_start, idle_from = 0.0, time.time()
    while True:
        check_running()
        check_memory()
        last_start = start_next(last_start)
        if jobs.with_state("running") or jobs.with_state("queued"):
            idle_from = time.time()
        elif time.time() - idle_from > IDLE_EXIT_S:
            break
        time.sleep(POLL_S)
    log("runner 空闲退出")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # pythonw 没有控制台, 不记下来就什么都看不到
        log(f"runner 崩溃: {e!r}")
        raise
