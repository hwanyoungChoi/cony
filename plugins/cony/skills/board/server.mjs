import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join, resolve, sep } from "node:path";

import { computeStats } from "./stats.mjs";

const START_PORT = Number(process.env.CONY_BOARD_PORT ?? 4747);
const MAX_PORT_TRIES = 10;

function findConyRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".cony"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const root = findConyRoot(process.argv[2] ?? process.cwd());
if (!root) {
  console.error("cony: .cony/ 를 찾을 수 없습니다. cony 프로젝트 안에서 실행하세요.");
  process.exit(1);
}
const conyDir = join(root, ".cony");

function readMarkdown(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function listDecisions() {
  const dir = join(conyDir, "decisions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .reverse()
    .map((name) => {
      const firstLine = readMarkdown(join(dir, name)).split("\n")[0] ?? "";
      return { path: `decisions/${name}`, title: firstLine.replace(/^#\s*/, "") || name };
    });
}

// 파일명: {YYYYMMDD-HHmm}-{역할}-{대상}.md. 예전 이름도 그대로 보여준다.
const REVIEW_NAME = /^(\d{8})-(\d{4})-(pm|fe|be|qa)-(.+)\.md$/;

const ROLES = ["pm", "fe", "be", "qa"];

function readTeam() {
  try {
    const team = JSON.parse(readFileSync(join(conyDir, "team.json"), "utf8"));
    return {
      ...Object.fromEntries(ROLES.map((role) => [role, ["build", "review", "off"].includes(team[role]) ? team[role] : "build"])),
      decisions: team.decisions === "user" ? "user" : "team",
      merge: ["auto", "pr", "none"].includes(team.merge) ? team.merge : "auto",
    };
  } catch {
    return { ...Object.fromEntries(ROLES.map((role) => [role, "build"])), decisions: "team", merge: "auto" };
  }
}

function listReviews(folder = "reviews") {
  const dir = join(conyDir, folder);
  if (!existsSync(dir)) return [];
  // 최신 라운드가 위, 같은 라운드 안에서는 pm → fe → be → qa
  const roleOrder = (name) => ["pm", "fe", "be", "qa"].indexOf(name.match(REVIEW_NAME)?.[3] ?? "");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort((a, b) => b.slice(0, 13).localeCompare(a.slice(0, 13)) || roleOrder(a) - roleOrder(b))
    .map((name) => {
      const m = name.match(REVIEW_NAME);
      const verdict = (readMarkdown(join(dir, name)).match(/판정[^:\n]*[:：]\s*\**([^\n*]+)/) || [])[1]?.trim() ?? "";
      return m
        ? { path: `${folder}/${name}`, role: m[3], target: m[4], when: `${m[1].slice(4, 6)}/${m[1].slice(6)} ${m[2].slice(0, 2)}:${m[2].slice(2)}`, verdict }
        : { path: `${folder}/${name}`, role: "", target: name.replace(/\.md$/, ""), when: "", verdict };
    });
}

function snapshot() {
  const boardPath = join(conyDir, "board.md");
  return JSON.stringify({
    project: basename(root),
    board: readMarkdown(boardPath),
    boardMtime: existsSync(boardPath) ? statSync(boardPath).mtimeMs : null,
    decisions: listDecisions(),
    reviews: listReviews(),
    handoffs: listReviews("handoffs"),
    team: readTeam(),
  });
}

const clients = new Set();
let debounce;
function broadcast() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    const data = snapshot();
    for (const res of clients) res.write(`data: ${data}\n\n`);
  }, 100);
}

watch(conyDir, { recursive: true }, (_event, filename) => {
  if (filename && filename.startsWith(".cache")) return;
  broadcast();
});

setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25_000);

function resolveConyFile(relPath) {
  if (!relPath || !relPath.endsWith(".md")) return null;
  const full = resolve(conyDir, relPath);
  return full.startsWith(conyDir + sep) && existsSync(full) ? full : null;
}

let statsCache = null;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(new URL("./board.html", import.meta.url), "utf8"));
    return;
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${snapshot()}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/file") {
    const file = resolveConyFile(url.searchParams.get("path"));
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end(readFileSync(file, "utf8"));
    return;
  }

  if (url.pathname === "/stats") {
    if (!statsCache || Date.now() - statsCache.at > 10_000) statsCache = { at: Date.now(), body: JSON.stringify(computeStats(root)) };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(statsCache.body);
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ app: "cony-board", root }));
    return;
  }

  res.writeHead(404).end();
});

async function isSameBoard(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    return body.app === "cony-board" && body.root === root;
  } catch {
    return false;
  }
}

function listen(port, triesLeft) {
  server.once("error", async (error) => {
    if (error.code !== "EADDRINUSE" || triesLeft === 0) throw error;
    if (await isSameBoard(port)) {
      console.log(`cony board: http://localhost:${port} (이미 실행 중)`);
      process.exit(0);
    }
    listen(port + 1, triesLeft - 1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`cony board: http://localhost:${port}`);
  });
}

listen(START_PORT, MAX_PORT_TRIES);
