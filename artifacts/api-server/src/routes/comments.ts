import { Router }      from "express";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "fs";

const commentsRouter = Router();

const DB_PATH   = "/home/runner/workspace/comments.db";
const JSON_PATH = "/home/runner/workspace/comments.json";
const TTS_API   = "http://127.0.0.1:8080/api/tts/generate";

const db = new DatabaseSync(DB_PATH);

// La semilla guarda: texto + audio_b64 (audio como texto Base64, nunca binario)
db.exec(`
  CREATE TABLE IF NOT EXISTS comentarios (
    id        TEXT PRIMARY KEY,
    autor     TEXT NOT NULL,
    texto     TEXT NOT NULL,
    audio_b64 TEXT,
    ts        INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_ts ON comentarios(ts);
  PRAGMA journal_mode=WAL;
`);

// Agregar columna si la tabla ya existía sin ella
try { db.exec("ALTER TABLE comentarios ADD COLUMN audio_b64 TEXT"); } catch { /* ya existe */ }

// Migrar desde JSON si la tabla está vacía
const row = db.prepare("SELECT COUNT(*) as n FROM comentarios").get() as { n: number };
if (row.n === 0 && existsSync(JSON_PATH)) {
  try {
    const items = JSON.parse(readFileSync(JSON_PATH, "utf8")) as { id: string; autor: string; texto: string }[];
    const ins   = db.prepare("INSERT OR IGNORE INTO comentarios (id, autor, texto) VALUES (?, ?, ?)");
    for (const c of items) ins.run(c.id, c.autor, c.texto);
    console.log(`[DB] Migrados ${items.length} comentarios desde JSON → SQLite`);
  } catch (e) { console.error("[DB] Error migrando JSON:", e); }
}

// ── GET /comments?cursor=<ts>&limit=<n> ──────────────────────────────────────
commentsRouter.get("/comments", (req, res) => {
  const limit  = Math.min(Number(req.query.limit ?? 50), 200);
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;

  const rows = cursor
    ? db.prepare("SELECT id, autor, texto, (audio_b64 IS NOT NULL) as hasAudio, ts FROM comentarios WHERE ts < ? ORDER BY ts DESC LIMIT ?").all(cursor, limit)
    : db.prepare("SELECT id, autor, texto, (audio_b64 IS NOT NULL) as hasAudio, ts FROM comentarios ORDER BY ts DESC LIMIT ?").all(limit);

  const nextCursor = rows.length === limit ? (rows[rows.length - 1] as { ts: number }).ts : null;
  res.json({ items: rows, nextCursor });
});

// ── GET /comments/:id/audio ───────────────────────────────────────────────────
// Si la semilla ya tiene el audio guardado como texto (Base64), lo decodifica y sirve.
// Si no, genera el audio, lo convierte a texto Base64, lo guarda en la semilla y lo sirve.
// El audio vive como texto en la semilla para siempre.
commentsRouter.get("/comments/:id/audio", async (req, res) => {
  const id      = req.params.id;
  const voiceId = (req.query.voiceId as string | undefined) ?? "darwin";
  const record  = db.prepare("SELECT texto, audio_b64 FROM comentarios WHERE id = ?").get(id) as
    { texto: string; audio_b64: string | null } | undefined;

  if (!record) { res.status(404).json({ error: "No encontrado" }); return; }

  // Si el audio ya está guardado como texto en la semilla → decodificar y servir
  if (record.audio_b64) {
    const buf = Buffer.from(record.audio_b64, "base64");
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("X-Seed", "HIT");
    res.send(buf);
    return;
  }

  // Primera vez: generar, convertir a texto Base64, guardar en la semilla
  try {
    const ttsRes = await fetch(TTS_API, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: record.texto, voiceId }),
    });
    if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`);

    const buf     = Buffer.from(await ttsRes.arrayBuffer());
    const b64text = buf.toString("base64");   // audio → texto

    // Guardar el audio como texto en la semilla para siempre
    db.prepare("UPDATE comentarios SET audio_b64 = ? WHERE id = ?").run(b64text, id);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("X-Seed", "MISS");
    res.send(buf);
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
});

// ── POST /comments ────────────────────────────────────────────────────────────
commentsRouter.post("/comments", (req, res) => {
  const { autor = "Anónimo", texto } = req.body as { autor?: string; texto?: string };
  if (!texto?.trim()) { res.status(400).json({ error: "texto requerido" }); return; }
  const id = Date.now().toString();
  db.prepare("INSERT INTO comentarios (id, autor, texto) VALUES (?, ?, ?)").run(
    id, (autor.trim() || "Anónimo"), texto.trim()
  );
  res.status(201).json({ id, autor: autor.trim() || "Anónimo", texto: texto.trim(), hasAudio: 0 });
});

// ── DELETE /comments/:id ──────────────────────────────────────────────────────
commentsRouter.delete("/comments/:id", (req, res) => {
  db.prepare("DELETE FROM comentarios WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

export default commentsRouter;
