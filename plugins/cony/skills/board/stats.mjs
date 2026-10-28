// cony 지표: 비용·과정별 시간(대화 기록), 흐름(이벤트), 토론(ADR·검토 원문), 사람 개입(log.md), hook 차단(이벤트)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROLE_ALIASES = { planner: "pm", "client-dev": "fe", "backend-dev": "be", tester: "qa" };
const LOG_TAGS = ["요청", "토론", "AI", "되돌림", "놓침"];

function transcriptsDir(root) {
  const base = process.env.CONY_TRANSCRIPTS_DIR ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  return join(base, root.replace(/[^A-Za-z0-9]/g, "-"));
}

function roleOf(agentType) {
  const m = /^cony:(.+)$/.exec(agentType ?? "");
  if (!m) return "기타";
  return ROLE_ALIASES[m[1]] ?? m[1];
}

const fileCache = new Map();

// 한 대화 기록 파일의 토큰 합계. 같은 응답이 여러 줄로 나뉘어 기록되므로 message.id 로 한 번만 센다.
function usageOf(path) {
  const { mtimeMs, size } = statSync(path);
  const key = `${path}:${mtimeMs}:${size}`;
  const cached = fileCache.get(path);
  if (cached?.key === key) return cached.value;
  const seen = new Set();
  const value = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {}, first: null, last: null };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "assistant" || !d.message?.usage) continue;
    const id = d.message.id ?? d.requestId ?? d.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    const u = d.message.usage;
    const add = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
    value.calls += 1;
    for (const k of Object.keys(add)) value[k] += add[k];
    const model = d.message.model ?? "unknown";
    value.byModel[model] = (value.byModel[model] ?? 0) + add.input + add.output + add.cacheRead + add.cacheWrite;
    if (d.timestamp) {
      value.first = value.first && value.first < d.timestamp ? value.first : d.timestamp;
      value.last = value.last && value.last > d.timestamp ? value.last : d.timestamp;
    }
  }
  fileCache.set(path, { key, value });
  return value;
}

function emptyBucket() {
  return { runs: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTo(bucket, u) {
  bucket.runs += 1;
  bucket.calls += u.calls;
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) bucket[k] += u[k];
  bucket.total = bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
}

function costStats(root) {
  const dir = transcriptsDir(root);
  const byRole = {};
  const byModel = {};
  let since = null;
  if (!existsSync(dir)) return { byRole, byModel, total: emptyBucket(), since, found: false };
  const merge = (role, u) => {
    byRole[role] ??= emptyBucket();
    addTo(byRole[role], u);
    for (const [model, n] of Object.entries(u.byModel)) byModel[model] = (byModel[model] ?? 0) + n;
    if (u.first && (!since || u.first < since)) since = u.first;
  };
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".jsonl")) merge("리드", usageOf(join(dir, name)));
    const subDir = join(dir, name, "subagents");
    if (!existsSync(subDir)) continue;
    for (const sub of readdirSync(subDir)) {
      if (!sub.endsWith(".jsonl")) continue;
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(subDir, sub.replace(/\.jsonl$/, ".meta.json")), "utf8"));
      } catch {
        // meta 없음
      }
      merge(roleOf(meta.agentType), usageOf(join(subDir, sub)));
    }
  }
  const total = emptyBucket();
  for (const b of Object.values(byRole)) {
    total.runs += b.runs;
    total.calls += b.calls;
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"]) total[k] += b[k];
  }
  return { byRole, byModel, total, since, found: true };
}

// ── 과정별 시간 (추정) ──
// 에이전트 한 번의 실행 시간 = 대화 기록의 첫 시각 ~ 마지막 시각.
// 검토인지 구현인지는 리드가 붙인 호출 설명으로 가른다. "[검토]" 같은 머리표가 있으면 그걸 따르고, 없으면 낱말로 짐작한다.
const PHASE_TAGS = { 검토: "검토", 따라잡기: "검토", 구현: "구현", 테스트: "테스트", 스펙: "스펙" };
const REVIEW_WORDS = /review|rebuttal|catch-?up|검토|리뷰|따라잡|제안/i;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|tests?|e2e)\//;
const TEST_COMMAND = /\b(vitest|jest|playwright|mocha|(npm|pnpm|yarn|bun)( run)? test)\b/;
// 리드 대화에서 이보다 긴 틈은 사용자를 기다린 시간으로 보고 뺀다.
const LEAD_IDLE_MS = 2 * 60_000;
// 에이전트 대화 안에서 이보다 긴 틈은 잘라서 센다(멈췄다 재개된 경우).
const AGENT_GAP_CAP_MS = 10 * 60_000;

function phaseOf(role, description = "") {
  const tag = /^\s*\[([^\]]+)\]/.exec(description)?.[1];
  if (tag && PHASE_TAGS[tag]) return PHASE_TAGS[tag];
  if (role === "pm") return "스펙";
  if (REVIEW_WORDS.test(description)) return "검토";
  if (role === "qa") return "테스트";
  if (role === "fe" || role === "be") return "구현";
  return null;
}

const activityCache = new Map();

// 대화 기록의 시각 목록과, 틈마다 테스트를 하던 중이었는지(마지막 도구 호출 기준)를 읽는다.
function activityOf(path) {
  const { mtimeMs, size } = statSync(path);
  const key = `${path}:${mtimeMs}:${size}`;
  const cached = activityCache.get(path);
  if (cached?.key === key) return cached.value;
  const points = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"timestamp"')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if ((d.type !== "user" && d.type !== "assistant") || !d.timestamp) continue;
    let testing = null;
    if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      for (const c of d.message.content) {
        if (c.type !== "tool_use") continue;
        const file = c.input?.file_path ?? c.input?.notebook_path;
        if (file) testing = TEST_FILE.test(file);
        else if (c.name === "Bash") testing = TEST_COMMAND.test(c.input?.command ?? "");
      }
    }
    points.push({ t: Date.parse(d.timestamp), testing });
  }
  points.sort((a, b) => a.t - b.t);
  const value = points;
  activityCache.set(path, { key, value });
  return value;
}

function agentTime(points) {
  let total = 0;
  let test = 0;
  let testing = false;
  for (let i = 0; i < points.length - 1; i += 1) {
    if (points[i].testing !== null) testing = points[i].testing;
    const gap = Math.min(points[i + 1].t - points[i].t, AGENT_GAP_CAP_MS);
    total += gap;
    if (testing) test += gap;
  }
  return { total, test, start: points[0]?.t ?? 0, end: points.at(-1)?.t ?? 0 };
}

// 겹치는 구간을 합친다
function mergeIntervals(list) {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b);
    else out.push([a, b]);
  }
  return out;
}

function overlap([a, b], merged) {
  let n = 0;
  for (const [x, y] of merged) n += Math.max(0, Math.min(b, y) - Math.max(a, x));
  return n;
}

function timeStats(root) {
  const dir = transcriptsDir(root);
  const phases = Object.fromEntries(["스펙", "검토", "구현", "구현 중 테스트", "테스트", "조율"].map((k) => [k, { runs: 0, ms: 0 }]));
  if (!existsSync(dir)) return { phases, found: false };
  const agentSpans = [];
  const leadFiles = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".jsonl")) leadFiles.push(join(dir, name));
    const subDir = join(dir, name, "subagents");
    if (!existsSync(subDir)) continue;
    for (const sub of readdirSync(subDir)) {
      if (!sub.endsWith(".jsonl")) continue;
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(subDir, sub.replace(/\.jsonl$/, ".meta.json")), "utf8"));
      } catch {
        // meta 없음
      }
      const t = agentTime(activityOf(join(subDir, sub)));
      agentSpans.push([t.start, t.end]);
      const phase = phaseOf(roleOf(meta.agentType), meta.description);
      if (!phase) continue;
      phases[phase].runs += 1;
      // fe·be가 구현하면서 테스트 파일을 고치거나 테스트를 돌린 시간은 따로 뺀다
      if (phase === "구현") {
        phases[phase].ms += t.total - t.test;
        phases["구현 중 테스트"].ms += t.test;
      } else {
        phases[phase].ms += t.total;
      }
    }
  }
  // 리드: 짧은 틈만 일한 시간으로 보고, 에이전트가 돌던 구간은 뺀다
  const busy = mergeIntervals(agentSpans);
  for (const file of leadFiles) {
    const points = activityOf(file);
    for (let i = 0; i < points.length - 1; i += 1) {
      const span = [points[i].t, points[i + 1].t];
      if (span[1] - span[0] > LEAD_IDLE_MS) continue;
      phases.조율.ms += span[1] - span[0] - overlap(span, busy);
    }
  }
  return { phases, found: true };
}

function readEvents(conyDir) {
  const path = join(conyDir, "metrics", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function flowStats(events) {
  const started = new Map();
  const cycles = [];
  let done = 0;
  let rollbacks = 0;
  for (const e of events.filter((ev) => ev.type === "task")) {
    if (e.to === "progress" && !started.has(e.task)) started.set(e.task, e.ts);
    if (e.from === "review" && e.to === "progress") rollbacks += 1;
    if (e.to === "done") {
      done += 1;
      if (started.has(e.task)) cycles.push((Date.parse(e.ts) - Date.parse(started.get(e.task))) / 60000);
      started.delete(e.task);
    }
  }
  const bypasses = events.filter((e) => e.type === "gate_bypassed").length;
  const avgCycleMin = cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null;
  return { done, rollbacks, bypasses, avgCycleMin };
}

function hookStats(events) {
  const byHook = {};
  for (const e of events.filter((ev) => ev.type === "hook")) {
    byHook[e.hook] ??= {};
    byHook[e.hook][e.decision] = (byHook[e.hook][e.decision] ?? 0) + 1;
  }
  return byHook;
}

function verdictOf(text) {
  const raw = (text.match(/판정[^:\n]*[:：]\s*\**([^\n*]+)/) || [])[1] ?? "";
  if (/반대/.test(raw)) return "반대";
  if (/조건/.test(raw)) return "조건부";
  if (/찬성|통과/.test(raw)) return "찬성";
  return "기타";
}

function debateStats(conyDir) {
  const list = (folder, skip = /^$/) => {
    const dir = join(conyDir, folder);
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => n.endsWith(".md") && !skip.test(n))
          .map((n) => readFileSync(join(dir, n), "utf8"))
      : [];
  };
  const adrs = list("decisions");
  // fe·be 구현 기록(-fe-task-N)은 판정이 없는 작업 기록이라 검토 판정에서 뺀다
  const reviews = list("reviews", /-(fe|be)-task-/);
  const verdicts = { 찬성: 0, 조건부: 0, 반대: 0, 기타: 0 };
  for (const r of reviews) verdicts[verdictOf(r)] += 1;
  const dissent = adrs.filter((a) => /의견[^\n]*(반대|조건)/.test(a)).length;
  const reversed = adrs.filter((a) => /상태:\s*뒤집힘/.test(a)).length;
  const pendingUser = adrs.filter((a) => /상태:\s*제안됨/.test(a)).length;
  const decidedByUser = adrs.filter((a) => /상태:\s*채택\(사용자\)/.test(a)).length;
  return {
    adrs: adrs.length,
    reviews: reviews.length,
    verdicts,
    adrsWithDissent: dissent,
    reversedByUser: reversed,
    pendingUser,
    decidedByUser,
    handoffs: list("handoffs").length,
  };
}

function peopleStats(conyDir) {
  const path = join(conyDir, "log.md");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  // "- `요청` ..." 과 "- 요청: ..." 두 표기를 모두 센다
  return Object.fromEntries(
    LOG_TAGS.map((tag) => [tag, (text.match(new RegExp(`^\\s*-\\s*(?:\`${tag}\`|${tag}\\s*[:：])`, "gm")) ?? []).length]),
  );
}

export function computeStats(root) {
  const conyDir = join(root, ".cony");
  const events = readEvents(conyDir);
  return {
    cost: costStats(root),
    time: timeStats(root),
    flow: flowStats(events),
    hooks: hookStats(events),
    debate: debateStats(conyDir),
    people: peopleStats(conyDir),
    generatedAt: new Date().toISOString(),
  };
}

// node stats.mjs [프로젝트 경로] — 터미널에서 바로 보기
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(computeStats(process.argv[2] ?? process.cwd()), null, 2));
}
