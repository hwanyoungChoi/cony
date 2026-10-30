import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { findConyRoot, logEvent, readBoardStatus, readInput, rememberValue, rememberedRoots } from "./lib.mjs";

// 팀 모드(team.json mode: "teams")에서 팀원이 쉬려 할 때 돈다. 공유 작업 목록(Task 도구)은 최신 모델에서 기본으로 꺼져 있어
// TaskCompleted hook이 뜨지 않으므로, 보드(.cony/board.md)를 작업 목록으로 보고 여기서 게이트를 건다.
//   - fe·be: 자기 태스크가 PROGRESS인데 기록 파일(.cony/reviews/*-{역할}-task-{N}.md)이 없으면 쉬지 못한다
//   - qa: REVIEW 태스크에 qa 기록 파일이 없으면 쉬지 못한다
// 같은 태스크로 두 번까지만 돌려보낸다. 정말 막힌 팀원을 영영 붙잡지 않으려고.
const ROLES = new Set(["pm", "fe", "be", "qa"]);
const MAX_BLOCKS = 2;
const TASK = /^- \[[ xX]\] (\d+)\. .*\[(PROGRESS|REVIEW)(?: · ([^\]]+))?\]\s*$/;

const input = readInput();
const root = findConyRoot(input.cwd ?? process.cwd());
const role = roleOf(input.teammate_name);
if (!root || !role) process.exit(0);

logEvent(root, { type: "teammate_idle", teammate: role });

const board = readBoardStatus(root);
if (!board) process.exit(0);
const tasks = board.board
  .split("\n")
  .map((line) => line.match(TASK))
  .filter(Boolean)
  .map(([, number, state, owner]) => ({ number, state, owner: owner ?? "" }));

const missing =
  role === "qa"
    ? tasks.filter((t) => t.state === "REVIEW" && !hasRecord(root, "qa", t.number))
    : role === "pm"
      ? []
      : tasks.filter((t) => t.state === "PROGRESS" && t.owner.includes(role) && !hasRecord(root, role, t.number));
if (missing.length === 0) process.exit(0);

const task = missing[0];
const counts = JSON.parse(rememberedRoots(input.session_id, "teammate-idle")[0] ?? "{}");
const key = `${role}:${task.number}`;
counts[key] = (counts[key] ?? 0) + 1;
rememberValue(input.session_id, "teammate-idle", JSON.stringify(counts));
if (counts[key] > MAX_BLOCKS) {
  logEvent(root, { type: "hook", hook: "teammate-idle", decision: "allow-after-max", teammate: role, task: Number(task.number) });
  process.exit(0);
}
logEvent(root, { type: "hook", hook: "teammate-idle", decision: "block", teammate: role, task: Number(task.number) });
console.error(
  role === "qa"
    ? `[cony] 태스크 ${task.number}이 REVIEW인데 qa 기록 파일(.cony/reviews/{YYYYMMDD-HHmm}-qa-task-${task.number}.md)이 없습니다. 판정을 기록 파일에 쓰고, 실패면 담당(fe/be)에게, 결과는 리드에게 SendMessage로 보낸 뒤 쉬세요. 검증 중이면 계속하세요.`
    : `[cony] 태스크 ${task.number}이 PROGRESS(담당 ${task.owner || role})인데 기록 파일(.cony/reviews/{YYYYMMDD-HHmm}-${role}-task-${task.number}.md)이 없습니다. 끝났으면 기록 파일을 쓰고 qa에게 SendMessage로 넘기세요. 막혔으면 리드에게 SendMessage로 알리세요. 아직 작업 중이면 계속하세요.`,
);
process.exit(2);

// 팀원 이름에서 역할을 읽는다: "fe", "cony:fe", "fe-1" 모두 fe
function roleOf(name) {
  const m = /^(?:cony:)?([a-z]+)/i.exec(name ?? "");
  const role = m?.[1]?.toLowerCase();
  return ROLES.has(role) ? role : null;
}

function hasRecord(root, role, number) {
  const dir = join(root, ".cony", "reviews");
  if (!existsSync(dir)) return false;
  const pattern = new RegExp(`-${role}-task-${number}\\.md$`);
  return readdirSync(dir).some((name) => pattern.test(name));
}
