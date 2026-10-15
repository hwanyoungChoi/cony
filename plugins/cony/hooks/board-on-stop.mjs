import { relative } from "node:path";

import { output, readBoardStatus, readInput, sessionRoots } from "./lib.mjs";

const input = readInput();
// 같은 턴에서 한 번만 알린다.
if (input.stop_hook_active) process.exit(0);

const stale = sessionRoots(input)
  .map((root) => ({ root, board: readBoardStatus(root) }))
  .filter(({ board }) => board?.status.includes("진행"));
if (stale.length === 0) process.exit(0);

const paths = stale.map(({ root, board }) => relative(process.cwd(), board.path) || board.path).join(", ");
output({
  decision: "block",
  reason: `[cony] 보드(${paths}) 상태가 "진행 중"인데 턴을 끝내려 합니다. 사용자에게 넘기는 거라면 상태를 "사용자 대기" 또는 "완료"로, "지금 하는 일"을 실제 상태로 갱신하세요. 백그라운드 에이전트가 계속 일하는 중이면 그대로 두고 마무리해도 됩니다.`,
});
