// ---------------------------------------------------------------------------
// Session 装配胶水 — 把 PermissionsConfig 接到 InteractiveGate
//
// 设计动机：
// Session 构造时只接受 InteractiveGateOptions / Gate 两种入口，
// 但应用层用的是 settings.json 的 PermissionsConfig（Zed 风格字段）。
// 本模块提供：
//   1) buildInteractiveGateOptionsFromConfig — 把 PermissionsConfig 转成
//      InteractiveGateOptions，并把 permissionsFromConfig 的结果塞进 engine。
//   2) hasRulesInConfig — 顶层助手：判断"配的 permissions 是否有实际规则"。
//      配合装配分支：有规则 → InteractiveGate；无规则 → 默认 InteractiveGate。
//
// 行为保证：
// - 无 rules 时返回 null（调用方保持默认 InteractiveGate）
// - 失败不抛错：permissionsFromConfig 内部已经把损坏的规则 skip 掉，
//   warnings 一并带回 InteractiveGateOptions.onWarn 风格的回调位。
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import type { PermissionsConfig } from "../config/types.js";
import type { InteractiveGateOptions } from "./interactive-gate.js";
import { GrantsCache } from "./grants-cache.js";
import { permissionsFromConfig } from "./permissions-loader.js";

// ---------------------------------------------------------------------------
// 顶层助手 — 构造 InteractiveGateOptions / 判断是否有规则
// ---------------------------------------------------------------------------

/**
 * 判断给定的 PermissionsConfig 是否包含「可生效的规则」。
 *
 * 用途：有规则就走规则引擎，否则保持默认 InteractiveGate。
 *
 * 行为：
 * - undefined / 空 config → false
 * - 有任何一个 always_* 数组非空 → true
 *
 * @pure
 */
export function hasRulesInConfig(config: PermissionsConfig | undefined): boolean {
  if (!config?.tools) return false;
  for (const toolRules of Object.values(config.tools)) {
    if (!toolRules) continue;
    if (
      (toolRules.always_deny?.length ?? 0) > 0 ||
      (toolRules.always_allow?.length ?? 0) > 0 ||
      (toolRules.always_confirm?.length ?? 0) > 0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 从 PermissionsConfig 构造 InteractiveGateOptions。
 *
 * 内部使用 permissionsFromConfig（由 permissions-loader.ts 提供统一的
 * PermissionsConfig → PermissionRule 转换），避免重复的循环展开逻辑。
 *
 * @param config — settings.json 的 permissions 字段
 * @param baseOpts — 可选基础选项（prompt / grants / defaultDecision）由调用方注入
 * @returns 完整的 InteractiveGateOptions
 *
 * @pure 不修改入参；只有 engine 持有编译产物
 */
export function buildInteractiveGateOptionsFromConfig(
  config: PermissionsConfig,
  baseOpts: Partial<InteractiveGateOptions> = {},
): InteractiveGateOptions {
  const { engine, warnings } = permissionsFromConfig(config);

  // 顶层 default → InteractiveGate.defaultDecision
  const defaultDecision = config.default ?? baseOpts.defaultDecision ?? "confirm";

  if (warnings.length > 0) {
    for (const w of warnings) {
      // eslint-disable-next-line no-console
      console.warn(`[permissions] ${w}`);
    }
  }

  return {
    engine,
    defaultDecision,
    grants: baseOpts.grants ?? new GrantsCache(),
    prompt: baseOpts.prompt,
  };
}
