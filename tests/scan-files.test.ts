import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { scanProjectFiles, scanProjectFilesFlat } from "../src/utils/scan-files.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dskcode-scan-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("scanProjectFiles", () => {
  it("递归列出 baseDir 下的所有文件", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "");
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "src", "b.ts"), "");
    mkdirSync(join(tmpDir, "src", "nested"));
    writeFileSync(join(tmpDir, "src", "nested", "c.ts"), "");

    const files = await scanProjectFiles(tmpDir);

    expect(files.sort()).toEqual(
      ["a.ts", join("src", "b.ts"), join("src", "nested", "c.ts")].sort(),
    );
  });

  it("跳过 node_modules / .git / 隐藏目录", async () => {
    writeFileSync(join(tmpDir, "keep.ts"), "");
    mkdirSync(join(tmpDir, "node_modules"));
    writeFileSync(join(tmpDir, "node_modules", "skip.ts"), "");
    mkdirSync(join(tmpDir, ".git"));
    writeFileSync(join(tmpDir, ".git", "skip.ts"), "");
    mkdirSync(join(tmpDir, ".hidden"));
    writeFileSync(join(tmpDir, ".hidden", "skip.ts"), "");

    const files = await scanProjectFiles(tmpDir);

    expect(files).toEqual(["keep.ts"]);
  });

  it("directory symlink 自指环不会栈溢出（realpath 去重）", async () => {
    // 构造一个典型的 Windows junction 触发场景：目录里有一个子目录指回自己的 junction
    mkdirSync(join(tmpDir, "loop"));
    writeFileSync(join(tmpDir, "loop", "ok.ts"), "");
    try {
      symlinkSync(tmpDir, join(tmpDir, "loop", "back"), "junction");
    } catch {
      // 当前平台/权限不支持 junction，建一个指向子目录本身的 symlink 也可达成同样效果
      symlinkSync(join(tmpDir, "loop"), join(tmpDir, "loop", "self"), "dir");
    }

    // 不开 maxDepth / 不做修复时会栈溢出；修复后应该在有限时间内返回
    const files = await Promise.race([
      scanProjectFiles(tmpDir),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout — 仍可能存在循环")), 3000),
      ),
    ]);

    // 至少能找到 ok.ts；不能栈溢出
    expect(files).toContain(join("loop", "ok.ts"));
    // 不应把同一文件通过 loop 重复出现
    const occurrences = files.filter((f) => f.endsWith("ok.ts")).length;
    expect(occurrences).toBe(1);
  });

  it("用 realpath 去重不会误杀合法的同名兄弟目录（不同 inode）", async () => {
    mkdirSync(join(tmpDir, "a"));
    mkdirSync(join(tmpDir, "b"));
    writeFileSync(join(tmpDir, "a", "x.txt"), "");
    writeFileSync(join(tmpDir, "b", "y.txt"), "");

    const files = await scanProjectFiles(tmpDir);

    expect(files.sort()).toEqual([join("a", "x.txt"), join("b", "y.txt")].sort());
  });

  it("maxDepth=1 只扫当前目录", async () => {
    writeFileSync(join(tmpDir, "top.ts"), "");
    mkdirSync(join(tmpDir, "sub"));
    writeFileSync(join(tmpDir, "sub", "deep.ts"), "");

    const files = await scanProjectFiles(tmpDir, undefined, 1);

    expect(files).toEqual(["top.ts"]);
  });
});

describe("scanProjectFilesFlat", () => {
  it("默认深度上限避免在含深目录的项目上无限递归", async () => {
    // 构造一个深目录链，深度超过默认上限
    let cur = tmpDir;
    const depth = 30;
    for (let i = 0; i < depth; i++) {
      const next = join(cur, `d${i}`);
      mkdirSync(next);
      writeFileSync(join(cur, `f${i}.ts`), "");
      cur = next;
    }

    const files = await scanProjectFilesFlat(tmpDir);

    // 默认上限 8 层；超过的层级文件不应出现（粗略用段长度判断）
    const maxDepthHit = files.some((f) => f.split(sep).length > 10);
    expect(maxDepthHit).toBe(false);
    // 浅层文件应被扫到
    expect(files.some((f) => f === `f0.ts`)).toBe(true);
  });
});
