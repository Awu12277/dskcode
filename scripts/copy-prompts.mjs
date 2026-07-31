import { cp, mkdir } from "node:fs/promises";

// 运行时通过 dist/index.js 的 import.meta.url + ./prompts/ 读取模板，
// 因此这里复制到 dist/prompts/，与源代码中的目录层级保持一致。
await mkdir("dist/prompts", { recursive: true });
await cp("src/agent/prompts", "dist/prompts", { recursive: true });
