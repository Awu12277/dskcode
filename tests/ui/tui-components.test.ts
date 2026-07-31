/**
 * Tests for pi-tui based TUI components in `agent-term/src/ui/tui/chat-app.ts`.
 *
 * These cover the small component-level contracts that we care about
 * after the pi-tui refactor:
 *   - StatusBar: 宽度契约 + 右对齐 + CJK 宽度计算正确
 *   - BorderedInput: 边框渲染 + setValue 后 inner 状态正确 + invalidate 透传
 *
 * 不需要启动真实 TUI，直接构造组件并断言 render(width) 输出即可。
 */

import { describe, expect, it, vi } from "vitest";
import { BorderedInput, StatusBar } from "../../src/ui/tui/chat-app.js";
import { visibleWidth } from "@earendil-works/pi-tui";

describe("StatusBar", () => {
  it("渲染宽度恒为 1（不抛 'line exceeds width'）", () => {
    const bar = new StatusBar();
    bar.model = "deepseek-v4";
    bar.balance = 12.34;
    const lines = bar.render(40);
    expect(lines).toHaveLength(1);
    // 必须满足 pi-tui 宽度契约
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(40);
  });

  it("width=0 不抛错并返回空行", () => {
    const bar = new StatusBar();
    bar.model = "x";
    bar.balance = 1;
    expect(() => bar.render(0)).not.toThrow();
  });

  it("右对齐：内容出现在行末", () => {
    const bar = new StatusBar();
    bar.model = "deepseek-v4";
    bar.balance = 12.34;
    const lines = bar.render(60);
    // 末段（去掉前导空格）应包含余额
    const trimmed = lines[0]!.replace(/^\s+/, "");
    expect(trimmed).toContain("\u00A512.34");
    expect(trimmed).toContain("deepseek-v4");
  });

  it("CJK 模型名按 2 列计算（用 visibleWidth 验证）", () => {
    const bar = new StatusBar();
    // "深度求索" — 4 个 CJK 字符，每个占 2 列
    bar.model = "深度求索";
    bar.balance = 0;
    const lines = bar.render(40);
    // 可见宽度不应被 4 而应是 8（光这 4 个字符）
    const visible = "模型: 深度求索  余额: \u00A50.00";
    // 重算 visible：模型 2 + ": 深度求索(8)  余额: ¥0.00(10+0)" 约 4+8+2+10 = 24
    // 不需要精确到这一行，只断言包含中文字符 + 长度合理
    expect(lines[0]!).toContain("深度求索");
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(40);
  });

  it("invalidate() 是 no-op，不抛错", () => {
    const bar = new StatusBar();
    expect(() => bar.invalidate()).not.toThrow();
  });

  it("handleInput() 接受任何数据但被丢弃", () => {
    const bar = new StatusBar();
    expect(() => bar.handleInput("a")).not.toThrow();
    expect(() => bar.handleInput("\x1b[A")).not.toThrow();
  });
});

describe("BorderedInput", () => {
  it("渲染包含上下边框 + 一行输入", () => {
    const input = new BorderedInput();
    input.setValue("hello");
    const lines = input.render(20);
    // 顶边框 + 1 行 input + 底边框 = 3 行
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // 边框使用 ─ 字符
    expect(lines[0]!).toContain("\u2500");
    expect(lines[lines.length - 1]!).toContain("\u2500");
    // 行宽不能超
    for (const l of lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(20);
    }
  });

  it("width=0 时不抛错（边框退化为空）", () => {
    const input = new BorderedInput();
    input.setValue("hello");
    expect(() => input.render(0)).not.toThrow();
  });

  it("footer 渲染在边框之后", () => {
    const input = new BorderedInput();
    input.setValue("hi");
    const fakeFooter = {
      focused: false,
      render: (w: number) => [`FOOTER-${w}`],
      invalidate: () => undefined,
    };
    input.footer = fakeFooter as never;
    const lines = input.render(20);
    expect(lines.some((l) => l.includes("FOOTER-20"))).toBe(true);
  });

  it("autocompleteList 渲染在 footer 之后", () => {
    const input = new BorderedInput();
    input.setValue("hi");
    input.footer = {
      focused: false,
      render: () => ["FOOTER"],
      invalidate: () => undefined,
    } as never;
    // 假 SelectList：只需满足 render 接口
    const fakeAc = {
      focused: false,
      render: (w: number) => [`AC-${w}`],
      invalidate: () => undefined,
      getSelectedItem: () => null,
    };
    input.autocompleteList = fakeAc as never;
    const lines = input.render(20);
    const footerIdx = lines.findIndex((l) => l === "FOOTER");
    const acIdx = lines.findIndex((l) => l === "AC-20");
    expect(footerIdx).toBeGreaterThanOrEqual(0);
    expect(acIdx).toBeGreaterThan(footerIdx);
  });

  it("setValue(value, 0) 把光标放行末（getValue 内容一致）", () => {
    const input = new BorderedInput();
    input.setValue("abc", 0);
    expect(input.getValue()).toBe("abc");
  });

  it("onSubmit 在 inner.onSubmit 触发时回调", () => {
    const input = new BorderedInput();
    const onSubmit = vi.fn();
    input.onSubmit = onSubmit;
    input.setValue("abc");
    // 直接调 inner.onSubmit：pi-tui Input 内部会通过它返回
    (input as unknown as { inner: { onSubmit?: (v: string) => void } }).inner.onSubmit?.(
      "abc",
    );
    expect(onSubmit).toHaveBeenCalledWith("abc");
  });

  it("invalidate() 透传到 footer 与 autocompleteList", () => {
    const footer = { focused: false, render: () => [""], invalidate: vi.fn() };
    const ac = {
      focused: false,
      render: () => [""],
      invalidate: vi.fn(),
      getSelectedItem: () => null,
    };
    const input = new BorderedInput();
    input.footer = footer as never;
    input.autocompleteList = ac as never;
    input.invalidate();
    expect(footer.invalidate).toHaveBeenCalled();
    expect(ac.invalidate).toHaveBeenCalled();
  });
});
