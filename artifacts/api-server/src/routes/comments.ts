import { Router }      from "express";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "fs";
import { spawn }        from "child_process";

const commentsRouter = Router();

const DB_PATH   = "/home/runner/workspace/comments.db";
const JSON_PATH = "/home/runner/workspace/comments.json";
const TTS_API   = "http://127.0.0.1:8080/api/tts/generate";

const db = new DatabaseSync(DB_PATH);

// La semilla tiene: texto + audio_b64 (Opus comprimido → Base64 → TEXT)
// Opus voice: ~15 KB por frase vs ~160 KB de WAV → 10x más liviano
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

// ── Comprimir WAV → OGG Opus usando ffmpeg (en memoria, cero archivos) ────────
// Opus es el códec más eficiente para voz: 24 kbps = calidad perfecta, 15 KB/frase
function wavToOpus(wavBuf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-f", "wav", "-i", "pipe:0",        // entrada: WAV desde stdin
      "-c:a", "libopus",                   // códec Opus
      "-b:a", "24k",                       // 24 kbps — voz perfecta
      "-vbr", "on",                        // bitrate variable (más eficiente)
      "-compression_level", "10",          // máxima compresión
      "-application", "voip",              // optimizado para voz
      "-f", "ogg",                         // contenedor OGG
      "pipe:1",                            // salida: OGG a stdout
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    ff.stdout.on("data", (d: Buffer) => chunks.push(d));
    ff.stderr.on("data", () => {});        // ignorar logs de ffmpeg
    ff.on("close", code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg salió con código ${code}`));
    });
    ff.stdin.write(wavBuf);
    ff.stdin.end();
  });
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
//
//  SISTEMA SEEDAUDIO:
//  El audio vive en la semilla como texto (Base64 de Opus comprimido).
//  Primera vez → genera WAV → comprime a Opus (~15 KB) → Base64 → guarda como TEXT.
//  Siguientes veces → decodifica Base64 → devuelve Opus → suena al instante.
//  10x más liviano que WAV sin perder calidad de voz.
//
commentsRouter.get("/comments/:id/audio", async (req, res) => {
  const id      = req.params.id;
  const voiceId = (req.query.voiceId as string | undefined) ?? "darwin";
  const record  = db.prepare("SELECT texto, audio_b64 FROM comentarios WHERE id = ?").get(id) as
    { texto: string; audio_b64: string | null } | undefined;

  if (!record) { res.status(404).json({ error: "No encontrado" }); return; }

  // ── El audio ya vive en la semilla como texto → instante ─────────────────
  if (record.audio_b64) {
    const opusBuf = Buffer.from(record.audio_b64, "base64");
    res.setHeader("Content-Type", "audio/ogg; codecs=opus");
    res.setHeader("X-Seed", "HIT");
    res.setHeader("X-Format", "opus");
    res.send(opusBuf);
    return;
  }

  // ── Primera vez: genera WAV → comprime a Opus → guarda como texto ────────
  try {
    // 1. Generar WAV
    const ttsRes = await fetch(TTS_API, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: record.texto, voiceId }),
    });
    if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`);
    const wavBuf = Buffer.from(await ttsRes.arrayBuffer());

    // 2. Comprimir WAV → Opus (en memoria, cero archivos, cero disco)
    const opusBuf = await wavToOpus(wavBuf);

    // 3. Convertir a texto Base64 y guardar en la semilla para siempre
    const b64 = opusBuf.toString("base64");
    db.prepare("UPDATE comentarios SET audio_b64 = ? WHERE id = ?").run(b64, id);

    console.log(`[SeedAudio] ${id} — WAV ${(wavBuf.length/1024).toFixed(0)} KB → Opus ${(opusBuf.length/1024).toFixed(0)} KB (${Math.round(opusBuf.length/wavBuf.length*100)}% del original)`);

    res.setHeader("Content-Type", "audio/ogg; codecs=opus");
    res.setHeader("X-Seed", "MISS");
    res.setHeader("X-Format", "opus");
    res.send(opusBuf);
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
