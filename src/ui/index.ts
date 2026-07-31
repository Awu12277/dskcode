// ---------------------------------------------------------------------------
// UI 组件统一导出
//
// Ink 版组件已移除，全部使用 @earendil-works/pi-tui 实现。
// ---------------------------------------------------------------------------

// pi-tui 集成组件
export { ChatApp, createChatApp, registerCommand } from "./tui/index.js";
export { markdownTheme, COLORS } from "./tui/theme.js";

// 通用工具函数（纯函数，与框架无关）
export {
  filterFilesByInput,
  filterAndRank,
  scoreFile,
  allSubstringsMatch,
} from "./file-search.js";
