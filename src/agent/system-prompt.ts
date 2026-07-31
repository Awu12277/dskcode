// ---------------------------------------------------------------------------
// 系统提示词构建（从 Markdown 文件读取，保留极简变量渲染）
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SystemPromptOptions, ToolDescription, ProjectInstruction } from "./types.js";
import { renderContextFiles } from "./context-files.js";

const PROMPTS_DIR = fileURLToPath(new URL("./prompts/", import.meta.url));
const SYSTEM_PROMPT_TEMPLATE = readPrompt("system-prompt.md");

/**
 * 从 prompts 目录读取 Markdown 提示词。
 * @param filename - 提示词文件名
 * @returns 提示词模板内容
 */
function readPrompt(filename: string): string {
	return readFileSync(new URL(filename, `file://${PROMPTS_DIR}/`), "utf8");
}

/**
 * 渲染普通变量。
 * @param template - 提示词模板
 * @param vars - 模板变量
 * @returns 渲染后的提示词
 */
function render(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

/**
 * 渲染条件块。
 * @param template - 提示词模板
 * @param condMap - 条件值
 * @returns 渲染后的提示词
 */
function renderConditional(template: string, condMap: Record<string, boolean>): string {
	return template.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) =>
		condMap[key] ? body : "",
	);
}

/**
 * XML 转义。
 */
function xmlEscape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * 格式化工具列表：使用工具自报的 promptSnippet + promptGuidelines。
 *
 * 生成的 XML 锚点供给系统提示词里的 <available_tools> 使用。
 * 工具增删只需在注册时设置 promptSnippet / promptGuidelines，
 * 不再需要修改 Markdown 模板。
 *
 * @param tools - 工具描述列表
 * @returns XML 形式工具列表
 */
function formatToolsList(tools: ToolDescription[] | undefined): string {
	if (!tools || tools.length === 0) return "";
	return tools
		.map((tool) => {
			const summary = tool.promptSnippet ?? tool.description;
			const lines = [`  <tool name="${tool.name}">`, `    ${summary}`];
			if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
				for (const guideline of tool.promptGuidelines) {
					lines.push(`    - ${guideline}`);
				}
			}
			lines.push("  </tool>");
			return lines.join("\n");
		})
		.join("\n");
}

/**
 * 格式化 Skill 列表（XML 格式，与 coding-agent 对齐）。
 *
 * 输出：
 *   <skill>
 *     <name>xxx</name>
 *     <description>xxx</description>
 *     <location>xxx</location>
 *   </skill>
 */
function formatSkillsList(skills: SystemPromptOptions["availableSkills"]): string {
	if (!skills) return "";
	return skills
		.map(
			(skill) =>
				`  <skill>\n` +
				`    <name>${xmlEscape(skill.name)}</name>\n` +
				`    <description>${xmlEscape(skill.description)}</description>\n` +
				`    <location>${xmlEscape(skill.location)}</location>\n` +
				`  </skill>`,
		)
		.join("\n");
}

/**
 * 格式化项目指令块：优先用传入的 projectInstructions，
 * 未传入时回退到 projectContext（外部调用方可覆写）。
 *
 * @param opts - 系统提示词选项
 * @returns XML 块字符串
 */
function formatProjectInstructions(opts: SystemPromptOptions): string {
	if (opts.projectInstructions && opts.projectInstructions.length > 0) {
		return renderContextFiles(
			opts.projectInstructions.map((p) => ({
				path: p.path,
				relativePath: p.path,
				filename: p.filename,
				content: p.content,
			})),
		);
	}
	if (!opts.projectContext) return "";
	return `<project_instructions>\n<source name="inline" path="<projectContext>">\n${opts.projectContext}\n</source>\n</project_instructions>`;
}

/**
 * 构建模板变量。
 * @param opts - 系统提示词选项
 * @returns 模板变量
 */
function buildVars(opts: SystemPromptOptions): Record<string, string> {
	const now = new Date();
	return {
		model: opts.model,
		maxToolRounds: String(opts.maxToolRounds),
		cwd: opts.cwd,
		date: now.toLocaleDateString("zh-CN", {
			year: "numeric",
			month: "long",
			day: "numeric",
			weekday: "long",
		}),
		time: now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
		projectInstructions: formatProjectInstructions(opts),
		toolsList: formatToolsList(opts.tools),
		skillsList: formatSkillsList(opts.availableSkills),
	};
}

/**
 * 构建模板条件。
 * @param opts - 系统提示词选项
 * @returns 条件值
 */
function buildConditions(opts: SystemPromptOptions): Record<string, boolean> {
	const hasInstructions =
		(opts.projectInstructions && opts.projectInstructions.length > 0) ||
		!!opts.projectContext;
	return {
		tools: (opts.tools?.length ?? 0) > 0,
		projectContext: hasInstructions,
		hasSkills: (opts.availableSkills?.length ?? 0) > 0,
	};
}

/**
 * 构建代码模式的系统提示词。
 * @param opts - 系统提示词选项
 * @returns 系统提示词
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
	return render(
		renderConditional(SYSTEM_PROMPT_TEMPLATE, buildConditions(opts)),
		buildVars(opts),
	);
}
