// ---------------------------------------------------------------------------
// Skill 模块公共导出
//
// Phase 1（核心解析）+ Phase 2（loader + catalog）。Phase 3 会加入 envelope
// 与 skill 工具层（envelope 在 src/skill/envelope.ts 内部被 skill 工具引用，
// 暂时不导出，等 Phase 3 一起接）。
// ---------------------------------------------------------------------------

export type {
  Skill,
  SkillSource,
  SkillSummary,
  SkillLoadError,
  SkillLoadWarning,
} from "./types.js";
export { getGlobalSkillsDir, getProjectSkillDir } from "./paths.js";
export {
  parseSkillFrontmatter,
  validateName,
  extractDescription,
  MAX_SKILL_NAME_LEN,
  MAX_SKILL_DESCRIPTION_LEN,
  MAX_SKILL_FILE_SIZE,
  MAX_SKILL_DESCRIPTIONS_SIZE,
} from "./frontmatter.js";
export type { ParsedFrontmatter, SkillMetadata } from "./frontmatter.js";
export { loadSkillsFromDirectory, loadAllSkills, readSkillBody } from "./loader.js";
export type { SkillLoadResult, LoadOptions } from "./loader.js";
export { selectCatalogSkills } from "./catalog.js";
export type { CatalogResult, CatalogOptions } from "./catalog.js";
export { xmlEscape, neutralizeEnvelopeTags, renderSkillEnvelope } from "./envelope.js";
export { parseSkillCommand, expandSkillCommand } from "./expand.js";
