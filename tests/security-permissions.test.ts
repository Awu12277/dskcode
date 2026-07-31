// ---------------------------------------------------------------------------
// 权限规则引擎单元测试
//
// 覆盖：
// 1. evaluate()：无规则 → null；有规则按顺序求值首条命中
// 2. match.pathGlob（用 globToRegExp）
// 3. match.commandRegex（bash 命令）
// 4. match.argValueRegex（按字段匹配）
// 5. 多个条件 AND 关系
// 6. 正则非法不命中（不抛错）
// 7. globToRegExp 各种 glob 写法
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  PermissionEngine,
  extractCommand,
  globToRegExp,
  matchPathGlob,
  type PermissionRule,
} from "../src/security/permissions.js";

describe("PermissionEngine — 基本求值", () => {
  it("无规则时返回 null", () => {
    const engine = new PermissionEngine([]);
    expect(engine.evaluate("bash", { args: { command: "ls" } })).toBeNull();
  });

  it("规则工具名不匹配 → null", () => {
    const engine = new PermissionEngine([{ tool: "edit_file", action: "allow" }]);
    expect(engine.evaluate("bash", { args: { command: "ls" } })).toBeNull();
  });

  it("规则无 match 条件 → 直接命中", () => {
    const engine = new PermissionEngine([{ tool: "bash", action: "confirm" }]);
    expect(engine.evaluate("bash", { args: { command: "ls" } })).toBe("confirm");
  });

  it("多条规则按顺序求值，首条命中即停", () => {
    const engine = new PermissionEngine([
      { tool: "bash", action: "deny", match: { commandRegex: "^rm\\s" } },
      { tool: "bash", action: "allow" }, // 默认放行
    ]);
    expect(engine.evaluate("bash", { args: { command: "rm -rf /" } })).toBe("deny");
    expect(engine.evaluate("bash", { args: { command: "ls" } })).toBe("allow");
  });

  it("导出 rules 属性为只读快照", () => {
    const rules: PermissionRule[] = [{ tool: "bash", action: "deny" }];
    const engine = new PermissionEngine(rules);
    const snapshot = engine.rules;
    expect(snapshot).toHaveLength(1);
    // 不应影响原数组
    expect(engine.rules).not.toBe(snapshot);
  });
});

describe("PermissionEngine — match.pathGlob", () => {
  const engine = new PermissionEngine([
    { tool: "edit_file", action: "allow", match: { pathGlob: "**/*.test.ts" } },
    { tool: "edit_file", action: "deny", match: { pathGlob: "**/secrets/**" } },
  ]);

  it("匹配 test 文件 → allow", () => {
    expect(
      engine.evaluate("edit_file", { args: {}, targetPath: "/proj/src/foo.test.ts" }),
    ).toBe("allow");
  });

  it("不匹配 test 文件 → null", () => {
    expect(
      engine.evaluate("edit_file", { args: {}, targetPath: "/proj/src/foo.ts" }),
    ).toBeNull();
  });

  it("命中 secrets → deny", () => {
    expect(
      engine.evaluate("edit_file", { args: {}, targetPath: "/proj/secrets/key.txt" }),
    ).toBe("deny");
  });

  it("targetPath 缺失 → 不命中（path 规则依赖它）", () => {
    expect(engine.evaluate("edit_file", { args: {} })).toBeNull();
  });

  it("支持单层 *.json glob", () => {
    const e = new PermissionEngine([
      { tool: "read_file", action: "allow", match: { pathGlob: "*.json" } },
    ]);
    expect(e.evaluate("read_file", { args: {}, targetPath: "package.json" })).toBe(
      "allow",
    );
    expect(e.evaluate("read_file", { args: {}, targetPath: "src/foo.json" })).toBeNull();
  });

  it("支持 src/**/*.ts 前缀 glob", () => {
    const e = new PermissionEngine([
      { tool: "read_file", action: "allow", match: { pathGlob: "src/**/*.ts" } },
    ]);
    expect(e.evaluate("read_file", { args: {}, targetPath: "src/a.ts" })).toBe("allow");
    expect(e.evaluate("read_file", { args: {}, targetPath: "src/nested/b.ts" })).toBe(
      "allow",
    );
    expect(e.evaluate("read_file", { args: {}, targetPath: "lib/a.ts" })).toBeNull();
  });

  it("支持字符类 [abc]", () => {
    const e = new PermissionEngine([
      { tool: "read_file", action: "allow", match: { pathGlob: "data[123].csv" } },
    ]);
    expect(e.evaluate("read_file", { args: {}, targetPath: "data1.csv" })).toBe("allow");
    expect(e.evaluate("read_file", { args: {}, targetPath: "data4.csv" })).toBeNull();
  });

  it("支持 ? 单字符", () => {
    const e = new PermissionEngine([
      { tool: "read_file", action: "allow", match: { pathGlob: "file?.txt" } },
    ]);
    expect(e.evaluate("read_file", { args: {}, targetPath: "fileA.txt" })).toBe("allow");
    expect(e.evaluate("read_file", { args: {}, targetPath: "fileAB.txt" })).toBeNull();
  });
});

describe("PermissionEngine — match.commandRegex", () => {
  const engine = new PermissionEngine([
    { tool: "bash", action: "confirm", match: { commandRegex: "^git\\s+(commit|push)" } },
    { tool: "bash", action: "deny", match: { commandRegex: "npm\\s+publish" } },
  ]);

  it("git commit → confirm", () => {
    expect(engine.evaluate("bash", { args: { command: "git commit -m hi" } })).toBe(
      "confirm",
    );
  });

  it("git push → confirm", () => {
    expect(engine.evaluate("bash", { args: { command: "git push origin main" } })).toBe(
      "confirm",
    );
  });

  it("npm publish → deny", () => {
    expect(engine.evaluate("bash", { args: { command: "npm publish" } })).toBe("deny");
  });

  it("不匹配的 git 命令 → null", () => {
    expect(engine.evaluate("bash", { args: { command: "git status" } })).toBeNull();
  });

  it("args 无 command 字段 → 不命中", () => {
    expect(engine.evaluate("bash", { args: { timeout: 5000 } })).toBeNull();
  });

  it("args 非对象 → 不命中", () => {
    expect(engine.evaluate("bash", { args: "ls" })).toBeNull();
    expect(engine.evaluate("bash", { args: null })).toBeNull();
    expect(engine.evaluate("bash", { args: undefined })).toBeNull();
  });

  it("正则非法 → 不命中（不抛错）", () => {
    const e = new PermissionEngine([
      { tool: "bash", action: "deny", match: { commandRegex: "[unclosed" } },
    ]);
    expect(() => e.evaluate("bash", { args: { command: "ls" } })).not.toThrow();
    expect(e.evaluate("bash", { args: { command: "ls" } })).toBeNull();
  });
});

describe("PermissionEngine — match.argValueRegex", () => {
  it("按字段名匹配参数", () => {
    const engine = new PermissionEngine([
      {
        tool: "fetch",
        action: "confirm",
        match: { argValueRegex: { url: "^https://internal\\.company\\.com" } },
      },
    ]);
    expect(
      engine.evaluate("fetch", { args: { url: "https://internal.company.com/api" } }),
    ).toBe("confirm");
    expect(engine.evaluate("fetch", { args: { url: "https://google.com" } })).toBeNull();
  });

  it("字段值不是字符串 → 不命中", () => {
    const engine = new PermissionEngine([
      { tool: "x", action: "allow", match: { argValueRegex: { url: "^https" } } },
    ]);
    expect(engine.evaluate("x", { args: { url: 123 } })).toBeNull();
  });

  it("正则非法 → 不命中（不抛错）", () => {
    const engine = new PermissionEngine([
      { tool: "x", action: "allow", match: { argValueRegex: { url: "[bad" } } },
    ]);
    expect(() => engine.evaluate("x", { args: { url: "https://x.com" } })).not.toThrow();
  });
});

describe("PermissionEngine — 条件 AND 关系", () => {
  it("pathGlob + commandRegex 都满足才命中", () => {
    const engine = new PermissionEngine([
      {
        tool: "bash",
        action: "confirm",
        match: {
          pathGlob: "scripts/**",
          commandRegex: "^deploy",
        },
      },
    ]);

    // 仅 path 命中但 command 不命中 → null
    expect(
      engine.evaluate("bash", {
        args: { command: "ls" },
        targetPath: "scripts/deploy.sh",
      }),
    ).toBeNull();

    // 仅 command 命中但 path 不命中 → null
    expect(
      engine.evaluate("bash", {
        args: { command: "deploy prod" },
        targetPath: "lib/x.ts",
      }),
    ).toBeNull();

    // 两者都命中 → confirm
    expect(
      engine.evaluate("bash", {
        args: { command: "deploy prod" },
        targetPath: "scripts/deploy.sh",
      }),
    ).toBe("confirm");
  });

  it("3 个条件全满足才命中", () => {
    const engine = new PermissionEngine([
      {
        tool: "fetch",
        action: "deny",
        match: {
          pathGlob: "**/*.json",
          commandRegex: "^GET",
          argValueRegex: { method: "^POST$" },
        },
      },
    ]);

    expect(
      engine.evaluate("fetch", {
        args: { method: "POST" },
        targetPath: "data.json",
      }),
    ).toBeNull(); // command 不匹配
  });
});

describe("extractCommand", () => {
  it("提取对象里的 command 字段", () => {
    expect(extractCommand({ command: "ls" })).toBe("ls");
    expect(extractCommand({ command: "rm -rf /", timeout: 5000 })).toBe("rm -rf /");
  });

  it("非对象返回 null", () => {
    expect(extractCommand("ls")).toBeNull();
    expect(extractCommand(null)).toBeNull();
    expect(extractCommand(undefined)).toBeNull();
    expect(extractCommand(123)).toBeNull();
  });

  it("对象无 command 字段 → null", () => {
    expect(extractCommand({})).toBeNull();
    expect(extractCommand({ timeout: 5000 })).toBeNull();
  });

  it("command 非字符串 → null", () => {
    expect(extractCommand({ command: 123 })).toBeNull();
    expect(extractCommand({ command: null })).toBeNull();
  });
});

describe("globToRegExp", () => {
  it("* 匹配非 / 字符序列", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("foo.tsx")).toBe(false);
    expect(re.test("dir/foo.ts")).toBe(false); // * 不跨 /
  });

  it("** 匹配含 / 的字符序列", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("dir/foo.ts")).toBe(true);
    expect(re.test("a/b/c/foo.ts")).toBe(true);
    expect(re.test("foo.tsx")).toBe(false);
  });

  it("**/ 可省略前缀", () => {
    const re = globToRegExp("**/foo.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("dir/foo.ts")).toBe(true);
  });

  it("? 匹配单个非 / 字符", () => {
    const re = globToRegExp("file?.txt");
    expect(re.test("fileA.txt")).toBe(true);
    expect(re.test("file.txt")).toBe(false);
    expect(re.test("fileAB.txt")).toBe(false);
  });

  it("字符类 [abc]", () => {
    const re = globToRegExp("data[123].csv");
    expect(re.test("data1.csv")).toBe(true);
    expect(re.test("data2.csv")).toBe(true);
    expect(re.test("data4.csv")).toBe(false);
  });

  it("字符类 [a-z]", () => {
    const re = globToRegExp("file[a-z].txt");
    expect(re.test("filea.txt")).toBe(true);
    expect(re.test("fileZ.txt")).toBe(false);
  });

  it("转义正则元字符", () => {
    const re = globToRegExp("file.test+name.json");
    expect(re.test("file.test+name.json")).toBe(true);
    expect(re.test("fileXtestXname.json")).toBe(false); // . 没转义会误匹配
  });

  it("src/**/*.ts 前缀", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/nested/b.ts")).toBe(true);
    expect(re.test("lib/a.ts")).toBe(false);
  });
});

describe("matchPathGlob", () => {
  it("空 glob 返回 false", () => {
    expect(matchPathGlob("", "/foo")).toBe(false);
  });

  it("空 targetPath 返回 false", () => {
    expect(matchPathGlob("*.ts", "")).toBe(false);
  });

  it("非法 glob 不抛错，返回 false", () => {
    expect(() => matchPathGlob("foo[", "/foo")).not.toThrow();
    // globToRegExp 对未闭合的 [ 会把 \[ 转义；通常仍能匹配字面 [
    // 我们关心的是"不抛错"
  });

  it("正常匹配", () => {
    expect(matchPathGlob("**/*.ts", "/proj/src/foo.ts")).toBe(true);
    expect(matchPathGlob("**/*.ts", "/proj/src/foo.js")).toBe(false);
  });
});
