import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandPlaceholders,
  loadContextFiles,
  renderContextFiles,
} from "../../src/agent/context-files.ts";

const root = join(tmpdir(), `dskcode-context-${Date.now()}`);
const repo = join(root, "repo");
const cwd = join(root, "repo", "apps", "app");
mkdirSync(cwd, { recursive: true });

// home/AGENTS.md (全局约定，比 cwd 更浅)
writeFileSync(join(root, "AGENTS.md"), "GLOBAL-AGENTS\n");
// repo/AGENTS.md (项目级，屏蔽子目录同名)
writeFileSync(join(repo, "AGENTS.md"), "REPO-AGENTS\n");
// repo/CLAUDE.md (项目级 CLAUDE，未被父目录屏蔽)
writeFileSync(join(repo, "CLAUDE.md"), "REPO-CLAUDE\n");
// repo/apps/AGENTS.md (应当被父目录 repo/AGENTS.md 屏蔽)
mkdirSync(join(root, "repo", "apps"), { recursive: true });
writeFileSync(join(root, "repo", "apps", "AGENTS.md"), "APP-AGENTS\n");

const files = loadContextFiles({ cwd, stopAt: root });

console.log("---files (shallow → deep)---");
for (const f of files) console.log(f.relativePath, "|", f.filename, "|", f.content);

console.log("---rendered---");
console.log(renderContextFiles(files));

console.log("---expanded---");
console.log(
  expandPlaceholders(
    "cwd=${cwd:-/}, who=${WHO:-anon}, ESC=$$ ${MISSING} ${USED} ${USED:-fallback}",
    { cwd: "D:/repo", USED: "ok" },
  ),
);

rmSync(root, { recursive: true, force: true });
