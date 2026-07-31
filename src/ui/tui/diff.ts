// ---------------------------------------------------------------------------
// Diff 渲染：把 agent-term 的 unified diff patch 格式转换为带行号 + 染色的
// 终端输出。
//
// 输入格式（来自 src/tool/diff.ts 的 formatUnifiedDiff 等）：
//   --- a/file
//   +++ b/file
//   @@ -A,B +C,D @@
//    context line          (前缀单空格)
//   -removed line
//   +added line
//
// 输出：string[]，每行形如：
//   ` <oldLine>  context`       （灰）
//   `-<oldLine>  removed`       （红 + inverse 高亮）
//   `+<newLine>  added`         （绿 + inverse 高亮）
// 单行修改（1 removed + 1 added 紧邻）触发 inverse 内联反色。
//
// 参考：pi/packages/coding-agent/src/modes/interactive/components/diff.ts
// ---------------------------------------------------------------------------

import * as Diff from "diff";
import { styles } from "./theme.js";

/** 解析后的一行 diff（带计算出的行号） */
interface ParsedLine {
  /** "+" / "-" / " " */
  prefix: "+" | "-" | " ";
  /** 当前行号（context/remove 来自 old，add 来自 new） */
  lineNum: number;
  /** 行内容（不含前缀/行号） */
  content: string;
}

/**
 * 解析 hunk 头 `@@ -A,B +C,D @@`（或 `-A +C`）。
 */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  // 容忍可选尾部 section heading："@@ -A,B +C,D @@ optional heading"
  const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

/**
 * 把无行号的 patch 转成带行号的解析后行列表。
 * 从 hunk 头读取 oldStart / newStart 作为该 hunk 的行号基线。
 * 文件头（---/+++）会被丢弃。
 */
function parsePatch(patch: string): ParsedLine[] {
  const rawLines = patch.split("\n");
  const out: ParsedLine[] = [];

  // 跟踪当前 hunk 的行号基线。初始 0，遇到 @@ 头时重置为头里声明的 oldStart/newStart - 1
  // （因为下面遇到实际行时 +1，所以预填 - 1）
  let oldLine = 0;
  let newLine = 0;

  for (const line of rawLines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;

    if (line.startsWith("@@")) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        // 重新设置基线：首行将 -1 后再 +1 = hunk.oldStart
        oldLine = hunk.oldStart - 1;
        newLine = hunk.newStart - 1;
      }
      continue;
    }

    if (line.length === 0) continue; // 末尾空行

    const prefix = line[0];
    const content = line.slice(1);

    if (prefix === "+") {
      newLine++;
      out.push({ prefix: "+", lineNum: newLine, content });
    } else if (prefix === "-") {
      oldLine++;
      out.push({ prefix: "-", lineNum: oldLine, content });
    } else if (prefix === " ") {
      oldLine++;
      newLine++;
      out.push({ prefix: " ", lineNum: oldLine, content });
    } else {
      // 未知行（前缀不是 +/-/空格），当成 context 渲染
      oldLine++;
      newLine++;
      out.push({ prefix: " ", lineNum: oldLine, content: line });
    }
  }

  return out;
}

/** 把 tab 替换为 3 空格（与 coding-agent 一致） */
function replaceTabs(s: string): string {
  return s.replace(/\t/g, "   ");
}

/**
 * 渲染一对 removed/added 行的内联 word-level diff。
 * 公共部分原样，变化部分用 inverse 反色。
 * 首段前导空白不反色（避免缩进被高亮）。
 */
function renderIntraLineDiff(
  oldContent: string,
  newContent: string,
): { removedLine: string; addedLine: string } {
  const wordDiff = Diff.diffWords(oldContent, newContent);

  let removedLine = "";
  let addedLine = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of wordDiff) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
        value = value.slice(leadingWs.length);
        removedLine += leadingWs;
        isFirstRemoved = false;
      }
      if (value) {
        removedLine += styles.inverse(value);
      }
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
        value = value.slice(leadingWs.length);
        addedLine += leadingWs;
        isFirstAdded = false;
      }
      if (value) {
        addedLine += styles.inverse(value);
      }
    } else {
      removedLine += part.value;
      addedLine += part.value;
    }
  }

  return { removedLine, addedLine };
}

/**
 * 渲染 patch 字符串为带 ANSI 颜色的逐行数组。
 * 适配 agent-term 内部 patch 格式（无行号，由本函数补行号）。
 */
export function renderDiffLines(patch: string): string[] {
  if (!patch) return [];
  const parsed = parsePatch(patch);
  if (parsed.length === 0) return [];

  const result: string[] = [];
  let i = 0;

  while (i < parsed.length) {
    const cur = parsed[i]!;

    if (cur.prefix === "-") {
      // 收集连续 removed
      const removedGroup: ParsedLine[] = [];
      while (i < parsed.length && parsed[i]!.prefix === "-") {
        removedGroup.push(parsed[i]!);
        i++;
      }
      // 收集紧接的连续 added
      const addedGroup: ParsedLine[] = [];
      while (i < parsed.length && parsed[i]!.prefix === "+") {
        addedGroup.push(parsed[i]!);
        i++;
      }

      // 单行修改 → 内联反色
      if (removedGroup.length === 1 && addedGroup.length === 1) {
        const removed = removedGroup[0]!;
        const added = addedGroup[0]!;
        const { removedLine, addedLine } = renderIntraLineDiff(
          replaceTabs(removed.content),
          replaceTabs(added.content),
        );
        result.push(
          styles.toolDiffRemoved(
            `-${String(removed.lineNum).padStart(4)} ${removedLine}`,
          ),
        );
        result.push(
          styles.toolDiffAdded(`+${String(added.lineNum).padStart(4)} ${addedLine}`),
        );
      } else {
        for (const r of removedGroup) {
          result.push(
            styles.toolDiffRemoved(
              `-${String(r.lineNum).padStart(4)} ${replaceTabs(r.content)}`,
            ),
          );
        }
        for (const a of addedGroup) {
          result.push(
            styles.toolDiffAdded(
              `+${String(a.lineNum).padStart(4)} ${replaceTabs(a.content)}`,
            ),
          );
        }
      }
    } else if (cur.prefix === "+") {
      // 单独 + 行（紧接 - 已经在上面处理）
      result.push(
        styles.toolDiffAdded(
          `+${String(cur.lineNum).padStart(4)} ${replaceTabs(cur.content)}`,
        ),
      );
      i++;
    } else {
      // context
      result.push(
        styles.toolDiffContext(
          ` ${String(cur.lineNum).padStart(4)} ${replaceTabs(cur.content)}`,
        ),
      );
      i++;
    }
  }

  return result;
}
