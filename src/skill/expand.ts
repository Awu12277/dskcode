// ---------------------------------------------------------------------------
// Skill 斜杠命令展开
//
// 对齐 coding-agent `_expandSkillCommand` 的逻辑：
//   /skill:<name> [args] → <skill_content> envelope + [args]
// ---------------------------------------------------------------------------

import { readSkillBody } from "./loader.js";
import { renderSkillEnvelope } from "./envelope.js";
import type { Skill } from "./types.js";

/**
 * 解析 `/skill:<name> [args]` 命令。
 * 返回 null 表示不是合法的 skill 命令。
 */
export function parseSkillCommand(text: string): { name: string; args: string } | null {
	const match = text.match(/^\/skill:(\S+)\s*(.*)$/s);
	if (!match) return null;
	return {
		name: match[1]!,
		args: match[2]?.trim() ?? "",
	};
}

/**
 * 展开 `/skill:<name> [args]` 命令为完整的 skill envelope。
 *
 * 返回格式：
 *   <skill_content name="...">
 *   <source>...</source>
 *   <directory>...</directory>
 *   Relative paths in this skill resolve against <directory>.
 *
 *   [skill body]
 *   </skill_content>
 *
 *   [args]
 *
 * 如果 skill 找不到则返回 null。
 */
export async function expandSkillCommand(
	text: string,
	skills: Skill[],
): Promise<string | null> {
	const parsed = parseSkillCommand(text);
	if (!parsed) return null;

	const skill = skills.find((s) => s.name === parsed.name);
	if (!skill) return null;

	const body = await readSkillBody(skill.skillFilePath);
	const envelope = renderSkillEnvelope(skill, body);

	if (parsed.args) {
		return `${envelope}\n\n${parsed.args}`;
	}
	return envelope;
}
