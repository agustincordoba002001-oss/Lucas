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
//
//  PROSODY FINGERPRINT — sistema único
//
//  Primera vez (genera una sola vez):
//    texto → TTS completo (~650ms) → audio
//    + WORLD extrae F0 + energía → comprime → ~400 bytes → guarda en BD
//
//  Siguientes veces (~200ms, no se regenera):
//    texto + huella → Piper + timbre Darwin + F0 guardada → audio
//
//  Storage: ~500-700 bytes por comentario (base64 en BD) ≈ < 1 GB para 1M frases.
//
commentsRouter.get("/comments/:id/audio", async (req, res) => {
  const id      = req.params.id;
  const voiceId = (req.query.voiceId as string | undefined) ?? "darwin";
  const record  = db.prepare("SELECT texto, audio_data FROM comentarios WHERE id = ?").get(id) as
    { texto: string; audio_data: string | null } | undefined;

  if (!record) { res.status(404).json({ error: "No encontrado" }); return; }

  type AudioMap = Record<string, { fingerprint?: string }>;
  let audioMap: AudioMap = {};
  try { audioMap = JSON.parse(record.audio_data ?? "{}"); } catch { audioMap = {}; }

  // ── Replay: reconstruir desde la huella prosódica (~200ms) ───────────────
  if (audioMap[voiceId]?.fingerprint) {
    try {
      const pfRes = await fetch(`${TTS_SERVICE}/prosody/synthesize`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          texto:           record.texto,
          fingerprint_b64: audioMap[voiceId].fingerprint,
        }),
      });
      if (!pfRes.ok) throw new Error(`Prosody synth error ${pfRes.status}`);
      const buf = Buffer.from(await pfRes.arrayBuffer());
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Seed", "FINGERPRINT");
      res.send(buf);
      return;
    } catch (e) {
      // Si falla la síntesis desde huella, caer al flujo normal
      console.warn("[PROSODY] Síntesis desde huella falló, regenerando:", (e as Error).message);
    }
  }

  // ── Primera vez: TTS completo → extraer huella → guardar en BD ───────────
  try {
    const ttsRes = await fetch(TTS_API, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: record.texto, voiceId }),
    });
    if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`);
    const ct  = ttsRes.headers.get("content-type") ?? "audio/wav";
    const buf = Buffer.from(await ttsRes.arrayBuffer());

    // Extraer huella prosódica en segundo plano (no bloquea la respuesta)
    const wavB64 = buf.toString("base64");
    fetch(`${TTS_SERVICE}/prosody/extract`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ wav_b64: wavB64 }),
    }).then(async (pfRes) => {
      if (!pfRes.ok) { console.warn("[PROSODY] Extract falló:", pfRes.status); return; }
      const { fingerprint_b64, compressed_bytes } = await pfRes.json() as
        { fingerprint_b64: string; compressed_bytes: number };
      audioMap[voiceId] = { fingerprint: fingerprint_b64 };
      db.prepare("UPDATE comentarios SET audio_data = ? WHERE id = ?")
        .run(JSON.stringify(audioMap), id);
      console.log(`[PROSODY] Huella guardada para ${id} — ${compressed_bytes} bytes (~${
        Math.round(fingerprint_b64.length / 1024 * 10) / 10} KB en BD)`);
    }).catch((e) => console.warn("[PROSODY] Error extrayendo huella:", e));

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
