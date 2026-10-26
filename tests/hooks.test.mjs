import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// 실제 eslint·tsc·gh 대신 가짜 실행 파일을 쓴다. 파일 내용에 LINT_ERROR·TYPE_ERROR가 있으면 실패한다.
// hook의 판단 로직만 검증하므로 의존성 설치 없이 빠르게 돈다.

const HOOKS = fileURLToPath(new URL("../plugins/cony/hooks/", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "cony-test-"));
const fakeBin = join(base, "bin");
const hookTmp = join(base, "tmp");
mkdirSync(fakeBin);
mkdirSync(hookTmp);
after(() => rmSync(base, { recursive: true, force: true }));

function writeExec(path, body) {
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
}

writeExec(
  join(fakeBin, "gh"),
  `console.log("fake gh checks"); process.exit(Number(process.env.FAKE_GH_STATUS ?? 0));`,
);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

let projectCount = 0;
function createProject({ cony = true } = {}) {
  projectCount += 1;
  const dir = join(base, `project-${projectCount}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  if (cony) mkdirSync(join(dir, ".cony"));
  writeFileSync(join(dir, "package.json"), '{ "name": "fixture" }\n');
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.cony/.cache\n");
  writeFileSync(join(dir, "src", "index.ts"), "export const a = 1;\n");
  writeExec(
    join(dir, "node_modules", ".bin", "eslint"),
    `const fs = require("fs");
const bad = process.argv.slice(2).filter((f) => !f.startsWith("-") && fs.readFileSync(f, "utf8").includes("LINT_ERROR"));
if (bad.length) { console.log("lint error: " + bad.join(", ")); process.exit(1); }`,
  );
  writeExec(
    join(dir, "node_modules", ".bin", "tsc"),
    `const fs = require("fs"), path = require("path");
const bad = fs.readdirSync("src").map((f) => path.join("src", f)).filter((f) => fs.readFileSync(f, "utf8").includes("TYPE_ERROR"));
if (bad.length) { console.log("type error: " + bad.join(", ")); process.exit(2); }`,
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}

function writeBoard(dir, status) {
  writeFileSync(
    join(dir, ".cony", "board.md"),
    `# 테스트\n> 상태: ${status} · 마지막 업데이트: 2026-10-20 10:00\n\n## 지금 하는 일\n테스트\n`,
  );
}

function runHook(name, input, env = {}) {
  const result = spawnSync("node", [join(HOOKS, name)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: hookTmp, PATH: `${fakeBin}:${process.env.PATH}`, ...env },
  });
  assert.equal(result.status, 0, `${name} 비정상 종료: ${result.stderr}`);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function decisionOf(out) {
  if (!out) return "allow";
  return out.hookSpecificOutput?.permissionDecision ?? out.decision ?? (out.systemMessage ? "message" : "allow");
}

describe("guard-instructions: 지침 파일 보호", () => {
  const project = createProject();
  const outside = createProject({ cony: false });
  const edit = (file) => decisionOf(runHook("guard-instructions.mjs", { tool_input: { file_path: file } }));

  test("CLAUDE.md 수정은 차단", () => assert.equal(edit(join(project, "CLAUDE.md")), "deny"));
  test(".claude/ 아래 수정은 차단", () => assert.equal(edit(join(project, ".claude", "CONVENTIONS.md")), "deny"));
  test("일반 소스 파일은 허용", () => assert.equal(edit(join(project, "src", "index.ts")), "allow"));
  test("cony 프로젝트가 아니면 관여하지 않음", () => assert.equal(edit(join(outside, "CLAUDE.md")), "allow"));
  test("막으면 지표 이벤트를 남긴다", () => {
    edit(join(project, "CLAUDE.md"));
    const lines = readFileSync(join(project, ".cony", "metrics", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.some((e) => e.type === "hook" && e.hook === "guard-instructions" && e.decision === "deny"));
  });
});

describe("guard-secrets: 비밀 파일", () => {
  const project = createProject();
  const outside = createProject({ cony: false });
  const read = (file) => decisionOf(runHook("guard-secrets.mjs", { tool_name: "Read", cwd: project, tool_input: { file_path: file } }));
  const bash = (command, cwd = project) => decisionOf(runHook("guard-secrets.mjs", { tool_name: "Bash", cwd, tool_input: { command } }));

  for (const name of [".env", ".env.local", ".dev.vars", "server.pem", "credentials.json"]) {
    test(`Read 차단: ${name}`, () => assert.equal(read(join(project, name)), "deny"));
  }
  test("예시 파일은 허용: .env.example", () => assert.equal(read(join(project, ".env.example")), "allow"));
  test("일반 파일은 허용", () => assert.equal(read(join(project, "src", "index.ts")), "allow"));
  test("cony 프로젝트가 아니면 관여하지 않음", () => assert.equal(read(join(outside, ".env")), "allow"));
  for (const command of ["cat .dev.vars", "grep API_KEY .env.local", "source .env && node probe.mjs", "cat ./config/.env"]) {
    test(`Bash 차단: ${command}`, () => assert.equal(bash(command), "deny"));
  }
  for (const command of ["cat .env.example", "pnpm test", "echo 'KEY=' >> .env.example"]) {
    test(`Bash 허용: ${command}`, () => assert.equal(bash(command), "allow"));
  }
  test("cony 밖에서는 Bash도 관여하지 않음", () => assert.equal(bash("cat .env", outside), "allow"));
});

describe("guard-bash: 위험 명령", () => {
  const project = createProject();
  const outside = createProject({ cony: false });
  const bash = (command, { cwd = project, env } = {}) =>
    decisionOf(runHook("guard-bash.mjs", { cwd, tool_input: { command } }, env));

  for (const command of [
    "git commit --no-verify -m x",
    "git commit --amend --no-edit",
    "git push --force",
    "git push -f origin feature",
    "git push origin +feature",
    "git push --force-with-lease",
  ]) {
    test(`차단: ${command}`, () => assert.equal(bash(command), "deny"));
  }

  for (const command of [
    "git push origin main",
    "git push origin feature:main",
    "git push origin --delete feature",
    "git reset --hard HEAD",
    "git clean -fd",
    "git checkout -- .",
    "rm -rf src",
    "psql -c 'DROP TABLE users'",
    "pnpm prisma migrate reset",
  ]) {
    test(`승인 필요: ${command}`, () => assert.equal(bash(command), "ask"));
  }

  test("main 브랜치에서 대상 없이 push하면 승인 필요", () => assert.equal(bash("git push"), "ask"));

  test("작업 브랜치 push는 허용", () => {
    const branchProject = createProject();
    git(branchProject, "switch", "-q", "-c", "cony/feature");
    assert.equal(bash("git push", { cwd: branchProject }), "allow");
    assert.equal(bash("git push -u origin HEAD", { cwd: branchProject }), "allow");
  });

  test("일반 명령은 허용", () => assert.equal(bash("git status && pnpm lint"), "allow"));
  test("cony 프로젝트가 아니면 관여하지 않음", () =>
    assert.equal(bash("git push --force", { cwd: outside }), "allow"));

  test("다른 폴더에서 cd로 들어가도 적용", () =>
    assert.equal(bash(`cd ${project} && git commit --amend`, { cwd: outside }), "deny"));
  test("git -C 경로 형태도 적용", () =>
    assert.equal(bash(`git -C ${project} push --force`, { cwd: outside }), "deny"));

  test("CI 통과한 PR은 머지 허용", () =>
    assert.equal(bash("gh pr merge 1 --squash", { env: { FAKE_GH_STATUS: "0" } }), "allow"));
  test("CI 진행 중이면 머지 차단", () =>
    assert.equal(bash("gh pr merge 1 --squash", { env: { FAKE_GH_STATUS: "8" } }), "deny"));
  test("merge가 pr이면 CI가 통과해도 머지 차단, PR 생성은 허용", () => {
    const prProject = createProject();
    git(prProject, "switch", "-q", "-c", "cony/feature");
    writeFileSync(join(prProject, ".cony", "team.json"), JSON.stringify({ merge: "pr" }));
    assert.equal(bash("gh pr merge 1 --squash", { cwd: prProject, env: { FAKE_GH_STATUS: "0" } }), "deny");
    assert.equal(bash("gh pr create --fill", { cwd: prProject }), "allow");
    assert.equal(bash("git push -u origin HEAD", { cwd: prProject }), "allow");
  });

  test("merge가 none이면 push와 PR 생성도 차단, 커밋은 허용", () => {
    const localProject = createProject();
    git(localProject, "switch", "-q", "-c", "cony/feature");
    writeFileSync(join(localProject, ".cony", "team.json"), JSON.stringify({ merge: "none" }));
    assert.equal(bash("git push -u origin HEAD", { cwd: localProject }), "deny");
    assert.equal(bash("gh pr create --fill", { cwd: localProject }), "deny");
    assert.equal(bash("git commit -m 'feat: x'", { cwd: localProject }), "allow");
  });

  test("CI 실패면 머지 차단", () =>
    assert.equal(bash("gh pr merge 1 --squash", { env: { FAKE_GH_STATUS: "1" } }), "deny"));
});

describe("lint-on-edit: 수정 즉시 lint", () => {
  const project = createProject();
  const outside = createProject({ cony: false });
  const edited = (file, session_id = "lint") =>
    decisionOf(runHook("lint-on-edit.mjs", { session_id, tool_input: { file_path: file } }));

  test("lint 오류가 있으면 막고 알림", () => {
    writeFileSync(join(project, "src", "bad.ts"), "// LINT_ERROR\n");
    assert.equal(edited(join(project, "src", "bad.ts")), "block");
  });
  test("lint 통과면 통과", () => assert.equal(edited(join(project, "src", "index.ts")), "allow"));
  test("코드 파일이 아니면 검사하지 않음", () => {
    writeFileSync(join(project, "notes.md"), "LINT_ERROR\n");
    assert.equal(edited(join(project, "notes.md")), "allow");
  });
  test("cony 프로젝트가 아니면 관여하지 않음", () => {
    writeFileSync(join(outside, "src", "bad.ts"), "// LINT_ERROR\n");
    assert.equal(edited(join(outside, "src", "bad.ts")), "allow");
  });
});

describe("verify-on-stop: 종료 전 lint + typecheck", () => {
  test("변경이 없으면 통과", () => {
    const project = createProject();
    assert.equal(decisionOf(runHook("verify-on-stop.mjs", { cwd: project })), "allow");
  });

  test("타입 오류가 있으면 3회까지 막고 그 뒤엔 경고만", () => {
    const project = createProject();
    writeFileSync(join(project, "src", "broken.ts"), "// TYPE_ERROR\n");
    for (let i = 0; i < 3; i += 1) {
      assert.equal(decisionOf(runHook("verify-on-stop.mjs", { cwd: project })), "block");
    }
    assert.equal(decisionOf(runHook("verify-on-stop.mjs", { cwd: project })), "message");
  });

  test("실패 내용이 바뀌어도 연속 실패 횟수는 세션 기준으로 이어진다", () => {
    const project = createProject();
    const file = join(project, "src", "broken.ts");
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(file, `// TYPE_ERROR ${i}\n`);
      assert.equal(decisionOf(runHook("verify-on-stop.mjs", { cwd: project, session_id: "s-reset" })), "block");
    }
    writeFileSync(file, "// TYPE_ERROR changed again\n");
    assert.equal(decisionOf(runHook("verify-on-stop.mjs", { cwd: project, session_id: "s-reset" })), "message");
  });

  test("고치면 통과하고, 같은 내용은 다시 검사하지 않음", () => {
    const project = createProject();
    writeFileSync(join(project, "src", "broken.ts"), "// LINT_ERROR\n");
    assert.equal(decisionOf(runHook("verify-on-stop.mjs", { cwd: project })), "block");
    writeFileSync(join(project, "src", "broken.ts"), "export const fixed = 1;\n");
    assert.equal(decisionOf(runHook("verify-on-stop.mjs", { cwd: project })), "allow");
    const state = JSON.parse(readFileSync(join(project, ".cony", ".cache", "verify.json"), "utf8"));
    assert.ok(state.passed);
  });

  test("명령만 실행한 프로젝트는 검사하지 않는다 (다른 세션이 작업 중인 코드)", () => {
    const project = createProject();
    const outside = createProject({ cony: false });
    writeFileSync(join(project, "src", "wip.ts"), "// TYPE_ERROR\n");
    runHook("guard-bash.mjs", { session_id: "reader", cwd: outside, tool_input: { command: `cd ${project} && node cli.mjs board` } });
    assert.equal(decisionOf(runHook("verify-on-stop.mjs", { cwd: outside, session_id: "reader" })), "allow");
  });

  test("세션 폴더가 달라도 이 세션이 수정한 프로젝트를 검사", () => {
    const project = createProject();
    const outside = createProject({ cony: false });
    const file = join(project, "src", "broken.ts");
    writeFileSync(file, "export const ok = 1;\n");
    runHook("lint-on-edit.mjs", { session_id: "remember", tool_input: { file_path: file } });
    writeFileSync(file, "// TYPE_ERROR\n");
    assert.equal(decisionOf(runHook("verify-on-stop.mjs", { cwd: outside, session_id: "remember" })), "block");
    assert.equal(decisionOf(runHook("verify-on-stop.mjs", { cwd: outside, session_id: "other" })), "allow");
  });
});

describe("board-on-stop / board-on-end: 보드 상태", () => {
  // 리드 = 이 세션에서 board.mjs 를 실행했거나 board.md 를 고친 세션
  const becomeLead = (project, session_id) =>
    runHook("guard-bash.mjs", {
      session_id,
      cwd: project,
      tool_input: { command: 'node "/plugin/skills/team/board.mjs" --task 1=doing' },
    });
  const boardText = (project) => readFileSync(join(project, ".cony", "board.md"), "utf8");
  // 보드를 minutes 분 전에 마지막으로 고친 것처럼 만든다
  const ageBoard = (project, minutes) => {
    const t = new Date(Date.now() - minutes * 60_000);
    utimesSync(join(project, ".cony", "board.md"), t, t);
  };

  test("리드가 진행 중인 채로 15분 넘게 보드를 안 고치고 턴을 끝내면 막음", () => {
    const project = createProject();
    writeBoard(project, "진행 중");
    becomeLead(project, "lead-1");
    ageBoard(project, 20);
    assert.equal(decisionOf(runHook("board-on-stop.mjs", { cwd: project, session_id: "lead-1" })), "block");
    assert.equal(
      decisionOf(runHook("board-on-stop.mjs", { cwd: project, session_id: "lead-1", stop_hook_active: true })),
      "allow",
    );
  });

  test("board.md 를 직접 고친 세션도 리드로 본다", () => {
    const project = createProject();
    writeBoard(project, "진행 중");
    runHook("guard-instructions.mjs", {
      session_id: "lead-edit",
      tool_input: { file_path: join(project, ".cony", "board.md") },
    });
    ageBoard(project, 20);
    assert.equal(decisionOf(runHook("board-on-stop.mjs", { cwd: project, session_id: "lead-edit" })), "block");
  });

  test("보드를 최근 15분 안에 고쳤으면 막지 않음", () => {
    const project = createProject();
    writeBoard(project, "진행 중");
    becomeLead(project, "lead-fresh");
    ageBoard(project, 5);
    assert.equal(decisionOf(runHook("board-on-stop.mjs", { cwd: project, session_id: "lead-fresh" })), "allow");
  });

  test("한 번 막은 뒤 30분 동안은 다시 막지 않음", () => {
    const project = createProject();
    writeBoard(project, "진행 중");
    becomeLead(project, "lead-cool");
    ageBoard(project, 20);
    assert.equal(decisionOf(runHook("board-on-stop.mjs", { cwd: project, session_id: "lead-cool" })), "block");
    assert.equal(decisionOf(runHook("board-on-stop.mjs", { cwd: project, session_id: "lead-cool" })), "allow");
  });

  test("보드를 갱신하지 않은 세션(/cony:status 등)은 막지 않음", () => {
    const project = createProject();
    writeBoard(project, "진행 중");
    becomeLead(project, "lead-2");
    runHook("guard-bash.mjs", { session_id: "viewer", cwd: project, tool_input: { command: "git status --short" } });
    assert.equal(decisionOf(runHook("board-on-stop.mjs", { cwd: project, session_id: "viewer" })), "allow");
  });

  test("리드가 사용자 대기·완료로 바꾸면 통과", () => {
    const project = createProject();
    becomeLead(project, "lead-3");
    writeBoard(project, "사용자 대기");
    assert.equal(decisionOf(runHook("board-on-stop.mjs", { cwd: project, session_id: "lead-3" })), "allow");
    writeBoard(project, "완료");
    assert.equal(decisionOf(runHook("board-on-stop.mjs", { cwd: project, session_id: "lead-3" })), "allow");
  });

  test("리드 세션이 끝나면 진행 중을 중단됨으로 바꿈", () => {
    const project = createProject();
    writeBoard(project, "진행 중");
    becomeLead(project, "lead-4");
    runHook("board-on-end.mjs", { cwd: project, session_id: "lead-4" });
    assert.match(boardText(project), /상태: 중단됨/);
  });

  test("다른 세션이 끝나도 리드의 보드는 그대로", () => {
    const project = createProject();
    writeBoard(project, "진행 중");
    becomeLead(project, "lead-5");
    runHook("guard-bash.mjs", { session_id: "viewer-2", cwd: project, tool_input: { command: "git diff --stat" } });
    runHook("board-on-end.mjs", { cwd: project, session_id: "viewer-2" });
    assert.match(boardText(project), /상태: 진행 중/);
  });

  test("완료 상태는 건드리지 않음", () => {
    const project = createProject();
    writeBoard(project, "완료");
    becomeLead(project, "lead-6");
    runHook("board-on-end.mjs", { cwd: project, session_id: "lead-6" });
    assert.match(boardText(project), /상태: 완료/);
  });
});

describe("session-start: 보드 주입", () => {
  test("cony 프로젝트면 보드 내용을 컨텍스트로 넣음", () => {
    const project = createProject();
    writeBoard(project, "진행 중");
    const out = runHook("session-start.mjs", { cwd: project });
    assert.match(out.hookSpecificOutput.additionalContext, /상태: 진행 중/);
  });

  test("cony 프로젝트가 아니면 아무것도 넣지 않음", () => {
    const outside = createProject({ cony: false });
    assert.equal(runHook("session-start.mjs", { cwd: outside }), null);
  });
});
