// ---------------------------------------------------------------------------
// PermissionPanelSlot — 输入框上方的“预留 N 行”槽
//
// 设计动机：
// 让权限弹窗永久钉在输入框上方（见 chat-app.ts：tui.addChild 在 inputComp 之前），
// 与消息流无得，但仍处于 ChatApp 静态组件树，无需 overlay 浮动。
//
// 行为：
// - 无内容 → 渲染“保留高度”行纯空白（无染色,与默认终端背景一致）
// - 有内容 → 接收外部构建好的多行 ANSI 字符串数组(可能含背景填色)，原样渲染。
//
// 为什么不像 Text / Box：复制其多行 paddingY / 边框等场景过于肨肿。
// 本组件仅多行渲染，内容均由调用方预构建，避免双重包装带来的 line 计数偏差。
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export class PermissionPanelSlot implements Component {
  /** 预构建好的多行（可能含 ANSI）。默认占位：3 行空白。 */
  static readonly DEFAULT_RESERVED_ROWS = 3;

  /** 预构建的多行（可能含 ANSI）。空数组表示“空槽”。 */
  #lines: string[] = [];
  /** 品牌色（#5686fe）的 ANSI 前景色转义 */
  static readonly #BRAND_FG = "\x1b[38;2;86;134;254m";
  /** 粗体开 */
  static readonly #BOLD_ON = "\x1b[1m";
  /** 粗体关 */
  static readonly #BOLD_OFF = "\x1b[22m";
  /** 前景重置 */
  static readonly #FG_RESET = "\x1b[39m";
  /** 槽位始终占据的行数（无内容也占这些行，保证布局不闪跳）。 */
  readonly #reservedRows: number;

  constructor(reservedRows: number = PermissionPanelSlot.DEFAULT_RESERVED_ROWS) {
    this.#reservedRows = reservedRows;
  }

  /**
   * 设置面板内容（多行,每行可能含 ANSI 转义/背景填色）。
   *
   * @param lines — 多行字符串数组；传空数组则重置为空槽。
   */
  setContent(lines: ReadonlyArray<string>): void {
    this.#lines = [...lines];
  }

  /**
   * 显示初始 DskCode 品牌标识（主题色加粗）。
   * 默认居中放置于 reservedRows 槽位的中间一行（上下留白对称）。
   * 当第一条消息到达后，调用方应调用 {@link clear} 隐藏它。
   */
  showDskCode(): void {
    const brand =
      PermissionPanelSlot.#BRAND_FG +
      PermissionPanelSlot.#BOLD_ON +
      "DskCode, A DeepSeek-native minimalism AI coding agent!" +
      PermissionPanelSlot.#BOLD_OFF +
      PermissionPanelSlot.#FG_RESET;
    const brandLine = "  " + brand + "  ";
    // 将品牌行放到 reservedRows 的几何中心（上下留白对称）。
    const reserved = this.#reservedRows;
    const middle = Math.floor(reserved / 2);
    const lines: string[] = [];
    for (let i = 0; i < reserved; i++) {
      lines.push(i === middle ? brandLine : "");
    }
    this.#lines = lines;
  }

  /** 重置为空槽（仍占满保留行数）。 */
  clear(): void {
    this.#lines = [];
  }

  /** 当前是否处于空槽状态。 */
  get isEmpty(): boolean {
    return this.#lines.length === 0;
  }

  /**
   * 渲染接口：TUI 按 addChild 顺序垂直堆叠，
   * 我们总是输出"保留行数"行（占位行或预构建内容）。
   *
   * 无内容时（空槽）：输出纯空白行，不染色 ——让槽位占住但不占地背景。
   * 有内容时：接管由调用方(chat-app wrapLine)预染色的多行，原样输出。
   *
   * 安全：每行末尾做 `truncateToWidth(line, width, "")` 兑底，避免上游调用者。
   */
  render(width: number): string[] {
    if (width <= 0) {
      // TUI 启动期 width 可能为 0，退化到 1 列宽保证 3 行占位
      const w = 1;
      const rows: string[] = [];
      for (let i = 0; i < this.#reservedRows; i++) rows.push(" ".repeat(w));
      return rows;
    }
    // 空槽：不染色,纯空白行。布局仍占 N 行但不堆出背景。
    if (this.#lines.length === 0) {
      const rows: string[] = [];
      for (let i = 0; i < this.#reservedRows; i++) {
        rows.push(" ".repeat(width));
      }
      return rows;
    }
    // 有内容：返回 `预构建行 + 补齐空白到 reservedRows`
    // 兑底：任何调用方传入超出 width 的行 用 truncateToWidth 严格截，防止
    // pi-tui 探测超宽抛终端崩溃。
    const result: string[] = [];
    const max = Math.max(this.#lines.length, this.#reservedRows);
    const blankPad = " ".repeat(width);
    for (let i = 0; i < max; i++) {
      const raw = this.#lines[i] ?? blankPad;
      // 仅可见宽度超 width 才截，避免正常内容被吃
      if (raw.includes("\x1b[") || raw === blankPad) {
        // 含 ANSI 的行：调用 truncateToWidth 安全
        const safe = truncateToWidth(raw, width, "");
        result.push(safe);
      } else {
        result.push(raw);
      }
    }
    return result;
  }

  /**
   * 主题变更等场景需要重渲缓存时调用。
   * 本组件不缓存,no-op 足够。
   */
  invalidate(): void {
    // no-op
  }
}
