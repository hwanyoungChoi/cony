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
  writeFileSync(join(cony, "decisions", "003.md"), "# ADR-003\n- 상태: 채택(사용자)\n");
  writeFileSync(join(cony, "decisions", "004.md"), "# ADR-004\n- 상태: 제안됨 · 사용자 결정 대기\n");
  writeFileSync(join(cony, "reviews", "20261022-1000-be-adr-001.md"), "판정: 반대\n");
  writeFileSync(join(cony, "reviews", "20261022-1000-fe-adr-001.md"), "**판정**: 조건부 찬성\n");
  writeFileSync(join(cony, "handoffs", "20261022-1000-be-api.md"), "# 요청서\n");
  writeFileSync(join(cony, "log.md"), "- `요청` a\n- 요청: b\n- `놓침` c\n- AI: d\n- 사용량: 무시\n");

  const s = computeStats(root);
  assert.equal(s.cost.found, false);
  assert.deepEqual(s.flow, { done: 1, rollbacks: 1, bypasses: 1, avgCycleMin: 40 });
  assert.deepEqual(s.hooks, { "guard-bash": { deny: 2 } });
  assert.equal(s.debate.adrs, 4);
  assert.equal(s.debate.decidedByUser, 1);
  assert.equal(s.debate.pendingUser, 1);
  assert.equal(s.debate.adrsWithDissent, 1);
  assert.equal(s.debate.reversedByUser, 1);
  assert.deepEqual(s.debate.verdicts, { 찬성: 0, 조건부: 1, 반대: 1, 기타: 0 });
  assert.equal(s.debate.handoffs, 1);
  assert.deepEqual(s.people, { 요청: 2, 토론: 0, AI: 1, 되돌림: 0, 놓침: 1, undated: 0 });
});

test("과정별 시간: 머리표·역할로 과정을 가르고, 구현 중 테스트와 리드 조율 시간을 추정한다", () => {
  const root = join(base, "proj-time");
  mkdirSync(join(root, ".cony"), { recursive: true });
  const dir = join(base, "transcripts", root.replace(/[^A-Za-z0-9]/g, "-"));
  const sub = join(dir, "s1", "subagents");
  mkdirSync(sub, { recursive: true });
  const at = (hms) => `2026-10-22T${hms}Z`;
  const user = (hms) => JSON.stringify({ type: "user", timestamp: at(hms), message: { content: [] } });
  const tool = (hms, name, input) =>
    JSON.stringify({ type: "assistant", timestamp: at(hms), message: { id: hms + name, content: [{ type: "tool_use", name, input }] } });
  const agent = (name, meta, lines) => {
    writeFileSync(join(sub, `${name}.jsonl`), lines.join("\n"));
    writeFileSync(join(sub, `${name}.meta.json`), JSON.stringify(meta));
  };

  // 리드: 1분 일함, 29분 사용자 대기(뺌), 1분 중 30초는 fe가 돌던 구간(뺌)
  writeFileSync(join(dir, "s1.jsonl"), [user("01:00:00"), user("01:01:00"), user("01:30:00"), user("01:31:00")].join("\n"));
  // fe 구현 9.5분: 코드 4분, 테스트 파일 2분, 테스트 실행 3.5분
  agent("agent-fe", { agentType: "cony:fe", description: "[구현] fe task 1" }, [
    tool("01:30:30", "Edit", { file_path: "/p/src/a.ts" }),
    user("01:34:30"),
    tool("01:34:30", "Edit", { file_path: "/p/src/a.test.ts" }),
    user("01:36:30"),
    tool("01:36:30", "Bash", { command: "pnpm test" }),
    user("01:40:00"),
  ]);
  agent("agent-qa", { agentType: "cony:qa", description: "qa reviews spec" }, [user("02:00:00"), user("02:03:00")]);
  agent("agent-pm", { agentType: "cony:pm", description: "pm applies review fixes" }, [user("03:00:00"), user("03:02:00")]);

  const { phases } = computeStats(root).time;
  const min = (ms) => ms / 60000;
  assert.equal(min(phases.구현.ms), 4);
  assert.equal(min(phases["구현 중 테스트"].ms), 5.5);
  assert.equal(phases.구현.runs, 1);
  assert.equal(min(phases.검토.ms), 3, "머리표가 없으면 설명 낱말(review)로 검토를 가른다");
  assert.equal(min(phases.스펙.ms), 2, "pm은 설명에 review가 있어도 스펙이다");
  assert.equal(min(phases.조율.ms), 1.5);
  assert.equal(phases.테스트.ms, 0);
});

test("since: 그 시각 뒤의 토큰·시간·이벤트·검토·결정만 세고, 날짜 없는 log.md는 뺀다", () => {
  const root = join(base, "proj-since");
  for (const d of ["metrics", "reviews", "decisions"]) mkdirSync(join(root, ".cony", d), { recursive: true });
  const dir = join(base, "transcripts", root.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const user = (ts) => JSON.stringify({ type: "user", timestamp: ts, message: { content: [] } });
  writeFileSync(
    join(dir, "s1.jsonl"),
    [
      assistant("old", "m", u, "2026-10-27T01:00:00.000Z"),
      assistant("new", "m", u, "2026-10-29T01:00:00.000Z"),
      user("2026-10-29T01:01:00.000Z"),
    ].join("\n"),
  );
  // 전부 since 전에 돈 qa 실행은 빠지고, 뒤에 돈 fe 실행만 남는다
  writeFileSync(join(dir, "s1", "subagents", "agent-qa.jsonl"), [assistant("q", "m", u, "2026-10-27T02:00:00.000Z"), user("2026-10-27T02:05:00.000Z")].join("\n"));
  writeFileSync(join(dir, "s1", "subagents", "agent-qa.meta.json"), JSON.stringify({ agentType: "cony:qa" }));
  writeFileSync(join(dir, "s1", "subagents", "agent-fe.jsonl"), [assistant("f", "m", u, "2026-10-29T02:00:00.000Z"), user("2026-10-29T02:04:00.000Z")].join("\n"));
  writeFileSync(join(dir, "s1", "subagents", "agent-fe.meta.json"), JSON.stringify({ agentType: "cony:fe", description: "[구현] task 1" }));
  writeFileSync(
    join(root, ".cony", "metrics", "events.jsonl"),
    [
      { ts: "2026-10-27T03:00:00.000Z", type: "hook", hook: "lint-on-edit", decision: "block" },
      { ts: "2026-10-29T03:00:00.000Z", type: "hook", hook: "guard-secrets", decision: "deny" },
      { ts: "2026-10-29T03:00:00.000Z", type: "decision", file: "decisions/002-new.md" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  writeFileSync(join(root, ".cony", "decisions", "001-old.md"), "# ADR-001\n- 상태: 채택\n");
  writeFileSync(join(root, ".cony", "decisions", "002-new.md"), "# ADR-002\n- 상태: 채택\n- 의견: qa(반대, 근거)\n");
  writeFileSync(join(root, ".cony", "reviews", "20261020-1000-qa-spec-x.md"), "판정: 반대\n");
  writeFileSync(join(root, ".cony", "reviews", "20261030-1000-qa-spec-x.md"), "판정: 찬성\n");
  writeFileSync(join(root, ".cony", "log.md"), "- 요청: a\n- 2026-10-27 되돌림: 옛것\n- 2026-10-29 되돌림: 새것\n- 2026-10-29 놓침: 새것\n");

  const s = computeStats(root, { since: "2026-10-28T00:00:00.000Z" });
  assert.equal(s.cost.byRole["리드"].calls, 1);
  assert.equal(s.cost.byRole.qa, undefined);
  assert.equal(s.cost.byRole.fe.runs, 1);
  assert.equal(s.cost.since, "2026-10-29T01:00:00.000Z");
  assert.equal(s.time.phases.테스트.runs, 0);
  assert.equal(s.time.phases.구현.ms, 4 * 60_000);
  assert.deepEqual(s.hooks, { "guard-secrets": { deny: 1 } });
  assert.equal(s.debate.adrs, 1, "board.mjs --decision 기록이 since 뒤인 ADR만");
  assert.equal(s.debate.adrsWithDissent, 1);
  assert.deepEqual(s.debate.verdicts, { 찬성: 1, 조건부: 0, 반대: 0, 기타: 0 });
  assert.deepEqual(s.people, { 요청: 0, 토론: 0, AI: 0, 되돌림: 1, 놓침: 1, undated: 1 }, "날짜 있는 항목만, since 뒤만");

  const all = computeStats(root);
  assert.equal(all.cost.byRole["리드"].calls, 2);
  assert.equal(all.debate.adrs, 2);
  assert.equal(all.people.요청, 1);
  assert.equal(all.people.되돌림, 2);
});
