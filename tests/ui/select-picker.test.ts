/**
 * Tests for the generic SelectPicker component in `agent-term/src/ui/tui/select-picker.ts`.
 *
 * These cover:
 *   - render: title/hint 可选；默认主题是绿色高亮；行宽不超 width
 *   - getSelectList: 返回的 SelectList 仍可用于嵌入式场景（BorderedInput.autocompleteList）
 *   - getSelectedItem: 跟随 initialValue / SelectList 内部状态
 *   - updateItems: 重建内层 SelectList 并尽量保持原选中
 *   - 不调用 show 时，root 仍可作为 Component 渲染
 */

import { describe, expect, it, vi } from "vitest";
import { visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import { SelectPicker } from "../../src/ui/tui/select-picker.js";

const items: SelectItem[] = [
  { value: "deepseek-v4-flash", label: "deepseek-v4-flash" },
  { value: "deepseek-v4-pro", label: "deepseek-v4-pro" },
  { value: "deepseek-r1", label: "deepseek-r1" },
];

// 用一个最小化的假 TUI：只需要 SelectPicker.show() / setFocus / requestRender 用到的接口。
function makeFakeTui() {
  const showOverlay = vi.fn((_comp: unknown, _opts: unknown) => {
    return {
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: () => false,
      focus: vi.fn(),
      unfocus: vi.fn(),
      isFocused: () => true,
    };
  });
  return {
    addChild: () => undefined,
    showOverlay,
    setFocus: vi.fn(),
    requestRender: vi.fn(),
  } as unknown as ConstructorParameters<typeof SelectPicker>[0] & {
    showOverlay: ReturnType<typeof vi.fn>;
    setFocus: ReturnType<typeof vi.fn>;
    requestRender: ReturnType<typeof vi.fn>;
  };
}

describe("SelectPicker", () => {
  it("默认主题（绿色高亮）渲染选中项", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, { items });
    const lines = picker.render(40);
    // 选中项（默认 0）应包含 "deepseek-v4-flash" 与绿色 ANSI。
    // chalk level=1 在 vitest 下走 16 色码：绿色为 \x1b[92m。
    const all = lines.join("\n");
    expect(all).toContain("deepseek-v4-flash");
    expect(all).toMatch(/\x1b\[(?:92|38;2;0;255;65)m/);
  });

  it("title 与 hint 都未传时不渲染标题与 hint", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, { items });
    const lines = picker.render(40);
    // 没有标题、不应有 "选择" "选择模型" 之类字样
    expect(lines.join("\n")).not.toContain("选择");
    // 不应出现 hint 文本
    expect(lines.join("\n")).not.toContain("确认");
  });

  it("传 title 时渲染标题行；hint 默认显示", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, { items, title: "选择模型：" });
    const lines = picker.render(60);
    const all = lines.join("\n");
    expect(all).toContain("选择模型：");
    expect(all).toContain("↑↓ 选择 · Enter 确认 · Esc 取消");
  });

  it("hint=null 不渲染底部 hint", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, { items, title: "X", hint: null });
    const lines = picker.render(60);
    expect(lines.join("\n")).not.toContain("确认");
  });

  it("自定义 hint 会覆盖默认", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, {
      items,
      title: "X",
      hint: "敲回车切换",
    });
    const lines = picker.render(60);
    expect(lines.join("\n")).toContain("敲回车切换");
  });

  it("行宽不能超 width（pi-tui 宽度契约）", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, { items, title: "选择模型：" });
    for (const l of picker.render(40)) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    }
  });

  it("initialValue 设置初始选中项", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, {
      items,
      initialValue: "deepseek-r1",
    });
    expect(picker.getSelectedItem()?.value).toBe("deepseek-r1");
  });

  it("onSelect 回调在选中时触发", () => {
    const tui = makeFakeTui();
    const onSelect = vi.fn();
    const picker = new SelectPicker(tui, { items, onSelect });
    picker.getSelectList().onSelect?.(items[1]!);
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("onCancel 回调在取消时触发", () => {
    const tui = makeFakeTui();
    const onCancel = vi.fn();
    const picker = new SelectPicker(tui, { items, onCancel });
    picker.getSelectList().onCancel?.();
    expect(onCancel).toHaveBeenCalled();
  });

  it("updateItems 保持原选中（若仍存在）", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, { items });
    // 选中第二项
    picker.getSelectList().setSelectedIndex(1);
    expect(picker.getSelectedItem()?.value).toBe("deepseek-v4-pro");
    // 更新：保留 deepseek-v4-pro
    const next: SelectItem[] = [
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash" },
      { value: "deepseek-v4-pro", label: "deepseek-v4-pro" },
      { value: "other", label: "other" },
    ];
    picker.updateItems(next);
    expect(picker.getSelectedItem()?.value).toBe("deepseek-v4-pro");
    // 仍能渲染
    const lines = picker.render(40);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("updateItems 原选中不在新列表时回到第一项", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, { items });
    picker.getSelectList().setSelectedIndex(2); // deepseek-r1
    picker.updateItems([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
    expect(picker.getSelectedItem()?.value).toBe("a");
  });

  it("show() 调用 tui.showOverlay 并 setFocus 到内层 list", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, {
      items,
      overlay: { width: 60, anchor: "center" },
    });
    picker.show();
    expect(
      (tui as unknown as { showOverlay: ReturnType<typeof vi.fn> }).showOverlay,
    ).toHaveBeenCalled();
    expect(
      (tui as unknown as { setFocus: ReturnType<typeof vi.fn> }).setFocus,
    ).toHaveBeenCalledWith(picker.getSelectList());
    expect(
      (tui as unknown as { requestRender: ReturnType<typeof vi.fn> }).requestRender,
    ).toHaveBeenCalled();
  });

  it("close() 隐藏 overlay 并清空 handle", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, {
      items,
      overlay: { width: 40, anchor: "center" },
    });
    picker.show();
    picker.close();
    // 二次 close 也安全
    picker.close();
    // requestRender 被多次调用不抛错
  });

  it("getSelectList() 每次 updateItems 后返回新实例", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, { items });
    const before = picker.getSelectList();
    picker.updateItems([{ value: "x", label: "x" }]);
    const after = picker.getSelectList();
    expect(after).not.toBe(before);
  });

  it("嵌入用法：把 getSelectList() 挂到 BorderedInput.autocompleteList 后仍能作为 Component 渲染", () => {
    const tui = makeFakeTui();
    const picker = new SelectPicker(tui, { items, initialValue: "deepseek-v4-pro" });
    const list = picker.getSelectList();
    // 不调 show，root 仍能渲染（用于嵌入到 BorderedInput 下方）
    const lines = picker.render(40);
    expect(lines.length).toBeGreaterThan(0);
    // list 本身也能独立渲染（嵌入父布局会逐个 render 子）
    const listLines = list.render(40);
    expect(listLines.some((l) => l.includes("deepseek-v4-flash"))).toBe(true);
  });

  it("onSelect / onCancel 不应在 closePicker 闭包未初始化时抛 ReferenceError（回归测试）", () => {
    // 模拟 ChatApp.showModelSelector 的调用序列：先 new SelectPicker(传入 onSelect/onCancel)，
    // 再 getSelectList()，再声明 closePicker 闭包。onSelect 在用户敲 Enter 后被调用，
    // 此时 closePicker 已声明。
    const tui = makeFakeTui();
    let closePicker: () => void = () => undefined;
    let captured: SelectItem | null = null;
    const picker = new SelectPicker(tui, {
      items,
      onSelect: (item) => {
        captured = item;
        closePicker();
      },
      onCancel: () => {
        closePicker();
      },
    });
    const list = picker.getSelectList();
    closePicker = () => {
      // 仅作闭包读到 list 不会跳错
      void list;
    };
    // 现在模拟用户按 Enter
    expect(() => list.onSelect?.(items[1]!)).not.toThrow();
    expect(captured?.value).toBe("deepseek-v4-pro");
    expect(() => list.onCancel?.()).not.toThrow();
  });

  it("嵌入用法下用户在 SelectList 上按 Enter 应触发 onSelect（模型选择 bug 回归）", () => {
    // 背景：之前模型选择改成嵌入到 BorderedInput.autocompleteList 后，
    // 焦点仍在 BorderedInput（其 inner 是 pi-tui Input），
    // SelectList 收不到键盘事件，onSelect 永远不触发 → “切换模型无反应”。
    // 修复后：handleGlobalKey → handleAutocompleteKey 显式转给 SelectList.handleInput。
    // 这里验证：SelectList.handleInput 在 Enter 键上会调用 onSelect。
    const tui = makeFakeTui();
    const onSelect = vi.fn();
    const picker = new SelectPicker(tui, {
      items,
      initialValue: "deepseek-v4-flash",
      onSelect,
    });
    const list = picker.getSelectList();
    // 模拟 chat-app 中转发的路径：直接调 SelectList.handleInput(Enter)
    // pi-tui keybinding "tui.select.confirm" 对应 \r（enter）
    list.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ value: "deepseek-v4-flash" }),
    );
  });
});
