// ---------------------------------------------------------------------------
// InteractiveGate — 集成规则引擎 + grants 缓存 + 询问 prompt 的 Gate
//
// 决策流程（与 roadmap-vs-zed.md 一致）：
//   1. 规则引擎 evaluate() → allow / deny / confirm / null
//   2. allow → true
//   3. deny  → false
//   4. confirm 决策 → 查 grants 缓存：
//      - 已批 → true
//      - 未批 → 询问用户（y/n/a）：
//        - y → true
//        - n → false
//        - a → 加 grants + true
//   5. evaluate 返回 null（无规则）→ 走默认策略（默认 confirm，最安全）
//
// "confirm 决策"包含两种来源：
//   a. ruleAction === "confirm"（命中 confirm 规则）
//   b. ruleAction === null && defaultDecision === "confirm"（无规则 + 默认安全策略）
// 两者都查 grants 缓存（见 check 中 effectiveConfirm 的定义）。
//
// 注意：本 Gate **不**查硬编码黑名单——硬编码检查由 `HardcodedBlacklistGate`
// 在更上层（bash 工具或 ToolExecutor 链）执行，避免被用户配置覆盖。
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import type { Gate, ToolDenial } from "../tool/types.js";
import {
  PermissionEngine,
  extractCommand,
  type EvalContext,
  type PermissionRule,
} from "./permissions.js";
import { GrantsCache, hashArgs } from "./grants-cache.js";

/** 询问回调返回值：用户对一次确认的响应 */
export type PromptResponse = "yes" | "no" | "always";

/**
 * InteractiveGate 的询问回调。
 *
 * 由调用方注入（CLI 端用 ink 弹窗，测试端用 mock 函数）。
 *
 * @param ctx — 询问上下文（工具名 / 参数 / 决策原因）
 * @returns "yes"（仅本次放行） / "no"（拒绝） / "always"（放行且加 grants）
 */
export type PromptFn = (ctx: PromptContext) => Promise<PromptResponse> | PromptResponse;

/** 询问回调的入参 */
export interface PromptContext {
  /** 工具名 */
  toolName: string;
  /** 工具参数（原始） */
  args: unknown;
  /** 触发原因（规则的 reason / 默认 "无规则命中，需手动确认"） */
  reason: string;
  /** 命中的规则（如有） */
  ruleAction?: "allow" | "deny" | "confirm";
}

/** InteractiveGate 构造选项 */
export interface InteractiveGateOptions {
  /** 规则引擎；不传则创建空引擎（所有决策走默认 confirm） */
  engine?: PermissionEngine;
  /** grants 缓存；不传则创建新实例（仅本次会话内有效） */
  grants?: GrantsCache;
  /** 询问回调；不传则默认 confirm 决策走拒绝（fail-safe） */
  prompt?: PromptFn;
  /** 无规则命中时的默认行为（默认 "confirm"，最保守） */
  defaultDecision?: "allow" | "deny" | "confirm";
  /**
   * grant 缓存 key 的派生函数（可选）。
   *
   * 用途：把「同一工具同一目标但 argsHash 不同」的多次调用归并为一条 grant。
   * 默认行为（不传时）：args 含 path-like 字段 → 用 `${toolName}:${path}` 作 key；
   * 否则 → 用 `${toolName}:${argsHash}` 作 key（保持原有 argsHash 行为）。
   *
   * 为什么默认按 path grant：
   * - 按 path grant（用户语义：「这个文件以后别再问」）。
   * - multi_edit / edit_file 的 args 包含 oldText/newText/edits 数组，
   *   每次模型生成的内容都不同，argsHash 永远不一样，"always" 形同虚设。
   * - bash / fetch / glob 等命令型工具 args 无 path 字段，回退到 argsHash，
   *   保持"同一命令不再问"的语义。
   *
   * 进阶：调用方可传自定义函数，按业务做更细粒度控制（例如把 bash 的
   * `git push origin main` 拆成「origin/main push 永远放行」）。
   */
  grantKeyFor?: (toolName: string, args: unknown) => string;
  /** 可选：日志记录器（测试用） */
  onDecision?: (info: {
    toolName: string;
    argsHash: string;
    ruleAction: "allow" | "deny" | "confirm" | null;
    finalAction: "allow" | "deny";
    via: "rule" | "grant" | "prompt" | "default";
  }) => void;
}

/**
 * InteractiveGate — 完整权限决策器。
 *
 * 集成 PermissionEngine + GrantsCache + 询问回调，
 * 实现"规则命中走规则；confirm 命中查 grants；都没命中询问用户"的链式决策。
 *
 * 用法：
 *   const gate = new InteractiveGate({
 *     engine: new PermissionEngine(rules),
 *     prompt: myPromptFn,
 *   });
 *   if (!(await gate.check("bash", { command: "git push" }))) {
 *     // 被拒绝
 *   }
 */
export class InteractiveGate implements Gate {
  readonly #engine: PermissionEngine;
  readonly #grants: GrantsCache;
  #prompt: PromptFn;
  readonly #defaultDecision: "allow" | "deny" | "confirm";
  readonly #grantKeyFor: (toolName: string, args: unknown) => string;
  readonly #onDecision?: InteractiveGateOptions["onDecision"];
  /** 上次 check() 返回 false 时的拒绝详情 */
  #lastDenial: ToolDenial | undefined = undefined;

  constructor(opts: InteractiveGateOptions = {}) {
    this.#engine = opts.engine ?? new PermissionEngine([]);
    this.#grants = opts.grants ?? new GrantsCache();
    // fail-loud：未传询问回调时需明确知道（避免默默拒绝所有 confirm 决策）
    // 选项：
    // - 传 prompt → 使用调用方提供的询问逻辑（CLI 端接 ink 弹窗）
    // - 不传 prompt → 用一个默认的 "auto-deny" 提示，提示调用方需要接 UI
    this.#prompt = opts.prompt ?? defaultAutoDenyPrompt;
    this.#defaultDecision = opts.defaultDecision ?? "confirm";
    this.#grantKeyFor = opts.grantKeyFor ?? defaultGrantKeyFor;
    this.#onDecision = opts.onDecision;
  }

  /**
   * 当前 grants 缓存（只读访问，给测试 / UI 用）
   *
   * 复用基类的 grants getter 字段（见 #grants）；不重新定义。
   */

  /** 当前 grants 缓存（只读访问，给测试 / UI 用） */
  get grants(): GrantsCache {
    return this.#grants;
  }

  /** 当前规则引擎（只读访问） */
  get engine(): PermissionEngine {
    return this.#engine;
  }

  /**
   * 动态替换询问回调。供会话层使用（如 ChatApp 在启动 streaming 时补上 UI prompt）。
   *
   * 行为：替换后，后续所有走 prompt 的决策都走新回调。
   * 顺序：可以多次调用；最后一次生效。
   */
  setPrompt(prompt: PromptFn): void {
    this.#prompt = prompt;
  }

  /**
   * 检查工具调用是否放行。
   *
   * 决策流程见文件顶部注释。
   *
   * @param toolName — 工具名
   * @param args — 工具参数（任意）
   * @returns true 表示放行；false 表示拒绝
   */
  async check(toolName: string, args: unknown): Promise<boolean> {
    const argsHash = hashArgs(args);
    const ctx: EvalContext = {
      args,
      targetPath: extractTargetPath(args),
    };

    // 1. 规则引擎评估
    const ruleAction = this.#engine.evaluate(toolName, ctx);

    if (ruleAction === "allow") {
      this.#lastDenial = undefined;
      this.#log(toolName, argsHash, "allow", "allow", "rule");
      return true;
    }

    if (ruleAction === "deny") {
      this.#lastDenial = {
        source: "permission_rule",
        reason: buildPromptReason(toolName, "deny", this.#engine, ctx),
        hint: "可在 ~/.dskcode/permissions.json 或 .dskcode/permissions.json 中调整或删除该 deny 规则。",
      };
      this.#log(toolName, argsHash, "deny", "deny", "rule");
      return false;
    }

    // ruleAction === "confirm" 或 null（无规则命中 → 默认走 confirm）
    // 2. confirm 决策 → 查 grants 缓存
    // 范围：「confirm 规则命中」与「无规则但 defaultDecision=confirm」两种来源。
    // 只覆盖 ruleAction === "confirm" 会让用户场景（permissionsConfig 为空）下
    // 「always」加的 grant 永远不被查询，每次重新弹窗（bugfix-10）。
    const effectiveConfirm =
      ruleAction === "confirm" ||
      (ruleAction === null && this.#defaultDecision === "confirm");
    const grantKey = this.#grantKeyFor(toolName, args);
    if (effectiveConfirm && grantKey && this.#grants.hasByKey(grantKey)) {
      this.#lastDenial = undefined;
      this.#log(toolName, argsHash, ruleAction, "allow", "grant");
      return true;
    }

    // 3. 询问用户（confirm 规则 或 默认行为）
    const finalAction = ruleAction ?? this.#defaultDecision;

    // 如果默认行为是 allow 且无规则命中，直接放行（不再问）
    if (finalAction === "allow" && ruleAction === null) {
      this.#lastDenial = undefined;
      this.#log(toolName, argsHash, null, "allow", "default");
      return true;
    }

    // 如果默认行为是 deny 且无规则命中，直接拒绝（不再问）
    if (finalAction === "deny" && ruleAction === null) {
      this.#lastDenial = {
        source: "permission_rule",
        reason: `默认决策是 deny（未匹配任何规则的 ${toolName} 调用）`,
        hint: "可在 ~/.dskcode/permissions.json 加一条 allow 规则取消拒绝。",
      };
      this.#log(toolName, argsHash, null, "deny", "default");
      return false;
    }

    // 走询问
    const promptReason = buildPromptReason(toolName, ruleAction, this.#engine, ctx);
    const response = await this.#prompt({
      toolName,
      args,
      reason: promptReason,
      ruleAction: ruleAction ?? undefined,
    });

    if (response === "no") {
      this.#lastDenial = {
        source: "user_prompt",
        reason: `用户手动拒绝：${promptReason}`,
      };
      this.#log(toolName, argsHash, ruleAction, "deny", "prompt");
      return false;
    }

    if (response === "always" && grantKey) {
      this.#grants.addByKey(grantKey);
    }

    this.#lastDenial = undefined;
    this.#log(toolName, argsHash, ruleAction, "allow", "prompt");
    return true;
  }

  /** 上次 check() 返回 false 时的拒绝详情 */
  get lastDenial(): ToolDenial | undefined {
    return this.#lastDenial;
  }

  #log(
    toolName: string,
    argsHash: string,
    ruleAction: "allow" | "deny" | "confirm" | null,
    finalAction: "allow" | "deny",
    via: "rule" | "grant" | "prompt" | "default",
  ): void {
    this.#onDecision?.({ toolName, argsHash, ruleAction, finalAction, via });
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 默认询问回调：未传 prompt 时的 fail-loud 默认。
 *
 * 行为：打印警告到 console，返回 "no"（拒绝本次调用）。
 *
 * 为什么这样设计：
 * - 未传 prompt → 调用方可能忘了接 UI（如 CLI 端未接 ink 弹窗）
 * - 默默拒绝会让用户体验糟（所有 confirm 决策静默被拒）
 * - 警告一行让调用方意识到需要接 prompt
 */
const defaultAutoDenyPrompt: PromptFn = (ctx) => {
  console.warn(
    `[InteractiveGate] 未传询问回调，默认拒绝确认请求。\n` +
      `  工具: ${ctx.toolName}\n` +
      `  原因: ${ctx.reason}\n` +
      `  如需交互式审批，请在创建 InteractiveGate 时传 prompt 选项。`,
  );
  return "no";
};

/**
 * 从工具参数中提取"目标路径"。
 *
 * 当前规则：优先 `args.path`（大多数文件类工具都用此字段）。
 * 后续可按工具名分支（如 edit_file 还可能是 `args.file_path`）。
 */
function extractTargetPath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const obj = args as Record<string, unknown>;
  const candidates = ["path", "file_path", "filePath", "filepath", "target"];
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * 默认 grant key 派生函数：按“用户意图”粒度打 cache key。
 *
 * 优先级：
 *  1. 工具名名单中的“命令型”工具：以`args.command` / `args.url` / `args.query` 为 key。
 *     这样 grants 不受无关字段变化影响（例如 `bash` 的 `timeout` 不传 vs 传不同值），
 *     与用户直觉——“这个命令以后别再问”——一致。
 *  2. 写工具（path-like 字段）：以该路径为 key。
 *  3. 其他：略过头，同参数 hashArgs。
 *
 * 例：
 *   defaultGrantKeyFor("bash", { command: "ls", timeout: 5000 })
 *     → "bash:ls"      ✓ 下次同一命令不传 timeout 也能命中
 *   defaultGrantKeyFor("bash", { command: "rm -rf /" })
 *     → "bash:rm -rf /"
 *   defaultGrantKeyFor("edit_file", { path: "src/main.ts", ... })
 *     → "edit_file:src/main.ts"
 *   defaultGrantKeyFor("custom_tool", { foo: 1 })
 *     → "custom_tool:<sha256 args>"
 *
 * 注意：返回值为空字符串时表示“不应缓存”（调用方会在 add 时跳过）。
 *
 * 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
 */

/** “命令型”工具：按 args.command 拼 grant key，不受其他字段干扰。 */
const COMMAND_TOOLS = new Set(["bash", "fetch", "glob"]);

function extractCommandField(toolName: string, args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const obj = args as Record<string, unknown>;
  switch (toolName) {
    case "bash":
      return typeof obj["command"] === "string" ? obj["command"] : undefined;
    case "fetch":
      return typeof obj["url"] === "string" ? obj["url"] : undefined;
    case "glob":
      return typeof obj["query"] === "string"
        ? obj["query"]
        : typeof obj["pattern"] === "string"
          ? obj["pattern"]
          : undefined;
    default:
      return undefined;
  }
}

function defaultGrantKeyFor(toolName: string, args: unknown): string {
  // 1. 命令型工具：按 args.command / url / query 拼 key
  if (COMMAND_TOOLS.has(toolName)) {
    const cmd = extractCommandField(toolName, args);
    if (cmd && cmd.length > 0) return `${toolName}:${cmd}`;
  }
  // 2. 写工具：按 path
  const path = extractTargetPath(args);
  if (path) return `${toolName}:${path}`;
  // 3. 暴露通用 hash 路径
  return `${toolName}:${hashArgs(args)}`;
}

/**
 * 构造"为什么需要确认"的解释文本。
 *
 * 按优先级找首条匹配的规则：
 * 1. ruleAction === "confirm" 且引擎返回的同一条规则 → 它的 reason / 工具名
 * 2. ruleAction === "confirm" 但匹配逻辑在引擎里 → 描述完整规则
 * 3. 其他场景 → 默认说明
 */
function buildPromptReason(
  toolName: string,
  ruleAction: "allow" | "deny" | "confirm" | null,
  engine: PermissionEngine,
  ctx: EvalContext,
): string {
  // 1. 首条为该工具声明的 confirm 规则（不重新求值——直接交原因字段）
  //    这是 B-1 fix 的核心：不管是否 pathGlob，confirm 规则都会返原因
  if (ruleAction === "confirm") {
    const matchedRule = engine.rules.find(
      (r) => r.tool === toolName && r.action === "confirm",
    );
    if (matchedRule) {
      if (matchedRule.reason) return matchedRule.reason;
      // 描述一下规则的 match（调试有用）
      const matchDesc = describeMatch(matchedRule.match);
      return `规则命中：${toolName}${matchDesc ? `（${matchDesc}）` : ""}。本次调用需要确认是否放行。`;
    }
    return `工具 \`${toolName}\` 被规则标记为需要确认，是否放行？`;
  }

  // 2. 其他场景
  return `工具 \`${toolName}\` 没有匹配的规则，默认需要你确认是否放行。`;
}

/** 把 RuleMatch 转成可读描述（供错误消息 / UI 展示） */
function describeMatch(match: PermissionRule["match"]): string {
  if (!match) return "";
  const parts: string[] = [];
  if (match.commandRegex) parts.push(`命令正则=${match.commandRegex}`);
  if (match.pathGlob) parts.push(`路径 glob=${match.pathGlob}`);
  if (match.argValueRegex) {
    const entries = Object.entries(match.argValueRegex)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    parts.push(`参数规则=${entries}`);
  }
  return parts.join("; ");
}
