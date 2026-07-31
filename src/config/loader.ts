import { existsSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Config,
} from "./types.js";

// ---------------------------------------------------------------------------
// 出厂默认配置
// ---------------------------------------------------------------------------



export const defaultConfig: Config = {
  defaultProvider: "deepseek",
  maxTokens: 8192,
  temperature: 0.7,
  maxToolRounds: 20,
  providers: [
    {
      name: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    },
  ],
  tools: [
    { name: "read_file", enabled: true },
    { name: "write_file", enabled: true },
    { name: "edit_file", enabled: true },
    { name: "bash", enabled: true },
    { name: "glob", enabled: true },
    { name: "grep", enabled: true },
    { name: "ls", enabled: true },
    { name: "fetch", enabled: true },
  ],
  thinking: {
    enabled: true,
    effort: "high",
  },
};

// ---------------------------------------------------------------------------
// 配置文件路径解析
// ---------------------------------------------------------------------------

/**
 * 返回候选配置文件路径列表。
 * 若传入了 --config 路径，则只使用该路径；
 * 否则依次检查用户全局目录和项目本地目录。
 */
function resolveConfigFiles(configPath?: string): string[] {
  if (configPath) {
    return [configPath];
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return [
    join(home, ".dskcode", "settings.json"),
    join(process.cwd(), ".dskcode", "settings.json"),
  ];
}

// ---------------------------------------------------------------------------
// 深度合并
// ---------------------------------------------------------------------------

/**
 * 将较高优先级的配置 overlay 合并到 base 之上。
 *
 * 合并规则：
 *  - 标量字段（string / number / boolean）：覆盖
 *  - 数组字段（providers / tools）：直接替换，不合并
 */
function mergeConfig(base: Config, overlay: Partial<Config>): Config {
  const result: Config = { ...base };

  if (overlay.defaultProvider !== undefined) {
    result.defaultProvider = overlay.defaultProvider;
  }
  if (overlay.maxTokens !== undefined) {
    result.maxTokens = overlay.maxTokens;
  }
  if (overlay.temperature !== undefined) {
    result.temperature = overlay.temperature;
  }
  if (overlay.maxToolRounds !== undefined) {
    result.maxToolRounds = overlay.maxToolRounds;
  }
  if (overlay.budgetLimit !== undefined) {
    result.budgetLimit = overlay.budgetLimit;
  }
  if (overlay.tokenBudgetLimit !== undefined) {
    result.tokenBudgetLimit = overlay.tokenBudgetLimit;
  }
  if (overlay.providers !== undefined) {
    result.providers = overlay.providers;
  }
  if (overlay.tools !== undefined) {
    result.tools = overlay.tools;
  }
  if (overlay.permissions !== undefined) {
    result.permissions = overlay.permissions;
  }
  if (overlay.thinking !== undefined) {
    result.thinking = overlay.thinking;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 环境变量解析
// ---------------------------------------------------------------------------

/** 环境变量前缀 */
const ENV_PREFIX = "DSKCODE_";

/** 支持的环境变量映射表 */
const ENV_MAP: Record<string, string> = {
  [`${ENV_PREFIX}DEFAULT_PROVIDER`]: "defaultProvider",
  [`${ENV_PREFIX}MAX_TOKENS`]: "maxTokens",
  [`${ENV_PREFIX}TEMPERATURE`]: "temperature",
  [`${ENV_PREFIX}MAX_TOOL_ROUNDS`]: "maxToolRounds",
  [`${ENV_PREFIX}BUDGET_LIMIT`]: "budgetLimit",
  [`${ENV_PREFIX}TOKEN_BUDGET_LIMIT`]: "tokenBudgetLimit",
  [`${ENV_PREFIX}THINKING`]: "thinking.enabled",
  [`${ENV_PREFIX}THINKING_EFFORT`]: "thinking.effort",
};

/**
 * 将环境变量中读取的值覆盖到配置上。
 * 环境变量的优先级高于 TOML 文件，但低于 CLI flag。
 * 返回一个新的配置对象，不修改原始配置。
 */
function applyEnvVars(config: Config): Config {
  // 浅拷贝以避免修改原始对象
  const result: Config = { ...config, providers: [...config.providers] };

  // 1. DSKCODE_* 前缀的环境变量
  for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
    const raw = process.env[envKey];
    if (raw === undefined) continue;

    // 拆 "thinking.enabled" 这种点号路径
    if (configKey.startsWith("thinking.")) {
      const field = configKey.slice("thinking.".length);
      const existing = result.thinking ?? { enabled: true, effort: "high" as const };
      if (field === "enabled") {
        result.thinking = {
          ...existing,
          enabled: raw === "1" || raw.toLowerCase() === "true",
        };
      } else if (field === "effort") {
        if (raw === "high" || raw === "max") {
          result.thinking = { ...existing, effort: raw };
        }
      }
      continue;
    }

    switch (configKey) {
      case "defaultProvider": {
        // eslint-disable-next-line typescript/no-unsafe-type-assertion
        (result as unknown as Record<string, unknown>)[configKey] = raw;
        break;
      }
      case "maxTokens":
      case "maxToolRounds":
      case "budgetLimit":
      case "tokenBudgetLimit": {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) {
          // eslint-disable-next-line typescript/no-unsafe-type-assertion
          (result as unknown as Record<string, unknown>)[configKey] = n;
        }
        break;
      }
      case "temperature": {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0 && n <= 2) {
          // eslint-disable-next-line typescript/no-unsafe-type-assertion
          (result as unknown as Record<string, unknown>)[configKey] = n;
        }
        break;
      }
    }
  }

  // 2. 注入各 provider 的 API Key
  // - DEEPSEEK_API_KEY → 名为 deepseek 的 provider（不存在则自动创建）
  injectApiKey(result, "deepseek", "DEEPSEEK_API_KEY", {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  });

  return result;
}

/**
 * 将指定环境变量注入到名为 providerName 的 provider 配置中。
 * 若不存在同名 provider，则用 defaults 创建一个。
 */
function injectApiKey(
  result: Config,
  providerName: string,
  envVar: string,
  defaults: { baseUrl: string; model: string },
): void {
  const apiKey = process.env[envVar];
  if (!apiKey) return;

  const idx = result.providers.findIndex((p) => p.name === providerName);
  if (idx !== -1) {
    const existing = result.providers[idx]!;
    if (!existing.apiKey) {
      result.providers[idx] = { ...existing, apiKey };
    }
  } else {
    // 不存在同名 provider，自动创建并插入到列表头部
    result.providers.unshift({
      name: providerName,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      apiKey,
    });
  }
}

// ---------------------------------------------------------------------------
// CLI flag 覆盖
// ---------------------------------------------------------------------------

export interface CliFlags {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  budgetLimit?: number;
  tokenBudgetLimit?: number;
}

/**
 * 将 CLI flag 中的值覆盖到配置上。
 * CLI flag 的优先级最高。
 * 返回一个新的配置对象，不修改原始配置。
 */
export function applyCliOverrides(config: Config, flags: CliFlags): Config {
  const result: Config = { ...config, providers: [...config.providers] };

  if (flags.model !== undefined) {
    // 将 --model 的值映射为标准 model 名称
    // 如果用户指定了 --model，覆盖 defaultProvider 中配置的 model
    const providerIdx = result.providers.findIndex(
      (p) => p.name === result.defaultProvider,
    );
    if (providerIdx !== -1) {
      result.providers[providerIdx] = {
        ...result.providers[providerIdx]!,
        model: flags.model,
      };
    }
  }
  if (flags.maxTokens !== undefined && flags.maxTokens > 0) {
    result.maxTokens = flags.maxTokens;
  }
  if (
    flags.temperature !== undefined &&
    flags.temperature >= 0 &&
    flags.temperature <= 2
  ) {
    result.temperature = flags.temperature;
  }
  if (flags.budgetLimit !== undefined && flags.budgetLimit >= 0) {
    result.budgetLimit = flags.budgetLimit;
  }
  if (flags.tokenBudgetLimit !== undefined && flags.tokenBudgetLimit >= 0) {
    result.tokenBudgetLimit = flags.tokenBudgetLimit;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 配置校验（已移至 validator.ts）
// ---------------------------------------------------------------------------

import { validateConfig, type ConfigError } from "./validator.js";
export type { ConfigError };
export { validateConfig };

// ---------------------------------------------------------------------------
// 核心加载流程
// ---------------------------------------------------------------------------

/**
 * 从多级配置源加载并合并配置。
 *
 * 解析顺序（后加载的优先级更高）：
 *   1. 内置默认值 —— defaultConfig
 *   2. 用户全局 —— ~/.dskcode/settings.json
 *   3. 项目本地 —— .dskcode/settings.json（或通过 --config 指定的路径）
 *   4. 环境变量 —— DEEPSEEK_API_KEY、DSKCODE_* 等
 *   5. CLI flag —— 由调用方通过 applyCliOverrides() 单独注入
 */
export async function loadConfig(configPath?: string): Promise<Config> {
  const filePaths = resolveConfigFiles(configPath);

  let config: Config = structuredClone(defaultConfig);

  // 1-3. 依次加载 JSON 配置文件
  for (const filePath of filePaths) {
    try {
      const raw = await readFile(filePath, "utf-8");
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      const parsed = JSON.parse(raw) as Partial<Config>;
      config = mergeConfig(config, parsed);
    } catch {
      // 文件不存在或权限不足 — 静默跳过
    }
  }

  // 4. 环境变量覆盖
  config = applyEnvVars(config);

  return config;
}

/**
 * 加载配置并同时执行校验。
 * 校验错误不会 throw，而是通过返回值中的 errors 字段返回，
 * 由调用方决定如何处理（例如在 middleware 中输出警告）。
 */
export async function loadAndValidate(
  configPath?: string,
): Promise<{ config: Config; errors: ConfigError[] }> {
  const config = await loadConfig(configPath);
  const errors = validateConfig(config);
  return { config, errors };
}



// ---------------------------------------------------------------------------
// 配置热加载（Watch 模式）
// ---------------------------------------------------------------------------

export type ConfigChangeCallback = (config: Config) => void;

/**
 * 监听配置文件变更，在文件被修改时重新加载配置并调用回调。
 *
 * @param callback  配置变更后的回调函数
 * @param configPath  可选，指定配置文件路径（对应 --config flag）
 * @returns  一个 unwatch 函数，调用后可停止监听
 */
export function watchConfig(
  callback: ConfigChangeCallback,
  configPath?: string,
): () => void {
  const filePaths = resolveConfigFiles(configPath).filter((fp) => existsSync(fp));

  // 如果一个文件都不存在，则监听项目本地的 .dskcode/settings.json（即使还没创建）
  if (filePaths.length === 0) {
    filePaths.push(join(process.cwd(), ".dskcode", "settings.json"));
  }

  const watchers: ReturnType<typeof watch>[] = [];
  let debounceTimer: ReturnType<typeof setTimeout>;

  for (const filePath of filePaths) {
    try {
      const watcher = watch(filePath, (eventType) => {
        if (eventType !== "change") return;

        // 防抖：多次连续变更只触发一次
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void (async () => {
            try {
              const config = await loadConfig(configPath);
              callback(config);
            } catch {
              // 重载失败时不回调，等待下一次变更
            }
          })();
        }, 300);
      });

      watchers.push(watcher);
    } catch {
      // 无法监听的文件（例如还不存在）— 跳过
    }
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) {
      w.close();
    }
  };
}

// ---------------------------------------------------------------------------
// API Key 持久化（已移至 api-key.ts）
// ---------------------------------------------------------------------------

import {
  saveApiKey,
  saveProviderApiKey,
  saveModelConfig,
  ensurePermissionsConfig,
} from "./api-key.js";
export { saveApiKey, saveProviderApiKey, saveModelConfig, ensurePermissionsConfig };
