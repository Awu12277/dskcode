// ---------------------------------------------------------------------------
// 工具调用参数解析器 — 流式 JSON 容错 + 缓存分片
//
// 设计动机：DeepSeek 等流式 LLM 在 tool_calls.arguments 字段是逐 token 拼出来的。
// 直接 JSON.parse 会在半截状态下抛错，导致整次工具调用失败。
// 这里借鉴 Zed 的 parse_tool_arguments + fix_streamed_json，给出三态结果：
//   - ok=true:           解析成功（含自动修复 escape 的情况）
//   - ok=false,PARTIAL:  半截 JSON，等下一批分片
//   - ok=false,INVALID:  真的损坏，把原文交给 LLM 自我修正
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

/**
 * 工具调用解析结果（Tagged Union）。
 *
 * - `{ ok: true, args, fixed }` 解析成功，`fixed` 是修复后的字符串（便于日志/调试）
 * - `{ ok: false, reason: "PARTIAL", partial, hint }` 流式分片未收全，等下一批
 * - `{ ok: false, reason: "INVALID_JSON", raw, error }` 真的解析失败
 */
export type ParseToolCallResult =
  | { ok: true; args: unknown; /** 修复后的原始字符串 */ fixed: string }
  | { ok: false; reason: "PARTIAL"; partial: string; hint: string }
  | { ok: false; reason: "INVALID_JSON"; raw: string; error: string };

/**
 * 解析工具调用参数 JSON 字符串。
 *
 * 设计原则：
 * 1. 空字符串 → ok=true, args={}（Zed 同款，避免 LLM 偶发输出空参数时报错）
 * 2. 半截 JSON → ok=false, reason=PARTIAL（流式拼接中，等下一批）
 * 3. 不完整 escape → 修复后重试（partial_json_fixer 的核心场景）
 * 4. 完全无法修复 → ok=false, reason=INVALID_JSON，携带原文供 LLM 诊断
 *
 * @param raw — DeepSeek 流式累积的 arguments 字符串
 * @returns ParseToolCallResult（不抛错，所有错误都收敛为返回对象）
 *
 * @pure 不修改入参
 */
export function parseToolCallArgs(raw: string | undefined | null): ParseToolCallResult {
  if (raw === "" || raw === undefined || raw === null) {
    return { ok: true, args: {}, fixed: "" };
  }

  // 1. 尝试直接解析（Zed parse_tool_arguments 行为）
  try {
    const args = JSON.parse(raw);
    return { ok: true, args, fixed: raw };
  } catch (firstErr) {
    // 2. 修复流式未闭合 escape 后重试
    const fixed = fixStreamedJson(raw);
    try {
      const args = JSON.parse(fixed);
      return { ok: true, args, fixed };
    } catch (secondErr) {
      // 3. 区分"半截" vs "真的错误"
      const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      if (isLikelyPartialJson(firstMsg, raw)) {
        return {
          ok: false,
          reason: "PARTIAL",
          partial: raw,
          hint: "参数 JSON 尚未收全，流式拼接中；可能是网络/心跳导致半截",
        };
      }
      return {
        ok: false,
        reason: "INVALID_JSON",
        raw,
        error: firstMsg,
      };
    }
  }
}

/**
 * 修复流式分片中"未闭合的 escape"问题。
 * 借鉴 Zed 的 strip_trailing_incomplete_escape + partial_json_fixer。
 *
 * 处理步骤：
 * 1. 去除末尾未配对的反斜杠（Zed strip_trailing_incomplete_escape）
 * 2. 用栈配对所有开括号，补齐缺失的右半边（partial_json_fixer 思路）
 * 3. 如果字符串未闭合，补一个 `"` 收尾
 *
 * @param partial — 原始（可能未收全）的 JSON 字符串
 * @returns 修复后的 JSON 字符串（仍可能解析失败，但已尽力收敛）
 *
 * @pure 不修改入参
 */
export function fixStreamedJson(partial: string): string {
  // 1. 去除末尾未配对的反斜杠（Zed strip_trailing_incomplete_escape）
  let end = partial.length;
  let backslashes = 0;
  for (let i = partial.length - 1; i >= 0; i--) {
    if (partial[i] === "\\") backslashes++;
    else break;
  }
  if (backslashes % 2 === 1) end--;

  let json = partial.slice(0, end);

  // 2. 配对所有开括号（partial_json_fixer 思路：补齐右半边）
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  // 补齐未闭合的字符串
  if (inString) json += '"';
  // 补齐未闭合的括号
  while (stack.length > 0) json += stack.pop();

  return json;
}

/**
 * 判断 JSON 解析错误是否是"流式分片导致的半截 JSON"。
 *
 * 启发式：常见半截错误消息 + 极短内容更可能是刚开始拼接。
 *
 * @param errMsg — JSON.parse 抛出的错误消息
 * @param raw — 原始字符串
 * @returns true 表示多半是流式分片尚未收全
 *
 * @pure
 */
function isLikelyPartialJson(errMsg: string, raw: string): boolean {
  // 常见半截错误：Unexpected end of JSON input / Unterminated string
  if (errMsg.includes("Unexpected end of JSON")) return true;
  if (errMsg.includes("Unterminated string")) return true;
  // 长度 < 5 也多半是刚开始
  if (raw.length < 5) return true;
  return false;
}
