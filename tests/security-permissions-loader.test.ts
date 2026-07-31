// ---------------------------------------------------------------------------
// 权限配置文件加载器单元测试
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  loadPermissions,
  loadRulesFromFile,
  defaultGlobalPermissionsPath,
  defaultProjectPermissionsPath,
} from "../src/security/permissions-loader.js";

describe("loadRulesFromFile — 文件操作", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dskcode-loader-"));
  });
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("文件不存在 → 空规则 + 不警告", async () => {
    const path = join(tmpDir, "nonexistent.json");
    const r = await loadRulesFromFile(path);
    expect(r.rules).toEqual([]);
    expect(r.warning).toBeNull();
  });

  it("合法 JSON + 空 rules → 空规则", async () => {
    const path = join(tmpDir, "perm.json");
    await writeFile(path, JSON.stringify({ rules: [] }), "utf-8");
    const r = await loadRulesFromFile(path);
    expect(r.rules).toEqual([]);
    expect(r.warning).toBeNull();
  });

  it("合法 JSON + 1 条规则", async () => {
    const path = join(tmpDir, "perm.json");
    await writeFile(
      path,
      JSON.stringify({
        rules: [{ tool: "bash", action: "confirm", reason: "test" }],
      }),
      "utf-8",
    );
    const r = await loadRulesFromFile(path);
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]).toEqual({ tool: "bash", action: "confirm", reason: "test" });
    expect(r.warning).toBeNull();
  });

  it("JSON 非法 → 警告 + 空规则", async () => {
    const path = join(tmpDir, "perm.json");
    await writeFile(path, "{not valid json", "utf-8");
    const r = await loadRulesFromFile(path);
    expect(r.rules).toEqual([]);
    expect(r.warning).toContain("JSON 失败");
  });

  it("顶层不是对象 → 警告", async () => {
    const path = join(tmpDir, "perm.json");
    await writeFile(path, "[]", "utf-8");
    const r = await loadRulesFromFile(path);
    expect(r.warning).toContain("不是对象");
  });

  it("rules 不是数组 → 警告", async () => {
    const path = join(tmpDir, "perm.json");
    await writeFile(path, JSON.stringify({ rules: "string" }), "utf-8");
    const r = await loadRulesFromFile(path);
    expect(r.warning).toContain("不是数组");
  });

  it("单条规则缺 tool → 跳过 + warn 到 console（不污染 return）", async () => {
    const path = join(tmpDir, "perm.json");
    await writeFile(
      path,
      JSON.stringify({
        rules: [
          { action: "allow" }, // 缺 tool
          { tool: "bash", action: "deny" }, // OK
        ],
      }),
      "utf-8",
    );
    const r = await loadRulesFromFile(path);
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]?.tool).toBe("bash");
  });

  it("action 非法 → 跳过该条", async () => {
    const path = join(tmpDir, "perm.json");
    await writeFile(
      path,
      JSON.stringify({
        rules: [
          { tool: "bash", action: "allow" },
          { tool: "bash", action: "INVALID" },
        ],
      }),
      "utf-8",
    );
    const r = await loadRulesFromFile(path);
    expect(r.rules).toHaveLength(1);
  });

  it("match 字段缺失 → OK（视为匹配所有）", async () => {
    const path = join(tmpDir, "perm.json");
    await writeFile(
      path,
      JSON.stringify({ rules: [{ tool: "bash", action: "deny" }] }),
      "utf-8",
    );
    const r = await loadRulesFromFile(path);
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]?.match).toBeUndefined();
  });

  it("match.pathGlob + commandRegex + argValueRegex 全部支持", async () => {
    const path = join(tmpDir, "perm.json");
    await writeFile(
      path,
      JSON.stringify({
        rules: [
          {
            tool: "fetch",
            action: "confirm",
            match: {
              pathGlob: "**/*.json",
              commandRegex: "^curl",
              argValueRegex: { url: "^https" },
            },
            reason: "fetch needs care",
          },
        ],
      }),
      "utf-8",
    );
    const r = await loadRulesFromFile(path);
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]?.match).toEqual({
      pathGlob: "**/*.json",
      commandRegex: "^curl",
      argValueRegex: { url: "^https" },
    });
  });

  it("argValueRegex 字段值非字符串 → 跳过该字段", async () => {
    const path = join(tmpDir, "perm.json");
    await writeFile(
      path,
      JSON.stringify({
        rules: [
          {
            tool: "fetch",
            action: "allow",
            match: { argValueRegex: { url: "^https", count: 123 } },
          },
        ],
      }),
      "utf-8",
    );
    const r = await loadRulesFromFile(path);
    expect(r.rules[0]?.match?.argValueRegex).toEqual({ url: "^https" });
  });
});

describe("loadPermissions — 全局 + 项目级合并", () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dskcode-permhome-"));
    projectDir = await mkdtemp(join(tmpdir(), "dskcode-permproj-"));
  });
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("两边都不存在 → 空引擎，无警告", async () => {
    const r = await loadPermissions(projectDir, join(tmpDir, "permissions.json"));
    expect(r.warnings).toEqual([]);
    expect(r.loadedFrom).toEqual([]);
    expect(r.engine.rules).toEqual([]);
  });

  it("只存在全局 → 加载全局", async () => {
    const globalPath = join(tmpDir, "permissions.json");
    await writeFile(
      globalPath,
      JSON.stringify({ rules: [{ tool: "bash", action: "allow" }] }),
      "utf-8",
    );
    const r = await loadPermissions(projectDir, globalPath);
    expect(r.warnings).toEqual([]);
    expect(r.loadedFrom).toEqual([globalPath]);
    expect(r.engine.rules).toHaveLength(1);
  });

  it("只存在项目级 → 加载项目级", async () => {
    const dskDir = join(projectDir, ".dskcode");
    await mkdir(dskDir, { recursive: true });
    await writeFile(
      join(dskDir, "permissions.json"),
      JSON.stringify({ rules: [{ tool: "edit_file", action: "deny" }] }),
      "utf-8",
    );
    const r = await loadPermissions(projectDir, join(tmpDir, "nonexistent.json"));
    expect(r.engine.rules).toHaveLength(1);
    expect(r.loadedFrom).toHaveLength(1);
  });

  it("两边都存在 → 都加载", async () => {
    const globalPath = join(tmpDir, "permissions.json");
    await writeFile(
      globalPath,
      JSON.stringify({ rules: [{ tool: "bash", action: "allow" }] }),
      "utf-8",
    );
    const dskDir = join(projectDir, ".dskcode");
    await mkdir(dskDir, { recursive: true });
    await writeFile(
      join(dskDir, "permissions.json"),
      JSON.stringify({ rules: [{ tool: "edit_file", action: "deny" }] }),
      "utf-8",
    );
    const r = await loadPermissions(projectDir, globalPath);
    expect(r.engine.rules).toHaveLength(2);
    expect(r.loadedFrom).toHaveLength(2);
  });

  it("项目级与全局相同 key 的规则去重（项目级优先）", async () => {
    const globalPath = join(tmpDir, "permissions.json");
    // tool + action + match 三者全相同的规则，项目级优先（同 key 后出现的覆盖）
    await writeFile(
      globalPath,
      JSON.stringify({
        rules: [
          {
            tool: "bash",
            action: "allow",
            match: { commandRegex: "^rm" },
            reason: "global",
          },
        ],
      }),
      "utf-8",
    );
    const dskDir = join(projectDir, ".dskcode");
    await mkdir(dskDir, { recursive: true });
    await writeFile(
      join(dskDir, "permissions.json"),
      JSON.stringify({
        rules: [
          {
            tool: "bash",
            action: "allow",
            match: { commandRegex: "^rm" },
            reason: "project",
          },
        ],
      }),
      "utf-8",
    );
    const r = await loadPermissions(projectDir, globalPath);
    expect(r.engine.rules).toHaveLength(1);
    expect(r.engine.rules[0]?.reason).toBe("project"); // 项目级优先
  });

  it("项目级与全局 action 不同的规则共存（不算同 key）", async () => {
    const globalPath = join(tmpDir, "permissions.json");
    await writeFile(
      globalPath,
      JSON.stringify({
        rules: [{ tool: "bash", action: "allow", match: { commandRegex: "^rm" } }],
      }),
      "utf-8",
    );
    const dskDir = join(projectDir, ".dskcode");
    await mkdir(dskDir, { recursive: true });
    await writeFile(
      join(dskDir, "permissions.json"),
      JSON.stringify({
        rules: [{ tool: "bash", action: "deny", match: { commandRegex: "^rm" } }],
      }),
      "utf-8",
    );
    const r = await loadPermissions(projectDir, globalPath);
    // action 不同 → 两个 key 都保留
    expect(r.engine.rules).toHaveLength(2);
  });

  it("一文件 JSON 非法 → 警告 + 另一文件照常加载", async () => {
    const globalPath = join(tmpDir, "permissions.json");
    await writeFile(globalPath, "{not valid", "utf-8");
    const dskDir = join(projectDir, ".dskcode");
    await mkdir(dskDir, { recursive: true });
    await writeFile(
      join(dskDir, "permissions.json"),
      JSON.stringify({ rules: [{ tool: "bash", action: "allow" }] }),
      "utf-8",
    );
    const r = await loadPermissions(projectDir, globalPath);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.engine.rules).toHaveLength(1); // 项目级的
  });

  it("默认路径：全局 = ~/.dskcode/permissions.json", () => {
    const p = defaultGlobalPermissionsPath();
    expect(p).toMatch(/permissions\.json$/);
  });

  it("默认路径：项目级 = <cwd>/.dskcode/permissions.json", () => {
    // 跨平台：只需验证结果以 cwd 开头、以 .dskcode/permissions.json 结尾
    const p = defaultProjectPermissionsPath("cwd");
    expect(p).toContain("cwd");
    expect(p).toMatch(/[\\/]\.dskcode[\\/]permissions\.json$/);
  });
});

describe("loadPermissions — 加载结果可立即用于 PermissionEngine", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dskcode-engine-"));
  });
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("加载的规则立即可被引擎 evaluate", async () => {
    const globalPath = join(tmpDir, "permissions.json");
    await writeFile(
      globalPath,
      JSON.stringify({
        rules: [
          { tool: "bash", action: "deny", match: { commandRegex: "npm\\s+publish" } },
          { tool: "bash", action: "allow" },
        ],
      }),
      "utf-8",
    );
    const r = await loadPermissions("/anywhere", globalPath);
    // npm publish 应被 deny
    expect(r.engine.evaluate("bash", { args: { command: "npm publish" } })).toBe("deny");
    // ls 应被 allow
    expect(r.engine.evaluate("bash", { args: { command: "ls" } })).toBe("allow");
  });
});
