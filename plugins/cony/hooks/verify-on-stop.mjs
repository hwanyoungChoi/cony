import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import {
  binPath,
  detectPackageManager,
  findUp,
  output,
  logEvent,
  readInput,
  sessionRoots,
  truncate,
} from "./lib.mjs";

const MAX_ATTEMPTS = 3;
const CODE_FILE = /\.(m?[jt]sx?|cjs)$/;

const input = readInput();

function changedFiles(root) {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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

function checkPackages(root, files) {
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
  return failures;
}

// 한 프로젝트를 검사하고, 막아야 하면 실패 내용을 돌려준다.
function verifyRoot(root) {
  let files;
  try {
    files = changedFiles(root);
  } catch {
    return null;
  }
  if (files.length === 0) return null;

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
  if (state.passed === signature) return null;

  const failures = checkPackages(root, files);
  mkdirSync(cacheDir, { recursive: true });

  if (failures.length === 0) {
    writeFileSync(statePath, JSON.stringify({ passed: signature, attempts: {} }));
    return null;
  }

  // 연속 실패는 세션 기준으로 센다. 고치는 동안이나 다른 세션 때문에 파일이 바뀌어도 횟수가 초기화되지 않게 한다.
  const key = input.session_id ?? "unknown";
  const attempts = (state.attempts?.[key] ?? 0) + 1;
  writeFileSync(statePath, JSON.stringify({ passed: state.passed, attempts: { ...state.attempts, [key]: attempts } }));
  return { root, attempts, failures };
}

const results = sessionRoots(input).map(verifyRoot).filter(Boolean);
if (results.length === 0) process.exit(0);

const blocking = results.filter((r) => r.attempts <= MAX_ATTEMPTS);
for (const r of results) {
  logEvent(r.root, { type: "hook", hook: "verify-on-stop", decision: r.attempts <= MAX_ATTEMPTS ? "block" : "allow-after-max", attempts: r.attempts });
}
if (blocking.length === 0) {
  output({
    systemMessage: `[cony] lint/typecheck 실패가 ${MAX_ATTEMPTS}회 연속 해결되지 않아 종료를 허용했습니다. 보고서의 남은 이슈를 확인하세요.`,
  });
  process.exit(0);
}

const detail = blocking
  .map((r) => `# ${r.root} (${r.attempts}/${MAX_ATTEMPTS})\n\n${r.failures.join("\n\n")}`)
  .join("\n\n");
output({
  decision: "block",
  reason: `[cony] 종료 전 검증에 실패했습니다. 고친 뒤 마무리하세요. 고칠 수 없는 이유가 있으면 보고서의 남은 이슈에 적으세요.\n\n${truncate(detail)}`,
});
