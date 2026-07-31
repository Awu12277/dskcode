// ---------------------------------------------------------------------------
// @earendil-works/pi-tui 集成入口
//
// 导出基于 pi-tui 的组件和创建函数，供 CLI 入口使用。
// ---------------------------------------------------------------------------

export { ChatApp, createChatApp, registerCommand } from "./chat-app.js";
export {
  markdownTheme,
  inlineMarkdownTheme,
  markdownOptions,
  COLORS,
  styles,
  ASSISTANT_BAR,
  USER_BAR,
  wrap,
} from "./theme.js";
export { SelectPicker, defaultSelectPickerTheme } from "./select-picker.js";
export type { SelectPickerOptions, SelectPickerTheme } from "./select-picker.js";
