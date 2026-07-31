// ---------------------------------------------------------------------------
// 硬编码黑名单 Gate — 不可被用户配置覆盖的安全底线
//
// 行为：
// - 仅对 `bash` 工具生效（其他工具不查黑名单）
// - 命中即拒绝：返回 false（Gate.check 返回 false 表示"不放行"）
// - 错误信息写进 console.error 让用户在终端能看到
//
// 借鉴 Zed 的 `tool_permissions.rs::check_hardcoded_security_rules`。
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import type { Gate, ToolDenial } from "../tool/types.js";
import { matchesHardcodedBlacklist } from "./blacklist.js";

/** 硬编码拦截的错误码（与 bash 工具现有错误码风格一致） */
export const BLACKLIST_DENIED_ERROR = "BLACKLIST_DENIED";

/** 给用户看的拒绝消息 */
export const BLACKLIST_DENIED_MESSAGE =
  "🚫 该命令命中硬编码安全规则（灾难性操作，不可被任何配置覆盖）：\n" +
  "  - 永远不允许：rm -rf /、rm -rf ~、rm -rf $HOME、rm -rf .、rm -rf ..\n" +
  "  - 永远不允许：mkfs / dd of=/dev/* / chmod -R 777 /\n" +
  "  - 永远不允许：curl|sh、wget|bash（远程脚本直跑）\n" +
  "  - 永远不允许：git push --force 到 main / master\n\n" +
  "如确认是合法操作，请换种等效但安全的写法。";

/**
 * 硬编码黑名单 Gate：仅检查 bash 工具的命令是否命中灾难模式。
 *
 * 用法：
 *   const gate = new HardcodedBlacklistGate();
 *   if (!(await gate.check("bash", { command: "rm -rf /" }))) { ... }
 *
 * 检查策略：
 * - 仅对工具名 === "bash" 生效
 * - 其他工具一律返回 true（交给上层 Gate / 规则引擎处理）
 */
export class HardcodedBlacklistGate implements Gate {
  /** 上次 check() 返回 false 时的拒绝详情（UI / ToolExecutor 消费） */
  #lastDenial: ToolDenial | undefined = undefined;

  /**
   * 检查工具调用是否被硬编码规则拦截。
   *
   * @param toolName — 工具名
   * @param args — 工具参数
   * @returns true 表示放行；false 表示被硬编码规则拒绝
   *
   * @pure 不修改任何外部状态；不做 IO（错误消息输出由调用方决定）
   */
  async check(toolName: string, args: unknown): Promise<boolean> {
    // 仅 bash 工具需要黑名单检查
    if (toolName !== "bash") {
      this.#lastDenial = undefined;
      return true;
    }

    // 提取命令字符串
    if (typeof args !== "object" || args === null) {
      this.#lastDenial = undefined;
      return true;
    }
    const cmd = (args as Record<string, unknown>)["command"];
    if (typeof cmd !== "string") {
      this.#lastDenial = undefined;
      return true;
    }

    if (matchesHardcodedBlacklist(cmd)) {
      this.#lastDenial = {
        source: "hardcoded_blacklist",
        reason: `命令命中硬编码灾难模式：` + cmd,
        hint: "请换种等效但安全的写法。该规则不可被配置覆盖。",
      };
      return false;
    }

    this.#lastDenial = undefined;
    return true;
  }

  /** 上次拒绝详情（仅当最近一次 check() 返回 false 时有意义） */
  get lastDenial(): ToolDenial | undefined {
    return this.#lastDenial;
  }
}
