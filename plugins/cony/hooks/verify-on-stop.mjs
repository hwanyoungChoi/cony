import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import {
  binPath,
  detectPackageManager,
  findConyRoot,
  findUp,
  output,
  readInput,
  truncate,
} from "./lib.mjs";

const MAX_ATTEMPTS = 3;
const CODE_FILE = /\.(m?[jt]sx?|cjs)$/;

const input = readInput();
const root = findConyRoot(input.cwd ?? process.cwd());
if (!root) process.exit(0);

const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function changedFiles() {
  let tracked;
  try {
    tracked = git(["diff", "HEAD", "--name-only", "--diff-filter=ACMR"]);
  } catch {
    // 커밋이 하나도 없는 저장소
    tracked = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  const names = new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean));
  return [...names]
    .filter((name) => CODE_FILE.test(name))
    .map((name) => join(root, name))
    .filter((file) => existsSync(file));
}

let files;
try {
  files = changedFiles();
} catch {
  process.exit(0);
}
if (files.length === 0) process.exit(0);

const hash = createHash("sha1");
for (const file of files) hash.update(file).update(readFileSync(file));
const signature = hash.digest("hex");

const cacheDir = join(root, ".cony", ".cache");
const statePath = join(cacheDir, "verify.json");
let state = { passed: null, attempts: {} };
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  // 첫 실행
}
if (state.passed === signature) process.exit(0);

function run(cmd, args, cwd) {
  try {
    execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
      shell: process.platform === "win32",
    });
    return null;
  } catch (error) {
    if (error.status == null) return null; // 실행 불가·타임아웃은 막지 않는다
    return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  }
}

const byPackage = new Map();
for (const file of files) {
  const pkgDir = findUp(dirname(file), "package.json", root);
  if (!pkgDir) continue;
  if (!byPackage.has(pkgDir)) byPackage.set(pkgDir, []);
  byPackage.get(pkgDir).push(file);
}

const failures = [];
for (const [pkgDir, pkgFiles] of byPackage) {
  const label = relative(root, pkgDir) || ".";

  const eslint = binPath(pkgDir, "eslint");
  if (eslint) {
    const result = run(eslint, ["--no-warn-ignored", ...pkgFiles], pkgDir);
    if (result) failures.push(`## ESLint (${label})\n${result}`);
  }

  if (!existsSync(join(pkgDir, "tsconfig.json"))) continue;
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  let result = null;
  if (pkg.scripts?.typecheck) {
    result = run(detectPackageManager(pkgDir, root), ["run", "typecheck"], pkgDir);
  } else {
    const tsc = binPath(pkgDir, "tsc");
    if (tsc) {
      const usesReferences = /"references"\s*:/.test(readFileSync(join(pkgDir, "tsconfig.json"), "utf8"));
      result = run(tsc, usesReferences ? ["-b"] : ["--noEmit"], pkgDir);
    }
  }
  if (result) failures.push(`## TypeScript (${label})\n${result}`);
}

mkdirSync(cacheDir, { recursive: true });

if (failures.length === 0) {
  writeFileSync(statePath, JSON.stringify({ passed: signature, attempts: {} }));
  process.exit(0);
}

const attempts = (state.attempts?.[signature] ?? 0) + 1;
writeFileSync(statePath, JSON.stringify({ passed: state.passed, attempts: { [signature]: attempts } }));

if (attempts > MAX_ATTEMPTS) {
  output({
    systemMessage: `[cony] lint/typecheck 실패가 ${MAX_ATTEMPTS}회 연속 해결되지 않아 종료를 허용했습니다. 보고서의 남은 이슈를 확인하세요.`,
  });
  process.exit(0);
}

output({
  decision: "block",
  reason: `[cony] 종료 전 검증에 실패했습니다 (${attempts}/${MAX_ATTEMPTS}). 고친 뒤 마무리하세요. 고칠 수 없는 이유가 있으면 보고서의 남은 이슈에 적으세요.\n\n${truncate(failures.join("\n\n"))}`,
});
