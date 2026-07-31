// ---------------------------------------------------------------------------
// 工具系统核心类型定义
// ---------------------------------------------------------------------------

/** 工具的分类语义，替代原来的 boolean readOnly */
export enum ToolKind {
  /** 纯读操作，无副作用，可并行执行 */
  Read = "read",
  /** 文件/目录编辑（修改内容） */
  Edit = "edit",
  /** 文件/目录删除 */
  Delete = "delete",
  /** 移动/重命名 */
  Move = "move",
  /** 其他（bash、fetch 等） */
  Other = "other",
}

/** 工具参数的 JSON Schema 表示 */
export interface JSONSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  /** Schema 自带的 description，自动用作 tool description */
  description?: string;
}

/** 每次工具执行时传入的上下文 */
export interface ToolContext {
  /** 当前工作目录，用于路径约束和相对路径解析 */
  cwd: string;
  /** 中止信号，用于取消正在执行的工具 */
  signal?: AbortSignal;
  /** 命令执行超时（毫秒），默认 30000 */
  timeout?: number;
  /**
   * 写操作的允许根目录列表（绝对路径）。
   * 非空时，写工具必须确保目标路径在其中一个根下；
   * 为空数组表示不限制（保持兼容）。
   */
  writeRoots?: string[];
}

/** 文件变更的 diff 信息 */
export interface FileDiff {
  /** 文件路径（绝对路径） */
  filePath: string;
  /** unified diff 文本 */
  patch: string;
  /** 变更前是否存在（新建文件时为 false） */
  existedBefore: boolean;
  /** 变更统计：新增行数 */
  additions: number;
  /** 变更统计：删除行数 */
  deletions: number;
}

/**
 * 工具执行结果。
 *
 * 设计要点：
 * - 成功和失败共用相同结构，LLM 总能读到可理解的 data
 * - error 字段仅做分类标记（如 TEXT_NOT_FOUND），不暴露内部细节
 * - diff 仅在文件修改工具携带
 * - summary 给 UI 展示，不暴露完整 data 给 UI
 * - issues 阶段 2 新增：携带 schema 校验 issue，供 logger/Reflector/UI 消费
 * - denial v0.6 新增：权限拒绝详情，UI 可展示出明确的拒绝原因 / 规则名 / 建议
 */
export interface ToolResult {
  /** 是否执行成功 */
  success: boolean;
  /** 结果内容（成功时为输出，失败时为错误信息），LLM 可读 */
  data: string;
  /** 错误分类标记（仅在 success=false 时有意义） */
  error?: string;
  /** 文件变更 diff（仅文件修改工具携带） */
  diff?: FileDiff;
  /**
   * 给 UI 展示的简短摘要（一行）。
   * 与 data 区别：data 喂给 LLM 保留完整内容，summary 仅做一行回显。
   * 未设置时 UI 自动降级到 data 的前 500 字符。
   */
  summary?: string;
  /**
   * schema 校验 issue（阶段 2），与 ToolCallRecord.issues 同步。
   * 供 logger / Reflector R5 / UI 结构化消费。
   */
  issues?: ReadonlyArray<{
    path: string;
    expected: string;
    received: string;
    message: string;
  }>;
  /**
   * 权限拒绝详情（v0.6 P0）。当 error === "GATE_DENIED" 时携带。
   * UI 可借此展示"为什么被拒、走了哪条规则、用户怎么调整"等。
   */
  denial?: ToolDenial;
}

/**
 * 权限拒绝详情。
 */
export interface ToolDenial {
  /** 拒绝来源："hardcoded_blacklist" / "permission_rule" / "user_prompt" */
  source: "hardcoded_blacklist" | "permission_rule" | "user_prompt";
  /** 人类可读的拒绝原因（中文） */
  reason: string;
  /** 命中的规则 key（如 "bash|deny|{\"commandRegex\":\"^rm\"}"），用于 UI 跳转配置 */
  ruleKey?: string;
  /** 建议：用户怎么调整能放行（如"编辑 ~/.dskcode/permissions.json"） */
  hint?: string;
}

// ---------------------------------------------------------------------------
// AgentTool — 静态类型安全的工具定义
//
// 每个工具定义为一个对象，提供类型安全的泛型参数。
// ---------------------------------------------------------------------------

/**
 * AgentTool 定义 — 一个工具的完整声明。
 *
 * @template I 工具输入参数类型
 * @template O 工具输出类型（从 ToolResult 继承）
 */
export interface AgentTool<I, O extends ToolResult = ToolResult> {
  /** 工具名称，全局唯一标识符 */
  readonly name: string;

  /** 工具的分类语义 */
  readonly kind: ToolKind;

  /**
   * 参数 JSON Schema 定义。
   * 喂给 LLM provider 的 tools.parameters 字段；
   * validateArgs 走轻量递归校验路径。
   */
  readonly parameters: JSONSchema;

  /**
   * 工具描述 — 默认从 parameters.description 自动提取，
   * 也可显式覆盖以提供更详细的说明。
   */
  readonly description: string;

  /**
   * 给系统提示词里展示的一句话说明。
   *
   * 与 description 的区别：
   * - description 喂给 provider 的 tools 字段（LLM 在调工具时看）
   * - promptSnippet 只在系统提示词里出现一次（告诉模型"这套工具都能干什么"）
   *
   * 未提供时降级为 description 自身。
   */
  readonly promptSnippet?: string;

  /**
   * 给系统提示词里展示的用法要点（可选）。
   *
   * 每条一个完整的提示，如“先读取再修改”“一次完成多处修改”。
   * 模型在主提示词中就能看到这些要点，不必再调 read 工具加载详细文档。
   */
  readonly promptGuidelines?: ReadonlyArray<string>;

  /** 工具执行逻辑 */
  execute(args: I, ctx: ToolContext): Promise<O>;

  /**
   * UI 初始标题（可选）。
   * 用于在 UI 中显示正在执行的工具名称。
   */
  initialTitle?(args: I): string;

  /**
   * 是否支持输入流式传输（可选）。
   * 用于支持 LLM 流式传输工具调用参数。
   */
  supportsInputStreaming?: boolean;

  /**
   * 工具支持的 LLM Provider（可选）。
   * 返回空/undefined 表示支持所有 provider。
   */
  supportedProviders?: string[];
}

// ---------------------------------------------------------------------------
// AnyAgentTool — 动态分发接口（Type Erasure 模式）
//
// 将类型参数擦除，用于 Registry 等需要存储异构工具集合的场景。
// ---------------------------------------------------------------------------

/**
 * AnyAgentTool — 类型擦除后的工具接口。
 * Registry 存储的是此类型，执行时内部做反序列化。
 */
export interface AnyAgentTool {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly parameters: JSONSchema;
  readonly supportsInputStreaming: boolean;
  readonly supportedProviders: string[];

  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
  initialTitle?(args: unknown): string;
}

/**
 * 将类型安全的 AgentTool 擦除为 AnyAgentTool。
 */
export function eraseTool<I, O extends ToolResult = ToolResult>(
  tool: AgentTool<I, O>,
): AnyAgentTool {
  return {
    get name() {
      return tool.name;
    },
    get description() {
      return tool.description;
    },
    get kind() {
      return tool.kind;
    },
    get parameters() {
      return tool.parameters;
    },
    get supportsInputStreaming() {
      return tool.supportsInputStreaming ?? false;
    },
    get supportedProviders() {
      return tool.supportedProviders ?? [];
    },

    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return tool.execute(args as I, ctx);
    },

    initialTitle(args: unknown): string {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return tool.initialTitle?.(args as I) ?? tool.name;
    },
  };
}

/**
 * 从 JSON Schema 中提取 description。
 * 若 schema.properties 的顶层有 description，使用它；
 * 否则使用 schema 本身的 description。
 */
export function extractDescription(schema: JSONSchema, fallback?: string): string {
  if (schema.description) return schema.description;
  if (fallback) return fallback;
  return "";
}

/**
 * 根据 ToolKind 判断是否只读（可并行执行）。
 * Read 一定只读；Edit/Delete/Move 一定写；Other 默认非只读。
 */
export function isReadOnly(kind: ToolKind): boolean {
  return kind === ToolKind.Read;
}

// ---------------------------------------------------------------------------
// Permission/Gate 接口
// ---------------------------------------------------------------------------

/**
 * Gate 权限门接口 — 控制工具执行前是否需要审批。
 *
 * v0.6 P0 扩展：可实现 `lastDenial` getter 让 ToolExecutor 在拒绝时拿到详细原因。
 * 默认实现返回 undefined（ToolExecutor 退化为"未知原因"展示）。
 */
export interface Gate {
  check(toolName: string, args: unknown): boolean | Promise<boolean>;
  /**
   * 上次 check() 返回 false 时携带的拒绝详情。可选。
   *
   * 语义：
   * - 仅在最近一次 check() 调用返回 false 后才有意义
   * - check() 返回 true 后状态未定义（不同 Gate 可选择重置 / 保留）
   *
   * @returns 拒绝详情；未实现则返回 undefined
   */
  readonly lastDenial?: ToolDenial | undefined;
}

/**
 * AlwaysAllowGate — 默认权限门，所有工具调用默认放行。
 */
export class AlwaysAllowGate implements Gate {
  check(_toolName: string, _args: unknown): boolean {
    return true;
  }
  readonly lastDenial: ToolDenial | undefined = undefined;
}

/**
 * 工具调用记录（用于风暴检测、Reflector 等）。
 *
 * 阶段 2 新增 `issues` 字段：携带 schema 校验失败的 issue 列表，
 * Reflector R5 据此判定是否提示 LLM 修正参数。
 */
export interface ToolCallRecord {
  name: string;
  success: boolean;
  error?: string;
  timestamp: number;
  /** schema 校验 issue（阶段 2），用于 Reflector R5 与日志/调试 */
  issues?: ReadonlyArray<{
    path: string;
    expected: string;
    received: string;
    message: string;
  }>;
}
