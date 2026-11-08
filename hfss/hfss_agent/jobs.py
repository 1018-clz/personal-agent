"""任务库: 所有任务记在 jobs.db (SQLite), 每个任务的文件在 runs/<job_id>/。

MCP 服务、后台 runner、worker 是三个独立进程, 只通过这个库沟通, 所以客户端退出后任务照跑。
状态: queued → running → done / failed / cancelled

数据目录 (jobs.db、runs/、snapshots/、日志) 不放在代码旁边: 装好的程序目录可能只读, 仿真结果又可能有几十 GB。
由环境变量 HFSS_AGENT_DATA 指定 (桌面应用把它设成 %LOCALAPPDATA%/personal-agent/hfss),
没设时用代码旁边的 data/, 方便开发。本机参数的覆盖写在数据目录的 settings.json 里, 见 settings()。
"""
import hashlib
import json
import msvcrt
import os
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

HOME = Path(__file__).resolve().parent
ROOT = HOME.parent  # python -m hfss_agent.xxx 在这里运行
DATA = Path(os.environ.get("HFSS_AGENT_DATA") or ROOT / "data").resolve()
DB = DATA / "jobs.db"
RUNS = DATA / "runs"
RUNNER_LOCK = DATA / "runner.lock"
SETTINGS = DATA / "settings.json"


def settings():
    """用户写的本机参数覆盖, 例如 {"aedt_version": "2024.2", "max_jobs": 2, "cores_alone": 8}。没有就是 {}。

    不用环境变量: runner 是经 WMI 启动的, 拿不到客户端进程的环境变量, 只能从数据目录读。
    """
    try:
        data = json.loads(SETTINGS.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    recipe TEXT NOT NULL,
    analysis TEXT NOT NULL,
    mesh TEXT NOT NULL,
    fingerprint TEXT NOT NULL,      -- 请求的指纹, 一模一样的请求不重复仿真
    request TEXT NOT NULL,          -- 完整请求 (JSON)
    timeout_min INTEGER NOT NULL,
    state TEXT NOT NULL,
    stage TEXT,                     -- 进行到哪一步 (给人看)
    cores INTEGER,
    pid INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created REAL NOT NULL,
    started REAL,
    finished REAL,
    result TEXT,                    -- 结果 (JSON)
    error TEXT
)"""


@contextmanager
def _db():
    DATA.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=30, isolation_level=None)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute(SCHEMA)
        yield con
    finally:
        con.close()


def _row(r):
    d = dict(r)
    d["request"] = json.loads(d["request"])
    d["result"] = json.loads(d["result"]) if d["result"] else None
    return d


def fingerprint(request):
    """sweep 只是分组标签, 不影响算什么: 扫参里和以前一模一样的点照样复用旧结果。"""
    same = {k: v for k, v in request.items() if k != "sweep"}
    return hashlib.sha1(json.dumps(same, sort_keys=True).encode()).hexdigest()


def submit(request, timeout_min, force=False):
    """登记一个任务。同样的请求已经算过 (或正在算) 就直接返回那个任务, 除非 force。返回 (任务, 是否复用)。"""
    fp = fingerprint(request)
    with _db() as con:
        if not force:
            r = con.execute("SELECT * FROM jobs WHERE fingerprint=? AND state IN ('queued','running','done') "
                            "ORDER BY created DESC LIMIT 1", (fp,)).fetchone()
            if r:
                return _row(r), True
        jid = time.strftime("j%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        con.execute("INSERT INTO jobs (id, recipe, analysis, mesh, fingerprint, request, timeout_min, state, created) "
                    "VALUES (?,?,?,?,?,?,?,'queued',?)",
                    (jid, request["recipe"], request["analysis"], request["mesh"], fp,
                     json.dumps(request, ensure_ascii=False), timeout_min, time.time()))
        return get(jid), False


def get(job_id):
    with _db() as con:
        r = con.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return _row(r) if r else None


def listing(limit=20, recipe=None, state=None):
    sql, args = "SELECT * FROM jobs WHERE 1=1", []
    if recipe:
        sql += " AND recipe=?"
        args.append(recipe)
    if state:
        sql += " AND state=?"
        args.append(state)
    with _db() as con:
        return [_row(r) for r in con.execute(sql + " ORDER BY created DESC LIMIT ?", (*args, limit))]


def with_state(state):
    """按提交先后排好的某状态全部任务。"""
    with _db() as con:
        return [_row(r) for r in con.execute("SELECT * FROM jobs WHERE state=? ORDER BY created", (state,))]


def claim(job_id, cores):
    with _db() as con:
        con.execute("UPDATE jobs SET state='running', stage='启动 AEDT', cores=?, started=? WHERE id=? AND state='queued'",
                    (cores, time.time(), job_id))


def set_pid(job_id, pid):
    with _db() as con:
        con.execute("UPDATE jobs SET pid=? WHERE id=?", (pid, job_id))


def set_stage(job_id, stage):
    with _db() as con:
        con.execute("UPDATE jobs SET stage=? WHERE id=?", (stage, job_id))


def finish(job_id, result):
    with _db() as con:
        con.execute("UPDATE jobs SET state='done', stage=NULL, finished=?, result=? WHERE id=? AND state='running'",
                    (time.time(), json.dumps(result, ensure_ascii=False), job_id))


def fail(job_id, error, state="failed"):
    """只有 running 的任务才会被改, 所以 worker 刚写完 done 时 runner 不会把它盖成 failed。"""
    with _db() as con:
        con.execute("UPDATE jobs SET state=?, stage=NULL, finished=?, error=? WHERE id=? AND state='running'",
                    (state, time.time(), error, job_id))


def cancel(job_id):
    """排队中的直接取消; 正在跑的打个标记, runner 下一轮杀掉进程。"""
    with _db() as con:
        con.execute("UPDATE jobs SET state='cancelled', finished=? WHERE id=? AND state='queued'",
                    (time.time(), job_id))
        con.execute("UPDATE jobs SET cancel_requested=1 WHERE id=? AND state='running'", (job_id,))
    return get(job_id)


def runner_alive():
    """runner 活着时占着这把锁 (进程一死, 系统自动释放, 不会有残留锁)。"""
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        fd = open(RUNNER_LOCK, "a+b")
    except OSError:
        return True
    try:
        fd.seek(0)
        msvcrt.locking(fd.fileno(), msvcrt.LK_NBLCK, 1)
        msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
        return False
    except OSError:
        return True
    finally:
        fd.close()


def ensure_runner():
    """有任务排队时保证 runner 在跑。

    用 WMI 启动而不是 subprocess: MCP 客户端可能把服务进程放进 Job Object, 客户端一退出, 里面所有子进程都会被杀,
    breakaway 也可能被拒绝。WMI 创建的进程不在这个 Job 里, 跑了几小时的仿真不会因为关掉聊天窗口而中断。
    """
    if runner_alive():
        return
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    # 数据目录放在命令行里: WMI 启动的进程拿不到这个进程的环境变量
    cmd = f'"{pythonw}" -m hfss_agent.runner --data "{DATA}"'
    ps = (f"Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
          f"-Arguments @{{CommandLine='{cmd}'; CurrentDirectory='{ROOT}'}} | ForEach-Object ReturnValue")
    r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True,
                       text=True, timeout=60, creationflags=subprocess.CREATE_NO_WINDOW)
    if r.stdout.strip() != "0":
        raise RuntimeError(f"启动后台 runner 失败: {r.stdout} {r.stderr}")
