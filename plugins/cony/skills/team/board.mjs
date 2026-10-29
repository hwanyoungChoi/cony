#!/usr/bin/env node
// .cony/board.md 의 필요한 부분만 갱신한다. 시각은 매번 자동으로 기록된다.
//
//   새 보드:  node board.mjs --init --goal "계산기" --spec specs/calculator.md
//   갱신:     node board.mjs --status "진행 중" --task 1=done --task 2=doing:fe \
//               --now "fe가 태스크 2 구현 중" --decision decisions/004-scope.md \
//               --attention "질문" --blocked none --pr "#14 · CI 진행 중"
//
// --task 값: N=todo | N=progress[:담당] | N=review[:담당] | N=done   (doing 은 progress 와 같다)
// 칸반: BACKLOG(스펙의 "다음 단계 후보") · TODO · PROGRESS · REVIEW · DONE
// --attention, --blocked: 여러 번 주면 목록, none 이면 "없음"
// --decision: ADR 파일에서 제목과 결정을 읽어 "최근 결정" 맨 위에 추가
// --lead: 리드 세션의 데스크톱 앱 세션 ID(local_...). /cony:status 가 리드 상태를 확인하고 재개 메시지를 보낼 때 쓴다
//
// 상태 전이 규칙 (팀 흐름을 코드로 지킨다):
//   todo → progress → review → done, review → progress(되돌림), 어디서든 → todo
//   건너뛰기(todo→review, todo/progress→done)는 막는다.
//   review → done 은 qa 기록(team.json 의 qa 설정에 따라)과 커밋되지 않은 변경 없음을 확인한다.
//   --status 완료 는 "사용자 확인 필요"가 비어 있어야 한다.
//   --skip-reason "이유" 로 넘어갈 수 있지만 log.md 에 `놓침`으로, 지표에 gate_bypassed 로 남는다.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { findConyRoot, logEvent, runNewerInstall } from "../../hooks/lib.mjs";

// 오래 켜 둔 리드 세션은 스킬을 처음 불러온 버전의 경로로 계속 이 파일을 부른다.
// 플러그인 캐시에서 실행됐고 더 새 버전이 설치돼 있으면 그쪽에 넘긴다(단계 검사가 최신 규칙을 따르도록).
runNewerInstall(import.meta.url);

const SECTIONS = ["태스크", "백로그", "지금 하는 일", "최근 결정", "사용자 확인 필요", "막힌 것", "PR"];
const STATUSES = ["진행 중", "사용자 대기", "완료", "중단됨"];
// 태스크 줄: "- [ ] 2. 제목 [PROGRESS · fe]". 예전 형식 "← 진행 중 (담당)"도 읽는다.
const TASK_LINE = /^- \[([ xX])\] (\d+)\. (.*?)(?: \[(?:PROGRESS|REVIEW)[^\]]*\]| ← .*)?$/;
const STATE_ALIASES = { todo: "todo", doing: "progress", progress: "progress", review: "review", done: "done" };

const { values } = parseArgs({
  options: {
    init: { type: "boolean" },
    goal: { type: "string" },
    spec: { type: "string" },
    status: { type: "string" },
    now: { type: "string" },
    task: { type: "string", multiple: true },
    decision: { type: "string", multiple: true },
    attention: { type: "string", multiple: true },
    blocked: { type: "string", multiple: true },
    pr: { type: "string" },
    root: { type: "string" },
    lead: { type: "string" },
    "skip-reason": { type: "string" },
  },
});

function fail(message) {
  console.error(`board: ${message}`);
  process.exit(1);
}

const root = findConyRoot(values.root ?? process.cwd());
if (!root) fail(".cony/ 를 찾을 수 없습니다. cony 프로젝트 안에서 실행하세요.");
const conyDir = join(root, ".cony");
const boardPath = join(conyDir, "board.md");

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseBoard(text) {
  const [head, ...chunks] = text.split(/^## /m);
  const goal = (head.match(/^#\s+(.+)$/m) || [])[1] ?? "";
  const status = (head.match(/상태:\s*([^·\n]+)/) || [])[1]?.trim() ?? "진행 중";
  const spec = (text.match(/<!-- spec: (.+?) -->/) || [])[1] ?? null;
  const lead = (text.match(/<!-- lead: (.+?) -->/) || [])[1] ?? null;
  const sections = Object.fromEntries(SECTIONS.map((name) => [name, "없음"]));
  for (const chunk of chunks) {
    const newline = chunk.indexOf("\n");
    const name = chunk.slice(0, newline).trim();
    sections[name] = chunk.slice(newline + 1).replace(/<!-- (spec|lead): .+? -->/g, "").trim();
  }
  return { goal, status, spec, lead, sections };
}

function renderBoard({ goal, status, spec, lead, sections }) {
  const body = SECTIONS.map((name) => `## ${name}\n${sections[name] || "없음"}`).join("\n\n");
  const meta = [spec && `<!-- spec: ${spec} -->`, lead && `<!-- lead: ${lead} -->`].filter(Boolean).join("\n");
  return `# ${goal}\n> 상태: ${status} · 마지막 업데이트: ${timestamp()}\n\n${body}${meta ? `\n\n${meta}` : ""}\n`;
}

function tasksFromSpec(specRel) {
  const specPath = join(conyDir, specRel);
  if (!existsSync(specPath)) fail(`스펙을 찾을 수 없습니다: ${specRel}`);
  const tasks = readFileSync(specPath, "utf8").split(/^## /m).find((chunk) => chunk.startsWith("태스크"));
  if (!tasks) fail(`스펙에 "## 태스크" 섹션이 없습니다: ${specRel}`);
  const lines = tasks.split("\n").filter((line) => TASK_LINE.test(line));
  if (lines.length === 0) fail(`스펙의 태스크에 "- [ ] 1. ..." 형식 항목이 없습니다: ${specRel}`);
  return lines.join("\n");
}

function backlogFromSpec(specRel) {
  const specPath = join(conyDir, specRel);
  if (!existsSync(specPath)) return "없음";
  const section = readFileSync(specPath, "utf8").split(/^## /m).find((chunk) => chunk.startsWith("다음 단계 후보"));
  const items = (section ?? "").split("\n").filter((line) => /^\s*- /.test(line)).map((line) => line.trim());
  return items.length ? items.join("\n") : "없음";
}

function stateOf(line) {
  if (/^- \[[xX]\]/.test(line)) return "done";
  if (/\[REVIEW/.test(line)) return "review";
  if (/\[PROGRESS| ← /.test(line)) return "progress";
  return "todo";
}

const NEXT = { todo: ["progress"], progress: ["review"], review: ["progress", "done"], done: [] };

function readTeam() {
  try {
    return JSON.parse(readFileSync(join(conyDir, "team.json"), "utf8"));
  } catch {
    return {};
  }
}

function hasRecord(folder, pattern) {
  const dir = join(conyDir, folder);
  return existsSync(dir) && readdirSync(dir).some((name) => pattern.test(name));
}

function uncommittedChanges() {
  try {
    return execFileSync("git", ["status", "--porcelain", "--", ".", ":(exclude).cony"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return ""; // git 저장소가 아니면 검사하지 않는다
  }
}

// 이 전이를 막아야 하면 이유 목록을, 괜찮으면 빈 배열을 돌려준다.
function gateProblems(number, from, to) {
  if (to === "todo" || from === to) return [];
  if (!NEXT[from].includes(to)) {
    return [
      `태스크 ${number}: ${from.toUpperCase()} → ${to.toUpperCase()}는 단계를 건너뜁니다. TODO → PROGRESS → REVIEW → DONE 순서로 옮기세요.`,
    ];
  }
  if (to !== "done") return [];
  const problems = [];
  const qa = readTeam().qa ?? "build";
  const taskPattern = new RegExp(`-qa-task-${number}(\\D|$)`);
  if (qa === "build" && !hasRecord("reviews", taskPattern)) {
    problems.push(
      `태스크 ${number}: qa 검증 기록이 없습니다. qa에게 기록 파일 .cony/reviews/{YYYYMMDD-HHmm}-qa-task-${number}.md 를 남기게 하세요.`,
    );
  }
  if (qa === "review" && !hasRecord("handoffs", taskPattern)) {
    problems.push(
      `태스크 ${number}: qa가 review인데 테스트 시나리오가 없습니다. .cony/handoffs/{YYYYMMDD-HHmm}-qa-task-${number}.md 를 남기게 하세요.`,
    );
  }
  const dirty = uncommittedChanges();
  if (dirty) {
    problems.push(
      `태스크 ${number}: 커밋하지 않은 변경이 있습니다. 커밋한 뒤 DONE으로 옮기세요.\n${dirty.split("\n").slice(0, 8).join("\n")}`,
    );
  }
  return problems;
}

function setTask(tasksText, value) {
  const match = value.match(/^(\d+)=(\w+)(?::(.+))?$/);
  const state = match && STATE_ALIASES[match[2]];
  if (!state) fail(`--task 형식은 N=todo | N=progress[:담당] | N=review[:담당] | N=done 입니다: ${value}`);
  const [, number, , owner] = match;
  let from = null;
  const updated = tasksText
    .split("\n")
    .map((line) => {
      const task = line.match(TASK_LINE);
      if (!task || task[2] !== number) return line;
      from = stateOf(line);
      const box = state === "done" ? "x" : " ";
      const tag = state === "progress" || state === "review" ? ` [${state.toUpperCase()}${owner ? ` · ${owner}` : ""}]` : "";
      return `- [${box}] ${number}. ${task[3]}${tag}`;
    })
    .join("\n");
  if (!from) fail(`보드에 태스크 ${number}이(가) 없습니다.`);
  return { updated, number, from, to: state, owner: owner ?? null };
}

// 완료·되돌림은 스펙 체크박스에도 반영한다
function syncSpecCheckbox(spec, number, state) {
  if (!spec || (state !== "done" && state !== "todo")) return;
  const specPath = join(conyDir, spec);
  if (!existsSync(specPath)) return;
  const box = state === "done" ? "x" : " ";
  const specText = readFileSync(specPath, "utf8");
  writeFileSync(specPath, specText.replace(new RegExp(`^- \\[[ xX]\\] ${number}\\. `, "m"), `- [${box}] ${number}. `));
}

function decisionLine(rel) {
  const path = join(conyDir, rel);
  if (!existsSync(path)) fail(`결정 기록을 찾을 수 없습니다: ${rel}`);
  const text = readFileSync(path, "utf8");
  const title = (text.match(/^#\s+(.+)$/m) || [])[1] ?? rel;
  const decided = (text.match(/^-\s*결정:\s*(.+)$/m) || [])[1];
  return `- [${title}](${rel})${decided ? `: ${decided}` : ""}`;
}

// none 을 다른 항목과 같이 주면(--attention none --attention "질문") none 은 버린다
function listOrNone(items) {
  const real = items.filter((item) => !/^(none|없음)$/i.test(item.trim()));
  if (!real.length) return "없음";
  return real.map((item) => `- ${item}`).join("\n");
}

let board;
if (values.init) {
  if (!values.goal) fail("--init 에는 --goal 이 필요합니다.");
  board = {
    goal: values.goal,
    status: "진행 중",
    spec: values.spec ?? null,
    sections: Object.fromEntries(SECTIONS.map((name) => [name, "없음"])),
  };
  board.sections.PR = "아직 없음";
  if (values.spec) board.sections["태스크"] = tasksFromSpec(values.spec);
} else {
  if (!existsSync(boardPath)) fail("board.md 가 없습니다. 먼저 --init 으로 만드세요.");
  board = parseBoard(readFileSync(boardPath, "utf8"));
  if (values.spec) board.spec = values.spec;
}

if (values.lead) board.lead = values.lead;
if (board.spec) board.sections["백로그"] = backlogFromSpec(board.spec);
if (values.goal) board.goal = values.goal;
if (values.status) {
  if (!STATUSES.includes(values.status)) fail(`--status 는 ${STATUSES.join(" | ")} 중 하나입니다.`);
  board.status = values.status;
}
if (values.now) board.sections["지금 하는 일"] = values.now;
const transitions = [];
const problems = [];
for (const value of values.task ?? []) {
  const t = setTask(board.sections["태스크"], value);
  board.sections["태스크"] = t.updated;
  transitions.push(t);
  problems.push(...gateProblems(t.number, t.from, t.to));
}
// 완료로 바꾸면서 사용자 확인 필요를 남겨 두면, 답을 기다리는 건지 잊힌 건지 알 수 없게 된다
if (values.status === "완료") {
  const attention = values.attention ? listOrNone(values.attention) : board.sections["사용자 확인 필요"];
  const open = attention.split("\n").filter((l) => /^- /.test(l) && !/^- (none|없음)\s*$/i.test(l));
  if (open.length) {
    problems.push(
      `완료로 바꾸려는데 사용자 확인 필요가 ${open.length}개 남아 있습니다.\n${open.join("\n")}\n답을 받았으면 --attention none(남은 것만 다시 주어도 된다), 기다리는 중이면 --status "사용자 대기", 나중으로 미루면 스펙의 "다음 단계 후보"로 옮기고 --attention none.`,
    );
  }
}
const skipReason = values["skip-reason"];
if (problems.length && !skipReason) {
  fail(
    `팀 흐름 규칙에 걸려 보드를 바꾸지 않았습니다.\n- ${problems.join("\n- ")}\n꼭 넘어가야 하면 --skip-reason "이유"를 붙이세요. log.md에 놓침으로 남습니다.`,
  );
}
for (const rel of values.decision ?? []) {
  const line = decisionLine(rel);
  const existing = board.sections["최근 결정"]
    .split("\n")
    .filter((l) => l.startsWith("- ") && !l.includes(`](${rel})`));
  board.sections["최근 결정"] = [line, ...existing].join("\n");
}
if (values.attention) board.sections["사용자 확인 필요"] = listOrNone(values.attention);
if (values.blocked) board.sections["막힌 것"] = listOrNone(values.blocked);
if (values.pr) board.sections.PR = values.pr;

writeFileSync(boardPath, renderBoard(board));

for (const t of transitions) {
  syncSpecCheckbox(board.spec, t.number, t.to);
  if (t.from !== t.to) logEvent(root, { type: "task", task: Number(t.number), from: t.from, to: t.to, owner: t.owner });
}
if (problems.length) {
  logEvent(root, { type: "gate_bypassed", reason: skipReason, problems });
  const logPath = join(conyDir, "log.md");
  const lines = problems.map((p) => `- \`놓침\` 흐름 규칙 건너뜀 (${skipReason}): ${p.split("\n")[0]}`).join("\n");
  appendFileSync(logPath, `${existsSync(logPath) ? "\n" : ""}${lines}\n`);
}
if (values.status) logEvent(root, { type: "status", status: board.status });

const tasks = board.sections["태스크"].split("\n").filter((l) => TASK_LINE.test(l));
const count = (pattern) => tasks.filter((l) => pattern.test(l)).length;
const done = count(/^- \[[xX]\]/);
const review = count(/\[REVIEW/);
const progress = count(/\[PROGRESS| ← /);
const todo = tasks.length - done - review - progress;
console.log(
  `board: ${board.status} · TODO ${todo} · PROGRESS ${progress} · REVIEW ${review} · DONE ${done} · ${board.sections["지금 하는 일"].split("\n")[0]}`,
);
