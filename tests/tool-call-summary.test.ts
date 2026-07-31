// ---------------------------------------------------------------------------
// tool-call-summary 单元测试 — 阶段 3 共享渲染模块
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  templateToolCall,
  maskSensitive,
  formatArgsForDisplay,
  formatValue,
} from "../src/agent/tool-call-summary.js";

describe("templateToolCall", () => {
  it("read_file 显示 path", () => {
    expect(templateToolCall("read_file", { path: "/src/main.ts" })).toBe(
      "read_file(path=/src/main.ts)",
    );
  });

  it("write_file 显示 path", () => {
    expect(templateToolCall("write_file", { path: "foo.ts" })).toBe(
      "write_file(path=foo.ts)",
    );
  });

  it("edit_file 显示 path + 截断的 old_text", () => {
    const oldText = "x".repeat(100);
    const result = templateToolCall("edit_file", { path: "foo.ts", old_text: oldText });
    expect(result).toContain("path=foo.ts");
    expect(result).toContain("old_text=");
    // old_text 截断到 30 字
    expect(result).toContain("…");
    expect(result.length).toBeLessThan(80);
  });

  it("multi_edit 显示 edits 数量", () => {
    expect(templateToolCall("multi_edit", { path: "foo.ts", edits: [{}, {}, {}] })).toBe(
      "multi_edit(path=foo.ts, edits=3)",
    );
  });

  it("bash 显示 command（长 command 截断）", () => {
    const longCmd = "echo " + "x ".repeat(50);
    const result = templateToolCall("bash", { command: longCmd });
    expect(result).toContain("command=");
    expect(result.length).toBeLessThan(80);
  });

  it("bash command 为空时不抛错", () => {
    expect(templateToolCall("bash", { command: "" })).toContain("(空)");
  });

  it("grep 显示 pattern + path", () => {
    expect(templateToolCall("grep", { pattern: "TODO", path: "src/" })).toBe(
      "grep(pattern=TODO, path=src/)",
    );
  });

  it("grep path 缺省为 .", () => {
    expect(templateToolCall("grep", { pattern: "TODO" })).toBe(
      "grep(pattern=TODO, path=.)",
    );
  });

  it("glob 显示 pattern", () => {
    expect(templateToolCall("glob", { pattern: "**/*.ts" })).toBe(
      "glob(pattern=**/*.ts)",
    );
  });

  it("ls path 缺省为 .", () => {
    expect(templateToolCall("ls", {})).toBe("ls(path=.)");
  });

  it("fetch 显示 url（截断）", () => {
    const longUrl = "https://example.com/" + "a".repeat(80);
    const result = templateToolCall("fetch", { url: longUrl });
    expect(result).toContain("url=");
    expect(result.length).toBeLessThan(80);
  });

  it("未知工具：列出前 4 个 key", () => {
    expect(templateToolCall("unknown_tool", { a: 1, b: 2, c: 3 })).toBe(
      "unknown_tool(a=…, b=…, c=…)",
    );
  });

  it("未知工具：超过 4 个 key 标 +N", () => {
    const result = templateToolCall("unknown_tool", { a: 1, b: 2, c: 3, d: 4, e: 5 });
    expect(result).toContain("+1");
  });

  it("空 args 显示 ()", () => {
    expect(templateToolCall("unknown_tool", {})).toBe("unknown_tool()");
  });

  it("args 不是 object 时降级", () => {
    expect(templateToolCall("x", null)).toBe("x()");
    expect(templateToolCall("x", "string")).toBe("x()");
  });

  it("path 为 undefined 时显示 undefined", () => {
    expect(templateToolCall("read_file", {})).toBe("read_file(path=undefined)");
  });
});

describe("maskSensitive", () => {
  it("顶层 password 字段被替换", () => {
    expect(maskSensitive({ username: "alice", password: "secret" })).toEqual({
      username: "alice",
      password: "****",
    });
  });

  it("多个敏感字段一起被替换", () => {
    const masked = maskSensitive({
      username: "alice",
      password: "p",
      token: "t",
      apiKey: "k",
    });
    expect(masked).toEqual({
      username: "alice",
      password: "****",
      token: "****",
      apiKey: "****",
    });
  });

  it("大小写不敏感匹配", () => {
    expect(maskSensitive({ PASSWORD: "x", Token: "y" })).toEqual({
      PASSWORD: "****",
      Token: "****",
    });
  });

  it("api_key / apiKey 两种命名都识别", () => {
    expect(maskSensitive({ apiKey: "x", api_key: "y" })).toEqual({
      apiKey: "****",
      api_key: "****",
    });
  });

  it("递归替换嵌套对象中的敏感字段", () => {
    const masked = maskSensitive({
      user: { name: "alice", password: "x" },
      tokens: [{ token: "t1" }, { token: "t2" }],
    });
    expect(masked).toEqual({
      user: { name: "alice", password: "****" },
      tokens: [{ token: "****" }, { token: "****" }],
    });
  });

  it("非敏感字段保留原值", () => {
    expect(maskSensitive({ path: "/tmp", count: 5, name: "foo" })).toEqual({
      path: "/tmp",
      count: 5,
      name: "foo",
    });
  });

  it("null / undefined / 标量 原样返回", () => {
    expect(maskSensitive(null)).toBe(null);
    expect(maskSensitive(undefined)).toBe(undefined);
    expect(maskSensitive(123)).toBe(123);
    expect(maskSensitive("text")).toBe("text");
  });

  it("循环引用不爆栈", () => {
    const a: Record<string, unknown> = { name: "x" };
    a.self = a;
    const masked = maskSensitive(a);
    expect(masked.name).toBe("x");
    expect(masked.self).toBe("****");
  });

  it("不修改入参（纯函数）", () => {
    const input = { password: "secret" };
    const _ = maskSensitive(input);
    expect(input.password).toBe("secret");
  });
});

describe("formatArgsForDisplay", () => {
  it("多行 key: value 格式", () => {
    const out = formatArgsForDisplay({ path: "/tmp", count: 5 });
    expect(out).toBe("path: /tmp\ncount: 5");
  });

  it("长 string 截断", () => {
    const out = formatArgsForDisplay({ content: "x".repeat(200) }, { valueMaxLen: 50 });
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(60);
  });

  it("超过 maxKeys 时末尾标 +N more", () => {
    const out = formatArgsForDisplay(
      { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 },
      { maxKeys: 3 },
    );
    expect(out).toContain("a:");
    expect(out).toContain("c:");
    expect(out).not.toContain("d:");
    expect(out).toContain("+4 more");
  });

  it("敏感字段默认脱敏", () => {
    const out = formatArgsForDisplay({ name: "alice", password: "secret" });
    expect(out).toContain("name: alice");
    expect(out).toContain("password: ****");
    expect(out).not.toContain("secret");
  });

  it("敏感字段可关闭脱敏", () => {
    const out = formatArgsForDisplay({ password: "secret" }, { maskSensitive: false });
    expect(out).toContain("password: secret");
  });

  it("非 object args 直接渲染", () => {
    expect(formatArgsForDisplay(null)).toBe("null");
    expect(formatArgsForDisplay(undefined)).toBe("undefined");
    expect(formatArgsForDisplay("hello")).toBe("hello");
  });

  it("空对象返回空字符串", () => {
    expect(formatArgsForDisplay({})).toBe("");
  });
});

describe("formatValue", () => {
  it("string 截断", () => {
    expect(formatValue("x".repeat(200), 50)).toMatch(/^x{49}…$/);
  });

  it("number / boolean 原样", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(true)).toBe("true");
  });

  it("null / undefined", () => {
    expect(formatValue(null)).toBe("null");
    expect(formatValue(undefined)).toBe("undefined");
  });

  it("短 array 完整渲染", () => {
    expect(formatValue([1, 2, 3])).toBe("[1,2,3]");
  });

  it("长 array 用 […]items… 摘要", () => {
    expect(formatValue([1, 2, 3, 4, 5])).toBe("[…5 items…]");
  });

  it("短 object 完整渲染", () => {
    expect(formatValue({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it("长 object 用 {…N keys…} 摘要", () => {
    expect(formatValue({ a: 1, b: 2, c: 3, d: 4 })).toBe("{…4 keys…}");
  });
});
