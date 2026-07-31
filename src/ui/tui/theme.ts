// ---------------------------------------------------------------------------
// pi-tui 主题定义 — 统一管理颜色函数和样式常量
// 所有组件通过此模块引用样式，便于整体调色
// ---------------------------------------------------------------------------

import chalk from "chalk";
import type {
  MarkdownTheme,
  MarkdownOptions,
  SelectListTheme,
} from "@earendil-works/pi-tui";

/** 基础颜色 */
export const COLORS = {
  /** 用户消息左侧竖线（橙色） */
  userAccent: "#FF8C00",
  /** 助手消息左侧竖线（粉紫/青色） */
  assistantAccent: "#E040FB",
  /** 主题色（输入框边框、状态栏高亮） */
  accent: "#5686fe",
  /** 列表高亮色（绿/蓝） */
  highlight: "#00ff41",
  /** 列表高亮色（蓝/命令和 skill） */
  highlightBlue: "#00bfff",
  /** 次级文本色（灰） */
  muted: "#808080",
  /** 错误色（红） */
  error: "#ff6b6b",
  /** 费用/金钱色（黄） */
  cost: "#ffd700",
  /** 警告色 */
  warning: "#ffa500",
  /** 工具/代码块色 */
  toolAccent: "#00ffff",
  /** 状态栏文本色 */
  statusFg: "#808080",
  /** 分隔线色 */
  separator: "#555555",
  // --- 工具调用块（与 pi-mono 对齐：整行带色背景） ---
  /** 工具调用 pending 背景（深灰） */
  toolPendingBg: "#282832",
  /** 工具调用成功背景（深绿） */
  toolSuccessBg: "#283228",
  /** 工具调用失败 / 被拒背景（深红） */
  toolErrorBg: "#3c2828",
  // --- 用户消息背景（与左侧竖线 #FF8C00 同色系，加深作整行背景） ---
  /** 用户消息整行背景（深棕橙，与 userAccent 协调） */
  userMsgBg: "#332010",
} as const;

// ---------------------------------------------------------------------------
// 文本样式器（统一颜色函数，避免组件内手写 ANSI 转义）
// ---------------------------------------------------------------------------

/** 文本样式器集合。所有函数 (text) => string，等价于 chalk 的着色函数。 */
export interface StyleSet {
  /** 主题色（输入框边框、状态栏高亮） */
  accent: (s: string) => string;
  /** 状态栏金额色（黄） */
  gold: (s: string) => string;
  /** 次级文本色（灰 / dim） */
  muted: (s: string) => string;
  /** dim 灰色（ANSI 90） */
  dim: (s: string) => string;
  /** 深度思考内容：灰色斜体 */
  thinking: (s: string) => string;
  /** 错误色（红） */
  error: (s: string) => string;
  /** 警告色（橙） */
  warning: (s: string) => string;
  /** 工具/代码块色（青） */
  toolAccent: (s: string) => string;
  /** 重置 ANSI */
  reset: (s: string) => string;
  /** 用户消息竖线（橙） */
  userBar: (s: string) => string;
  /** 助手消息竖线（粉紫） */
  assistantBar: (s: string) => string;
  /** 列表高亮（绿） */
  highlight: (s: string) => string;
  /** 列表高亮（蓝） */
  highlightBlue: (s: string) => string;
  /** 工具标题（白色加粗） */
  toolTitle: (s: string) => string;
  /** 工具输出（灰） */
  toolOutput: (s: string) => string;
  /** 工具 pending 背景 */
  toolPendingBg: (s: string) => string;
  /** 工具 success 背景 */
  toolSuccessBg: (s: string) => string;
  /** diff 新增行（绿） */
  toolDiffAdded: (s: string) => string;
  /** diff 删除行（红） */
  toolDiffRemoved: (s: string) => string;
  /** diff 上下文行（灰） */
  toolDiffContext: (s: string) => string;
  /** SGR 反色高亮（用于内联 word-level diff） */
  inverse: (s: string) => string;
  /** 工具 error 背景 */
  toolErrorBg: (s: string) => string;
  /** 用户消息整行背景（深棕橙） */
  userMsgBg: (s: string) => string;
  /** 权限弹窗面板背景（主题色 #5686fe 取 18% 亮度，伪“半透明”) */
  permissionPanelBg: (s: string) => string;
  /** 权限弹窗面板背景：警告色 #ffa500 取 18% 亮度（黄色柔色） */
  permissionPanelBgY: (s: string) => string;
  /** 权限弹窗面板背景：浅灰 #2a2a30（与消息流默认背景区分,高可读性） */
  permissionPanelBgG: (s: string) => string;
}

/** 默认文本样式集合（基于 COLORS） */
export const styles: StyleSet = {
  accent: (s) => chalk.hex(COLORS.accent)(s),
  gold: (s) => chalk.hex(COLORS.cost)(s),
  muted: (s) => chalk.hex(COLORS.muted)(s),
  dim: (s) => chalk.dim(s),
  // 深度思考内容：与 coding-agent 对齐的浅灰色 (#808080) + 斜体。
  // 不使用 chalk.gray：终端会把 chalk.gray 解析为偏深的灰，与主题意图不符。
  thinking: (s: string) => `\x1b[38;2;128;128;128m\x1b[3m${s}\x1b[23m\x1b[0m`,
  error: (s) => chalk.hex(COLORS.error)(s),
  warning: (s) => chalk.hex(COLORS.warning)(s),
  toolAccent: (s) => chalk.hex(COLORS.toolAccent)(s),
  reset: (s) => chalk.reset(s),
  userBar: (s) => chalk.hex(COLORS.userAccent)(s),
  assistantBar: (s) => chalk.hex(COLORS.assistantAccent)(s),
  highlight: (s) => chalk.hex(COLORS.highlight)(s),
  highlightBlue: (s) => chalk.hex(COLORS.highlightBlue)(s),
  toolTitle: (s) => chalk.white.bold(s),
  toolOutput: (s) => chalk.hex(COLORS.muted)(s),
  // 24-bit 背景：\x1b[48;2;R;G;Bm ... \x1b[0m
  toolPendingBg: (s) => `\x1b[48;2;40;40;50m${s}\x1b[0m`,
  toolSuccessBg: (s) => `\x1b[48;2;40;50;40m${s}\x1b[0m`,
  toolErrorBg: (s) => `\x1b[48;2;60;40;40m${s}\x1b[0m`,
  // diff 行级前景色：与 coding-agent dark 主题对齐
  toolDiffAdded: (s) => chalk.hex("#b5bd68")(s),
  toolDiffRemoved: (s) => chalk.hex("#cc6666")(s),
  toolDiffContext: (s) => chalk.hex(COLORS.muted)(s),
  // SGR 7 = 反色（前景/背景互换），用于 word-level 变化高亮
  inverse: (s) => `\x1b[7m${s}\x1b[27m`,
  // 用户消息背景：#332010 = (51, 32, 16)
  userMsgBg: (s) => `\x1b[48;2;51;32;16m${s}\x1b[0m`,
  // 权限弹窗面板背景：用 accent 的 18% 亮度代替透明度。
  // #5686fe 转 18% = (22, 33, 63)（动态计算不必要，这里直接写死 RGB）。
  permissionPanelBg: (s) => `\x1b[48;2;22;33;63m${s}\x1b[0m`,
  // 黄色背景：warning #ffa500 = (255, 165, 0)，取 18% 亮度 ≈ (46, 30, 0)。
  permissionPanelBgY: (s) => `\x1b[48;2;46;32;15m${s}\x1b[0m`,
  // 浅灰背景：#2a2a30 = (42, 42, 48),与消息流默认黑底区分。
  permissionPanelBgG: (s) => `\x1b[48;2;42;42;48m${s}\x1b[0m`,
};

/**
 * 包裹一段普通文本：在文本前后加上指定颜色的前缀。
 * 用于构造类似 `▸ 选中项` 之类需要保留 raw 文本方便布局计算的场景。
 */
export function wrap(prefix: string, text: string, suffix = "\x1b[0m"): string {
  return `${prefix}${text}${suffix}`;
}

/** 助手消息左侧竖线（粉紫）+ reset，常量以避免每帧重新构造字符串。 */
export const ASSISTANT_BAR = wrap(chalk.hex(COLORS.assistantAccent)("\u2502"), "");

/** 用户消息左侧竖线（橙）+ reset。 */
export const USER_BAR = wrap(chalk.hex(COLORS.userAccent)("\u2502"), "");

// ---------------------------------------------------------------------------
// Markdown 主题 — 渲染 AI 回复内容
// ---------------------------------------------------------------------------

export const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.hex("#E040FB").bold(s),
  link: (s) => chalk.hex("#00bfff").underline(s),
  linkUrl: (s) => chalk.dim(s),
  code: (s) => chalk.hex("#ff79c6")(s),
  codeBlock: (s) => s,
  codeBlockBorder: (s) => chalk.dim(s),
  quote: (s) => chalk.italic.dim(s),
  quoteBorder: (s) => chalk.dim(s),
  hr: (s) => chalk.dim(s),
  listBullet: (s) => chalk.hex(COLORS.highlight)(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
};

/** Markdown 渲染选项 */
export const markdownOptions: MarkdownOptions = {
  preserveOrderedListMarkers: true,
};

// ---------------------------------------------------------------------------
// Markdown 主题（内联 / 摘要 — 更简洁）
// ---------------------------------------------------------------------------

export const inlineMarkdownTheme: MarkdownTheme = {
  ...markdownTheme,
  code: (s) => chalk.hex("#ff79c6")(s),
  codeBlock: (s) => s,
};

// ---------------------------------------------------------------------------
// SelectList 主题 — 文件 / @ 引用列表
// ---------------------------------------------------------------------------

export const fileSelectTheme: SelectListTheme = {
  selectedPrefix: (s) => styles.highlight("▸ "),
  selectedText: (s) => styles.highlight(s),
  description: (s) => styles.dim(s),
  scrollInfo: (s) => styles.dim(s),
  noMatch: (s) => styles.dim(s),
};

export const commandSelectTheme: SelectListTheme = {
  selectedPrefix: (s) => styles.highlightBlue("▸ "),
  selectedText: (s) => styles.highlightBlue(s),
  description: (s) => styles.dim(s),
  scrollInfo: (s) => styles.dim(s),
  noMatch: (s) => styles.dim(s),
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 格式化毫秒 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 格式化金额 */
export function formatCost(cost: number): string {
  return `¥${cost.toFixed(4)}`;
}
