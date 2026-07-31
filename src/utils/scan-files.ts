// ---------------------------------------------------------------------------
// 扫描项目源码文件（排除 node_modules 等非源码目录）
// 启动时调用一次，结果缓存为扁平路径数组传给 UI
//
// 提供两种策略：
//   - scanProjectFiles(baseDir, dir?, maxDepth?)  递归扫描（可控制深度）
//   - scanProjectFilesFlat(baseDir)                以 baseDir 为根全量递归
//
// 推荐使用 scanProjectFilesFlat：用户启动 CLI 的目录作为 baseDir，
// 只显示该目录下的文件，避免父目录文件淹没提示列表。
// ---------------------------------------------------------------------------

import { readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

/** 需要跳过的目录名（任何层级） */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".dskcode",
  ".claude",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".nx",
  "coverage",
  ".cache",
  ".nyc_output",
  ".vscode",
  ".idea",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
  "vendor",
  "bower_components",
  "jspm_packages",
]);

/**
 * 递归扫描 dir 下的所有文件，返回相对于 baseDir 的路径数组。
 *
 * @param baseDir  基准目录，返回的路径以此目录为根
 * @param dir      当前扫描目录（内部递归用），不传则从 baseDir 开始
 * @param maxDepth 最大递归深度，
 *                   1  → 只扫当前目录（等同于 flat 模式）
 *                   2  → 扫当前 + 一层子目录
 *                   不传或 Infinity → 全量递归（历史行为）
 *
 * 优化手段：
 *  - readdir withFileTypes 省掉 stat 调用（减少一半 syscall）
 *  - 同层目录的 readdir 用 Promise.all 并行
 *  - 跳过以 . 开头的隐藏目录和已知非源码目录
 *
 * 性能预期（SSD）：
 *    1,000 文件 → ~15ms
 *   10,000 文件 → ~150ms
 *   50,000 文件 → ~800ms
 */
export async function scanProjectFiles(
  baseDir: string,
  dir?: string,
  maxDepth: number = Infinity,
  visited?: Set<string>,
): Promise<string[]> {
  const currentDir = dir ?? baseDir;

  // 防 symlink/junction 循环：用 realpath 去重已访问目录。
  // Windows 用户的家目录通常含大量 junction（Application Data、My Documents 等），
  // 不做循环检测会导致栈溢出。
  const seen = visited ?? new Set<string>();
  try {
    const real = await realpath(currentDir);
    if (seen.has(real)) return [];
    seen.add(real);
  } catch {
    // realpath 失败（权限、符号悬挂等）就按字面路径处理，避免误判
  }

  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  const dirs: string[] = [];

  for (const entry of entries) {
    const name = entry.name;
    if (IGNORE_DIRS.has(name) || name.startsWith(".")) continue;

    if (entry.isDirectory()) {
      dirs.push(name);
    } else if (entry.isFile()) {
      files.push(relative(baseDir, join(currentDir, name)));
    }
  }

  // 同层子目录并行扫描（达到最大深度时不再下钻）
  const remainingDepth = dir === undefined ? maxDepth : Math.max(0, maxDepth - 1);
  const nested =
    remainingDepth <= 1
      ? []
      : await Promise.all(
          dirs.map((d) =>
            scanProjectFiles(baseDir, join(currentDir, d), remainingDepth, seen),
          ),
        );

  for (const n of nested) {
    files.push(...n);
  }

  return files;
}

/**
 * scanProjectFilesFlat 使用的默认最大深度，作为深递归/循环扫描的兜底上限。
 * 历史行为是不限深度，但在家目录启动时若存在 junction 循环就会栈溢出，
 * 故默认限制为 8 层；普通前端/Node 项目基本都在 8 层以内，不会触发。
 */
const SCAN_FLAT_DEFAULT_MAX_DEPTH = 8;

/**
 * 以 baseDir 为根递归扫描所有文件，不上探父目录。
 *
 * 适用场景：用户在某个子目录（比如 ts-version/）下启动 CLI，
 * baseDir 设为该子目录，@ 提示中就只显示该目录及其子目录下的文件，
 * 不被项目根目录或其他父目录的散文件淹没。
 *
 * 过滤规则：
 *   - 跳过 IGNORE_DIRS 中的依赖/构建目录（node_modules / .git / dist 等）
 *   - 跳过以 . 开头的隐藏文件/目录
 *   - 其余所有文件均包含（不限扩展名，图片/二进制/文档等均可选）
 */
export async function scanProjectFilesFlat(baseDir: string): Promise<string[]> {
  return scanProjectFiles(baseDir, undefined, SCAN_FLAT_DEFAULT_MAX_DEPTH);
}
