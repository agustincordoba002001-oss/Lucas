import { Router }      from "express";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "fs";

const commentsRouter = Router();

const DB_PATH        = "/home/runner/workspace/comments.db";
const JSON_PATH      = "/home/runner/workspace/comments.json";
const TTS_API        = "http://127.0.0.1:8080/api/tts/generate";
const TTS_SERVICE    = "http://127.0.0.1:5000";

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
    audio_data TEXT,
    photon_capsule TEXT,
    photon_bytes INTEGER,
    photon_mode TEXT,
    photon_encoding TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ts ON comentarios(ts);
  PRAGMA journal_mode=WAL;
`);

// Migrar columna si la tabla ya existía sin audio_data
try {
  db.exec("ALTER TABLE comentarios ADD COLUMN audio_data TEXT");
} catch { /* columna ya existe */ }
try {
  db.exec("ALTER TABLE comentarios ADD COLUMN photon_capsule TEXT");
} catch { /* columna ya existe */ }
try {
  db.exec("ALTER TABLE comentarios ADD COLUMN photon_bytes INTEGER");
} catch { /* columna ya existe */ }
try {
  db.exec("ALTER TABLE comentarios ADD COLUMN photon_mode TEXT");
} catch { /* columna ya existe */ }
try {
  db.exec("ALTER TABLE comentarios ADD COLUMN photon_encoding TEXT");
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
    ? db.prepare("SELECT id, autor, texto, ts, photon_capsule as photonCapsule, photon_bytes as photonBytes, photon_mode as photonMode, photon_encoding as photonEncoding FROM comentarios WHERE ts < ? ORDER BY ts DESC LIMIT ?").all(cursor, limit)
    : db.prepare("SELECT id, autor, texto, ts, photon_capsule as photonCapsule, photon_bytes as photonBytes, photon_mode as photonMode, photon_encoding as photonEncoding FROM comentarios ORDER BY ts DESC LIMIT ?").all(limit);

  const nextCursor = rows.length === limit ? (rows[rows.length - 1] as { ts: number }).ts : null;
  res.json({ items: rows, nextCursor });
});

// ── GET /comments/:id/audio ───────────────────────────────────────────────────
//
//  Primera vez → TTS completo (~650ms) → audio guardado como base64 en BD.
//  Siguientes veces → se lee directo de la BD → instantáneo (~5ms).
//  Misma voz, misma calidad, generado una sola vez para siempre.
//
commentsRouter.get("/comments/:id/audio", async (req, res) => {
  const id      = req.params.id;
  const voiceId = (req.query.voiceId as string | undefined) ?? "darwin";
  const record  = db.prepare("SELECT texto, audio_data, photon_capsule FROM comentarios WHERE id = ?").get(id) as
    { texto: string; audio_data: string | null; photon_capsule: string | null } | undefined;

  if (!record) { res.status(404).json({ error: "No encontrado" }); return; }

  type AudioMap = Record<string, { ct: string; b64: string }>;
  let audioMap: AudioMap = {};
  try { audioMap = JSON.parse(record.audio_data ?? "{}"); } catch { audioMap = {}; }

  const cacheKey = record.photon_capsule ? `photon:${voiceId}` : voiceId;

  // ── Replay: audio ya generado, servir directo desde la BD (~5ms) ─────────
  if (audioMap[cacheKey]?.b64) {
    const { ct, b64 } = audioMap[cacheKey];
    res.setHeader("Content-Type", ct);
    res.setHeader("X-Seed", record.photon_capsule ? "PHOTON-CACHED" : "CACHED");
    res.send(Buffer.from(b64, "base64"));
    return;
  }

  // ── Primera vez: generar y guardar para siempre ───────────────────────────
  try {
    const ttsRes = await fetch(TTS_API, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: record.texto, voiceId }),
    });
    if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`);
    const ct  = ttsRes.headers.get("content-type") ?? "audio/wav";
    const buf = Buffer.from(await ttsRes.arrayBuffer());

    audioMap[cacheKey] = { ct, b64: buf.toString("base64") };
    db.prepare("UPDATE comentarios SET audio_data = ? WHERE id = ?")
      .run(JSON.stringify(audioMap), id);

    res.setHeader("Content-Type", ct);
    res.setHeader("X-Seed", record.photon_capsule ? "PHOTON-MATERIALIZED" : "MATERIALIZED");
    res.send(buf);
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
});

// ── POST /comments ────────────────────────────────────────────────────────────
commentsRouter.post("/comments", (req, res) => {
  const { autor = "Anónimo", texto, photonCapsule, photonBytes, photonMode, photonEncoding } = req.body as {
    autor?: string;
    texto?: string;
    photonCapsule?: string;
    photonBytes?: number;
    photonMode?: string;
    photonEncoding?: string;
  };
  if (!texto?.trim()) { res.status(400).json({ error: "texto requerido" }); return; }
  if (!photonCapsule?.trim()) { res.status(400).json({ error: "cápsula Photon requerida" }); return; }
  const id = Date.now().toString();
  db.prepare("INSERT INTO comentarios (id, autor, texto, photon_capsule, photon_bytes, photon_mode, photon_encoding) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    (autor.trim() || "Anónimo"),
    texto.trim(),
    photonCapsule?.trim() || null,
    Number.isFinite(photonBytes) ? photonBytes : null,
    photonMode?.trim() || null,
    photonEncoding?.trim() || null,
  );
  res.status(201).json({
    id,
    autor: autor.trim() || "Anónimo",
    texto: texto.trim(),
    photonCapsule: photonCapsule?.trim() || null,
    photonBytes: Number.isFinite(photonBytes) ? photonBytes : null,
    photonMode: photonMode?.trim() || null,
    photonEncoding: photonEncoding?.trim() || null,
  });
});

// ── DELETE /comments/:id ──────────────────────────────────────────────────────
commentsRouter.delete("/comments/:id", (req, res) => {
  db.prepare("DELETE FROM comentarios WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

export default commentsRouter;
