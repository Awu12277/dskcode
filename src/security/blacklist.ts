// ---------------------------------------------------------------------------
// 硬编码终端安全规则（Hardcoded Blacklist）
//
// 设计动机：
// LLM 跑 bash 工具可能因为 prompt injection 或对长命令的误解，写出
// `rm -rf /`、`rm -rf ~`、`curl ... | sh` 这类破坏性命令。本模块把这些
// 永远不应该放行的"灾难模式"集中在这里，**不允许用户配置覆盖**。
//
// 借鉴 Zed 的 `zed/crates/agent/src/tool_permissions.rs::HARDCODED_SECURITY_RULES`：
//   - 正则常量定义在最上面，按"危险程度"分组（rm / fs / curl-pipe / git push）
//   - `matchesHardcodedBlacklist()` 入口只接受命令字符串，返回 boolean
//   - 测试覆盖"基础 + 各种 flags 绕过 + 路径展开绕过"
//
// 设计简化：
// - 用「前缀 flags + target + 后缀 flags」的灵活模式（不强制 anchor 末尾）
// - 链式命令用 `&&`/`||`/`;`/换行 拆分后分别校验
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

/**
 * 匹配"前置 flags"：可重复 0 次或多次，每次匹配一组长/短 flag + 空格。
 *
 * 例：`-rf `、`-rfv `、`--recursive --force `、`--force -r `。
 */
const LEADING_FLAGS = String.raw`(?:--[a-zA-Z0-9][-a-zA-Z0-9_]*(?:=[^\s]*)?\s+|-[a-zA-Z]+\s+)*`;

/**
 * 匹配"可选的 `--` 终止符"。
 */
const DD = String.raw`(?:--\s+)?`;

/**
 * 匹配"尾部 flags"（GNU rm 允许 path operand 之后跟 flags）。
 */
const TRAILING_FLAGS = String.raw`(?:\s+--[a-zA-Z0-9][-a-zA-Z0-9_]*(?:=[^\s]*)?|\s+-[a-zA-Z]+)*`;

/**
 * 硬编码 deny 正则列表。
 *
 * 顺序无关（每条独立匹配），按"危险类别"分组便于维护。
 * 所有规则**不区分大小写**。
 */
/** path 后必须接非路径分隔符（防 ~/Desktop/... 误拦） */
const PATH_END = String.raw`(?:[\s;&|]|$)`;

export const HARDCODED_TERMINAL_DENY: readonly RegExp[] = [
  // ─────────────────────────────────────────────────────────────────────
  // 组 1：rm 递归删除关键目录
  // ─────────────────────────────────────────────────────────────────────

  // rm [-flags] [--] / 或 /*（根目录）
  // 匹配：rm -rf /、rm -rfv /、rm -rf /*、rm / -rf、rm -- /、rm -rf -- /
  new RegExp(String.raw`\brm\s+${LEADING_FLAGS}${DD}/\*?${TRAILING_FLAGS}${PATH_END}`),

  // rm [-flags] [--] ~ 或 ~/（用户主目录）
  // 匹配：rm -rf ~、rm -rf ~/、rm -rf ~/*、rm ~ -rf、rm -- ~
  // 必须 path_end = 非路径分隔符，防 ~/Desktop 误拦
  new RegExp(String.raw`\brm\s+${LEADING_FLAGS}${DD}~/?\*?${TRAILING_FLAGS}${PATH_END}`),

  // rm [-flags] [--] $HOME 或 ${HOME}（变量形式的主目录）
  // 匹配：rm -rf $HOME、rm -rf ${HOME}、rm -rf $HOME/*、rm $HOME -rf
  new RegExp(
    String.raw`\brm\s+${LEADING_FLAGS}${DD}\$\{?HOME\}?(?:/|\*)?(?:[^\s/]*\*)?${TRAILING_FLAGS}${PATH_END}`,
  ),

  // rm [-flags] [--] . 或 ./（当前目录！）
  // 匹配：rm -rf .、rm -rf ./、rm -rf ./*、rm . -rf
  // 必须 path_end = 非路径分隔符，防 ./build 误拦
  // 注意：.* 放选项里让 ./* 也命中；但路径字符后不能再有其他路径分隔符（即不能是 ./build 这种合法子目录）
  new RegExp(
    String.raw`\brm\s+${LEADING_FLAGS}${DD}\.(?:/\*?|/\.\.?/?\*?|\*)?${TRAILING_FLAGS}${PATH_END}`,
  ),

  // rm [-flags] [--] .. 或 ../（父目录）
  // 匹配：rm -rf ..、rm -rf ../、rm -rf ../*、rm .. -rf
  new RegExp(
    String.raw`\brm\s+${LEADING_FLAGS}${DD}\.\.(?:/\*?|/\.\.?/?\*?|\*)?${TRAILING_FLAGS}${PATH_END}`,
  ),

  // ─────────────────────────────────────────────────────────────────────
  // 组 2：磁盘 / 设备文件破坏
  // ─────────────────────────────────────────────────────────────────────

  // mkfs.* /dev/sda 或 nvme
  // 匹配：mkfs.ext4 /dev/sda、mkfs.xfs /dev/nvme0n1
  new RegExp(
    String.raw`\bmkfs(?:\.\w+)?\s+(?:-[\w]+\s+)*/dev/(?:sd[a-z]\d*|nvme\w+|hd[a-z]\d*|vd[a-z]\d*|mmcblk\d+)\b`,
  ),

  // dd of=/dev/sda / hd / nvme
  // 匹配：dd if=/dev/zero of=/dev/sda、dd of=/dev/nvme0n1 bs=1M
  new RegExp(
    String.raw`\bdd\s+[^|;&]*\s+of=/dev/(?:sd[a-z]|nvme\w+|hd[a-z]|vd[a-z]|mmcblk\d+)\b`,
  ),

  // ─────────────────────────────────────────────────────────────────────
  // 组 3：递归 chmod 777 关键路径
  // ─────────────────────────────────────────────────────────────────────

  // chmod -R 777 /（不允许递归给根开 777）
  new RegExp(String.raw`\bchmod\s+${LEADING_FLAGS}-R\s+777?\s+/(?:\s|$|;|&&|\|\||\*)`),

  // ─────────────────────────────────────────────────────────────────────
  // 组 4：从网络拉取脚本直接执行
  // ─────────────────────────────────────────────────────────────────────

  // curl ... | sh / bash / zsh
  // 匹配：curl https://x.com/install.sh | sh、curl -sSL ... | bash
  new RegExp(
    String.raw`\bcurl\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish|ash)\b`,
  ),

  // wget ... | sh / bash
  new RegExp(
    String.raw`\bwget\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish|ash)\b`,
  ),

  // ─────────────────────────────────────────────────────────────────────
  // 组 5：强制推送到主干
  // ─────────────────────────────────────────────────────────────────────

  // git push --force 到 main / master
  new RegExp(
    String.raw`\bgit\s+push\s+(?:[^|;&]*\s)?--?(?:force|f)\b[^|;&]*\b(?:origin\s+)?(?:main|master)\b`,
  ),
];

/**
 * 判断一条 shell 命令是否命中硬编码黑名单。
 *
 * 行为：
 * - 大小写不敏感（flags 大写小写都拦）
 * - 多个子命令用 `&&` / `||` / `;` / 换行串接时，**任一子命令命中即视为命中**
 *   （防止 `ls && rm -rf /` 这种链式绕过）
 * - 末尾的 `;` `&` 空白容忍
 *
 * @param command — 完整 shell 命令字符串
 * @returns true 表示"灾难模式，必须拦截"
 *
 * @pure 不修改任何外部状态
 */
export function matchesHardcodedBlacklist(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;

  // 整体先过一次（防整体匹配）
  if (matchesAnyPattern(command)) return true;

  // 拆子命令再过（防 && || ; 链式绕过）
  const subCommands = splitOnShellChains(command);
  for (const sub of subCommands) {
    if (matchesAnyPattern(sub)) return true;
  }

  return false;
}

/**
 * 命令对黑名单中任意正则命中即返回 true。
 */
function matchesAnyPattern(command: string): boolean {
  for (const re of HARDCODED_TERMINAL_DENY) {
    if (re.test(command)) return true;
  }
  return false;
}

/**
 * 按 shell 链式操作符（`&&` / `||` / `;` / 换行）拆分命令为子命令数组。
 *
 * 不处理管道 `|`（管道两边各自传给下一条命令，从安全角度两边都要查）。
 *
 * 输出不含空字符串；保留原顺序。
 */
function splitOnShellChains(command: string): string[] {
  const parts: string[] = [];
  const re = /(?:&&|\|\||;|\n)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const part = command.slice(lastIdx, m.index).trim();
    if (part.length > 0) parts.push(part);
    lastIdx = m.index + m[0].length;
  }
  const tail = command.slice(lastIdx).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}
