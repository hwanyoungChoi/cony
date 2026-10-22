// cony 지표: 비용(대화 기록), 흐름(이벤트), 토론(ADR·검토 원문), 사람 개입(log.md), hook 차단(이벤트)
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
  const list = (folder) => {
    const dir = join(conyDir, folder);
    return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")).map((n) => readFileSync(join(dir, n), "utf8")) : [];
  };
  const adrs = list("decisions");
  const reviews = list("reviews");
  const verdicts = { 찬성: 0, 조건부: 0, 반대: 0, 기타: 0 };
  for (const r of reviews) verdicts[verdictOf(r)] += 1;
  const dissent = adrs.filter((a) => /의견[^\n]*(반대|조건)/.test(a)).length;
  const reversed = adrs.filter((a) => /상태:\s*뒤집힘/.test(a)).length;
  return { adrs: adrs.length, reviews: reviews.length, verdicts, adrsWithDissent: dissent, reversedByUser: reversed, handoffs: list("handoffs").length };
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
