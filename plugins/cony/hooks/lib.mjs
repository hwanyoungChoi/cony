import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

export function output(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// .cony/ 가 있는 프로젝트에서만 하네스가 동작한다.
export function findConyRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".cony"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findUp(start, fileName, stopAt) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, fileName))) return dir;
    if (dir === stopAt) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function binPath(pkgDir, name) {
  const bin = join(pkgDir, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  return existsSync(bin) ? bin : null;
}

export function detectPackageManager(pkgDir, root) {
  const locks = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  for (const [lock, pm] of locks) {
    if (findUp(pkgDir, lock, root)) return pm;
  }
  return "npm";
}

export function truncate(text, max = 4000) {
  return text.length > max ? `${text.slice(0, max)}\n... (생략)` : text;
}

export function expandHome(path) {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

// 세션을 연 폴더와 실제로 작업한 프로젝트가 다를 수 있어서,
// 이 세션이 건드린 cony 프로젝트를 기억해 두고 Stop·SessionEnd 에서 함께 본다.
// kind "touched": 파일을 고치거나 명령을 실행한 프로젝트 (종료 전 검증 대상)
// kind "lead": 보드를 갱신한 프로젝트 (보드 hook 대상). 상태만 보는 세션은 여기에 들지 않는다.
function sessionFile(sessionId, kind) {
  const suffix = kind === "touched" ? "" : `.${kind}`;
  return join(tmpdir(), "cony-hooks", `${String(sessionId).replace(/[^\w-]/g, "_")}${suffix}.json`);
}

export function rememberRoot(sessionId, root, kind = "touched") {
  if (!sessionId || !root) return;
  const roots = rememberedRoots(sessionId, kind);
  if (roots.includes(root)) return;
  const file = sessionFile(sessionId, kind);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...roots, root]));
}

export function rememberedRoots(sessionId, kind = "touched") {
  if (!sessionId) return [];
  try {
    return JSON.parse(readFileSync(sessionFile(sessionId, kind), "utf8"));
  } catch {
    return [];
  }
}

export function leadRoots(sessionId) {
  return rememberedRoots(sessionId, "lead");
}

export function forgetSession(sessionId) {
  if (!sessionId) return;
  for (const kind of ["touched", "lead"]) rmSync(sessionFile(sessionId, kind), { force: true });
}

export function sessionRoots(input) {
  const roots = [findConyRoot(input.cwd ?? process.cwd()), ...rememberedRoots(input.session_id)];
  return [...new Set(roots.filter(Boolean))];
}

// .cony/team.json. 없거나 깨졌으면 기본값(전원 build, 결정 team, 머지 auto)
export function readTeamConfig(root) {
  const defaults = { pm: "build", fe: "build", be: "build", qa: "build", decisions: "team", merge: "auto" };
  try {
    return { ...defaults, ...JSON.parse(readFileSync(join(root, ".cony", "team.json"), "utf8")) };
  } catch {
    return defaults;
  }
}

export function readBoardStatus(root) {
  const path = join(root, ".cony", "board.md");
  if (!existsSync(path)) return null;
  const board = readFileSync(path, "utf8");
  const status = (board.match(/^>\s*상태:\s*([^·\n]+)/m) || [])[1]?.trim() ?? "";
  return { path, board, status };
}

// 지표용 기록. 실패해도 hook 동작에는 영향을 주지 않는다.
export function logEvent(root, event) {
  if (!root) return;
  try {
    const dir = join(root, ".cony", "metrics");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  } catch {
    // 기록 실패는 무시
  }
}
