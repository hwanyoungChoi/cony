#!/usr/bin/env node
// 작업 브랜치를 push → PR → CI 대기 → (merge 설정에 따라) 머지까지 하고, 단계마다 한 줄만 출력한다.
// 리드가 git·gh 명령과 CI 출력을 대화에 쌓지 않게 하려고 만들었다(모기지핏 리드 대화의 약 28%가 Bash 명령과 출력).
//
//   새 PR:     node ship.mjs --title "기능 이름" --body-file .cony/reports/20261028-feature.md
//   다시:      node ship.mjs            (CI를 고쳐 push한 뒤, 이 브랜치의 PR로 다시 대기·머지)
//
// hook은 이 스크립트 안의 git·gh 호출을 보지 못하므로, hook이 지키던 규칙을 여기서 같이 지킨다.
//   - team.json merge: none 이면 push 하지 않는다. pr 이면 CI 통과까지만 하고 멈춘다. auto 면 머지한다.
//   - 기본 브랜치에서는 실행하지 않는다. 커밋하지 않은 변경(.cony/ 제외)이 있으면 실행하지 않는다.
//   - CI가 없거나 하나라도 실패하면 머지하지 않는다.
// CI를 기다리느라 오래 걸리므로 백그라운드로 실행한다.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { findConyRoot, logEvent, readTeamConfig, runNewerInstall } from "../../hooks/lib.mjs";

runNewerInstall(import.meta.url);

const { values } = parseArgs({
  options: {
    title: { type: "string" },
    "body-file": { type: "string" },
  },
});

const CI_WAIT_MS = Number(process.env.CONY_SHIP_CI_WAIT_MS ?? 30 * 60_000);
const NO_CHECKS_RETRY_MS = Number(process.env.CONY_SHIP_NO_CHECKS_RETRY_MS ?? 10_000);
const NO_CHECKS_TRIES = 12;

const say = (line) => console.log(`ship: ${line}`);
function fail(line) {
  console.error(`ship: ${line}`);
  process.exit(1);
}
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryRun = (cmd, args) => {
  try {
    return run(cmd, args);
  } catch {
    return null;
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const conyRoot = findConyRoot(process.cwd());
if (!conyRoot) fail(".cony/ 를 찾을 수 없습니다. cony 프로젝트에서 실행하세요.");
const { merge } = readTeamConfig(conyRoot);
if (merge === "none") fail('team.json 의 merge 가 "none"입니다. push·PR·머지는 사용자가 합니다.');

const branch = run("git", ["branch", "--show-current"]);
const base =
  tryRun("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "") ??
  tryRun("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]) ??
  "main";
if (!branch || branch === base) fail(`기본 브랜치(${base})에서는 실행하지 않습니다. 작업 브랜치에서 실행하세요.`);
const dirty = run("git", ["status", "--porcelain", "--", ".", ":(exclude).cony"]);
if (dirty) fail(`커밋하지 않은 변경이 있습니다.\n${dirty}`);

run("git", ["push", "-u", "origin", branch]);
say(`push ${branch}`);

let pr = prOfBranch();
if (!pr) {
  if (!values.title || !values["body-file"]) fail("이 브랜치에 PR이 없습니다. --title 과 --body-file 을 주세요.");
  run("gh", ["pr", "create", "--base", base, "--head", branch, "--title", values.title, "--body-file", values["body-file"]]);
  pr = prOfBranch();
  if (!pr) fail("PR을 만들었는데 찾지 못했습니다. gh pr view 로 확인하세요.");
}
say(`PR #${pr.number} ${pr.url}`);
board(`[#${pr.number}](${pr.url}) · CI 진행 중`);

const checks = waitForChecks(pr.number);
const failed = checks.filter((c) => ["fail", "cancel"].includes(c.bucket));
if (failed.length) {
  const names = failed.map((c) => c.name).join(", ");
  board(`[#${pr.number}](${pr.url}) · CI 실패(${names})`);
  logEvent(conyRoot, { type: "ship", pr: pr.number, result: "ci_failed" });
  fail(`CI 실패 — ${failed.map((c) => `${c.name}${c.link ? ` ${c.link}` : ""}`).join(" · ")}\n고쳐서 커밋한 뒤 다시 실행하세요.`);
}
say(`CI 통과 (${checks.map((c) => c.name).join(", ")})`);

if (merge !== "auto") {
  board(`[#${pr.number}](${pr.url}) · CI 통과 · 머지는 사용자`);
  logEvent(conyRoot, { type: "ship", pr: pr.number, result: "ready" });
  say('merge 가 "pr"이라 여기서 멈춥니다. 머지는 사용자가 합니다.');
  process.exit(0);
}

// ship이 고친 보드·이벤트 기록(.cony/ 아래 추적 파일)이 남아 있으면 기본 브랜치로 바꿀 때
// "local changes would be overwritten"으로 멈춘다(모기지핏 PR #52·#53). 커밋된 내용으로 잠시 되돌렸다가 돌아온 뒤 다시 얹는다.
const held = holdConyChanges();
mergePr(pr.number);
const sha = (tryRun("gh", ["pr", "view", String(pr.number), "--json", "mergeCommit", "-q", ".mergeCommit.oid"]) ?? "").slice(0, 7);
let syncError = run("git", ["branch", "--show-current"]) !== base ? gitError(["switch", base]) : null;
syncError ??= gitError(["pull", "--ff-only", "-q"]);
restoreConyChanges(held);
board(`[#${pr.number}](${pr.url}) · CI 통과 · 머지됨${sha ? `(${sha})` : ""}`);
logEvent(conyRoot, { type: "ship", pr: pr.number, result: "merged", ...(syncError ? { sync: "failed" } : {}) });
if (syncError) {
  const status = tryRun("git", ["status", "--porcelain"]);
  fail(`머지됨${sha ? ` ${sha}` : ""} · 그런데 ${base}로 돌아오지 못했습니다. 아래를 정리하고 git switch ${base} && git pull 하세요.\n${syncError}${status ? `\n${status}` : ""}`);
}
say(`머지됨${sha ? ` ${sha}` : ""} · ${base} 최신으로 받음`);

function prOfBranch() {
  const out = tryRun("gh", ["pr", "view", branch, "--json", "number,url,state"]);
  if (!out) return null;
  const pr = JSON.parse(out);
  return pr.state === "OPEN" ? pr : null;
}

// gh pr checks --watch 는 출력이 길어서 버리고, 끝난 뒤 결과만 JSON으로 읽는다.
// PR을 막 만들면 CI가 아직 등록되지 않아 "no checks reported"가 나오므로 잠시 다시 시도한다.
function waitForChecks(number) {
  say("CI 대기 중");
  for (let i = 0; i < NO_CHECKS_TRIES; i += 1) {
    const watch = spawnSync("gh", ["pr", "checks", String(number), "--watch", "--interval", "15"], {
      encoding: "utf8",
      timeout: CI_WAIT_MS,
    });
    if (watch.error?.code === "ETIMEDOUT") fail(`CI가 ${Math.round(CI_WAIT_MS / 60000)}분 안에 끝나지 않았습니다. 나중에 다시 실행하세요.`);
    if (/no checks reported/i.test(`${watch.stdout}${watch.stderr}`)) {
      sleep(NO_CHECKS_RETRY_MS);
      continue;
    }
    const list = JSON.parse(tryRun("gh", ["pr", "checks", String(number), "--json", "name,bucket,link"]) ?? "[]");
    if (list.length) return list;
    sleep(NO_CHECKS_RETRY_MS);
  }
  fail("CI가 없습니다. CI가 통과해야 머지할 수 있습니다(/cony:setup 의 CI 단계).");
}

// gh pr merge --delete-branch 는 원격 머지 뒤 로컬에서 브랜치를 바꾸다 실패해도 0이 아닌 값으로 끝난다. 머지됐는지는 PR 상태로 본다.
function mergePr(number) {
  try {
    run("gh", ["pr", "merge", String(number), "--squash", "--delete-branch"]);
  } catch (error) {
    if (tryRun("gh", ["pr", "view", String(number), "--json", "state", "-q", ".state"]) === "MERGED") return;
    restoreConyChanges(held);
    fail(`머지 실패 — ${(error.stderr || error.message).trim()}`);
  }
}

function gitError(args) {
  try {
    run("git", args);
    return null;
  } catch (error) {
    return (error.stderr || error.message).trim();
  }
}

// .cony/ 아래에서 커밋된 것과 달라진 추적 파일을 기억해 두고 커밋된 내용으로 되돌린다.
function holdConyChanges() {
  const top = run("git", ["rev-parse", "--show-toplevel"]);
  const files = run("git", ["diff", "--name-only", "HEAD", "--", join(conyRoot, ".cony")]).split("\n").filter(Boolean);
  const held = [];
  for (const file of files) {
    const path = join(top, file);
    let committed;
    try {
      committed = execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue; // 아직 커밋된 적 없는 파일은 브랜치를 바꿔도 남는다
    }
    if (existsSync(path)) held.push({ file, path, committed, mine: readFileSync(path, "utf8") });
  }
  if (held.length) run("git", ["checkout", "HEAD", "--", ...held.map(({ file }) => `:(top)${file}`)]);
  return held;
}

// 지금 파일이 되돌릴 때의 커밋 내용 그대로면(squash 머지된 기본 브랜치도 같다) 기억한 내용을 그대로 얹는다.
// 기본 브랜치에서 달라졌으면 덧붙인 줄(events.jsonl 등)만 이어 붙이고, 덮어쓰는 파일(보드)은 기본 브랜치 것을 둔다.
function restoreConyChanges(held) {
  for (const { path, committed, mine } of held) {
    const now = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (now === committed) writeFileSync(path, mine);
    else if (mine.startsWith(committed)) writeFileSync(path, now + mine.slice(committed.length));
  }
}

function board(pr) {
  spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "board.mjs"), "--pr", pr], { stdio: "ignore" });
}
