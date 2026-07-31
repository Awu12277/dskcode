// ---------------------------------------------------------------------------
// Skill 目录裁剪（catalog selection）
//
// 对齐 zed `crates/agent/src/agent.rs::select_catalog_skills` (L3433-3495)。
//
// 规则：
//   1. 过滤掉 `disable_model_invocation === true` 的 skill
//   2. 按 `skillFilePath` 排序后依次尝试加入 catalog
//   3. 累积 (name + description) 字节数；超过 `maxBytes` 时停止加入
//   4. 一旦某个 model-invocable skill 超出预算，**之后所有 skill 一律丢弃**
//      （zed 的"deterministic by sort order" 行为：避免"刚好能塞下小 skill
//      的剩余空间"导致的不确定性）
//
// 与 zed 的差异：
//   - zed 返回 `(Vec<SkillSummary>, Vec<SkillLoadingIssueData>)` 并附带
//     给 UI 的 i18n 错误信息；ts-version v0.7 不引入 SkillLoadingIssue
//     类型，只返回 `{ catalog, dropped }`，UI 自己拼装提示
// ---------------------------------------------------------------------------

import { MAX_SKILL_DESCRIPTIONS_SIZE } from "./frontmatter.js";
import type { Skill, SkillSummary } from "./types.js";

/** selectCatalogSkills 的返回结构 */
export interface CatalogResult {
  /** 注入 system prompt 的轻量 summary 列表 */
  catalog: SkillSummary[];
  /** 被预算丢弃的 skill（按 skillFilePath 排序；包括 disable_model_invocation 之外的所有丢弃原因） */
  dropped: Skill[];
}

/** selectCatalogSkills 选项 */
export interface CatalogOptions {
  /** 描述总字节预算，默认 MAX_SKILL_DESCRIPTIONS_SIZE (8KB) */
  maxBytes?: number;
}

/**
 * 把加载好的 Skill[] 投影成 system prompt 用的 SkillSummary[]。
 *
 * 行为与 zed `select_catalog_skills` 一致：
 *   - 屏蔽 `disable_model_invocation === true` 的 skill（不出现在 catalog，
 *     也不出现在 dropped——这些是"模型压根不能调"的，不是"被预算裁掉"的）
 *   - 一次性按序裁剪：超预算的 skill 整批丢掉
 *   - 排序键是 `skillFilePath`（与 loader 的输出顺序一致），保证多次调用结果一致
 */
export function selectCatalogSkills(
  skills: readonly Skill[],
  opts: CatalogOptions = {},
): CatalogResult {
  const maxBytes = opts.maxBytes ?? MAX_SKILL_DESCRIPTIONS_SIZE;

  // 先按 skillFilePath 排序（输入通常已排序，这里幂等兜底）
  const sorted = [...skills].toSorted((a, b) =>
    a.skillFilePath.localeCompare(b.skillFilePath),
  );

  const catalog: SkillSummary[] = [];
  const dropped: Skill[] = [];
  let totalSize = 0;
  let budgetExceeded = false;

  for (const skill of sorted) {
    if (skill.disableModelInvocation) {
      // 屏蔽类：不进 catalog，也不进 dropped（语义不同）
      continue;
    }

    const entrySize =
      Buffer.byteLength(skill.name, "utf8") +
      Buffer.byteLength(skill.description, "utf8");

    if (!budgetExceeded && totalSize + entrySize <= maxBytes) {
      totalSize += entrySize;
      catalog.push({
        name: skill.name,
        description: skill.description,
        location: skill.skillFilePath,
        source: skill.source,
      });
    } else {
      budgetExceeded = true;
      dropped.push(skill);
    }
  }

  return { catalog, dropped };
}
