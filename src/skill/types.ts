// ---------------------------------------------------------------------------
// Skill 核心数据模型
//
// 对齐 zed `crates/agent_skills/agent_skills.rs` 中的 `Skill` / `SkillSource` /
// `SkillSummary`。ts-version 不实现 built-in skill（v0.7 暂不做），只区分
// "global"（~/.dskcode/skills）与 "project-local"（<cwd>/.dskcode/skill）。
// ---------------------------------------------------------------------------

/**
 * Skill 来源。
 *
 * ts-version 不实现 built-in（先不做），只区分全局 / 项目本地。
 */
export type SkillSource = "global" | "project-local";

/**
 * 加载阶段产生的非致命警告集合。
 *
 * - description_too_long：description 字节数超过 MAX_SKILL_DESCRIPTION_LEN，
 *   仍加载进 catalog（不阻断）
 * - file_too_large：SKILL.md 字节数超过 MAX_SKILL_FILE_SIZE，
 *   在 Phase 1 的 frontmatter 解析里我们用 short-circuit 拒绝（与 zed 一致）
 */
export type SkillLoadWarning =
  | { kind: "description_too_long"; actualLen: number; maxLen: number }
  | { kind: "file_too_large"; actualLen: number; maxLen: number };

/**
 * 已加载的完整 Skill（包含 body 路径）。
 *
 * body 不在加载阶段读，按需通过 readSkillBody() 加载。
 */
export interface Skill {
  /** frontmatter 中的 name，已校验过命名规则 */
  name: string;
  /** frontmatter 中的 description，trim 后非空 */
  description: string;
  /** Skill 所在根目录的绝对路径（skill 目录的父级，目录名 = name） */
  directoryPath: string;
  /** SKILL.md 的绝对路径 */
  skillFilePath: string;
  /** 来源 */
  source: SkillSource;
  /** 非致命警告（描述过长、文件超大等） */
  loadWarnings: SkillLoadWarning[];
  /** frontmatter 的 disable_model_invocation: true → 不进 prompt、不允许 skill 工具加载 */
  disableModelInvocation: boolean;
}

/**
 * 注入 system prompt 的轻量 summary。
 *
 * 只包含 name / description / location（绝对路径），避免将完整 Skill 内容复制进 prompt。
 */
export interface SkillSummary {
  name: string;
  description: string;
  /** SKILL.md 绝对路径，给 skill 工具回调用 */
  location: string;
  source: SkillSource;
}

/**
 * 加载失败时的错误描述（不会抛错，调用方收集到数组里统一处理）。
 */
export interface SkillLoadError {
  /** SKILL.md 的绝对路径（解析失败时） */
  skillFilePath: string;
  /** 给 UI / logger 看的中文错误信息 */
  message: string;
}

/**
 * 单个 skill 的展示信息（供 UI 层选择器 / 列表使用）。
 * 只包含最小字段，body / 路径都不在此处。
 */
export interface SkillInfo {
  name: string;
  description: string;
}
