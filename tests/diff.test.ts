import { describe, expect, it } from "vitest";

import { unifiedDiff } from "../src/main/agent/diff";

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

describe("unifiedDiff", () => {
  it("shows a change with context and line numbers", () => {
    const before = lines(10);
    const after = [...before];
    after[4] = "changed";

    expect(unifiedDiff(before.join("\n"), after.join("\n"))).toBe(
      "@@ -3,5 +3,5 @@\n line 3\n line 4\n-line 5\n+changed\n line 6\n line 7",
    );
  });

  it("splits distant changes into separate hunks", () => {
    const before = lines(30);
    const after = [...before];
    after[1] = "first";
    after[25] = "second";

    const diff = unifiedDiff(before.join("\n"), after.join("\n"));

    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain("@@ -24,5 +24,5 @@");
  });

  it("handles insertions, deletions and an empty file", () => {
    expect(unifiedDiff("a\nb\n", "a\nx\nb\n")).toBe("@@ -1,2 +1,3 @@\n a\n+x\n b");
    expect(unifiedDiff("a\nb\n", "a\n")).toBe("@@ -1,2 +1,1 @@\n a\n-b");
    expect(unifiedDiff("", "new\n")).toBe("@@ -1,0 +1,1 @@\n+new");
  });

  it("aligns unchanged lines between changes", () => {
    expect(unifiedDiff("a\nb\nc\n", "x\nb\ny\n")).toBe("@@ -1,3 +1,3 @@\n-a\n+x\n b\n-c\n+y");
  });

  it("treats Windows line endings like Unix ones", () => {
    expect(unifiedDiff("a\r\nb\r\n", "a\r\nc\r\n")).toBe("@@ -1,2 +1,2 @@\n a\n-b\n+c");
  });

  it("returns nothing when the text is the same", () => {
    expect(unifiedDiff("a\nb", "a\nb")).toBe("");
  });
});
