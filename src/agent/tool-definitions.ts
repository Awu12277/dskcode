// ---------------------------------------------------------------------------
// buildToolDefinitions — 把 ToolRegistry 转成 Provider 需要的工具定义
// ---------------------------------------------------------------------------

import type { ToolDefinition } from "../provider/index.js";
import type { ToolRegistry } from "../tool/registry.js";

/**
 * 构建 Provider 工具定义（喂给 provider.chat() 的 tools 字段）。
 *
 * 列出注册表中所有启用的工具。
 *
 * @param registry — 工具注册表
 * @returns Provider 兼容的 ToolDefinition 数组
 *
 * @pure 无副作用：仅读 registry 状态，不修改任何东西
 */
export function buildToolDefinitions(
  registry: ToolRegistry,
): ToolDefinition[] {
  const tools = registry.list();
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }));
}
