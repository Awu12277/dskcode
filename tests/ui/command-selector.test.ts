// 单元测试：CommandSelector 的 filterCommandsBySlashInput 纯函数
import { describe, it, expect } from "vitest";
import { filterCommandsBySlashInput } from "../../src/ui/file-search.js";

const FAKE_COMMANDS = [
  { name: "/exit", desc: "退出" },
  { name: "/quit", desc: "退出" },
  { name: "/help", desc: "显示帮助" },
  { name: "/clear", desc: "清空对话" },
  { name: "/model", desc: "切换模型" },
  { name: "/thinking", desc: "深度思考" },
  { name: "/effort", desc: "推理等级" },
  { name: "/rewind", desc: "回退" },
  { name: "/mcp", desc: "MCP server" },
  { name: "/permissions", desc: "查看权限" },
];

describe("filterCommandsBySlashInput", () => {
  it("非 / 触发态返回空", () => {
    expect(filterCommandsBySlashInput("hello world", FAKE_COMMANDS)).toEqual([]);
  });

  it("行中纯 / 紧跟空白 query 为空 → 视为误触，返回空", () => {
    expect(filterCommandsBySlashInput("hello /", FAKE_COMMANDS)).toEqual([]);
  });

  it("/ 行首无 query → 展示前 N 个", () => {
    const out = filterCommandsBySlashInput("/", FAKE_COMMANDS);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.name).toBe("/exit");
  });

  it("/ 后前导匹配不区分大小写", () => {
    const out = filterCommandsBySlashInput("/EXI", FAKE_COMMANDS);
    expect(out.map((c) => c.name)).toContain("/exit");
  });

  it("前导匹配：/he 应包含 /help", () => {
    const out = filterCommandsBySlashInput("/he", FAKE_COMMANDS);
    expect(out.map((c) => c.name)).toContain("/help");
  });

  it("前导匹配：/think 应只命中以 think 开头的命令", () => {
    const out = filterCommandsBySlashInput("/think", FAKE_COMMANDS);
    expect(out.map((c) => c.name)).toContain("/thinking");
    // /o /a /i 都不以 think 开头
    expect(out.map((c) => c.name)).not.toContain("/model");
  });

  it("前导匹配：/o 应该只匹配 /o 开头的命令，本例无匹配", () => {
    const out = filterCommandsBySlashInput("/o", FAKE_COMMANDS);
    expect(out).toEqual([]);
  });

  it("精确匹配仍返回结果（CommandSelector 检测 done）", () => {
    const out = filterCommandsBySlashInput("/help", FAKE_COMMANDS);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("/help");
  });

  it("/cl 应只命中 /clear", () => {
    const out = filterCommandsBySlashInput("/cl", FAKE_COMMANDS);
    expect(out.map((c) => c.name)).toEqual(["/clear"]);
  });

  it("/ 中间触发也生效（行首或空白后）", () => {
    const out = filterCommandsBySlashInput("先帮我 /rewi 一下", FAKE_COMMANDS);
    expect(out.map((c) => c.name)).toContain("/rewind");
  });

  it("不匹配返回空", () => {
    expect(filterCommandsBySlashInput("/zzzzz", FAKE_COMMANDS)).toEqual([]);
  });

  it("大小写不敏感", () => {
    const out1 = filterCommandsBySlashInput("/EXIT", FAKE_COMMANDS);
    const out2 = filterCommandsBySlashInput("/exit", FAKE_COMMANDS);
    expect(out1.map((c) => c.name)).toEqual(out2.map((c) => c.name));
  });
});
