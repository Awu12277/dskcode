// ---------------------------------------------------------------------------
// InteractiveGate 单元测试
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import {
  InteractiveGate,
  type PromptResponse,
} from "../src/security/interactive-gate.js";
import { PermissionEngine } from "../src/security/permissions.js";
import { GrantsCache, hashArgs } from "../src/security/grants-cache.js";

/** 创建一个交互 prompt 的 mock，返回预设序列 */
function makePrompt(responses: PromptResponse[]) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i] ?? "no";
    i++;
    return r;
  });
}

describe("InteractiveGate — 规则路径", () => {
  it("规则 allow → 直接放行，不问", async () => {
    const prompt = makePrompt([]);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([{ tool: "bash", action: "allow" }]),
      prompt,
    });
    const ok = await gate.check("bash", { command: "rm -rf /" });
    expect(ok).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("规则 deny → 直接拒绝，不问", async () => {
    const prompt = makePrompt([]);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([
        { tool: "bash", action: "deny", match: { commandRegex: "^rm" } },
      ]),
      prompt,
    });
    const ok = await gate.check("bash", { command: "rm -rf /" });
    expect(ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("规则 confirm → 询问用户", async () => {
    const prompt = makePrompt(["yes"]);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([
        { tool: "bash", action: "confirm", match: { commandRegex: "^git commit" } },
      ]),
      prompt,
    });
    const ok = await gate.check("bash", { command: "git commit -m hi" });
    expect(ok).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("无规则 → 走 defaultDecision", async () => {
    const prompt = makePrompt([]);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      defaultDecision: "deny",
      prompt,
    });
    const ok = await gate.check("bash", { command: "ls" });
    expect(ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled(); // default=deny 直接拒
  });

  it("无规则 + default=allow → 直接放行", async () => {
    const prompt = makePrompt([]);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      defaultDecision: "allow",
      prompt,
    });
    const ok = await gate.check("bash", { command: "ls" });
    expect(ok).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("无规则 + default=confirm → 询问", async () => {
    const prompt = makePrompt(["yes"]);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      defaultDecision: "confirm",
      prompt,
    });
    const ok = await gate.check("bash", { command: "ls" });
    expect(ok).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe("InteractiveGate — 询问交互", () => {
  it("用户 yes → 放行", async () => {
    const prompt = makePrompt(["yes"]);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([{ tool: "bash", action: "confirm" }]),
      prompt,
    });
    expect(await gate.check("bash", { command: "ls" })).toBe(true);
  });

  it("用户 no → 拒绝", async () => {
    const prompt = makePrompt(["no"]);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([{ tool: "bash", action: "confirm" }]),
      prompt,
    });
    expect(await gate.check("bash", { command: "ls" })).toBe(false);
  });

  it("用户 always → 放行 + 加入 grants", async () => {
    const prompt = makePrompt(["always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([{ tool: "bash", action: "confirm" }]),
      grants,
      prompt,
    });

    // 第 1 次：询问
    expect(await gate.check("bash", { command: "ls" })).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(grants.size).toBe(1);

    // 第 2 次：直接走 grants，不再问
    expect(await gate.check("bash", { command: "ls" })).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1); // 没增加
  });
});

describe("InteractiveGate — grants 缓存", () => {
  it("confirm 规则命中 + 已有 grant → 直接放行", async () => {
    const prompt = makePrompt([]);
    const grants = new GrantsCache();
    grants.add("bash", "abc123");
    const gate = new InteractiveGate({
      engine: new PermissionEngine([{ tool: "bash", action: "confirm" }]),
      grants,
      prompt,
    });
    // 即使有 confirm 规则，grant 缓存也只对相同 argsHash 生效
    // 这里 grant 是手动加的，"abc123" hash 不会匹配真实 hash
    expect(prompt).toHaveBeenCalledTimes(0);
  });

  it("always 路径加的 grant 后续直接放行", async () => {
    const prompt = makePrompt(["always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([{ tool: "bash", action: "confirm" }]),
      grants,
      prompt,
    });
    const args = { command: "git status" };
    await gate.check("bash", args); // 询问 → always
    await gate.check("bash", args); // 直接走 grant
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("不同参数产生不同 grant", async () => {
    const prompt = makePrompt(["always", "no"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([{ tool: "bash", action: "confirm" }]),
      grants,
      prompt,
    });
    await gate.check("bash", { command: "git status" });
    await gate.check("bash", { command: "git diff" });
    // 第 2 次用 no，因为 grant 不匹配新的 hash
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(grants.size).toBe(1);
  });

  it("allow 规则不需要 grant 也能直接放行", async () => {
    const prompt = makePrompt([]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([{ tool: "bash", action: "allow" }]),
      grants,
      prompt,
    });
    expect(await gate.check("bash", { command: "rm -rf /" })).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  // new：命令型工具 grant key 按 args.command 拼，不受其他字段变化影响
  it("bash: same command 不同 timeout / 额外字段，永远命中同一个 grant", async () => {
    const prompt = makePrompt(["always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      grants,
      prompt,
      defaultDecision: "confirm",
    });
    await gate.check("bash", { command: "ls -la" });
    // 此刻 grants 里应该有 "bash:ls -la"
    expect(grants.size).toBe(1);
    // 第二次，无 timeout 字段 → 仍命中
    expect(await gate.check("bash", { command: "ls -la" })).toBe(true);
    // 第三次，timeout 不同 → 仍命中（这不是同一 hash）
    expect(await gate.check("bash", { command: "ls -la", timeout: 99_999 })).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("bash: 不同 command → 不共享 grant", async () => {
    const prompt = makePrompt(["always", "always", "yes"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      grants,
      prompt,
      defaultDecision: "confirm",
    });
    await gate.check("bash", { command: "ls" });
    await gate.check("bash", { command: "ls" }); // grant 命中
    await gate.check("bash", { command: "pwd" }); // 不同 command → 重新弹
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(grants.size).toBe(2);
  });

  it("fetch: grant key 按 url 而不是整个 argsHash", async () => {
    const prompt = makePrompt(["always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      grants,
      prompt,
      defaultDecision: "confirm",
    });
    await gate.check("fetch", { url: "https://api.x.com", method: "GET" });
    // 第二次 method 字段变化 → 仍命中同一 grant
    expect(await gate.check("fetch", { url: "https://api.x.com", method: "POST" })).toBe(
      true,
    );
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe("InteractiveGate — 无规则 + 默认 confirm 场景", () => {
  // bugfix-10：用户场景是「permissionsConfig 为空 → ruleAction 永远 null → 默认 confirm」。
  // 之前 L159 的 grant 命中检查写死 `ruleAction === "confirm"`，导致这种场景下
  // always 加的 grant 永远不被检查，每次都重新弹窗。
  it("always → 后续同 args 直接走 grant，不再问（默认 confirm）", async () => {
    const prompt = makePrompt(["always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]), // 空引擎，所有调用 ruleAction=null
      grants,
      prompt,
      defaultDecision: "confirm", // 默认走 confirm
    });
    const args = { command: "ls" };
    // 第 1 次：询问 → always
    expect(await gate.check("bash", args)).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(grants.size).toBe(1);

    // 第 2 次：应当直接走 grant，不再问
    expect(await gate.check("bash", args)).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1); // 没增加
  });

  it("defaultDecision=allow 时不查 grants（语义合理：默认就放行）", async () => {
    const prompt = makePrompt([]);
    const grants = new GrantsCache();
    grants.add("bash", "fakehash");
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      grants,
      prompt,
      defaultDecision: "allow",
    });
    // 默认 allow 直接放行，不询问、不查 grants（grant 在 allow 默认路径上无意义）
    expect(await gate.check("bash", { command: "ls" })).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("different args → 重新询问（grant 按 argsHash 区分）", async () => {
    const prompt = makePrompt(["always", "always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      grants,
      prompt,
      defaultDecision: "confirm",
    });
    await gate.check("bash", { command: "ls" }); // always → grant A
    await gate.check("bash", { command: "git status" }); // 不同 args，再问 → always → grant B
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(grants.size).toBe(2);

    // 第 3 次同 ls → 走 grant A
    await gate.check("bash", { command: "ls" });
    expect(prompt).toHaveBeenCalledTimes(2);
    // 第 4 次同 git status → 走 grant B
    await gate.check("bash", { command: "git status" });
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});

describe("InteractiveGate — grantKeyFor（path 级别 grant）", () => {
  // bugfix-11：multi_edit / edit_file 的 args 含 oldText/newText/edits 数组，
  // 每次模型生成内容不同，argsHash 永远不一样，"always" 形同虚设。
  // 默认 grantKeyFor 改为「args 含 path → path grant；否则 → argsHash grant」，
  // 与 WriteConfirmGate 语义对齐。

  it("multi_edit 同 path 不同 edits → 第二次走 grant（用户场景）", async () => {
    const prompt = makePrompt(["always", "always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      grants,
      prompt,
      defaultDecision: "confirm",
    });

    // 第 1 次：oldText=A → always（按 path grant）
    await gate.check("multi_edit", {
      path: "test.ts",
      edits: [{ oldText: "A", newText: "B" }],
    });
    expect(prompt).toHaveBeenCalledTimes(1);

    // 第 2 次：oldText=C（同 path 不同内容）→ 命中 grant，不再问
    await gate.check("multi_edit", {
      path: "test.ts",
      edits: [{ oldText: "C", newText: "D" }],
    });
    expect(prompt).toHaveBeenCalledTimes(1); // 没增加
  });

  it("edit_file 同 path 不同 oldText → 第二次走 grant", async () => {
    const prompt = makePrompt(["always", "always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      grants,
      prompt,
      defaultDecision: "confirm",
    });

    await gate.check("edit_file", {
      path: "src/foo.ts",
      oldText: "foo",
      newText: "bar",
    });
    await gate.check("edit_file", {
      path: "src/foo.ts",
      oldText: "different content",
      newText: "different new",
    });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("不同 path → 仍要重新询问（grant 按 path 隔离）", async () => {
    const prompt = makePrompt(["always", "always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      grants,
      prompt,
      defaultDecision: "confirm",
    });

    await gate.check("multi_edit", { path: "a.ts", edits: [] });
    await gate.check("multi_edit", { path: "b.ts", edits: [] });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(grants.size).toBe(2);
  });

  it("bash 仍按 argsHash grant（无 path 字段时回退）", async () => {
    const prompt = makePrompt(["always", "always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      grants,
      prompt,
      defaultDecision: "confirm",
    });

    await gate.check("bash", { command: "git push origin main" });
    await gate.check("bash", { command: "git push origin main" }); // 同 args → 走 grant
    expect(prompt).toHaveBeenCalledTimes(1);

    await gate.check("bash", { command: "rm -rf foo" }); // 不同 args → 重问
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("grantKeyFor 自定义：可按业务定制（如 git push 拆 origin/branch）", async () => {
    const prompt = makePrompt(["always", "always"]);
    const grants = new GrantsCache();
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      grants,
      prompt,
      defaultDecision: "confirm",
      // 自定义：bash 命令按下划线拆分（演示用，实际可按 git push 的 remote/branch 拆）
      grantKeyFor: (toolName, args) => {
        if (toolName !== "bash") return `${toolName}:${hashArgs(args)}`;
        const cmd = (args as Record<string, unknown>).command;
        return typeof cmd === "string" ? `bash:${cmd.split(" ")[0]}` : "";
      },
    });

    // 第 1 次：git push origin main → grant key = "bash:git"
    await gate.check("bash", { command: "git push origin main" });
    // 第 2 次：git status → 同 grant key "bash:git" → 走 grant，不再问
    await gate.check("bash", { command: "git status" });
    expect(prompt).toHaveBeenCalledTimes(1);

    // 第 3 次：npm install → 不同 grant key "bash:npm" → 重问
    await gate.check("bash", { command: "npm install" });
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});

describe("InteractiveGate — 决策日志", () => {
  it("onDecision 记录每个决策的最终动作与路径", async () => {
    const decisions: Array<{ finalAction: string; via: string; toolName: string }> = [];
    const gate = new InteractiveGate({
      engine: new PermissionEngine([
        { tool: "bash", action: "allow" },
        { tool: "edit_file", action: "confirm" },
      ]),
      defaultDecision: "confirm",
      prompt: makePrompt(["yes", "yes"]), // edit_file + grep 各一次
      onDecision: (d) =>
        decisions.push({ finalAction: d.finalAction, via: d.via, toolName: d.toolName }),
    });

    await gate.check("bash", { command: "ls" }); // rule=allow → allow via=rule
    await gate.check("edit_file", { path: "a.ts" }); // rule=confirm → 询问 yes → allow via=prompt
    await gate.check("grep", { pattern: "x" }); // 无规则 + default=confirm → 询问 yes → allow via=prompt

    expect(decisions).toEqual([
      { finalAction: "allow", via: "rule", toolName: "bash" },
      { finalAction: "allow", via: "prompt", toolName: "edit_file" },
      { finalAction: "allow", via: "prompt", toolName: "grep" }, // 无规则 + default=confirm → 走询问
    ]);
  });

  it("default=deny 时记录 via=default", async () => {
    const decisions: Array<{ finalAction: string; via: string }> = [];
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      defaultDecision: "deny",
      prompt: makePrompt([]),
      onDecision: (d) => decisions.push({ finalAction: d.finalAction, via: d.via }),
    });
    await gate.check("bash", { command: "ls" });
    expect(decisions).toEqual([{ finalAction: "deny", via: "default" }]);
  });

  it("deny 规则命中不询问不查 grant", async () => {
    const decisions: Array<{ finalAction: string; via: string }> = [];
    const prompt = makePrompt([]);
    const grants = new GrantsCache();
    grants.add("bash", "fakehash");
    const gate = new InteractiveGate({
      engine: new PermissionEngine([
        { tool: "bash", action: "deny", match: { commandRegex: "^rm" } },
      ]),
      grants,
      prompt,
      onDecision: (d) => decisions.push({ finalAction: d.finalAction, via: d.via }),
    });
    await gate.check("bash", { command: "rm -rf /" });
    expect(decisions).toEqual([{ finalAction: "deny", via: "rule" }]);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("InteractiveGate — 提示原因文本（buildPromptReason）", () => {
  it("confirm 规则有 reason → 返回该 reason", async () => {
    const prompt = vi.fn(async () => "yes" as const);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([
        {
          tool: "bash",
          action: "confirm",
          match: { commandRegex: "^npm install" },
          reason: "install 会修改 node_modules",
        },
      ]),
      prompt,
    });
    await gate.check("bash", { command: "npm install lodash" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "install 会修改 node_modules",
      }),
    );
  });

  it("confirm 规则有 match 但无 reason → 描述 match", async () => {
    const prompt = vi.fn(async () => "yes" as const);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([
        {
          tool: "bash",
          action: "confirm",
          match: { commandRegex: "^git\\s+push" },
        },
      ]),
      prompt,
    });
    await gate.check("bash", { command: "git push" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining("命令正则=^git\\s+push"),
      }),
    );
  });

  it("confirm 规则 match.pathGlob → 描述包含 glob", async () => {
    const prompt = vi.fn(async () => "yes" as const);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([
        {
          tool: "edit_file",
          action: "confirm",
          match: { pathGlob: "**/.env*" },
        },
      ]),
      prompt,
    });
    await gate.check("edit_file", { path: ".env.production" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining("路径 glob=**/.env*"),
      }),
    );
  });

  it("confirm 规则 match.argValueRegex → 描述包含字段", async () => {
    const prompt = vi.fn(async () => "yes" as const);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([
        {
          tool: "fetch",
          action: "confirm",
          match: { argValueRegex: { url: "^https://internal" } },
        },
      ]),
      prompt,
    });
    await gate.check("fetch", { url: "https://internal.com/x" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining("参数规则=url=^https://internal"),
      }),
    );
  });

  it("无规则命中 → 默认说明", async () => {
    const prompt = vi.fn(async () => "yes" as const);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([]),
      defaultDecision: "confirm",
      prompt,
    });
    await gate.check("bash", { command: "ls" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining("没有匹配的规则"),
      }),
    );
  });
});

describe("InteractiveGate — 默认安全行为", () => {
  it("未传 prompt → 询问路径默认拒绝（fail-safe）", async () => {
    const gate = new InteractiveGate({
      engine: new PermissionEngine([{ tool: "bash", action: "confirm" }]),
      // 不传 prompt
    });
    expect(await gate.check("bash", { command: "ls" })).toBe(false);
  });

  it("未传 engine → 视为无规则", async () => {
    const gate = new InteractiveGate({
      prompt: makePrompt(["yes"]),
      defaultDecision: "confirm",
    });
    expect(await gate.check("bash", { command: "ls" })).toBe(true);
  });

  it("未传 grants → 内部建新实例", async () => {
    const prompt = makePrompt(["always"]);
    const gate = new InteractiveGate({
      engine: new PermissionEngine([{ tool: "bash", action: "confirm" }]),
      prompt,
    });
    await gate.check("bash", { command: "ls" }); // 询问 → always
    await gate.check("bash", { command: "ls" }); // 走 grant
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(gate.grants.size).toBe(1);
  });
});

describe("InteractiveGate — 真实集成场景", () => {
  it("git commit → confirm；git status → confirm；用户 always commit 后续同 commit 不问，但 status 仍问", async () => {
    const prompt = makePrompt(["always", "yes"]);
    const engine = new PermissionEngine([
      { tool: "bash", action: "confirm", match: { commandRegex: "^git\\s+commit" } },
      { tool: "bash", action: "confirm", match: { commandRegex: "^git\\s+status" } },
    ]);
    const gate = new InteractiveGate({ engine, prompt });

    const commitArgs = { command: "git commit -m a" }; // 同 args
    await gate.check("bash", commitArgs); // 询问 → always（加 grant）
    await gate.check("bash", commitArgs); // 走 grant（同 argsHash），不再问
    await gate.check("bash", { command: "git status" }); // 不同 args → 走 status 规则 → 询问 → yes

    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("deny 规则优先级最高（即使有 allow 规则）", async () => {
    const engine = new PermissionEngine([
      { tool: "bash", action: "deny", match: { commandRegex: "^rm" } }, // rm 全 deny（必须在 allow 前面）
      { tool: "bash", action: "allow" }, // 默认放行
    ]);
    const prompt = makePrompt([]);
    const gate = new InteractiveGate({ engine, prompt });

    expect(await gate.check("bash", { command: "ls" })).toBe(true); // 不匹配 rm，走 allow
    expect(await gate.check("bash", { command: "rm -rf /tmp/foo" })).toBe(false); // 匹配 rm，走 deny
    expect(prompt).not.toHaveBeenCalled();
  });

  it("argValueRegex 提取的字段值参与匹配", async () => {
    const engine = new PermissionEngine([
      {
        tool: "fetch",
        action: "deny",
        match: { argValueRegex: { url: "^https://internal\\.company\\.com/admin" } },
      },
    ]);
    // 传 prompt=总是 yes 且 defaultDecision=allow，让无规则命中也能放行
    const gate = new InteractiveGate({
      engine,
      prompt: makePrompt(["yes"]),
      defaultDecision: "allow",
    });

    expect(
      await gate.check("fetch", { url: "https://internal.company.com/admin/users" }),
    ).toBe(false);
    expect(await gate.check("fetch", { url: "https://internal.company.com/api" })).toBe(
      true,
    );
  });
});
