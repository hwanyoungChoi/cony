import { statSync } from "node:fs";
import { relative } from "node:path";

import { leadRoots, logEvent, output, readBoardStatus, readInput, rememberedRoots, rememberValue } from "./lib.mjs";

// 리드가 턴을 끝낼 때마다 막으면 방해가 된다(모기지핏에서 6일간 66번).
// 보드가 오래 갱신되지 않았을 때만, 그리고 한 번 막으면 한동안은 다시 막지 않는다.
const FRESH_MS = 15 * 60_000;
const COOLDOWN_MS = 30 * 60_000;

const input = readInput();
// 같은 턴에서 한 번만 알린다.
if (input.stop_hook_active) process.exit(0);

const now = Date.now();
const lastBlock = Number(rememberedRoots(input.session_id, "board-stop-at")[0] ?? 0);
if (now - lastBlock < COOLDOWN_MS) process.exit(0);

const stale = leadRoots(input.session_id)
  .map((root) => ({ root, board: readBoardStatus(root) }))
  .filter(({ board }) => board?.status.includes("진행") && now - statSync(board.path).mtimeMs > FRESH_MS);
if (stale.length === 0) process.exit(0);

rememberValue(input.session_id, "board-stop-at", String(now));
for (const { root } of stale) logEvent(root, { type: "hook", hook: "board-on-stop", decision: "block" });
const paths = stale.map(({ board }) => relative(process.cwd(), board.path) || board.path).join(", ");
output({
  decision: "block",
  reason: `[cony] 보드(${paths})가 "진행 중"인 채로 15분 넘게 갱신되지 않았습니다. 사용자에게 넘기는 거라면 상태를 "사용자 대기" 또는 "완료"로, "지금 하는 일"을 실제 상태로 갱신하세요. 백그라운드 에이전트가 계속 일하는 중이면 그대로 두고 마무리해도 됩니다. 30분 동안은 다시 묻지 않습니다.`,
});
