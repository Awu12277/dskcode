// ---------------------------------------------------------------------------
// CompositeGate — 多个 Gate 的串行组合
//
// 设计动机：
// Session 启动时只有一个 `gate` 字段，但实际需要：
//   1. 先过硬编码黑名单（不可覆盖）
//   2. 再过用户配置的规则引擎 / InteractiveGate
//
// CompositeGate 把多个 Gate 按顺序串起来，前一个 deny 立即短路返回 false。
//
// 用法：
//   const gate = new CompositeGate([
//     new HardcodedBlacklistGate(),  // 第一关：硬编码
//     new InteractiveGate({ engine, prompt }), // 第二关：用户配置
//   ]);
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import type { Gate, ToolDenial } from "../tool/types.js";

/**
 * CompositeGate — 多 Gate 串行短路。
 *
 * 短路规则：
 * - 任一 Gate.check 返回 false → 立即返回 false（后续 Gate 不再调用）
 * - 全部 Gate.check 返回 true → 返回 true
 *
 * 顺序敏感：硬编码 Gate 应当放第一个。
 */
export class CompositeGate implements Gate {
  readonly #gates: ReadonlyArray<Gate>;

  constructor(gates: ReadonlyArray<Gate>) {
    this.#gates = gates;
  }

  /**
   * 串行检查所有 Gate，任一拒绝即短路。
   *
   * @param toolName — 工具名
   * @param args — 工具参数
   * @returns true 表示全部放行；false 表示任一 Gate 拒绝
   */
  async check(toolName: string, args: unknown): Promise<boolean> {
    for (const gate of this.#gates) {
      const ok = await gate.check(toolName, args);
      if (!ok) return false;
    }
    return true;
  }

  /**
   * 上次拒绝详情：转发首个 deny 子 gate 的 lastDenial。
   * 若所有子 gate 都没实现 lastDenial，返回 undefined。
   */
  get lastDenial(): ToolDenial | undefined {
    for (const gate of this.#gates) {
      const d = gate.lastDenial;
      if (d) return d;
    }
    return undefined;
  }

  /** 当前链中的 Gate 数量（给 UI 展示用） */
  get size(): number {
    return this.#gates.length;
  }

  /**
   * 查找首个满足 predicate 的子 gate。供上层“动态调整某类 gate”使用
   * （如 Session.setGatePrompt 在不重建整条链的前提下注入 prompt）。
   *
   * @param predicate — 子节点筛选函数
   * @returns 首个命中；都不命中返回 undefined
   */
  find(predicate: (g: Gate) => boolean): Gate | undefined {
    for (const g of this.#gates) {
      if (predicate(g)) return g;
    }
    return undefined;
  }
}
