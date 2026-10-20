import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../plugins/cony/skills/team/board.mjs", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "cony-board-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const SPEC = `# 계산기

## 태스크
- [ ] 1. 최소 버전 (AC-1)
  - [ ] 1-1. 로직 (담당: client)
- [ ] 2. 경계 처리 (AC-4)

## 가정
- A1: 일반 계산기
`;

const ADR = `# ADR-001 연산 순서
- 상태: 채택
- 결정: 우선순위 적용
`;

let count = 0;
function createProject() {
  count += 1;
  const dir = join(base, `p${count}`);
  mkdirSync(join(dir, ".cony", "specs"), { recursive: true });
  mkdirSync(join(dir, ".cony", "decisions"), { recursive: true });
  writeFileSync(join(dir, ".cony", "specs", "calc.md"), SPEC);
  writeFileSync(join(dir, ".cony", "decisions", "001-precedence.md"), ADR);
  return dir;
}

function board(dir, ...args) {
  return spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
}

const read = (dir, rel) => readFileSync(join(dir, ".cony", rel), "utf8");

describe("board.mjs", () => {
  test("--init 은 스펙의 최상위 태스크만 가져온다", () => {
    const dir = createProject();
    const r = board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    assert.equal(r.status, 0, r.stderr);
    const text = read(dir, "board.md");
    assert.match(text, /^# 계산기$/m);
    assert.match(text, /상태: 진행 중 · 마지막 업데이트: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(text, /- \[ \] 1\. 최소 버전/);
    assert.match(text, /- \[ \] 2\. 경계 처리/);
    assert.doesNotMatch(text, /1-1\./);
  });

  test("태스크 진행·완료와 스펙 체크박스 동기화", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    board(dir, "--task", "1=doing:client-dev");
    assert.match(read(dir, "board.md"), /- \[ \] 1\. 최소 버전 \(AC-1\) ← 진행 중 \(client-dev\)/);
    assert.doesNotMatch(read(dir, "specs/calc.md"), /- \[x\] 1\./);

    board(dir, "--task", "1=done", "--task", "2=doing");
    const text = read(dir, "board.md");
    assert.match(text, /- \[x\] 1\. 최소 버전 \(AC-1\)$/m);
    assert.match(text, /- \[ \] 2\. 경계 처리 \(AC-4\) ← 진행 중$/m);
    assert.match(read(dir, "specs/calc.md"), /^- \[x\] 1\. 최소 버전/m);
    assert.match(read(dir, "specs/calc.md"), /^  - \[ \] 1-1\./m);

    board(dir, "--task", "1=todo");
    assert.match(read(dir, "specs/calc.md"), /^- \[ \] 1\. 최소 버전/m);
  });

  test("결정은 ADR에서 제목과 결정을 읽어 맨 위에 추가하고 중복은 없앤다", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기");
    board(dir, "--decision", "decisions/001-precedence.md");
    board(dir, "--decision", "decisions/001-precedence.md");
    const text = read(dir, "board.md");
    const lines = text.split("\n").filter((l) => l.includes("ADR-001"));
    assert.deepEqual(lines, ["- [ADR-001 연산 순서](decisions/001-precedence.md): 우선순위 적용"]);
  });

  test("확인 필요·막힌 것은 목록으로, none 이면 없음", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기");
    board(dir, "--attention", "질문 A", "--attention", "질문 B", "--blocked", "키 필요");
    let text = read(dir, "board.md");
    assert.match(text, /## 사용자 확인 필요\n- 질문 A\n- 질문 B/);
    assert.match(text, /## 막힌 것\n- 키 필요/);
    board(dir, "--attention", "none", "--blocked", "none");
    text = read(dir, "board.md");
    assert.match(text, /## 사용자 확인 필요\n없음/);
    assert.match(text, /## 막힌 것\n없음/);
  });

  test("상태·지금 하는 일·PR을 바꿔도 나머지는 유지", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    board(dir, "--task", "1=done", "--attention", "질문");
    board(dir, "--status", "사용자 대기", "--now", "tester 대기", "--pr", "#3 · CI 통과");
    const text = read(dir, "board.md");
    assert.match(text, /상태: 사용자 대기/);
    assert.match(text, /## 지금 하는 일\ntester 대기/);
    assert.match(text, /## PR\n#3 · CI 통과/);
    assert.match(text, /- \[x\] 1\./);
    assert.match(text, /- 질문/);
    assert.match(text, /<!-- spec: specs\/calc\.md -->/);
  });

  for (const [name, args, message] of [
    ["없는 태스크", ["--task", "9=done"], /태스크 9/],
    ["잘못된 태스크 형식", ["--task", "1=finish"], /형식/],
    ["잘못된 상태", ["--status", "아무거나"], /--status/],
    ["없는 결정 기록", ["--decision", "decisions/999.md"], /찾을 수 없습니다/],
  ]) {
    test(`오류: ${name}`, () => {
      const dir = createProject();
      board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
      const before = read(dir, "board.md");
      const r = board(dir, ...args);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, message);
      assert.equal(read(dir, "board.md"), before);
    });
  }

  test("보드 없이 갱신하면 오류", () => {
    const r = board(createProject(), "--now", "x");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--init/);
  });
});
