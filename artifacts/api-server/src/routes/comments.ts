import { Router }      from "express";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

const commentsRouter = Router();

const DB_PATH        = "/home/runner/workspace/comments.db";
const JSON_PATH      = "/home/runner/workspace/comments.json";
const TTS_API        = "http://127.0.0.1:8080/api/tts/generate";
const AUDIO_CACHE    = "/home/runner/workspace/tts_cache";

mkdirSync(AUDIO_CACHE, { recursive: true });

// ── Frases Semilla ────────────────────────────────────────────────────────────
//
//  El texto es la semilla. La semilla contiene implícitamente el audio.
//  Al darle play → la semilla se materializa en sonido.
//  Al terminar → vuelve a ser solo texto. No queda nada en ningún lado.
//  El audio no se guarda. No ocupa espacio. Solo existe mientras suena.
//
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
    console.log(`[Semilla] Migrados ${items.length} frases`);
  } catch (e) { console.error("[Semilla] Error migrando:", e); }
}

// ── GET /comments?cursor=<ts>&limit=<n> ──────────────────────────────────────
commentsRouter.get("/comments", (req, res) => {
  const limit  = Math.min(Number(req.query.limit ?? 50), 200);
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;

  const rows = cursor
    ? db.prepare("SELECT id, autor, texto, ts FROM comentarios WHERE ts < ? ORDER BY ts DESC LIMIT ?").all(cursor, limit)
    : db.prepare("SELECT id, autor, texto, ts FROM comentarios ORDER BY ts DESC LIMIT ?").all(limit);

  const nextCursor = rows.length === limit ? (rows[rows.length - 1] as { ts: number }).ts : null;
  res.json({ items: rows, nextCursor });
});

// ── GET /comments/:id/audio ───────────────────────────────────────────────────
// La semilla se materializa en audio la primera vez y queda guardada.
// Las siguientes veces se sirve directamente desde el caché sin regenerar.
commentsRouter.get("/comments/:id/audio", async (req, res) => {
  const id      = req.params.id;
  const voiceId = (req.query.voiceId as string | undefined) ?? "darwin";
  const record  = db.prepare("SELECT texto FROM comentarios WHERE id = ?").get(id) as
    { texto: string } | undefined;

  if (!record) { res.status(404).json({ error: "No encontrado" }); return; }

  // Nombre de archivo de caché: {id}_{voiceId}.{ext}
  // Buscamos primero .mp3 luego .wav para compatibilidad con ambos engines
  const cacheBase = path.join(AUDIO_CACHE, `${id}_${voiceId}`);
  const cacheMp3  = `${cacheBase}.mp3`;
  const cacheWav  = `${cacheBase}.wav`;

  if (existsSync(cacheMp3)) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("X-Seed", "CACHED");
    res.sendFile(cacheMp3);
    return;
  }
  if (existsSync(cacheWav)) {
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("X-Seed", "CACHED");
    res.sendFile(cacheWav);
    return;
  }

  try {
    const ttsRes = await fetch(TTS_API, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: record.texto, voiceId }),
    });
    if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`);
    const ct      = ttsRes.headers.get("content-type") ?? "audio/wav";
    const buf     = Buffer.from(await ttsRes.arrayBuffer());
    const isWav   = ct.includes("wav");
    const savePath = isWav ? cacheWav : cacheMp3;
    writeFileSync(savePath, buf);
    res.setHeader("Content-Type", ct);
    res.setHeader("X-Seed", "MATERIALIZED");
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
  res.status(201).json({ id, autor: autor.trim() || "Anónimo", texto: texto.trim() });
});

// ── DELETE /comments/:id ──────────────────────────────────────────────────────
commentsRouter.delete("/comments/:id", (req, res) => {
  db.prepare("DELETE FROM comentarios WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

export default commentsRouter;
