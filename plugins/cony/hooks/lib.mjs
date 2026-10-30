import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
// kind "edited": 이 세션이 파일을 실제로 고친 프로젝트 (종료 전 검증 대상).
//   명령만 실행한 프로젝트는 넣지 않는다. 다른 세션이 작업 중인 코드를 대신 검증하게 되기 때문이다.
// kind "lead": 보드를 갱신한 프로젝트 (보드 hook 대상). 상태만 보는 세션은 여기에 들지 않는다.
// kind "touched": 예전 버전이 쓰던 이름. 읽지 않고 정리만 한다.
function sessionFile(sessionId, kind) {
  const suffix = kind === "touched" ? "" : `.${kind}`;
  return join(tmpdir(), "cony-hooks", `${String(sessionId).replace(/[^\w-]/g, "_")}${suffix}.json`);
}

export function rememberRoot(sessionId, root, kind = "edited") {
  if (!sessionId || !root) return;
  const roots = rememberedRoots(sessionId, kind);
  if (roots.includes(root)) return;
  const file = sessionFile(sessionId, kind);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...roots, root]));
}

// 목록에 더하지 않고 값 하나로 덮어쓴다 (예: 마지막으로 막은 시각)
export function rememberValue(sessionId, kind, value) {
  if (!sessionId) return;
  const file = sessionFile(sessionId, kind);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([value]));
}

export function rememberedRoots(sessionId, kind = "edited") {
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
  for (const kind of ["edited", "lead", "board-stop-at", "context-warned", "touched", "skill-version", "teammate-idle"]) rmSync(sessionFile(sessionId, kind), { force: true });
}

export function sessionRoots(input) {
  const roots = [findConyRoot(input.cwd ?? process.cwd()), ...rememberedRoots(input.session_id)];
  return [...new Set(roots.filter(Boolean))];
}

// .cony/team.json. 없거나 깨졌으면 기본값(전원 build, 결정 team, 머지 auto)
// 팀원을 어떻게 띄우나. "subagents": 리드가 부르고 결과를 받아 중계한다. "teams": 에이전트 팀으로 띄워 팀원끼리 직접 대화한다.
// 기본값을 바꾸려면 이 상수 하나와 skills/team/SKILL.md 의 "mode" 표만 고친다.
export const DEFAULT_TEAM_MODE = "subagents";

export function readTeamConfig(root) {
  const defaults = { pm: "build", fe: "build", be: "build", qa: "build", decisions: "team", merge: "auto", mode: DEFAULT_TEAM_MODE };
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

// 오래 켜 둔 세션은 스킬을 처음 불러온 버전의 경로로 스크립트를 계속 부른다.
// 플러그인 캐시에 더 새 버전이 깔려 있으면 같은 스크립트의 새 버전을 대신 실행하고 그 결과로 끝낸다.
export function runNewerInstall(scriptUrl) {
  const newer = newerInstall(fileURLToPath(scriptUrl));
  if (!newer) return;
  const r = spawnSync(process.execPath, [newer, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function newerInstall(self) {
  const m = self.match(/^(.*[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/]cony)[\\/]([^\\/]+)[\\/](skills[\\/].+)$/);
  if (!m) return null;
  const [, base, current, rel] = m;
  const latest = readdirSync(base)
    .filter((v) => /^\d+(\.\d+)*$/.test(v) && existsSync(join(base, v, rel)))
    .sort(compareVersions)
    .at(-1);
  return latest && compareVersions(latest, current) > 0 ? join(base, latest, rel) : null;
}

// "0.9.0" < "0.10.0" 처럼 숫자로 비교한다
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
