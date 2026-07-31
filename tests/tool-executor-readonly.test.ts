// ---------------------------------------------------------------------------
// ToolExecutor 只读工具短路 gate 测试 — bugfix-07 回归
//
// 验证：
// - ToolKind.Read 工具调用时，gate.check 完全不被调用
// - ToolKind.Edit/Other 工具调用时，gate.check 仍按预期被调用
// - 这与「读默认放行」语义一致，并被提升为 ToolExecutor 层的硬约束
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { ToolRegistry } from "../src/tool/registry.js";
import { ToolExecutor } from "../src/agent/tool-executor.js";
import { readFileTool } from "../src/tool/builtins/read-file.js";
import { lsTool } from "../src/tool/builtins/ls.js";
import { bashTool } from "../src/tool/builtins/bash.js";
import { ToolKind, type Gate } from "../src/tool/types.js";
import type { ProviderToolCall } from "../src/provider/index.js";
import type { AnyAgentTool } from "../src/tool/types.js";

function call(
  name: string,
  args: Record<string, unknown>,
  id = `c_${name}_${Math.random()}`,
): ProviderToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

describe("ToolExecutor — Read 工具短路 Gate", () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), "dskcode-exec-readonly-"));
    await writeFile(join(cwd, "hello.txt"), "hi\n", "utf-8");
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  it("read_file 执行时 gate.check 不被调用", async () => {
    const gate = {
      check: vi.fn(async () => true),
      lastDenial: undefined,
    } satisfies Gate & { check: ReturnType<typeof vi.fn> };

    const registry = new ToolRegistry();
    registry.register(readFileTool);

    const executor = new ToolExecutor({
      registry,
      gate,
      baseCtx: { cwd },
    });

    const result = await executor.executeBatch([
      call("read_file", { path: "hello.txt" }),
    ]);

    expect(gate.check).not.toHaveBeenCalled();
    expect(result.items[0]!.result.success).toBe(true);
    expect(result.items[0]!.result.data).toContain("hi");
  });

  it("ls 执行时 gate.check 不被调用（也是 ToolKind.Read）", async () => {
    const gate = {
      check: vi.fn(async () => true),
      lastDenial: undefined,
    } satisfies Gate & { check: ReturnType<typeof vi.fn> };

    const registry = new ToolRegistry();
    registry.register(lsTool);

    const executor = new ToolExecutor({
      registry,
      gate,
      baseCtx: { cwd },
    });

    await executor.executeBatch([call("ls", { path: "." })]);

    expect(gate.check).not.toHaveBeenCalled();
  });

  it("bash 执行时 gate.check 仍按预期被调用", async () => {
    const gate = {
      check: vi.fn(async () => true),
      lastDenial: undefined,
    } satisfies Gate & { check: ReturnType<typeof vi.fn> };

    const registry = new ToolRegistry();
    registry.register(bashTool);

    const executor = new ToolExecutor({
      registry,
      gate,
      baseCtx: { cwd },
    });

    await executor.executeBatch([call("bash", { command: "echo hi" })]);

    expect(gate.check).toHaveBeenCalledTimes(1);
    expect(gate.check).toHaveBeenCalledWith("bash", { command: "echo hi" });
  });

  it("读 + 写混合：读不查 gate，写正常查 gate", async () => {
    // 自定义一个 ToolKind.Read 的 mock 工具，让 batch 里同时有读和写
    const fakeRead: AnyAgentTool = {
      name: "fake_read",
      description: "fake read",
      kind: ToolKind.Read,
      parameters: { type: "object", properties: {}, required: [] },
      supportsInputStreaming: false,
      supportedProviders: [],
      execute: async () => ({ success: true, data: "read-result" }),
    };
    const fakeWrite: AnyAgentTool = {
      name: "fake_write",
      description: "fake write",
      kind: ToolKind.Edit,
      parameters: { type: "object", properties: {}, required: [] },
      supportsInputStreaming: false,
      supportedProviders: [],
      execute: async () => ({ success: true, data: "write-result" }),
    };

    const gate = {
      check: vi.fn(async (_toolName: string, _args: unknown) => true),
      lastDenial: undefined,
    } satisfies Gate & { check: ReturnType<typeof vi.fn> };

    const registry = new ToolRegistry();
    registry.register(fakeRead);
    registry.register(fakeWrite);

    const executor = new ToolExecutor({
      registry,
      gate,
      baseCtx: { cwd },
    });

    // 1 读 + 1 写 → 走串行路径（不是 all-read-only）
    await executor.executeBatch([call("fake_read", {}), call("fake_write", {})]);

    expect(gate.check).toHaveBeenCalledTimes(1);
    expect(gate.check).toHaveBeenCalledWith("fake_write", {});
  });

  it("读被 gate deny 不影响读工具执行（gate 不被调用 = 不会被 deny）", async () => {
    // 即便 gate 全 deny，读工具也照常成功——证明短路完全跳过 gate
    const gate = {
      check: vi.fn(async () => false),
      lastDenial: {
        source: "user_prompt" as const,
        reason: "fake deny",
      },
    } satisfies Gate;

    const registry = new ToolRegistry();
    registry.register(readFileTool);

    const executor = new ToolExecutor({
      registry,
      gate,
      baseCtx: { cwd },
    });

    const result = await executor.executeBatch([
      call("read_file", { path: "hello.txt" }),
    ]);

    expect(gate.check).not.toHaveBeenCalled();
    expect(result.items[0]!.result.success).toBe(true);
    expect(result.items[0]!.result.error).toBeUndefined();
  });

  it("并行读：多个 read_file 一次性并发，gate 不被调用", async () => {
    const gate = {
      check: vi.fn(async () => false), // deny 但不应被调用
      lastDenial: undefined,
    } satisfies Gate & { check: ReturnType<typeof vi.fn> };

    const registry = new ToolRegistry();
    registry.register(readFileTool);

    const executor = new ToolExecutor({
      registry,
      gate,
      baseCtx: { cwd },
      maxParallel: 2,
    });

    const result = await executor.executeBatch([
      call("read_file", { path: "hello.txt" }, "c1"),
      call("read_file", { path: "hello.txt" }, "c2"),
      call("read_file", { path: "hello.txt" }, "c3"),
    ]);

    expect(gate.check).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(3);
    for (const it of result.items) {
      expect(it.result.success).toBe(true);
    }
  });
});
