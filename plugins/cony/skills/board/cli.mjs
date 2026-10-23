#!/usr/bin/env node
// 터미널에서 보는 cony 보드와 지표.
//   cony board [--all]   칸반, 확인 필요·막힌 것, 최근 결정 (--all 이면 백로그 목록까지)
//   cony stats           지표
//   cony watch [stats]   파일이 바뀌면 다시 그린다 (stats 는 30초마다도)
import { existsSync, readFileSync, watch } from "node:fs";
import { basename, join } from "node:path";

import { findConyRoot, readTeamConfig } from "../../hooks/lib.mjs";
import { computeStats } from "./stats.mjs";

// ── 출력 도구 ──────────────────────────────────────────────
const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR);
const esc = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = esc("1");
const dim = esc("2");
const rgb = (hex) => hex.match(/\w\w/g).map((h) => parseInt(h, 16));
const fg = (hex) => (s) => (useColor ? `\x1b[38;2;${rgb(hex).join(";")}m${s}\x1b[0m` : s);
const badge = (hex, label) => (useColor ? `\x1b[48;2;${rgb(hex).join(";")}m\x1b[97;1m ${label} \x1b[0m` : `[${label}]`);

const ROLE_COLOR = { pm: "7C3AED", fe: "3B5BDB", be: "2F9E44", qa: "F08C00" };
const COLUMN = {
  todo: { label: "TODO", color: "9A9AA6" },
  progress: { label: "PROGRESS", color: "4C6EF5" },
  review: { label: "REVIEW", color: "F08C00" },
  done: { label: "DONE", color: "2F9E44" },
};

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
function width(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += WIDE.test(ch) ? 2 : 1;
  return w;
}
function truncate(s, max) {
  if (width(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (width(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}
const pad = (s, w) => s + " ".repeat(Math.max(0, w - width(s)));
const termWidth = () => Math.max(40, Math.min(process.stdout.columns || Number(process.env.COLUMNS) || 100, 140));
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function box(lines, w) {
  const inner = w - 4;
  const top = dim(`╭${"─".repeat(w - 2)}╮`);
  const bottom = dim(`╰${"─".repeat(w - 2)}╯`);
  return [top, ...lines.map((l) => `${dim("│")} ${pad(truncate(l, inner), inner)} ${dim("│")}`), bottom].join("\n");
}

function relative(date) {
  if (!date) return "";
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}시간 전`;
  return `${Math.round(minutes / 1440)}일 전`;
}

// ── 보드 읽기 ──────────────────────────────────────────────
function readBoard(root) {
  const path = join(root, ".cony", "board.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const [head, ...chunks] = text.split(/^## /m);
  const sections = {};
  for (const chunk of chunks) {
    const nl = chunk.indexOf("\n");
    sections[chunk.slice(0, nl).trim()] = chunk.slice(nl + 1).replace(/<!--[\s\S]*?-->/g, "").trim();
  }
  const statusLine = (head.match(/^>\s*(.+)$/m) || [])[1] ?? "";
  const ts = statusLine.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  const tasks = (sections["태스크"] ?? "").split("\n").flatMap((line) => {
    const m = line.match(/^- \[([ xX])\] (\d+)\. (.*?)(?: \[(PROGRESS|REVIEW)(?: · ([^\]]+))?\]| ← [^(]*(?:\((.+)\))?)?\s*$/);
    if (!m) return [];
    const [, checked, number, rawTitle, tag, tagOwner, legacyOwner] = m;
    const col = checked.trim() ? "done" : tag ? tag.toLowerCase() : / ← /.test(line) ? "progress" : "todo";
    // 수용 기준은 "(AC-1, 2)" 나 "— AC-1~AC-5" 로 적힌다
    const acMatch = rawTitle.match(/\s*\((AC-[^)]+)\)/) || rawTitle.match(/\s+[—–-]\s+(AC-.+)$/);
    const ac = acMatch?.[1] ?? "";
    const title = (acMatch ? rawTitle.replace(acMatch[0], "") : rawTitle).replace(/\*\*/g, "").trim();
    return [{ col, number, title, ac, owner: tagOwner || legacyOwner || "" }];
  });
  const list = (name) => {
    const body = sections[name] ?? "";
    if (!body || /^(없음|아직 없음)$/.test(body)) return [];
    return body.split("\n").filter((l) => /^\s*- /.test(l)).map((l) => l.replace(/^\s*- /, ""));
  };
  return {
    goal: (head.match(/^#\s+(.+)$/m) || [])[1] ?? "(목표 없음)",
    status: ((statusLine.match(/상태:\s*([^·]+)/) || [])[1] ?? "").trim(),
    updated: ts ? new Date(+ts[1], +ts[2] - 1, +ts[3], +ts[4], +ts[5]) : null,
    tasks,
    backlog: list("백로그"),
    now: sections["지금 하는 일"] ?? "",
    decisions: list("최근 결정"),
    attention: list("사용자 확인 필요"),
    blocked: list("막힌 것"),
    pr: sections.PR ?? "",
  };
}

const plain = (md) => md.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "");

// ── 보드 그리기 ────────────────────────────────────────────
function statusBadge(status) {
  if (status.includes("완료")) return fg("2F9E44")("● 완료");
  if (status.includes("중단")) return fg("E03131")("● 중단됨");
  if (status.includes("대기")) return fg("F08C00")("● 사용자 대기");
  return fg("4C6EF5")(`● ${status || "진행 중"}`);
}

function header(board, team, root, w) {
  const done = board.tasks.filter((t) => t.col === "done").length;
  const total = board.tasks.length;
  const barW = Math.max(10, Math.min(30, w - 40));
  const filled = total ? Math.round((done / total) * barW) : 0;
  const bar = fg(done === total && total ? "2F9E44" : "4C6EF5")("█".repeat(filled)) + dim("░".repeat(barW - filled));
  const goalW = w - 4 - width(stripAnsi(statusBadge(board.status))) - 2;
  const members = ["pm", "fe", "be", "qa"]
    .map((r) => {
      const mode = team[r];
      const label = { build: "구현", review: "검토", off: "제외" }[mode] ?? mode;
      return mode === "off" ? dim(`${r.toUpperCase()} 제외`) : `${badge(ROLE_COLOR[r], r.toUpperCase())} ${label}`;
    })
    .join("  ");
  const policy = dim(`결정: ${team.decisions === "user" ? "사용자" : "팀"} · 머지: ${{ auto: "자동", pr: "PR까지", none: "커밋까지" }[team.merge] ?? team.merge}`);
  return box(
    [
      `${pad(bold(truncate(board.goal, goalW)), goalW)}  ${statusBadge(board.status)}`,
      `${bar} ${bold(`${done}/${total}`)}  ${dim(`${basename(root)} · ${relative(board.updated)} 갱신`)}`,
      `${members}  ${policy}`,
    ],
    w,
  );
}

// 칸 폭에 맞춰 최대 maxLines 줄로 나누고, 넘치면 마지막 줄을 … 로 줄인다.
function wrap(text, w, maxLines) {
  const lines = [""];
  for (const ch of text) {
    const last = lines.length - 1;
    if (width(lines[last] + ch) <= w) {
      lines[last] += ch;
    } else if (lines.length === maxLines) {
      lines[last] = truncate(`${lines[last]}${ch}…`, w);
      break;
    } else {
      lines.push(ch === " " ? "" : ch);
    }
  }
  return lines;
}

function card(t, colW) {
  const key = `#${t.number} `;
  const [first, ...more] = wrap(t.title, colW - width(key), 2);
  const head = [`${dim(key)}${first ?? ""}`, ...more.map((l) => `${" ".repeat(width(key))}${l}`)];
  const meta = [t.owner && fg(ROLE_COLOR[t.owner] ?? "9A9AA6")(t.owner), t.ac && dim(t.ac)].filter(Boolean).join(dim(" · "));
  return meta ? [...head, `${" ".repeat(width(key))}${meta}`] : head;
}

function kanban(board, w) {
  const cols = ["todo", "progress", "review", "done"];
  const byCol = Object.fromEntries(cols.map((c) => [c, board.tasks.filter((t) => t.col === c)]));
  const title = (c) => `${fg(COLUMN[c].color)("●")} ${bold(COLUMN[c].label)} ${dim(String(byCol[c].length))}`;
  const gap = 3;
  const colW = Math.floor((w - gap * 3) / 4);
  if (colW < 18) {
    // 좁은 터미널: 세로 목록
    return cols
      .filter((c) => byCol[c].length)
      .map((c) => [title(c), ...byCol[c].flatMap((t) => card(t, w - 2).map((l) => `  ${l}`))].join("\n"))
      .join("\n\n");
  }
  const blocks = cols.map((c) => [title(c), dim("─".repeat(colW)), ...byCol[c].flatMap((t) => [...card(t, colW), ""])]);
  const rows = Math.max(...blocks.map((b) => b.length));
  const lines = [];
  for (let i = 0; i < rows; i += 1) lines.push(blocks.map((b) => pad(b[i] ?? "", colW)).join(" ".repeat(gap)).trimEnd());
  return lines.join("\n").replace(/\n+$/, "");
}

function renderBoard(root, { all = false } = {}) {
  const board = readBoard(root);
  if (!board) return dim("진행 중인 cony 작업이 없습니다. (.cony/board.md 없음)");
  const w = termWidth();
  const team = readTeamConfig(root);
  const out = [header(board, team, root, w), ""];
  for (const item of board.attention) out.push(`${fg("F08C00")("⚠ 확인 필요")}  ${truncate(plain(item), w - 14)}`);
  for (const item of board.blocked) out.push(`${fg("E03131")("✖ 막힌 것")}  ${truncate(plain(item), w - 13)}`);
  if (board.attention.length || board.blocked.length) out.push("");
  out.push(kanban(board, w), "");
  if (board.backlog.length) {
    out.push(`${dim("●")} ${bold("BACKLOG")} ${dim(String(board.backlog.length))}${all ? "" : dim("  (cony board --all 로 목록 보기)")}`);
    if (all) for (const b of board.backlog) out.push(dim(`  · ${truncate(plain(b), w - 4)}`));
    out.push("");
  }
  if (board.now) out.push(`${bold("지금")}  ${truncate(plain(board.now.split("\n")[0]), w - 6)}`);
  if (board.decisions.length) {
    out.push(bold("최근 결정"));
    for (const d of board.decisions.slice(0, 3)) out.push(`  ${dim("·")} ${truncate(plain(d), w - 4)}`);
  }
  if (board.pr && !/^아직 없음/.test(board.pr)) out.push(`${bold("PR")}  ${plain(board.pr)}`);
  return out.join("\n");
}

// ── 지표 그리기 ────────────────────────────────────────────
function renderStats(root) {
  const s = computeStats(root);
  const w = termWidth();
  const c = s.cost;
  const hookTotal = Object.values(s.hooks).reduce((sum, d) => sum + Object.values(d).reduce((a, b) => a + b, 0), 0);
  const agentRuns = Object.entries(c.byRole).filter(([r]) => r !== "리드").reduce((a, [, b]) => a + b.runs, 0);
  const tile = (label, value) => `${dim(label)} ${bold(value)}`;
  const out = [
    bold(`지표 · ${basename(root)}`) + dim(c.found ? `  ${c.since?.slice(0, 10) ?? "?"}부터` : "  (대화 기록 없음, 비용 지표 비어 있음)"),
    "",
    [
      tile("출력 토큰", fmt(c.total.output)),
      tile("합계", fmt(c.total.total)),
      tile("에이전트 실행", String(agentRuns)),
      tile("완료", String(s.flow.done)),
      tile("되돌림", String(s.flow.rollbacks)),
      tile("규칙 건너뜀", String(s.flow.bypasses)),
      tile("hook 차단", String(hookTotal)),
    ].join(dim("  │  ")),
    "",
    bold("역할별 토큰") + dim("  (합계는 캐시 읽기 포함)"),
  ];
  const roles = ["리드", "pm", "fe", "be", "qa", "기타"].filter((r) => c.byRole[r]);
  const max = Math.max(1, ...roles.map((r) => c.byRole[r].total));
  const barW = Math.max(10, w - 44);
  for (const r of roles) {
    const b = c.byRole[r];
    const label = ROLE_COLOR[r] ? badge(ROLE_COLOR[r], r.toUpperCase()) : dim(pad(r, 4));
    const n = Math.max(1, Math.round((b.total / max) * barW));
    out.push(`${pad(label, 6)} ${fg("4C6EF5")("▇".repeat(n))} ${bold(fmt(b.total))} ${dim(`출력 ${fmt(b.output)} · ${b.runs}회`)}`);
  }
  const d = s.debate;
  const pct = d.adrs ? Math.round((d.adrsWithDissent / d.adrs) * 100) : 0;
  const kv = (rows) => rows.map(([k, v]) => `  ${pad(dim(k), 30)} ${bold(String(v))}`);
  out.push(
    "",
    bold("토론"),
    ...kv([
      ["결정(ADR)", d.adrs],
      ["반대·조건부가 있었던 결정", `${d.adrsWithDissent} (${pct}%)`],
      ["사용자가 확정 · 대기 · 뒤집음", `${d.decidedByUser} · ${d.pendingUser} · ${d.reversedByUser}`],
      ["검토 판정 찬성 · 조건부 · 반대", `${d.verdicts.찬성} · ${d.verdicts.조건부} · ${d.verdicts.반대}`],
      ["사람에게 넘긴 문서", d.handoffs],
    ]),
    "",
    bold("사람 개입") + dim(" (log.md)"),
    `  ${Object.entries(s.people).map(([k, v]) => `${dim(k)} ${bold(String(v))}`).join("   ")}`,
    "",
    bold("hook이 막은 횟수"),
  );
  const hooks = Object.entries(s.hooks);
  if (!hooks.length) out.push(dim("  아직 없음"));
  for (const [hook, byDecision] of hooks) {
    out.push(`  ${pad(dim(hook), 30)} ${Object.entries(byDecision).map(([k, v]) => `${k} ${bold(String(v))}`).join("  ")}`);
  }
  return out.join("\n");
}

// ── 실행 ───────────────────────────────────────────────────
const HELP = `cony — 터미널에서 보는 cony 보드와 지표

  cony board [--all]   칸반, 확인 필요·막힌 것, 최근 결정 (--all: 백로그 목록까지)
  cony stats           역할별 토큰, 흐름, 토론, 사람 개입, hook 차단
  cony watch [stats]   바뀔 때마다 다시 그린다 (Ctrl+C 로 끝)

cony 프로젝트(.cony/ 가 있는 폴더) 안에서 실행한다.`;

const [command = "board", ...rest] = process.argv.slice(2);
if (["-h", "--help", "help"].includes(command)) {
  console.log(HELP);
  process.exit(0);
}
const root = findConyRoot(process.cwd());
if (!root) {
  console.error("cony: .cony/ 를 찾을 수 없습니다. cony 프로젝트 안에서 실행하세요.");
  process.exit(1);
}

const views = { board: () => renderBoard(root, { all: rest.includes("--all") }), stats: () => renderStats(root) };

if (command === "watch") {
  const view = views[rest[0] === "stats" ? "stats" : "board"];
  const draw = () => process.stdout.write(`\x1b[2J\x1b[H${view()}\n\n${dim(`${new Date().toLocaleTimeString()} · 바뀌면 다시 그림 · Ctrl+C 로 끝`)}\n`);
  let timer;
  draw();
  watch(join(root, ".cony"), { recursive: true }, (_e, file) => {
    if (file?.startsWith(".cache")) return;
    clearTimeout(timer);
    timer = setTimeout(draw, 150);
  });
  setInterval(draw, rest[0] === "stats" ? 30_000 : 60_000);
} else if (views[command]) {
  console.log(views[command]());
} else {
  console.error(`cony: 모르는 명령 "${command}"\n\n${HELP}`);
  process.exit(1);
}
