import { Router }      from "express";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "fs";

const commentsRouter = Router();

const DB_PATH   = "/home/runner/workspace/comments.db";
const JSON_PATH = "/home/runner/workspace/comments.json";
const TTS_API   = "http://127.0.0.1:8080/api/tts/generate";

// ── RAM Sleep Chamber ─────────────────────────────────────────────────────────
//
//  El audio vive en RAM, nunca en disco.
//  Se genera UNA SOLA VEZ por semilla y queda dormido en el Sleep Chamber.
//  Al darle play → materializa al instante desde RAM.
//  Al terminar → vuelve a dormir en RAM (sigue ahí, cero regeneración).
//  Si la RAM está llena → evicta el audio menos usado (el más dormido).
//  Si el servidor se reinicia → la primera vez regenera y vuelve a dormir.
//
const CHAMBER_MAX = 500;  // máximo de audios dormidos en RAM simultáneos

interface Sleeping {
  buf:        Buffer;
  contentType: string;
  lastWoken:  number;   // última vez que materializó
  generated:  number;   // cuándo fue generado
}

const chamber = new Map<string, Sleeping>();

function sleep(id: string, buf: Buffer, ct: string) {
  chamber.set(id, { buf, contentType: ct, lastWoken: Date.now(), generated: Date.now() });
  // Si superamos el límite, evictar el que lleva más tiempo sin materializar
  if (chamber.size > CHAMBER_MAX) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [k, s] of chamber) {
      if (s.lastWoken < oldestTime) { oldestTime = s.lastWoken; oldestKey = k; }
    }
    if (oldestKey) chamber.delete(oldestKey);
  }
}

function wakeUp(id: string): Sleeping | undefined {
  const s = chamber.get(id);
  if (s) s.lastWoken = Date.now();
  return s;
}

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
`);

// Migrar desde JSON si la tabla está vacía
const count = db.prepare("SELECT COUNT(*) as n FROM comentarios").get() as { n: number };
if (count.n === 0 && existsSync(JSON_PATH)) {
  try {
    const items = JSON.parse(readFileSync(JSON_PATH, "utf8")) as { id: string; autor: string; texto: string }[];
    const ins   = db.prepare("INSERT OR IGNORE INTO comentarios (id, autor, texto) VALUES (?, ?, ?)");
    for (const c of items) ins.run(c.id, c.autor, c.texto);
    console.log(`[SleepChamber] Migrados ${items.length} comentarios`);
  } catch (e) { console.error("[SleepChamber] Error migrando:", e); }
}

// ── GET /comments?cursor=<ts>&limit=<n> ──────────────────────────────────────
commentsRouter.get("/comments", (req, res) => {
  const limit  = Math.min(Number(req.query.limit ?? 50), 200);
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;

  const rows = cursor
    ? db.prepare("SELECT id, autor, texto, ts FROM comentarios WHERE ts < ? ORDER BY ts DESC LIMIT ?").all(cursor, limit)
    : db.prepare("SELECT id, autor, texto, ts FROM comentarios ORDER BY ts DESC LIMIT ?").all(limit);

  const nextCursor = rows.length === limit ? (rows[rows.length - 1] as { ts: number }).ts : null;

  const items = (rows as { id: string; autor: string; texto: string; ts: number }[]).map(r => ({
    ...r,
    sleeping: chamber.has(r.id),  // true = ya generado, duerme en RAM listo para materializar
  }));

  res.json({ items, nextCursor });
});

// ── GET /comments/:id/audio — materializar ────────────────────────────────────
commentsRouter.get("/comments/:id/audio", async (req, res) => {
  const id      = req.params.id;
  const voiceId = (req.query.voiceId as string | undefined) ?? "darwin";
  const record  = db.prepare("SELECT texto FROM comentarios WHERE id = ?").get(id) as
    { texto: string } | undefined;

  if (!record) { res.status(404).json({ error: "No encontrado" }); return; }

  // ── Duerme en RAM → materializa al instante ───────────────────────────────
  const sleeping = wakeUp(id);
  if (sleeping) {
    res.setHeader("Content-Type", sleeping.contentType);
    res.setHeader("X-Chamber", "AWAKE");
    res.send(sleeping.buf);
    return;
  }

  // ── Primera vez (o reinicio): generar una sola vez y poner a dormir ───────
  try {
    const ttsRes = await fetch(TTS_API, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: record.texto, voiceId }),
    });
    if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`);
    const ct  = ttsRes.headers.get("content-type") ?? "audio/wav";
    const buf = Buffer.from(await ttsRes.arrayBuffer());

    // Poner a dormir en RAM — no toca el disco nunca
    sleep(id, buf, ct);
    console.log(`[SleepChamber] "${id}" generado y dormido — ${(buf.length/1024).toFixed(0)} KB en RAM`);

    res.setHeader("Content-Type", ct);
    res.setHeader("X-Chamber", "GENERATED");
    res.send(buf);
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
});

// ── GET /comments/chamber/status ─────────────────────────────────────────────
commentsRouter.get("/comments/chamber/status", (_req, res) => {
  const total   = db.prepare("SELECT COUNT(*) as n FROM comentarios").get() as { n: number };
  const sleeping = chamber.size;
  const ramBytes = [...chamber.values()].reduce((s, g) => s + g.buf.length, 0);
  res.json({
    total_seeds:    total.n,
    sleeping_in_ram: sleeping,
    ram_kb:         Math.round(ramBytes / 1024),
    disk_audio_kb:  0,
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
  res.status(201).json({ id, autor: autor.trim() || "Anónimo", texto: texto.trim(), sleeping: false });
});

// ── DELETE /comments/:id ──────────────────────────────────────────────────────
commentsRouter.delete("/comments/:id", (req, res) => {
  chamber.delete(req.params.id);
  db.prepare("DELETE FROM comentarios WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

export default commentsRouter;
