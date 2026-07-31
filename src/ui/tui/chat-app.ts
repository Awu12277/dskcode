// ---------------------------------------------------------------------------
// 基于 @earendil-works/pi-tui 的聊天应用主组件
//
// 替代 Ink 版 ChatSession.tsx，使用 pi-tui 的 TUI / Box / Text / Input /
// Markdown / SelectList / Loader / Overlay 等组件构建终端 UI。
// ---------------------------------------------------------------------------

import {
  type Component,
  type OverlayHandle,
  type SelectItem,
  TUI,
  Container,
  Box,
  Input,
  Text as PiText,
  Markdown,
  SelectList,
  Spacer,
  matchesKey,
  type Focusable,
  ProcessTerminal,
  visibleWidth,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { SelectPicker } from "./select-picker.js";
import { PermissionPanelSlot } from "./permission-slot.js";
import { Session } from "../../agent/index.js";

import { builtinTools } from "../../tool/index.js";
import type { Skill } from "../../skill/types.js";
import { expandSkillCommand } from "../../skill/expand.js";
import { HardcodedBlacklistGate } from "../../security/hardcoded-gate.js";
import { CompositeGate } from "../../security/composite-gate.js";
import { InteractiveGate } from "../../security/interactive-gate.js";
import type { PromptFn } from "../../security/interactive-gate.js";
import {
  buildInteractiveGateOptionsFromConfig,
  hasRulesInConfig,
} from "../../security/session-permissions.js";
import type { Gate } from "../../tool/types.js";
import type { PromptResponse } from "../../security/interactive-gate.js";
import type {
  PermissionsConfig,
  ThinkingConfig,
} from "../../config/types.js";
import type { CostTracker } from "../../provider/cost-tracker.js";
import { createProvider } from "../../provider/index.js";
import type { ProviderToolCall, UsageInfo } from "../../provider/index.js";
import type { ToolDenial, FileDiff } from "../../tool/types.js";
import { renderDiffLines } from "./diff.js";
import {
  ASSISTANT_BAR,
  formatElapsed,
  formatCost,
  markdownOptions,
  markdownTheme,
  styles,
  wrap,
} from "./theme.js";
import { filterFilesByInput, getAtTrigger } from "../../ui/file-search.js";
import { VERSION } from "../../utils/version.js";
import { HttpClient } from "../../provider/client.js";
import { getBalance } from "../../provider/deepseek-protocol.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface CompletedAssistant {
  content: string;
  toolCalls?: ProviderToolCall[];
  toolResults?: ReadonlyMap<
    string,
    { success: boolean; error?: string; denial?: ToolDenial; diff?: FileDiff }
  >;
  usage?: UsageInfo;
  elapsed?: number;
  cost?: number;
  model?: string;
}

/**
 * 助手消息中的一个“渲染块”。按流事件顺序拼接，渲染时交替出现文本 / 工具调用。
 * - kind: "text" —— 一段 assistant 文本（可能跨多轮 text_delta）
 * - kind: "tool" —— 一个工具调用 + （如果已收到）其结果
 */
type AssistantBlock =
  | { kind: "text"; content: string }
  | {
      kind: "tool";
      call: ProviderToolCall;
      result?: { success: boolean; error?: string; denial?: ToolDenial; diff?: FileDiff };
    };

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  assistantDetail?: CompletedAssistant;
  /**
   * 完整路径块序列：仅在 assistant 消息上设置。
   * 渲染时应按顺序输出，以实现“文本 + 工具交错”的效果。
   */
  blocks?: AssistantBlock[];
  /**
   * 深度思考内容（仅 assistant 消息上设置）。始终显示在终端，
   * 即使本轮响应已完成、且后续轮次滚动后仍保留。
   * 渲染位置：在消息起始 bar 之后、文本/工具块之前。
   */
  reasoning?: string;
}

interface ChatAppProps {
  skills: Skill[];
  files: string[];
  apiKey?: string;
  baseUrl?: string;
  costTracker?: CostTracker;
  model?: string;
  providerName?: string;
  permissionsConfig?: PermissionsConfig;
  /** 深度思考配置。配置后优先于默认开启行为。 */
  thinking?: ThinkingConfig;
}

// ---------------------------------------------------------------------------
// 注册命令
// ---------------------------------------------------------------------------

interface ChatCommand {
  name: string;
  desc: string;
  handler: () => string | void;
}

let commandRegistry = new Map<string, ChatCommand>();

/** 所有可用的斜杠命令元数据（供补全列表用） */
const commandCatalog: Array<{ name: string; desc: string }> = [
  { name: "/help", desc: "显示帮助信息" },
  { name: "/clear", desc: "清空对话历史" },
  { name: "/version", desc: "显示版本信息" },
  { name: "/model", desc: "切换模型" },
  { name: "/thinking", desc: "切换深度思考模式" },
  { name: "/effort", desc: "切换推理等级 High/Max" },

  { name: "/permissions", desc: "查看当前权限规则" },
  { name: "/exit", desc: "退出对话" },
  { name: "/quit", desc: "退出对话" },
];

export function registerCommand(name: string, cmd: Omit<ChatCommand, "name">): void {
  commandRegistry.set(name, { name, ...cmd });
  // 同步到补全目录
  if (!commandCatalog.some((c) => c.name === name)) {
    commandCatalog.push({ name, desc: cmd.desc });
  }
}

function getCommandCandidates(input: string): Array<{ name: string; desc: string }> {
  const m = input.match(/(?:^|\s)\/([^/]*)$/);
  if (!m) return [];
  const query = (m[1] ?? "").toLowerCase();
  if (!query) return input.trimEnd().endsWith("/") ? commandCatalog.slice(0, 6) : [];
  return commandCatalog
    .filter((c) => c.name.toLowerCase().startsWith(`/${query}`))
    .slice(0, 6);
}

// 注册内置命令
registerCommand("/exit", { desc: "退出对话", handler: () => process.exit(0) });
registerCommand("/quit", { desc: "退出对话", handler: () => process.exit(0) });
registerCommand("/help", {
  desc: "显示帮助信息",
  handler: () => {
    const lines = ["可用命令："];
    for (const c of commandCatalog) {
      lines.push(`  ${c.name.padEnd(16)}${c.desc}`);
    }
    return lines.join("\n");
  },
});
registerCommand("/clear", {
  desc: "清空对话历史",
  handler: () => "", // ChatApp handleSubmit 中 /clear 会单独处理，这里仅作注册
});
registerCommand("/version", {
  desc: "显示版本信息",
  handler: () => `dskcode v${VERSION}`,
});
// /model /thinking /effort /plan /code 由 ChatApp 特殊处理，不在这里注册
// 避免补全后带空格跳过这些命令特有的交互

// ---------------------------------------------------------------------------
// 带上下边框的输入框包装组件
// ---------------------------------------------------------------------------

/**
 * 包装 pi-tui Input，在输入框上下各渲染一条横线边框。
 * 将焦点和键盘事件委托给内部 Input。
 * 可选的 autocompleteList 渲染在下边框之后，作为输入框的一部分。
 *
 * 实现说明：
 * 1. 边框色是固定的；只画完整行宽的 `─`，当 width<=0 时退化为空串（避免画全空背景）。
 * 2. `setValue` 只调整 inner 的光标位置（`cursor` 是 private 字段，仍需类型断言），
 *    不再越权重写 `value` 字段，保留 `Input` 的 pasteBuffer/undoStack 一致性。
 * 3. `invalidate` 透传 inner + footer + autocompleteList，避免局部主题/状态变更后缓存不失效。
 *
 * @internal 仅供同包内测试使用，不在 index.ts 公开导出。
 */
export class BorderedInput implements Component, Focusable {
  private inner: Input;
  private prevValue = "";

  /** Focusable 接口：TUI 通过此字段控制焦点 */
  focused = false;

  /** 可选的补全列表（渲染在下边框之后，与输入框紧贴） */
  autocompleteList: SelectList | null = null;
  /** 可选的底部状态栏（渲染在补全列表之后、输入框之下的位置） */
  footer: Component | null = null;

  constructor() {
    this.inner = new Input();
    this.inner.onSubmit = (v) => this.onSubmit?.(v);
    this.inner.onEscape = () => this.onEscape?.();
  }

  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  /** 输入值变化时触发 */
  onChange?: (value: string) => void;

  getValue(): string {
    return this.inner.getValue();
  }

  /**
   * 设置输入框值。
   * @param cursorOffset 距离行末的字符数（0 = 光标位于行末）。
   */
  setValue(value: string, cursorOffset = 0): void {
    this.prevValue = value;
    this.inner.setValue(value);
    // Input.setValue 已把 cursor clamp 到 value.length；这里按需把光标往左移到 offset 处
    // `cursor` 是 private 字段，需要类型断言。Input 内部渲染仅读 cursor，不依赖其他私有状态，
    // 因此这里是唯一被允许的越界写入点。
    const cursor = Math.max(0, value.length - cursorOffset);
    (this.inner as unknown as { cursor: number }).cursor = cursor;
    this.inner.invalidate();
  }

  handleInput(data: string): void {
    // 同步 focus 状态：内部 Input 需要知道焦点才能决定是否输出 CURSOR_MARKER
    this.inner.focused = this.focused;
    this.inner.handleInput(data);
    const newVal = this.inner.getValue();
    if (newVal !== this.prevValue) {
      this.prevValue = newVal;
      this.onChange?.(newVal);
    }
  }

  invalidate(): void {
    this.inner.invalidate();
    this.footer?.invalidate?.();
    this.autocompleteList?.invalidate?.();
  }

  render(width: number): string[] {
    const result: string[] = [];

    // 上边框
    result.push(this.renderBorder(width));

    // 输入框本体
    const inputLines = this.inner.render(width);
    for (const line of inputLines) {
      // 严格遵守 TUI 宽度契约：每行都不能超 width
      result.push(truncateToWidth(line, width, ""));
    }

    // 下边框
    result.push(this.renderBorder(width));

    // 状态栏紧贴输入框下方；补全列表贴在最底（方便交互）
    if (this.footer) {
      for (const line of this.footer.render(width)) {
        result.push(truncateToWidth(line, width, ""));
      }
    }
    if (this.autocompleteList) {
      for (const line of this.autocompleteList.render(width)) {
        result.push(truncateToWidth(line, width, ""));
      }
    }
    return result;
  }

  private renderBorder(width: number): string {
    if (width <= 0) return "";
    const glyph = "\u2500"; // ─
    return wrap(styles.accent(glyph.repeat(width)), "");
  }
}

// ---------------------------------------------------------------------------
// 占位符
// ---------------------------------------------------------------------------

const IDLE_PLACEHOLDERS = [
  "输入消息，Enter 发送 · @ 引用文件 · / 查看命令",
  "输入问题，或使用 /help 查看帮助",
  "问我任何关于代码的问题…",
];

const STREAMING_PLACEHOLDERS = ["思考中…", "AI 正在回复…", "处理请求中…"];

// ---------------------------------------------------------------------------
// 底部状态栏组件（右对齐）
// ---------------------------------------------------------------------------

/**
 * 状态栏：
 *  - 实时显示当前模型 + 账户余额
 *  - 右对齐（用 visibleWidth 准确计算含 CJK/Emoji 的可见列）
 *  - 不接受焦点，不响应键盘（handleInput 保持空）
 *
 * @internal 仅供同包内测试使用，不在 index.ts 公开导出。
 */
export class StatusBar implements Component {
  focused = false;
  wantsKeyRelease = false;

  model = "";
  balance = 0;
  /** 深度思考开启状态，未设置则不渲染该字段 */
  thinkingEnabled?: boolean;
  /** 推理等级（仅 thinkingEnabled=true 时才有意义） */
  thinkingEffort: "high" | "max" = "high";

  handleInput(_data: string): void {}
  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [""];

    // 样式：dim 标签 + accent 模型 + 思考状态（开关主色、等级橙） + gold 余额
    // 已开启 → 主题色（#5686fe）；已关闭 → muted 灰。HIGH/MAX 用橙色高亮。
    const showThinking = this.thinkingEnabled !== undefined;
    const statusText = this.thinkingEnabled ? "已开启" : "已关闭";
    const effortText = this.thinkingEnabled ? this.thinkingEffort.toUpperCase() : "";

    const thinkingSegment = showThinking
      ? "  " +
        styles.dim("思考") +
        ": " +
        (this.thinkingEnabled ? styles.accent(statusText) : styles.muted(statusText)) +
        (effortText ? " " + styles.userBar(effortText) : "")
      : "";

    const text =
      styles.dim("模型") +
      ": " +
      styles.accent(this.model) +
      thinkingSegment +
      "  " +
      styles.dim("余额") +
      ": " +
      styles.gold("\u00A5" + this.balance.toFixed(2));

    // 可见宽度（不含 ANSI）用于右对齐
    const thinkingVisible = showThinking
      ? effortText
        ? `  思考: ${statusText} ${effortText}`
        : `  思考: ${statusText}`
      : "";
    const visible = `模型: ${this.model}${thinkingVisible}  余额: \u00A5${this.balance.toFixed(2)}`;
    const padding = Math.max(0, width - visibleWidth(visible));
    return [truncateToWidth(" ".repeat(padding) + text, width, "")];
  }
}

// ---------------------------------------------------------------------------
// 主聊天应用组件
// ---------------------------------------------------------------------------

export class ChatApp implements Component {
  // pi-tui 组件系统需要的字段
  focused = false;
  wantsKeyRelease = false;

  // 子组件
  private tui: TUI;
  private inputComp: BorderedInput;
  private footerComp: StatusBar;
  // 输入框上方的“预留 1 行”权限面板槽。
  // 始终在主组件树中，位于 inputComp 之前 1 行，
  // 无面板时空行、有面板时被填黄色面板内容。
  private permissionSlot: import("./permission-slot.js").PermissionPanelSlot;

  // ---- 状态 ----
  private _stateVersion = 0;

  // 消息历史
  private displayMessages: DisplayMessage[] = [];

  // render 缓存（只追踪消息变化，避免每次按键都重算 Markdown）
  private _cachedMessageLines: string[] = [];
  private _cacheWidth = -1;
  /** 缓存时的 _messagesVersion，命中则跳过消息渲染 */
  private _cacheMessagesToken = 0;
  /** displayMessages 实际变化时递增 */
  private _messagesVersion = 0;
  /** Markdown 实例级缓存：同一 content+width 复用上一次结果 */
  private _cachedMarkdown: { text: string; width: number; lines: string[] } | null = null;

  /** 添加消息并递增版本号。如果是第一条消息，同时隐藏初始 DskCode 标识。 */
  private addMessage(msg: DisplayMessage): void {
    const wasEmpty = this.displayMessages.length === 0;
    this.displayMessages.push(msg);
    this._messagesVersion++;
    if (wasEmpty) {
      this.permissionSlot.clear();
      this.requestRender();
    }
  }

  /** 清空消息并递增版本号，清空后重新显示 DskCode 标识。 */
  private clearMessages(): void {
    this.displayMessages = [];
    this._messagesVersion++;
    this.permissionSlot.showDskCode();
  }

  // 流式输出
  private isStreaming = false;
  private currentContent = "";
  /** 深度思考内容（仅用于终端展示，不参与最终回复） */
  private currentReasoning = "";
  /**
   * 当前轮的完整块序列。按流事件顺序拼接，末尾可能还留一个未提交的 text 缓冲块。
   * 渲染时按顺序输出 → 实现“文本与工具调用交错”。
   */
  private currentBlocks: AssistantBlock[] = [];
  /** 未提交的 text 缓冲：最后一笔 text_delta 还在追加的块 */
  private currentTextBlock: AssistantBlock | null = null;
  private currentToolCalls: ProviderToolCall[] = [];
  private currentToolResults = new Map<
    string,
    { success: boolean; error?: string; denial?: ToolDenial; diff?: FileDiff }
  >();
  private streamError: string | undefined;

  // 会话
  private sessionRef: Session | null = null;
  private costTracker: CostTracker | undefined;
  private sessionCost = 0;
  /** Skill catalog for system prompt injection */
  private skillCatalog: import("../../agent/types.js").SkillSummaryView[] = [];
  private balance = 0;
  private httpClient = new HttpClient();

  // 模型 / 模式
  private activeModel: string;
  private providerName: string;
  private apiKey?: string;
  private baseUrl?: string;
  private thinkingEnabled = true;
  private thinkingEffort: "high" | "max" = "high";
  private permissionsConfig?: PermissionsConfig;

  // / 命令补全 SelectList（挂在 inputComp 上）
  private cmdSelectList: SelectList | null = null;
  /** 上次 / 查询的原始字符串，用于跳过无变化更新 */
  private lastCmdRawQuery: string | null = null;
  /** 正在执行 completeCmdItem，抑制 onChang 连锁反应 */
  private completingCmd = false;

  // 文件 / skills
  private skills: Skill[];
  private files: string[];
  /** @ 补全 SelectList（挂在 inputComp 上） */
  private atSelectList: SelectList | null = null;
  /** @ 搜索输入（实时跟踪 inputComp 的值变化） */
  private atQuery = "";
  /** 上次 @ 查询的原始字符串，用于跳过无变化更新 */
  private lastAtRawQuery: string | null = null;
  /** 正在执行 completeAtItem，抑制 onChang 连锁反应 */
  private completingAt = false;

  // 占位符轮换
  private idlePlaceholderIdx = 0;
  private idlePlaceholderTimer: ReturnType<typeof setInterval> | null = null;
  private streamingPlaceholderIdx = 0;

  // 双击 Ctrl+C
  private ctrlCPressTime = 0;
  private ctrlCHintShown = false;

  // Overlay handles
  private modelPicker: SelectPicker | null = null;
  // /permissions 选项面板的 picker
  private permissionViewerPicker: SelectPicker | null = null;
  // busyOverlayHandle 保留:其它占用 overlay（如 loading）仍使用该字段。
  private busyOverlayHandle: OverlayHandle | null = null;

  // 权限弹窗 resolve
  private permissionResolver: ((r: PromptResponse) => void) | null = null;

  constructor(tui: TUI, props: ChatAppProps) {
    this.tui = tui;
    this.activeModel = props.model ?? "deepseek-v4-flash";
    this.providerName = props.providerName ?? "deepseek";
    this.apiKey = props.apiKey;
    this.baseUrl = props.baseUrl;
    this.skills = props.skills;
    this.files = props.files;

    // 将 skills 注册为 /skill:name 斜杠命令
    for (const skill of props.skills) {
      const cmdName = `/skill:${skill.name}`;
      if (!commandRegistry.has(cmdName)) {
        registerCommand(cmdName, {
          desc: skill.description ?? "",
          handler: () => `@${skill.name}`,
        });
      }
    }
    this.costTracker = props.costTracker;
    this.permissionsConfig = props.permissionsConfig;

    // 注册 /permissions 为只读选择项。
    // handler 需访问 this -> 在 ChatApp 构造里重写。注册表是模块顶层 Map，
    // 后面 register 会覆盖上面预设的（如果有），这里覆盖回去是唯一。
    registerCommand("/permissions", {
      desc: "查看当前权限状态（只读）",
      handler: () => this.handlePermissionsView(),
    });
    this.sessionCost = 0;
    // 思考开关与等级：配置项优先，未配置则保持字段默认（enabled=true / effort=high）
    if (props.thinking) {
      this.thinkingEnabled = props.thinking.enabled;
      this.thinkingEffort = props.thinking.effort;
    }

    // 创建输入组件（带上下边框）
    this.inputComp = new BorderedInput();
    this.inputComp.onSubmit = (value) => this.handleSubmit(value);
    this.inputComp.onChange = (value) => this.handleInputChange(value);
    this.inputComp.onEscape = () => {
      // 有补全列表时先关闭
      if (this.inputComp.autocompleteList) {
        if (this.cmdSelectList) this.closeCmdOverlay();
        else this.closeAtOverlay();
      }
    };

    // 底部状态栏（嵌入输入框组件输出中，紧贴输入框/补全列表下方）
    this.footerComp = new StatusBar();
    this.footerComp.model = this.activeModel;
    this.footerComp.thinkingEnabled = this.thinkingEnabled;
    this.footerComp.thinkingEffort = this.thinkingEffort;
    this.inputComp.footer = this.footerComp;

    // 权限面板槽：1 行 Component,位于输入框上边框与输入行之间。
    // 无面板时空行,有面板时填黄色面板。请求背景:
    // 以前是 tui.showOverlay 浮动实现,会受 status bar / 输入框边框干扰;
    // 改为嵌入式预留槽后位置稳定,不需绝对定位参数。
    this.permissionSlot = new PermissionPanelSlot(3);
    this.permissionSlot.showDskCode();

    // 组件挂载到 TUI 的渲染顺序：消息区 → 权限面板槽 → 输入框（含 footer）
    tui.addChild(this);
    tui.addChild(this.permissionSlot);
    tui.addChild(this.inputComp);
    tui.setFocus(this.inputComp);

    // 注册全局输入拦截（特殊键）
    tui.addInputListener((data) => this.handleGlobalKey(data));

    // 占位符轮换
    this.idlePlaceholderTimer = setInterval(() => {
      this.idlePlaceholderIdx = (this.idlePlaceholderIdx + 1) % IDLE_PLACEHOLDERS.length;
      if (!this.isStreaming) this.requestRender();
    }, 5000);

    // 异步查询账户余额
    this.fetchBalance();
  }

  /**
   * 设置 Skill catalog，供 Session 构建 system prompt 时注入。
   * 必须在第一次流式调用（创建 Session）之前调用。
   */
  setSkillCatalog(catalog: import("../../agent/types.js").SkillSummaryView[]): void {
    this.skillCatalog = catalog;
  }

  /** 请求重绘 + 同步子组件状态 */
  private requestRender(): void {
    this._stateVersion++;
    this.footerComp.balance = this.balance;
    this.tui.requestRender();
  }

  /** 查询 DeepSeek 账户余额并更新状态栏 */
  private async fetchBalance(): Promise<void> {
    if (!this.apiKey) return;
    try {
      const result = await getBalance(
        this.httpClient,
        this.baseUrl ?? "https://api.deepseek.com",
        this.apiKey,
      );
      if (result.isAvailable && result.balances.length > 0) {
        this.balance = result.balances[0]!.totalBalance;
        this.requestRender();
      }
    } catch {
      // 余额查询失败不报错，静默忽略
    }
  }

  // -----------------------------------------------------------------------
  // 全局键盘处理（在 Input.handleInput 之前执行）
  // -----------------------------------------------------------------------

  private handleGlobalKey(
    data: string,
  ): { consume?: boolean; data?: string } | undefined {
    // 1. Ctrl+C 始终优先处理（流式 → 取消；空闲 → 双击退出）
    if (matchesKey(data, "ctrl+c")) {
      return this.handleCtrlC() ? { consume: true } : { consume: true };
    }

    // 2. @ / / 补全激活时独占输入
    const acList = this.inputComp.autocompleteList;
    if (acList) {
      return this.handleAutocompleteKey(acList, data);
    }

    // 3. 其它 overlay 打开时让 TUI / overlay 自己处理（模型选择不读 overlay，走 autocompleteList）
    return undefined;
  }

  /** 处理 Ctrl+C：流式状态下取消请求；空闲状态下双击退出。 */
  private handleCtrlC(): boolean {
    if (this.isStreaming) {
      this.cancelStreaming();
      return true;
    }
    const now = Date.now();
    if (now - this.ctrlCPressTime < 1500 && this.ctrlCHintShown) {
      this.tui.stop();
      process.exit(0);
    }
    this.ctrlCPressTime = now;
    this.ctrlCHintShown = true;
    this.requestRender();
    setTimeout(() => {
      this.ctrlCHintShown = false;
      this.requestRender();
    }, 1500);
    return true;
  }

  /** 处理补全列表打开时的 ↑↓/Tab/Enter/Esc 键。返回 undefined 表示不消费。 */
  private handleAutocompleteKey(
    acList: SelectList,
    data: string,
  ): { consume?: boolean; data?: string } | undefined {
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      acList.handleInput(data);
      this.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "tab") || matchesKey(data, "return")) {
      const selected = acList.getSelectedItem();
      if (selected) {
        // 三种补全列表互斥：@ / / /模型。按下 Enter 时各自走自己的 commit 逻辑。
        if (this.modelPicker) {
          // SelectList 的 confirm 路径会触发 picker.onSelect，picker 内部已经处理 commit + 关闭。
          acList.handleInput(data);
        } else if (this.cmdSelectList) {
          this.completeCmdItem(selected.value);
        } else {
          this.completeAtItem(selected.value);
        }
      } else if (this.modelPicker) {
        // 没有选中项也调一下（与原 SelectList 行为一致）
        acList.handleInput(data);
      }
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (this.modelPicker) {
        this.modelPicker = null;
        this.inputComp.autocompleteList = null;
        this.requestRender();
      } else if (this.cmdSelectList) {
        this.closeCmdOverlay();
      } else {
        this.closeAtOverlay();
      }
      return { consume: true };
    }
    return undefined;
  }

  // -----------------------------------------------------------------------
  // @ 文件选择（Overlay + SelectList）
  // -----------------------------------------------------------------------

  /** @ 选择列表主题（与默认通用主题一致，这里仅为可读性导出） */
  private static readonly AT_SELECT_THEME = {
    selectedPrefix: (s: string) => styles.highlight("▸ "),
    selectedText: (s: string) => styles.highlight(s),
    description: (s: string) => styles.dim(s),
    scrollInfo: (s: string) => styles.dim(s),
    noMatch: (s: string) => styles.dim(s),
  };

  /**
   * 为嵌入到 BorderedInput.autocompleteList 这种位置构造一个 SelectList：
   * 复用 SelectPicker 的默认主题与构造逻辑，不调用 show()。
   */
  private createEmbeddedSelectList(
    items: SelectItem[],
    theme: typeof ChatApp.AT_SELECT_THEME,
    onSelect: (item: SelectItem) => void,
    onCancel: () => void,
    maxVisible: number,
  ): SelectList {
    const list = new SelectList(items, Math.min(items.length, maxVisible), theme);
    list.onCancel = onCancel;
    list.onSelect = onSelect;
    return list;
  }

  /** 输入变化时由 BorderedInput.onChange 触发，检测 @ 并直接显示/更新文件列表 */
  private handleInputChange(value: string): void {
    // completeAtItem 正在执行 setValue，跳过连锁反应
    if (this.completingAt || this.completingCmd) return;

    // 模型选择中：只要用户开始输入新字符（不只是导航键）就关闭
    if (this.modelPicker) {
      this.modelPicker = null;
      if (this.inputComp.autocompleteList) {
        this.inputComp.autocompleteList = null;
      }
      this.requestRender();
    }

    // / 命令触发态优先于 @（输入框顶部时）
    if (value.trimStart().startsWith("/")) {
      // 有 @ 补全时则先关闭（@ 和 / 不同时出现）
      if (this.atSelectList) this.closeAtOverlay();
      this.handleCmdInputChange(value);
      return;
    } else if (this.cmdSelectList) {
      this.closeCmdOverlay();
    }

    const trigger = getAtTrigger(value);
    if (!trigger) {
      if (this.atSelectList) {
        this.closeAtOverlay();
      }
      return;
    }

    const rawQuery = trigger.query;
    // 查询文本没变 → 跳过
    if (rawQuery === this.lastAtRawQuery) return;
    this.lastAtRawQuery = rawQuery;

    if (!this.atSelectList) {
      this.showAtFileList(rawQuery);
    } else {
      this.updateAtFileList(rawQuery);
    }
  }

  /** 计算匹配的 SelectItem 列表 */
  private computeAtItems(query: string): SelectItem[] {
    const matched = filterFilesByInput(`@${query}`, this.files);
    if (!matched || matched.length === 0) return [];
    return matched.slice(0, 30).map((f) => ({ value: f, label: f }));
  }

  /** 创建 SelectList，挂到复用容器上 */
  private createAtSelectList(items: SelectItem[]): SelectList {
    return this.createEmbeddedSelectList(
      items,
      ChatApp.AT_SELECT_THEME,
      (item) => this.completeAtItem(item.value),
      () => this.closeAtOverlay(),
      10,
    );
  }

  /** 首次展示 @ 文件匹配列表（仅展示有限项） */
  private showAtFileList(rawQuery: string): void {
    const query = rawQuery.trim().toLowerCase();
    this.atQuery = query;

    const items = this.computeAtItems(query);
    if (items.length === 0) return;

    // 精确匹配 → 直接补全
    if (items.length === 1 && items[0]!.value.toLowerCase() === query) {
      this.completeAtItem(items[0]!.value);
      return;
    }

    this.atSelectList = this.createAtSelectList(items);
    this.inputComp.autocompleteList = this.atSelectList;
    this.requestRender();
  }

  /** 更新 @ 文件候选列表（复用 SelectList） */
  private updateAtFileList(rawQuery: string): void {
    const query = rawQuery.trim().toLowerCase();
    this.atQuery = query;

    const items = this.computeAtItems(query);
    if (items.length === 0) {
      this.closeAtOverlay();
      return;
    }

    this.atSelectList = this.createAtSelectList(items);
    this.inputComp.autocompleteList = this.atSelectList;
    this.requestRender();
  }

  /** 关闭 @ 补全 */
  private closeAtOverlay(): void {
    this.atQuery = "";
    this.lastAtRawQuery = null;
    this.atSelectList = null;
    this.inputComp.autocompleteList = null;
    this.requestRender();
  }

  /** 补全选中的 @ 文件 */
  private completeAtItem(value: string): void {
    this.completingAt = true;
    const v = this.inputComp.getValue();
    const atIdx = v.lastIndexOf("@");
    if (atIdx >= 0) {
      const beforeAt = v.slice(0, atIdx);
      // value 后追加一个空格，光标位于该空格之后
      this.inputComp.setValue(`${beforeAt}@${value} `, 0);
    }
    this.closeAtOverlay();
    this.completingAt = false;
    this.requestRender();
  }

  // -----------------------------------------------------------------------
  // / 命令选择（Overlay + SelectList）
  // -----------------------------------------------------------------------

  /** / 选择列表主题（蓝色高亮） */
  private static readonly CMD_SELECT_THEME = {
    selectedPrefix: (s: string) => styles.highlightBlue("▸ "),
    selectedText: (s: string) => styles.highlightBlue(s),
    description: (s: string) => styles.dim(s),
    scrollInfo: (s: string) => styles.dim(s),
    noMatch: (s: string) => styles.dim(s),
  };

  /** / 命令输入变化 */
  private handleCmdInputChange(value: string): void {
    const m = value.match(/(?:^|\s)\/([^/]*)$/);
    if (!m) {
      if (this.cmdSelectList) this.closeCmdOverlay();
      return;
    }
    // 用完整 value 调用 getCommandCandidates，让它判断/提示
    if (value === this.lastCmdRawQuery) return;
    this.lastCmdRawQuery = value;

    if (!this.cmdSelectList) {
      this.showCmdList(value);
    } else {
      this.updateCmdList(value);
    }
  }

  /** 计算 / 命令候选 */
  private computeCmdItems(value: string): SelectItem[] {
    return getCommandCandidates(value).map((c) => ({
      value: c.name,
      label: c.name,
    }));
  }

  /** 创建 / 命令 SelectList */
  private createCmdSelectList(items: SelectItem[]): SelectList {
    return this.createEmbeddedSelectList(
      items,
      ChatApp.CMD_SELECT_THEME,
      (item) => this.completeCmdItem(item.value),
      () => this.closeCmdOverlay(),
      8,
    );
  }

  /** 首次展示 / 命令补全 */
  private showCmdList(rawQuery: string): void {
    const items = this.computeCmdItems(rawQuery);
    if (items.length === 0) return;

    this.cmdSelectList = this.createCmdSelectList(items);
    this.inputComp.autocompleteList = this.cmdSelectList;
    this.requestRender();
  }

  /** 更新 / 命令候选列表 */
  private updateCmdList(rawQuery: string): void {
    const items = this.computeCmdItems(rawQuery);
    if (items.length === 0) {
      this.closeCmdOverlay();
      return;
    }

    this.cmdSelectList = this.createCmdSelectList(items);
    this.inputComp.autocompleteList = this.cmdSelectList;
    this.requestRender();
  }

  /** 关闭 / 命令补全 */
  private closeCmdOverlay(): void {
    this.lastCmdRawQuery = null;
    this.cmdSelectList = null;
    this.inputComp.autocompleteList = null;
    this.requestRender();
  }

  /** 补全选中的 / 命令 */
  private completeCmdItem(value: string): void {
    this.completingCmd = true;
    this.inputComp.setValue(`${value} `);
    this.closeCmdOverlay();
    this.completingCmd = false;
    this.requestRender();
  }

  // -----------------------------------------------------------------------
  // 文件搜索 Overlay（Ctrl+P）

  // -----------------------------------------------------------------------
  // 命令处理
  // -----------------------------------------------------------------------

  private handleSubmit(text: string): void {
    if (!text || this.isStreaming) return;
    // 接受任意尾部空格，取首个非空 token 作为命令名
    const trimmed = text.trim();
    if (!trimmed) return;
    const cmdName = trimmed.split(/\s+/)[0]!;

    // 所有命令被消费后都要清空输入框（/skill: 除外——它会把命令体替换为 @name 留在输入框里）。
    // 在分支之前重置，不会在错误路径下进不了清空。
    const clearInputAfter = (): void => {
      this.inputComp.setValue("");
      this.requestRender();
    };

    // /skill:name [args] → 展开 skill 内容作为消息发送
    if (trimmed.startsWith("/skill:")) {
      if (this.isStreaming) return;
      this.startSkillExpand(trimmed);
      return;
    }

    // 内置命令
    const cmd = commandRegistry.get(cmdName);
    if (cmd) {
      if (cmdName === "/clear") {
        this.clearMessages();
        this.sessionRef?.reset();
        clearInputAfter();
        return;
      }
      if (cmdName === "/exit" || cmdName === "/quit") {
        // handler 中已调用 process.exit
        return;
      }
      const result = cmd.handler();
      if (result) {
        this.addMessage({ role: "assistant", content: result });
      }
      clearInputAfter();
      return;
    }

    // /model
    if (cmdName === "/model") {
      this.showModelSelector();
      clearInputAfter();
      return;
    }

    // /thinking 切换
    if (cmdName === "/thinking") {
      this.thinkingEnabled = !this.thinkingEnabled;
      this.footerComp.thinkingEnabled = this.thinkingEnabled;
      this.addMessage({
        role: "assistant",
        content: `深度思考已${this.thinkingEnabled ? "开启" : "关闭"}`,
      });
      this.requestRender();
      clearInputAfter();
      return;
    }

    // /effort 切换
    if (cmdName === "/effort") {
      this.thinkingEffort = this.thinkingEffort === "high" ? "max" : "high";
      this.footerComp.thinkingEffort = this.thinkingEffort;
      this.addMessage({
        role: "assistant",
        content: `推理等级已切换为 ${this.thinkingEffort.toUpperCase()}`,
      });
      this.requestRender();
      clearInputAfter();
      return;
    }

    // 普通用户消息（保留原文本，包括尾部空格/换行语义）
    this.addMessage({ role: "user", content: trimmed });
    this.inputComp.setValue("");
    this.requestRender();

    // API Key 检查
    if (!this.apiKey) {
      this.addMessage({
        role: "assistant",
        content:
          "❌ 未配置 API Key。\n请在 ~/.dskcode/settings.json 的 providers[0].apiKey 填入 DEEPSEEK_API_KEY，或者设置环境变量 DEEPSEEK_API_KEY。",
      });
      this.requestRender();
      return;
    }

    // 开始流式调用
    this.startStreaming(trimmed);
  }

  // -----------------------------------------------------------------------
  // Skill 展开
  // -----------------------------------------------------------------------

  /**
   * 展开 /skill:<name> [args] 命令为 skill envelope 并发送给 LLM。
   * 与 coding-agent _expandSkillCommand 语义一致。
   */
  private async startSkillExpand(text: string): Promise<void> {
    this.inputComp.setValue("");
    this.requestRender();

    const expanded = await expandSkillCommand(text, this.skills);
    if (!expanded) {
      this.addMessage({
        role: "assistant",
        content: `❌ 未找到 skill，请检查 / 命令列表`,
      });
      this.requestRender();
      return;
    }

    this.startStreaming(expanded);
  }

  // -----------------------------------------------------------------------
  // 模型选择器 Overlay
  // -----------------------------------------------------------------------

  private async showModelSelector(): Promise<void> {
    try {
      const { SUPPORTED_MODELS } = await import("../../provider/models.js");
      const models = Object.values(SUPPORTED_MODELS).map((m) => m.id);
      const items: SelectItem[] = models.map((m) => ({ value: m, label: m }));

      // 互斥：@ / / 补全在显示时，先关闭
      if (this.atSelectList) this.closeAtOverlay();
      if (this.cmdSelectList) this.closeCmdOverlay();

      const picker = new SelectPicker(this.tui, {
        items,
        initialValue: this.activeModel,
        // 不传 title/hint → 视觉与 /命令选择一致（绿色高亮、无标题、无底部 hint）
        onSelect: (item) => {
          this.activeModel = item.value;
          this.addMessage({
            role: "assistant",
            content: `已切换模型到: ${item.value}`,
          });
          closePicker();
        },
        onCancel: () => {
          closePicker();
        },
      });
      const list = picker.getSelectList();

      // closePicker 必须在 list 赋值之后定义（闭包读 list 不能在 TDZ）。
      // 模型选择与 @ / / 互斥，所以可以简单置空 autocompleteList。
      const closePicker = (): void => {
        this.modelPicker = null;
        this.inputComp.autocompleteList = null;
        this.requestRender();
      };

      this.modelPicker = picker;
      this.inputComp.autocompleteList = list;
      this.requestRender();
    } catch (err) {
      this.addMessage({
        role: "assistant",
        content: `加载模型列表失败：${err instanceof Error ? err.message : String(err)}`,
      });
      this.requestRender();
    }
  }

  // -----------------------------------------------------------------------
  // 权限弹窗
  // -----------------------------------------------------------------------

  showPermissionPrompt(ctx: {
    toolName: string;
    reason: string;
    args?: Record<string, unknown>;
  }): Promise<PromptResponse> {
    return new Promise<PromptResponse>((resolve) => {
      this.permissionResolver = resolve;

      // 3 行结构：
      //   行 1:   🔐 权限审批  <toolName>
      //   行 2:   原因 / bash 命令预览（如有）
      //   行 3:   [1] Yes  [2] No  [3] Always
      // 浅灰背景面板（permissionPanelBgG）与消息流区分。
      // 选项部分允许更新（箭头键切换高亮后重渲）。
      // 选项颜色：
      //   Yes    = 深绿 #1a7f37（GitHub 风格，与“放行”语义一致）
      //   No     = 红   #ff6b6b（与 styles.error 同色）
      //   Always = 浅绿 #7fdc67（“保持”语义）
      const options: Array<{
        key: string;
        label: string;
        value: PromptResponse;
        color: string;
      }> = [
        { key: "1", label: "Yes", value: "yes", color: "26;127;55" },
        { key: "2", label: "No", value: "no", color: "255;107;107" },
        { key: "3", label: "Always", value: "always", color: "127;220;127" },
      ];
      let highlightIdx = 0;
      const renderOptionsLine = (): string =>
        options
          .map((opt, i) => {
            // 不用 \x1b[0m(全局重置会取消面板 bg)。
            // 面板背景下需要"选中"显示:依赖 fg + 加粗 + 下划线，不动 bg。
            const fg = `\x1b[38;2;${opt.color}m`;
            return i === highlightIdx
              ? ` ${fg}\x1b[1m\x1b[4m[${opt.key}] ${opt.label}\x1b[24m\x1b[22m`
              : ` ${fg}[${opt.key}] ${opt.label}\x1b[39m`;
          })
          .join(" ");

      /** 行 1：标题 + 工具名。
       *
       * 注意：不能用 `\x1b[0m`(完整重置),会让上下文中的背景染色被取消。
       * 这里只重置 fg 默认 (\x1b[39m) 与关粗体 (\x1b[22m),不动 bg。
       */
      const buildTitleLine = (): string => {
        const titleOpen = "\x1b[38;2;255;165;0m\x1b[1m";
        const titleClose = "\x1b[22m\x1b[39m";
        return `${titleOpen}🔐 权限审批  ${titleClose}\x1b[1m${ctx.toolName}\x1b[22m`;
      };

      /** 行 2：选项（不再显示原因 / 命令预览，用户要求极简面板） */
      const buildOptionsLine = renderOptionsLine;

      /**
       * 整行染色 + 两侧 padding。与 renderUserLine 同样的“面板块”设计。
       *   输入 inner = 原始文本(含前景色 ANSI)，输出 1 行完整染色化后字符串
       *   逻辑：对 visible 计算，输入两侧各加 1 格 padding，末尾补齐到 width。
       */
      /**
       * 完整色面板化一行可见宽度为 width：
       * - 整行被 permissionPanelBgG（浅灰）染色
       * - 左 1 列 padding + truncated 内容 + 右填充至 width
       * - 输出可见宽度 === width，严格后续 truncateToWidth（保证不超
       */
      /**
       * 完整染色一行至 width：与 renderUserLine 同一逻辑：
       *   1. innerMaxWidth = width - 2 预留两侧个 1 padding
       *   2. truncate 内容到 innerMaxWidth
       *   3. inner = " " + truncated
       *   4. fill = max(0, width - visibleWidth(inner))
       *   5. 输出 = BG_OPEN + inner + " ".repeat(fill) + BG_CLOSE
       *
       * 注意：renderUserLine 使用拼接后单独染色，这里逆思了：content + padded
       * 都用同一 bgFn 包，保证整行背景透出。
       */
      const wrapLine = (inner: string, width: number): string => {
        if (width <= 0) return "";
        const innerMaxWidth = Math.max(0, width - 2);
        const truncated =
          visibleWidth(inner) > innerMaxWidth
            ? truncateToWidth(inner, innerMaxWidth, "")
            : inner;
        const innerWithPad = " " + truncated;
        const visible = visibleWidth(innerWithPad);
        const fill = Math.max(0, width - visible);
        return styles.permissionPanelBgG(innerWithPad + " ".repeat(fill));
      };

      /** 空槽也涂背景色，保持 3 行占位整体染色一致。 */
      const paintBlankSlot = (width: number): void => {
        const blank = styles.permissionPanelBgG(" ".repeat(width));
        const lines: string[] = [];
        for (let i = 0; i < 3; i++) lines.push(blank);
        this.permissionSlot.setContent(lines);
        this.requestRender();
      };

      const paintSlot = (): void => {
        const w = this.tui.terminal?.columns ?? 0;
        if (w <= 0) {
          // 启动期保护：使用 80 上限
          const fallback = 80;
          this.permissionSlot.setContent([
            wrapLine(buildTitleLine(), fallback),
            wrapLine(buildOptionsLine(), fallback),
          ]);
          this.requestRender();
          return;
        }
        const targetWidth = Math.max(w, 40);
        this.permissionSlot.setContent([
          wrapLine(buildTitleLine(), targetWidth),
          wrapLine(buildOptionsLine(), targetWidth),
        ]);
        this.requestRender();
      };

      paintSlot();

      // 解决函数：负责选择后清理。唯一调用方。
      const dispose = (): (() => void) => {
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          this.permissionResolver = null;
          this.permissionSlot.clear();
          this.requestRender();
        };
      };
      const cleanup = dispose();
      const resolveWith = (value: PromptResponse): { consume: true } => {
        const r = this.permissionResolver;
        cleanup();
        listenerDispose();
        r?.(value);
        return { consume: true };
      };

      // 全局输入监听处理权限面板的按键。
      const listenerDispose = this.tui.addInputListener((data) => {
        if (!this.permissionResolver) return undefined;

        if (matchesKey(data, "escape")) {
          return resolveWith("no");
        }
        if (matchesKey(data, "enter") || matchesKey(data, "return")) {
          const opt = options[highlightIdx];
          if (opt) return resolveWith(opt.value);
          return { consume: true };
        }
        if (matchesKey(data, "left")) {
          highlightIdx = (highlightIdx - 1 + options.length) % options.length;
          paintSlot();
          return { consume: true };
        }
        if (matchesKey(data, "right")) {
          highlightIdx = (highlightIdx + 1) % options.length;
          paintSlot();
          return { consume: true };
        }
        // 数字键 1/2/3
        const byKey = options.find((o) => o.key === data);
        if (byKey) {
          return resolveWith(byKey.value);
        }
        return undefined;
      });
    });
  }

  /**
   * /permissions 命令处理：弹出 SelectList 选项菜单（只读），选中后 addMessage 打印概要。
   *
   * 设计动机：
   * - 用户可以在交互中随时打开“当前生效的安全状态”面板（make-selectable item）。
   * - 避免引入编辑 UI / 持久化状态，仅 read-only 展示。
   *
   * 选项：
   *  1. 查看规则摘要（default 决策 / 实际生效规则条数）
   *  2. 查看 grants 缓存（仅 InteractiveGate 相关）
   *  3. 查看硬编码黑名单概要（仅列举 5 类，不调 bash）
   *  0. 取消
   *
   * 备注：
   * - 回调为同步；addMessage + requestRender 只在选中后同步触发。
   * - 不重 input 焦点，SelectPicker 会拦截输入且完成后自动释放。
   */
  private handlePermissionsView(): void {
    const perms = this.permissionsConfig;
    const ruleSummary: string = hasRulesInConfig(perms)
      ? (() => {
          const opts = buildInteractiveGateOptionsFromConfig(perms!);
          const count = opts.engine?.rules.length ?? 0;
          const def = perms?.default ?? "confirm";
          const allow =
            perms!.tools &&
            Object.entries(perms!.tools)
              .map(([t, r]) => {
                const lines: string[] = [];
                for (const k of [
                  "always_allow",
                  "always_deny",
                  "always_confirm",
                ] as const) {
                  const arr = r?.[k];
                  if (Array.isArray(arr) && arr.length > 0) {
                    lines.push(`  - ${t}.${k}: ${arr.length} 条`);
                  }
                }
                return lines.join("\n");
              })
              .filter((s) => s.length > 0)
              .join("\n");
          return (
            `当前 InteractiveGate 生效，规则总数 ${count}，default=${def}\n` +
            `明细：\n${allow || "  （无细则）"}`
          );
        })()
      : "未配置 rules，仅 HardcodedBlacklistGate（写操作由默认 InteractiveGate 接管—— 当前 ChatApp 未启动会话时不生效）。";

    const grantsSummary: string = (() => {
      // 拿不到内部 grants instance 是设计使然（仅 Session 内部使用），
      // 这里只告诉用户“某个确认被记住了”这件事本身是否发生过。
      const tag = this.sessionRef
        ? "已启动 Session；grants 为会话内缓存，提示面板无法跨层访问。"
        : "尚未创建 Session，grants 未初始化。";
      return `grants 是会话级缓存（与命令 argsHash / 文件 path 关联的“以后不再问”票根）。\n${tag}`;
    })();

    const blacklistSummary =
      "【硬编码黑名单】（不可被配置覆盖）：\n" +
      " - rm -rf /、~、$HOME、.、..\n" +
      " - mkfs.* /dev/sd* | dd of=/dev/sd*\n" +
      " - chmod -R 777 /\n" +
      " - curl ... | sh | bash（wget 同）\n" +
      " - git push --force 到 main / master";

    const items: SelectItem[] = [
      { value: "rules", label: "1. 查看规则摘要" },
      { value: "grants", label: "2. 查看 grants 缓存概要" },
      { value: "blacklist", label: "3. 查看硬编码黑名单" },
      { value: "cancel", label: "0. 取消" },
    ];

    // 互斥：@ / 命令 / model 选择不能同时显示
    if (this.modelPicker) return;
    if (this.atSelectList) this.closeAtOverlay();
    if (this.cmdSelectList) this.closeCmdOverlay();

    const picker = new SelectPicker(this.tui, {
      items,
      onSelect: (item) => {
        let content: string;
        switch (item.value) {
          case "rules":
            content = `【规则】\n${ruleSummary}`;
            break;
          case "grants":
            content = `【grants】\n${grantsSummary}`;
            break;
          case "blacklist":
            content = blacklistSummary;
            break;
          default:
            content = "已取消。";
        }
        this.addMessage({ role: "assistant", content });
        closePicker();
      },
      onCancel: () => closePicker(),
    });

    const closePicker = (): void => {
      this.permissionViewerPicker = null;
      this.inputComp.autocompleteList = null;
      this.requestRender();
    };

    this.permissionViewerPicker = picker;
    this.inputComp.autocompleteList = picker.getSelectList();
    this.requestRender();
  }

  // -----------------------------------------------------------------------
  // 流式调用
  // -----------------------------------------------------------------------

  private cancelStreaming(): void {
    // 简化：实际场景需要中断异步流
    this.isStreaming = false;
    const reasoning = this.currentReasoning;
    if (this.currentContent) {
      this.addMessage({
        role: "assistant",
        content: this.currentContent + "\n\n*（已取消）*",
        ...(reasoning ? { reasoning } : {}),
      });
    } else if (reasoning) {
      // 仅推理但未产生文本：也保留思考记录
      this.addMessage({
        role: "assistant",
        content: "",
        reasoning,
      });
    }
    this.currentContent = "";
    this.currentReasoning = "";
    this.currentBlocks = [];
    this.currentTextBlock = null;
    this.currentToolCalls = [];
    this.currentToolResults = new Map();
    this.streamError = undefined;
    this.requestRender();
  }

  private async startStreaming(text: string): Promise<void> {
    // 懒加载 session
    if (!this.sessionRef) {
      const SessionClass = Session;
      const session = new SessionClass({
        cwd: process.cwd(),
        costTracker: this.costTracker,
        thinkingEnabled: this.thinkingEnabled,
        thinkingEffort: this.thinkingEffort,
        skillCatalog: this.skillCatalog.length > 0 ? this.skillCatalog : undefined,
      });
      for (const t of builtinTools) {
        session.registerTool(t);
      }
      this.sessionRef = session;
    }

    // 门由 Session 自身负责装配（默认开启权限门）。
    // 这里仅补上 UI prompt（Session 装配后的 InteractiveGate 默认 prompt 为 fail-loud）。
    // ChatApp 在启动 streaming 时注入 showPermissionPrompt，不重建 gate 链。
    const perms = this.permissionsConfig;
    if (perms && hasRulesInConfig(perms)) {
      // settings.json 有 rules：调用方提供的权限配置覆盖 Session 自动加载的，
      // 把 engine 直接交给 Session。
      const opts = buildInteractiveGateOptionsFromConfig(perms);
      if (opts.engine) {
        this.sessionRef.setPermissions(opts.engine, perms.default);
      }
    }
    this.sessionRef.setGatePrompt((ctx) =>
      this.showPermissionPrompt({
        toolName: ctx.toolName,
        reason: ctx.reason,
        args:
          ctx.args && typeof ctx.args === "object"
            ? (ctx.args as Record<string, unknown>)
            : {},
      }),
    );

    // 创建 provider
    const provider = createProvider({
      name: this.providerName,
      apiKey: this.apiKey!,
      baseUrl: this.baseUrl ?? "https://api.deepseek.com",
      model: this.activeModel,
    });

    // 流式状态
    this.isStreaming = true;
    this.currentContent = "";
    this.currentReasoning = "";
    this.currentBlocks = [];
    this.currentTextBlock = null;
    this.currentToolCalls = [];
    this.currentToolResults = new Map();
    this.streamError = undefined;
    this.streamingPlaceholderIdx = 0;
    this.requestRender();

    let assistantContent = "";
    const seenToolCalls: ProviderToolCall[] = [];
    const toolResults = new Map<
      string,
      { success: boolean; error?: string; denial?: ToolDenial; diff?: FileDiff }
    >();

    // 占位符轮换
    const streamPlaceholderInterval = setInterval(() => {
      this.streamingPlaceholderIdx =
        (this.streamingPlaceholderIdx + 1) % STREAMING_PLACEHOLDERS.length;
      this.requestRender();
    }, 3000);

    try {
      const stream = this.sessionRef.chat(text, { provider });
      for await (const ev of stream) {
        switch (ev.type) {
          case "text_delta":
            assistantContent += ev.content;
            this.currentContent = assistantContent;
            // 追加到 currentTextBlock，未提交则创建
            if (this.currentTextBlock && this.currentTextBlock.kind === "text") {
              this.currentTextBlock = {
                kind: "text",
                content: this.currentTextBlock.content + ev.content,
              };
            } else {
              this.currentTextBlock = { kind: "text", content: ev.content };
            }
            this.requestRender();
            break;
          case "reasoning_delta":
            this.currentReasoning += ev.content;
            this.requestRender();
            break;
          case "tool_calls":
            for (const tc of ev.calls) seenToolCalls.push(tc);
            this.currentToolCalls = [...seenToolCalls];
            // 提交上一个 text 缓冲，创建 tool 块插入序列
            for (const tc of ev.calls) {
              this.commitTextBlock();
              this.currentBlocks.push({ kind: "tool", call: tc });
            }
            this.requestRender();
            break;
          case "tool_result":
            toolResults.set(ev.callId ?? ev.name, {
              success: ev.result.success,
              error: ev.result.error,
              denial: ev.result.denial,
              diff: ev.result.diff,
            });
            this.currentToolResults = new Map(toolResults);
            // 补到最后一个未决的 tool 块上（避免同 callId 多次出现）
            {
              const callId = ev.callId ?? ev.name;
              for (let i = this.currentBlocks.length - 1; i >= 0; i--) {
                const b = this.currentBlocks[i]!;
                if (b.kind === "tool" && b.call.id === callId && !b.result) {
                  b.result = {
                    success: ev.result.success,
                    error: ev.result.error,
                    denial: ev.result.denial,
                    diff: ev.result.diff,
                  };
                  break;
                }
              }
            }
            this.requestRender();
            break;
          case "usage":
          case "done":
            break;
          case "error":
            this.streamError = ev.error.message;
            this.requestRender();
            break;
        }
      }

      // 流式结束：封存
      this.commitTextBlock();
      const blocksSnapshot: AssistantBlock[] = this.currentBlocks.map((b) => ({ ...b }));
      const reasoning = this.currentReasoning;
      this.addMessage({
        role: "assistant",
        content: assistantContent,
        ...(reasoning ? { reasoning } : {}),
        blocks: blocksSnapshot.length > 0 ? blocksSnapshot : undefined,
        assistantDetail: {
          content: assistantContent,
          toolCalls: seenToolCalls.length > 0 ? seenToolCalls : undefined,
          toolResults: toolResults.size > 0 ? toolResults : undefined,
          model: this.activeModel,
        },
      });
      this.sessionCost = this.sessionRef.sessionTotalCost;
    } catch (err) {
      const reasoning = this.currentReasoning;
      this.addMessage({
        role: "assistant",
        content: `❌ 错误：${err instanceof Error ? err.message : String(err)}`,
        ...(reasoning ? { reasoning } : {}),
      });
    } finally {
      clearInterval(streamPlaceholderInterval);
      this.isStreaming = false;
      this.currentContent = "";
      this.currentReasoning = "";
      this.currentBlocks = [];
      this.currentTextBlock = null;
      this.currentToolCalls = [];
      this.currentToolResults = new Map();
      this.requestRender();
    }
  }

  /** 将 currentTextBlock 提交到 currentBlocks，重置为 null。 */
  private commitTextBlock(): void {
    if (
      this.currentTextBlock &&
      this.currentTextBlock.kind === "text" &&
      this.currentTextBlock.content.length > 0
    ) {
      this.currentBlocks.push(this.currentTextBlock);
    }
    this.currentTextBlock = null;
  }

  // -----------------------------------------------------------------------
  // Component 接口实现
  // -----------------------------------------------------------------------

  invalidate(): void {
    // 消息缓存：依赖 version/width token，不需手动清。
    // Markdown 实例缓存：跟随消息重建（on content change），这里只清以防主题变更。
    this._cachedMarkdown = null;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    if (width <= 0) return lines;
    const usableWidth = width - 2;
    const bar = ASSISTANT_BAR;

    // ---- 消息列表（带缓存，避免每次 Markdown 全文重算） ----
    const cacheHit =
      width === this._cacheWidth &&
      this._messagesVersion === this._cacheMessagesToken &&
      !this.isStreaming;

    if (cacheHit) {
      lines.push(...this._cachedMessageLines);
    } else {
      const computed: string[] = [];
      for (const msg of this.displayMessages) {
        if (msg.role === "user") {
          computed.push(...this.renderUserLine(msg.content, width));
        } else if (msg.role === "assistant") {
          computed.push(bar);
          // 深度思考内容：始终显示在文本/工具块之前，灰色斜体。
          if (msg.reasoning) {
            for (const line of msg.reasoning.split("\n")) {
              computed.push(
                truncateToWidth(`${bar} ${styles.thinking(line || " ")}`, width, ""),
              );
            }
          }
          // 优先按 blocks 顺序交错输出（文本与工具调用穿插）
          if (msg.blocks && msg.blocks.length > 0) {
            for (const block of msg.blocks) {
              if (block.kind === "text") {
                if (!block.content) continue;
                const mdLines = this.renderMarkdownCached(block.content, usableWidth - 2);
                for (const l of mdLines) {
                  computed.push(truncateToWidth(`${bar} ${l}`, width, ""));
                }
              } else {
                for (const l of this.renderToolCall(
                  block.call,
                  usableWidth - 2,
                  bar,
                  block.result,
                )) {
                  computed.push(truncateToWidth(l, width, ""));
                }
              }
            }
          } else {
            // 兑底：只有 content（老路径 / 纯文本消息）
            if (msg.content) {
              const mdLines = this.renderMarkdownCached(msg.content, usableWidth - 2);
              for (const l of mdLines) {
                computed.push(truncateToWidth(`${bar} ${l}`, width, ""));
              }
            }
            const detail = msg.assistantDetail;
            if (detail?.toolCalls?.length) {
              for (const tc of detail.toolCalls) {
                const r = detail.toolResults?.get(tc.id);
                for (const l of this.renderToolCall(tc, usableWidth - 2, bar, r)) {
                  computed.push(truncateToWidth(l, width, ""));
                }
              }
            }
          }
          const detail = msg.assistantDetail;
          if (detail?.cost || detail?.elapsed || detail?.usage) {
            computed.push(
              truncateToWidth(
                `${bar} ${styles.dim("\u2500".repeat(Math.min(36, usableWidth - 4)))}`,
                width,
                "",
              ),
            );
            const stats: string[] = [];
            if (detail.cost && detail.cost > 0) {
              stats.push(styles.gold(`\u{1F4B0} ${formatCost(detail.cost)}`));
            }
            if (detail.elapsed !== undefined) {
              stats.push(styles.toolAccent(`\u{1F550} ${formatElapsed(detail.elapsed)}`));
            }
            if (detail.usage) {
              const tokens = (
                detail.usage.promptTokens + detail.usage.completionTokens
              ).toLocaleString();
              stats.push(styles.dim(`\u{1F4E6} ${tokens} tokens`));
            }
            if (stats.length > 0) {
              computed.push(
                truncateToWidth(`${bar} ${stats.join(" \u00B7 ")}`, width, ""),
              );
            }
          }
        }
      }
      this._cachedMessageLines = computed;
      this._cacheWidth = width;
      this._cacheMessagesToken = this._messagesVersion;
      lines.push(...computed);
    }

    // ---- 流式输出（不缓存） ----
    if (this.isStreaming) {
      lines.push(bar);
      if (this.currentReasoning) {
        const reasoningLines = this.currentReasoning.split("\n");
        for (const line of reasoningLines) {
          lines.push(
            truncateToWidth(`${bar} ${styles.thinking(line || " ")}`, width, ""),
          );
        }
      }
      // 按块顺序渲染：已提交的块 + 未提交的 text 缓冲块
      for (const block of this.currentBlocks) {
        if (block.kind === "text") {
          if (!block.content) continue;
          const mdLines = this.renderMarkdownCached(block.content, usableWidth - 2);
          for (const l of mdLines) {
            lines.push(truncateToWidth(`${bar} ${l}`, width, ""));
          }
        } else {
          const r = this.currentToolResults.get(block.call.id);
          for (const l of this.renderToolCall(block.call, usableWidth - 2, bar, r)) {
            lines.push(truncateToWidth(l, width, ""));
          }
        }
      }
      // 未提交的 text 缓冲
      if (
        this.currentTextBlock &&
        this.currentTextBlock.kind === "text" &&
        this.currentTextBlock.content
      ) {
        const mdLines = this.renderMarkdownCached(
          this.currentTextBlock.content,
          usableWidth - 2,
        );
        for (const l of mdLines) {
          lines.push(truncateToWidth(`${bar} ${l}`, width, ""));
        }
      }
      if (!this.currentBlocks.length && !this.currentTextBlock) {
        const ph = STREAMING_PLACEHOLDERS[this.streamingPlaceholderIdx] ?? "…";
        lines.push(truncateToWidth(`${bar} ${styles.dim(ph)}`, width, ""));
      }
      if (this.streamError) {
        lines.push(
          truncateToWidth(
            `${bar} ${styles.error("错误：" + this.streamError)}`,
            width,
            "",
          ),
        );
      }
    }

    // ---- Ctrl+C 提示（不缓存） ----
    if (this.ctrlCHintShown && !this.isStreaming) {
      lines.push(
        truncateToWidth(
          "  \x1b[95m\u26A0 再按一次 Ctrl+C 退出 dskcode\x1b[0m",
          width,
          "",
        ),
      );
    }
    if (this.isStreaming) {
      lines.push(
        truncateToWidth(
          "  \x1b[33m\u2714 提示：按 Ctrl+C 取消当前请求\x1b[0m",
          width,
          "",
        ),
      );
    }

    return lines;
  }

  /**
   * 渲染用户消息块：固定 3 行高度 + 整行满行背景。
   * 布局与 coding-agent UserMessageComponent 对齐（Box(paddingX=1, paddingY=1, bgFn)）。
   * 返回 3 行 ANSI：
   *   行 1：顶 padding（整行背景）
   *   行 2：左 1 空格 padding + 内容（超长截断） + 右 padding 填到 width
   *   行 3：底 padding（整行背景）
   */
  private renderUserLine(content: string, width: number): string[] {
    if (width <= 0) return [];
    const BG_OPEN = "\x1b[48;2;51;32;16m";
    const BG_CLOSE = "\x1b[0m";
    const padRow = BG_OPEN + " ".repeat(width) + BG_CLOSE;

    // 内容行：保留里外各 1 空格作为视觉 padding；可见宽度凑到 width
    const innerWidth = Math.max(0, width - 2);
    const inner = " " + truncateToWidth(content, innerWidth, "") + " ";
    const visible = visibleWidth(inner);
    const fill = Math.max(0, width - visible);
    const middle = BG_OPEN + inner + " ".repeat(fill) + BG_CLOSE;

    return [padRow, middle, padRow];
  }

  // -----------------------------------------------------------------------
  // 辅助渲染
  // -----------------------------------------------------------------------

  /**
   * 用 Markdown 组件渲染文本，并在 (content, width) 维度上复用实例。
   * 内部仍依赖 pi-tui Markdown 的内置渲染缓存。
   */
  private renderMarkdownCached(text: string, maxWidth: number): string[] {
    const cache = this._cachedMarkdown;
    if (cache && cache.text === text && cache.width === maxWidth) {
      return cache.lines;
    }
    let lines: string[];
    try {
      const md = new Markdown(text, 0, 0, markdownTheme, undefined, markdownOptions);
      lines = md.render(maxWidth);
    } catch {
      // 降级：纯文本
      lines = text.split("\n").map((l) => l || " ");
    }
    this._cachedMarkdown = { text, width: maxWidth, lines };
    return lines;
  }

  /**
   * 渲染工具调用块（pi-mono 风格：整行带色背景的 “卡片”）。
   *
   * 调用块与结果块上下排列，统一使用 Box(1, 1, bgFn) 染背景。
   * 背景色由结果状态决定（pending / success / error），
   * 让用户一眼区分执行中、成功、失败。
   *
   * @param call  工具调用
   * @param maxWidth  可用列宽（已扣除竖线 + padding）
   * @param bar  竖线（传给每一行作为前缀）
   * @param result  可选的工具执行结果（用于决状 + 拼接到调用后面）
   */
  private renderToolCall(
    call: ProviderToolCall,
    maxWidth: number,
    bar: string,
    result?: { success: boolean; error?: string; denial?: ToolDenial; diff?: FileDiff },
  ): string[] {
    const name = call.name ?? "unknown";
    const parsedArgs = this.parseToolArgs(call);
    const headline = this.formatToolHeadline(name, parsedArgs, result);
    const resultSummary = this.formatToolResult(name, result);

    // 背景色决状
    const bgFn = this.toolBgFn(result);

    // 紧凑：单行“卡”（成功/pending 各 1 行；失败/被拒加一行错误说明）。
    // 不用 Box（避免上下 padding 导致 3 行），直接用 Text + bgFn 整行染色。
    // 左右 padding 1（空格）也舍弃，以免与头部 bar 的空格重复。
    const lines: string[] = [truncateToWidth(bgFn(headline), maxWidth, "")];
    if (resultSummary) {
      lines.push(truncateToWidth(bgFn(styles.toolOutput(resultSummary)), maxWidth, ""));
    }

    // 文件修改类工具：渲染 diff（带行号 + 红绿行色 + 单行修改 inverse 高亮）
    if (result?.diff?.patch) {
      const diffLines = renderDiffLines(result.diff.patch);
      for (const dl of diffLines) {
        lines.push(truncateToWidth(bgFn(dl), maxWidth, ""));
      }
    }

    // 补上左侧竖线
    return lines.map((l) =>
      truncateToWidth(`${bar} ${l}`, maxWidth + bar.length + 1, ""),
    );
  }

  /** 工具块背景色选择器：pending / success / error */
  private toolBgFn(result?: {
    success: boolean;
    error?: string;
    denial?: ToolDenial;
    diff?: FileDiff;
  }): (s: string) => string {
    if (!result) return styles.toolPendingBg;
    if (result.denial) return styles.toolErrorBg;
    return result.success ? styles.toolSuccessBg : styles.toolErrorBg;
  }

  /** 状态徽章：✓ success / ✗ error / ⛔ denied */
  private statusBadge(result: {
    success: boolean;
    error?: string;
    denial?: ToolDenial;
    diff?: FileDiff;
  }): string {
    if (result.denial) return styles.error("⛔ denied");
    return result.success ? styles.highlight("✓ success") : styles.error("✗ error");
  }

  /** 给 value 上加上引号（仅当含空格 / 不是简单数字时） */
  private quoteIfNeeded(v: unknown): string {
    if (v == null) return String(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v);
    if (s.length > 80) return JSON.stringify(s.slice(0, 77) + "…");
    if (/\s/.test(s) || s === "") return JSON.stringify(s);
    return s;
  }

  /**
   * 从 args 中选取一个可识别为 number 的值。
   * 同时检查多个可能的 key（兼容模型传来不同的字段名），如果值是字符串也尝试转换。
   */
  private pickNumber(
    args: Record<string, unknown>,
    keys: readonly string[],
  ): number | undefined {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
    }
    return undefined;
  }
  /**
   * 解析工具调用参数。返回 key → 原始值。
   * 解析失败返回空对象（不报错）。
   */
  private parseToolArgs(call: ProviderToolCall): Record<string, unknown> {
    if (!call.arguments) return {};
    try {
      const parsed = JSON.parse(
        typeof call.arguments === "string"
          ? call.arguments
          : JSON.stringify(call.arguments),
      );
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 解析失败
    }
    return {};
  }

  /**
   * 工具调用的“主标题行”。
   * 格式：`<图标>  <name>  <主题色路径 / 专用摘要>  <状态徽章>`
   *
   * - 对已知工具走“专用摘要”函数（例如 read_file → `lines 11-14`）。
   * - 其余工具：路径类 key（path / file / file_path / ...）走主题色，
   *   剩余参数不展示（避免过多小字干扰）。
   */
  private formatToolHeadline(
    name: string,
    args: Record<string, unknown>,
    result?: { success: boolean; error?: string; denial?: ToolDenial; diff?: FileDiff },
  ): string {
    const PATH_KEYS = new Set([
      "path",
      "file",
      "file_path",
      "filepath",
      "target",
      "target_path",
      "target_file",
      "cwd",
      "dir",
      "directory",
      "glob",
      "pattern",
      "command",
    ]);

    // 1. 优先走专用摘要（read_file 的 lines 范围）
    const specialized = this.formatToolSpecialized(name, args);
    if (specialized) {
      const title = styles.toolTitle(`🛠  ${name}`);
      const badge = result ? "  " + this.statusBadge(result) : "";
      return `${title}  ${specialized}${badge}`;
    }

    // 2. 默认：路径走主题色，其余参数不展示
    const highlightParts: string[] = [];
    for (const [k, v] of Object.entries(args)) {
      if (PATH_KEYS.has(k)) highlightParts.push(this.quoteIfNeeded(v));
    }

    let line = styles.toolTitle(`🛠  ${name}`);
    if (highlightParts.length > 0) {
      line += "  " + highlightParts.map((p) => styles.accent(p)).join("  ");
    }
    if (result) {
      line += "  " + this.statusBadge(result);
    }
    return line;
  }

  /**
   * 工具专用摘要：仅展示与“动作目标”最相关的信息。
   *
   * 目前支持：
   * - read_file → 路径 + `lines X-Y`（有 startLine / endLine 时）。
   *
   * 返回空字符串表示不适用、走默认逻辑。
   */
  private formatToolSpecialized(name: string, args: Record<string, unknown>): string {
    if (name === "read_file") {
      return this.formatReadFileSummary(args);
    }
    return "";
  }

  /** read_file 专用摘要：<主题色 path> + <小字 lines X-Y> */
  private formatReadFileSummary(args: Record<string, unknown>): string {
    const path = args.path ?? args.file ?? args.file_path ?? args.filepath ?? args.target;
    // 兼容模型传来的小写 / camelCase
    const start = this.pickNumber(args, [
      "startLine",
      "startline",
      "start_line",
      "from_line",
    ]);
    const end = this.pickNumber(args, ["endLine", "endline", "end_line", "to_line"]);

    let out = "";
    if (path != null) {
      out = styles.accent(this.quoteIfNeeded(path));
    }
    if (start !== undefined && end !== undefined) {
      out += "  " + styles.toolOutput(`lines ${start}-${end}`);
    } else if (start !== undefined) {
      out += "  " + styles.toolOutput(`lines ${start}-…`);
    } else if (end !== undefined) {
      out += "  " + styles.toolOutput(`lines 1-${end}`);
    }
    return out;
  }

  /** 拼接结果摘要：错误/被拒跳明，成功后返回 stdout 首行 + 长度 */
  private formatToolResult(
    name: string,
    result?: { success: boolean; error?: string; denial?: ToolDenial; diff?: FileDiff },
  ): string {
    if (!result) return "";
    if (result.denial) {
      return `reason: ${result.denial.reason ?? "permission denied"}`;
    }
    if (!result.success) {
      return `error: ${result.error ?? "unknown"}`;
    }
    // 成功：默认不叠 preview
    return "";
  }
}

// ---------------------------------------------------------------------------
// 创建 TUI 聊天应用
// ---------------------------------------------------------------------------

export function createChatApp(props: ChatAppProps): { tui: TUI; app: ChatApp } {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  // Ctrl+C 退出（raw 模式下 SIGINT 被拦截）
  let ctrlCPressTimeGlobal = 0;
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (now - ctrlCPressTimeGlobal < 100) {
        // 快速双击 → 退出
        tui.stop();
        process.exit(0);
      }
      ctrlCPressTimeGlobal = now;
      return undefined; // 让 ChatApp 处理
    }
    if (matchesKey(data, "ctrl+d")) {
      // Debug 键
      tui.onDebug?.();
      return { consume: true };
    }
    return undefined;
  });

  const app = new ChatApp(tui, props);
  return { tui, app };
}
