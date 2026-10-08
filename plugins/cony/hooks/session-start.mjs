import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findConyRoot, output, readInput } from "./lib.mjs";

const input = readInput();
const root = findConyRoot(input.cwd ?? process.cwd());
if (!root) process.exit(0);

const boardPath = join(root, ".cony", "board.md");
const board = existsSync(boardPath)
  ? readFileSync(boardPath, "utf8").split("\n").slice(0, 80).join("\n")
  : "(보드 없음)";

output({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: [
      "이 프로젝트는 cony 하네스를 사용한다. 팀 작업 공간은 .cony/ 이고, 현재 보드는 아래와 같다.",
      "진행 중인 작업을 이어갈 때는 /cony:team 절차를, 진행 상황 질문에는 /cony:status 절차를 따른다.",
      "",
      board,
    ].join("\n"),
  },
});
