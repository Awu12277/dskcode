// ---------------------------------------------------------------------------
// 写操作拒绝后停止 turn 的单元测试（无需 mock Session）
//
// 注意：WriteConfirmGate 已删除，统一使用 InteractiveGate。
// 这些测试覆盖 ToolExecutor + Gate 的交互行为。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { ToolExecutor } from "../src/agent/tool-executor.js";
import { InteractiveGate, type PromptResponse } from "../src/security/interactive-gate.js";
import { GrantsCache } from "../src/security/grants-cache.js";
import { ToolRegistry } from "../src/tool/registry.js";
import type { ProviderToolCall } from "../src/provider/index.js";
import { editFileTool } from "../src/tool/builtins/edit-file.js";
import { writeFileTool } from "../src/tool/builtins/write-file.js";
import { readFileTool } from "../src/tool/builtins/read-file.js";

function makePrompt(responses: PromptResponse[]) {
  let i = 0;
  return vi.fn(async () => responses[i++] ?? "no");
}

describe("ToolExecutor — 拒绝后停止后续 tool_call", () => {
  it("用户拒绝第一个 edit_file 后，第二个 write_file 不执行", async () => {
    const registry = new ToolRegistry();
    registry.register(editFileTool);
    registry.register(writeFileTool);
    const prompt = makePrompt(["no"]); // 拒绝第一个
    const gate = new InteractiveGate({ prompt, defaultDecision: "confirm" });
    const executor = new ToolExecutor({
      registry,
      gate,
      baseCtx: { cwd: "/tmp" },
    });

    const calls: ProviderToolCall[] = [
      { id: "1", name: "edit_file", arguments: JSON.stringify({ path: "a.ts" }) },
      { id: "2", name: "write_file", arguments: JSON.stringify({ path: "b.ts" }) },
      { id: "3", name: "edit_file", arguments: JSON.stringify({ path: "c.ts" }) },
    ];

    const result = await executor.executeBatch(calls);

    // 只有第一个被执行（被拒绝），后续两个都被跳过
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("edit_file");
    expect(result.items[0]?.result.success).toBe(false);
    expect(result.items[0]?.result.error).toBe("GATE_DENIED");
    // prompt 只被调用一次（拒绝第一个后 turn 中断）
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("读工具始终放行，不触发 gate", async () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.register(editFileTool);
    const prompt = makePrompt(["yes"]);
    const gate = new InteractiveGate({ prompt, defaultDecision: "confirm" });
    const executor = new ToolExecutor({
      registry,
      gate,
      baseCtx: { cwd: "/tmp" },
    });

    const calls: ProviderToolCall[] = [
      { id: "1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
      { id: "2", name: "read_file", arguments: JSON.stringify({ path: "b.ts" }) },
    ];

    const result = await executor.executeBatch(calls);
    expect(result.items).toHaveLength(2);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("用户拒绝时返回的 data 明确告诉 LLM 'Permission to run tool denied by user'", async () => {
    const registry = new ToolRegistry();
    registry.register(editFileTool);
    const prompt = makePrompt(["no"]);
    const gate = new InteractiveGate({ prompt, defaultDecision: "confirm" });
    const executor = new ToolExecutor({
      registry,
      gate,
      baseCtx: { cwd: "/tmp" },
    });

    const result = await executor.executeBatch([
      { id: "1", name: "edit_file", arguments: JSON.stringify({ path: "a.ts" }) },
    ]);

    const item = result.items[0];
    expect(item?.result.data).toContain("Permission to run tool denied by user");
    expect(item?.result.data).toContain("请勿尝试用其他方式");
  });

  it("denial 标记 source=user_prompt 才能中断，黑名单不中断", async () => {
    // 黑名单拦截不属于"用户主动决定"，不应该中断 turn
    const { HardcodedBlacklistGate } = await import("../src/security/hardcoded-gate.js");
    const registry = new ToolRegistry();
    registry.register(editFileTool);
    const gate = new HardcodedBlacklistGate();
    const executor = new ToolExecutor({
      registry,
      gate,
      baseCtx: { cwd: "/tmp" },
    });

    // edit_file 不在黑名单范围内（黑名单只检查 bash）
    const result = await executor.executeBatch([
      { id: "1", name: "edit_file", arguments: JSON.stringify({ path: "a.ts" }) },
      { id: "2", name: "edit_file", arguments: JSON.stringify({ path: "b.ts" }) },
    ]);
    expect(result.items).toHaveLength(2);
  });
});

describe("InteractiveGate — path 级别 grant（替代原 WriteConfirmGate 语义）", () => {
  it("用户选 always 后，同 path 再次调用不弹窗", async () => {
    const prompt = makePrompt(["always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({ prompt, grants, defaultDecision: "confirm" });

    // 第一次：弹窗，用户选 always
    expect(await gate.check("edit_file", { path: "src/main.ts" })).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(grants.size).toBe(1);

    // 第二次：同 path，不同 old_text/new_text，不弹窗
    expect(
      await gate.check("edit_file", {
        path: "src/main.ts",
        old_text: "foo",
        new_text: "bar",
      }),
    ).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1); // 没增加
  });

  it("multi_edit 选 always 后，同 path 的后续 multi_edit 不弹窗", async () => {
    const { multiEditTool } = await import("../src/tool/builtins/multi-edit.js");
    const registry = new ToolRegistry();
    registry.register(multiEditTool);
    const prompt = makePrompt(["always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({ prompt, grants, defaultDecision: "confirm" });

    // 第一次 multi_edit：弹窗，用户选 always
    expect(
      await gate.check("multi_edit", {
        path: "src/main.ts",
        edits: [{ oldText: "a", newText: "b" }],
      }),
    ).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(grants.size).toBe(1);

    // 第二次 multi_edit：edits 完全不同（hash 也不一样），但 path 同，不弹窗
    expect(
      await gate.check("multi_edit", {
        path: "src/main.ts",
        edits: [
          { oldText: "x", newText: "y" },
          { oldText: "m", newText: "n" },
        ],
      }),
    ).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1); // 仍然只调用 1 次
  });

  it("write_file 选 always 后，同 path 的后续 write_file 不弹窗", async () => {
    const prompt = makePrompt(["always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({ prompt, grants, defaultDecision: "confirm" });

    expect(await gate.check("write_file", { path: "a.ts", content: "v1" })).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);

    // 第二次不同 content
    expect(await gate.check("write_file", { path: "a.ts", content: "v2" })).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("delete_range 选 always 后，同 path 的后续 delete_range 不弹窗", async () => {
    const prompt = makePrompt(["always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({ prompt, grants, defaultDecision: "confirm" });

    expect(
      await gate.check("delete_range", {
        path: "a.ts",
        startAnchor: "function foo()",
        endAnchor: "}",
      }),
    ).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);

    // 第二次不同 anchor
    expect(
      await gate.check("delete_range", {
        path: "a.ts",
        startAnchor: "import x",
        endAnchor: "import y",
      }),
    ).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("always 跨不同 path 仍会问（每个 path 单独 grant）", async () => {
    const prompt = makePrompt(["always", "yes"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({ prompt, grants, defaultDecision: "confirm" });

    await gate.check("edit_file", { path: "a.ts" });
    await gate.check("edit_file", { path: "b.ts" });
    expect(prompt).toHaveBeenCalledTimes(2);
    // 仅 path "a.ts" 被加进 grants（用户第一次选 always，第二次选 yes）
    expect(grants.size).toBe(1);
  });

  it("yes 响应不写 grants（每次同 path 都问）", async () => {
    const prompt = makePrompt(["yes", "yes"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({ prompt, grants, defaultDecision: "confirm" });

    await gate.check("edit_file", { path: "a.ts" });
    await gate.check("edit_file", { path: "a.ts" });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(grants.size).toBe(0);
  });

  it("no 响应不写 grants", async () => {
    const prompt = makePrompt(["no"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({ prompt, grants, defaultDecision: "confirm" });

    await gate.check("edit_file", { path: "a.ts" });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(grants.size).toBe(0);
  });

  it("外部传入的 grants 能跨实例共享", async () => {
    const sharedGrants = new GrantsCache();

    const gate1 = new InteractiveGate({
      prompt: makePrompt(["always"]),
      grants: sharedGrants,
      defaultDecision: "confirm",
    });
    const gate2 = new InteractiveGate({
      prompt: makePrompt(["yes"]),
      grants: sharedGrants,
      defaultDecision: "confirm",
    });

    await gate1.check("edit_file", { path: "a.ts" });
    expect(sharedGrants.size).toBe(1);

    // gate2 看到共享 grants，直接放行不弹窗
    expect(await gate2.check("edit_file", { path: "a.ts" })).toBe(true);
  });
});
