// ---------------------------------------------------------------------------
// ToolExecutor — 纯执行层：解析参数、查工具、走权限门、跑工具、捕异常
//
// 设计原则：
// - 不持有 Session / messages 状态，只依赖注入的 registry / gate / ctx
// - 输入：一批 ProviderToolCall
// - 输出：执行结果项（含 result）+ 风暴检测用的 records
// - 异常安全：单个工具的异常不会中断其他工具
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import type { ProviderToolCall } from "../provider/index.js";
import type { ToolRegistry } from "../tool/registry.js";
import type {
  ToolCallRecord,
  ToolContext,
  ToolResult,
  Gate,
  AnyAgentTool,
} from "../tool/types.js";
import { isReadOnly } from "../tool/types.js";
import { parseToolCallArgs } from "./tool-call-parser.js";
import { validateArgs, type ValidationIssue } from "../tool/schema-validator.js";

/**
 * 单个工具执行的产出（喂回 Session 协调层）。
 *
 * @field name — 工具名（与 ProviderToolCall.name 一致）
 * @field callId — LLM 侧 call id，用于 messages.push 时回填 toolCallId
 * @field result — 工具执行结果（含 success / data / error / diff）
 */
export interface ToolExecutionItem {
  name: string;
  callId: string;
  result: ToolResult;
}

/**
 * 一次批量执行的完整产出。
 *
 * @field items — 所有工具执行结果（成功 + 失败）
 * @field records — 仅失败的 record（喂给 StormDetector 判断是否中断）
 */
export interface ToolExecutionResult {
  items: ToolExecutionItem[];
  /** 仅失败的 record（用于风暴检测） */
  records: ToolCallRecord[];
}

/**
 * ToolExecutor 的注入依赖。
 *
 * @field registry — 工具注册表（用于按名查找）
 * @field gate — 权限门（决定是否放行某个工具调用）
 * @field baseCtx — 工具执行的上下文（cwd / signal / writeRoots）
 * @field maxParallel — 并行执行的最大同时执行数（默认 8）
 */
export interface ToolExecutorDeps {
  registry: ToolRegistry;
  gate: Gate;
  baseCtx: Omit<ToolContext, "signal"> & { signal?: AbortSignal };
  /** 并行执行的最大同时执行数（默认 8） */
  maxParallel?: number;
}

/**
 * ToolExecutor：把"工具调用 batch"映射为"执行结果 + 失败记录"。
 *
 * 行为：
 * - 若全部为只读工具（Read 类）且数量 > 1：分批并行（每批最多 maxParallel 个）
 * - 其他情况：串行执行（保证有副作用的工具按 LLM 给出的顺序执行）
 *
 * 异常路径：工具不存在 / 权限门拒绝 / 执行抛错，都会被捕获并包装成失败 ToolResult，
 *          不会让一个工具的错误中断其他工具的执行。
 */
export class ToolExecutor {
  /** 工具注册表（只读引用） */
  readonly #registry: ToolRegistry;
  /** 权限门（只读引用） */
  readonly #gate: Gate;
  /** 工具执行上下文（每次执行都共用） */
  readonly #baseCtx: ToolContext;
  /** 并行执行的最大同时执行数（默认 8） */
  readonly #maxParallel: number;

  /**
   * 构造一个 ToolExecutor。
   *
   * @param deps — 注入依赖（registry / gate / baseCtx / maxParallel）
   * @pure 仅保存引用，不调用任何外部 IO
   */
  constructor(deps: ToolExecutorDeps) {
    this.#registry = deps.registry;
    this.#gate = deps.gate;
    this.#baseCtx = {
      cwd: deps.baseCtx.cwd,
      signal: deps.baseCtx.signal,
      writeRoots: deps.baseCtx.writeRoots,
      ...(deps.baseCtx.timeout !== undefined ? { timeout: deps.baseCtx.timeout } : {}),
    };
    this.#maxParallel = deps.maxParallel ?? 8;
  }

  /**
   * 执行一批工具调用。
   *
   * 自动选择并行 / 串行：
   * - 全部为只读工具 且 calls.length > 1：分批并行（每批最多 #maxParallel 个）
   * - 其他：严格串行
   *
   * @param calls — LLM 决定的本轮工具调用列表
   * @returns items（全部结果）+ records（仅失败项，用于风暴检测）
   *
   * @sideEffect 调用 registry / gate / tool.execute；不修改 Session.messages
   */
  async executeBatch(calls: ProviderToolCall[]): Promise<ToolExecutionResult> {
    if (calls.length === 0) return { items: [], records: [] };

    if (this.#allReadOnly(calls) && calls.length > 1) {
      return this.#executeParallel(calls);
    }
    return this.#executeSequential(calls);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 判定这一批调用是否全部为只读工具。
   * 工具未找到时按"只读"处理（不会因为没注册就拒绝并行）。
   *
   * @pure 不修改任何状态
   */
  #allReadOnly(calls: ProviderToolCall[]): boolean {
    return calls.every((tc) => {
      const tool = this.#registry.get(tc.name);
      return tool ? isReadOnly(tool.kind) : true;
    });
  }

  /**
   * 并行执行：按 #maxParallel 分批，每批内 Promise.all。
   * 用于"全部只读 + 多于 1 个"的场景。
   *
   * @param calls — 全部只读的工具调用
   * @returns items + records
   *
   * @sideEffect 调用 tool.execute
   */
  async #executeParallel(calls: ProviderToolCall[]): Promise<ToolExecutionResult> {
    const items: ToolExecutionItem[] = [];
    const records: ToolCallRecord[] = [];

    for (let i = 0; i < calls.length; i += this.#maxParallel) {
      const batch = calls.slice(i, i + this.#maxParallel);
      const results = await Promise.all(batch.map((tc) => this.#executeOne(tc)));
      for (const r of results) {
        items.push(r.item);
        if (!r.record.success) records.push(r.record);
      }
    }
    return { items, records };
  }

  /**
   * 串行执行：按 calls 顺序逐个执行。
   * 用于含写工具的场景（保证副作用顺序与 LLM 给出顺序一致）。
   *
   * @param calls — 工具调用列表
   * @returns items + records
   *
   * @sideEffect 按序调用 tool.execute
   */
  async #executeSequential(calls: ProviderToolCall[]): Promise<ToolExecutionResult> {
    const items: ToolExecutionItem[] = [];
    const records: ToolCallRecord[] = [];
    for (const tc of calls) {
      const r = await this.#executeOne(tc);
      items.push(r.item);
      if (!r.record.success) {
        records.push(r.record);
        // 用户拒绝（GATE_DENIED）时停止后续工具调用：
        // 避免模型用 multi_edit / write_file 等同类型工具"换个方式"重试。
        // 借鉴 Zed：deny 后整个 turn 立刻结束，剩下的 tool_call 不执行。
        if (
          r.record.error === "GATE_DENIED" &&
          r.item.result.denial?.source === "user_prompt"
        ) {
          break;
        }
      }
    }
    return { items, records };
  }

  /**
   * 执行单个工具调用，包含查找 / 参数解析 / 权限门 / 写工具 preview / 异常捕获。
   *
   * 失败映射：
   * - 工具不存在或被禁用 → `TOOL_NOT_FOUND`
   * - 权限门拒绝       → `GATE_DENIED`
   * - 工具 execute 抛错 → `EXECUTION_ERROR`
   *
   * @param tc — 单个工具调用（含 id / name / arguments 字符串）
   * @returns { item, record } — item 喂回 Session；record 用于风暴检测
   *
   * @sideEffect 调 tool.execute、可能调 tool.preview；不抛错给调用方
   */
  async #executeOne(
    tc: ProviderToolCall,
  ): Promise<{ item: ToolExecutionItem; record: ToolCallRecord }> {
    const toolName = tc.name;
    const timestamp = Date.now();
    const tool = this.#registry.get(toolName);
    if (!tool) {
      const errMsg = `工具 "${toolName}" 不存在或已被禁用`;
      return {
        item: {
          name: toolName,
          callId: tc.id,
          result: { success: false, data: errMsg, error: "TOOL_NOT_FOUND" },
        },
        record: { name: toolName, success: false, error: "TOOL_NOT_FOUND", timestamp },
      };
    }

    // 解析参数：arguments 是 JSON 字符串，使用容错 parser 处理流式分片场景。
    // - PARTIAL：流式尚未收全，本轮跳过（避免误执行）
    // - INVALID_JSON：真的解析失败，把原文回传 LLM 让它自我修正
    // - ok：拿到 args 继续走权限门 / preview / execute
    const parsed = parseToolCallArgs(tc.arguments ?? "");
    if (!parsed.ok) {
      if (parsed.reason === "PARTIAL") {
        const errMsg = `工具 "${toolName}" 参数尚未收全，本轮跳过（流式分片导致）：${parsed.hint}`;
        return {
          item: {
            name: toolName,
            callId: tc.id,
            result: { success: false, data: errMsg, error: "PARTIAL_JSON" },
          },
          record: { name: toolName, success: false, error: "PARTIAL_JSON", timestamp },
        };
      }
      // INVALID_JSON
      const errMsg = `工具 "${toolName}" 参数不是合法 JSON：${parsed.error}\n原文: ${parsed.raw.slice(0, 200)}`;
      return {
        item: {
          name: toolName,
          callId: tc.id,
          result: { success: false, data: errMsg, error: "INVALID_JSON" },
        },
        record: { name: toolName, success: false, error: "INVALID_JSON", timestamp },
      };
    }
    const toolArgs = parsed.args;

    // schema 校验（warn-only，不阻塞执行）
    // - 走 tool.parameters 的 JSONSchema 路径
    // - 失败时把 issues 拼接到 result.data 末尾，同步到 record.issues
    // - 不在 gate.check 之前拦截：让工具本身有机会自己给出更具体的错误
    let schemaIssues: ValidationIssue[] | undefined;
    if (tool.parameters) {
      const validation = validateArgs(toolArgs, tool.parameters);
      if (!validation.ok) {
        schemaIssues = validation.issues;
      }
    }

    // 只读工具短路 gate：ToolKind.Read 工具无副作用，不应被任何 Gate 拦截。
    // 这与「读默认放行」语义一致，并被提升为 ToolExecutor 层的硬约束，
    // 未来任何 Gate 实现都不用再考虑 Read 工具。
    if (!isReadOnly(tool.kind)) {
      const gateResult = await this.#gate.check(toolName, toolArgs);
      if (!gateResult) {
        const denial = this.#gate.lastDenial;
        // 给 LLM 看的消息要明确：用户主动拒绝，不要尝试其他方式。
        // 借鉴 Zed：直接 "Permission to run tool denied by user"，
        // 模型读完知道是用户决策，不是系统故障，不会瞎换工具重试。
        const errMsg = denial
          ? `Permission to run tool denied by user (${denial.reason})。请勿尝试用其他方式修改同一个文件或绕过此决定；如需继续，请先与用户确认。`
          : `Permission to run tool denied by user。请勿尝试用其他方式修改同一个文件或绕过此决定；如需继续，请先与用户确认。`;
        return {
          item: {
            name: toolName,
            callId: tc.id,
            result: {
              success: false,
              data: errMsg,
              error: "GATE_DENIED",
              ...(denial ? { denial } : {}),
            },
          },
          record: { name: toolName, success: false, error: "GATE_DENIED", timestamp },
        };
      }
    }

    // 写工具的 preview：用于在执行前预热 / 副作用预览（仅写工具支持）
    if (!isReadOnly(tool.kind)) {
      const maybePreview = (
        tool as { preview?: (args: unknown, ctx: ToolContext) => Promise<unknown> }
      ).preview;
      if (typeof maybePreview === "function") {
        try {
          await maybePreview(toolArgs, this.#baseCtx);
        } catch {
          /* ignore preview errors */
        }
      }
    }

    try {
      let result = await this.#invokeTool(tool, toolArgs);
      // 阶段 2：把 schema issues 拼接到 result.data 末尾（如有）
      if (schemaIssues && schemaIssues.length > 0) {
        const issuesText = schemaIssues.map((i) => `  - ${i.message}`).join("\n");
        const tag = result.success ? "[schema 警告]" : "[schema 问题]";
        result = {
          ...result,
          data: `${result.data}\n\n${tag} 参数不符合 schema：\n${issuesText}`,
          issues: schemaIssues,
        };
      }
      const record: ToolCallRecord = {
        name: toolName,
        success: result.success,
        error: result.error,
        timestamp,
        ...(schemaIssues ? { issues: schemaIssues } : {}),
      };
      return {
        item: { name: toolName, callId: tc.id, result },
        record,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const errorResult: ToolResult = {
        success: false,
        data: `工具 "${toolName}" 执行异常：${message}`,
        error: "EXECUTION_ERROR",
      };
      return {
        item: { name: toolName, callId: tc.id, result: errorResult },
        record: { name: toolName, success: false, error: "EXECUTION_ERROR", timestamp },
      };
    }
  }

  /**
   * 真正调 tool.execute 的薄包装（拆出来便于以后插入横切关注点，如重试 / 计时）。
   *
   * @param tool — 类型擦除后的工具
   * @param args — 解析后的参数（unknown）
   * @returns 工具的 ToolResult
   *
   * @sideEffect 调 tool.execute
   */
  async #invokeTool(tool: AnyAgentTool, args: unknown): Promise<ToolResult> {
    return tool.execute(args, this.#baseCtx);
  }
}
