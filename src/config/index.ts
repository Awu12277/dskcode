export type {
  Config,
  ProviderConfig,
  ToolConfig,
} from "./types.js";
export {
  loadConfig,
  loadAndValidate,
  applyCliOverrides,
  watchConfig,
  saveApiKey,
  saveProviderApiKey,
  ensurePermissionsConfig,
  defaultConfig,
} from "./loader.js";
export type { CliFlags, ConfigChangeCallback } from "./loader.js";
export { validateConfig } from "./validator.js";
export type { ConfigError } from "./validator.js";
