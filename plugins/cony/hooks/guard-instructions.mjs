import { basename, dirname, relative } from "node:path";

import { findConyRoot, output, readInput, rememberRoot } from "./lib.mjs";

const input = readInput();
const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

const root = findConyRoot(dirname(filePath));
if (!root) process.exit(0);
rememberRoot(input.session_id, root);

const rel = relative(root, filePath).split("\\").join("/");
if (rel === ".cony/board.md") rememberRoot(input.session_id, root, "lead");
const isProtected = basename(filePath) === "CLAUDE.md" || rel.startsWith(".claude/");
if (!isProtected) process.exit(0);

// "ask" 는 auto 모드에서 자동 승인될 수 있어 보호가 되지 않는다.
output({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `[cony] ${rel} 은(는) 사람이 정한 내용만 들어가는 지침 파일이라 Claude가 수정할 수 없습니다. 사용자가 원한 변경이면 바꿀 내용을 제시하고 사용자가 직접 수정하게 하세요. 팀 작업 중이면 보고서의 "규칙 제안"에 적으세요.`,
  },
});
