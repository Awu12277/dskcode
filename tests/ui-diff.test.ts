// ---------------------------------------------------------------------------
// Diff 渲染测试 — 覆盖 src/ui/tui/diff.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { renderDiffLines } from "../src/ui/tui/diff.js";
import { computeFileDiff } from "../src/tool/diff.js";

/** 抹掉所有 ANSI 转义序列（SGR + OSC） */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

describe("renderDiffLines", () => {
  it("空 patch 返回空数组", () => {
    expect(renderDiffLines("")).toEqual([]);
  });

  it("只丢弃文件头/hunk 头，保留 +/-/空格 行", () => {
    // hunk 头: oldStart=1, oldCount=2 → 包含 old line 1 (context) + line 2 (remove)
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
    ].join("\n");
    const lines = renderDiffLines(patch);
    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[0]!)).toBe("    1 keep");
    expect(stripAnsi(lines[1]!)).toBe("-   2 old");
    expect(stripAnsi(lines[2]!)).toBe("+   2 new");
  });

  it("单行修改触发 inverse 内联反色（removed/added 行内都含 SGR 7）", () => {
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -3,1 +3,1 @@",
      "-foo bar baz",
      "+foo BAR baz",
    ].join("\n");
    const lines = renderDiffLines(patch);
    expect(lines).toHaveLength(2);
    // 两行都应含 SGR 7（反色）
    expect(lines[0]).toContain("\x1b[7m");
    expect(lines[1]).toContain("\x1b[7m");
    // 反色部分应包含被改动的 token
    expect(stripAnsi(lines[1]!)).toContain("BAR");
  });

  it("多行修改不做内联高亮（不出现 SGR 7）", () => {
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      "-a",
      "-b",
      "+x",
      "+y",
    ].join("\n");
    const lines = renderDiffLines(patch);
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      expect(l).not.toContain("\x1b[7m");
    }
  });

  it("连续多行删除 + 多行添加：所有 - 行 + 所有 + 行依次出现", () => {
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      "-l1",
      "-l2",
      "+n1",
      "+n2",
    ].join("\n");
    const lines = renderDiffLines(patch);
    expect(lines).toHaveLength(4);
    expect(stripAnsi(lines[0]!)).toBe("-   1 l1");
    expect(stripAnsi(lines[1]!)).toBe("-   2 l2");
    expect(stripAnsi(lines[2]!)).toBe("+   1 n1");
    expect(stripAnsi(lines[3]!)).toBe("+   2 n2");
  });

  it("行号在多个 hunk 间连续累计", () => {
    // hunk 1: 改 line 1 (a→x)
    // hunk 2: 改 line 10 (b→y)
    // 累计到 hunk 2 时 oldLine/newLine 都从 1 累计 = 1
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+x",
      "@@ -10,1 +10,1 @@",
      "-b",
      "+y",
    ].join("\n");
    const lines = renderDiffLines(patch);
    // 4 行：-a(1) +x(1) -b(10) +y(10)
    expect(lines).toHaveLength(4);
    expect(stripAnsi(lines[0]!)).toBe("-   1 a");
    expect(stripAnsi(lines[1]!)).toBe("+   1 x");
    expect(stripAnsi(lines[2]!)).toBe("-  10 b");
    expect(stripAnsi(lines[3]!)).toBe("+  10 y");
  });

  it("tab 被替换为 3 空格", () => {
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,1 @@",
      "-\tfoo",
      "+\tbar",
    ].join("\n");
    const lines = renderDiffLines(patch);
    // tab → "   "，单行修改触发 inverse，断言 raw 内容仍含 "   "
    expect(stripAnsi(lines[0]!)).toBe("-   1    foo");
    expect(stripAnsi(lines[1]!)).toBe("+   1    bar");
  });

  it("新文件 diff 渲染", () => {
    const result = computeFileDiff("", "hello\nworld\n", "/test/new.ts");
    expect(result.patch).toContain("--- /dev/null");
    const lines = renderDiffLines(result.patch);
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0]!)).toBe("+   1 hello");
    expect(stripAnsi(lines[1]!)).toBe("+   2 world");
  });

  it("删除文件 diff 渲染", () => {
    const result = computeFileDiff("a\nb\n", "", "/test/del.ts");
    expect(result.patch).toContain("+++ /dev/null");
    const lines = renderDiffLines(result.patch);
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0]!)).toBe("-   1 a");
    expect(stripAnsi(lines[1]!)).toBe("-   2 b");
  });

  it("所有行都被注入 ANSI 转义（染色已发生）", () => {
    const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n");
    const lines = renderDiffLines(patch);
    for (const l of lines) {
      // 每行都应含 SGR 转义（前景色或 inverse）
      expect(l).toMatch(/\x1b\[/);
    }
  });
});
