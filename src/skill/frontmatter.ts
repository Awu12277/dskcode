// ---------------------------------------------------------------------------
// SKILL.md Frontmatter 解析
//
// 对齐 zed `crates/agent_skills/agent_skills.rs::extract_frontmatter` (L343-413)
// 的行为：
//   1. trim_start 后必须以 `---` 开头（否则 Missing opening delimiter）
//   2. 找所有"严格闭合的 `---` 行"：必须是 `---` + 行结束符（\n / \r\n / EOF），
//      不能是 `----` 或 `---xxx`
//   3. 对每个候选闭合点，用 yaml 库解析前缀，能成功反序列化成 SkillMetadata
//      即为真正闭合点
//   4. 解析失败时尝试下一个候选
//   5. 全部失败抛 "Invalid YAML frontmatter"
//
// 与 zed 的小差异：
//   - zed 用 serde_yaml_ng；ts-version 用 `yaml` (pure-JS YAML 1.2)
//   - 校验函数直接抛 Error（v0.7 不引入自定义错误类，调用方判断 message 即可）
// ---------------------------------------------------------------------------

import { parseAllDocuments } from "yaml";
import type { SkillLoadWarning } from "./types.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** name 字段最大长度（字节，非字符）。与 zed validate_name 对齐。 */
export const MAX_SKILL_NAME_LEN = 64;

/** description 字段最大长度（字节）。超长只警告，不拒绝。 */
export const MAX_SKILL_DESCRIPTION_LEN = 1024;

/** SKILL.md 文件最大字节数。超过直接拒绝（参考 zed load_skill_frontmatter L632-651）。 */
export const MAX_SKILL_FILE_SIZE = 100 * 1024;

/**
 * 注入 system prompt 时，目录中所有 (name + description) 的总字节预算。
 * zed 是 50KB；ts-version 上下文更紧，调小到 8KB。
 */
export const MAX_SKILL_DESCRIPTIONS_SIZE = 8 * 1024;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * Frontmatter 反序列化目标。
 *
 * 只声明我们关心的字段；YAML 里有额外字段会被静默忽略（yaml 库默认行为）。
 * `disable_model_invocation` 是 zed 引入的"屏蔽模型调用"开关。
 */
export interface SkillMetadata {
  name?: unknown;
  description?: unknown;
  disable_model_invocation?: unknown;
}

/** parseSkillFrontmatter 的成功结果 */
export interface ParsedFrontmatter {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  /** 解析得到的 loadWarnings（Phase 1：description_too_long） */
  loadWarnings: SkillLoadWarning[];
  /** SKILL.md 中 frontmatter 之后的正文 */
  body: string;
}

// ---------------------------------------------------------------------------
// 行匹配辅助
// ---------------------------------------------------------------------------

/**
 * 匹配严格闭合分隔符 `---` + 行结束符。
 *
 * 严格性：
 *   - 行首必须是 `---` 三连字符
 *   - 后面必须紧跟行结束符（\n、\r\n）或字符串结尾
 *   - 拒绝 `----`（四个连字符）、`---xxx`、`---` 后面跟非空白
 *
 * 允许 `---` 行内后面有行尾空白（trailing whitespace），因为编辑器经常
 * 顺手带空格保存。
 */
function findClosingDelimiters(text: string): number[] {
  const positions: number[] = [];
  const re = /^---[ \t]*(?:\r\n|\n|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    positions.push(m.index);
  }
  return positions;
}

/**
 * 找到第一个能成功解析成 SkillMetadata 的闭合点索引。
 *
 * @param afterOpening  跳过开头 `---` 行之后的字符串
 * @returns 在 `afterOpening` 中真正闭合点的索引；找不到返回 -1
 */
function resolveFrontmatterEnd(afterOpening: string): number {
  const closingPositions = findClosingDelimiters(afterOpening);
  for (const idx of closingPositions) {
    const candidate = afterOpening.slice(0, idx);
    // 用 parseAllDocuments 模拟 zed serde_yaml_ng 的多文档流行为：
    // `---` 在 yaml 里是文档分隔符，zed 靠 Deserializer 迭代 + SkillMetadata::deserialize
    // 决定哪个候选是真正的 frontmatter 闭点。这里我们看"第一个能反序列化为
    // SkillMetadata 的文档"。
    const docs = parseAllDocuments(candidate);
    for (const doc of docs) {
      if (doc.errors.length > 0) break;
      const js = doc.toJS();
      if (js === null || js === undefined) continue; // 空文档，跳过看下一个
      if (typeof js === "object" && !Array.isArray(js)) {
        return idx;
      }
      // 第一个文档是 scalar / array 等非法 frontmatter，
      // 中止本候选（后面的文档也是同一闭点之后的，不算）
      break;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 字段校验
// ---------------------------------------------------------------------------

/**
 * 校验 skill name 是否合法。
 *
 * 规则（与 zed `validate_name` 对齐）：
 *   - 非空字符串
 *   - 长度 <= MAX_SKILL_NAME_LEN（按 UTF-8 字节计）
 *   - 仅允许 [a-z0-9-]
 *   - 首尾字符不能是 `-`
 */
export function validateName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Skill name is empty");
  }
  const byteLen = Buffer.byteLength(name, "utf8");
  if (byteLen > MAX_SKILL_NAME_LEN) {
    throw new Error(
      `Skill name too long: ${String(byteLen)} bytes (max ${String(MAX_SKILL_NAME_LEN)})`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(
      `Skill name "${name}" contains invalid characters (allowed: a-z, 0-9, '-')`,
    );
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    throw new Error(`Skill name "${name}" must not start or end with '-'`);
  }
}

/**
 * 校验 / 预警 skill description。
 *
 * 规则：
 *   - 必须是字符串
 *   - trim 后必须非空
 *   - 字节数 > MAX_SKILL_DESCRIPTION_LEN 时只返回 loadWarnings（不抛）
 *
 * 返回：trim 后的 description；调用方把它和 warning 一起返回。
 */
export function extractDescription(value: unknown): {
  description: string;
  warning?: SkillLoadWarning;
} {
  if (typeof value !== "string") {
    throw new Error("Skill description is missing or not a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Skill description is empty");
  }
  const byteLen = Buffer.byteLength(trimmed, "utf8");
  if (byteLen > MAX_SKILL_DESCRIPTION_LEN) {
    return {
      description: trimmed,
      warning: {
        kind: "description_too_long",
        actualLen: byteLen,
        maxLen: MAX_SKILL_DESCRIPTION_LEN,
      },
    };
  }
  return { description: trimmed };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 解析 SKILL.md 完整内容，返回结构化 frontmatter + body。
 *
 * @param content SKILL.md 的完整文本
 * @returns ParsedFrontmatter
 * @throws Error 各种 frontmatter 错误
 */
export function parseSkillFrontmatter(content: string): ParsedFrontmatter {
  // 1. 文件大小短路（参考 zed load_skill_frontmatter L632-651）
  const byteLen = Buffer.byteLength(content, "utf8");
  if (byteLen > MAX_SKILL_FILE_SIZE) {
    throw new Error(
      `SKILL.md too large: ${String(byteLen)} bytes (max ${String(MAX_SKILL_FILE_SIZE)})`,
    );
  }

  // 2. 找到正文 + 闭分隔符的偏移
  const leading = content.length - content.trimStart().length;
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    throw new Error("Missing opening delimiter `---` in frontmatter");
  }
  const openingMatch = /^---[ \t]*(?:\r\n|\n)/.exec(trimmed);
  if (!openingMatch) {
    throw new Error("Missing opening delimiter `---` in frontmatter");
  }
  const openingLen = openingMatch[0].length;
  const afterOpening = trimmed.slice(openingLen);

  const closeIdx = resolveFrontmatterEnd(afterOpening);
  if (closeIdx < 0) {
    throw new Error("Invalid YAML frontmatter");
  }

  // 3. 切出 yaml 文本 + body
  const yamlText = afterOpening.slice(0, closeIdx);

  // body 起始 = leading + openingLen + closeIdx
  // 然后跳过闭分隔符 `---` 行本身
  const bodyStartInOriginal = leading + openingLen + closeIdx;
  const closeMatch = /^---[ \t]*(?:\r\n|\n|$)/.exec(content.slice(bodyStartInOriginal));
  const closeLen = closeMatch ? closeMatch[0].length : 0;
  const body = content.slice(bodyStartInOriginal + closeLen);

  // 4. 反序列化：取第一个 map 文档（与 resolveFrontmatterEnd 一致的语义）
  const parsed = (() => {
    const docs = parseAllDocuments(yamlText);
    for (const doc of docs) {
      if (doc.errors.length > 0) break;
      const js = doc.toJS();
      if (js === null || js === undefined) continue;
      if (typeof js === "object" && !Array.isArray(js)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return js as SkillMetadata;
      }
      break;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return {} as SkillMetadata;
  })();

  // 5. 校验 / 提取字段
  if (typeof parsed.name !== "string") {
    throw new Error("Skill frontmatter is missing required `name` field");
  }
  const name = parsed.name.trim();
  validateName(name);

  const { description, warning } = extractDescription(parsed.description);

  let disableModelInvocation = false;
  if (parsed.disable_model_invocation !== undefined) {
    if (typeof parsed.disable_model_invocation !== "boolean") {
      throw new Error(
        `Skill frontmatter \`disable_model_invocation\` must be a boolean, got ${typeof parsed.disable_model_invocation}`,
      );
    }
    disableModelInvocation = parsed.disable_model_invocation;
  }

  const loadWarnings: SkillLoadWarning[] = [];
  if (warning) loadWarnings.push(warning);

  return {
    name,
    description,
    disableModelInvocation,
    loadWarnings,
    body,
  };
}
