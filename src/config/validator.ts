// ---------------------------------------------------------------------------
// 配置校验器 — 校验配置的合法性
//
// 从 loader.ts 剥离，保持纯函数风格。
// ---------------------------------------------------------------------------

import type { Config } from "./types.js";

// ---------------------------------------------------------------------------
// 校验常量
// ---------------------------------------------------------------------------

/** 支持的模型列表 */
const SUPPORTED_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];

// ---------------------------------------------------------------------------
// 校验结果类型
// ---------------------------------------------------------------------------

export interface ConfigError {
  field: string;
  message: string;
}

/**
 * 校验配置的合法性，返回错误列表。
 * 返回空数组表示配置合法。
 */
export function validateConfig(config: Config): ConfigError[] {
  const errors: ConfigError[] = [];

  // 1. 至少需要一个 Provider
  if (!config.providers || config.providers.length === 0) {
    errors.push({
      field: "providers",
      message:
        "至少需要配置一个 Provider。请通过配置文件或 DEEPSEEK_API_KEY 环境变量设置。",
    });
  }

  // 2. 每个 Provider 必须有 name 和 model
  for (let i = 0; i < config.providers.length; i++) {
    const p = config.providers[i]!;
    if (!p.name) {
      errors.push({
        field: `providers[${i}].name`,
        message: `第 ${i + 1} 个 Provider 缺少 name 字段。`,
      });
    }
    if (!p.model) {
      errors.push({
        field: `providers[${i}].model`,
        message: `Provider "${p.name || i}" 缺少 model 字段。`,
      });
    } else if (!SUPPORTED_MODELS.includes(p.model)) {
      errors.push({
        field: `providers[${i}].model`,
        message: `Provider "${p.name || i}" 的 model "${p.model}" 不受支持。dskcode 支持: ${SUPPORTED_MODELS.join(", ")}`,
      });
    }
  }

  // 3. defaultProvider 必须存在于 providers 列表中
  if (config.defaultProvider) {
    const exists = config.providers.some((p) => p.name === config.defaultProvider);
    if (!exists) {
      errors.push({
        field: "defaultProvider",
        message: `默认 Provider "${config.defaultProvider}" 未在 providers 中定义。`,
      });
    }
  }

  // 4. temperature 范围校验
  if (
    config.temperature !== undefined &&
    (config.temperature < 0 || config.temperature > 2)
  ) {
    errors.push({
      field: "temperature",
      message: "temperature 必须在 0.0 ~ 2.0 之间。",
    });
  }

  // 5. maxTokens 范围校验
  if (config.maxTokens !== undefined && config.maxTokens < 1) {
    errors.push({
      field: "maxTokens",
      message: "maxTokens 必须大于等于 1。",
    });
  }

  // 6. maxToolRounds 范围校验
  if (config.maxToolRounds !== undefined && config.maxToolRounds < 1) {
    errors.push({
      field: "maxToolRounds",
      message: "maxToolRounds 必须大于等于 1。",
    });
  }

  // 7. budgetLimit 范围校验
  if (config.budgetLimit !== undefined && config.budgetLimit < 0) {
    errors.push({
      field: "budgetLimit",
      message: "budgetLimit 必须大于等于 0（0 表示不限制）。",
    });
  }

  // 8. tokenBudgetLimit 范围校验
  if (config.tokenBudgetLimit !== undefined && config.tokenBudgetLimit < 0) {
    errors.push({
      field: "tokenBudgetLimit",
      message: "tokenBudgetLimit 必须大于等于 0（0 表示不限制）。",
    });
  }

  return errors;
}
