import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function sessionFile(sessionId) {
  return join(tmpdir(), "cony-hooks", `${String(sessionId).replace(/[^\w-]/g, "_")}.json`);
}

export function rememberRoot(sessionId, root) {
  if (!sessionId || !root) return;
  const roots = rememberedRoots(sessionId);
  if (roots.includes(root)) return;
  const file = sessionFile(sessionId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...roots, root]));
}

export function rememberedRoots(sessionId) {
  if (!sessionId) return [];
  try {
    return JSON.parse(readFileSync(sessionFile(sessionId), "utf8"));
  } catch {
    return [];
  }
}

export function forgetSession(sessionId) {
  if (sessionId) rmSync(sessionFile(sessionId), { force: true });
}

export function sessionRoots(input) {
  const roots = [findConyRoot(input.cwd ?? process.cwd()), ...rememberedRoots(input.session_id)];
  return [...new Set(roots.filter(Boolean))];
}

export function readBoardStatus(root) {
  const path = join(root, ".cony", "board.md");
  if (!existsSync(path)) return null;
  const board = readFileSync(path, "utf8");
  const status = (board.match(/^>\s*상태:\s*([^·\n]+)/m) || [])[1]?.trim() ?? "";
  return { path, board, status };
}
