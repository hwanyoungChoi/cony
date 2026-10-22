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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { findConyRoot } from "../../hooks/lib.mjs";

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

function setTask(tasksText, spec, value) {
  const match = value.match(/^(\d+)=(\w+)(?::(.+))?$/);
  const state = match && STATE_ALIASES[match[2]];
  if (!state) fail(`--task 형식은 N=todo | N=progress[:담당] | N=review[:담당] | N=done 입니다: ${value}`);
  const [, number, , owner] = match;
  let found = false;
  const updated = tasksText
    .split("\n")
    .map((line) => {
      const task = line.match(TASK_LINE);
      if (!task || task[2] !== number) return line;
      found = true;
      const box = state === "done" ? "x" : " ";
      const tag = state === "progress" || state === "review" ? ` [${state.toUpperCase()}${owner ? ` · ${owner}` : ""}]` : "";
      return `- [${box}] ${number}. ${task[3]}${tag}`;
    })
    .join("\n");
  if (!found) fail(`보드에 태스크 ${number}이(가) 없습니다.`);

  // 완료·되돌림은 스펙 체크박스에도 반영한다
  if (spec && (state === "done" || state === "todo")) {
    const specPath = join(conyDir, spec);
    if (existsSync(specPath)) {
      const specText = readFileSync(specPath, "utf8");
      const box = state === "done" ? "x" : " ";
      writeFileSync(specPath, specText.replace(new RegExp(`^- \\[[ xX]\\] ${number}\\. `, "m"), `- [${box}] ${number}. `));
    }
  }
  return updated;
}

function decisionLine(rel) {
  const path = join(conyDir, rel);
  if (!existsSync(path)) fail(`결정 기록을 찾을 수 없습니다: ${rel}`);
  const text = readFileSync(path, "utf8");
  const title = (text.match(/^#\s+(.+)$/m) || [])[1] ?? rel;
  const decided = (text.match(/^-\s*결정:\s*(.+)$/m) || [])[1];
  return `- [${title}](${rel})${decided ? `: ${decided}` : ""}`;
}

function listOrNone(items) {
  if (items.length === 1 && items[0] === "none") return "없음";
  return items.map((item) => `- ${item}`).join("\n");
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
for (const value of values.task ?? []) board.sections["태스크"] = setTask(board.sections["태스크"], board.spec, value);
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

const tasks = board.sections["태스크"].split("\n").filter((l) => TASK_LINE.test(l));
const count = (pattern) => tasks.filter((l) => pattern.test(l)).length;
const done = count(/^- \[[xX]\]/);
const review = count(/\[REVIEW/);
const progress = count(/\[PROGRESS| ← /);
const todo = tasks.length - done - review - progress;
console.log(
  `board: ${board.status} · TODO ${todo} · PROGRESS ${progress} · REVIEW ${review} · DONE ${done} · ${board.sections["지금 하는 일"].split("\n")[0]}`,
);
