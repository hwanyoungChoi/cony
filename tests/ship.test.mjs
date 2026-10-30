import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../plugins/cony/skills/team/ship.mjs", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "cony-ship-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

// 가짜 gh: 호출을 기록하고, PR 상태를 파일에 둔다. CI 결과는 FAKE_CI(pass | fail | none)로 정한다.
const fakeBin = join(base, "bin");
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "gh"),
  `#!/usr/bin/env node
const fs = require("fs");
const state = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(state + ".log", args.join(" ") + "\\n");
const pr = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : null;
const ci = process.env.FAKE_CI ?? "pass";
const [a, b] = args;
if (a === "repo") { console.log("main"); process.exit(0); }
if (a === "pr" && b === "view" && args.includes("mergeCommit")) { console.log("abcdef1234567"); process.exit(0); }
if (a === "pr" && b === "view" && args.includes("state") && args.includes("-q")) { console.log(pr?.state ?? ""); process.exit(0); }
if (a === "pr" && b === "view") { if (!pr) process.exit(1); console.log(JSON.stringify(pr)); process.exit(0); }
if (a === "pr" && b === "create") { fs.writeFileSync(state, JSON.stringify({ number: 7, url: "https://github.com/x/y/pull/7", state: "OPEN" })); console.log("https://github.com/x/y/pull/7"); process.exit(0); }
if (a === "pr" && b === "checks" && args.includes("--watch")) {
  if (ci === "none") { console.error("no checks reported on the 'feat' branch"); process.exit(1); }
  process.exit(ci === "pass" ? 0 : 1);
}
if (a === "pr" && b === "checks") {
  if (ci === "none") { console.log("[]"); process.exit(0); }
  console.log(JSON.stringify([{ name: "verify", bucket: ci === "pass" ? "pass" : "fail", link: "https://ci/1" }]));
  process.exit(0);
}
if (a === "pr" && b === "merge") {
  // 원격에서 머지된 것처럼 작업 브랜치를 origin/main 에 올린다(squash 와 내용은 같다).
  const { execFileSync } = require("child_process");
  execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { stdio: "ignore" });
  fs.writeFileSync(state, JSON.stringify({ ...pr, state: "MERGED" }));
  // 진짜 gh 처럼 --delete-branch 면 로컬도 기본 브랜치로 바꾼다. 못 바꾸면 머지는 됐어도 실패로 끝난다.
  if (args.includes("--delete-branch")) {
    try {
      execFileSync("git", ["checkout", "-q", "main"], { stdio: "pipe" });
    } catch (error) {
      process.stderr.write(String(error.stderr));
      process.exit(1);
    }
  }
  process.exit(0);
}
process.exit(0);
`,
);
chmodSync(join(fakeBin, "gh"), 0o755);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let count = 0;
// origin(bare) + 작업 복사본. main 에 첫 커밋, feat 브랜치에 커밋 하나.
// tracked: 보드와 이벤트 기록을 git이 추적하고, feat 커밋에서 둘 다 바꾼다(모기지핏처럼).
function project(team = {}, { tracked = false } = {}) {
  count += 1;
  const root = join(base, `p${count}`);
  const origin = join(root, "origin.git");
  const dir = join(root, "work");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "switch", "-q", "-c", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  mkdirSync(join(dir, ".cony", "metrics"), { recursive: true });
  writeFileSync(join(dir, ".cony", "team.json"), JSON.stringify(team));
  writeFileSync(join(dir, ".cony", "board.md"), "# 기능\n> 상태: 진행 중 · 마지막 업데이트: 2026-10-28 10:00\n\n## 태스크\n\n## PR\n아직 없음\n");
  writeFileSync(join(dir, ".cony", "metrics", "events.jsonl"), '{"type":"start"}\n');
  writeFileSync(join(dir, ".gitignore"), tracked ? ".cony/team.json\n" : ".cony/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "push", "-q", "-u", "origin", "main");
  git(dir, "remote", "set-head", "origin", "main");
  git(dir, "switch", "-q", "-c", "feat");
  writeFileSync(join(dir, "b.txt"), "b\n");
  if (tracked) {
    writeFileSync(join(dir, ".cony", "board.md"), "# 기능\n> 상태: 진행 중 · 마지막 업데이트: 2026-10-28 11:00\n\n## 태스크\n- [x] 1. 표 내보내기\n\n## PR\n아직 없음\n");
    writeFileSync(join(dir, ".cony", "metrics", "events.jsonl"), '{"type":"start"}\n{"type":"task"}\n');
  }
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "feat");
  writeFileSync(join(dir, ".cony", "body.md"), "본문\n");
  return { dir, state: join(root, "gh-state.json") };
}

function ship(p, args = [], env = {}) {
  return spawnSync("node", [SCRIPT, ...args], {
    cwd: p.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_GH_STATE: p.state,
      CONY_SHIP_NO_CHECKS_RETRY_MS: "1",
      ...env,
    },
  });
}

const ghLog = (p) => (existsSync(`${p.state}.log`) ? readFileSync(`${p.state}.log`, "utf8") : "");

test("auto: push → PR → CI 통과 → 머지 → 기본 브랜치로 돌아와 최신을 받는다", () => {
  const p = project();
  const r = ship(p, ["--title", "기능", "--body-file", ".cony/body.md"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ship: PR #7/);
  assert.match(r.stdout, /ship: CI 통과 \(verify\)/);
  assert.match(r.stdout, /ship: 머지됨 abcdef1/);
  assert.match(ghLog(p), /pr merge 7 --squash --delete-branch/);
  assert.equal(git(p.dir, "branch", "--show-current"), "main");
  assert.match(git(join(p.dir, "..", "origin.git"), "branch", "--list", "feat"), /feat/, "push 됐다");
  assert.match(readFileSync(join(p.dir, ".cony", "board.md"), "utf8"), /\[#7\]\(https:\/\/github.com\/x\/y\/pull\/7\) · CI 통과 · 머지됨\(abcdef1\)/);
  assert.equal(r.stdout.trim().split("\n").length, 5, "단계마다 한 줄씩만 출력한다");
});

test("추적되는 보드를 ship이 고쳐도 머지 뒤 기본 브랜치로 돌아오고, 보드·이벤트 기록이 남는다", () => {
  const p = project({}, { tracked: true });
  const r = ship(p, ["--title", "기능", "--body-file", ".cony/body.md"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ship: 머지됨 abcdef1 · main 최신으로 받음/);
  assert.equal(git(p.dir, "branch", "--show-current"), "main");
  assert.equal(git(p.dir, "rev-parse", "HEAD"), git(p.dir, "rev-parse", "feat"), "머지된 내용을 받았다");
  const board = readFileSync(join(p.dir, ".cony", "board.md"), "utf8");
  assert.match(board, /- \[x\] 1\. 표 내보내기/, "브랜치에서 커밋한 보드 내용");
  assert.match(board, /\[#7\]\(https:\/\/github.com\/x\/y\/pull\/7\) · CI 통과 · 머지됨\(abcdef1\)/);
  const events = readFileSync(join(p.dir, ".cony", "metrics", "events.jsonl"), "utf8").trim().split("\n");
  assert.deepEqual(events.slice(0, 2).map((line) => JSON.parse(line).type), ["start", "task"]);
  assert.match(events.at(-1), /"type":"ship".*"result":"merged"/);
  assert.doesNotMatch(events.at(-1), /sync/);
});

test("머지 뒤 기본 브랜치를 최신으로 받지 못하면 머지는 기록하고, 이유를 알려주고 끝낸다", () => {
  const p = project({}, { tracked: true });
  // 로컬 main 에만 있는 커밋이 있으면 pull --ff-only 가 멈춘다.
  git(p.dir, "switch", "-q", "main");
  writeFileSync(join(p.dir, "c.txt"), "local\n");
  git(p.dir, "add", "c.txt");
  git(p.dir, "commit", "-q", "-m", "로컬에만");
  git(p.dir, "switch", "-q", "feat");
  const r = ship(p, ["--title", "기능", "--body-file", ".cony/body.md"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /머지됨 abcdef1 · 그런데 main로 돌아오지 못했습니다/);
  assert.match(r.stderr, /fast-forward/i);
  const events = readFileSync(join(p.dir, ".cony", "metrics", "events.jsonl"), "utf8").trim().split("\n");
  assert.match(events.at(-1), /"result":"merged","sync":"failed"/);
  assert.match(readFileSync(join(p.dir, ".cony", "board.md"), "utf8"), /머지됨\(abcdef1\)/);
});

test("CI가 실패하면 머지하지 않고 실패한 검사를 알려준다", () => {
  const p = project();
  const r = ship(p, ["--title", "기능", "--body-file", ".cony/body.md"], { FAKE_CI: "fail" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /CI 실패 — verify https:\/\/ci\/1/);
  assert.doesNotMatch(ghLog(p), /pr merge/);
  assert.match(readFileSync(join(p.dir, ".cony", "board.md"), "utf8"), /CI 실패\(verify\)/);
});

test("CI가 없으면 머지하지 않는다", () => {
  const p = project();
  const r = ship(p, ["--title", "기능", "--body-file", ".cony/body.md"], { FAKE_CI: "none" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /CI가 없습니다/);
  assert.doesNotMatch(ghLog(p), /pr merge/);
});

test('merge "pr"이면 CI 통과까지만 하고 멈춘다', () => {
  const p = project({ merge: "pr" });
  const r = ship(p, ["--title", "기능", "--body-file", ".cony/body.md"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /머지는 사용자가 합니다/);
  assert.doesNotMatch(ghLog(p), /pr merge/);
  assert.equal(git(p.dir, "branch", "--show-current"), "feat");
});

test('merge "none"이면 push 하지 않는다', () => {
  const p = project({ merge: "none" });
  const r = ship(p, ["--title", "기능", "--body-file", ".cony/body.md"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /사용자가 합니다/);
  assert.equal(git(join(p.dir, "..", "origin.git"), "branch", "--list", "feat"), "");
});

test("기본 브랜치에서, 또는 커밋하지 않은 변경이 있으면 실행하지 않는다", () => {
  const p = project();
  writeFileSync(join(p.dir, "b.txt"), "changed\n");
  const dirty = ship(p, ["--title", "기능", "--body-file", ".cony/body.md"]);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /커밋하지 않은 변경/);

  git(p.dir, "checkout", "-q", "--", "b.txt");
  git(p.dir, "switch", "-q", "main");
  const onMain = ship(p, ["--title", "기능", "--body-file", ".cony/body.md"]);
  assert.notEqual(onMain.status, 0);
  assert.match(onMain.stderr, /기본 브랜치\(main\)/);
});

test("PR이 이미 있으면 다시 만들지 않고 그 PR로 대기·머지한다", () => {
  const p = project();
  writeFileSync(p.state, JSON.stringify({ number: 9, url: "https://github.com/x/y/pull/9", state: "OPEN" }));
  const r = ship(p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PR #9/);
  assert.doesNotMatch(ghLog(p), /pr create/);
});

test("플러그인 캐시의 예전 버전으로 불리면 설치된 최신 버전에 넘긴다", () => {
  const cony = join(base, "plugins", "cache", "conychoi-plugins", "cony");
  for (const v of ["0.21.0", "0.21.1"]) {
    mkdirSync(join(cony, v, "skills", "team"), { recursive: true });
    mkdirSync(join(cony, v, "hooks"), { recursive: true });
    writeFileSync(join(cony, v, "hooks", "lib.mjs"), readFileSync(new URL("../plugins/cony/hooks/lib.mjs", import.meta.url)));
  }
  writeFileSync(join(cony, "0.21.0", "skills", "team", "ship.mjs"), readFileSync(SCRIPT));
  writeFileSync(join(cony, "0.21.1", "skills", "team", "ship.mjs"), 'console.log("latest", process.argv.slice(2).join(" "));\nprocess.exit(3);\n');

  const r = spawnSync("node", [join(cony, "0.21.0", "skills", "team", "ship.mjs"), "--title", "기능"], { encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.trim(), "latest --title 기능");
});
