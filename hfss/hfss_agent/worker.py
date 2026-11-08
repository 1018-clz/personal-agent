"""跑一个任务 (一个 AEDT)。由 runner 启动: python -m hfss_agent.worker <job_id>"""
import json
import shutil
import sys
import time
import traceback

from . import jobs
from .recipes import ALL


class Ctx:
    """配方跑任务时需要的东西: 文件放哪、用几核、怎么汇报进度。"""

    def __init__(self, job):
        self.job_id = job["id"]
        self.cores = job["cores"]
        self.dir = jobs.RUNS / job["id"]
        self.project = self.dir / job["request"].get("filename", "model.aedt")

    def stage(self, text):
        jobs.set_stage(self.job_id, text)
        print(f"[{time.strftime('%H:%M:%S')}] {text}", flush=True)


def main():
    job = jobs.get(sys.argv[1])
    ctx = Ctx(job)
    t0 = time.time()
    try:
        result = ALL[job["recipe"]].run(job["request"], ctx)
    except (ValueError, RuntimeError) as e:  # 配方写好的错误信息, 直接给大模型看; 完整堆栈留在 worker.log
        traceback.print_exc()
        jobs.fail(job["id"], str(e))
        sys.exit(1)
    except Exception:
        jobs.fail(job["id"], traceback.format_exc()[-3000:])
        raise
    result.update(job_id=job["id"], seconds=round(time.time() - t0), cores=ctx.cores)
    (ctx.dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.rmtree(ctx.project.with_suffix(".aedtresults"), ignore_errors=True)  # 数字都提出来了, 省硬盘; 工程本身留着
    jobs.finish(job["id"], result)


if __name__ == "__main__":
    main()
