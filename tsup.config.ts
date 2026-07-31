import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	target: "node18",
	clean: true,
	dts: true,
	sourcemap: true,
	minify: true,
	shims: true,
	external: [
		// yaml 是 CJS 包，bundling 会生成 __require shim 且在 ESM 下失败
		"yaml",
	],
	onSuccess: "node scripts/copy-prompts.mjs",
});
