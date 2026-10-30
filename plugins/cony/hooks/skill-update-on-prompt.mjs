import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareVersions, leadRoots, logEvent, output, readInput, rememberedRoots, rememberValue } from "./lib.mjs";

// 스킬 지침은 세션이 처음 불러온 버전 그대로 대화에 남는다. 에이전트 지침과 board.mjs·ship.mjs는 최신이 적용되지만
// 리드 규칙은 아니다(모기지핏 리드는 0.18.1 지침으로 0.21까지 일해서 0.20·0.21의 리드 규칙이 한 번도 적용되지 않았다).
// 오래 켜 둔 리드 세션에 사용자가 말을 걸 때, 설치된 버전이 더 새로우면 지침을 다시 읽으라고 덧붙인다.
const SKILL_LOADED = /Base directory for this skill: [^"\\\n]*?[\\/]cony[\\/](\d+(?:\.\d+)*)[\\/]skills[\\/]team/g;

const input = readInput();
const roots = leadRoots(input.session_id);
if (roots.length === 0) process.exit(0);

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const current = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
const known = rememberedRoots(input.session_id, "skill-version")[0] ?? loadedVersion(input.transcript_path);
rememberValue(input.session_id, "skill-version", current);
if (!known || compareVersions(known, current) >= 0) process.exit(0);

for (const root of roots) logEvent(root, { type: "hook", hook: "skill-update-on-prompt", decision: "notice", from: known, to: current });
output({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `[cony] 이 세션은 팀 스킬을 ${known} 지침으로 불러왔고, 설치된 cony는 ${current}다. 그 사이 리드 규칙이 바뀌었을 수 있다. 이 요청을 처리하기 전에 ${join(pluginRoot, "skills", "team", "SKILL.md")} 를 Read로 다시 읽고 바뀐 지침을 따른다. 에이전트 지침과 board.mjs·ship.mjs에는 이미 최신이 적용돼 있다.`,
  },
});

// 대화 기록에서 팀 스킬을 마지막으로 불러온 버전. 세션마다 한 번만 읽는다.
function loadedVersion(path) {
  if (!path) return null;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return [...text.matchAll(SKILL_LOADED)].at(-1)?.[1] ?? null;
}
