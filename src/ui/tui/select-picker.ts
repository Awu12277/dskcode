// ---------------------------------------------------------------------------
// 通用选择弹窗（基于 pi-tui SelectList + Container）
//
// 统一三处选择列表的视觉与行为：
//   - ChatApp 的模型选择 overlay
//   - BorderedInput 嵌入的 / 命令补全
//   - BorderedInput 嵌入的 @ 文件补全
//
// 视觉默认与命令/文件补全一致（绿色高亮、无标题、无底部 hint、命中直接 commit）。
// ---------------------------------------------------------------------------

import {
  type Component,
  Container,
  Spacer,
  Text as PiText,
  SelectList,
  TUI,
  type OverlayHandle,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import { styles } from "./theme.js";

/** 列表视觉主题（与 pi-tui SelectListTheme 等价，便于调用方覆盖）。 */
export type SelectPickerTheme = SelectListTheme;

/** 默认主题：绿色高亮（与命令/文件补全一致）。 */
export const defaultSelectPickerTheme: SelectPickerTheme = {
  selectedPrefix: (s) => styles.highlight("▸ "),
  selectedText: (s) => styles.highlight(s),
  description: (s) => styles.dim(s),
  scrollInfo: (s) => styles.dim(s),
  noMatch: (s) => styles.dim(s),
};

/** SelectPicker 配置。 */
export interface SelectPickerOptions {
  /** 列表项 */
  items: SelectItem[];
  /** 用户选中时触发（Enter / Tab）；不传则禁用 commit。 */
  onSelect?: (item: SelectItem) => void;
  /** 用户取消时触发（Esc / 列表 onCancel）。 */
  onCancel?: () => void;
  /** overlay 标题（可选；不传则不渲染标题行） */
  title?: string;
  /** 底部 hint（可选；不传则用默认 `↑↓ 选择 · Enter 确认 · Esc 取消`） */
  hint?: string;
  /** overlay 配置（仅当调用 show 时生效）。 */
  overlay?: {
    width?: number | `${number}%`;
    maxHeight?: number | `${number}%`;
    anchor?:
      | "center"
      | "top-left"
      | "top-right"
      | "bottom-left"
      | "bottom-right"
      | "top-center"
      | "bottom-center"
      | "left-center"
      | "right-center";
  };
  /** 自定义主题（覆盖默认绿色高亮） */
  theme?: SelectPickerTheme;
  /** 列表最大可见行数（默认 Math.min(items.length, 10)） */
  maxVisible?: number;
  /** 初始选中项的 value（可选） */
  initialValue?: string;
}

/**
 * 通用选择弹窗。
 *
 * 用法（overlay 形态）：
 *   const picker = new SelectPicker(tui, { items, onSelect });
 *   picker.show();           // 弹出 overlay + 转移焦点到列表
 *   picker.updateItems(...); // 动态更新候选
 *   picker.close();          // 关闭
 *
 * 也可作为 Component 直接挂到任何父 Container：直接 .render() / .invalidate() 即可。
 */
export class SelectPicker implements Component {
  /** 根容器（title / Spacer / list / Spacer / hint） */
  private root: Container = new Container();
  /** 当前 SelectList 实例（updateItems 时会重建） */
  private list: SelectList;
  private readonly tui: TUI;
  private readonly opts: SelectPickerOptions;
  private readonly theme: SelectPickerTheme;
  private handle: OverlayHandle | null = null;

  constructor(tui: TUI, opts: SelectPickerOptions) {
    this.tui = tui;
    this.opts = opts;
    this.theme = opts.theme ?? defaultSelectPickerTheme;
    this.list = this.buildList(opts.items, opts.initialValue);
    this.rebuildRoot();
  }

  /** 取出内层 SelectList（用于兼容 BorderedInput.autocompleteList 这类特殊场景）。 */
  getSelectList(): SelectList {
    return this.list;
  }

  /** 当前选中项。 */
  getSelectedItem(): SelectItem | null {
    return this.list.getSelectedItem();
  }

  /**
   * 替换列表项并尽量保持原选中（如果新列表中仍存在）。items 为空时调用方应自行 close()。
   * SelectList 没有 setItems API，所以这里重建内层列表并重新组装 root。
   */
  updateItems(items: SelectItem[], initialValue?: string): void {
    const prev = this.list.getSelectedItem()?.value;
    this.list.invalidate();
    this.list = this.buildList(
      items,
      initialValue ??
        (prev !== undefined && items.some((i) => i.value === prev) ? prev : undefined),
    );
    this.rebuildRoot();
    this.root.invalidate();
  }

  /** 弹出 overlay，焦点交给内层 SelectList。返回 OverlayHandle。 */
  show(): OverlayHandle {
    this.handle = this.tui.showOverlay(this.root, {
      width: this.opts.overlay?.width,
      maxHeight: this.opts.overlay?.maxHeight,
      anchor: this.opts.overlay?.anchor,
    });
    this.tui.setFocus(this.list);
    this.tui.requestRender();
    return this.handle;
  }

  /** 关闭 overlay 并清空 handle。 */
  close(): void {
    this.handle?.hide();
    this.handle = null;
    this.tui.requestRender();
  }

  /** Component 接口：透传到 root。 */
  render(width: number): string[] {
    return this.root.render(width);
  }

  invalidate(): void {
    this.root.invalidate();
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  /** 用 opts 构造一个内层 SelectList。 */
  private buildList(items: SelectItem[], initialValue: string | undefined): SelectList {
    const maxVisible = this.opts.maxVisible ?? Math.min(items.length, 10);
    const list = new SelectList(items, maxVisible, this.theme);
    list.onSelect = (item) => this.opts.onSelect?.(item);
    list.onCancel = () => this.opts.onCancel?.();
    if (initialValue !== undefined) {
      const idx = items.findIndex((i) => i.value === initialValue);
      if (idx >= 0) list.setSelectedIndex(idx);
    }
    return list;
  }

  /** 按 opts.title / hint 重新组装 root。 */
  private rebuildRoot(): void {
    this.root.clear();
    if (this.opts.title) {
      this.root.addChild(new PiText("  " + this.opts.title));
      this.root.addChild(new Spacer(1));
    }
    this.root.addChild(this.list);
    if (this.opts.title || this.opts.hint !== undefined) {
      this.root.addChild(new Spacer(1));
    }
    // 默认 hint：只有给了 title 才显示。显式 hint=null 表示不显示；undefined 表示用默认。
    let hint: string | undefined;
    if (this.opts.hint === null) hint = undefined;
    else if (this.opts.hint !== undefined) hint = this.opts.hint;
    else if (this.opts.title) hint = "↑↓ 选择 · Enter 确认 · Esc 取消";
    if (hint) {
      this.root.addChild(new PiText("  " + styles.dim(hint)));
    }
  }
}
