import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

## 다음 단계 후보
- AC-5: 식 표시줄
- 태스크 3. 키보드 입력

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

// qa가 남기는 태스크 검증 기록
const qaRecord = (dir, number) => {
  mkdirSync(join(dir, ".cony", "reviews"), { recursive: true });
  writeFileSync(join(dir, ".cony", "reviews", `20261022-1200-qa-task-${number}.md`), "# 검증\n판정: 통과\n");
};
const events = (dir) =>
  readFileSync(join(dir, ".cony", "metrics", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

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
    board(dir, "--task", "1=doing:fe");
    assert.match(read(dir, "board.md"), /- \[ \] 1\. 최소 버전 \(AC-1\) \[PROGRESS · fe\]$/m);
    assert.doesNotMatch(read(dir, "specs/calc.md"), /- \[x\] 1\./);

    board(dir, "--task", "1=review:qa");
    qaRecord(dir, 1);
    const r = board(dir, "--task", "1=done", "--task", "2=doing");
    assert.equal(r.status, 0, r.stderr);
    const text = read(dir, "board.md");
    assert.match(text, /- \[x\] 1\. 최소 버전 \(AC-1\)$/m);
    assert.match(text, /- \[ \] 2\. 경계 처리 \(AC-4\) \[PROGRESS\]$/m);
    assert.match(read(dir, "specs/calc.md"), /^- \[x\] 1\. 최소 버전/m);
    assert.match(read(dir, "specs/calc.md"), /^  - \[ \] 1-1\./m);

    board(dir, "--task", "1=todo");
    assert.match(read(dir, "specs/calc.md"), /^- \[ \] 1\. 최소 버전/m);
  });

  test("REVIEW 상태는 태그로 남고 스펙 체크박스는 건드리지 않는다", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    board(dir, "--task", "1=progress:fe");
    const r = board(dir, "--task", "1=review:qa");
    assert.equal(r.status, 0, r.stderr);
    assert.match(read(dir, "board.md"), /- \[ \] 1\. 최소 버전 \(AC-1\) \[REVIEW · qa\]$/m);
    assert.match(read(dir, "specs/calc.md"), /^- \[ \] 1\. 최소 버전/m);
    assert.match(r.stdout, /TODO 1 · PROGRESS 0 · REVIEW 1 · DONE 0/);
  });

  test("예전 형식(← 진행 중)도 읽고 새 형식으로 바꾼다", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    const path = join(dir, ".cony", "board.md");
    writeFileSync(path, read(dir, "board.md").replace("- [ ] 2. 경계 처리 (AC-4)", "- [ ] 2. 경계 처리 (AC-4) ← 진행 중 (fe)"));
    board(dir, "--task", "2=review:qa");
    assert.match(read(dir, "board.md"), /- \[ \] 2\. 경계 처리 \(AC-4\) \[REVIEW · qa\]$/m);
  });

  test("백로그는 스펙의 다음 단계 후보를 따라간다", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    assert.match(read(dir, "board.md"), /## 백로그\n- AC-5: 식 표시줄\n- 태스크 3\. 키보드 입력/);
    const specPath = join(dir, ".cony", "specs", "calc.md");
    writeFileSync(specPath, read(dir, "specs/calc.md").replace("- AC-5: 식 표시줄\n", ""));
    board(dir, "--now", "갱신");
    assert.doesNotMatch(read(dir, "board.md"), /AC-5: 식 표시줄/);
  });

  test("단계를 건너뛰면 막고 보드를 바꾸지 않는다", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    const before = read(dir, "board.md");
    for (const step of ["1=done", "1=review"]) {
      const r = board(dir, "--task", step);
      assert.notEqual(r.status, 0, step);
      assert.match(r.stderr, /단계를 건너뜁니다/);
    }
    board(dir, "--task", "1=progress:fe");
    const r = board(dir, "--task", "1=done");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PROGRESS → DONE/);
    assert.match(read(dir, "board.md"), /\[PROGRESS · fe\]/);
    assert.notEqual(read(dir, "board.md"), before);
  });

  test("DONE은 qa 기록이 있어야 하고, qa가 off면 필요 없다", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    board(dir, "--task", "1=progress");
    board(dir, "--task", "1=review");
    let r = board(dir, "--task", "1=done");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /qa 검증 기록이 없습니다/);
    writeFileSync(join(dir, ".cony", "team.json"), JSON.stringify({ qa: "off" }));
    r = board(dir, "--task", "1=done");
    assert.equal(r.status, 0, r.stderr);
  });

  test("qa가 review면 테스트 시나리오(handoff)가 있어야 한다", () => {
    const dir = createProject();
    writeFileSync(join(dir, ".cony", "team.json"), JSON.stringify({ qa: "review" }));
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    board(dir, "--task", "2=progress");
    board(dir, "--task", "2=review");
    let r = board(dir, "--task", "2=done");
    assert.match(r.stderr, /테스트 시나리오가 없습니다/);
    mkdirSync(join(dir, ".cony", "handoffs"), { recursive: true });
    writeFileSync(join(dir, ".cony", "handoffs", "20261022-1200-qa-task-2.md"), "# 시나리오\n");
    r = board(dir, "--task", "2=done");
    assert.equal(r.status, 0, r.stderr);
  });

  test("DONE은 커밋하지 않은 변경이 있으면 막는다 (.cony 변경은 제외)", () => {
    const dir = createProject();
    const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    board(dir, "--task", "1=progress");
    board(dir, "--task", "1=review");
    qaRecord(dir, 1);
    writeFileSync(join(dir, "app.ts"), "export const a = 2;\n");
    let r = board(dir, "--task", "1=done");
    assert.match(r.stderr, /커밋하지 않은 변경/);
    git("add", "app.ts");
    git("commit", "-qm", "task 1");
    r = board(dir, "--task", "1=done");
    assert.equal(r.status, 0, r.stderr);
  });

  test("--skip-reason 으로 넘어가면 log.md와 지표에 남는다", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md");
    const r = board(dir, "--task", "1=done", "--skip-reason", "급한 핫픽스");
    assert.equal(r.status, 0, r.stderr);
    assert.match(read(dir, "log.md"), /`놓침` 흐름 규칙 건너뜀 \(급한 핫픽스\)/);
    const types = events(dir).map((e) => e.type);
    assert.ok(types.includes("gate_bypassed"));
    assert.deepEqual(events(dir).find((e) => e.type === "task"), { ...events(dir).find((e) => e.type === "task"), task: 1, from: "todo", to: "done" });
  });

  test("리드 세션 ID를 기록하고 다른 갱신에도 유지한다", () => {
    const dir = createProject();
    board(dir, "--init", "--goal", "계산기", "--spec", "specs/calc.md", "--lead", "local_abc-123");
    board(dir, "--task", "1=done", "--now", "갱신");
    const text = read(dir, "board.md");
    assert.match(text, /<!-- lead: local_abc-123 -->/);
    assert.match(text, /<!-- spec: specs\/calc\.md -->/);
    assert.doesNotMatch(text, /## PR\n.*lead/);
    board(dir, "--lead", "local_new");
    assert.match(read(dir, "board.md"), /<!-- lead: local_new -->/);
    assert.doesNotMatch(read(dir, "board.md"), /local_abc-123/);
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
    board(dir, "--task", "1=done", "--attention", "질문", "--skip-reason", "테스트용");
    board(dir, "--status", "사용자 대기", "--now", "qa 대기", "--pr", "#3 · CI 통과");
    const text = read(dir, "board.md");
    assert.match(text, /상태: 사용자 대기/);
    assert.match(text, /## 지금 하는 일\nqa 대기/);
    assert.match(text, /## PR\n#3 · CI 통과/);
    assert.match(text, /- \[x\] 1\./);
    assert.match(text, /- 질문/);
    assert.match(text, /<!-- spec: specs\/calc\.md -->/);
  });

  for (const [name, args, message] of [
    ["없는 태스크", ["--task", "9=done"], /태스크 9/],
    ["잘못된 태스크 형식", ["--task", "1=finish"], /형식/],
    ["태스크 번호 누락", ["--task", "review"], /형식/],
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

test("플러그인 캐시의 예전 버전으로 불리면 설치된 최신 버전에 넘긴다", () => {
  const cony = join(base, "plugins", "cache", "conychoi-plugins", "cony");
  for (const v of ["0.9.0", "0.10.0"]) {
    mkdirSync(join(cony, v, "skills", "team"), { recursive: true });
    mkdirSync(join(cony, v, "hooks"), { recursive: true });
    writeFileSync(join(cony, v, "hooks", "lib.mjs"), readFileSync(new URL("../plugins/cony/hooks/lib.mjs", import.meta.url)));
  }
  writeFileSync(join(cony, "0.9.0", "skills", "team", "board.mjs"), readFileSync(SCRIPT));
  writeFileSync(join(cony, "0.10.0", "skills", "team", "board.mjs"), 'console.log("latest", process.argv.slice(2).join(" "));\nprocess.exit(3);\n');

  const r = spawnSync("node", [join(cony, "0.9.0", "skills", "team", "board.mjs"), "--status", "완료"], { encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.trim(), "latest --status 완료", "0.9.0 < 0.10.0 은 숫자로 비교한다");
});
