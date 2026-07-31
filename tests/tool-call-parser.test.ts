// ---------------------------------------------------------------------------
// tool-call-parser 单元测试 — 覆盖阶段 1 的容错解析能力
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { parseToolCallArgs, fixStreamedJson } from "../src/agent/tool-call-parser.js";

describe("parseToolCallArgs", () => {
  it("空字符串 → ok, args={}", () => {
    expect(parseToolCallArgs("")).toEqual({ ok: true, args: {}, fixed: "" });
    expect(parseToolCallArgs(undefined)).toEqual({ ok: true, args: {}, fixed: "" });
    expect(parseToolCallArgs(null)).toEqual({ ok: true, args: {}, fixed: "" });
  });

  it("空白字符串 → PARTIAL（启发式判定未收全）", () => {
    expect(parseToolCallArgs(" ")).toMatchObject({ ok: false, reason: "PARTIAL" });
  });

  it("合法 JSON → ok, args=解析结果", () => {
    expect(parseToolCallArgs('{"path":"/tmp"}')).toEqual({
      ok: true,
      args: { path: "/tmp" },
      fixed: '{"path":"/tmp"}',
    });
  });

  it("未闭合的反斜杠 → 自动修复后 ok", () => {
    expect(parseToolCallArgs('{"text":"hello\\')).toMatchObject({ ok: true });
  });

  it("流式分片: 半截 JSON → reason=PARTIAL", () => {
    expect(parseToolCallArgs('{"path":')).toMatchObject({ ok: false, reason: "PARTIAL" });
    expect(parseToolCallArgs('{"a":{"b":')).toMatchObject({
      ok: false,
      reason: "PARTIAL",
    });
  });

  it("完全损坏 JSON → reason=INVALID_JSON + 原文", () => {
    expect(parseToolCallArgs("{not valid json}")).toMatchObject({
      ok: false,
      reason: "INVALID_JSON",
    });
  });

  it("数组半截 → PARTIAL", () => {
    expect(parseToolCallArgs("[1,2,3,")).toMatchObject({ ok: false, reason: "PARTIAL" });
  });

  it("INVALID_JSON 时携带原文 raw 字段", () => {
    const raw = "{not valid json}";
    const result = parseToolCallArgs(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("INVALID_JSON");
      expect(result.raw).toBe(raw);
      expect(typeof result.error).toBe("string");
    }
  });

  it("PARTIAL 时携带 partial 和 hint 字段", () => {
    const result = parseToolCallArgs('{"path":');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("PARTIAL");
      expect(result.partial).toBe('{"path":');
      expect(typeof result.hint).toBe("string");
    }
  });

  it("ok 路径会带回 fixed 字段（合法 JSON 时 fixed === raw）", () => {
    const raw = '{"a":1}';
    const result = parseToolCallArgs(raw);
    expect(result).toMatchObject({ ok: true, args: { a: 1 }, fixed: raw });
  });

  it("ok 路径在自动修复后 fixed 不等于 raw", () => {
    const raw = '{"a":"b\\';
    const result = parseToolCallArgs(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fixed.length).toBeLessThanOrEqual(raw.length + 2);
      expect(result.fixed).not.toBe(raw);
    }
  });
});

describe("fixStreamedJson", () => {
  it("配对缺失的右括号", () => {
    expect(JSON.parse(fixStreamedJson('{"a":1'))).toEqual({ a: 1 });
    expect(JSON.parse(fixStreamedJson('{"a":[1,2'))).toEqual({ a: [1, 2] });
    expect(JSON.parse(fixStreamedJson('{"a":{"b":2'))).toEqual({ a: { b: 2 } });
  });

  it("去除末尾未配对的反斜杠（反斜杠在字符串内）", () => {
    expect(fixStreamedJson('"a\\')).toBe('"a"');
    expect(JSON.parse(fixStreamedJson('"a\\'))).toBe("a");
  });

  it("末尾反斜杠：对象半截场景", () => {
    const fixed = fixStreamedJson("{\\");
    expect(() => JSON.parse(fixed)).not.toThrow();
    expect(JSON.parse(fixed)).toEqual({});
  });

  it("末尾偶数个 \\ → 保留", () => {
    expect(fixStreamedJson('"a\\\\"')).toBe('"a\\\\"');
  });

  it('未闭合的字符串 → 自动补 "', () => {
    expect(JSON.parse(fixStreamedJson('{"a":"hel'))).toEqual({ a: "hel" });
  });

  it("字符串内的右括号不参与配对", () => {
    expect(JSON.parse(fixStreamedJson('{"a":"x}y"}'))).toEqual({ a: "x}y" });
  });

  it("字符串内的转义引号不切换状态", () => {
    expect(JSON.parse(fixStreamedJson('{"a":"x\\"y"'))).toEqual({ a: 'x"y' });
  });

  it("嵌套结构 + 字符串 + escape 综合", () => {
    const input = '{"items":[{"name":"a\\';
    const fixed = fixStreamedJson(input);
    expect(JSON.parse(fixed)).toEqual({ items: [{ name: "a" }] });
  });
});
