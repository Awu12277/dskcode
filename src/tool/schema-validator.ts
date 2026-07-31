// ---------------------------------------------------------------------------
// 轻量 JSON Schema 校验器 — 工具参数 schema 验证
//
// 设计动机：
// - 引入校验，让 LLM 在工具调用前得到结构化错误反馈
//   （必填缺失、类型错、enum 不在白名单、数值越界、字符串超长、嵌套/数组递归等）
// - JSONSchema 路径用极简递归实现，覆盖 DSKCODE 8 个内置工具的实际需求，零依赖
//
// 与 types.ts 中 JSONSchema 的关系：
// - 这里的 JSONSchemaInput 是面向"运行时校验"的强类型版本
// - 现有 tools/builtins/*.ts 的 parameters 字段是 JSONSchema，类型上 properties 是 Record<string, unknown>
// - validateArgs 接受 JSONSchema（弱类型），运行时按需强转成 JSONSchemaInput 使用
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

/**
 * 强类型的 JSON Schema（运行时校验用）。
 *
 * 与 `types.ts:JSONSchema` 的区别：
 * - 这里的 `type` 是可选的，且支持 array/string/number/integer/boolean/null
 * - properties 的值是 `JSONSchemaProperty`，可递归带 items / properties / required
 */
export interface JSONSchemaInput {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JSONSchemaInput;
  description?: string;
}

/**
 * Schema 属性定义 — 可嵌套（array.items / object.properties）。
 */
export interface JSONSchemaProperty {
  type?: JSONSchemaInput["type"];
  description?: string;
  enum?: ReadonlyArray<string | number | boolean | null>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  /** 数组元素 schema */
  items?: JSONSchemaProperty;
  /** 嵌套对象属性 */
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

// ---------------------------------------------------------------------------
// 校验结果
// ---------------------------------------------------------------------------

/**
 * 单条校验问题。
 *
 * - path: JSON Pointer 风格的路径，如 `$.path`、`$.items[2].name`
 * - expected: 期望的类型或约束（如 "string"、"present"、"enum[A,B,C]"）
 * - received: 实际值描述（截断到 60 字避免爆日志）
 * - message: 人类可读的中文提示，直接喂给 LLM
 */
export interface ValidationIssue {
  path: string;
  expected: string;
  received: string;
  message: string;
}

/** 校验结果：ok 表示无 issue */
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 校验工具调用参数是否符合 schema。
 *
 * 入口（按顺序判断）：
 * 1. JSONSchema 路径：仅支持根为 object 类型（DSKCODE 8 个内置工具都是 object 根）
 * 2. 其他根类型或非对象 schema：直接返回 ok=true,issues=[]（不在本模块范围）
 *
 * @param args — 已解析的 JSON（来自 parseToolCallArgs.ok=true 的 args 字段）
 * @param schema — 工具的 parameters schema：JSONSchema
 * @returns ValidationResult（不抛错）
 *
 * @pure 不修改入参
 */
export function validateArgs(args: unknown, schema: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(schema)) {
    // schema 自身结构异常：跳过校验（避免反射崩溃）
    return { ok: true, issues };
  }
  // JSONSchema 路径仅校验 object 根；其他根直接放过
  if (schema.type !== undefined && schema.type !== "object") {
    return { ok: true, issues };
  }
  validateObject(args, schema as JSONSchemaInput, "$", issues);
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// 内部：递归校验
// ---------------------------------------------------------------------------

/**
 * 校验 object 类型值：required / properties / additionalProperties。
 *
 * @param value — 待校验值
 * @param schema — 当前层 schema
 * @param path — 当前 JSON Pointer（用于 issue.path）
 * @param issues — 累积容器（out 参数）
 */
function validateObject(
  value: unknown,
  schema: JSONSchemaInput,
  path: string,
  issues: ValidationIssue[],
): void {
  // 1. 类型检查
  if (!isPlainObject(value)) {
    issues.push({
      path,
      expected: "object",
      received: describe(value),
      message: `${path} 应为 object，实际为 ${describe(value)}`,
    });
    return;
  }

  // 2. required 检查
  for (const key of schema.required ?? []) {
    if (!(key in value)) {
      issues.push({
        path: `${path}.${key}`,
        expected: "present",
        received: "missing",
        message: `${path}.${key} 是必填字段`,
      });
    }
  }

  // 3. properties 检查
  const props = schema.properties ?? {};
  const additional = schema.additionalProperties;
  for (const [k, v] of Object.entries(value)) {
    const propSchema = props[k];
    if (propSchema === undefined) {
      if (additional === false) {
        issues.push({
          path: `${path}.${k}`,
          expected: "未在 schema 中定义",
          received: describe(v),
          message: `${path}.${k} 不在允许字段中`,
        });
      } else if (isPlainObject(additional)) {
        // additionalProperties 可以是一个 schema（常见于 headers 等「一个宽松对象」场景）
        validateProperty(v, additional, `${path}.${k}`, issues);
      }
      // additionalProperties === true 或 undefined：放过
      continue;
    }
    validateProperty(v, propSchema, `${path}.${k}`, issues);
  }
}

/**
 * 校验单个属性：type / enum / 数值范围 / 字符串长度 / pattern / 嵌套。
 */
function validateProperty(
  value: unknown,
  schema: JSONSchemaProperty,
  path: string,
  issues: ValidationIssue[],
): void {
  // 1. type 检查
  if (schema.type !== undefined) {
    const actual = jsonTypeOf(value);
    if (!typeMatches(actual, schema.type)) {
      issues.push({
        path,
        expected: schema.type,
        received: describe(value),
        message: `${path} 应为 ${schema.type}，实际为 ${actual}`,
      });
      return; // 类型错时不继续校验其他约束（避免级联噪声）
    }
  }

  // 2. enum 检查（仅对标量生效）
  if (schema.enum && schema.enum.length > 0) {
    const expected = `enum[${schema.enum.map((e) => JSON.stringify(e)).join(",")}]`;
    if (!isScalar(value)) {
      issues.push({
        path,
        expected,
        received: describe(value),
        message: `${path} 应为 enum 值之一，实际为 ${describe(value)}`,
      });
    } else if (!schema.enum.includes(value as string | number | boolean | null)) {
      issues.push({
        path,
        expected,
        received: describe(value),
        message: `${path} 应为 enum 值之一，实际为 ${JSON.stringify(value)}`,
      });
    }
  }

  // 3. 数值范围
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({
        path,
        expected: `>= ${schema.minimum}`,
        received: String(value),
        message: `${path} 应 >= ${schema.minimum}，实际为 ${value}`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({
        path,
        expected: `<= ${schema.maximum}`,
        received: String(value),
        message: `${path} 应 <= ${schema.maximum}，实际为 ${value}`,
      });
    }
  }

  // 4. 字符串长度 / pattern
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({
        path,
        expected: `length >= ${schema.minLength}`,
        received: `length ${value.length}`,
        message: `${path} 长度应 >= ${schema.minLength}，实际为 ${value.length}`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({
        path,
        expected: `length <= ${schema.maxLength}`,
        received: `length ${value.length}`,
        message: `${path} 长度应 <= ${schema.maxLength}，实际为 ${value.length}`,
      });
    }
    if (schema.pattern !== undefined) {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) {
          issues.push({
            path,
            expected: `pattern ${schema.pattern}`,
            received: describe(value),
            message: `${path} 不匹配 pattern ${schema.pattern}`,
          });
        }
      } catch {
        // 非法 pattern：跳过（避免反射崩溃）
      }
    }
  }

  // 5. 嵌套对象
  if (schema.properties !== undefined) {
    validateObject(value, schema as JSONSchemaInput, path, issues);
  }

  // 6. 数组元素逐项
  if (schema.items !== undefined && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateProperty(value[i], schema.items, `${path}[${i}]`, issues);
    }
  }
}

// ---------------------------------------------------------------------------
// 内部：辅助函数
// ---------------------------------------------------------------------------

/** 判定值是否为普通对象（非数组、非 null） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 判定值是否为标量（用于 enum 校验前的快速路径） */
function isScalar(v: unknown): boolean {
  return (
    v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}

/**
 * 值的 JSON 类型字符串。
 *
 * 输出："string" | "number" | "boolean" | "object" | "array" | "null"
 */
function jsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/**
 * 类型匹配（支持 integer ↔ number 互通）。
 *
 * 设计：integer 与 number 视为互通（实际场景里 JS 没有真正的 int，
 * LLM 输出 1 也会被解析成 number，校验为 integer 也应该通过）。
 */
function typeMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (expected === "integer" && actual === "number") return true;
  if (expected === "number" && actual === "integer") return true;
  return false;
}

/**
 * 把任意值描述成短字符串，用于 issue.received。
 *
 * 截断到 60 字符，避免日志爆掉。
 */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") {
    const s = v.length > 60 ? v.slice(0, 57) + "..." : v;
    return JSON.stringify(s);
  }
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `array(len=${v.length})`;
  if (typeof v === "object") {
    const keys = Object.keys(v);
    return `object{keys=${keys.length}}`;
  }
  return typeof v;
}
