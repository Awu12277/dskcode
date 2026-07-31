// ---------------------------------------------------------------------------
// 扩展名 → 语言名映射
//
// 预览当前不执行语法高亮，但保留该映射模块及其导出，方便后续恢复高亮
// 时不需要调整文件搜索相关调用方。
// ---------------------------------------------------------------------------

/** 文件后缀 → 语言名 */
type LanguageName = string;

const EXT_LANG_MAP: Record<string, LanguageName> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".cts": "typescript",
  ".mts": "typescript",
  ".js": "javascript",
  ".jsx": "jsx",
  ".cjs": "javascript",
  ".mjs": "javascript",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".svg": "xml",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sql": "sql",
  ".graphql": "graphql",
  ".dockerfile": "dockerfile",
  ".lua": "lua",
  ".r": "r",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".scala": "scala",
  ".pl": "perl",
};

/** 纯文件名 → 语言名（Dockerfile、Makefile 等无扩展名场景） */
const FILENAME_LANG_MAP: Record<string, LanguageName> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  Rakefile: "ruby",
  Gemfile: "ruby",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
};

/**
 * 根据文件路径推导 shiki 语言名。
 * 找不到时返回 undefined，调用方应退化为纯文本（lang="text"）。
 */
export function langFromPath(filePath: string): LanguageName | undefined {
  // 先按文件名查（如 Dockerfile）
  const base = filePath.split(/[\\/]/).pop() ?? "";
  if (FILENAME_LANG_MAP[base]) return FILENAME_LANG_MAP[base];

  // 取最后一个 .ext
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx < 0) return undefined;
  const ext = base.slice(dotIdx).toLowerCase();
  return EXT_LANG_MAP[ext];
}

/** 所有已知扩展名（小写，含点） */
export const KNOWN_EXTS: ReadonlySet<string> = new Set(Object.keys(EXT_LANG_MAP));
