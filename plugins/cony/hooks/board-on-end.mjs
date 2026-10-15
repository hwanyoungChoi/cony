import { writeFileSync } from "node:fs";

import { forgetSession, readBoardStatus, readInput, sessionRoots } from "./lib.mjs";

const input = readInput();

// 세션이 끝났는데 보드가 "진행 중"이면 아무도 일하지 않는 상태를 거짓으로 보여주게 된다.
for (const root of sessionRoots(input)) {
  const board = readBoardStatus(root);
  if (!board?.status.includes("진행")) continue;
  writeFileSync(
    board.path,
    board.board.replace(/^(>\s*상태:\s*)[^·\n]+/m, "$1중단됨 (리드 세션 종료) "),
  );
}

forgetSession(input.session_id);
