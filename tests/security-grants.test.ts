// ---------------------------------------------------------------------------
// 会话级 Grants 缓存单元测试
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { GrantsCache, hashArgs } from "../src/security/grants-cache.js";

describe("GrantsCache — 基本 CRUD", () => {
  it("has 新增前为 false", () => {
    const c = new GrantsCache();
    expect(c.has("bash", "abc")).toBe(false);
  });

  it("add 后 has 为 true", () => {
    const c = new GrantsCache();
    c.add("bash", "abc");
    expect(c.has("bash", "abc")).toBe(true);
  });

  it("不同 toolName 独立", () => {
    const c = new GrantsCache();
    c.add("bash", "abc");
    expect(c.has("edit_file", "abc")).toBe(false);
  });

  it("不同 argsHash 独立", () => {
    const c = new GrantsCache();
    c.add("bash", "abc");
    expect(c.has("bash", "def")).toBe(false);
  });

  it("revoke 删一条", () => {
    const c = new GrantsCache();
    c.add("bash", "abc");
    expect(c.revoke("bash", "abc")).toBe(true);
    expect(c.has("bash", "abc")).toBe(false);
  });

  it("revoke 不存在的返回 false", () => {
    const c = new GrantsCache();
    expect(c.revoke("bash", "abc")).toBe(false);
  });

  it("clear 清空所有", () => {
    const c = new GrantsCache();
    c.add("bash", "abc");
    c.add("edit_file", "def");
    c.clear();
    expect(c.size).toBe(0);
    expect(c.has("bash", "abc")).toBe(false);
    expect(c.has("edit_file", "def")).toBe(false);
  });

  it("size 反映 add/revoke 数量", () => {
    const c = new GrantsCache();
    expect(c.size).toBe(0);
    c.add("bash", "a");
    expect(c.size).toBe(1);
    c.add("bash", "b");
    expect(c.size).toBe(2);
    c.revoke("bash", "a");
    expect(c.size).toBe(1);
  });

  it("重复 add 同一 key 仍只算一条", () => {
    const c = new GrantsCache();
    c.add("bash", "abc");
    c.add("bash", "abc");
    c.add("bash", "abc");
    expect(c.size).toBe(1);
  });
});

describe("hashArgs — 指纹稳定性", () => {
  it("相同输入产出相同 hash", () => {
    expect(hashArgs({ command: "ls" })).toBe(hashArgs({ command: "ls" }));
  });

  it("key 顺序不影响 hash", () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
  });

  it("嵌套对象 key 顺序不影响", () => {
    const a = hashArgs({ outer: { x: 1, y: 2 } });
    const b = hashArgs({ outer: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it("不同输入产出不同 hash", () => {
    expect(hashArgs({ command: "ls" })).not.toBe(hashArgs({ command: "rm" }));
    expect(hashArgs({ command: "ls" })).not.toBe(
      hashArgs({ command: "ls", timeout: 5000 }),
    );
  });

  it("undefined 字段被忽略", () => {
    expect(hashArgs({ a: 1 })).toBe(hashArgs({ a: 1, b: undefined }));
    expect(hashArgs({ a: 1, b: undefined })).toBe(hashArgs({ b: undefined, a: 1 }));
  });

  it("数组顺序敏感", () => {
    expect(hashArgs([1, 2, 3])).not.toBe(hashArgs([3, 2, 1]));
  });

  it("null 与 undefined 不同", () => {
    expect(hashArgs({ a: null })).not.toBe(hashArgs({ a: undefined }));
  });

  it("字符串字面量直接 hash", () => {
    expect(hashArgs("hello")).toBe(hashArgs("hello"));
    expect(hashArgs("hello")).not.toBe(hashArgs("world"));
  });

  it("数字字面量 hash", () => {
    expect(hashArgs(42)).toBe(hashArgs(42));
    expect(hashArgs(42)).not.toBe(hashArgs(43));
  });

  it("嵌套数组保留顺序", () => {
    expect(hashArgs({ list: [1, 2] })).toBe(hashArgs({ list: [1, 2] }));
    expect(hashArgs({ list: [1, 2] })).not.toBe(hashArgs({ list: [2, 1] }));
  });

  it("返回 16 位 hex 字符串", () => {
    const h = hashArgs({ x: 1 });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("空对象 hash 一致", () => {
    expect(hashArgs({})).toBe(hashArgs({}));
  });

  it("top-level undefined 返回稳定 hash", () => {
    expect(hashArgs(undefined)).toBe(hashArgs(undefined));
  });
});

describe("GrantsCache — 真实场景", () => {
  it("同一命令两次只问一次", () => {
    const c = new GrantsCache();
    const cmd1 = { command: "git commit -m 'fix'" };
    const cmd2 = { command: "git commit -m 'fix'" };
    const h1 = hashArgs(cmd1);
    const h2 = hashArgs(cmd2);
    expect(h1).toBe(h2);

    // 第 1 次：没 grant，需要询问
    expect(c.has("bash", h1)).toBe(false);
    c.add("bash", h1);

    // 第 2 次：已有 grant，直接放行
    expect(c.has("bash", h2)).toBe(true);
  });

  it("不同命令各自独立", () => {
    const c = new GrantsCache();
    c.add("bash", hashArgs({ command: "git commit" }));
    expect(c.has("bash", hashArgs({ command: "git commit" }))).toBe(true);
    expect(c.has("bash", hashArgs({ command: "git push" }))).toBe(false);
  });

  it("不同工具同 argsHash 互不影响", () => {
    const c = new GrantsCache();
    const h = hashArgs({ x: 1 });
    c.add("bash", h);
    expect(c.has("edit_file", h)).toBe(false);
  });
});
