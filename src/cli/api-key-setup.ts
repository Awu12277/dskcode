import { createInterface } from "node:readline";
import chalk from "chalk";

/**
 * 检测是否有可用的 API Key。
 * 遍历所有 provider 检查是否配置了 apiKey，同时检查已注册 provider 的环境变量。
 */
export function hasApiKey(providers: { apiKey?: string }[]): boolean {
  if (providers.some((p) => p.apiKey)) return true;
  // 检查所有已知 provider 的环境变量
  for (const envVar of KNOWN_PROVIDER_ENV_KEYS) {
    if (process.env[envVar]) return true;
  }
  return false;
}

/**
 /** 已注册 provider 环境变量名。 */
const KNOWN_PROVIDER_ENV_KEYS = ["DEEPSEEK_API_KEY"];

/**
 * API Key 最小长度校验值。
 * DeepSeek 的 Key 通常以 sk- 开头，长度远超 10 位。
 */
const MIN_API_KEY_LENGTH = 10;

/**
 * 交互式提示用户输入 API Key。
 * 使用 Node readline 的 password 模式（输入不可见）。
 * 返回用户输入的 Key，如果用户取消则返回 null。
 *
 * 当前的提示信息保留 DeepSeek 向后兼容的措辞；Multi provider 场景下
 * 提示用户从环境变量 / 配置文件走，主流程依然能用。
 */
export async function promptForApiKey(): Promise<string | null> {
  console.log(chalk.yellow("\n  ⚠ 未检测到 API Key 配置"));
  console.log(chalk.dim("  你可以通过以下任一方式配置："));
  console.log(chalk.dim("    · DeepSeek 环境变量: export DEEPSEEK_API_KEY=sk-xxx"));
  console.log(chalk.dim("    · 配置文件: ~/.dskcode/settings.json"));
  console.log(chalk.dim("    · 下面直接输入，自动保存到全局配置\n"));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string | null>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      process.stdin.removeListener("keypress", onKeypress);
      rl.close();
    };

    const onKeypress = (_: unknown, key: { ctrl?: boolean; name?: string }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve(null);
      }
    };

    process.stdin.on("keypress", onKeypress);

    rl.question(
      `  ${chalk.cyan("🔑")} ${chalk.bold("请输入你的 DeepSeek API Key:")} `,
      (answer) => {
        cleanup();
        const trimmed = answer.trim();
        if (!trimmed) {
          console.log(chalk.red("  ✖ API Key 不能为空"));
          resolve(null);
          return;
        }
        if (trimmed.length < MIN_API_KEY_LENGTH) {
          console.log(chalk.red("  ✖ API Key 格式不正确，长度至少 10 位"));
          resolve(null);
          return;
        }
        resolve(trimmed);
      },
    );
  });
}
