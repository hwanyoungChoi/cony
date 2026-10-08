import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

import { binPath, findConyRoot, findUp, output, readInput, truncate } from "./lib.mjs";

const input = readInput();
const filePath = input.tool_input?.file_path;
if (!filePath || !/\.(m?[jt]sx?|cjs)$/.test(filePath)) process.exit(0);

const root = findConyRoot(dirname(filePath));
if (!root) process.exit(0);

const pkgDir = findUp(dirname(filePath), "package.json", root);
const eslint = pkgDir && binPath(pkgDir, "eslint");
if (!eslint) process.exit(0);

try {
  execFileSync(eslint, ["--no-warn-ignored", filePath], {
    cwd: pkgDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    shell: process.platform === "win32",
  });
} catch (error) {
  // 1 = lint 오류. 그 외(설정 오류, 타임아웃)는 작업을 막지 않는다.
  if (error.status !== 1) process.exit(0);
  output({
    decision: "block",
    reason: `[cony] 방금 수정한 파일에 ESLint 오류가 있습니다. 다음 작업으로 넘어가기 전에 고치세요.\n\n${truncate(error.stdout ?? "")}`,
  });
}
