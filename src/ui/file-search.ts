// ---------------------------------------------------------------------------
// file-search — 与组件无关的文件搜索纯函数
//
// 统一给调用点使用：
//   - FileSelector（输入框中输入 @ 时弹出的轻量联想列表）
//   - ChatSession 内部 getFilteredFiles（键盘 Tab 补全前的候选计算）
//
// 行为契约：
//   - 大小写不敏感
//   - query 以空白拆分为多个 token，所有 token 都得在路径里出现
//   - 排序：完全相等(0) > 前缀(5) > 子串位置(idx+10)
//   - 空 query → 返回原 files（按原顺序，固定分数 1000）
// ---------------------------------------------------------------------------

/**
 * 单个匹配结果：路径 + 分数。
 * 分数越小越靠前；用于排序而非 UI 展示。
 */
export interface ScoredFile {
  path: string;
  /** 越小越靠前 */
  score: number;
}

/** 计算单文件匹配分数。未命中返回 null。 */
export function scoreFile(query: string, file: string): number | null {
  if (!query) return 1000;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1000;
  const head = tokens[0]!;
  const f = file.toLowerCase();
  if (f === head) return 0;
  if (f.startsWith(head)) return 5;
  const idx = f.indexOf(head);
  if (idx >= 0) return idx + 10;
  return null;
}

/** 把 query 切成非空 token，要求全部命中（用于"foo bar"匹配 foo 和 bar） */
export function allSubstringsMatch(query: string, file: string): boolean {
  const q = query.toLowerCase();
  const f = file.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => f.includes(t));
}

/** 过滤 + 排序：返回全部命中的文件，按 score 升序 */
export function filterAndRank(query: string, files: string[]): ScoredFile[] {
  const result: ScoredFile[] = [];
  for (const f of files) {
    if (!allSubstringsMatch(query, f)) continue;
    const s = scoreFile(query, f);
    if (s === null) continue;
    result.push({ path: f, score: s });
  }
  result.sort((a, b) => a.score - b.score);
  return result;
}

// ---------------------------------------------------------------------------
// 输入框 @ 语义适配层
// ---------------------------------------------------------------------------

/** 输入框里最多展示的候选条数（轻量联想列表） */
export const MAX_INLINE_FILE_MATCHES = 10;

/**
 * 在输入框中输入 `@xxx` 时，从 files 列表里挑出候选。
 *
 * 返回 `null` 表示当前输入文本不构成“@ 触发态”，调用方应隐藏候选列表。
 * 返回 `string[]` 时已按 score 升序，包含所有命中文件（不截断）。
 * 调用方（FileSelector / ChatSession）根据需要分页展示，最多同时
 * 展示 `MAX_INLINE_FILE_MATCHES` 条；选中到边界时由 UI 层翻页。
 *
 * 触发规则与现有 FileSelector / ChatSession.getFilteredFiles 完全一致：
 *   - `@` 必须在开头或前面有空白
 *   - `@` 后面到行尾不能含第二个 `@`
 *   - 空 query（@" / "@   "）→ 返回所有候选文件，让 UI 一打开就展示列表
 *   - 精确匹配（path === query）→ 返回空数组（视为已补全完成）
 */

/**
 * 提取输入中 @ 触发段的元信息，用于判断"@ 后是否还有字符"等状态。
 *
 * 返回 `null` 表示当前输入不处于 @ 触发态；
 * 返回 `{ atIndex, query }`：
 *   - atIndex：最近一个 @ 在 input 中的下标
 *   - query：@ 后面到行尾的原始字符串（未 trim）
 */
export interface AtTrigger {
  /** 最近一个 @ 在 input 中的下标 */
  atIndex: number;
  /** @ 后面到行尾的原始字符串（未 trim，可能包含空白） */
  query: string;
}

export function getAtTrigger(input: string): AtTrigger | null {
  const match = input.match(/(?:^|\s)@([^@]*)$/);
  if (!match) return null;
  // match.index 是整个 match 起点；@ 的位置 = match.index + （前缀空白的长度）
  // match[0] 前缀部分由 "^|\s" 占一个字符，再加上 @ 自己，所以 @ 偏移 = match.index + 0 + 1
  // 但 match.index 已经定位到非空白字符起点（含空白或开头），@ 就在该位置。
  // 这里直接用 lastIndexOf 重新定位，确保与现有 filterFilesByInput 语义一致。
  const atIndex = input.lastIndexOf("@");
  const query = match[1] ?? "";
  return { atIndex, query };
}

/**
 * @ 触发态下的 skill 过滤逻辑纯函数。
 *
 * 与原 getFilteredSkills 的区别：后者只匹配 `/xxx` 模式，
 * 本函数用于用户在 @ 类型面板选了 Skills 之后，输入框内容是 `@xxx` 的场景。
 *
 * 行为：
 *   - 不处于 @ 触发态 → 返回 []
 *   - 触发态 + 纯数字 query "1"/"2" → 视为刚选了类型，关键词清空，返回前 3 个
 *   - 触发态 + 空 query → 返回前 3 个
 *   - 触发态 + 精确匹配 → 返回 []（已补全）
 *   - 触发态 + 子串匹配 → 返回前 3 个
 */
export interface AtSkillCandidate {
  name: string;
  description: string;
}

export function filterSkillsByAtInput(
  input: string,
  skills: ReadonlyArray<AtSkillCandidate>,
): AtSkillCandidate[] {
  const trigger = getAtTrigger(input);
  if (!trigger) return [];
  const q = trigger.query.toLowerCase().trim();
  // 去掉用于切换类型的纯数字标记 "1"/"2"
  const cleanedQ = /^[12]$/.test(q) ? "" : q;
  if (!cleanedQ) return skills.slice(0, 3);
  const matched = skills
    .filter((s) => s.name.toLowerCase().includes(cleanedQ))
    .slice(0, 3);
  if (matched.some((s) => s.name.toLowerCase() === cleanedQ)) return [];
  return matched;
}

export function filterFilesByInput(input: string, files: string[]): string[] | null {
  const match = input.match(/(?:^|\s)@([^@]*)$/);
  if (!match) return null;
  const rawQuery = match[1] ?? "";
  const query = rawQuery.toLowerCase().trim();

  // 空 query 的两种情况：
  // 1. `@` 紧贴行首（@" / "@   "）→ 返回所有候选，让 FileSelector 一打开
  //    就展示可选列表；截断展示由 UI 层（MAX_INLINE_FILE_MATCHES）负责。
  // 2. `@` 在中间（"hello @"）→ 意图不明确，返回空数组不主动弹候选。
  if (!query) {
    return input.startsWith("@") ? [...files] : [];
  }

  const ranked = filterAndRank(query, files);
  if (ranked.length === 0) return [];

  // 精确匹配：已补全完成，隐藏列表
  if (ranked[0]?.path.toLowerCase() === query) return [];

  return ranked.map((r) => r.path);
}

// ---------------------------------------------------------------------------
// @ 类型选择面板常量（原 AtTypeMenu.tsx）
// ---------------------------------------------------------------------------

/** @ 触发的可选类型 */
export interface AtTypeOption {
  index: number;
  label: string;
  enabled: boolean;
}

export const AT_TYPE_OPTIONS: readonly AtTypeOption[] = [
  { index: 1, label: "Files & Directories", enabled: true },
  { index: 2, label: "Skills", enabled: true },
] as const;

export function getEnabledAtTypes(): AtTypeOption[] {
  return AT_TYPE_OPTIONS.filter((o) => o.enabled);
}

export function findAtTypeByIndex(index: number): AtTypeOption | null {
  return AT_TYPE_OPTIONS.find((o) => o.index === index) ?? null;
}

export function shouldRenderAtTypeMenu(open: boolean): boolean {
  if (!open) return false;
  return getEnabledAtTypes().length > 0;
}

// ---------------------------------------------------------------------------
// / 命令过滤（原 CommandSelector.tsx）
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 6;

/**
 * 过滤 / 命令。query 为空且行末为 / 时展示前 MAX_VISIBLE 个作为提示。
 */
export function filterCommandsBySlashInput(
  input: string,
  commands: ReadonlyArray<{ name: string; desc: string }>,
): Array<{ name: string; desc: string }> {
  const m = input.match(/(?:^|\s)\/([^/]*)$/);
  if (!m) return [];
  if (m[1] === "" && m[0].length > 1) return [];
  const firstToken = (m[1] ?? "").split(/\s+/)[0] ?? "";
  const query = firstToken ? `/${firstToken.toLowerCase()}` : "";
  if (!query) {
    return input.trimEnd().endsWith("/") ? commands.slice(0, MAX_VISIBLE) : [];
  }
  return commands
    .filter((c) => c.name.toLowerCase().startsWith(query))
    .slice(0, MAX_VISIBLE);
}
