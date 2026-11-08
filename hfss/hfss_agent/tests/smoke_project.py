"""通用工程的冒烟测试: 走完 inspect → run, 跑真实的 HFSS。工程内容会变, 所以这里只查流程, 不比具体数字。

运行 (在 hfss 目录): ..\\.hfss\\env\\Scripts\\python.exe -m hfss_agent.tests.smoke_project [天线工程.aedt [设计名]]
天线工程不随仓库发布, 给了路径才测远场 (原来用的是 ant_23p8.aedt 的 GPS_23p8x4)。
"""
import asyncio
import json
import sys
from pathlib import Path

from mcp import Client

from hfss_agent.tests.smoke_client import SERVER, call

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FILTER = str(FIXTURES / "dr6g" / "dr6g.aedt")  # 两端口, 没有辐射边界
ANTENNA = sys.argv[1] if len(sys.argv) > 1 else None  # 单端口, 有辐射边界; 不随仓库发布
ANTENNA_DESIGN = sys.argv[2] if len(sys.argv) > 2 else "GPS_23p8x4"


async def done(c, job_id):
    while True:
        j = await call(c, "get_job", job_id=job_id, wait_seconds=50)
        if j["state"] not in ("queued", "running"):
            assert j["state"] == "done", j
            return j["result"]


async def main():
    async with Client(SERVER) as c:
        s = await call(c, "inspect_project", project=FILTER, force=True)
        designs = (await done(c, s["job_id"]))["metrics"]["designs"]
        print("设计:", [(d["design"], d["solution_type"], d["ports"]) for d in designs])

        s = await call(c, "run_project", project=FILTER, design="FILTER", force=True)
        r = await done(c, s["job_id"])
        print(json.dumps(r["metrics"]["s"]["passband"], ensure_ascii=False, default=str))
        assert r["converged"] and "far_field" not in r["metrics"], r

        if ANTENNA:
            s = await call(c, "run_project", project=ANTENNA, design=ANTENNA_DESIGN, force=True)
            r = await done(c, s["job_id"])
            print(json.dumps(r["metrics"]["far_field"], ensure_ascii=False, default=str))
            assert r["converged"] and len(r["metrics"]["far_field"]) == 1, r
        else:
            print("没给天线工程, 跳过远场")

        s = await call(c, "run_project", project=FILTER, design="FILTER", variables={"D": 10}, force=True)
        while (j := await call(c, "get_job", job_id=s["job_id"], wait_seconds=50))["state"] in ("queued", "running"):
            pass
        assert j["state"] == "failed" and "没写单位" in j["error"], j
        print("没写单位的变量被挡下:", j["error"][:60])


if __name__ == "__main__":
    asyncio.run(main())
