// ---------------------------------------------------------------------------
// Skill 信封渲染 — `<skill_content>` envelope
//
// 对齐 zed `crates/agent/src/tools/skill_tool.rs`：
//   - `xml_escape`              (L17-19)
//   - `neutralize_envelope_tags` (L28-32)
//   - `render_skill_envelope`    (L46-78)
//
// ts-version 差异：
//   - 不在信封里写 `<worktree>`（ts-version 无 worktree 概念）
//   - 不在信封里写 `<worktree>` 与 built-in 区别（ts-version v0.7 不实现
//     built-in skill）
//   - source 直接用 `SkillSource` 字符串（"global" / "project-local"）
// ---------------------------------------------------------------------------

import type { Skill } from "./types.js";

// ---------------------------------------------------------------------------
// xmlEscape
// ---------------------------------------------------------------------------

/**
 * XML 转义 5 个预定义实体。
 *
 * 与 zed `quick_xml::escape::escape` 等价：只转义 `&`、`<`、`>`、`"`、`'`，
 * 不动其他字符（避免把合法 Markdown HTML 也 entity-mangle）。
 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// neutralizeEnvelopeTags
// ---------------------------------------------------------------------------

/**
 * 把 body 中可能出现的 `<skill_content` / `</skill_content` 字面量替换成
 * `&lt;...`，防止恶意 skill body 闭合我们的信封。
 *
 * 与 zed 一致：只处理开闭两种起始字面量，不过度转义（合法 Markdown HTML 如
 * `<details>` / `<a href="...">` 原样保留）。
 */
export function neutralizeEnvelopeTags(body: string): string {
  return body
    .replace(/<skill_content/g, "&lt;skill_content")
    .replace(/<\/skill_content/g, "&lt;/skill_content");
}

// ---------------------------------------------------------------------------
// renderSkillEnvelope
// ---------------------------------------------------------------------------

/**
 * 渲染 skill body 给 LLM 看的标准信封。
 *
 * 输出结构（与 zed `render_skill_envelope` 对齐，缺 `<worktree>` 段）：
 *
 *   <skill_content name="...">
 *   <source>global|project-local</source>
 *   <directory>...</directory>
 *   Relative paths in this skill resolve against <directory>.
 *
 *   <body 内容，neutralize 后的>
 *   </skill_content>
 *
 * 所有插值都用 xmlEscape 防注入；body 走 neutralizeEnvelopeTags 二次防御。
 */
export function renderSkillEnvelope(skill: Skill, body: string): string {
  const name = xmlEscape(skill.name);
  const source = xmlEscape(skill.source);
  const directory = xmlEscape(skill.directoryPath);
  const safeBody = neutralizeEnvelopeTags(body.trim());

  return (
    `<skill_content name="${name}">\n` +
    `<source>${source}</source>\n` +
    `<directory>${directory}</directory>\n` +
    `Relative paths in this skill resolve against <directory>.\n` +
    `\n` +
    `${safeBody}\n` +
    `</skill_content>\n`
  );
}
