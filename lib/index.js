/**
 * dsh-context-tamer — host half (0.1.0).
 *
 * 1) `contextTamer` session projection: live context-size estimate (last
 *    billed step's input incl. cache read/write), peak, and conversation
 *    weight counters (turns / messages / tool events).
 * 2) settings namespace `contexttamer` ({threshold}) persisted through the
 *    official host settings provider (settings.yaml) — the client half
 *    reads/writes it via the /dsh-context-tamer/config endpoint, never
 *    localStorage.
 * 3) `/handoff` command: writes a HANDOFF.md skeleton into the session cwd
 *    with computed stats (context estimate, top-level file tree, recent git
 *    log) so the model can finish the document while its memory is freshest.
 */
import z from "zod";
import sm from "@deepseek-ai/schemastery";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const name = "dsh-context-tamer";
export const inject = ["commands", "settings", "sessions", "webServer"];

const SETTINGS_NS = "contexttamer";
const DEFAULT_THRESHOLD = 150000;
const THRESHOLD_MIN = 1000;
const THRESHOLD_MAX = 100000000;

const settingsSchema = sm.object({
  threshold: sm.number().min(THRESHOLD_MIN).max(THRESHOLD_MAX).default(DEFAULT_THRESHOLD),
  autoCommit: sm.boolean().default(false),
});

/* ── projection ─────────────────────────────────────────────────────── */

const stateSchema = z.object({
  lastContextTokens: z.number().int().nonnegative(),
  peakContextTokens: z.number().int().nonnegative(),
  lastInputTokens: z.number().int().nonnegative(),
  lastCacheReadTokens: z.number().int().nonnegative(),
  lastCacheWriteTokens: z.number().int().nonnegative(),
  lastOutputTokens: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  userMessages: z.number().int().nonnegative(),
  assistantMessages: z.number().int().nonnegative(),
  toolEvents: z.number().int().nonnegative(),
  lastModel: z.string().nullable(),
  lastProvider: z.string().nullable(),
  firstTime: z.string().nullable(),
  lastTime: z.string().nullable(),
});

const initState = () => ({
  lastContextTokens: 0,
  peakContextTokens: 0,
  lastInputTokens: 0,
  lastCacheReadTokens: 0,
  lastCacheWriteTokens: 0,
  lastOutputTokens: 0,
  turns: 0,
  userMessages: 0,
  assistantMessages: 0,
  toolEvents: 0,
  lastModel: null,
  lastProvider: null,
  firstTime: null,
  lastTime: null,
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** Fold one session event into the projection state (pure). */
function applyStep(state, event) {
  const type = event && event.type;
  let next = state;
  if (typeof event?.time === "string") {
    next = { ...next, lastTime: event.time, firstTime: next.firstTime ?? event.time };
  }
  if (type === "user/message") return { ...next, userMessages: next.userMessages + 1 };
  if (type === "turn/end") return { ...next, turns: next.turns + 1 };
  if (typeof type === "string" && type.startsWith("tool/")) return { ...next, toolEvents: next.toolEvents + 1 };
  if (type === "assistant/message") {
    next = { ...next, assistantMessages: next.assistantMessages + 1 };
    const data = event.data ?? {};
    const usage = data.usage;
    if (usage && typeof usage === "object") {
      const input = num(usage.inputTokens);
      const cacheRead = num(usage.cacheReadTokens);
      const cacheWrite = num(usage.cacheWriteTokens);
      const output = num(usage.outputTokens);
      const contextTokens = input + cacheRead + cacheWrite;
      next = {
        ...next,
        lastContextTokens: contextTokens,
        peakContextTokens: Math.max(next.peakContextTokens, contextTokens),
        lastInputTokens: input,
        lastCacheReadTokens: cacheRead,
        lastCacheWriteTokens: cacheWrite,
        lastOutputTokens: output,
      };
    }
    const src = data.message && data.message.source;
    if (src && typeof src === "object") {
      if (typeof src.model === "string" && src.model !== "") next.lastModel = src.model;
      if (typeof src.provider === "string" && src.provider !== "") next.lastProvider = src.provider;
    }
    return next;
  }
  return next;
}

const contextTamerProjection = {
  key: "contextTamer",
  stateSchema,
  init: initState,
  apply: applyStep,
  wire: { viewSchema: stateSchema, view: (s) => s },
  stateVersion: 1,
};

/* ── helpers ────────────────────────────────────────────────────────── */

function fmtTokens(n) {
  n = num(n);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function topLevelTree(cwd) {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    const rows = [];
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      rows.push(e.isDirectory() ? e.name + "/" : e.name);
      if (rows.length >= 60) break;
    }
    return rows;
  } catch {
    return [];
  }
}

function gitLog(cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, "log", "--oneline", "-n", "10"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = String(out).split("\n").filter((l) => l.trim() !== "");
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/* ── recent-conversation excerpt ─────────────────────────────────────── */
/* The handoff is keyed per working directory, but several projects can
   share one directory; the excerpt ties each generated handoff to the
   SOURCE session's own dialogue so continuations never mix projects. */

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const b of blocks) {
    if (b && typeof b === "object" && typeof b.text === "string") parts.push(b.text);
    else if (typeof b === "string") parts.push(b);
  }
  return parts.join("\n").replace(/\s+/g, " ").trim();
}

function recentExcerpt(events, maxUser, maxAssistant, maxChars) {
  const users = [];
  const assists = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || !ev.data) continue;
    if (ev.type === "user/message") {
      const src = ev.data.source;
      if (src && src.kind === "user" && users.length < maxUser) {
        const t = textOfBlocks(ev.data.content);
        if (t !== "") users.unshift(t.slice(0, maxChars));
      }
    } else if (ev.type === "assistant/message") {
      if (assists.length < maxAssistant) {
        const msg = ev.data.message ?? ev.data;
        const t = textOfBlocks(msg && msg.content);
        if (t !== "") assists.unshift(t.slice(0, maxChars));
      }
    }
    if (users.length >= maxUser && assists.length >= maxAssistant) break;
  }
  return { users, assists };
}

function buildSkeleton(cwd, s, events) {
  const eventCount = Array.isArray(events) ? events.length : 0;
  const now = new Date().toISOString();
  const tree = topLevelTree(cwd);
  const log = gitLog(cwd);
  const excerpt = recentExcerpt(events, 3, 3, 400);
  const lines = [];
  lines.push("# HANDOFF.md（项目交接快照，新会话第一份必读）");
  lines.push("");
  lines.push(`> 生成时间: ${now}`);
  lines.push(`> 工作目录: ${cwd}`);
  lines.push(`> 自动统计: ${eventCount} 个会话事件 · ${s.turns} 轮 · 消息 ${s.userMessages + s.assistantMessages} · 工具事件 ${s.toolEvents}`);
  lines.push(`> 上下文估算: 最近一步 ${fmtTokens(s.lastContextTokens)} tokens（峰值 ${fmtTokens(s.peakContextTokens)}，含缓存读 ${fmtTokens(s.lastCacheReadTokens)} / 缓存写 ${fmtTokens(s.lastCacheWriteTokens)}）`);
  if (s.lastProvider || s.lastModel) {
    lines.push(`> 最近模型: ${s.lastProvider ? s.lastProvider + " / " : ""}${s.lastModel ?? ""}`);
  }
  lines.push("");
  lines.push("## 最近对话摘要（生成自当前会话，继续时以此为准）");
  if (excerpt.users.length === 0 && excerpt.assists.length === 0) {
    lines.push("（本会话无对话记录）");
  } else {
    if (excerpt.users.length > 0) {
      lines.push("### 用户最近发言");
      for (const t of excerpt.users) lines.push("- " + t);
    }
    if (excerpt.assists.length > 0) {
      lines.push("### 助手最近回复");
      for (const t of excerpt.assists) lines.push("- " + t);
    }
  }
  lines.push("");
  lines.push("## 1. 项目目标与当前阶段");
  lines.push("（一句话：这个项目要做什么，目前做到哪一步）");
  lines.push("");
  lines.push("## 2. 关键文件地图");
  lines.push("（3~8 个核心文件/目录，各自干什么）");
  if (tree.length > 0) {
    lines.push("");
    lines.push("工作目录顶层：");
    for (const row of tree) lines.push("- " + row);
  }
  lines.push("");
  lines.push("## 3. 任务状态");
  lines.push("### 已完成");
  lines.push("（精确到文件/功能，附验证方式）");
  lines.push("");
  lines.push("### 进行中");
  lines.push("（做到哪个函数、卡在哪、下一步动作）");
  lines.push("");
  lines.push("### 未开始");
  lines.push("（按优先级列，附目标文件路径）");
  lines.push("");
  lines.push("## 4. 关键决策与原因");
  lines.push("（为什么选这个方案/库/接口，拒绝过什么）");
  lines.push("");
  lines.push("## 5. 已知坑");
  lines.push("（重走必踩的雷，一行一条）");
  lines.push("");
  lines.push("## 6. 验证命令");
  lines.push("（怎么跑测试/构建，确认没坏）");
  lines.push("");
  lines.push("## 7. 数据与接口约定");
  lines.push("（数据库位置、字段、端口、外部依赖版本）");
  lines.push("");
  lines.push("## 8. 下一步行动");
  lines.push("（按优先级，每条附目标文件路径与预期改动）");
  if (log) {
    lines.push("");
    lines.push("## 9. 最近提交（git log）");
    for (const l of log) lines.push("- " + l);
  }
  lines.push("");
  lines.push("---");
  lines.push("使用方式：新会话开场先读本文件 → 复述理解 → 你核对 → 跑验证命令 → 再开工。");
  return lines.join("\n");
}

/* ── webServer helpers ──────────────────────────────────────────────── */

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/* ── plugin body ────────────────────────────────────────────────────── */

export function apply(ctx) {
  /* 1) context projection */
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register(contextTamerProjection);
  });

  /* 2) settings scope, with a JSON-file fallback so writes always persist */
  const dshHome = () => process.env.DSH_HOME || join(os.homedir(), ".dsh");
  const fallbackFile = () => join(dshHome(), "storages", "context-tamer.json");
  const validThreshold = (t) => Number.isFinite(t) && t >= THRESHOLD_MIN && t <= THRESHOLD_MAX;
  let scope = null;
  try {
    scope = ctx.settings.register(SETTINGS_NS, settingsSchema);
  } catch (err) {
    ctx.logger?.warn?.("dsh-context-tamer: settings register failed, using file fallback: %s", String(err?.message ?? err));
  }
  const readFallback = () => {
    try {
      const raw = JSON.parse(readFileSync(fallbackFile(), "utf8"));
      return {
        threshold: validThreshold(raw.threshold) ? raw.threshold : DEFAULT_THRESHOLD,
        autoCommit: raw.autoCommit === true,
      };
    } catch {
      /* absent or malformed */
    }
    return null;
  };
  const getConfig = () => {
    if (scope) {
      try {
        const v = scope.get();
        if (validThreshold(v && v.threshold)) {
          return { threshold: v.threshold, autoCommit: v.autoCommit === true };
        }
      } catch {
        /* fall through */
      }
    }
    return readFallback() ?? { threshold: DEFAULT_THRESHOLD, autoCommit: false };
  };
  const setConfig = async (patch) => {
    const normalized = {};
    if (validThreshold(patch.threshold)) normalized.threshold = Math.round(patch.threshold);
    if (typeof patch.autoCommit === "boolean") normalized.autoCommit = patch.autoCommit;
    if (Object.keys(normalized).length === 0) return;
    if (scope) {
      await scope.update(normalized);
      return;
    }
    const merged = { ...getConfig(), ...normalized };
    try {
      mkdirSync(dirname(fallbackFile()), { recursive: true });
      writeFileSync(fallbackFile(), JSON.stringify(merged), "utf8");
    } catch (err) {
      ctx.logger?.warn?.("dsh-context-tamer: fallback write failed: %s", String(err?.message ?? err));
    }
  };

  /* 5) automatic HANDOFF freshness. The handoff lives OUTSIDE the project
     (~/.dsh/storages/handoffs/<sha1(cwd)>.md, indexed by
     ~/.dsh/storages/handoffs/index.json) so the project folder stays clean.
     Auto-update only overwrites content this plugin last wrote (model-filled
     handoffs are never clobbered). Optional git checkpoint when autoCommit
     is on (>=5 min apart). All guarded — never breaks a turn. */
  const AUTO_MARKER = "<!-- auto-generated by dsh-context-tamer -->";
  const handoffDir = () => join(dshHome(), "storages", "handoffs");
  const handoffFileFor = (cwd) => join(handoffDir(), createHash("sha1").update(String(cwd).toLowerCase()).digest("hex").slice(0, 12) + ".md");
  const indexFile = () => join(handoffDir(), "index.json");
  const updateIndex = (cwd, file) => {
    try {
      mkdirSync(handoffDir(), { recursive: true });
      let index = {};
      try {
        index = JSON.parse(readFileSync(indexFile(), "utf8"));
      } catch {
        /* first run */
      }
      index[String(cwd)] = { file: basename(file), updatedAt: new Date().toISOString() };
      writeFileSync(indexFile(), JSON.stringify(index, null, 2), "utf8");
    } catch {
      /* non-fatal */
    }
  };

  /* Conservative cleanup of per-session continuation handoffs:
     - only `session-*.md` auto files are candidates (cwd-keyed and
       model-filled handoffs are never touched);
     - keep the newest 50, and only delete files older than 7 days;
     - index.json entries pointing at deleted files are dropped.
     The file just minted by a continuation is always the newest, so the
     AI always finds what its prompt references. */
  const pruneHandoffs = () => {
    const MAX_KEEP = 50;
    const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    try {
      const dir = handoffDir();
      const files = readdirSync(dir).filter((f) => f.startsWith("session-") && f.endsWith(".md"));
      const now = Date.now();
      const rows = [];
      for (const f of files) {
        try {
          rows.push({ f, m: statSync(join(dir, f)).mtimeMs });
        } catch {
          rows.push({ f, m: 0 });
        }
      }
      rows.sort((a, b) => b.m - a.m);
      const doomed = new Set();
      for (let i = 0; i < rows.length; i++) {
        if (i >= MAX_KEEP && now - rows[i].m > MIN_AGE_MS) doomed.add(rows[i].f);
      }
      for (const f of doomed) {
        try {
          unlinkSync(join(dir, f));
        } catch {
          /* busy / gone */
        }
      }
      if (doomed.size === 0) return;
      try {
        let index = {};
        try {
          index = JSON.parse(readFileSync(indexFile(), "utf8"));
        } catch {
          return;
        }
        let changed = false;
        for (const [cwd, entry] of Object.entries(index)) {
          if (entry && doomed.has(entry.file)) {
            delete index[cwd];
            changed = true;
          }
        }
        if (changed) writeFileSync(indexFile(), JSON.stringify(index, null, 2), "utf8");
      } catch {
        /* non-fatal */
      }
    } catch {
      /* never break a turn over cleanup */
    }
  };
  const lastHandoffWrite = new Map(); // sessionId -> { turns, at, content }
  const lastAutoCommit = new Map(); // sessionId -> at
  try {
    ctx.on("session/event", (session, event) => {
      if (event?.type !== "turn/end") return;
      try {
        const sid = session?.id;
        const cwd =
          session?.header && typeof session.header.cwd === "string" && session.header.cwd !== ""
            ? session.header.cwd
            : null;
        if (!sid || !cwd) return;
        const now = Date.now();
        const prev = lastHandoffWrite.get(sid);
        if (prev && now - prev.at < 30000) return;
        const events = Array.isArray(session.events) ? session.events : [];
        let s = initState();
        for (const ev of events) s = applyStep(s, ev);
        if (prev && prev.turns === s.turns) return;
        const target = handoffFileFor(cwd);
        let existing = "";
        try {
          existing = readFileSync(target, "utf8");
        } catch {
          /* absent */
        }
        // Only refresh content we wrote ourselves; a model-filled handoff is sacred.
        if (existing !== "" && (prev === undefined || prev.content !== existing)) return;
        const content = AUTO_MARKER + "\n" + buildSkeleton(cwd, s, events);
        mkdirSync(handoffDir(), { recursive: true });
        writeFileSync(target, content, "utf8");
        updateIndex(cwd, target);
        lastHandoffWrite.set(sid, { turns: s.turns, at: now, content });
        if (getConfig().autoCommit) {
          const lastAt = lastAutoCommit.get(sid) ?? 0;
          if (now - lastAt >= 5 * 60 * 1000) {
            try {
              execFileSync("git", ["-C", cwd, "add", "-A"], { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
              execFileSync("git", ["-C", cwd, "commit", "-m", "checkpoint: auto commit (dsh-context-tamer)"], { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
              lastAutoCommit.set(sid, now);
            } catch {
              /* not a repo / nothing to commit / git absent */
            }
          }
        }
      } catch {
        /* never break a turn over handoff upkeep */
      }
    });
  } catch (err) {
    ctx.logger?.warn?.("dsh-context-tamer: session/event hook failed: %s", String(err?.message ?? err));
  }

  /* 3) /handoff command */
  try {
    ctx.commands.register({
      name: "handoff",
      description: "Write a HANDOFF.md handover skeleton (stats + template) into the workspace",
      handler: async (invocation) => {
        try {
          const session = invocation.agent?.session;
          const cwd =
            (session?.header && typeof session.header.cwd === "string" && session.header.cwd !== ""
              ? session.header.cwd
              : process.cwd());
          const events = Array.isArray(session?.events) ? session.events : [];
          let s = initState();
          for (const ev of events) s = applyStep(s, ev);
          const target = handoffFileFor(cwd);
          mkdirSync(handoffDir(), { recursive: true });
          writeFileSync(target, AUTO_MARKER + "\n" + buildSkeleton(cwd, s, events), "utf8");
          updateIndex(cwd, target);
          return {
            kind: "success",
            text:
              `HANDOFF 骨架已写入 ${target}（在 ~/.dsh/storages 下，项目目录保持干净）\n` +
              `（上下文约 ${fmtTokens(s.lastContextTokens)}、峰值 ${fmtTokens(s.peakContextTokens)}、` +
              `${s.turns} 轮、${s.userMessages + s.assistantMessages} 条消息）\n` +
              `请基于当前上下文直接编辑该文件、补全第 1~8 章；换新会话时助手会经 index.json 自动找到它。`,
          };
        } catch (err) {
          return { kind: "error", text: "HANDOFF 生成失败: " + String(err?.message ?? err) };
        }
      },
    });
  } catch (err) {
    ctx.logger?.warn?.("dsh-context-tamer: /handoff register failed: %s", String(err?.message ?? err));
  }

  /* 4) config + session-cwd endpoints for the client half */
  ctx.inject(["webServer"], (injected) => {
    injected.webServer.register({
      kind: "prefix",
      path: "/dsh-context-tamer",
      handler: async (req, res) => {
        const url = new URL(req.url, "http://localhost");

        /* One-click continuation: mint/refresh THIS session's handoff and
           return its absolute path plus the authoritative cwd, so the new
           conversation references that exact file — never a wrong project's. */
        if (url.pathname.endsWith("/continue")) {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, reason: "method" });
            return;
          }
          try {
            const body = await readBody(req);
            const sid = body && body.sessionId;
            const sess = ctx.sessions && typeof ctx.sessions.get === "function" && sid ? ctx.sessions.get(sid) : undefined;
            if (!sess) {
              sendJson(res, 404, { ok: false, reason: "unknown-session" });
              return;
            }
            const cwd = sess.header && typeof sess.header.cwd === "string" && sess.header.cwd !== "" ? sess.header.cwd : null;
            if (!cwd) {
              sendJson(res, 400, { ok: false, reason: "no-cwd" });
              return;
            }
            const events = Array.isArray(sess.events) ? sess.events : [];
            let s = initState();
            for (const ev of events) s = applyStep(s, ev);
            // Per-session handoff: every continuation mints a FRESH file for
            // THIS conversation (its own recent dialogue is embedded), so
            // projects sharing one working directory never mix. The shared
            // cwd-keyed file is left untouched.
            const target = join(handoffDir(), "session-" + createHash("sha1").update(String(sid).toLowerCase()).digest("hex").slice(0, 12) + ".md");
            const content = AUTO_MARKER + "\n" + buildSkeleton(cwd, s, events);
            mkdirSync(handoffDir(), { recursive: true });
            writeFileSync(target, content, "utf8");
            updateIndex(cwd, target);
            pruneHandoffs();
            sendJson(res, 200, { ok: true, cwd, handoffFile: target, stats: s });
          } catch (err) {
            sendJson(res, 500, { ok: false, reason: "internal", error: String(err?.message ?? err) });
          }
          return;
        }

        /* Diagnostic: every live session id → cwd (troubleshooting only). */
        if (url.pathname.endsWith("/sessions")) {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, reason: "method" });
            return;
          }
          try {
            const list = ctx.sessions && typeof ctx.sessions.list === "function" ? ctx.sessions.list() : [];
            sendJson(res, 200, {
              ok: true,
              sessions: list.map((sess) => ({
                id: sess?.id ?? null,
                cwd: sess?.header && typeof sess.header.cwd === "string" ? sess.header.cwd : null,
              })),
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, reason: "internal", error: String(err?.message ?? err) });
          }
          return;
        }

        /* Client debug log: the client half reports its continue-flow
           decisions here so failures can be diagnosed from the host side. */
        if (url.pathname.endsWith("/client-log")) {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, reason: "method" });
            return;
          }
          try {
            const body = await readBody(req);
            const line = JSON.stringify({
              at: new Date().toISOString(),
              ...(body && typeof body === "object" ? body : { raw: body }),
            });
            try {
              const file = join(dshHome(), "storages", "context-tamer-debug.log");
              mkdirSync(dirname(file), { recursive: true });
              appendFileSync(file, line + "\n", "utf8");
            } catch {
              /* non-fatal */
            }
            sendJson(res, 200, { ok: true });
          } catch (err) {
            sendJson(res, 500, { ok: false, reason: "internal", error: String(err?.message ?? err) });
          }
          return;
        }

        if (!url.pathname.endsWith("/config")) {
          sendJson(res, 404, { ok: false, reason: "not-found" });
          return;
        }
        try {
          if (req.method === "GET") {
            sendJson(res, 200, { ok: true, ...getConfig() });
            return;
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            const t = num(body && body.threshold);
            if (body && body.threshold !== undefined && (t < THRESHOLD_MIN || t > THRESHOLD_MAX)) {
              sendJson(res, 400, { ok: false, reason: "bad-threshold" });
              return;
            }
            if (body && body.autoCommit !== undefined && typeof body.autoCommit !== "boolean") {
              sendJson(res, 400, { ok: false, reason: "bad-autocommit" });
              return;
            }
            await setConfig(body ?? {});
            sendJson(res, 200, { ok: true, ...getConfig() });
            return;
          }
          sendJson(res, 405, { ok: false, reason: "method" });
        } catch (err) {
          sendJson(res, 500, { ok: false, reason: "internal", error: String(err?.message ?? err) });
        }
      },
    });
  });
}
