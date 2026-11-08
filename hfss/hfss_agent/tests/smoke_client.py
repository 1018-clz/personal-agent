"""端到端冒烟测试: 像真正的客户端一样, 通过 stdio 连上 MCP 服务, 用工具跑真实的 HFSS。

运行 (在 hfss 目录): ..\\.hfss\\env\\Scripts\\python.exe -m hfss_agent.tests.smoke_client
第 2 步的默认几何要对上历史结果 (AEDT 2025 R2, ΔS 0.02): f0 3500.4 MHz, IL 0.387 dB, BW 9.7 MHz。
"""
import asyncio
import json
import sys

from mcp import Client, StdioServerParameters

from hfss_agent.jobs import ROOT

SERVER = StdioServerParameters(command=sys.executable, args=["-m", "hfss_agent.server"], cwd=str(ROOT))


async def call(c, name, **args):
    r = await c.call_tool(name, args)
    if r.is_error:
        raise RuntimeError(r.content[0].text)
    return r.structured_content or json.loads(r.content[0].text)


async def wait(c, job_id):
    while True:
        j = await call(c, "get_job", job_id=job_id, wait_seconds=50)
        print("  ", {k: j.get(k) for k in ("state", "stage", "elapsed_s", "cores") if j.get(k) is not None}, flush=True)
        if j["state"] not in ("queued", "running"):
            return j


async def main():
    async with Client(SERVER) as c:
        tools = await c.list_tools()
        print("工具:", [t.name for t in tools.tools])
        info = await call(c, "list_recipes")
        print("配方:", [r["name"] for r in info["recipes"]], "网格档位:", list(info["mesh_levels"]))

        print("① 本征模 (默认几何, 粗网格)")
        s = await call(c, "submit_simulation", recipe="dr_filter", analysis="eigenmode")
        print("  ", s)
        j = await wait(c, s["job_id"])
        assert j["state"] == "done", j
        print(json.dumps(j["result"], ensure_ascii=False, indent=2))
        te = j["result"]["metrics"]["te01d_ghz"]

        print(f"② 驱动模 (f0_ghz=3.5, 粗网格) 本征模算出 {te} GHz")
        s = await call(c, "submit_simulation", recipe="dr_filter", analysis="driven", f0_ghz=3.5)
        print("  ", s)
        j = await wait(c, s["job_id"])
        assert j["state"] == "done", j
        print(json.dumps(j["result"], ensure_ascii=False, indent=2))

        print("③ 相同请求要直接复用, 不能再算一遍")
        s = await call(c, "submit_simulation", recipe="dr_filter", analysis="driven", f0_ghz=3.5)
        assert s["reused"] and s["state"] == "done", s
        print("   reused:", s["job_id"])


if __name__ == "__main__":
    asyncio.run(main())
