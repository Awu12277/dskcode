/** 单个 Provider 的配置（如 deepseek、openai 等） */
export interface ProviderConfig {
  /** Provider 在注册表中使用的标识符 */
  name: string;
  /** API 基础地址 */
  baseUrl?: string;
  /** API 密钥（也可通过环境变量读取，如 DEEPSEEK_API_KEY） */
  apiKey?: string;
  /** 聊天请求中发送的模型标识 */
  model: string;
}

/** 内置工具的配置 */
export interface ToolConfig {
  /** 工具名称 */
  name: string;
  /** 是否启用该工具 */
  enabled: boolean;
}

/** 深度思考运行参数（v0.6+） */
export interface ThinkingConfig {
  /** 是否启用深度思考（仅部分模型支持） */
  enabled: boolean;
  /** 推理努力等级 */
  effort: "high" | "max";
}

/** dskcode 的根配置 */
export interface Config {
  /** 默认 Provider 名称（必须匹配 TOML 中某个 provider 的 name 字段） */
  defaultProvider: string;
  /** 每次 LLM 请求的最大 token 数 */
  maxTokens?: number;
  /** 生成温度（0.0 ~ 2.0） */
  temperature?: number;
  /** 单次会话最大工具调用轮次 */
  maxToolRounds?: number;
  /** 每日预算上限（元），超过后自动中止请求，0 表示不限制 */
  budgetLimit?: number;
  /** 每日 Token 预算上限，超过后自动中止请求，0 表示不限制 */
  tokenBudgetLimit?: number;
  /** Provider 定义列表 */
  providers: ProviderConfig[];
  /** 工具设置 */
  tools: ToolConfig[];
  /**
   * 工具权限配置（v0.6）。
   * 不配置时默认行为：读/终端直接放行，改文件弹窗确认。
   *
   * 格式（与 Zed 一致，三组正则列表 + 默认策略）：
   * ```json
   * {
   *   "default": "confirm",
   *   "tools": {
   *     "bash": {
   *       "always_deny": ["^rm\\s+-rf\\s+/"],
   *       "always_allow": ["^git\\s+status"],
   *       "always_confirm": ["^npm\\s+publish"]
   *     }
   *   }
   * }
   * ```
   */
  permissions?: PermissionsConfig;
  /** 深度思考开关与强度 */
  thinking?: ThinkingConfig;
}

/** 权限配置（顶层） */
export interface PermissionsConfig {
  default?: "allow" | "deny" | "confirm";
  tools?: Record<string, ToolPermissionRules>;
}

/** 单个工具的权限规则 */
export interface ToolPermissionRules {
  default?: "allow" | "deny" | "confirm";
  always_deny?: string[];
  always_allow?: string[];
  always_confirm?: string[];
}
