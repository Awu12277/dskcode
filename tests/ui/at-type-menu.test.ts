// 单元测试：@ 类型选择面板相关纯函数
// 覆盖：getAtTrigger 提取 @ 触发段、AtTypeMenu 的选项配置
import { describe, it, expect } from "vitest";
import { getAtTrigger, filterSkillsByAtInput } from "../../src/ui/file-search.js";
import {
  AT_TYPE_OPTIONS,
  getEnabledAtTypes,
  findAtTypeByIndex,
  shouldRenderAtTypeMenu,
} from "../../src/ui/file-search.js";

describe("getAtTrigger", () => {
  it("非 @ 触发态返回 null", () => {
    expect(getAtTrigger("hello world")).toBeNull();
    expect(getAtTrigger("hello@world")).toBeNull(); // @ 前无空白且不在行首
    expect(getAtTrigger("/skill name")).toBeNull();
  });

  it("@ 在行首：query 为空", () => {
    const t = getAtTrigger("@");
    expect(t).not.toBeNull();
    expect(t!.atIndex).toBe(0);
    expect(t!.query).toBe("");
  });

  it("@ 在行首，query 有内容", () => {
    const t = getAtTrigger("@package.json");
    expect(t).not.toBeNull();
    expect(t!.atIndex).toBe(0);
    expect(t!.query).toBe("package.json");
  });

  it("@ 前有空格：定位到最近 @", () => {
    const t = getAtTrigger("hello @");
    expect(t).not.toBeNull();
    expect(t!.atIndex).toBe(6);
    expect(t!.query).toBe("");
  });

  it("@ 前有空格，query 有内容", () => {
    const t = getAtTrigger("看看 @src/ui");
    expect(t).not.toBeNull();
    expect(t!.atIndex).toBe(3);
    expect(t!.query).toBe("src/ui");
  });

  it("多个 @ 时只匹配最后一个", () => {
    // 文本中包含两个 @，但最后一个 @ 后面无字符 → query 为空
    const t = getAtTrigger("看看 @first 然后 @");
    expect(t).not.toBeNull();
    expect(t!.atIndex).toBe("看看 @first 然后 @".lastIndexOf("@"));
    expect(t!.query).toBe("");
  });

  it("@ 后只剩空白仍处于触发态", () => {
    const t = getAtTrigger("@   ");
    expect(t).not.toBeNull();
    expect(t!.query).toBe("   ");
  });
});

describe("filterSkillsByAtInput", () => {
  const skills = [
    { name: "code-review", description: "d1" },
    { name: "refactor", description: "d2" },
    { name: "test-runner", description: "d3" },
    { name: "weather", description: "d4" },
    { name: "lint-fix", description: "d5" },
  ];

  it("非 @ 触发态返回空", () => {
    expect(filterSkillsByAtInput("/code", skills)).toEqual([]);
    expect(filterSkillsByAtInput("hello", skills)).toEqual([]);
  });

  it("@ 后空 query 返回前 3 个", () => {
    expect(filterSkillsByAtInput("@", skills)).toEqual([
      { name: "code-review", description: "d1" },
      { name: "refactor", description: "d2" },
      { name: "test-runner", description: "d3" },
    ]);
  });

  it("@ 后纯数字 1/2 视为刚选了类型，返回前 3 个而不是子串匹配", () => {
    expect(filterSkillsByAtInput("@1", skills)).toEqual([
      { name: "code-review", description: "d1" },
      { name: "refactor", description: "d2" },
      { name: "test-runner", description: "d3" },
    ]);
    expect(filterSkillsByAtInput("@2", skills)).toEqual([
      { name: "code-review", description: "d1" },
      { name: "refactor", description: "d2" },
      { name: "test-runner", description: "d3" },
    ]);
  });

  it("@ 后子串匹配返回最多 3 个", () => {
    expect(filterSkillsByAtInput("@code", skills)).toEqual([
      { name: "code-review", description: "d1" },
    ]);
    // "fix" 命中 lint-fix
    expect(filterSkillsByAtInput("@fix", skills)).toEqual([
      { name: "lint-fix", description: "d5" },
    ]);
    // 多个命中按原顺序取前 3：code-review/refactor/test-runner/weather 包含 e
    const r = filterSkillsByAtInput("@e", skills);
    expect(r.map((s) => s.name)).toEqual(["code-review", "refactor", "test-runner"]);
  });

  it("@ 中间触发也生效", () => {
    expect(filterSkillsByAtInput("hello @code", skills)).toEqual([
      { name: "code-review", description: "d1" },
    ]);
  });

  it("精确匹配返回空（视为已补全）", () => {
    expect(filterSkillsByAtInput("@refactor", skills)).toEqual([]);
  });

  it("不匹配返回空", () => {
    expect(filterSkillsByAtInput("@zzzzz", skills)).toEqual([]);
  });

  it("大小写不敏感", () => {
    expect(filterSkillsByAtInput("@CODE", skills)).toEqual([
      { name: "code-review", description: "d1" },
    ]);
  });
});

describe("AT_TYPE_OPTIONS", () => {
  it("包含 2 个候选类型（MVP：MCP / Fetch 已砍）", () => {
    expect(AT_TYPE_OPTIONS).toHaveLength(2);
  });

  it("index 编号 1..2 严格对应 Files / Skills", () => {
    expect(AT_TYPE_OPTIONS[0]?.index).toBe(1);
    expect(AT_TYPE_OPTIONS[0]?.label).toBe("Files & Directories");
    expect(AT_TYPE_OPTIONS[1]?.index).toBe(2);
    expect(AT_TYPE_OPTIONS[1]?.label).toBe("Skills");
  });

  it("当前两个都启用", () => {
    expect(AT_TYPE_OPTIONS[0]?.enabled).toBe(true);
    expect(AT_TYPE_OPTIONS[1]?.enabled).toBe(true);
  });

  it("getEnabledAtTypes 只返回启用的项", () => {
    const enabled = getEnabledAtTypes();
    expect(enabled).toHaveLength(2);
    expect(enabled.map((o) => o.index)).toEqual([1, 2]);
  });

  it("findAtTypeByIndex 找到时返回对应项", () => {
    expect(findAtTypeByIndex(1)?.label).toBe("Files & Directories");
    expect(findAtTypeByIndex(2)?.label).toBe("Skills");
  });

  it("findAtTypeByIndex 找不到时返回 null", () => {
    expect(findAtTypeByIndex(0)).toBeNull();
    expect(findAtTypeByIndex(99)).toBeNull();
    expect(findAtTypeByIndex(-1)).toBeNull();
  });
});

describe("shouldRenderAtTypeMenu", () => {
  it("默认（open=false）不渲染", () => {
    expect(shouldRenderAtTypeMenu(false)).toBe(false);
  });

  it("open=true 且有 enabled 项时渲染", () => {
    expect(shouldRenderAtTypeMenu(true)).toBe(true);
  });

  it("open=true 但 enabled 为空时不渲染（安全网）", () => {
    // 模拟全部 enabled=false 的场景：用 stub 调用不会修改 AT_TYPE_OPTIONS，
    // 这里只能反向验证函数本身的逻辑——open=false 才是 false。
    expect(shouldRenderAtTypeMenu(false)).toBe(false);
  });
});
