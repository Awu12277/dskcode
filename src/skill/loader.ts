// ---------------------------------------------------------------------------
// Skill 加载器
//
// 对齐 zed `crates/agent_skills/agent_skills.rs`：
//   - `find_skill_files`           (L586-616)
//   - `load_skill_frontmatter`     (L627-666)
//   - `load_skills_from_directory` (L543-579)
//   - `read_skill_body`            (L672-682)
//
// ts-version 简化：
//   - 不用 trait Fs，直接用 node:fs/promises
//   - 并发用 Promise.all + 简单信号量（默认 16，与 zed 的
//     SKILL_IO_CONCURRENCY 一致）
//   - loadAllSkills 合并全局 + 项目本地：项目本地同名覆盖全局
// ---------------------------------------------------------------------------

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSkillFrontmatter,
  MAX_SKILL_FILE_SIZE,
  type ParsedFrontmatter,
} from "./frontmatter.js";
import { getGlobalSkillsDir, getProjectSkillDir } from "./paths.js";
import type { Skill, SkillLoadError, SkillSource } from "./types.js";

/** 默认 IO 并发数（与 zed 的 SKILL_IO_CONCURRENCY 一致） */
const DEFAULT_CONCURRENCY = 16;

/** SKILL.md 文件名（与 zed 的 SKILL_FILE_NAME 一致） */
const SKILL_FILE_NAME = "SKILL.md";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** loadSkillsFromDirectory / loadAllSkills 的统一返回结构 */
export interface SkillLoadResult {
  /** 成功加载的 skills（已按 skillFilePath 排序） */
  skills: Skill[];
  /** 加载失败的项目（frontmatter 错误 / 元数据失败 / IO 失败） */
  errors: SkillLoadError[];
}

/** loadSkillsFromDirectory 选项 */
export interface LoadOptions {
  /** IO 并发上限，默认 16 */
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 把 `tasks` 按 `concurrency` 上限并发执行。
 *
 * 行为：维护一个 `running` 计数，新任务只在 `running < concurrency` 时启动；
 * 全部完成后 `Promise.all` 收集结果。这样既保证上限，又避免对全部任务预
 * 先 wrap（与 zed 的 `buffer_unordered(16)` 语义一致）。
 */
async function runWithConcurrency<T, R>(
  tasks: readonly T[],
  concurrency: number,
  fn: (task: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: tasks.length });
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      // eslint-disable-next-line no-await-in-loop
      results[idx] = await fn(tasks[idx]!);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// 目录扫描
// ---------------------------------------------------------------------------

/**
 * 找目录下所有 `<name>/SKILL.md`。
 *
 * - 目录不存在或不可读 → 返回空数组（不抛错）
 * - 仅一层：`<skills_root>/<name>/SKILL.md`，不递归
 * - 子目录必须存在 `SKILL.md` 才算合法 skill 目录
 *
 * 与 zed `find_skill_files` 对齐：非目录、缺 SKILL.md、metadata 不可达
 * 的条目静默跳过。
 */
async function findSkillFiles(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const candidates = entries.map((name) => join(directory, name));
  const checks = await Promise.all(
    candidates.map(async (entryPath) => {
      try {
        const s = await stat(entryPath);
        if (!s.isDirectory()) return null;
        const skillFile = join(entryPath, SKILL_FILE_NAME);
        const skillStat = await stat(skillFile);
        return skillStat.isFile() ? skillFile : null;
      } catch {
        return null;
      }
    }),
  );

  return checks.filter((p): p is string => p !== null);
}

// ---------------------------------------------------------------------------
// 单文件加载
// ---------------------------------------------------------------------------

/**
 * 读单个 SKILL.md 并解析 frontmatter。
 *
 * 与 zed `load_skill_frontmatter` 对齐：
 *   1. 短路过大的文件（> MAX_SKILL_FILE_SIZE）— 在读内容前做
 *   2. 读全文
 *   3. parseSkillFrontmatter 抛错时包成 SkillLoadError
 */
async function loadSkillFrontmatter(
  skillFilePath: string,
  source: SkillSource,
): Promise<{ skill: Skill } | { error: SkillLoadError }> {
  // 1. 大小短路（不读内容）
  try {
    const s = await stat(skillFilePath);
    if (s.size > MAX_SKILL_FILE_SIZE) {
      return {
        error: {
          skillFilePath,
          message: `SKILL.md 超过 ${String(MAX_SKILL_FILE_SIZE / 1024)}KB 限制`,
        },
      };
    }
  } catch (err) {
    return {
      error: {
        skillFilePath,
        message: `读取 SKILL.md 元数据失败：${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // 2. 读全文
  let content: string;
  try {
    content = await readFile(skillFilePath, "utf-8");
  } catch (err) {
    return {
      error: {
        skillFilePath,
        message: `读取文件失败：${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // 3. 解析
  let parsed: ParsedFrontmatter;
  try {
    parsed = parseSkillFrontmatter(content);
  } catch (err) {
    return {
      error: {
        skillFilePath,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // SKILL.md 的父目录 = skill 所在目录（`<root>/<name>/`）
  const lastSep = Math.max(
    skillFilePath.lastIndexOf("/"),
    skillFilePath.lastIndexOf("\\"),
  );
  const directoryPath = lastSep > 0 ? skillFilePath.slice(0, lastSep) : skillFilePath;

  return {
    skill: {
      name: parsed.name,
      description: parsed.description,
      directoryPath,
      skillFilePath,
      source,
      loadWarnings: parsed.loadWarnings,
      disableModelInvocation: parsed.disableModelInvocation,
    },
  };
}

// ---------------------------------------------------------------------------
// 单目录加载
// ---------------------------------------------------------------------------

/**
 * 从给定根目录加载所有 skill。
 *
 * - 目录不存在 → 返回 `{ skills: [], errors: [] }`
 * - 大小超限 / frontmatter 错误 → 收集进 `errors`，但其他 skill 继续加载
 * - 结果按 `skillFilePath` 排序（与 zed 一致，便于同名去重确定性）
 */
export async function loadSkillsFromDirectory(
  directory: string,
  source: SkillSource,
  opts: LoadOptions = {},
): Promise<SkillLoadResult> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  // 目录不存在 → 直接返回
  try {
    const s = await stat(directory);
    if (!s.isDirectory()) {
      return { skills: [], errors: [] };
    }
  } catch {
    return { skills: [], errors: [] };
  }

  const skillFiles = await findSkillFiles(directory);
  if (skillFiles.length === 0) {
    return { skills: [], errors: [] };
  }

  const results = await runWithConcurrency(skillFiles, concurrency, (file) =>
    loadSkillFrontmatter(file, source),
  );

  const skills: Skill[] = [];
  const errors: SkillLoadError[] = [];
  for (const r of results) {
    if ("skill" in r) {
      skills.push(r.skill);
    } else {
      errors.push(r.error);
    }
  }

  // 按 skillFilePath 排序（与 zed 一致：fs.read_dir 顺序不可靠）
  const sortedSkills = skills.toSorted((a, b) =>
    a.skillFilePath.localeCompare(b.skillFilePath),
  );
  const sortedErrors = errors.toSorted((a, b) =>
    a.skillFilePath.localeCompare(b.skillFilePath),
  );

  return { skills: sortedSkills, errors: sortedErrors };
}

// ---------------------------------------------------------------------------
// 全量加载 + 合并
// ---------------------------------------------------------------------------

/**
 * 同时加载全局 + 项目本地 skill，合并去重。
 *
 * 合并策略：
 *   - 并行 loadSkillsFromDirectory(globalDir, "global") + projectDir
 *   - 同名 skill：项目本地覆盖全局（与 zed apply_skill_overrides 一致；
 *     也与现有 `getAllSkills` 行为一致）
 *   - errors 不去重，两边都收集
 *   - 最终 skills 按 name 排序（让 disable_model_invocation / 预算裁剪的
 *     顺序可预测）
 */
export async function loadAllSkills(cwd: string): Promise<SkillLoadResult> {
  const globalDir = getGlobalSkillsDir();
  const projectDir = getProjectSkillDir(cwd);

  const [globalResult, projectResult] = await Promise.all([
    loadSkillsFromDirectory(globalDir, "global"),
    loadSkillsFromDirectory(projectDir, "project-local"),
  ]);

  // 合并：项目本地同名覆盖全局
  const byName = new Map<string, Skill>();
  for (const s of globalResult.skills) {
    byName.set(s.name, s);
  }
  for (const s of projectResult.skills) {
    byName.set(s.name, s);
  }

  const skills = Array.from(byName.values()).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  const errors = [...globalResult.errors, ...projectResult.errors];

  return { skills, errors };
}

// ---------------------------------------------------------------------------
// 按需读 body
// ---------------------------------------------------------------------------

/**
 * 读 SKILL.md 的 body 部分（frontmatter 之后的内容）。
 *
 * 加载阶段不读 body，按需调用。Phase 3 的 `skill` 工具会用。
 */
export async function readSkillBody(skillFilePath: string): Promise<string> {
  const content = await readFile(skillFilePath, "utf-8");
  const parsed = parseSkillFrontmatter(content);
  return parsed.body;
}
