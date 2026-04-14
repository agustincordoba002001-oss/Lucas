import { Router }      from "express";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "fs";

const commentsRouter = Router();

const DB_PATH   = "/home/runner/workspace/comments.db";
const JSON_PATH = "/home/runner/workspace/comments.json";
const TTS_API   = "http://127.0.0.1:8080/api/tts/generate";

// ── Frases Semilla ────────────────────────────────────────────────────────────
//
//  El texto es la semilla · vive como texto en la BD · 0 bytes de audio en disco.
//  Al darle play → la semilla se materializa en sonido (se genera una sola vez).
//  El audio queda guardado como texto (base64) dentro de la misma semilla.
//  Al terminar → vuelve a ser texto en pantalla. Nada binario en ningún lado.
//
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS comentarios (
    id         TEXT PRIMARY KEY,
    autor      TEXT NOT NULL,
    texto      TEXT NOT NULL,
    ts         INTEGER NOT NULL DEFAULT (unixepoch()),
    audio_data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ts ON comentarios(ts);
  PRAGMA journal_mode=WAL;
`);

// Migrar columna si la tabla ya existía sin audio_data
try {
  db.exec("ALTER TABLE comentarios ADD COLUMN audio_data TEXT");
} catch { /* columna ya existe */ }

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
// Primera vez: genera el audio y lo guarda como base64 dentro de la semilla.
// Siguientes veces: decodifica el texto guardado → audio. Sin regenerar nada.
commentsRouter.get("/comments/:id/audio", async (req, res) => {
  const id      = req.params.id;
  const voiceId = (req.query.voiceId as string | undefined) ?? "darwin";
  const record  = db.prepare("SELECT texto, audio_data FROM comentarios WHERE id = ?").get(id) as
    { texto: string; audio_data: string | null } | undefined;

  if (!record) { res.status(404).json({ error: "No encontrado" }); return; }

  // Intentar leer caché desde la BD (texto base64)
  type AudioMap = Record<string, { ct: string; b64: string }>;
  let audioMap: AudioMap = {};
  try { audioMap = JSON.parse(record.audio_data ?? "{}"); } catch { audioMap = {}; }

  if (audioMap[voiceId]) {
    const { ct, b64 } = audioMap[voiceId];
    const buf = Buffer.from(b64, "base64");
    res.setHeader("Content-Type", ct);
    res.setHeader("X-Seed", "CACHED");
    res.send(buf);
    return;
  }

  // Primera vez: materializar la semilla en audio y guardarlo como texto
  try {
    const ttsRes = await fetch(TTS_API, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: record.texto, voiceId }),
    });
    if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`);
    const ct  = ttsRes.headers.get("content-type") ?? "audio/wav";
    const buf = Buffer.from(await ttsRes.arrayBuffer());

    // Guardar como base64 (texto) en la BD — ningún archivo binario en disco
    audioMap[voiceId] = { ct, b64: buf.toString("base64") };
    db.prepare("UPDATE comentarios SET audio_data = ? WHERE id = ?")
      .run(JSON.stringify(audioMap), id);

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
