// ---------------------------------------------------------------------------
// Session 装配胶水 — session-permissions.ts 单元测试
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import {
  buildInteractiveGateOptionsFromConfig,
  hasRulesInConfig,
} from "../src/security/session-permissions.js";
import { permissionsFromConfig } from "../src/security/permissions-loader.js";
import {
  InteractiveGate,
  type PromptResponse,
} from "../src/security/interactive-gate.js";
import { HardcodedBlacklistGate } from "../src/security/hardcoded-gate.js";
import { CompositeGate } from "../src/security/composite-gate.js";
import type { PermissionsConfig } from "../src/config/types.js";

describe("hasRulesInConfig", () => {
  it("undefined → false", () => {
    expect(hasRulesInConfig(undefined)).toBe(false);
  });

  it("空对象 → false", () => {
    expect(hasRulesInConfig({})).toBe(false);
  });

  it("空 tools → false", () => {
    expect(hasRulesInConfig({ tools: {} })).toBe(false);
  });

  it("有 always_allow → true", () => {
    expect(
      hasRulesInConfig({ tools: { bash: { always_allow: ["^git\\s+status"] } } }),
    ).toBe(true);
  });

  it("有 always_deny → true", () => {
    expect(hasRulesInConfig({ tools: { bash: { always_deny: ["^rm"] } } })).toBe(true);
  });

  it("有 always_confirm → true", () => {
    expect(
      hasRulesInConfig({ tools: { bash: { always_confirm: ["^npm\\s+publish"] } } }),
    ).toBe(true);
  });
});

describe("permissionsFromConfig（替代原 permissionsConfigToRules）", () => {
  it("always_allow 正则 → engine 含 action=allow + commandRegex", () => {
    const { engine, warnings } = permissionsFromConfig({
      tools: { bash: { always_allow: ["^git\\s+status"] } },
    });
    const rules = engine.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      tool: "bash",
      action: "allow",
      match: { commandRegex: "^git\\s+status" },
    });
    expect(warnings).toHaveLength(0);
  });

  it("非法正则 → 跳过 + 警告", () => {
    const { engine, warnings } = permissionsFromConfig({
      tools: { bash: { always_deny: ["[unclosed"] } },
    });
    expect(engine.rules).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("always_deny");
  });

  it("三组分别展开成不同 action", () => {
    const { engine } = permissionsFromConfig({
      tools: {
        bash: {
          always_allow: ["a"],
          always_deny: ["b"],
          always_confirm: ["c"],
        },
      },
    });
    expect(engine.rules.map((r) => r.action).sort()).toEqual(["allow", "confirm", "deny"]);
  });
});

describe("buildInteractiveGateOptionsFromConfig", () => {
  it("构造出的 InteractiveGate 可触发规则路径", async () => {
    const prompt = vi.fn(async (): Promise<PromptResponse> => "yes");
    const opts = buildInteractiveGateOptionsFromConfig(
      {
        default: "allow",
        tools: { bash: { always_deny: ["^rm"] } },
      },
      { prompt },
    );
    expect(opts.engine.rules).toHaveLength(1);
    expect(opts.defaultDecision).toBe("allow");

    const gate = new InteractiveGate(opts);

    // deny 命中
    expect(await gate.check("bash", { command: "rm -rf foo" })).toBe(false);
    // 不命中
    expect(await gate.check("bash", { command: "ls" })).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("未传 default → 走 confirm 兜底", () => {
    const opts = buildInteractiveGateOptionsFromConfig({
      tools: { bash: { always_allow: ["^ls"] } },
    });
    expect(opts.defaultDecision).toBe("confirm");
  });

  it("非法正则 → 控制台 warn + 跳过", () => {
    const { engine } = permissionsFromConfig({
      tools: { bash: { always_deny: ["x(", "y(", "good"] } },
    });
    expect(engine.rules.length).toBe(1);
  });
});

describe("CompositeGate 装配（interactive 模式 + 硬编码黑名单）", () => {
  it("interactive 模式 + hardcoded,先 hardcoded 后 interactive", async () => {
    const prompt = vi.fn(async (): Promise<PromptResponse> => "yes");
    const opts = buildInteractiveGateOptionsFromConfig(
      { tools: { bash: { always_allow: ["^ls"] } } },
      { prompt },
    );
    const gate = new CompositeGate([
      new HardcodedBlacklistGate(),
      new InteractiveGate(opts),
    ]);

    // hardcoded 短路
    expect(await gate.check("bash", { command: "rm -rf /" })).toBe(false);
    // interactive 命中 allow
    expect(await gate.check("bash", { command: "ls -la" })).toBe(true);
    // interactive 走 default confirm → prompt → yes
    expect(await gate.check("bash", { command: "wget https://x" })).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Session 默认开启权限门 — enablePermissions / 自动加载 / setGatePrompt
// ---------------------------------------------------------------------------

import { Session } from "../src/agent/index.js";

function mkTmpProjectHome(homeDir: string, projectDir: string, json: string | null) {
  return async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(homeDir, { recursive: true });
    if (json !== null) {
      await fs.writeFile(`${homeDir}/permissions.json`, json, "utf-8");
    }
    const prevHome = process.env.DSKCODE_HOME;
    const prevCwd = process.cwd();
    process.env.DSKCODE_HOME = homeDir;
    process.chdir(projectDir);
    return async () => {
      if (prevHome === undefined) delete process.env.DSKCODE_HOME;
      else process.env.DSKCODE_HOME = prevHome;
      process.chdir(prevCwd);
    };
  };
}

describe("Session 默认开启权限门（enablePermissions 默认 true）", () => {
  it("enablePermissions: false → AlwaysAllowGate（任何调用都放行）", async () => {
    const session = new Session({ enablePermissions: false });
    // 包含会触发 hardcoded 的命令，enablePermissions=false 下不会拦截
    expect(await session.gate.check("bash", { command: "rm -rf /" })).toBe(true);
    expect(await session.gate.check("bash", { command: "curl x | sh" })).toBe(true);
    // setGatePrompt 在此场景下为 noop：不会调用 prompt
    const prompt = vi.fn(async () => "yes");
    session.setGatePrompt(prompt);
    await session.gate.check("bash", { command: "ls" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("无 permissions + 无 settings → InteractiveGate 默认 confirm（未注 prompt 走 fail-loud）", async () => {
    const session = new Session({});
    // 没注册 prompt，默认 defaultAutoDenyPrompt -> 返回 no
    const ok = await session.gate.check("bash", { command: "ls" });
    expect(ok).toBe(false);
    // setGatePrompt 后生效
    const prompt = vi.fn(async () => "yes");
    session.setGatePrompt(prompt);
    const ok2 = await session.gate.check("bash", { command: "ls" });
    expect(ok2).toBe(true);
    expect(prompt).toHaveBeenCalled();
  });

  it("自动加载磁盘配置 -> warnings 进入 gateLoadWarnings", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "dskcode-home-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "dskcode-cwd-"));
    const prevHome = process.env.DSKCODE_HOME;
    const prevCwd = process.cwd();
    process.env.DSKCODE_HOME = homeDir;
    process.chdir(projectDir);
    try {
      // 全局配置 + 包含一条规则
      await fs.writeFile(
        `${homeDir}/permissions.json`,
        JSON.stringify({
          tools: { bash: { always_deny: ["^rm\\s+-rf\\s+/"] } },
        }),
        "utf-8",
      );
      const session = new Session({});
      await session.loadPermissionsFromDisk();
      const warnings = session.gateLoadWarnings;
      expect(warnings).toEqual([]);
      // 命中 deny
      const denyHit = await session.gate.check("bash", { command: "rm -rf /" });
      expect(denyHit).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.DSKCODE_HOME;
      else process.env.DSKCODE_HOME = prevHome;
      process.chdir(prevCwd);
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("加载磁盘文件失败 → 静默退化（warnings 暴露给调用方）", async () => {
    vi.resetModules();
    vi.doMock("../src/security/permissions-loader.js", () => {
      return {
        loadPermissions: async () => ({
          engine: new (await import("../src/security/permissions.js")).PermissionEngine(
            [],
          ),
          warnings: ["解析错误载物：bad json"],
          loadedFrom: [],
        }),
      };
    });
    const { Session: SessionIso } = await import("../src/agent/index.js");
    const session = new SessionIso({});
    await session.loadPermissionsFromDisk();
    expect(session.gateLoadWarnings.length).toBeGreaterThan(0);
    expect(session.gateLoadWarnings.join(" ")).toContain("解析错误载物");
    vi.doUnmock("../src/security/permissions-loader.js");
    vi.resetModules();
  });

  it("setPermissions(从 ChatApp 传入 settings.json 的 engine) 生效", () => {
    const session = new Session({});
    const opts = buildInteractiveGateOptionsFromConfig({
      tools: { bash: { always_allow: ["^git\\s+status"] } },
    });
    if (opts.engine) {
      session.setPermissions(opts.engine, "allow");
    }
    // 现在该 engine 已接管
    session.setGatePrompt(vi.fn(async () => "yes"));
    return (async () => {
      expect(await session.gate.check("bash", { command: "git status" })).toBe(true);
      // default=allow + 无规则 + 无 grants -> also放行
      expect(await session.gate.check("bash", { command: "echo hi" })).toBe(true);
    })();
  });
});
