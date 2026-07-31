import type { Command } from "commander";
import { loadAndValidate, applyCliOverrides, defaultConfig } from "../config/index.js";
import type { Config } from "../config/index.js";

/**
 * dskcode 运行时上下文。
 * 通过 commander 的 preAction hook 注入到每个命令中。
 */
export interface DskcodeContext {
  config: Config;
}

/**
 * 在 preAction hook 中加载配置并构造上下文。
 *
 * 完整的配置解析流水线：
 *   1. 内置默认值 —— defaultConfig
 *   2. 用户全局 —— ~/.dskcode/settings.json
 *   3. 项目本地 —— .dskcode/settings.json
 *   4. 环境变量 —— DEEPSEEK_API_KEY / DSKCODE_*
 *   5. CLI flag —— --model 等
 */
export async function loadConfigMiddleware(this: Command): Promise<DskcodeContext> {
  const opts = this.optsWithGlobals() as {
    config?: string;
    model?: string;
  };

  // 1-4. 加载配置文件 + 环境变量
  let config: Config;
  try {
    const result = await loadAndValidate(opts.config);
    config = result.config;
  } catch {
    config = structuredClone(defaultConfig);
  }

  // 5. CLI flag 覆盖（优先级最高）
  config = applyCliOverrides(config, {
    model: opts.model,
  });

  return { config };
}
