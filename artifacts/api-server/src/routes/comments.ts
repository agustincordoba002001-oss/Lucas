import { Router }      from "express";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "fs";

const commentsRouter = Router();

const DB_PATH   = "/home/runner/workspace/comments.db";
const JSON_PATH = "/home/runner/workspace/comments.json";
const TTS_API   = "http://127.0.0.1:8080/api/tts/generate";

// ── GhostSeed: fantasmas de audio en memoria ──────────────────────────────────
//
//  El texto vive en la base de datos para siempre (~100 bytes/frase).
//  El audio no se guarda en ningún lado — vive como un "fantasma" en RAM.
//  Cuando le das play → materializa el fantasma (genera el audio).
//  Si nadie lo usa en GHOST_TTL ms → se evapora solo.
//  La semilla sigue existiendo (texto eterno). El fantasma vuelve al próximo play.
//
const GHOST_TTL    = 2 * 60 * 60 * 1000;   // 2 horas de vida
const GHOST_MAX    = 200;                   // máximo de fantasmas simultáneos en RAM

interface Ghost {
  buf:        Buffer;
  contentType: string;
  lastAccess: number;
}

const ghosts = new Map<string, Ghost>();

function touchGhost(id: string, buf: Buffer, ct: string) {
  ghosts.set(id, { buf, contentType: ct, lastAccess: Date.now() });
  // Si superamos el máximo, evaporar el más viejo
  if (ghosts.size > GHOST_MAX) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [k, g] of ghosts) {
      if (g.lastAccess < oldestTime) { oldestTime = g.lastAccess; oldestKey = k; }
    }
    if (oldestKey) ghosts.delete(oldestKey);
  }
}

// Evaporar fantasmas viejos cada 30 minutos
setInterval(() => {
  const cutoff = Date.now() - GHOST_TTL;
  let evaporados = 0;
  for (const [k, g] of ghosts) {
    if (g.lastAccess < cutoff) { ghosts.delete(k); evaporados++; }
  }
  if (evaporados > 0) console.log(`[GhostSeed] ${evaporados} fantasma(s) evaporados`);
}, 30 * 60 * 1000);

// ── SQLite — solo texto, cero audio en disco ──────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS comentarios (
    id    TEXT PRIMARY KEY,
    autor TEXT NOT NULL,
    texto TEXT NOT NULL,
    ts    INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_ts ON comentarios(ts);
  PRAGMA journal_mode=WAL;
  PRAGMA page_size=4096;
  PRAGMA cache_size=-32000;
`);

// Migrar desde JSON si la tabla está vacía
const count = db.prepare("SELECT COUNT(*) as n FROM comentarios").get() as { n: number };
if (count.n === 0 && existsSync(JSON_PATH)) {
  try {
    const items = JSON.parse(readFileSync(JSON_PATH, "utf8")) as { id: string; autor: string; texto: string }[];
    const ins   = db.prepare("INSERT OR IGNORE INTO comentarios (id, autor, texto) VALUES (?, ?, ?)");
    for (const c of items) ins.run(c.id, c.autor, c.texto);
    console.log(`[GhostSeed] Migrados ${items.length} comentarios → SQLite`);
  } catch (e) { console.error("[GhostSeed] Error migrando JSON:", e); }
}

// ── GET /comments?cursor=<ts>&limit=<n> ──────────────────────────────────────
commentsRouter.get("/comments", (req, res) => {
  const limit  = Math.min(Number(req.query.limit ?? 50), 200);
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;

  const rows = cursor
    ? db.prepare("SELECT id, autor, texto, ts FROM comentarios WHERE ts < ? ORDER BY ts DESC LIMIT ?").all(cursor, limit)
    : db.prepare("SELECT id, autor, texto, ts FROM comentarios ORDER BY ts DESC LIMIT ?").all(limit);

  const nextCursor = rows.length === limit ? (rows[rows.length - 1] as { ts: number }).ts : null;

  // Adjuntar estado del fantasma a cada frase
  const items = (rows as { id: string; autor: string; texto: string; ts: number }[]).map(r => ({
    ...r,
    ghost: ghosts.has(r.id),
  }));

  res.json({ items, nextCursor });
});

// ── GET /comments/:id/audio — GhostSeed ──────────────────────────────────────
commentsRouter.get("/comments/:id/audio", async (req, res) => {
  const id      = req.params.id;
  const voiceId = (req.query.voiceId as string | undefined) ?? "darwin";
  const record  = db.prepare("SELECT texto FROM comentarios WHERE id = ?").get(id) as
    { texto: string } | undefined;

  if (!record) { res.status(404).json({ error: "No encontrado" }); return; }

  // ── Fantasma vivo → instante, sin generar nada ────────────────────────────
  const ghost = ghosts.get(id);
  if (ghost) {
    ghost.lastAccess = Date.now();
    res.setHeader("Content-Type", ghost.contentType);
    res.setHeader("X-Ghost", "HIT");
    res.send(ghost.buf);
    return;
  }

  // ── Fantasma muerto o nunca existió → materializar ────────────────────────
  try {
    const ttsRes = await fetch(TTS_API, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: record.texto, voiceId }),
    });
    if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`);

    const ct  = ttsRes.headers.get("content-type") ?? "audio/wav";
    const buf = Buffer.from(await ttsRes.arrayBuffer());

    // Materializar el fantasma en RAM (no toca el disco)
    touchGhost(id, buf, ct);

    res.setHeader("Content-Type", ct);
    res.setHeader("X-Ghost", "MATERIALIZED");
    res.send(buf);
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
});

// ── GET /comments/ghosts/status — estado de los fantasmas ────────────────────
commentsRouter.get("/comments/ghosts/status", (_req, res) => {
  const total   = db.prepare("SELECT COUNT(*) as n FROM comentarios").get() as { n: number };
  const alive   = ghosts.size;
  const ramBytes = [...ghosts.values()].reduce((s, g) => s + g.buf.length, 0);
  res.json({
    total_seeds:   total.n,
    ghosts_alive:  alive,
    ghosts_ram_kb: Math.round(ramBytes / 1024),
    db_text_only:  true,
  });
});

// ── POST /comments ────────────────────────────────────────────────────────────
commentsRouter.post("/comments", (req, res) => {
  const { autor = "Anónimo", texto } = req.body as { autor?: string; texto?: string };
  if (!texto?.trim()) { res.status(400).json({ error: "texto requerido" }); return; }
  const id = Date.now().toString();
  db.prepare("INSERT INTO comentarios (id, autor, texto) VALUES (?, ?, ?)").run(
    id, (autor.trim() || "Anónimo"), texto.trim()
  );
  res.status(201).json({ id, autor: autor.trim() || "Anónimo", texto: texto.trim(), ghost: false });
});

// ── DELETE /comments/:id/ghost — evaporar fantasma al instante ───────────────
commentsRouter.delete("/comments/:id/ghost", (req, res) => {
  const existed = ghosts.has(req.params.id);
  ghosts.delete(req.params.id);
  res.json({ ok: true, evaporated: existed });
});

// ── DELETE /comments/:id ──────────────────────────────────────────────────────
commentsRouter.delete("/comments/:id", (req, res) => {
  ghosts.delete(req.params.id);
  db.prepare("DELETE FROM comentarios WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

export default commentsRouter;
