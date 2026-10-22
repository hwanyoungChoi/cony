import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const base = mkdtempSync(join(tmpdir(), "cony-stats-test-"));
after(() => rmSync(base, { recursive: true, force: true }));
process.env.CONY_TRANSCRIPTS_DIR = join(base, "transcripts");
const { computeStats } = await import("../plugins/cony/skills/board/stats.mjs");

const assistant = (id, model, usage, ts = "2026-10-22T01:00:00Z") =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, usage } });

test("대화 기록에서 역할별 토큰을 집계하고 같은 응답은 한 번만 센다", () => {
  const root = join(base, "proj");
  mkdirSync(join(root, ".cony"), { recursive: true });
  const dir = join(base, "transcripts", root.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
  writeFileSync(join(dir, "s1.jsonl"), [assistant("m1", "claude-opus", u), assistant("m1", "claude-opus", u), assistant("m2", "claude-opus", u)].join("\n"));
  writeFileSync(join(dir, "s1", "subagents", "agent-a.jsonl"), assistant("q1", "claude-sonnet", u));
  writeFileSync(join(dir, "s1", "subagents", "agent-a.meta.json"), JSON.stringify({ agentType: "cony:qa" }));
  writeFileSync(join(dir, "s1", "subagents", "agent-b.jsonl"), assistant("p1", "claude-opus", u));
  writeFileSync(join(dir, "s1", "subagents", "agent-b.meta.json"), JSON.stringify({ agentType: "cony:planner" }));

  const { cost } = computeStats(root);
  assert.equal(cost.found, true);
  assert.equal(cost.byRole["리드"].calls, 2);
  assert.equal(cost.byRole["리드"].output, 10);
  assert.equal(cost.byRole.qa.runs, 1);
  assert.equal(cost.byRole.pm.total, 135, "예전 이름 planner는 pm으로 센다");
  assert.equal(cost.total.total, 135 * 4);
  assert.equal(cost.byModel["claude-sonnet"], 135);
});

test("이벤트·ADR·검토·log.md에서 흐름, 토론, 사람 개입, hook 지표를 만든다", () => {
  const root = join(base, "proj2");
  const cony = join(root, ".cony");
  for (const d of ["metrics", "decisions", "reviews", "handoffs"]) mkdirSync(join(cony, d), { recursive: true });
  const ev = (o) => JSON.stringify(o);
  writeFileSync(
    join(cony, "metrics", "events.jsonl"),
    [
      ev({ ts: "2026-10-22T01:00:00Z", type: "task", task: 1, from: "todo", to: "progress" }),
      ev({ ts: "2026-10-22T01:20:00Z", type: "task", task: 1, from: "progress", to: "review" }),
      ev({ ts: "2026-10-22T01:25:00Z", type: "task", task: 1, from: "review", to: "progress" }),
      ev({ ts: "2026-10-22T01:40:00Z", type: "task", task: 1, from: "review", to: "done" }),
      ev({ ts: "2026-10-22T01:41:00Z", type: "gate_bypassed", reason: "x" }),
      ev({ ts: "2026-10-22T01:42:00Z", type: "hook", hook: "guard-bash", decision: "deny" }),
      ev({ ts: "2026-10-22T01:43:00Z", type: "hook", hook: "guard-bash", decision: "deny" }),
      "깨진 줄",
    ].join("\n"),
  );
  writeFileSync(join(cony, "decisions", "001.md"), "# ADR-001\n- 의견: fe(찬성) / be(반대, 근거)\n- 결정: A\n");
  writeFileSync(join(cony, "decisions", "002.md"), "# ADR-002\n- 상태: 뒤집힘(사용자)\n- 의견: fe(찬성)\n");
  writeFileSync(join(cony, "reviews", "20261022-1000-be-adr-001.md"), "판정: 반대\n");
  writeFileSync(join(cony, "reviews", "20261022-1000-fe-adr-001.md"), "**판정**: 조건부 찬성\n");
  writeFileSync(join(cony, "handoffs", "20261022-1000-be-api.md"), "# 요청서\n");
  writeFileSync(join(cony, "log.md"), "- `요청` a\n- 요청: b\n- `놓침` c\n- AI: d\n- 사용량: 무시\n");

  const s = computeStats(root);
  assert.equal(s.cost.found, false);
  assert.deepEqual(s.flow, { done: 1, rollbacks: 1, bypasses: 1, avgCycleMin: 40 });
  assert.deepEqual(s.hooks, { "guard-bash": { deny: 2 } });
  assert.equal(s.debate.adrs, 2);
  assert.equal(s.debate.adrsWithDissent, 1);
  assert.equal(s.debate.reversedByUser, 1);
  assert.deepEqual(s.debate.verdicts, { 찬성: 0, 조건부: 1, 반대: 1, 기타: 0 });
  assert.equal(s.debate.handoffs, 1);
  assert.deepEqual(s.people, { 요청: 2, 토론: 0, AI: 1, 되돌림: 0, 놓침: 1 });
});
