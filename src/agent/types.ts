// ---------------------------------------------------------------------------
// Agent 主循环事件类型定义（MVP 版）
//
// 砍掉了 CompactionEvent / GoalEvent，保留核心流式事件。
// ---------------------------------------------------------------------------

import type { ProviderToolCall, UsageInfo } from "../provider/index.js";
import type { ToolResult } from "../tool/types.js";

/** Agent 事件 — Session.chat() 流式输出的每一步 */
export type AgentEvent =
  | { type: "text_delta"; content: string }
  | { type: "reasoning_delta"; content: string }
  | { type: "tool_calls"; calls: ProviderToolCall[] }
  | { type: "tool_result"; name: string; result: ToolResult; callId?: string }
  | { type: "usage"; usage: UsageInfo; model: string; cost?: number; estimated?: boolean }
  | { type: "done"; elapsed: number }
  | { type: "error"; error: Error };

/** Agent 循环中的消息角色 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 会话模式 */
export type SessionMode = "code";

/** 会话状态 */
export type SessionPhase = "idle" | "thinking" | "streaming" | "tool_calling" | "error";

/** 单个工具的描述（用于注入 system prompt） */
export interface ToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 给系统提示词的一句话说明，未传则退化为 description */
  promptSnippet?: string;
  /** 给系统提示词的用法要点列表 */
  promptGuidelines?: ReadonlyArray<string>;
}

/** 单个 skill 的 system prompt 视图。对齐 src/skill/types.ts 的 SkillSummary。 */
export interface SkillSummaryView {
  name: string;
  description: string;
  /** SKILL.md 绝对路径 */
  location: string;
  /** 来源："global" | "project-local" */
  source?: string;
}

/** 单条项目指令文件（AGENTS.md / CLAUDE.md） */
export interface ProjectInstruction {
  /** 相对 cwd 的路径（POSIX 风格） */
  path: string;
  /** 文件名 */
  filename: string;
  /** 文件内容 */
  content: string;
}

/** 构建系统提示词的选项 */
export interface SystemPromptOptions {
  model: string;
  tools?: ToolDescription[];
  /** 外部传入的项目上下文（可覆写从文件加载的指令） */
  projectContext?: string;
  /** 从 cwd 自动发现的 AGENTS.md / CLAUDE.md */
  projectInstructions?: ProjectInstruction[];
  maxToolRounds: number;
  cwd: string;
  availableSkills?: SkillSummaryView[];
}

/** 一轮完整的助手回复结果 */
export interface TurnResult {
  content: string;
  toolCalls: ProviderToolCall[];
  usage?: UsageInfo;
  model: string;
  elapsed: number;
}
