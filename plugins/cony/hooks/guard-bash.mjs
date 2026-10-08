import { findConyRoot, output, readInput } from "./lib.mjs";

const input = readInput();
const command = input.tool_input?.command ?? "";
if (!command || !findConyRoot(input.cwd ?? process.cwd())) process.exit(0);

const DENY = [
  [/--no-verify\b/, "커밋 전 검사(husky)를 우회할 수 없습니다. 실패 원인을 고치세요."],
  [/\bgit\s+commit\b[^|;&]*--amend\b/, "기존 커밋을 고치지 말고 새 커밋을 만드세요."],
  [/\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/, "force push는 허용되지 않습니다."],
];

const ASK = [
  [/\bgit\s+push\b/, "push는 외부에 공개되는 작업입니다."],
  [/\bgit\s+reset\s+--hard\b/, "커밋하지 않은 작업이 사라집니다."],
  [/\bgit\s+clean\s+-\w*f/, "추적하지 않는 파일이 삭제됩니다."],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, "작업 트리의 변경이 사라집니다."],
  [/\brm\s+-\w*(rf|fr)\w*\b/, "재귀 삭제입니다."],
  [/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, "데이터가 삭제됩니다."],
  [/\b(prisma\s+migrate\s+reset|supabase\s+db\s+reset|db:reset)\b/, "DB가 초기화됩니다."],
];

for (const [pattern, reason] of DENY) {
  if (pattern.test(command)) {
    output({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[cony] ${reason}`,
      },
    });
    process.exit(0);
  }
}

for (const [pattern, reason] of ASK) {
  if (pattern.test(command)) {
    output({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `[cony] ${reason} 사용자 확인이 필요합니다.`,
      },
    });
    process.exit(0);
  }
}
