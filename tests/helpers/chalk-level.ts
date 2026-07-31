/**
 * Vitest setup: 强制 chalk 始终输出 ANSI 转义码。
 * 默认情况下，chalk 在非 TTY 环境（如 vitest runner）会禁用颜色。
 * 但 TUI 组件的渲染契约（宽度计算、样式字符串）依赖 ANSI 的存在与不存在的
 * 精确差异；这里固定 level=1 模拟真实终端。
 */
import chalk from "chalk";

chalk.level = 1;
