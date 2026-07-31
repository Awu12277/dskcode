import type { Command } from "commander";
import chalk from "chalk";

export function customHelp(program: Command): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold("用法:"));
  lines.push(`  ${chalk.cyan("dskcode")} ${chalk.dim("[options]")}`);
  lines.push("");

  const globalOpts = program.options.filter(
    (o) => o.long !== "--help" && o.long !== "--version",
  );
  if (globalOpts.length > 0) {
    lines.push(chalk.bold("选项:"));
    for (const opt of globalOpts) {
      const flags = [opt.short, opt.long].filter(Boolean).join(", ");
      lines.push(`  ${chalk.cyan(flags.padEnd(24))} ${opt.description ?? ""}`);
    }
    lines.push("");
  }

  lines.push(chalk.bold("内置选项:"));
  for (const flag of ["-h, --help", "-V, --version"]) {
    const opt = program.options.find(
      (o) => o.long === (flag.includes("help") ? "--help" : "--version"),
    );
    if (opt) {
      lines.push(`  ${chalk.cyan(flag.padEnd(24))} ${opt.description ?? ""}`);
    }
  }
  lines.push("");

  lines.push(chalk.bold("示例:"));
  lines.push(`  ${chalk.dim("# 启动交互式对话")}`);
  lines.push("  dskcode");
  lines.push("");

  return lines.join("\n");
}
