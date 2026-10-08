import { basename, dirname, relative } from "node:path";

import { findConyRoot, output, readInput } from "./lib.mjs";

const input = readInput();
const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

const root = findConyRoot(dirname(filePath));
if (!root) process.exit(0);

const rel = relative(root, filePath).split("\\").join("/");
const isProtected = basename(filePath) === "CLAUDE.md" || rel.startsWith(".claude/");
if (!isProtected) process.exit(0);

output({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: `[cony] ${rel} 은(는) 사람이 정한 내용만 들어가는 지침 파일입니다. 사용자가 직접 요청한 수정이 아니라면 거절하고, 바꾸고 싶은 규칙은 보고서의 "규칙 제안"에 적으세요.`,
  },
});
