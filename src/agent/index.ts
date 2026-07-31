// ---------------------------------------------------------------------------
// Agent 会话 — 协调者（MVP 版）
//
// 砍掉了 Goal/Checkpoint/Harness/Reflector/Compactor/StormDetector/skill 工具注入。
// 保留核心：chat() 主循环 + 工具执行 + 持久化 + 权限门。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatOptions,
  Provider,
  ProviderToolCall,
  UsageInfo,
} from "../provider/index.js";
import { CostTracker, calculateCost, getModelMeta } from "../provider/index.js";
import type { AnyAgentTool } from "../tool/index.js";
import type { Gate, ToolCallRecord, ToolResult } from "../tool/types.js";
import { AlwaysAllowGate, ToolKind, eraseTool } from "../tool/types.js";
import type { AgentEvent, SessionMode, SystemPromptOptions } from "./types.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { loadContextFiles } from "./context-files.js";
import { trimMessages, buildApiMessages } from "./message-builder.js";
import { ToolRegistry } from "../tool/registry.js";
import { ToolExecutor } from "./tool-executor.js";
import { buildToolDefinitions } from "./tool-definitions.js";
import { HardcodedBlacklistGate } from "../security/hardcoded-gate.js";
import { CompositeGate } from "../security/composite-gate.js";
import { InteractiveGate, type PromptFn } from "../security/interactive-gate.js";
import {
  loadPermissions,
  defaultGlobalPermissionsPath,
  defaultProjectPermissionsPath,
} from "../security/permissions-loader.js";

/**
 * Session 构造选项。
 */
export interface SessionOptions {
  cwd?: string;
  maxToolRounds?: number;
  reservedForOutput?: number;
  preserveRecentRounds?: number;
  projectContext?: string;
  gate?: Gate;
  writeRoots?: string[];
  sessionId?: string;
  /**
   * 权限配置：包含 rules / grants / prompt / defaultDecision。
   * 若不传则走「自动加载」（见 enablePermissions）。
   */
  permissions?: import("../security/interactive-gate.js").InteractiveGateOptions;
  /**
   * 是否启用权限门（默认 true）。
   *
   * - true（本项目默认）→ 装配 InteractiveGate，
   *     规则来源优先顺序：options.permissions.engine -> 磁盘全局/项目级 permissions.json。
   *     默认 defaultDecision = "confirm"，未传 prompt 时走 fail-loud defaultAutoDenyPrompt。
   * - false → 不装配任何权限门，总是放行（除了硬编码黑名单不被进）。
   *     适用于一次性脚本 / CI / 明确你理解后果的场景。
   */
  enablePermissions?: boolean;
  /** 当前会话模式 */
  mode?: SessionMode;
  /** 是否启用深度思考 */
  thinkingEnabled?: boolean;
  /** 思考强度 */
  thinkingEffort?: "high" | "max";
  /** 成本追踪器（未传则创建默认） */
  costTracker?: CostTracker;
  /** 注入 system prompt 的 skill summary 列表 */
  skillCatalog?: import("./types.js").SkillSummaryView[];
}

/**
 * 补齐 messages 末尾 assistant(tool_calls) 但没有对应 tool 消息的孤儿。
 * 防止 DeepSeek API 报 400 错误。
 */
export function repairOrphanToolCalls(messages: ChatMessage[]): number {
  let patched = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      // 检查后面是否有 tool 消息
      const next = messages[i + 1];
      if (!next || next.role !== "tool") {
        // 插入占位 tool 消息
        for (const tc of msg.toolCalls) {
          messages.splice(i + 1 + patched, 0, {
            role: "tool",
            content: "[上轮被打断，未执行]",
            toolCallId: tc.id,
          });
          patched++;
        }
      }
    }
  }
  return patched;
}

/**
 * Session — 单个对话会话的协调者。
 *
 * 责任范围（瘦身后）：
 * 1. 编排 chat() 主循环：用户输入 → 构建 prompt → 调 LLM → 工具执行
 * 2. 维护会话级状态：messages、模式、cost
 * 3. 不实现工具执行、风暴检测、checkpoint、持久化 — 都已砍掉
 */
export class Session {
  // 会话基础
  readonly #sessionId: string;
  readonly #createdAt: number;
  readonly #cwd: string;
  readonly #options: Required<
    Omit<
      SessionOptions,
      | "gate"
      | "sessionId"
      | "projectContext"
      | "permissions"
      | "writeRoots"
      | "thinkingEnabled"
      | "thinkingEffort"
      | "mode"
      | "costTracker"
      | "skillCatalog"
    >
  > & {
    gate?: Gate;
    sessionId?: string;
    projectContext?: string;
    writeRoots?: string[];
    permissions?: import("../security/interactive-gate.js").InteractiveGateOptions;
    enablePermissions: boolean;
    mode: SessionMode;
    thinkingEnabled: boolean;
    thinkingEffort: "high" | "max";
    costTracker?: CostTracker;
    skillCatalog?: import("./types.js").SkillSummaryView[];
  };

  // 状态
  readonly #messages: ChatMessage[] = [];
  #mode: SessionMode;
  #abortController = new AbortController();
  #costTracker: CostTracker;
  #skillCatalog: import("./types.js").SkillSummaryView[] = [];

  // 工具 + 权限
  readonly #toolRegistry: ToolRegistry;
  #gate: Gate;
  /** 当前注入到 InteractiveGate 的 prompt。null 表示仅用 InteractiveGate 默认 fail-loud。 */
  #interactivePromptFn: PromptFn | null = null;
  /** 加载 permissions.json 中的警告（不阻断出）。 */
  #gateLoadWarnings: string[] = [];

  // 公共：成本
  get sessionTotalCost(): number {
    return this.#costTracker.sessionTotalCost;
  }

  /** toolRegistry 公开给调用方使用 */
  get toolRegistry(): ToolRegistry {
    return this.#toolRegistry;
  }

  /** gate 公开给调用方使用 */
  get gate(): Gate {
    return this.#gate;
  }

  /**
   * 注入 UI 的权限询问回调。供 ChatApp 调用，仅替换当前 gate 链中
   * InteractiveGate 的 prompt，不重建外部 CompositeGate / HardcodedBlacklistGate。
   *
   * - enablePermissions=false 或 gate 是外部提供者 → noop（明确不接管）
   * - 其它场景如果当前 gate 不是 CompositeGate 或包含交互型 Gate → noop
   */
  setGatePrompt(promptFn: PromptFn): void {
    if (this.#options.enablePermissions === false) return;
    if (this.#options.gate) return; // 外部 gate 不接管

    this.#interactivePromptFn = promptFn;
    // 如果当前 gate 是 CompositeGate 且包裹 InteractiveGate，则重建并替换。
    const inner = unwrapInteractive(this.#gate);
    if (!inner) return; // 不是 InteractiveGate 包裹的场景，不修改

    inner.setPrompt(promptFn);
  }

  /**
   * 供 ChatApp 在启动 streaming 时调用：启用 settings.json 的 permissions 配置。
   * 语义：替换当前 InteractiveGate 为以指定 engine 驱动的 InteractiveGate。
   * 不创建新 CompositeGate，不改变 HardcodedBlacklistGate 顺序。
   *
   * - enablePermissions=false 或 gate 是外部提供者 → noop
   * - 未提供 engine → noop（需明确提供 engine 才接管）
   */
  setPermissions(
    engine: import("../security/permissions.js").PermissionEngine,
    defaultDecision: "allow" | "deny" | "confirm" = "confirm",
  ): void {
    if (this.#options.enablePermissions === false) return;
    if (this.#options.gate) return;
    if (this.#options.permissions) return; // 优先于设置文件
    if (!engine) return;

    const promptFn = this.#interactivePromptFn ?? undefined;
    this.#gate = wrapWithHardcoded(
      new InteractiveGate({
        engine,
        defaultDecision,
        prompt: promptFn,
      }),
    );
  }

  /** 加载权限配置时的警告列表（只读快照）。 */
  get gateLoadWarnings(): readonly string[] {
    return [...this.#gateLoadWarnings];
  }

  constructor(options: SessionOptions = {}) {
    this.#sessionId = options.sessionId ?? randomUUID();
    this.#createdAt = Date.now();
    this.#cwd = options.cwd ?? process.cwd();
    this.#options = {
      cwd: this.#cwd,
      maxToolRounds: options.maxToolRounds ?? 20,
      reservedForOutput: options.reservedForOutput ?? 4096,
      preserveRecentRounds: options.preserveRecentRounds ?? 6,
      mode: options.mode ?? "code",
      thinkingEnabled: options.thinkingEnabled ?? false,
      thinkingEffort: options.thinkingEffort ?? "high",
      projectContext: options.projectContext,
      permissions: options.permissions,
      enablePermissions: options.enablePermissions ?? true,
      writeRoots: options.writeRoots,
      gate: options.gate,
      sessionId: options.sessionId,
    };
    this.#mode = this.#options.mode;
    this.#costTracker = options.costTracker ?? new CostTracker({});
    this.#toolRegistry = new ToolRegistry();

    // 构造 gate
    //
    // 默认开启权限门（enablePermissions 默认 true）：
    // - options.permissions 提供明确 engine → InteractiveGate 用其 engine/defaultDecision/prompt
    // - 否则自动加载磁盘配置（全局+项目级合并），结果填到 engine
    // - 仍未加载到任何规则 → 空 InteractiveGate + defaultDecision="confirm"
    //
    // prompt 默认走 fail-loud defaultAutoDenyPrompt。调用方应通过
    // session.setGatePrompt(promptFn) 注入 UI prompt（ChatApp 在启动 streaming 时调）。
    //
    // 硬编码黑名单永远在 CompositeGate 最前，无论其它哪条分支。
    // enablePermissions: false → AlwaysAllowGate（CI / 一次性脚本友好）。
    this.#gateLoadWarnings = [];
    this.#gate = this.#buildGate(options);
    this.#skillCatalog = options.skillCatalog ?? [];
  }

  /**
   * 同步装配内部 Gate（在 constructor 内调用、必须同步）。
   *
   * 装配顺序：
   *  1. enablePermissions === false → AlwaysAllowGate
   *  2. options.gate 显式提供 → 原样返回
   *  3. options.permissions 提供 → InteractiveGate（options.permissions 拥有最高优先级）
   *  4. 未提供 → 空 InteractiveGate + defaultDecision="confirm"
   *  5. 在 CompositeGate 最前补 HardcodedBlacklistGate
   *
   * Session 装配后 prompt 默认是 fail-loud，调用方需用 setGatePrompt()
   * 注入 UI prompt（ChatApp 在启动 streaming 时调）。
   *
   * 磁盘配置（~/.dskcode/permissions.json + .dskcode/permissions.json）由
   * constructor 之后调 session.loadPermissionsFromDisk() 补充。
   *
   * @pure 不修改入参；不主动 IO（除构造函数中 set 的 #gateLoadWarnings）
   */
  #buildGate(options: SessionOptions): Gate {
    if (options.enablePermissions === false) {
      return new AlwaysAllowGate();
    }
    if (options.gate) return options.gate;

    const perms = options.permissions;
    if (perms) {
      return wrapWithHardcoded(
        new InteractiveGate({
          engine: perms.engine,
          defaultDecision: perms.defaultDecision ?? "confirm",
          prompt: perms.prompt,
        }),
      );
    }

    return wrapWithHardcoded(
      new InteractiveGate({
        engine: undefined,
        defaultDecision: "confirm",
      }),
    );
  }

  /**
   * 从磁盘加载 permissions.json（全局+项目级合并），并替换当前 gate。
   * 由 CLI 装配时调用；其余调用方（如单元测试）可以忽略。
   *
   * 幂等：多次调用只会走“未启用、未被外部 gate 、未提供 permissions”这三个前置条件。
   */
  async loadPermissionsFromDisk(): Promise<void> {
    if (this.#options.enablePermissions === false) return;
    if (this.#options.gate) return;
    if (this.#options.permissions) return;

    const loaded = await loadPermissions(this.#cwd);
    if (loaded.warnings.length > 0) {
      this.#gateLoadWarnings.push(...loaded.warnings);
    }

    const promptFn = this.#interactivePromptFn ?? undefined;
    this.#gate = wrapWithHardcoded(
      new InteractiveGate({
        engine: loaded.engine,
        defaultDecision: "confirm",
        prompt: promptFn,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // 模式 / 思考
  // -------------------------------------------------------------------------

  get mode(): SessionMode {
    return this.#mode;
  }

  setMode(mode: SessionMode): void {
    this.#mode = mode;
  }

  // -------------------------------------------------------------------------
  // 消息访问
  // -------------------------------------------------------------------------

  get messages(): ReadonlyArray<ChatMessage> {
    return this.#messages;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  // -------------------------------------------------------------------------
  // 工具注册
  // -------------------------------------------------------------------------

  registerTool(tool: AnyAgentTool): void {
    this.#toolRegistry.register(tool);
  }

  // -------------------------------------------------------------------------
  // 主入口：chat() — 流式输出一轮对话
  // -------------------------------------------------------------------------

  async *chat(
    userInput: string,
    opts: ChatOptions & { provider: Provider },
  ): AsyncGenerator<AgentEvent> {
    // 1. push user message
    this.#messages.push({ role: "user", content: userInput });
    repairOrphanToolCalls(this.#messages);

    // 2. 主循环：调用 LLM → 工具执行 → 写 messages
    let toolRounds = 0;
    const startTime = Date.now();
    let totalUsage: UsageInfo | undefined;
    const lastModel = opts.provider.model();

    while (true) {
      // 2a. 构建提示词 + 裁剪 + 拼装
      const apiMessages = this.#prepareApiMessages(lastModel);

      // 2b. 流式调用 LLM（inline 确保 text_delta 实时 yield）
      let assistantContent = "";
      const toolCalls: ProviderToolCall[] = [];
      let currentUsage: UsageInfo | undefined;

      const stream = opts.provider.chat(apiMessages, {
        tools: buildToolDefinitions(this.#toolRegistry),
        thinkingAllowed: this.#options.thinkingEnabled,
        thinkingEffort: this.#options.thinkingEffort,
        signal: this.#abortController.signal,
      });

      for await (const chunk of stream) {
        if (chunk.content) {
          assistantContent += chunk.content;
          yield { type: "text_delta", content: chunk.content };
        }
        if (chunk.reasoningContent) {
          yield { type: "reasoning_delta", content: chunk.reasoningContent };
        }
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          for (const tc of chunk.toolCalls) {
            toolCalls.push(tc);
          }
        }
        if (chunk.usage) {
          currentUsage = chunk.usage;
          totalUsage = chunk.usage;
        }
      }

      if (currentUsage) {
        totalUsage = currentUsage;
      }

      // 2c. 写 assistant 消息
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: assistantContent,
        ...(toolCalls.length > 0
          ? { toolCalls: toolCalls.map((tc) => ({ ...tc })) }
          : {}),
      };
      this.#messages.push(assistantMsg);

      // 2d. 无工具调用 → 本轮结束
      if (toolCalls.length === 0) {
        if (currentUsage) {
          this.#recordCost(currentUsage, lastModel);
        }
        yield { type: "done", elapsed: Date.now() - startTime };
        return;
      }

      // 2e. yield tool_calls 给 UI
      yield { type: "tool_calls", calls: toolCalls };

      // 2f-g. 执行工具 + 写结果到 messages
      const { toolResults: results } = await this.#executeToolCalls(toolCalls);

      // yield tool_result 事件
      for (const item of results) {
        yield {
          type: "tool_result",
          name: item.name,
          result: item.result,
          callId: item.callId,
        };
      }

      toolRounds++;
      if (toolRounds >= this.#options.maxToolRounds) {
        yield {
          type: "error",
          error: new Error(`达到 maxToolRounds=${this.#options.maxToolRounds}`),
        };
        return;
      }

      if (currentUsage) {
        this.#recordCost(currentUsage, lastModel);
      }
    }
  }

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------

  reset(): void {
    this.#messages.length = 0;
    this.#costTracker.resetSession();
  }

  // -------------------------------------------------------------------------
  // abort
  // -------------------------------------------------------------------------

  abort(): void {
    this.#abortController.abort();
  }

  // -------------------------------------------------------------------------
  // 回合执行辅助方法
  // -------------------------------------------------------------------------

  /**
   * 准备 API 消息：构建 system prompt + 裁剪上下文 + 拼装消息数组。
   */
  #prepareApiMessages(model: string): ChatMessage[] {
    const sysPrompt = this.#buildSystemPrompt();
    const [trimmed] = trimMessages(this.#messages, {
      reservedForOutput: this.#options.reservedForOutput,
      preserveRecentRounds: this.#options.preserveRecentRounds,
      model,
      systemPrompt: sysPrompt,
    });
    return buildApiMessages(sysPrompt, trimmed);
  }

  /**
   * 执行工具调用 batch，将结果写回 messages。
   * 返回 toolResult 列表供 chat() yield 给 UI。
   */
  async #executeToolCalls(
    toolCalls: ProviderToolCall[],
  ): Promise<{
    toolResults: Array<{ name: string; callId: string; result: ToolResult }>;
  }> {
    const executor = new ToolExecutor({
      registry: this.#toolRegistry,
      gate: this.#gate,
      baseCtx: {
        cwd: this.#cwd,
        signal: this.#abortController.signal,
      },
    });
    const { items } = await executor.executeBatch(toolCalls);

    // 写 tool 结果到 messages
    for (const item of items) {
      const call = toolCalls.find((c) => c.id === item.callId);
      const toolMsg: ChatMessage = {
        role: "tool",
        content: item.result.success
          ? typeof item.result.data === "string"
            ? item.result.data
            : JSON.stringify(item.result.data ?? "")
          : `错误：${item.result.error ?? "未知错误"}`,
        toolCallId: call?.id,
      };
      this.#messages.push(toolMsg);
    }

    return {
      toolResults: items.map((i) => ({
        name: i.name,
        callId: i.callId,
        result: i.result,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // system prompt
  // -------------------------------------------------------------------------

  #buildSystemPrompt(): string {
    const files = loadContextFiles({ cwd: this.#cwd });
    const projectInstructions = files.map((f) => ({
      path: f.relativePath,
      filename: f.filename,
      content: f.content,
    }));
    const opts: SystemPromptOptions = {
      model: this.#options.thinkingEnabled ? "deepseek-reasoner" : "deepseek-chat",
      maxToolRounds: this.#options.maxToolRounds,
      cwd: this.#cwd,
      projectContext: this.#options.projectContext,
      projectInstructions,
      availableSkills: this.#skillCatalog.length > 0 ? this.#skillCatalog : undefined,
    };
    return buildSystemPrompt(opts);
  }

  // -------------------------------------------------------------------------
  // cost
  // -------------------------------------------------------------------------

  #recordCost(usage: UsageInfo, model: string): void {
    try {
      this.#costTracker.record(usage, model);
    } catch {
      // 未知模型不抛错
    }
  }
}

// ---------------------------------------------------------------------------
// 文件内部辅助：包装 HardcodedBlacklistGate + InteractiveGate
//
// 原则：InteractiveGate 是默认权限门；HardcodedBlacklistGate 永远在 CompositeGate 最前。
// ---------------------------------------------------------------------------

/**
 * 在任何传入 gate 外层包一层 HardcodedBlacklistGate，保证“不可覆盖”的安全底线。
 *
 * @param inner — 已有的 InteractiveGate（或其他 Gate）
 */
function wrapWithHardcoded(inner: Gate): Gate {
  return new CompositeGate([new HardcodedBlacklistGate(), inner]);
}

/**
 * 从 CompositeGate 中取出 InteractiveGate（用于 setGatePrompt 动态修改 prompt）。
 *
 * 识别策略：
 *  - 顶层就是 InteractiveGate → 返回它
 *  - 顶层是 CompositeGate → 查找首个 InteractiveGate（可能与 HardcodedBlacklistGate 并列）
 *  - 都不是 → 返回 undefined
 *
 * 非交互 gate（如外部提供者）会被忽略，不会返回。
 */
function unwrapInteractive(g: Gate): InteractiveGate | undefined {
  if (g instanceof InteractiveGate) return g;
  if (g instanceof CompositeGate) {
    const found = g.find((c) => c instanceof InteractiveGate);
    if (found instanceof InteractiveGate) return found;
  }
  return undefined;
}
