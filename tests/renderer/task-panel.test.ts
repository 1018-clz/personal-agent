import { describe, expect, it } from "vitest";

import { niceTicks } from "../../src/renderer/src/Chart";
import { formatDuration, keyLines } from "../../src/renderer/src/TaskPanel";

describe("task panel", () => {
  it("shows the key numbers of each kind of result", () => {
    expect(keyLines({ passband: { f0_mhz: 7862.5, il_db: 0.56, bw3_mhz: 14.6 } })).toEqual([
      "f0 7862.5 MHz · 插损 0.56 dB · 带宽 14.6 MHz",
    ]);
    expect(keyLines({ te01d_ghz: 3.512, q0: 9123.4, mode_spacing_mhz: 812.3, f0_mhz: undefined })[0]).toContain("TE01δ 3.512 GHz");
    expect(keyLines({ modes_ghz_q: [[7.8579, 8792.04], [8.9653, 8028.33]] })).toEqual(["模式 7.8579 GHz (Q 8792)、8.9653 GHz (Q 8028)"]);
    expect(keyLines({ "S(1,1)": [2450, -21.3], far_field: { peak_realized_gain_dbi: 5.12, total_efficiency: 0.81 } })).toEqual([
      "S(1,1) 谷 2450 MHz -21.3 dB",
      "增益 5.12 dBi · 效率 0.81",
    ]);
    expect(keyLines({ designs: ["FILTER", "EIG"] })).toEqual(["设计 FILTER、EIG"]);
    expect(keyLines(null)).toEqual([]);
  });

  it("says how long a job took", () => {
    expect(formatDuration(42)).toBe("42 秒");
    expect(formatDuration(77)).toBe("1 分 17 秒");
    expect(formatDuration(3 * 3600 + 125)).toBe("3 小时 2 分");
  });

  it("puts chart ticks on round numbers", () => {
    expect(niceTicks(6, 10.5, 5)).toEqual([6, 7, 8, 9, 10]);
    expect(niceTicks(-40.3, 0.2, 5)).toEqual([-40, -30, -20, -10, 0]);
    expect(niceTicks(-40.3, 0.2, 2)).toEqual([-40, -20, 0]);
    expect(niceTicks(7.8, 7.92, 4)).toEqual([7.8, 7.85, 7.9]);
  });
});
