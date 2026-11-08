"""不启动 AEDT 的测试: 指标算法对上历史数据, 参数校验能拦住错误的请求, 任务库行为正确。

运行 (在 hfss 目录): ..\\.hfss\\env\\Scripts\\python.exe -m hfss_agent.tests.test_offline
"""
import asyncio
import json
import os
import shutil
import tempfile
from pathlib import Path

# 在 import jobs 之前: 测试写的任务库和快照都放进临时目录, 不碰真的数据目录
_TMP_DATA = tempfile.mkdtemp(prefix="hfss_agent_test_")
os.environ["HFSS_AGENT_DATA"] = _TMP_DATA

import numpy as np  # noqa: E402
from mcp import Client  # noqa: E402

from hfss_agent import doctor, jobs, pitfalls  # noqa: E402
from hfss_agent import server as S  # noqa: E402
from hfss_agent.curves import conv_passes, downsample, read_s, trace_name  # noqa: E402
from hfss_agent.metrics import bands_below, dips, filter_metrics, s_summary  # noqa: E402
from hfss_agent.recipes import dr_filter as R  # noqa: E402
from hfss_agent.recipes import project as P  # noqa: E402
from hfss_agent.recipes.common import installed_aedt_versions, judge, parse_convergence, verdict  # noqa: E402
from hfss_agent.runner import parallel_limits  # noqa: E402
from hfss_agent.server import mcp  # noqa: E402

# 历史数据, 来自原项目的 filter/dr_single、filter/dr6g 和 adapter/dra
FIXTURES = Path(__file__).resolve().parent / "fixtures"
DATA = FIXTURES / "dr_single"
# 历史数据是作者自己的设计, 不随公开仓库发布: 没有时, 依赖它的测试跳过, 其余照常跑
HAVE_FIXTURES = (FIXTURES / "dr6g" / "dr6g.aedt").exists()


class Skip(Exception):
    pass


def needs_fixtures(fn):
    def wrapped():
        if not HAVE_FIXTURES:
            raise Skip("没有历史数据 (tests/fixtures 不随公开仓库发布)")
        return fn()
    wrapped.__name__ = fn.__name__
    return wrapped


def expect_error(text, *args):
    try:
        R.prepare(*args)
    except ValueError as e:
        assert text in str(e), f"错误信息里没有 {text!r}: {e}"
        return
    raise AssertionError(f"应该报错但通过了: {args}")


@needs_fixtures
def test_metrics_match_history():
    """用 dr_single 历史结果核对: 算法从 02_filter.py 搬过来, 数字必须一模一样。"""
    recs = {json.loads(ln)["tag"]: json.loads(ln) for ln in open(DATA / "results_drv.jsonl", encoding="utf-8")}
    for tag in ("MVP", "M3", "M4"):
        d = np.loadtxt(DATA / "data" / f"{tag}_s.csv", delimiter=",", skiprows=1)
        m, warn = filter_metrics(d[:, 0], d[:, 1], d[:, 2], 3.5)
        rec = recs[tag]
        assert m["f0_mhz"] == rec["f0"] and m["il_db"] == rec["IL"] and m["bw3_mhz"] == rec["bw3"], (tag, m, rec)
        assert m["s11_at_f0_db"] == rec["S11_f0"] and m["s11_min"] == rec["S11_min"], (tag, m, rec)
        assert m["spurious"] == [p for p in rec["peaks"] if abs(p[0] - rec["f0"]) > 5], (tag, m, rec)
        assert not warn, (tag, warn)


def test_metrics_warnings():
    f = np.linspace(3.0, 4.6, 1601)
    flat = np.full_like(f, -40.0)
    assert any("没有通带" in w for w in filter_metrics(f, flat, flat, 3.5)[1]), "没有通带时要警告"
    # 真实谐振在 3.3 GHz, 不在 f0_ghz=3.5 的窗内: 峰值只能落在窗边缘
    lor = -10 * np.log10(1 + ((f - 3.3) / 0.005) ** 2)
    assert any("窗边缘" in w for w in filter_metrics(f, flat, lor, 3.5)[1]), "谐振不在窗内时要警告"
    # 通带比扫频范围还宽
    wide = np.linspace(3.45, 3.55, 101)
    m, warn = filter_metrics(wide, wide * 0 - 20, wide * 0 - 1, 3.5)
    assert m["bw3_mhz"] is None and any("带宽" in w for w in warn)


def test_prepare():
    req = R.prepare("eigenmode", {}, None, None, 1.0)
    assert req["params"]["D"] == 24.25 and req["params"]["er"] == 18 and req["params"]["layout"] == "90"
    assert req["f0_ghz"] is None
    req = R.prepare("driven", {"layout": 180}, 3.5, None, 1.0)
    assert req["band_ghz"] == [3.0, 4.6] and req["params"]["layout"] == "180"
    expect_error("没有参数 'dd'", "eigenmode", {"dd": 1}, None, None, 1.0)
    expect_error("超出范围", "eigenmode", {"D": 500}, None, None, 1.0)
    expect_error("要填数字", "eigenmode", {"D": "24mm"}, None, None, 1.0)
    expect_error("必须给 f0_ghz", "driven", {}, None, None, 1.0)
    expect_error("包住", "driven", {}, 3.5, [4.0, 5.0], 1.0)
    expect_error("没有分析类型", "transient", {}, None, None, 1.0)
    expect_error("横杆离陶瓷柱", "eigenmode", {"Lx": 5}, None, None, 1.0)
    expect_error("接地腿", "eigenmode", {"g": 3}, None, None, 1.0)
    expect_error("支撑柱", "eigenmode", {"Ds": 25}, None, None, 1.0)
    expect_error("腔高", "eigenmode", {"H": 10}, None, None, 1.0)


@needs_fixtures
def test_convergence_parse():
    txt = (FIXTURES / "dra" / "data" / "fin_L2_conv.prof").read_text(errors="ignore")
    c = parse_convergence(txt)
    assert c == {"converged": True, "passes": 13, "tets": 83852, "criterion": "Max Mag. Delta S", "target": 0.005,
                 "final_delta": 0.0033559}, c
    assert judge(c, "Delta S", 0.005) == (True, [])
    assert not judge(c, "Delta S", 0.02)[0], "判据和要求的不一样, 不能算收敛"
    assert not judge(c, "Delta Freq", 0.005)[0]
    assert not judge(dict(c, converged=False), "Delta S", 0.005)[0]
    assert "趋势" in verdict("coarse", True) and "不可信" in verdict("fine", False)


def test_job_store():
    """提交相同请求要复用, force 才新建; 状态只能从 running 走到结束状态。"""
    tmp = Path(tempfile.mkdtemp())
    db, jobs.DB = jobs.DB, tmp / "jobs.db"
    try:
        req = dict(R.prepare("eigenmode", {}, None, None, 1.0), recipe=R.NAME, analysis="eigenmode", mesh="coarse")
        a, reused = jobs.submit(req, 60)
        assert not reused and a["state"] == "queued"
        assert jobs.submit(req, 60)[1], "相同请求要复用"
        assert not jobs.submit(req, 60, force=True)[1], "force 要新建"
        b = jobs.with_state("queued")[1]
        assert jobs.cancel(b["id"])["state"] == "cancelled"
        jobs.claim(a["id"], 16)
        jobs.finish(a["id"], {"metrics": {}, "converged": True})
        jobs.fail(a["id"], "晚到的错误")  # 不能把 done 盖掉
        assert jobs.get(a["id"])["state"] == "done" and jobs.get(a["id"])["error"] is None
        assert jobs.listing(state="done")[0]["id"] == a["id"]
    finally:
        jobs.DB = db
        shutil.rmtree(tmp, ignore_errors=True)


@needs_fixtures
def test_s_metrics_match_history():
    """通用指标用 DRA 板和 dr6g 的历史结果核对。"""
    dra = FIXTURES / "dra"
    recs = [json.loads(ln) for ln in open(dra / "results.jsonl", encoding="utf-8")]
    n = 0
    for rec in recs[-30:]:
        path = dra / "data" / f"{rec['tag']}.csv"
        if not path.exists() or not rec["dips"]:
            continue
        d = np.loadtxt(path, delimiter=",", skiprows=1)
        got = dips(d[:, 0], d[:, 1], top=99)
        assert sorted(got) == sorted(map(list, rec["dips"])), (rec["tag"], got, rec["dips"])
        if rec["bw10"]:
            bands = bands_below(d[:, 0], d[:, 1])
            assert abs(bands[0][0] - rec["bw10"][0]) < 20 and abs(bands[-1][1] - rec["bw10"][1]) < 20, (rec["tag"], bands)
        n += 1
    assert n >= 3, "历史数据太少"

    rec = [json.loads(ln) for ln in open(FIXTURES / "dr6g" / "results_drv.jsonl", encoding="utf-8")]
    rec = [r for r in rec if r["tag"] == "MVP2"][-1]
    d = np.loadtxt(FIXTURES / "dr6g" / "data" / "MVP2_s.csv", delimiter=",", skiprows=1)
    m = s_summary(d[:, 0], {"S(1,1)": d[:, 1], "S(2,1)": d[:, 2]}, 7.87)
    pb = m["passband"]
    assert pb["f0_mhz"] == rec["f0"] and pb["il_db"] == rec["IL"] and pb["bw3_mhz"] == rec["bw3"], (pb, rec)
    assert not pb["notes"] and m["S(1,1)"]["min"][0] > 0 and m["S(2,1)"]["peaks"]


def test_s_summary_shapes():
    """单端口没有通带; 终端解的表达式是 St(...)。"""
    f = np.linspace(1.0, 2.0, 1001)
    y = -30 * np.exp(-((f - 1.5) / 0.02) ** 2)
    z = 50 + 0j * f
    m = s_summary(f, {"S(1,1)": y}, 1.5, {"S(1,1)": z})
    assert "passband" not in m and m["S(1,1)"]["min"] == [1500.0, -30.0], m
    assert m["S(1,1)"]["bands_10db_mhz"] == [[1479.0, 1521.0]], m
    assert m["S(1,1)"]["z_at_min_ohm"] == [50.0, 0.0]
    s21 = -40 + 39.5 * np.exp(-((f - 1.5) / 0.01) ** 2)
    m = s_summary(f, {"St(a,a)": y, "St(b,a)": s21}, 1.5)
    assert m["passband"]["f0_mhz"] == 1500.0, m
    edge = np.where(f < 1.2, -15.0, 0.0)  # 从扫频起点就低于 -10 dB
    assert bands_below(f, edge)[0][0] == 1000.0


def test_project_helpers():
    assert P.to_ghz("1.5GHz") == 1.5 and P.to_ghz("800MHz") == 0.8 and abs(P.to_ghz("0.0005GHz") - 5e-4) < 1e-12
    for v in ("23.8mm", "29", "1e-4", "-0.5mm", "2.5e3MHz"):
        assert P.is_plain(v), v
    for v in ("w", "2*b_h", "$er_d", "a+1mm"):
        assert not P.is_plain(v), v
    assert P.has_unit("3mm") and P.has_unit("2*w") and not P.has_unit("35") and not P.has_unit("1e-4")


def test_headline():
    ff = {"f_ghz": 1.575, "peak_realized_gain_dbi": -0.5, "total_efficiency": 0.48, "peak_direction_deg": [0, 0]}
    r = {"metrics": {"f_solve_ghz": 1.575, "far_field": [dict(ff, f_ghz=1.5), ff],
                     "s": {"S(1,1)": {"min": [1575.0, -26.0], "dips": [[1575.0, -26.0]]}, "S(2,1)": {"max": [1, 2]},
                           "passband": {"f0_mhz": 1.0, "il_db": 2.0, "bw3_mhz": 3.0, "spurious": []}}}}
    assert P.headline(r) == {"S(1,1)": [1575.0, -26.0], "passband": {"f0_mhz": 1.0, "il_db": 2.0, "bw3_mhz": 3.0},
                             "far_field": {"f_ghz": 1.575, "peak_realized_gain_dbi": -0.5, "total_efficiency": 0.48}}
    assert P.headline({"metrics": {"modes_ghz_q": [[1, 2]] * 6}}) == {"modes_ghz_q": [[1, 2]] * 3}
    assert P.headline({"metrics": {"designs": [{"design": "A"}]}}) == {"designs": ["A"]}


def test_data_dir_is_separate():
    """任务库、结果和快照都在数据目录, 不在代码旁边。"""
    assert jobs.DATA == Path(_TMP_DATA).resolve()
    assert jobs.DB.parent == jobs.DATA and jobs.RUNS.parent == jobs.DATA and P.SNAPSHOTS.parent == jobs.DATA


def test_parallel_limits():
    """原来手调的参数 (24 核 / 48 GB) 要原样算出来, 小机器不能超配。"""
    assert parallel_limits(24, 48) == (3, 16, 8, 16)
    assert parallel_limits(24, 47.78)[0] == 3, "48 GB 的机器 Windows 报 47.8 GB, 仍然是 3 个"
    assert parallel_limits(24, 44)[0] == 2, "内存明显不够 3 个任务时不能开 3 个"
    assert parallel_limits(8, 16) == (1, 8, 2, 16 / 3)
    assert parallel_limits(4, 8)[:3] == (1, 4, 1)
    assert parallel_limits(None, 4)[0] == 1
    assert parallel_limits(24, 48, {"max_jobs": 1, "cores_alone": 12}) == (1, 12, 8, 16)


def test_aedt_versions():
    root = tempfile.mkdtemp()
    try:
        env = {"ANSYSEM_ROOT242": root, "ANSYSEM_ROOT252": root, "ANSYSEM_ROOT251": str(Path(root) / "没装"),
               "AWP_ROOT252": root}
        assert installed_aedt_versions(env) == ["2025.2", "2024.2"]
        assert installed_aedt_versions({}) == []
    finally:
        shutil.rmtree(root, ignore_errors=True)


def expect_run_error(text, *args):
    try:
        P.prepare_run(*args)
    except ValueError as e:
        assert text in str(e), (text, e)
        return
    raise AssertionError(f"应该报错但通过了: {args}")


@needs_fixtures
def test_prepare_run():
    aedt = str(FIXTURES / "dr6g" / "dr6g.aedt")
    ok = ("D", {}, "coarse", None, None, None, None, True, None, [0, 0], None)
    req, warn = P.prepare_run(aedt, *ok)
    assert req["recipe"] == "project" and (P.SNAPSHOTS / f"{req['project_sha']}.aedt").exists() and not warn
    assert P.prepare_run(aedt, "D", {"w": 3, "$e": "2"}, *ok[2:])[0]["params"] == {"w": "3", "$e": "2"}
    assert jobs.fingerprint(req) != jobs.fingerprint(P.prepare_run(aedt, "D", {"w": "3mm"}, *ok[2:])[0])
    expect_run_error("band_ghz", aedt, "D", {}, "coarse", None, None, [2, 1], None, True, None, [0, 0], None)
    expect_run_error("step_mhz", aedt, "D", {}, "coarse", None, None, None, -1, True, None, [0, 0], None)
    expect_run_error("ff_sweep_ghz", aedt, "D", {}, "coarse", None, None, None, None, True, [1, 2], [0, 0], None)
    expect_run_error("不能超过", aedt, "D", {}, "coarse", None, None, None, None, True, [1.0, 2.0, 0.01], [0, 0], None)
    expect_run_error("ff_direction_deg", aedt, "D", {}, "coarse", None, None, None, None, True, None, [200, 0], None)
    expect_run_error("找不到工程", "E:/没有这个文件.aedt", *ok)


def test_snapshot_is_a_copy():
    """快照按内容命名: 原文件改了就是新快照, 旧任务用的快照不变。"""
    tmp = Path(tempfile.mkdtemp())
    # 新装的机器上数据目录还不存在: 快照目录要连同上级目录一起建出来
    snaps, P.SNAPSHOTS = P.SNAPSHOTS, tmp / "new-data-dir" / "snapshots"
    try:
        src = tmp / "a.aedt"
        src.write_text("v1")
        f1, _ = P._snapshot(src)
        src.write_text("v2")
        f2, _ = P._snapshot(src)
        assert f1["project_sha"] != f2["project_sha"] and f1["filename"] == "a.aedt"
        assert (P.SNAPSHOTS / f"{f1['project_sha']}.aedt").read_text() == "v1"
        Path(str(src) + ".lock").write_text("")
        assert "打开" in P._snapshot(src)[1][0]
    finally:
        P.SNAPSHOTS = snaps
        shutil.rmtree(tmp, ignore_errors=True)


def test_errors_reach_the_model():
    """错误原因必须传到客户端: 大模型要靠它改参数, 只看到 "Error executing tool" 什么也改不了。"""
    async def go():
        async with Client(mcp) as c:
            for args, text in (({"recipe": "dr_filter", "analysis": "driven"}, "必须给 f0_ghz"),
                               ({"recipe": "dr_filter", "analysis": "eigenmode", "params": {"Lx": 6, "D": 30}}, "横杆"),
                               ({"recipe": "nope", "analysis": "eigenmode"}, "没有配方")):
                r = await c.call_tool("submit_simulation", args)
                assert r.is_error and text in r.content[0].text, r
            r = await c.call_tool("inspect_project", {"project": "E:/没有这个文件.aedt"})
            assert r.is_error and "找不到工程" in r.content[0].text, r
            for name in ("get_job", "cancel_job"):
                r = await c.call_tool(name, {"job_id": "不存在"})
                assert r.is_error and "没有任务" in r.content[0].text, r
    asyncio.run(go())


def test_unexpected_errors_keep_their_cause():
    """工具自己出 bug 时, 模型也要看到原因, 否则它会去猜 (曾经猜成 "沙箱读不了 D 盘")。"""
    def broken(project):
        raise FileNotFoundError("系统找不到指定的路径: snapshots")

    original, P.prepare_inspect = P.prepare_inspect, broken
    try:
        async def go():
            async with Client(mcp) as c:
                r = await c.call_tool("inspect_project", {"project": "E:/x.aedt"})
                text = r.content[0].text
                assert r.is_error and "FileNotFoundError" in text and "snapshots" in text, r
                assert "不是参数或路径权限的问题" in text, text
        asyncio.run(go())
    finally:
        P.prepare_inspect = original



def test_curves():
    """应用画图用的数据: 收敛过程逐次读出, 抽稀后谷底还在, 列名对上 S 参数名。"""
    if HAVE_FIXTURES:
        rows = conv_passes((FIXTURES / "dra" / "data" / "fin_L2_conv.prof").read_text(errors="ignore"))
        assert len(rows) == 13 and rows[0]["delta"] is None and rows[-1]["delta"] == 0.0033559 and rows[-1]["tets"] == 83852
    rows = conv_passes("Pass Number|Solved Elements|Max Mag. Delta S|\n 1| 500| N/A|\n 2| 900| 0.25|\n")
    assert rows == [{"pass": 1, "tets": 500, "delta": None}, {"pass": 2, "tets": 900, "delta": 0.25}], rows
    assert trace_name("S1_1_dB") == "S(1,1)" and trace_name("S21_dB") == "S(2,1)" and trace_name("St2_1_dB") == "St(2,1)"
    assert trace_name("ReZ1_1") is None and trace_name("f_GHz") is None
    x = list(range(5000))
    y = [0.0] * 5000
    y[3333] = -40.0  # 一个很窄的谷
    keep = downsample(x, [y], limit=200)
    assert len(keep) <= 202 and 3333 in keep, "抽稀不能把窄谷抽掉"
    tmp = Path(tempfile.mkdtemp())
    try:
        csv = tmp / "s.csv"
        rows = "\n".join(f"{6 + i * 1e-3},{-3 - (40 if i == 1234 else 0)},{-20.0}" for i in range(3000))
        csv.write_text("f_GHz,S11_dB,S21_dB\n" + rows + "\n", encoding="utf-8")
        s = read_s(csv)
        assert s and set(s["traces"]) == {"S(1,1)", "S(2,1)"} and len(s["f_ghz"]) <= 802
        assert min(s["traces"]["S(1,1)"]) == -43, "抽稀后谷底还在"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _done_job(mesh="coarse", result=None, request=None, jid="jtest"):
    return {"id": jid, "state": "done", "mesh": mesh, "finished": 1.0, "request": {"params": {}, **(request or {})},
            "result": {"converged": True, "convergence": {"passes": 7, "tets": 14578}, "metrics": {}, **(result or {})}}


def test_pitfalls():
    """结果出来后才看得出的坑: 网格加密在错误频率、贴着扫频边界、加密次数太少、网格太粗、模式太少、到上限没收敛。"""
    ok = _done_job(result={"metrics": {"f_solve_ghz": 7.87, "band_ghz": [6, 10.5],
                                       "s": {"passband": {"f0_mhz": 7862.5}}}})
    assert pitfalls.review(ok) == [], pitfalls.review(ok)
    off = _done_job(result={"metrics": {"f_solve_ghz": 7.5, "band_ghz": [6, 10.5], "s": {"passband": {"f0_mhz": 7862.5}}}})
    assert any("f0_ghz 设成 7.862" in t for t in pitfalls.review(off))
    edge = _done_job(result={"metrics": {"f_solve_ghz": 7.86, "band_ghz": [7.8, 7.863], "s": {"passband": {"f0_mhz": 7862}}}})
    assert any("扫频边界" in t for t in pitfalls.review(edge))
    antenna = _done_job(result={"metrics": {"f_solve_ghz": 2.0, "s": {"S(1,1)": {"min": [2450.0, -20]}}}})
    assert any("2.45" in t for t in pitfalls.review(antenna)), "单端口看 S11 谷点"
    few = _done_job(result={"convergence": {"passes": 3, "tets": 711}, "metrics": {"modes_ghz_q": [[7.86, 8787], [11.9, 1e4]]}})
    found = pitfalls.review(few)
    assert len(found) == 3 and any("碰巧" in t for t in found) and any("711" in t for t in found) and any("2 个模式" in t for t in found)
    capped = _done_job(result={"converged": False, "convergence": {"passes": 15, "tets": 90000}})
    assert any("上限 15" in t for t in pitfalls.review(capped))
    assert pitfalls.review(dict(ok, state="failed")) == []
    assert pitfalls.review(_done_job(result={"converged": None})) == [], "inspect 没有收敛这回事"


def test_doctor():
    """环境自检: 只查不改, 每项都有结论, 没过的说怎么修。"""
    assert doctor.check_aedt({})["level"] == "fail"
    servers = doctor.license_servers({"ANSYSLMD_LICENSE_FILE": "1055@lic1;2325@lic2.corp.cn"})
    assert servers == [(1055, "lic1"), (2325, "lic2.corp.cn")]
    tmp = Path(tempfile.mkdtemp())
    try:
        ini = tmp / "ANSYS Inc" / "Shared Files" / "Licensing"
        ini.mkdir(parents=True)
        (ini / "ansyslmd.ini").write_text("SERVER=1055@myhost\nANSYSLI_SERVERS=2325@myhost\n")
        root = tmp / "ANSYS Inc" / "v252" / "AnsysEM"
        root.mkdir(parents=True)
        assert doctor.license_servers({}, str(root)) == [(1055, "myhost")]
        unreachable = doctor.check_license({"ANSYSLMD_LICENSE_FILE": "1@127.0.0.1"})
        assert unreachable["level"] == "fail" and "fix" in unreachable
        assert doctor.check_license({})["level"] in ("warn", "ok", "fail")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    report = doctor.check()
    assert {i["name"] for i in report["items"]} == {"AEDT", "许可证", "PyAEDT", "数据目录", "后台任务", "本机"}
    assert all(i["level"] in ("ok", "warn", "fail") and i["detail"] for i in report["items"])
    assert all("fix" in i for i in report["items"] if i["level"] == "fail")


def test_sweeps():
    """扫参: 一次提交一组, 按值排序比较; 和以前一样的点复用; 有一个点不合法就一个都不提交。"""
    tmp = Path(tempfile.mkdtemp())
    db, jobs.DB = jobs.DB, tmp / "jobs.db"
    started, jobs.ensure_runner = jobs.ensure_runner, lambda: None
    try:
        async def go():
            async with Client(mcp) as c:
                r = await c.call_tool("sweep_recipe", {"recipe": "dr_filter", "analysis": "eigenmode", "param": "Lx",
                                                      "values": [3.5, 2.5, 3]})
                assert not r.is_error, r
                sweep = r.structured_content
                assert len(sweep["jobs"]) == 3 and sweep["jobs"][0]["sweep"]["value"] == "3.5"
                again = await c.call_tool("submit_simulation", {"recipe": "dr_filter", "analysis": "eigenmode",
                                                                "params": {"Lx": 3}})
                assert again.structured_content["reused"], "扫参的点和单独提交的一样时要复用"
                table = (await c.call_tool("compare_jobs", {"sweep_id": sweep["sweep_id"]})).structured_content
                assert [row["value"] for row in table["rows"]] == ["2.5", "3", "3.5"], "按数值排序"
                assert table["done"] == 0 and table["total"] == 3
                bad = await c.call_tool("sweep_recipe", {"recipe": "dr_filter", "analysis": "eigenmode", "param": "Lx",
                                                        "values": [3.5, 99]})
                assert bad.is_error and "一个都没提交" in bad.content[0].text
                assert len(jobs.listing(50)) == 3
                many = await c.call_tool("sweep_recipe", {"recipe": "dr_filter", "analysis": "eigenmode", "param": "Lx",
                                                         "values": list(range(1, 15))})
                assert many.is_error and "最多扫 12" in many.content[0].text
                if HAVE_FIXTURES:
                    proj = await c.call_tool("sweep_project", {"project": str(FIXTURES / "dr6g" / "dr6g.aedt"),
                                                              "design": "FILTER", "variable": "g",
                                                              "values": ["5mm", "5.5mm"]})
                    assert not proj.is_error and len(proj.structured_content["jobs"]) == 2, proj
                listed = (await c.call_tool("list_jobs", {"limit": 10})).structured_content["jobs"]
                assert all("created" in j for j in listed) and any(j.get("position") for j in listed)
        asyncio.run(go())
    finally:
        jobs.DB, jobs.ensure_runner = db, started
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    try:
        for name, fn in list(globals().items()):
            if name.startswith("test_"):
                try:
                    fn()
                    print("ok", name)
                except Skip as why:
                    print("skip", name, why)
    finally:
        shutil.rmtree(_TMP_DATA, ignore_errors=True)
