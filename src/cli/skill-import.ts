// ---------------------------------------------------------------------------
// Skill 发现与元数据加载（精简版）
//
// 直接使用 src/skill/ 模块加载 skills。
// 旧版 countDskcodeSkills / countProjectLocalSkills / getAllSkills
// 已移除（skills 直接读取 .agents/skills 文件夹）。
// ---------------------------------------------------------------------------

export type { Skill as SkillInfo } from "../skill/types.js";
