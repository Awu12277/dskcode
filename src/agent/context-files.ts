// ---------------------------------------------------------------------------
// 项目指令文件发现 — 自动加载 AGENTS.md / CLAUDE.md
//
// 借鉴 pi-coding-agent 的 trust-gated resource loading：
// 1. 从 cwd 向上逐级查找 {AGENTS.md, CLAUDE.md}
// 2. 父目录命中后子目录命中会被"屏蔽"（用 seenPaths 维护祖先集合）
// 3. 每个文件渲染为带源标签的 XML 块，供 system prompt 注入
// 4. 暴露 expandPlaceholders() 给上层用，遵守 shell 风格 ${VAR:-default}
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** 上下文文件名候选（按优先级排序：先命中先生效） */
const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** 单条项目指令文件 */
export interface ContextFile {
  /** 绝对路径 */
  path: string;
  /** 相对 cwd 的展示路径（POSIX 风格） */
  relativePath: string;
  /** 文件名（AGENTS.md / CLAUDE.md） */
  filename: string;
  /** 文件内容（已 strip 收尾空白） */
  content: string;
}

/** 加载选项 */
export interface LoadContextFilesOptions {
  /** 工作目录 */
  cwd: string;
  /** 自定义文件名候选；未提供则使用默认 AGENTS.md / CLAUDE.md */
  filenames?: ReadonlyArray<string>;
  /** 允许的最大文件大小（字节），超过则跳过；默认 1 MiB */
  maxBytes?: number;
  /** 停止向上的目录（默认到 home 目录） */
  stopAt?: string;
}

/** 默认 1 MiB 阈值 */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * 向上逐级查找项目指令文件。
 *
 * 规则：
 * - 从 stopAt 一路走到 cwd：先扫全局约定（home/AGENTS.md），后扫项目内指令
 * - 同一目录先匹配到的文件优先（按 filenames 顺序）
 * - 先扫到的同名文件会"屏蔽"更深一级的同名文件
 *   （避免 `repo/AGENTS.md` 被 `repo/apps/AGENTS.md` 覆盖丢失全局约定）
 *
 * @param options - 加载选项
 * @returns 找到的上下文文件列表（从浅到深）
 */
export function loadContextFiles(options: LoadContextFilesOptions): ContextFile[] {
  const filenames = options.filenames ?? CONTEXT_FILE_NAMES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const stopAt = options.stopAt ? resolve(options.stopAt) : homedir();
  const cwd = resolve(options.cwd);

  // 浅 → 深：先扫全局约定（home/AGENTS.md），后扫项目内指令。
  // 规则：先扫到的同名文件会"屏蔽"更深一级的同名文件，
  // 避免 `repo/AGENTS.md` 被 `repo/apps/AGENTS.md` 覆盖。
  const queue: string[] = [];
  let cursor: string | undefined = cwd;
  while (cursor) {
    const parent = dirname(cursor);
    queue.unshift(cursor);
    if (cursor === stopAt) break;
    if (parent === cursor) break;
    cursor = parent;
  }

  const results: ContextFile[] = [];
  const seenByName = new Set<string>();

  for (const dir of queue) {
    for (const filename of filenames) {
      if (seenByName.has(filename)) continue;
      const filePath = join(dir, filename);
      if (!safeExists(filePath)) continue;
      const stat = safeStat(filePath);
      if (!stat || !stat.isFile() || stat.size > maxBytes) continue;

      const content = safeRead(filePath)?.trimEnd() ?? "";
      results.push({
        path: filePath,
        relativePath: toRelative(filePath, cwd),
        filename,
        content,
      });
      seenByName.add(filename);
    }
  }

  return results;
}

/**
 * 把加载到的指令文件渲染为 XML 块。
 *
 * 多个文件按发现顺序用 `<project_instructions>` 包裹，
 * 每个文件用 `<source path="...">` 标注来源。
 *
 * @param files - loadContextFiles() 的返回
 * @returns XML 字符串；files 为空时返回空串
 */
export function renderContextFiles(files: ReadonlyArray<ContextFile>): string {
  if (files.length === 0) return "";
  return [
    "<project_instructions>",
    ...files.map(
      (f) =>
        `<source path="${f.relativePath}" name="${f.filename}">\n${f.content}\n</source>`,
    ),
    "</project_instructions>",
  ].join("\n");
}

/**
 * 占位符变量来源（key → 默认值）。
 *
 * 默认提供 cwd、date、time；调用方可扩展（注入 build/branch 等）。
 */
export type PlaceholderValues = Record<string, string>;

/**
 * 展开 ${VAR} / ${VAR:-default} 形式的占位符。
 *
 * 行为：
 * - 未提供变量且无默认值 → 保留原样
 * - 有默认值但变量为空 → 使用默认值
 * - 转义 `$$` 输出字面量 `$`
 *
 * @param text - 待处理文本
 * @param values - 变量表
 * @returns 展开后的文本
 */
export function expandPlaceholders(text: string, values: PlaceholderValues): string {
  // 先处理 $$ 转义，避免后面被 $ 匹配
  return text
    .replace(/\$\$/g, "\u0000")
    .replace(/\$\{([A-Za-z_][\w]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
      const value = values[name];
      if (value !== undefined && value !== "") return value;
      return fallback ?? "";
    })
    .replace(/\$([A-Za-z_][\w]*)/g, (_, name) => {
      const value = values[name];
      if (value !== undefined && value !== "") return value;
      return "";
    })
    .replace(/\u0000/g, "$");
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function safeExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function toRelative(filePath: string, cwd: string): string {
  if (!isAbsolute(filePath) || !isAbsolute(cwd)) return filePath;
  const rel = relative(cwd, filePath);
  if (!rel || rel.startsWith("..")) return rel.split(sep).join("/");
  return "./" + rel.split(sep).join("/");
}
