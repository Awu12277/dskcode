// ---------------------------------------------------------------------------
// 工具权限规则引擎（Permission Engine）
//
// 设计动机：
// 硬编码黑名单覆盖"绝对不能放行"的灾难命令；
// 规则引擎覆盖"用户可配置"的细粒度策略（按工具名 + 参数 regex 决定 allow/deny/confirm）。
//
// 借鉴 Zed 的 `agent_settings::ToolPermissions`：
//   - 规则按"工具名 + 可选参数匹配"组织
//   - 决策三态：allow / deny / confirm
//   - 多条规则按顺序求值，**首条命中即返回**（先匹配先用）
//
// 注意：本引擎**不**检查硬编码黑名单——硬编码检查在更上层（bash 工具内部）执行。
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 工具函数（导出便于测试与外部复用）
// ---------------------------------------------------------------------------

/**
 * 把简单 glob 模式转为正则表达式。
 *
 * 支持的语法（最小集，满足 permissions.json 需求即可）：
 *   - `*`        → 匹配除 `/` 外的任意字符序列（与 shell glob 一致）
 *   - `**`       → 匹配含 `/` 的任意字符序列
 *   - `?`        → 匹配除 `/` 外的一个字符
 *   - `[abc]`    → 字符类
 *   - `[a-z]`    → 字符类范围
 *   - 其他字符   → 字面匹配（`/` 不转义）
 *
 * 例子：
 *   - glob = star.ts  →  regex starts with non-slash, ends with literal .ts
 *   - glob = star-star slash star.test.ts  →  regex matches any depth + .test.ts
 *   - glob = src slash star-star slash star.ts  →  must start with src/ then any path then .ts
 *
 * @param glob — glob 模式字符串
 * @returns 编译后的 RegExp
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      // ** 跨目录
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 2;
        // 吃掉紧跟的 /
        if (glob[i] === "/") i++;
      } else {
        // 单 * 不跨 /
        pattern += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      pattern += "[^/]";
      i++;
    } else if (c === "[") {
      // 字符类，原样透传到正则结尾的 ]
      const end = glob.indexOf("]", i);
      if (end < 0) {
        pattern += "\\[";
        i++;
      } else {
        pattern += glob.slice(i, end + 1);
        i = end + 1;
      }
    } else if (
      c === "." ||
      c === "(" ||
      c === ")" ||
      c === "+" ||
      c === "|" ||
      c === "^" ||
      c === "$" ||
      c === "{" ||
      c === "}" ||
      c === "\\"
    ) {
      // 正则元字符转义
      pattern += "\\" + c;
      i++;
    } else {
      pattern += c;
      i++;
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

/**
 * 从工具参数中提取 bash 命令字符串。

/** 权限决策三态 */
export type Decision = "allow" | "deny" | "confirm";

/**
 * 规则匹配条件。
 *
 * 多个字段之间是 AND 关系（全部满足才命中）。
 * 全为空表示匹配所有参数。
 */
export interface RuleMatch {
  /** 路径 glob（双星杠表示跨任意目录），仅对文件类工具有效 */
  pathGlob?: string;
  /** 命令正则（仅对 bash 工具生效） */
  commandRegex?: string;
  /**
   * 工具参数对象的字段值匹配（仅 1 层深度）。
   * 例如 { command: 前面带 git\s+commit 的正则 } 表示 args.command 以 git commit 开头。
   */
  argValueRegex?: Record<string, string>;
}

/** 单条权限规则 */
export interface PermissionRule {
  /** 工具名（如 "bash"、"edit_file"） */
  tool: string;
  /** 决策 */
  action: Decision;
  /** 匹配条件（可选）；不传表示"该工具全部请求都按 action 处理" */
  match?: RuleMatch;
  /** 给人看的拒绝/确认理由（可选，UI 弹窗会展示） */
  reason?: string;
}

/** 规则文件 schema */
export interface PermissionsFile {
  /** 规则列表（按顺序求值，首条命中先用） */
  rules: PermissionRule[];
}

/**
 * 工具参数上下文（用于规则匹配）。
 *
 * 大多数工具的 args 是个对象；但 bash 工具的 args 是 `{ command: string, timeout?: number }`。
 * 文件类工具通常有 `path` 字段；非文件类工具无 path。
 */
export interface EvalContext {
  /** 工具参数对象（任意） */
  args: unknown;
  /** 若工具是文件类，可由调用方预先提取的"目标路径"（绝对或相对）；未提取时为 undefined */
  targetPath?: string;
}

/**
 * PermissionEngine — 纯函数式规则求值器。
 *
 * 用法：
 *   const engine = new PermissionEngine(rules);
 *   const decision = engine.evaluate("bash", { args: { command: "git commit -m hi" } });
 *   // → "allow" | "deny" | "confirm" | null
 *
 * `evaluate` 返回 null 表示"无规则命中"，调用方应走默认策略（confirm）。
 */
export class PermissionEngine {
  readonly #rules: ReadonlyArray<PermissionRule>;

  constructor(rules: ReadonlyArray<PermissionRule>) {
    this.#rules = rules;
  }

  /**
   * 取出当前所有规则（只读快照）。给 UI 展示"当前生效的规则"用。
   *
   * @pure 不修改内部状态
   */
  get rules(): ReadonlyArray<PermissionRule> {
    return [...this.#rules];
  }

  /**
   * 求值：返回首条命中规则的 action；无命中返回 null。
   *
   * 行为：
   * - 规则按顺序求值，首条命中即停（其余规则不评估）
   * - 单条规则内 `match` 为空 → 直接命中（按 action 返回）
   * - 单条规则有 `match` → 三个子条件 AND
   *
   * @param toolName — 工具名
   * @param ctx — 评估上下文（args + 可选 targetPath）
   * @returns 决策（"allow" | "deny" | "confirm"），无规则命中返回 null
   *
   * @pure 不修改任何外部状态
   */
  evaluate(toolName: string, ctx: EvalContext): Decision | null {
    for (const rule of this.#rules) {
      if (!matchToolNameRule(rule.tool, toolName)) continue;
      if (!this.#matches(rule.match, ctx)) continue;
      return rule.action;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 判断 match 条件是否全部满足。
   *
   * @pure 仅读入参
   */
  #matches(match: RuleMatch | undefined, ctx: EvalContext): boolean {
    if (!match) return true;

    // path glob
    if (match.pathGlob) {
      if (!ctx.targetPath) return false;
      if (!matchPathGlob(match.pathGlob, ctx.targetPath)) return false;
    }

    // command regex
    if (match.commandRegex) {
      const cmd = extractCommand(ctx.args);
      if (cmd === null) return false;
      let re: RegExp;
      try {
        re = new RegExp(match.commandRegex);
      } catch {
        // 正则非法 → 不命中（避免 throw 污染主循环）
        return false;
      }
      if (!re.test(cmd)) return false;
    }

    // arg value regex（按字段名取 args 的字符串值再匹配）
    if (match.argValueRegex) {
      const args = ctx.args;
      if (typeof args !== "object" || args === null) return false;
      const argsObj = args as Record<string, unknown>;
      for (const [field, pattern] of Object.entries(match.argValueRegex)) {
        const value = argsObj[field];
        if (typeof value !== "string") return false;
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch {
          return false;
        }
        if (!re.test(value)) return false;
      }
    }

    return true;
  }
}

// ---------------------------------------------------------------------------
// 工具函数（导出便于测试与外部复用）
// ---------------------------------------------------------------------------

export function extractCommand(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const obj = args as Record<string, unknown>;
  const cmd = obj["command"];
  if (typeof cmd !== "string") return null;
  return cmd;
}

/**
 * 判断 targetPath 是否匹配 pathGlob。
 *
 * @param glob — glob 模式（双星杠跨目录、单星杠不跨）
 * @param targetPath — 文件路径（绝对或相对均可，但调用方需保证不含符号链接未解析段）
 * @returns true 表示命中
 */
export function matchPathGlob(glob: string, targetPath: string): boolean {
  if (!glob || !targetPath) return false;
  try {
    const re = globToRegExp(glob);
    return re.test(targetPath);
  } catch {
    return false;
  }
}

/**
 * 规则 `tool` 字段与实际工具名的匹配。
 *
 * 三种语义（v0.8+ 为 MCP 工具新增后两种）：
 * 1. 全量相等：`mcp_github` 严格 `=== mcp_github`
 * 2. 下划线结尾的前缀：`mcp_github_` 匹配 `mcp_github_list_repos`、
 *    `mcp_github_get_issue` 等所有以该前缀开头的 tool。
 * 3. 含正则元字符（`. * + ? ( ) [ ] { } | \ ^ $`）：当作正则匹配，
 *    如 `mcp_.*`。
 *
 * 背景：`mcp_<server>_<tool>` 是三段式拼接，精确匹配需要枚举每个 tool；
 * 用前缀或正则可以一条规则覆盖一类工具。
 *
 * @pure
 */
export function matchToolNameRule(ruleTool: string, actualTool: string): boolean {
  if (ruleTool === actualTool) return true;
  // 下划线结尾的字面前缀（如 `mcp_github_`）→ 前缀匹配
  if (ruleTool.endsWith("_")) {
    return actualTool.startsWith(ruleTool);
  }
  // 含正则元字符 → 正则匹配
  if (/[.*+?()[\]{}|\\^$]/.test(ruleTool)) {
    try {
      return new RegExp(ruleTool).test(actualTool);
    } catch {
      return false;
    }
  }
  return false;
}
