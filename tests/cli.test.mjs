import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../plugins/cony/skills/board/cli.mjs", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "cony-cli-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const BOARD = `# 계산기 만들기
> 상태: 진행 중 · 마지막 업데이트: 2026-10-23 10:00

## 태스크
- [x] 1. 최소 버전 (AC-1, 2)
- [ ] 2. 연산자 교체 — AC-8 [PROGRESS · fe]
- [ ] 3. 0 나누기 오류 [REVIEW · qa]
- [ ] 4. 모바일 레이아웃

## 백로그
- AC-5: 식 표시줄

## 지금 하는 일
fe가 태스크 2 구현 중

## 최근 결정
- [ADR-001 연산 순서](decisions/001.md): 우선순위 적용

## 사용자 확인 필요
- 기본 LTV 확인

## 막힌 것
없음

## PR
아직 없음
`;

function project() {
  const dir = mkdtempSync(join(base, "p-"));
  mkdirSync(join(dir, ".cony"), { recursive: true });
  writeFileSync(join(dir, ".cony", "board.md"), BOARD);
  writeFileSync(join(dir, ".cony", "team.json"), JSON.stringify({ qa: "review", decisions: "user", merge: "pr" }));
  return dir;
}

const run = (cwd, args, columns = "120") =>
  spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", COLUMNS: columns, CONY_TRANSCRIPTS_DIR: join(base, "none") },
  });

test("board: 칸반 4열, 확인 필요, 결정, 팀 설정을 그린다", () => {
  const r = run(project(), ["board"]);
  assert.equal(r.status, 0, r.stderr);
  for (const s of ["계산기 만들기", "TODO 1", "PROGRESS 1", "REVIEW 1", "DONE 1", "⚠ 확인 필요  기본 LTV 확인", "ADR-001 연산 순서: 우선순위 적용", "[QA] 검토", "결정: 사용자 · 머지: PR까지", "BACKLOG 1"]) {
    assert.ok(r.stdout.includes(s), `없음: ${s}\n${r.stdout}`);
  }
  assert.match(r.stdout, /#2 연산자 교체/);
  assert.match(r.stdout, /fe · AC-8/, "— AC-8 형식도 수용 기준으로 읽는다");
  assert.doesNotMatch(r.stdout, /\x1b\[/, "NO_COLOR면 색 코드가 없다");
});

test("board: 좁은 터미널에서는 세로 목록, 줄이 폭을 넘지 않는다", () => {
  const r = run(project(), ["board"], "50");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /● PROGRESS 1\n  #2 연산자 교체/);
  const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/;
  for (const line of r.stdout.split("\n")) {
    const w = [...line].reduce((n, ch) => n + (wide.test(ch) ? 2 : 1), 0);
    assert.ok(w <= 50, `폭 ${w}: ${line}`);
  }
});

test("board --all 은 백로그 목록을 보여준다", () => {
  const r = run(project(), ["board", "--all"]);
  assert.match(r.stdout, /· AC-5: 식 표시줄/);
});

test("stats: 대화 기록이 없어도 지표를 그린다", () => {
  const r = run(project(), ["stats"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /대화 기록 없음/);
  assert.match(r.stdout, /hook이 막은 횟수/);
});

test("cony 프로젝트 밖이면 알려주고 실패한다", () => {
  const r = run(base, ["board"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\.cony\/ 를 찾을 수 없습니다/);
});

test("모르는 명령이면 도움말을 보여준다", () => {
  const r = run(project(), ["nope"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cony board/);
});
