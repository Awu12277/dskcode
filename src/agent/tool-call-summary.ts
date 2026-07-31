// ---------------------------------------------------------------------------
// 工具调用摘要模板 — 阶段 3 共享渲染
//
// 设计动机：阶段 1+2 让 ToolResult.parsedArgs / schemaIssues 可观测。
// 阶段 3 把这些结构化字段"翻译"成人类可读字符串，供两个地方消费：
//   1. compactor fallbackSummary：LLM 摘要失败时的兜底文本
//   2. ui/ToolCallBlock：终端折叠显示
//
// 两个地方的"摘要形态"略有不同：
//   - compactor：嵌入 fallbackSummary 的多行文本
//   - UI：带高亮、截断的终端框
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

/** 敏感字段名（不区分大小写匹配）— 渲染时自动替换为 `****` */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "password",
  "token",
  "apikey",
  "api_key",
  "secret",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "private_key",
  "privatekey",
]);

/**
 * 工具调用一行摘要（人话版本）。
 *
 * 形如：
 * - `read_file(path=src/main.ts)`
 * - `delete_range(path=foo.ts, count=5)`
 * - `bash(command=git status)`
 * - `multi_edit(path=foo.ts, edits=3)`
 * - `grep(pattern=foo, path=src/)` （path 太长时截断到 40 字）
 *
 * @param toolName — 工具名
 * @param args — 已解析的参数对象（来自 parseToolCallArgs.ok=true 的 args 字段）
 * @returns 人类可读的一行字符串
 *
 * @pure 不修改入参
 */
export function templateToolCall(toolName: string, args: unknown): string {
  // 防御性：args 不是 object 时降级
  if (!isPlainObject(args)) {
    return `${toolName}()`;
  }

  switch (toolName) {
    case "read_file":
      return `${toolName}(path=${shortStr(args.path)})`;

    case "write_file":
      return `${toolName}(path=${shortStr(args.path)})`;

    case "edit_file":
      return `${toolName}(path=${shortStr(args.path)}, old_text=${shortStr(args.old_text, 30)})`;

    case "multi_edit": {
      const edits = Array.isArray(args.edits) ? args.edits.length : 0;
      return `${toolName}(path=${shortStr(args.path)}, edits=${edits})`;
    }

    case "delete_range": {
      // delete_range 没有显式 count，从 old_text/endText 推断不可靠，简化为 "delete_range(path)"
      return `${toolName}(path=${shortStr(args.path)})`;
    }

    case "bash":
      return `${toolName}(command=${shortStr(args.command, 60)})`;

    case "ls":
      return `${toolName}(path=${shortStr(args.path ?? ".")})`;

    case "glob":
      return `${toolName}(pattern=${shortStr(args.pattern)})`;

    case "grep":
      return `${toolName}(pattern=${shortStr(args.pattern)}, path=${shortStr(args.path ?? ".")})`;

    case "fetch":
      return `${toolName}(url=${shortStr(args.url, 60)})`;

    default:
      // 未知工具：列出所有 key（截断到 60 字）
      const keys = Object.keys(args);
      if (keys.length === 0) return `${toolName}()`;
      const preview = keys
        .slice(0, 4)
        .map((k) => `${k}=…`)
        .join(", ");
      const more = keys.length > 4 ? `, +${keys.length - 4}` : "";
      return `${toolName}(${preview}${more})`;
  }
}

/**
 * 递归把敏感字段值替换为 `****`。
 *
 * 用于：
 * - compactor fallbackSummary（避免摘要进 LLM context 时泄露）
 * - UI 折叠（避免屏幕回看时泄露）
 *
 * @param args — 待清理的 JSON 对象
 * @returns 新对象（不修改入参）
 *
 * @pure 不修改入参
 */
export function maskSensitive<T>(args: T): T {
  // maskRecursive 返回 unknown；通过 unknown 收窄为 T 是类型安全的
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return maskRecursive(args, new WeakSet()) as T;
}

/** 内部递归实现 */
function maskRecursive(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  const obj = value;
  if (seen.has(obj)) return "****"; // 循环引用
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.map((v) => maskRecursive(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = "****";
    } else {
      out[k] = maskRecursive(v, seen);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// UI 用的渲染函数（独立于 templateToolCall，更注重可读性 + 截断）
// ---------------------------------------------------------------------------

/** formatArgsForDisplay 选项 */
export interface DisplayOptions {
  /** 单个 value 的最大长度（默认 80） */
  valueMaxLen?: number;
  /** 是否脱敏敏感字段（默认 true） */
  maskSensitive?: boolean;
  /** 单个 args 对象最多展示几个 key（默认 6） */
  maxKeys?: number;
}

/**
 * 把 args 对象渲染成多行 `key: value` 字符串（UI 用）。
 *
 * 形如：
 * ```
 * path: src/main.ts
 * startLine: 10
 * endLine: 20
 * ```
 *
 * 长 value 截断；敏感字段替换为 `****`；超出 maxKeys 的 key 末尾加 `+N more`。
 *
 * @param args — 待渲染的对象
 * @param opts — 渲染选项
 * @returns 多行字符串（不含尾部换行）
 *
 * @pure 不修改入参
 */
export function formatArgsForDisplay(args: unknown, opts: DisplayOptions = {}): string {
  const valueMaxLen = opts.valueMaxLen ?? 80;
  const doMask = opts.maskSensitive !== false;
  const maxKeys = opts.maxKeys ?? 6;

  if (!isPlainObject(args)) {
    const s = formatValue(args, valueMaxLen);
    return s;
  }

  const masked = doMask ? maskSensitive(args) : args;
  const entries = Object.entries(masked);
  const shown = entries.slice(0, maxKeys);
  const lines = shown.map(([k, v]) => `${k}: ${formatValue(v, valueMaxLen)}`);
  if (entries.length > maxKeys) {
    lines.push(`+${entries.length - maxKeys} more`);
  }
  return lines.join("\n");
}

/**
 * 把单个值渲染成短字符串。
 *
 * - string：截断到 maxLen，加 `…`
 * - number / boolean：原样
 * - null / undefined：`null` / `undefined`
 * - array：`[1,2,3]` 或 `[…5 items…]`
 * - object：`{a: 1, b: 2}` 或 `{…3 keys…}`
 *
 * @param v — 待渲染的值
 * @param maxLen — 字符串最大长度
 * @returns 短字符串
 *
 * @pure
 */
export function formatValue(v: unknown, maxLen = 80): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") {
    return v.length > maxLen ? v.slice(0, maxLen - 1) + "…" : v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length <= 3) return JSON.stringify(v);
    return `[…${v.length} items…]`;
  }
  if (typeof v === "object") {
    // 上面已经窄化到 object，且 null/array 已处理；此处 v 必为普通对象
    const obj = v;
    const keys = Object.keys(obj);
    if (keys.length <= 3) return JSON.stringify(obj);
    return `{…${keys.length} keys…}`;
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 渲染一个 string 值，长度超过 maxLen 截断 */
function shortStr(v: unknown, maxLen = 40): string {
  if (v === undefined || v === null) return String(v);
  if (typeof v !== "string") return formatValue(v, maxLen);
  if (v.length === 0) return "(空)";
  if (v.length > maxLen) return v.slice(0, maxLen - 1) + "…";
  return v;
}

/** 判定值是否为普通对象 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
