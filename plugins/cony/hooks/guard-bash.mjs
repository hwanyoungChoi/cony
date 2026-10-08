import { execFileSync } from "node:child_process";

import { findConyRoot, output, readInput, truncate } from "./lib.mjs";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

const input = readInput();
const command = input.tool_input?.command ?? "";
const cwd = input.cwd ?? process.cwd();
if (!command || !findConyRoot(cwd)) process.exit(0);

function decide(permissionDecision, reason) {
  output({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: `[cony] ${reason}`,
    },
  });
  process.exit(0);
}

function currentBranch() {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// 대상 브랜치를 알 수 없으면 null
function pushTargets(args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.some((t) => ["--all", "--mirror", "--delete", "-d"].includes(t))) return null;
  const refspecs = tokens.filter((t) => !t.startsWith("-")).slice(1);
  if (refspecs.length === 0) return [currentBranch()];
  return refspecs.map((refspec) => {
    const dst = refspec.includes(":") ? refspec.split(":")[1] : refspec;
    const name = dst.replace(/^refs\/heads\//, "");
    return name === "HEAD" ? currentBranch() : name;
  });
}

const DENY = [
  [/--no-verify\b/, "커밋 전 검사(husky)를 우회할 수 없습니다. 실패 원인을 고치세요."],
  [/\bgit\s+commit\b[^|;&]*--amend\b/, "기존 커밋을 고치지 말고 새 커밋을 만드세요."],
  [
    /\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b|\s\+\S)/,
    "force push는 허용되지 않습니다. 충돌은 rebase 대신 기본 브랜치를 merge해서 푸세요.",
  ],
];

const ASK = [
  [/\bgit\s+reset\s+--hard\b/, "커밋하지 않은 작업이 사라집니다."],
  [/\bgit\s+clean\s+-\w*f/, "추적하지 않는 파일이 삭제됩니다."],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, "작업 트리의 변경이 사라집니다."],
  [/\brm\s+-\w*(rf|fr)\w*\b/, "재귀 삭제입니다."],
  [/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, "데이터가 삭제됩니다."],
  [/\b(prisma\s+migrate\s+reset|supabase\s+db\s+reset|db:reset)\b/, "DB가 초기화됩니다."],
];

for (const [pattern, reason] of DENY) {
  if (pattern.test(command)) decide("deny", reason);
}

for (const match of command.matchAll(/\bgit\s+push\b([^;&|]*)/g)) {
  const targets = pushTargets(match[1]);
  if (!targets || targets.some((t) => !t || PROTECTED_BRANCHES.has(t))) {
    decide("ask", "기본 브랜치로 직접 push하거나 대상 브랜치를 알 수 없습니다. 작업 브랜치에서 PR로 머지하세요. 사용자 확인이 필요합니다.");
  }
}

// auto-merge 정책: CI가 모두 통과한 PR만 머지할 수 있다.
for (const match of command.matchAll(/\bgh\s+pr\s+merge\b([^;&|]*)/g)) {
  const selector = match[1].trim().split(/\s+/).find((t) => t && !t.startsWith("-"));
  try {
    execFileSync("gh", ["pr", "checks", ...(selector ? [selector] : [])], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (error) {
    const detail = truncate(`${error.stdout ?? ""}${error.stderr ?? ""}`.trim(), 1500);
    const reason =
      error.status === 8
        ? "CI가 아직 진행 중입니다. `gh pr checks --watch`로 끝날 때까지 기다린 뒤 머지하세요."
        : "CI가 모두 통과한 PR만 머지할 수 있습니다. 실패한 체크를 고치거나, CI가 없으면 사용자에게 알리세요.";
    decide("deny", `${reason}\n\n${detail}`);
  }
}

for (const [pattern, reason] of ASK) {
  if (pattern.test(command)) decide("ask", `${reason} 사용자 확인이 필요합니다.`);
}
