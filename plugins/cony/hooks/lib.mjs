import { existsSync, readFileSync } from "node:fs";
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
