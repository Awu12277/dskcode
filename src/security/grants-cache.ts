// ---------------------------------------------------------------------------
// 会话级 Grants 缓存
//
// 设计动机：
// 用户批准一次"git commit"后，同一会话内继续调"git commit"不该再问一次。
// 本模块用 (toolName, argsHash) 二元组为 key 缓存"已批准"。
//
// 借鉴 Zed 的 `thread.rs::sandbox_grants`：
//   - session 内不重复问
//   - 进程退出即失效（不持久化）
//   - 通过 argsHash 区分"看起来一样"的调用
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/**
 * 工具调用的"参数指纹"——同一指纹视为同一调用。
 *
 * 实现：JSON 规范化 + SHA-256（取前 16 hex）。
 */
export function hashArgs(args: unknown): string {
  // 把 args 转成规范化字符串（key 排序、去掉 undefined）
  const normalized = stableStringify(args);
  const h = createHash("sha256");
  h.update(normalized);
  return h.digest("hex").slice(0, 16);
}

/**
 * 把任意值序列化为 key 排序后的 JSON 字符串。
 *
 * 不依赖 key 插入顺序；undefined 字段被丢弃。
 */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return ""; // undefined 字段被丢掉
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `"[function]"`;
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ":" + stableStringify(v));
    }
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(value);
}

/**
 * GrantsCache — 同 thread 内的"已批准"集合。
 *
 * 用法：
 *   const grants = new GrantsCache();
 *   if (grants.has("bash", argsHash)) return true; // 直接放行
 *   const ok = await promptUser(...);
 *   if (ok) grants.add("bash", argsHash);
 *
 * 不持久化：进程退出即失效。
 */
export class GrantsCache {
  /** key = `${toolName}:${argsHash}`，value 任意（占位用 true） */
  readonly #store = new Map<string, true>();

  /**
   * 记录一次"已批准"。
   *
   * @param toolName — 工具名
   * @param argsHash — 参数指纹（用 hashArgs() 生成）
   */
  add(toolName: string, argsHash: string): void {
    this.#store.set(this.#key(toolName, argsHash), true);
  }

  /**
   * 查询某次调用是否已被批准。
   *
   * @returns true 表示已批准（可直接放行）；false 表示未批准或之前拒绝
   */
  has(toolName: string, argsHash: string): boolean {
    return this.#store.has(this.#key(toolName, argsHash));
  }

  /**
   * 删除一条 grant（如用户撤销授权）。
   *
   * @returns 是否真的删了一条
   */
  revoke(toolName: string, argsHash: string): boolean {
    return this.#store.delete(this.#key(toolName, argsHash));
  }

  /**
   * 用自定义 key 记录一次"已批准"（v0.8+ 用于 InteractiveGate grantKeyFor 拓展）。
   *
   * 与 add(toolName, argsHash) 的区别：key 完全由调用方决定，
   * 不再被「${toolName}:${argsHash}」拼接格式限制。允许实现：
   * - 「同文件路径跨工具共享 grant」（${toolName}:${path}）
   * - 「完全自定义的 grant 粒度」（如 git push origin main → origin/main）
   *
   * @param key — 调用方拼接的 grant key（不能为空）
   */
  addByKey(key: string): void {
    if (!key) return;
    this.#store.set(key, true);
  }

  /**
   * 用自定义 key 查询 grant 是否命中（v0.8+ 用于 InteractiveGate grantKeyFor 拓展）。
   *
   * @param key — 调用方拼接的 grant key
   * @returns true 表示已批准（可直接放行）
   */
  hasByKey(key: string): boolean {
    if (!key) return false;
    return this.#store.has(key);
  }

  /**
   * 清空所有 grants（如切换 mode / 加载新会话）。
   */
  clear(): void {
    this.#store.clear();
  }

  /**
   * 当前已批准条数。
   */
  get size(): number {
    return this.#store.size;
  }

  #key(toolName: string, argsHash: string): string {
    return `${toolName}:${argsHash}`;
  }
}
