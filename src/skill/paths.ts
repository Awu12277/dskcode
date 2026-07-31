// ---------------------------------------------------------------------------
// Skill 目录路径解析
//
// 从 `src/cli/skill-import.ts` 迁出来，给 skill 加载/注入层用。
// CLI 层的 `skill-import.ts` 改为 re-export，保持向后兼容。
// ---------------------------------------------------------------------------

import { join } from "node:path";

/**
 * 全局 skills 目录路径（~/.agents/skills）。
 *
 * 跨平台兼容：优先用 HOME，Windows 下回退到 USERPROFILE。
 * 与 coding-agent 的约定一致。
 */
export function getGlobalSkillsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return join(home, ".agents", "skills");
}

/**
 * 项目本地 skill 目录路径（{cwd}/.agents/skills）。
 *
 * 与 coding-agent 的约定一致。
 */
export function getProjectSkillDir(cwd: string): string {
  return join(cwd, ".agents", "skills");
}
