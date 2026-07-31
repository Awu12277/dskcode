// ---------------------------------------------------------------------------
// API Key 持久化
//
// 从 loader.ts 剥离的 API Key / Model 保存、权限配置初始化函数。
// ---------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfig } from "./loader.js";

/**
 * 将 API Key 保存到用户全局配置 ~/.dskcode/settings.json。
 * 如果文件已存在，合并写入；不存在则新建。
 * 返回保存的文件路径。
 *
 * v0.10+：本函数为 deepseek provider 的便捷封装，向后兼容。
 * 推荐使用 {@link saveProviderApiKey} 以支持任意 provider。
 */
export async function saveApiKey(apiKey: string): Promise<string> {
  return saveProviderApiKey("deepseek", apiKey);
}

/**
 * 将指定 provider 的 API Key 保存到用户全局配置 ~/.dskcode/settings.json。
 * 若同名 provider 不存在且 providerDefaults 提供，则以默认值创建一个。
 *
 * @param providerName provider 名称（如 "deepseek"）
 * @param apiKey 要保存的 API Key
 * @param providerDefaults 若不存在同名 provider，创建时使用的默认 baseUrl / model
 * @returns 保存的文件路径
 */
export async function saveProviderApiKey(
  providerName: string,
  apiKey: string,
  providerDefaults?: { baseUrl: string; model: string },
): Promise<string> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const configDir = join(home, ".dskcode");
  const configFile = join(configDir, "settings.json");

  // 确保目录存在
  await mkdir(configDir, { recursive: true });

  // 读取现有配置，或从默认配置开始
  let configData: Record<string, unknown>;
  try {
    const raw = await readFile(configFile, "utf-8");
    configData = JSON.parse(raw);
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    configData = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const providers = (configData.providers as Record<string, unknown>[]) ?? [];
  const existing = providers.find((p) => p.name === providerName);

  if (existing) {
    existing.apiKey = apiKey;
  } else if (providerDefaults) {
    providers.push({
      name: providerName,
      apiKey,
      baseUrl: providerDefaults.baseUrl,
      model: providerDefaults.model,
    });
  } else {
    providers.push({
      name: providerName,
      apiKey,
    });
  }

  configData.providers = providers;

  // 写回文件
  await writeFile(configFile, JSON.stringify(configData, null, 2), "utf-8");

  return configFile;
}

/**
 * 将模型偏好保存到用户全局配置 ~/.dskcode/settings.json。
 * 只更新 defaultProvider 的 model 字段，不覆盖其他配置。
 * 返回保存的文件路径。
 */
export async function saveModelConfig(model: string): Promise<string> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const configDir = join(home, ".dskcode");
  const configFile = join(configDir, "settings.json");

  // 确保目录存在
  await mkdir(configDir, { recursive: true });

  // 读取现有配置
  let configData: Record<string, unknown>;
  try {
    const raw = await readFile(configFile, "utf-8");
    configData = JSON.parse(raw);
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    configData = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
  }

  // 更新 defaultProvider 的 model
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const providers = (configData.providers as Record<string, unknown>[]) ?? [];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const defaultProviderName = (configData.defaultProvider as string) ?? "deepseek";
  const existing = providers.find((p) => p.name === defaultProviderName);

  if (existing) {
    existing.model = model;
  } else {
    providers.push({
      name: defaultProviderName,
      baseUrl: "https://api.deepseek.com",
      model,
    });
  }

  configData.providers = providers;

  // 写回文件
  await writeFile(configFile, JSON.stringify(configData, null, 2), "utf-8");

  return configFile;
}

/**
 * 向 settings.json 注入默认的 permissions 配置（如果尚未存在）。
 * 用户第一次启动时自动生成，可以手动编辑。
 */
export async function ensurePermissionsConfig(): Promise<string | null> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const configDir = join(home, ".dskcode");
  const configFile = join(configDir, "settings.json");

  await mkdir(configDir, { recursive: true });

  let configData: Record<string, unknown>;
  try {
    const raw = await readFile(configFile, "utf-8");
    configData = JSON.parse(raw);
  } catch {
    return null;
  }

  if (configData.permissions !== undefined) return null;

  configData.permissions = { tools: {} };

  await writeFile(configFile, JSON.stringify(configData, null, 2), "utf-8");
  return configFile;
}
