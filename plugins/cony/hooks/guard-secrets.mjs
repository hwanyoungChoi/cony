import { basename, dirname } from "node:path";

import { findConyRoot, logEvent, output, readInput } from "./lib.mjs";

// 에이전트가 비밀 파일 내용을 읽지 못하게 한다. 예시 파일(.env.example 등)은 허용한다.
// 스크립트가 내부에서 몰래 읽는 경우는 잡지 못하므로 be 지시문으로 따로 막는다.
const EXAMPLE = /\.(example|sample|template|dist)$/;
const SECRET_NAME = /^(\.env(\..+)?|\.dev\.vars(\..+)?|.+\.pem|.+\.key|id_rsa|id_ed25519|credentials\.json|service-account.*\.json)$/;

function isSecretPath(path) {
  const name = basename(path);
  return SECRET_NAME.test(name) && !EXAMPLE.test(name);
}

const input = readInput();
const cwd = input.cwd ?? process.cwd();

function deny(root, target) {
  logEvent(root, { type: "hook", hook: "guard-secrets", decision: "deny", target });
  output({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[cony] ${target} 은(는) 비밀 파일이라 내용을 읽을 수 없습니다. 키가 있는지 확인이 필요하면 사용자에게 물어보세요. 실제 키로 외부 API를 부르는 일도 사용자 확인 없이 하지 않습니다.`,
    },
  });
  process.exit(0);
}

const tool = input.tool_name;
if (tool === "Read" || tool === "Grep" || tool === "Glob") {
  const target = input.tool_input?.file_path ?? input.tool_input?.path;
  if (target && isSecretPath(target)) {
    const root = findConyRoot(dirname(target));
    if (root) deny(root, basename(target));
  }
  process.exit(0);
}

if (tool === "Bash") {
  const command = input.tool_input?.command ?? "";
  if (!findConyRoot(cwd)) process.exit(0);
  const mentioned = command.split(/[\s'"=<>|;&()]+/).find((token) => token && isSecretPath(token));
  if (mentioned) deny(findConyRoot(cwd), basename(mentioned));
}
