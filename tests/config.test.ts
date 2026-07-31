import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadAndValidate } from "../src/config/index.js";

describe("defaultConfig", () => {
  it("should use deepseek as the default provider", () => {
    expect(defaultConfig.defaultProvider).toBe("deepseek");
  });

  it("should include a deepseek provider definition", () => {
    const ds = defaultConfig.providers.find((p) => p.name === "deepseek");
    expect(ds).toBeDefined();
    expect(ds!.baseUrl).toBe("https://api.deepseek.com");
    expect(ds!.model).toBe("deepseek-v4-flash");
  });

  it("should list all 8 built-in tools", () => {
    expect(defaultConfig.tools).toHaveLength(8);
    const names = defaultConfig.tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "bash",
      "edit_file",
      "fetch",
      "glob",
      "grep",
      "ls",
      "read_file",
      "write_file",
    ]);
  });

  it("should not have mcp fields", () => {
    expect((defaultConfig as Record<string, unknown>).mcpServers).toBeUndefined();
    expect((defaultConfig as Record<string, unknown>).plugins).toBeUndefined();
  });
});

describe("loadAndValidate - permissions 合并", () => {
  let tmpHome: string;
  const originalHome = process.env["HOME"];

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "dskcode-cfg-"));
    // HOME 指向临时目录，避免读到真实 ~/.dskcode
    process.env["HOME"] = tmpHome;
  });

  afterEach(() => {
    if (originalHome) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("加载 settings.json 时保留 permissions 段", async () => {
    mkdirSync(join(tmpHome, ".dskcode"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".dskcode", "settings.json"),
      JSON.stringify({
        defaultProvider: "deepseek",
        providers: [{ name: "deepseek", model: "deepseek-v4-flash" }],
        tools: [],
        permissions: { default: "confirm" },
      }),
    );

    const { config } = await loadAndValidate();
    expect(config.permissions).toEqual({ default: "confirm" });
  });
});
