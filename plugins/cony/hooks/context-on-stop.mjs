import { closeSync, openSync, readSync, statSync } from "node:fs";

import { leadRoots, logEvent, output, readBoardStatus, readInput, rememberedRoots, rememberValue } from "./lib.mjs";

// 리드 대화가 길어지면 응답할 때마다 그만큼을 다시 읽는다(모기지핏 리드 한 세션이 6일, 대화 92만 토큰, 전체 토큰의 61%).
// 기능 하나를 마친 시점(진행 중이 아님)에 대화가 크면, 다음 작업은 새 세션에서 이어가라고 한 번 권한다.
// 진행 중이어도 아주 크면 지금 태스크를 마무리하고 넘기라고 권한다. 같은 크기에서 되풀이하지 않는다.
const AT_REST = 200_000;
const IN_PROGRESS = 500_000;
const STEP = 150_000;
const TAIL_BYTES = 2 * 1024 * 1024;

const input = readInput();
if (input.stop_hook_active || !input.transcript_path) process.exit(0);

const boards = leadRoots(input.session_id)
  .map((root) => ({ root, board: readBoardStatus(root) }))
  .filter(({ board }) => board);
if (boards.length === 0) process.exit(0);

const context = lastContextSize(input.transcript_path);
const busy = boards.some(({ board }) => board.status.includes("진행"));
if (context < (busy ? IN_PROGRESS : AT_REST)) process.exit(0);

const warnedAt = Number(rememberedRoots(input.session_id, "context-warned")[0] ?? 0);
if (warnedAt && context - warnedAt < STEP) process.exit(0);
rememberValue(input.session_id, "context-warned", String(context));

for (const { root } of boards) logEvent(root, { type: "hook", hook: "context-on-stop", decision: "block", context });
const size = `${Math.round(context / 1000)}k`;
output({
  decision: "block",
  reason: busy
    ? `[cony] 이 리드 세션의 대화가 약 ${size} 토큰입니다. 응답할 때마다 이만큼을 다시 읽어서 토큰 대부분이 여기서 나갑니다. 지금 태스크를 마무리하면 보드의 "지금 하는 일"·남은 태스크·열린 질문과 log를 이어받을 수 있게 갱신하고, 사용자에게 "남은 작업은 새 세션에서 /cony:team 으로 이어가기"를 권하세요.`
    : `[cony] 기능을 마쳤고 이 리드 세션의 대화가 약 ${size} 토큰입니다. 응답할 때마다 이만큼을 다시 읽어서 토큰 대부분이 여기서 나갑니다. 보드·log·스펙에 다음 세션이 이어받을 내용(백로그, 열린 질문, 사용자 확인 필요)이 다 있는지 확인하고, 보고 끝에 "다음 작업은 새 세션에서 /cony:team 으로 시작하기"를 권하세요.`,
});

// 대화 기록 끝부분에서 마지막 응답이 읽은 대화 크기(입력 + 캐시 읽기 + 캐시 쓰기)
function lastContextSize(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return 0;
  }
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  readSync(fd, buffer, 0, length, size - length);
  closeSync(fd);
  const lines = buffer.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const u = JSON.parse(lines[i]).message?.usage;
      if (u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    } catch {
      // 잘린 첫 줄
    }
  }
  return 0;
}
