// ---------------------------------------------------------------------------
// 权限配置文件加载器
//
// 设计动机：
// 用户把规则写到 settings.json 的 permissions 字段（全局+项目级合并），
// 启动 Session 时加载合并成 PermissionEngine。
//
// 设计：
// - 支持两种来源：独立的 permissions.json 文件（旧格式）、settings.json 的权限字段（新格式）
// - 文件缺失 / 解析失败：返回空引擎（不报错）
// - 配置热加载：暂不支持；改完配置需要重启 session
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  PermissionEngine,
  type PermissionsFile,
  type PermissionRule,
} from "./permissions.js";
import type { PermissionsConfig, ToolPermissionRules } from "../config/types.js";

/** 全局配置文件路径：`~/.dskcode/permissions.json` */
export function defaultGlobalPermissionsPath(): string {
  const home = process.env.DSKCODE_HOME ?? homedir();
  return join(home, ".dskcode", "permissions.json");
}

/** 项目级配置文件路径：`<cwd>/.dskcode/permissions.json` */
export function defaultProjectPermissionsPath(cwd: string): string {
  return join(cwd, ".dskcode", "permissions.json");
}

/** 加载结果 */
export interface LoadResult {
  engine: PermissionEngine;
  /** 加载过程中遇到的非致命警告（如：文件存在但 JSON 非法） */
  warnings: string[];
  /** 实际加载到的文件路径（用于 UI 展示） */
  loadedFrom: string[];
}

/**
 * 从 settings.json 的 permissions 字段创建 PermissionEngine。
 *
 * 格式（Zed 风格，三组正则列表 + 默认策略）：
 * ```json
 * {
 *   "default": "confirm",
 *   "tools": {
 *     "bash": {
 *       "always_deny": ["^rm\\s+-rf"],
 *       "always_allow": ["^git\\s+status"],
 *       "always_confirm": ["^npm\\s+publish"]
 *     }
 *   }
 * }
 * ```
 *
 * @param config — settings.json 里的 permissions 字段（undefined 时返回空引擎）
 * @returns LoadResult
 */
export function permissionsFromConfig(config?: PermissionsConfig): LoadResult {
  if (!config?.tools) {
    return { engine: new PermissionEngine([]), warnings: [], loadedFrom: [] };
  }

  const rules: PermissionRule[] = [];
  const warnings: string[] = [];

  for (const [toolName, toolRules] of Object.entries(config.tools)) {
    if (!toolRules) continue;

    // always_deny
    if (toolRules.always_deny) {
      for (const pattern of toolRules.always_deny) {
        try {
          new RegExp(pattern);
        } catch {
          warnings.push(`${toolName}.always_deny: 正则 "${pattern}" 编译失败（已跳过）`);
          continue;
        }
        rules.push({ tool: toolName, action: "deny", match: { commandRegex: pattern } });
      }
    }

    // always_allow
    if (toolRules.always_allow) {
      for (const pattern of toolRules.always_allow) {
        try {
          new RegExp(pattern);
        } catch {
          warnings.push(`${toolName}.always_allow: 正则 "${pattern}" 编译失败（已跳过）`);
          continue;
        }
        rules.push({ tool: toolName, action: "allow", match: { commandRegex: pattern } });
      }
    }

    // always_confirm
    if (toolRules.always_confirm) {
      for (const pattern of toolRules.always_confirm) {
        try {
          new RegExp(pattern);
        } catch {
          warnings.push(
            `${toolName}.always_confirm: 正则 "${pattern}" 编译失败（已跳过）`,
          );
          continue;
        }
        rules.push({
          tool: toolName,
          action: "confirm",
          match: { commandRegex: pattern },
        });
      }
    }
  }

  return {
    engine: new PermissionEngine(rules),
    warnings,
    loadedFrom: [],
  };
}

/**
 * 从单个配置文件加载规则。
 *
 * 行为：
 * - 文件不存在 -> 返回空数组 + 不警告
 * - 文件存在但 JSON 非法 -> 返回空数组 + 加警告
 * - 文件存在但 rules 字段缺失或类型错 -> 返回空数组 + 加警告
 *
 * @pure 不修改任何外部状态
 */
export async function loadRulesFromFile(path: string): Promise<{
  rules: PermissionRule[];
  warning: string | null;
}> {
  if (!existsSync(path)) {
    return { rules: [], warning: null };
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rules: [], warning: `读取 ${path} 失败：${msg}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rules: [], warning: `解析 ${path} JSON 失败：${msg}` };
  }

  const validated = validatePermissionsFile(parsed, path);
  return { rules: validated.rules, warning: validated.warning };
}

/**
 * 校验单个解析后的对象是否符合 PermissionsFile schema。
 */
function validatePermissionsFile(
  obj: unknown,
  sourcePath: string,
): { rules: PermissionRule[]; warning: string | null } {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { rules: [], warning: `${sourcePath} 顶层不是对象` };
  }

  const obj2 = obj as Record<string, unknown>;
  const rulesRaw = obj2["rules"];
  if (rulesRaw === undefined) {
    return { rules: [], warning: null };
  }
  if (!Array.isArray(rulesRaw)) {
    return { rules: [], warning: `${sourcePath} 的 rules 字段不是数组` };
  }

  const rules: PermissionRule[] = [];
  for (let i = 0; i < rulesRaw.length; i++) {
    const item = rulesRaw[i];
    const r = validateRule(item, sourcePath, i);
    if (r) rules.push(r);
  }
  return { rules, warning: null };
}

function validateRule(
  raw: unknown,
  sourcePath: string,
  index: number,
): PermissionRule | null {
  if (typeof raw !== "object" || raw === null) {
    console.warn(`[permissions] ${sourcePath} 规则 #${index} 不是对象，已跳过`);
    return null;
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj["tool"] !== "string") {
    console.warn(`[permissions] ${sourcePath} 规则 #${index} 缺 tool 字段，已跳过`);
    return null;
  }

  const action = obj["action"];
  if (action !== "allow" && action !== "deny" && action !== "confirm") {
    console.warn(
      `[permissions] ${sourcePath} 规则 #${index} action 非法（${String(action)}），已跳过`,
    );
    return null;
  }

  const rule: PermissionRule = {
    tool: obj["tool"] as string,
    action,
  };

  if (typeof obj["reason"] === "string") {
    rule.reason = obj["reason"];
  }

  if (obj["match"] !== undefined) {
    const m = obj["match"];
    if (typeof m !== "object" || m === null) {
      console.warn(`[permissions] ${sourcePath} 规则 #${index} match 不是对象，已忽略`);
    } else {
      const match = m as Record<string, unknown>;
      const ruleMatch: NonNullable<PermissionRule["match"]> = {};
      if (typeof match["pathGlob"] === "string") ruleMatch.pathGlob = match["pathGlob"];
      if (typeof match["commandRegex"] === "string")
        ruleMatch.commandRegex = match["commandRegex"];
      if (typeof match["argValueRegex"] === "object" && match["argValueRegex"] !== null) {
        const avr = match["argValueRegex"] as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(avr)) {
          if (typeof v === "string") out[k] = v;
        }
        ruleMatch.argValueRegex = out;
      }
      rule.match = ruleMatch;
    }
  }

  return rule;
}

/**
 * 从全局 + 项目级两个配置文件加载规则，合并成一个 PermissionEngine。
 *
 * 合并策略：
 * - 全局规则在前，项目级规则在后
 * - 同 (tool, action, match) 项目级优先（覆盖全局的旧同名规则）
 *
 * @param cwd - 当前工作目录（决定项目级配置文件位置）
 * @param globalPath - 全局配置文件路径（默认 ~/.dskcode/permissions.json）
 * @returns 加载结果（含合并后的引擎 + 警告列表 + 加载到的文件路径）
 *
 * @pure 不修改任何外部状态
 */
export async function loadPermissions(
  cwd: string,
  globalPath: string = defaultGlobalPermissionsPath(),
): Promise<LoadResult> {
  const loadedFrom: string[] = [];
  const warnings: string[] = [];
  let allRules: PermissionRule[] = [];

  // 1. 加载全局
  const global = await loadRulesFromFile(globalPath);
  if (global.warning) warnings.push(global.warning);
  if (global.rules.length > 0) {
    loadedFrom.push(globalPath);
    allRules = allRules.concat(global.rules);
  }

  // 2. 加载项目级
  const projectPath = defaultProjectPermissionsPath(cwd);
  const project = await loadRulesFromFile(projectPath);
  if (project.warning) warnings.push(project.warning);
  if (project.rules.length > 0) {
    loadedFrom.push(projectPath);
    allRules = allRules.concat(project.rules);
  }

  // 3. 项目级规则覆盖全局同名规则
  const merged = mergeRules(allRules);

  return {
    engine: new PermissionEngine(merged),
    warnings,
    loadedFrom,
  };
}

/**
 * 合并规则：项目级（后半段）覆盖全局（前半段）的同名规则。
 *
 * 同名判定：tool + action + match 序列化后相等。
 */
function mergeRules(rules: ReadonlyArray<PermissionRule>): PermissionRule[] {
  const map = new Map<string, PermissionRule>();
  for (const r of rules) {
    map.set(ruleKey(r), r);
  }
  return [...map.values()];
}

function ruleKey(r: PermissionRule): string {
  const match = r.match
    ? JSON.stringify({
        pathGlob: r.match.pathGlob,
        commandRegex: r.match.commandRegex,
        argValueRegex: r.match.argValueRegex,
      })
    : "{}";
  return `${r.tool}|${r.action}|${match}`;
}
