// ---------------------------------------------------------------------------
// CLI 入口 — dskcode 命令行
//
// 使用 @earendil-works/pi-tui 终端 UI 框架。
// ---------------------------------------------------------------------------

import { Command } from "commander";
import chalk from "chalk";
import { CostTracker } from "../provider/cost-tracker.js";
import { loadConfigMiddleware } from "./middleware.js";
import type { DskcodeContext } from "./middleware.js";
import { customHelp } from "./help.js";
import { hasApiKey, promptForApiKey } from "./api-key-setup.js";
import { saveApiKey, loadAndValidate, ensurePermissionsConfig } from "../config/index.js";
import { loadAllSkills } from "../skill/loader.js";
import { selectCatalogSkills } from "../skill/catalog.js";
import { scanProjectFilesFlat } from "../utils/scan-files.js";
import { VERSION } from "../utils/version.js";
import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { ChatApp } from "../ui/tui/chat-app.js";

export function createCli(): Command {
  // stock 子命令已迁移到 stocking
  if (process.argv[2] === "stock") {
    console.log(chalk.yellow("⚠ dskcode stock 已迁移到独立 CLI `stocking`。"));
    console.log(
      chalk.dim("  请使用：npx stocking              # 读取 ~/.stocking/settings.json"),
    );
    process.exit(0);
  }

  const program = new Command();
  program.exitOverride();

  program
    .name("dskcode")
    .description("基于 DeepSeek 的 AI 编程助手终端工具")
    .version(VERSION, "-V, --version", "显示版本号")


  program.helpInformation = () => customHelp(program);

  program.hook("preAction", async (thisCommand, actionCommand) => {
    const ctx = await loadConfigMiddleware.call(thisCommand);
    (actionCommand as unknown as Record<string, unknown>).dskcodeCtx = ctx;
  });

  // 无参启动对话
  program.action(async function () {
    await runChat(this as unknown as Record<string, unknown>);
  });

  return program;
}

async function runChat(self: Record<string, unknown>): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("dskcode chat 需要交互式终端。");
    process.exit(1);
  }

  let ctx = self.dskcodeCtx as DskcodeContext | undefined;

  // API Key 检查
  if (ctx && !hasApiKey(ctx.config.providers)) {
    const key = await promptForApiKey();
    if (!key) process.exit(1);

    const savedPath = await saveApiKey(key);
    console.log(`  ${chalk.green("✔")} API Key 已保存到 ${chalk.dim(savedPath)}\n`);

    const result = await loadAndValidate();
    ctx = { ...ctx, config: result.config };
  }

  // 权限配置
  const permPath = await ensurePermissionsConfig();
  if (permPath && ctx) {
    const result = await loadAndValidate();
    ctx = { ...ctx, config: result.config };
    console.log("  ✔ 已生成权限配置: " + permPath);
    console.log("    提示: 可编辑上述文件添加 permissions 规则");
  }

  // 加载 skills（完整类型，用于斜杠命令展开）并计算 system prompt 目录
  const [skillResult, files] = await Promise.all([
    loadAllSkills(process.cwd()),
    scanProjectFilesFlat(process.cwd()),
  ]);
  const catalogResult = selectCatalogSkills(skillResult.skills);
  const skills = skillResult.skills;

  // 成本追踪
  const costTracker = new CostTracker({
    budgetLimit: ctx?.config.budgetLimit ?? 0,
    tokenBudgetLimit: ctx?.config.tokenBudgetLimit ?? 0,
  });

  const defaultProvider = ctx?.config.providers.find(
    (p) => p.name === (ctx?.config.defaultProvider ?? "deepseek"),
  );

  // 创建 pi-tui 终端 UI
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const app = new ChatApp(tui, {
    skills,
    files,
    costTracker,
    permissionsConfig: ctx?.config.permissions,
    model: defaultProvider?.model ?? "deepseek-v4-flash",
    apiKey: defaultProvider?.apiKey,
    baseUrl: defaultProvider?.baseUrl ?? "https://api.deepseek.com",
    providerName: ctx?.config.defaultProvider ?? "deepseek",
    thinking: ctx?.config.thinking,
  });

  // 将 skill catalog 注入到 Session 的 system prompt 中
  app.setSkillCatalog(catalogResult.catalog);

  // 启动 TUI
  tui.start();

  // 阻塞等待直到进程退出（pi-tui 通过 Ctrl+C 双击退出）
  await new Promise<void>(() => {
    // 进程会被 process.exit() 终止，不会 resolve
  });
}
