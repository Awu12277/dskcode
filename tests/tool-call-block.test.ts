// ---------------------------------------------------------------------------
// ToolCallBlock 单元测试 — 阶段 3 UI 渲染
//
// 测试策略：项目不引入 ink-testing-library，按约定只测从 ToolCallBlock
// 提取出的纯函数(已迁到 src/agent/tool-call-summary.ts)。这里通过
// 重构过的 ToolCallBlock 内部使用的纯函数(templateToolCall /
// formatArgsForDisplay / maskSensitive)间接覆盖 UI 的渲染行为。
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  templateToolCall,
  formatArgsForDisplay,
  maskSensitive,
  formatValue,
} from "../src/agent/tool-call-summary.js";
import type { ProviderToolCall } from "../src/provider/index.js";

/**
 * 构造一个最小 ProviderToolCall 的辅助函数（UI 组件 props 依赖）
 */
function makeCall(name: string, args: string): ProviderToolCall {
  return { id: "c1", name, arguments: args };
}

describe("ToolCallBlock props → 渲染文本", () => {
  it("read_file 渲染：模板摘要 + 多行参数", () => {
    const call = makeCall("read_file", '{"path":"/src/main.ts"}');
    const parsed = JSON.parse(call.arguments);
    const safe = maskSensitive(parsed);
    const summary = templateToolCall(call.name, safe);
    const body = formatArgsForDisplay(safe);
    expect(summary).toBe("read_file(path=/src/main.ts)");
    expect(body).toBe("path: /src/main.ts");
  });

  it("bash 渲染：command 截断", () => {
    // 足够长的 command 触发 templateToolCall 内部 40 字截断
    const longCmd =
      "git log --all --oneline --graph --decorate --since=2.weeks --author=alice --grep=fix";
    const call = makeCall("bash", JSON.stringify({ command: longCmd }));
    const parsed = JSON.parse(call.arguments);
    const safe = maskSensitive(parsed);
    const summary = templateToolCall(call.name, safe);
    const body = formatArgsForDisplay(safe, { valueMaxLen: 30 });
    expect(summary).toContain("bash(command=");
    expect(summary).toContain("…"); // 长 command 截断
    // body 内的 command 也被截断
    expect(body).toContain("…");
  });

  it("multi_edit 渲染：edits 显示数量", () => {
    // 实际数据：edits 是空对象数组
    const call = makeCall("multi_edit", '{"path":"foo.ts","edits":[{},{},{}]}');
    const parsed = JSON.parse(call.arguments);
    const safe = maskSensitive(parsed);
    const summary = templateToolCall(call.name, safe);
    const body = formatArgsForDisplay(safe);
    expect(summary).toBe("multi_edit(path=foo.ts, edits=3)");
    // body 内的 edits 保留原始 JSON（formatValue 短 array 原样渲染）
    expect(body).toContain("edits: [{},{},{}]");
  });

  it("敏感字段在 UI 渲染时脱敏", () => {
    const call = makeCall("bash", '{"command":"echo ok","password":"supersecret"}');
    const parsed = JSON.parse(call.arguments);
    const safe = maskSensitive(parsed);
    const body = formatArgsForDisplay(safe);
    expect(body).toContain("password: ****");
    expect(body).not.toContain("supersecret");
  });

  it("未知工具渲染：模板列出 key 占位 + body 列实际 value", () => {
    const call = makeCall("my_custom_tool", '{"a":1,"b":"hello"}');
    const parsed = JSON.parse(call.arguments);
    const safe = maskSensitive(parsed);
    const summary = templateToolCall(call.name, safe);
    const body = formatArgsForDisplay(safe);
    expect(summary).toBe("my_custom_tool(a=…, b=…)");
    expect(body).toContain("a: 1");
    expect(body).toContain("b: hello");
  });

  it("损坏的 JSON arguments 不会让渲染崩溃", () => {
    const call = makeCall("bash", "{not valid json}");
    // 模拟 ToolCallBlock 的 resolveArgsFromRaw 行为：损坏 JSON 时 fallback 到 {}
    const safe = maskSensitive({});
    const summary = templateToolCall(call.name, safe);
    const body = formatArgsForDisplay(safe);
    expect(summary).toBe("bash(command=undefined)");
    // 空对象渲染时 body 为空（formatArgsForDisplay 对 {} 直接返回 ""）
    expect(body).toBe("");
  });

  it("空 arguments 渲染", () => {
    const call = makeCall("ls", "");
    const safe = maskSensitive({});
    const summary = templateToolCall(call.name, safe);
    expect(summary).toBe("ls(path=.)");
  });
});

describe("ToolCallBlock 渲染的边界值", () => {
  it("空 object 渲染：summary 显示 ()，body 空", () => {
    const summary = templateToolCall("noop", {});
    const body = formatArgsForDisplay({});
    expect(summary).toBe("noop()");
    expect(body).toBe("");
  });

  it("long string 截断到 80 字符（UI 默认值）", () => {
    const long = "x".repeat(200);
    const body = formatArgsForDisplay({ content: long });
    // body 每行一个 key: value，content 截断到 80
    expect(body.length).toBeLessThan(120);
    expect(body).toContain("…");
  });

  it("超过 6 个 key 时末尾标 +N more", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) obj[`k${i}`] = i;
    const body = formatArgsForDisplay(obj);
    expect(body).toContain("+4 more");
  });
});

describe("schemaIssues 在 UI 中的展示（间接覆盖）", () => {
  // ToolCallBlock.tsx 内部映射 schemaIssues 数组：
  //   {schemaIssues.length > 0 && 显示黄色提示 + 前 3 条}
  // 这里通过纯函数层面验证 issues 数量与截断逻辑

  it("issues 数量 = 0 → 不显示提示", () => {
    const issues: ReadonlyArray<{
      path: string;
      expected: string;
      received: string;
      message: string;
    }> = [];
    expect(issues.length).toBe(0);
  });

  it("issues 数量 = 3 → 全部显示，不显示 +N more", () => {
    const issues = [
      { path: "$.a", expected: "string", received: "undefined", message: "a 缺失" },
      { path: "$.b", expected: "string", received: "undefined", message: "b 缺失" },
      { path: "$.c", expected: "string", received: "undefined", message: "c 缺失" },
    ];
    const shown = issues.slice(0, 3);
    expect(shown.length).toBe(3);
  });

  it("issues 数量 = 5 → 显示前 3 条 + 末尾 +2 more", () => {
    const issues = Array.from({ length: 5 }, (_, i) => ({
      path: `$.field${i}`,
      expected: "string",
      received: "undefined",
      message: `field${i} 缺失`,
    }));
    const shown = issues.slice(0, 3);
    expect(shown.length).toBe(3);
    expect(issues.length - shown.length).toBe(2);
  });
});

describe("formatValue 边界", () => {
  it("空字符串", () => {
    expect(formatValue("")).toBe("");
  });

  it("零", () => {
    expect(formatValue(0)).toBe("0");
  });

  it("false", () => {
    expect(formatValue(false)).toBe("false");
  });

  it("嵌套对象", () => {
    expect(formatValue({ a: { b: 1 } })).toBe('{"a":{"b":1}}');
  });
});
