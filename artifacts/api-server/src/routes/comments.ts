import { Router }      from "express";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "fs";
import { spawn }       from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import ffmpeg from 'fluent-ffmpeg';

function wavToOpus(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    ffmpeg()
      .input(buffer)
      .inputFormat('wav')
      .outputFormat('opus')
      .outputOptions('-c:a libopus')
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject)
      .pipe()
      .on('data', (chunk: Buffer) => chunks.push(chunk));
  });
}

import {
  tokenizeIntelligent,
  groupIntoMicroPhrases,
  getMicroPhraseAudio,
  storeMicroPhraseAudio,
  generateTTSParams,
  updateLearningContext,
  getLearningStats,
  createLearningContext,
  type LearningContext,
  type MicroPhrase,
  type SemanticToken,
  type TTSParams,
} from "../lib/intelligent-nexus.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env["WORKSPACE_ROOT"] ?? join(__dirname, "../../../..");

const commentsRouter = Router();

const DB_PATH        = process.env["COMMENTS_DB_PATH"] ?? join(REPO_ROOT, "comments.db");
const JSON_PATH      = process.env["COMMENTS_JSON_PATH"] ?? join(REPO_ROOT, "comments.json");
const TTS_API        = process.env["TTS_API_URL"] ?? "http://127.0.0.1:5000/api/tts/generate";
const TTS_SERVICE    = process.env["TTS_SERVICE_URL"] ?? "http://127.0.0.1:5001";

type AudioMap = Record<string, { ct: string; b64: string }>;
type PhotonMemoryAudio = { ct: string; buf: Buffer; bytes: number; touched: number };

const PHOTON_MEMORY_LIMIT_BYTES = 50 * 1024 * 1024;
const photonMemoryCache = new Map<string, PhotonMemoryAudio>();
const photonWarmups = new Map<string, Promise<void>>();
let photonMemoryBytes = 0;

// ─── CONTEXTOS DE APRENDIZAJE INTELIGENTE ─────────────────────────────────
const voiceLearningContexts = new Map<string, LearningContext>();
const microphraseAudioCache = new Map<string, Map<string, MicroPhrase>>();

function getOrCreateLearningContext(voiceId: string): LearningContext {
  if (!voiceLearningContexts.has(voiceId)) {
    voiceLearningContexts.set(voiceId, createLearningContext(voiceId));
  }
  return voiceLearningContexts.get(voiceId)!;
}

function getOrCreateMicrophraseCache(voiceId: string): Map<string, MicroPhrase> {
  if (!microphraseAudioCache.has(voiceId)) {
    microphraseAudioCache.set(voiceId, new Map());
  }
  return microphraseAudioCache.get(voiceId)!;
}

function photonCacheKey(voiceId: string, photonCapsule: string | null, texto: string) {
  return photonCapsule ? `photon:${voiceId}:${photonCapsule}:${texto}` : voiceId;
}

function getPhotonMemoryCache(key: string): PhotonMemoryAudio | undefined {
  const hit = photonMemoryCache.get(key);
  if (hit) hit.touched = Date.now();
  return hit;
}

function setPhotonMemoryCache(key: string, ct: string, buf: Buffer) {
  const prev = photonMemoryCache.get(key);
  if (prev) photonMemoryBytes -= prev.bytes;
  photonMemoryCache.set(key, { ct, buf, bytes: buf.byteLength, touched: Date.now() });
  photonMemoryBytes += buf.byteLength;

  while (photonMemoryBytes > PHOTON_MEMORY_LIMIT_BYTES && photonMemoryCache.size > 0) {
    let oldestKey: string | null = null;
    let oldestTouched = Number.POSITIVE_INFINITY;
    for (const [candidateKey, value] of photonMemoryCache.entries()) {
      if (value.touched < oldestTouched) {
        oldestTouched = value.touched;
        oldestKey = candidateKey;
      }
    }
    if (!oldestKey) break;
    const oldest = photonMemoryCache.get(oldestKey);
    if (oldest) photonMemoryBytes -= oldest.bytes;
    photonMemoryCache.delete(oldestKey);
  }
}

async function generatePhotonAudioToMemory(cacheKey: string, texto: string, voiceId: string) {
  if (getPhotonMemoryCache(cacheKey)) return;
  if (photonWarmups.has(cacheKey)) return photonWarmups.get(cacheKey);

  const promise = (async () => {
    const ttsRes = await fetch(TTS_API, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto, voiceId }),
    });
    if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`);
    const ct  = ttsRes.headers.get("content-type") ?? "audio/wav";
    const buf = Buffer.from(await ttsRes.arrayBuffer());
    setPhotonMemoryCache(cacheKey, ct, buf);
  })();

  photonWarmups.set(cacheKey, promise);
  try {
    await promise;
  } finally {
    photonWarmups.delete(cacheKey);
  }
}

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
    photon_encoding TEXT,
    storage_mode TEXT
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
try {
  db.exec("ALTER TABLE comentarios ADD COLUMN storage_mode TEXT");
} catch { /* columna ya existe */ }
try {
  db.exec("ALTER TABLE comentarios ADD COLUMN word_seq TEXT");
} catch { /* columna ya existe */ }
try {
  db.exec("ALTER TABLE comentarios ADD COLUMN nexus_voice_id TEXT");
} catch { /* columna ya existe */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS voice_word_audio (
    voice_id   TEXT NOT NULL,
    word_norm  TEXT NOT NULL,
    audio      BLOB NOT NULL,
    bytes      INTEGER NOT NULL,
    ct         TEXT NOT NULL DEFAULT 'audio/wav',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (voice_id, word_norm)
  );
  
  CREATE TABLE IF NOT EXISTS voice_microphrases_intelligent (
    voice_id      TEXT NOT NULL,
    signature     TEXT NOT NULL,
    tokens_json   TEXT NOT NULL,
    audio         BLOB,
    bytes         INTEGER,
    learning_score REAL NOT NULL DEFAULT 0.5,
    usage_count   INTEGER NOT NULL DEFAULT 0,
    emotion       TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    last_used_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (voice_id, signature)
  );
`);


const NEXUS_VOICE_WHITELIST = new Set([
  "darwin-xtts", "diever", "nexus", "nexus-ultra",
  "nexus-piper-patch", "lolo-piper-patch", "darwin-piper-patch",
  "claude-mx", "daniela-ar", "carlfm-es", "davefx-es",
  "darwin",
  "gonzalo-co", "jorge-mx", "alvaro-es", "tomas-ar", "mateo-uy",
  "dalia-mx", "salome-co", "elvira-es",
]);

function normalizeWord(raw: string): string {
  return raw.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}'’-]+/gu, "");
}

const EXPRESSIVE_TAGS_LOCAL: Record<string, string> = {
  "risa":         "jajajajaja",
  "risa-fuerte":  "jajajajajaja",
  "risita":       "jejejeje",
  "carcajada":    "jajajajajajajaja",
  "suspiro":      "aaaaah",
  "suspiro-largo":"aaaaaaaaaah",
  "duda":         "eeeeeh",
  "mmm":          "mmmmm",
  "ah":           "ah",
  "uf":           "uuuuf",
  "carraspeo":    "ejem ejem",
  "asombro":      "oooooh",
  "tos":          "ejem ejem ejem",
  "beso":         "muá",
  "llanto":       "buuuaaa buuuaaa",
};

function expandExpressiveTagsLocal(text: string): string {
  return text.replace(/\[([a-záéíóúüñ-]+)\]/gi, (full, tag: string) => {
    const key = tag.toLowerCase();
    return EXPRESSIVE_TAGS_LOCAL[key] !== undefined ? ` ${EXPRESSIVE_TAGS_LOCAL[key]} ` : "";
  });
}

// === LEGACY: Solo palabras (deprecated, mantener para compatibilidad) ===
function splitWords(text: string): string[] {
  const expanded = expandExpressiveTagsLocal(text);
  const out: string[] = [];
  for (const piece of expanded.split(/\s+/)) {
    const norm = normalizeWord(piece);
    if (norm) out.push(norm);
  }
  return out;
}

// === INTELIGENTE: Análisis semántico profundo → microfrases ===
function splitIntoMicroPhrases(text: string, voiceId: string): MicroPhrase[] {
  const context = getOrCreateLearningContext(voiceId);
  const tokens = tokenizeIntelligent(text, voiceId, context);
  const microphrases = groupIntoMicroPhrases(tokens);
  updateLearningContext(voiceId, microphrases, context);
  return microphrases;
}

// === GENERAR AUDIO PARA MICROFRASE ===
async function generateMicroPhraseAudio(voiceId: string, mpData: any): Promise<MicroPhrase> {
  const tokens = mpData.tokens || [];
  const texto = tokens.map((t: any) => t.word).join(" ");
  
  // Generar parámetros TTS inteligentes
  const params = generateTTSParams({
    tokens: tokens.map((t: any) => ({
      word: t.word,
      lemma: t.word, // simplificado
      pos: "noun" as const,
      context: "",
      emotion: t.emotion || "neutral",
      prosody: [],
      position: "middle" as const,
      isQuestion: false,
      emphasisLevel: t.emphasisLevel || 0,
    })),
    audio: undefined,
    signature: mpData.signature,
    learningScore: 0.5,
    usageCount: 0,
  });

  // Llamar al TTS con parámetros inteligentes
  const ttsBody = {
    texto,
    voiceId,
    speed: params.speed || 1.0,      // 0.5-2.0
    pitch: params.pitch || 1.0,      // 0.5-2.0
    rate: `${Math.round((params.speed || 1) * 100)}%`,  // Edge TTS rate format
    emotion: params.emotion || "neutral",
    ...params,
  };
  
  const ttsRes = await fetch(TTS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ttsBody),
  });

  if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status} para microfrase`);
  
  const audio = Buffer.from(await ttsRes.arrayBuffer());
  
  return {
    tokens: tokens.map((t: any) => ({
      word: t.word,
      lemma: t.word,
      pos: "noun" as const,
      context: "",
      emotion: t.emotion || "neutral",
      prosody: [],
      position: "middle" as const,
      isQuestion: false,
      emphasisLevel: t.emphasisLevel || 0,
    })),
    audio,
    signature: mpData.signature,
    learningScore: 0.5,
    usageCount: 0,
  };
}

function concatWavBuffers(bufs: Buffer[]): Buffer {
  if (bufs.length === 0) throw new Error("Sin buffers WAV");
  if (bufs.length === 1) return bufs[0];
  const hdr      = bufs[0].slice(0, 44);
  const pcmParts = bufs.map((b) => b.slice(44));
  const totalPcm = Buffer.concat(pcmParts);
  const out      = Buffer.alloc(44 + totalPcm.length);
  hdr.copy(out, 0);
  out.writeUInt32LE(totalPcm.length + 36, 4);
  out.writeUInt32LE(totalPcm.length, 40);
  totalPcm.copy(out, 44);
  return out;
}

// === CONCATENACIÓN FLUIDA SIN CLICKS ===
// Versión mejorada: crossfade + suavización para leer "de corrido"
function concatWavBuffersFluid(bufs: Buffer[]): Buffer {
  if (bufs.length === 0) throw new Error("Sin buffers WAV");
  if (bufs.length === 1) return bufs[0];
  
  // Extraer PCM data
  const pcmParts = bufs.map((b) => b.slice(44));
  
  // Aplicar crossfade entre cada par de buffers (150ms @ 24kHz = 3600 samples - más suave)
  const CROSSFADE_SAMPLES = Math.floor(24000 * 0.15); // 150ms (aumentado de 50ms)
  const SAMPLE_SIZE = 2; // 16-bit = 2 bytes
  
  const result: Buffer[] = [];
  
  for (let i = 0; i < pcmParts.length; i++) {
    const part = pcmParts[i];
    
    if (i === 0) {
      // Primer buffer: agregar fade-in (3ms)
      const fadeInSamples = Math.floor(24000 * 0.003);
      const faded = applyFadeIn(part, fadeInSamples);
      result.push(faded);
    } else {
      // Buffer siguiente: crossfade con anterior
      const prev = result[result.length - 1];
      const crossfaded = applyCrossfade(prev, part, CROSSFADE_SAMPLES);
      result[result.length - 1] = crossfaded;
    }
  }
  
  // Agregar fade-out al final (5ms)
  const lastIdx = result.length - 1;
  const fadeOutSamples = Math.floor(24000 * 0.005);
  result[lastIdx] = applyFadeOut(result[lastIdx], fadeOutSamples);
  
  // Concatenar todo
  const totalPcm = Buffer.concat(result);
  const hdr = bufs[0].slice(0, 44);
  const out = Buffer.alloc(44 + totalPcm.length);
  hdr.copy(out, 0);
  out.writeUInt32LE(totalPcm.length + 36, 4);
  out.writeUInt32LE(totalPcm.length, 40);
  totalPcm.copy(out, 44);
  
  return out;
}

function applyFadeIn(buf: Buffer, samples: number): Buffer {
  const out = Buffer.from(buf);
  const SAMPLE_SIZE = 2;
  
  for (let i = 0; i < Math.min(samples, buf.length / SAMPLE_SIZE); i++) {
    const factor = i / samples;
    const offset = i * SAMPLE_SIZE;
    const sample = out.readInt16LE(offset);
    out.writeInt16LE(Math.floor(sample * factor), offset);
  }
  
  return out;
}

function applyFadeOut(buf: Buffer, samples: number): Buffer {
  const out = Buffer.from(buf);
  const SAMPLE_SIZE = 2;
  const totalSamples = buf.length / SAMPLE_SIZE;
  
  for (let i = Math.max(0, totalSamples - samples); i < totalSamples; i++) {
    const factor = (totalSamples - i) / samples;
    const offset = i * SAMPLE_SIZE;
    if (offset + SAMPLE_SIZE <= buf.length) {
      const sample = out.readInt16LE(offset);
      out.writeInt16LE(Math.floor(sample * factor), offset);
    }
  }
  
  return out;
}

function applyCrossfade(buf1: Buffer, buf2: Buffer, crossfadeSamples: number): Buffer {
  const SAMPLE_SIZE = 2;
  const samples1 = buf1.length / SAMPLE_SIZE;
  const samples2 = buf2.length / SAMPLE_SIZE;
  
  // Tomar últimos N samples de buf1 y primeros N de buf2
  const fadeStart1 = Math.max(0, samples1 - crossfadeSamples);
  const fadeStart2 = 0;
  const fadeEnd2 = Math.min(crossfadeSamples, samples2);
  
  // Crear buffer de fadein/fadeout
  const faded = Buffer.alloc(buf1.length + buf2.length - (crossfadeSamples * SAMPLE_SIZE));
  
  // Copiar todo buf1 excepto el final
  buf1.copy(faded, 0, 0, fadeStart1 * SAMPLE_SIZE);
  
  // Aplicar crossfade en la zona de overlap
  let offset = fadeStart1 * SAMPLE_SIZE;
  for (let i = 0; i < crossfadeSamples && fadeStart1 + i < samples1 && fadeStart2 + i < samples2; i++) {
    const factor1 = (crossfadeSamples - i) / crossfadeSamples;
    const factor2 = i / crossfadeSamples;
    
    const sample1 = buf1.readInt16LE((fadeStart1 + i) * SAMPLE_SIZE) * factor1;
    const sample2 = buf2.readInt16LE((fadeStart2 + i) * SAMPLE_SIZE) * factor2;
    const mixed = Math.floor(sample1 + sample2);
    const clamped = Math.max(-32768, Math.min(32767, mixed));
    
    faded.writeInt16LE(clamped, offset);
    offset += SAMPLE_SIZE;
  }
  
  // Copiar resto de buf2
  if (fadeEnd2 * SAMPLE_SIZE < buf2.length) {
    buf2.copy(faded, offset, fadeEnd2 * SAMPLE_SIZE);
  }
  
  return faded;
}

function transcodeToWav(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "wav", "-acodec", "pcm_s16le", "-ar", "24000", "-ac", "1",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    const errs:   Buffer[] = [];
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (c) => errs.push(c));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg salió ${code}: ${Buffer.concat(errs).toString()}`));
    });
    ff.stdin.end(input);
  });
}

async function ensureWordInDict(voiceId: string, wordNorm: string, opts?: { maxRetries?: number; retryDelayMs?: number }): Promise<{ added: boolean; bytes: number }> {
  const existing = db.prepare("SELECT bytes FROM voice_word_audio WHERE voice_id = ? AND word_norm = ?").get(voiceId, wordNorm) as { bytes: number } | undefined;
  if (existing) return { added: false, bytes: existing.bytes };

  const maxRetries   = opts?.maxRetries   ?? 4;
  const retryDelayMs = opts?.retryDelayMs ?? 800;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const ttsRes = await fetch(TTS_API, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ texto: wordNorm, voiceId }),
      });
      if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status} para palabra "${wordNorm}"`);
      const ct  = ttsRes.headers.get("content-type") ?? "audio/wav";
      let buf   = Buffer.from(await ttsRes.arrayBuffer());

      // El diccionario sólo concatena WAV. Si la voz devuelve MP3 (Edge TTS),
      // lo transcodificamos a WAV PCM 24kHz mono para poder pegarlo después.
      if (!ct.includes("wav")) {
        buf = await transcodeToWav(buf);
      }

      db.prepare("INSERT OR IGNORE INTO voice_word_audio (voice_id, word_norm, audio, bytes, ct) VALUES (?, ?, ?, ?, ?)")
        .run(voiceId, wordNorm, buf, buf.byteLength, "audio/wav");
      return { added: true, bytes: buf.byteLength };
    } catch (e) {
      lastErr = e as Error;
      if (attempt < maxRetries) {
        const wait = retryDelayMs * Math.pow(1.6, attempt);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr ?? new Error(`No se pudo poblar la palabra "${wordNorm}"`);
}

// Población en background del diccionario para un comentario nexus-decreciente.
// El comentario ya está en la BD: si una palabra falla, simplemente queda vacía
// y se repuebla on-demand en GET /comments/:id/audio.
type NexusPopState = { promise: Promise<void>; total: number; done: number; failed: number };
const nexusPopulations = new Map<string, NexusPopState>();

function startNexusPopulation(commentId: string, voiceId: string, microphraseSignatures: string[]): NexusPopState {
  const existing = nexusPopulations.get(commentId);
  if (existing) return existing;

  const state: NexusPopState = {
    total: microphraseSignatures.length, done: 0, failed: 0,
    promise: Promise.resolve(),
  };

  state.promise = (async () => {
    for (const signature of microphraseSignatures) {
      try {
        // Buscar la microfrase en la secuencia del comentario
        const commentRow = db.prepare("SELECT word_seq FROM comentarios WHERE id = ?").get(commentId) as { word_seq: string | null } | undefined;
        if (!commentRow?.word_seq) continue;
        
        const microphraseSeq = JSON.parse(commentRow.word_seq);
        const mpData = microphraseSeq.find((mp: any) => mp.signature === signature);
        if (!mpData) continue;
        
        // Generar y almacenar la microfrase
        const microphrase = await generateMicroPhraseAudio(voiceId, mpData);
        storeMicroPhraseAudio(microphrase, microphrase.audio!, getOrCreateMicrophraseCache(voiceId));
        
        // Guardar en BD
        db.prepare("INSERT OR REPLACE INTO voice_microphrases_intelligent (voice_id, signature, tokens_json, audio, bytes, learning_score, usage_count, emotion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(voiceId, signature, JSON.stringify(mpData.tokens), microphrase.audio, microphrase.audio!.byteLength, microphrase.learningScore, microphrase.usageCount, mpData.tokens[0]?.emotion || "neutral");
        
        state.done++;
      } catch (e) {
        state.failed++;
        console.warn(`[NexusPop ${commentId}] microfrase "${signature}" falló:`, (e as Error).message);
      }
    }
  })().finally(() => {
    setTimeout(() => nexusPopulations.delete(commentId), 60_000);
  });

  nexusPopulations.set(commentId, state);
  return state;
}

commentsRouter.get("/voice-dict/stats", (req, res) => {
  const voiceId = (req.query.voiceId as string | undefined)?.trim();
  if (voiceId) {
    const row = db.prepare("SELECT COUNT(*) AS words, COALESCE(SUM(bytes),0) AS bytes FROM voice_word_audio WHERE voice_id = ?").get(voiceId) as { words: number; bytes: number };
    res.json({ voiceId, words: row.words, bytes: row.bytes });
    return;
  }
  const rows = db.prepare("SELECT voice_id AS voiceId, COUNT(*) AS words, COALESCE(SUM(bytes),0) AS bytes FROM voice_word_audio GROUP BY voice_id").all() as { voiceId: string; words: number; bytes: number }[];
  const total = db.prepare("SELECT COUNT(*) AS words, COALESCE(SUM(bytes),0) AS bytes FROM voice_word_audio").get() as { words: number; bytes: number };
  res.json({ perVoice: rows, total });
});

// ── GET /voice-learning-stats ────────────────────────────────────────────────
// Estadísticas del motor inteligente Nexus v2
commentsRouter.get("/voice-learning-stats", (req, res) => {
  const voiceId = (req.query.voiceId as string | undefined)?.trim();
  try {
    if (voiceId) {
      const context = getOrCreateLearningContext(voiceId);
      const stats = getLearningStats(context);
      res.json({
        voiceId,
        ...stats,
        engine: "nexus-v2-intelligent",
      });
      return;
    }
    
    // Stats para todas las voces
    const allStats: Record<string, object> = {};
    for (const [vid, context] of voiceLearningContexts.entries()) {
      allStats[vid] = getLearningStats(context);
    }
    
    res.json({ allVoices: allStats, engine: "nexus-v2-intelligent" });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

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
    ? db.prepare("SELECT id, autor, texto, ts, photon_capsule as photonCapsule, photon_bytes as photonBytes, photon_mode as photonMode, photon_encoding as photonEncoding, storage_mode as storageMode FROM comentarios WHERE ts < ? ORDER BY ts DESC LIMIT ?").all(cursor, limit)
    : db.prepare("SELECT id, autor, texto, ts, photon_capsule as photonCapsule, photon_bytes as photonBytes, photon_mode as photonMode, photon_encoding as photonEncoding, storage_mode as storageMode FROM comentarios ORDER BY ts DESC LIMIT ?").all(limit);

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
  const record  = db.prepare("SELECT texto, audio_data, photon_capsule, storage_mode FROM comentarios WHERE id = ?").get(id) as
    { texto: string; audio_data: string | null; photon_capsule: string | null; storage_mode: string | null } | undefined;

  if (!record) { res.status(404).json({ error: "No encontrado" }); return; }

  const isPhoton = !!record.photon_capsule;
  const isPhotonLight = isPhoton && record.storage_mode === "photon-light";
  const isNexusDecreciente = record.storage_mode === "nexus-decreciente";
  const cacheKey = photonCacheKey(voiceId, record.photon_capsule, record.texto);

  if (isNexusDecreciente) {
    const fullRow = db.prepare("SELECT word_seq, nexus_voice_id FROM comentarios WHERE id = ?").get(id) as { word_seq: string | null; nexus_voice_id: string | null } | undefined;
    const dictVoice = fullRow?.nexus_voice_id || voiceId;
    let microphraseSeq: any[] = [];
    try { microphraseSeq = JSON.parse(fullRow?.word_seq ?? "[]"); } catch { microphraseSeq = []; }
    if (microphraseSeq.length === 0) { res.status(404).json({ error: "Sin microfrases en la secuencia" }); return; }

    // Si la población background sigue corriendo, esperá a que termine antes
    // de armar el audio para evitar microfrases faltantes en el primer play.
    const pop = nexusPopulations.get(id);
    if (pop) {
      try { await pop.promise; } catch { /* fail-soft, intentamos servir igual */ }
    }

    try {
      const buffers: Buffer[] = [];
      for (const mpData of microphraseSeq) {
        const signature = mpData.signature;
        let row = db.prepare("SELECT audio FROM voice_microphrases_intelligent WHERE voice_id = ? AND signature = ?").get(dictVoice, signature) as { audio: Buffer } | undefined;
        if (!row) {
          // Generar microfrase on-demand
          try {
            const microphrase = await generateMicroPhraseAudio(dictVoice, mpData);
            if (microphrase.audio) {
              storeMicroPhraseAudio(microphrase, microphrase.audio, getOrCreateMicrophraseCache(dictVoice));
              row = { audio: microphrase.audio };
            }
          } catch (err) {
            console.warn(`[NexusPlay] microfrase "${signature}" falló:`, (err as Error).message);
          }
        }
        if (row?.audio) buffers.push(Buffer.from(row.audio));
      }
      if (buffers.length === 0) { res.status(503).json({ error: "No se pudo armar el audio (diccionario vacío, intentá de nuevo en unos segundos)" }); return; }
      const audio = concatWavBuffersFluid(buffers); // ← FLUIDO PARA LEER DE CORRIDO
      const opusAudio = await wavToOpus(audio);
      res.setHeader("Content-Type", "audio/opus");
      res.setHeader("X-Seed", "NEXUS-DECRECIENTE");
      res.setHeader("X-Nexus-Microphrases", microphraseSeq.length.toString());
      res.setHeader("X-Nexus-Microphrases-Used", buffers.length.toString());
      res.setHeader("X-Nexus-Voice", dictVoice);
      res.send(opusAudio);
      return;
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
      return;
    }
  }

  if (isPhotonLight) {
    const hit = getPhotonMemoryCache(cacheKey);
    if (hit) {
      res.setHeader("Content-Type", hit.ct);
      res.setHeader("X-Seed", "PHOTON-LIGHT-MEMORY");
      res.setHeader("X-Photon-Bytes", Buffer.byteLength(record.photon_capsule ?? "", "utf8").toString());
      res.send(hit.buf);
      return;
    }
    const pending = photonWarmups.get(cacheKey);
    if (pending) {
      await pending.catch(() => {});
      const warmed = getPhotonMemoryCache(cacheKey);
      if (warmed) {
        res.setHeader("Content-Type", warmed.ct);
        res.setHeader("X-Seed", "PHOTON-LIGHT-WARMED");
        res.setHeader("X-Photon-Bytes", Buffer.byteLength(record.photon_capsule ?? "", "utf8").toString());
        res.send(warmed.buf);
        return;
      }
    }
  }

  let audioMap: AudioMap = {};
  try { audioMap = JSON.parse(record.audio_data ?? "{}"); } catch { audioMap = {}; }

  // ── Replay: audio ya generado, servir directo desde la BD (~5ms) ─────────
  if (!isPhotonLight && audioMap[cacheKey]?.b64) {
    const { ct, b64 } = audioMap[cacheKey];
    res.setHeader("Content-Type", ct);
    res.setHeader("X-Seed", isPhoton ? "PHOTON-CACHED" : "CACHED");
    if (isPhoton) res.setHeader("X-Photon-Bytes", Buffer.byteLength(record.photon_capsule ?? "", "utf8").toString());
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

    if (isPhotonLight) {
      setPhotonMemoryCache(cacheKey, ct, buf);
    } else {
      audioMap[cacheKey] = { ct, b64: buf.toString("base64") };
      db.prepare("UPDATE comentarios SET audio_data = ? WHERE id = ?")
        .run(JSON.stringify(audioMap), id);
    }

    res.setHeader("Content-Type", ct);
    res.setHeader("X-Seed", isPhotonLight ? "PHOTON-LIGHT-REGENERATED" : isPhoton ? "PHOTON-MATERIALIZED" : "MATERIALIZED");
    if (isPhoton) res.setHeader("X-Photon-Bytes", Buffer.byteLength(record.photon_capsule ?? "", "utf8").toString());
    res.send(buf);
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
});

commentsRouter.post("/comments/warm", async (req, res) => {
  const { ids, voiceId = "darwin" } = req.body as { ids?: string[]; voiceId?: string };
  const cleanIds = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id.trim()).slice(0, 10) : [];
  if (cleanIds.length === 0) { res.json({ warmed: 0, queued: 0 }); return; }

  const rows = cleanIds.map((id) => db.prepare("SELECT id, texto, photon_capsule FROM comentarios WHERE id = ? AND storage_mode = 'photon-light'").get(id) as
    { id: string; texto: string; photon_capsule: string | null } | undefined).filter(Boolean) as
    { id: string; texto: string; photon_capsule: string | null }[];

  let alreadyWarm = 0;
  let queued = 0;
  for (const row of rows) {
    const cacheKey = photonCacheKey(voiceId, row.photon_capsule, row.texto);
    if (getPhotonMemoryCache(cacheKey)) {
      alreadyWarm++;
      continue;
    }
    if (!photonWarmups.has(cacheKey)) {
      queued++;
      generatePhotonAudioToMemory(cacheKey, row.texto, voiceId).catch((e) => {
        console.error("[PhotonWarm] Error:", e);
      });
    }
  }

  res.json({ warmed: alreadyWarm, queued });
});

// ── POST /comments ────────────────────────────────────────────────────────────
commentsRouter.post("/comments", async (req, res) => {
  const { autor = "Anónimo", texto, photonCapsule, photonBytes, photonMode, photonEncoding, storageMode = "photon-permanent", voiceId = "darwin", audioData } = req.body as {
    autor?: string;
    texto?: string;
    photonCapsule?: string;
    photonBytes?: number;
    photonMode?: string;
    photonEncoding?: string;
    storageMode?: string;
    voiceId?: string;
    audioData?: { ct?: string; b64?: string };
  };
  if (!texto?.trim()) { res.status(400).json({ error: "texto requerido" }); return; }
  if (!photonCapsule?.trim()) { res.status(400).json({ error: "cápsula Photon requerida" }); return; }
  const id = Date.now().toString();
  let initialAudioData: string | null = null;
  let safeStorageMode: "photon-light" | "photon-permanent" | "nexus-decreciente";
  if (storageMode === "photon-light") safeStorageMode = "photon-light";
  else if (storageMode === "nexus-decreciente") safeStorageMode = "nexus-decreciente";
  else safeStorageMode = "photon-permanent";

  let wordSeqJson: string | null = null;
  let nexusVoiceId: string | null = null;
  let nexusStats: { wordsTotal: number; wordsNew: number; dictBytesAdded: number } | null = null;

  let nexusWordsToPopulate: string[] | null = null;
  if (safeStorageMode === "nexus-decreciente") {
    const dictVoice = NEXUS_VOICE_WHITELIST.has(voiceId) ? voiceId : "darwin-xtts";
    // === USAR ANÁLISIS INTELIGENTE ===
    const microphrases = splitIntoMicroPhrases(texto.trim(), dictVoice);
    const words = microphrases.flatMap(mp => mp.tokens.map(t => t.word));
    if (words.length === 0) { res.status(400).json({ error: "texto sin palabras válidas" }); return; }

    // Guardar secuencia de microfrases, no solo palabras
    const microphraseSeq = microphrases.map(mp => ({
      signature: mp.signature,
      tokens: mp.tokens.map(t => ({ word: t.word, emotion: t.emotion, emphasisLevel: t.emphasisLevel }))
    }));
    wordSeqJson = JSON.stringify(microphraseSeq);

    // Solo nos preocupan las microfrases que aún no están en el diccionario
    const missing: string[] = [];
    for (const mp of microphrases) {
      const row = db.prepare("SELECT 1 FROM voice_microphrases_intelligent WHERE voice_id = ? AND signature = ?").get(dictVoice, mp.signature);
      if (!row) missing.push(mp.signature);
    }

    nexusVoiceId = dictVoice;
    nexusWordsToPopulate = missing; // Ahora son signatures de microfrases
    nexusStats = { wordsTotal: words.length, wordsNew: missing.length, dictBytesAdded: 0 };
  }

  if (safeStorageMode === "photon-permanent" && audioData?.b64?.trim()) {
    const safeVoiceId = typeof voiceId === "string" && voiceId.trim() ? voiceId.trim() : "darwin";
    const safeCt = audioData.ct?.trim() || "audio/wav";
    const cacheKey = photonCacheKey(safeVoiceId, photonCapsule.trim(), texto.trim());
    initialAudioData = JSON.stringify({ [cacheKey]: { ct: safeCt, b64: audioData.b64.trim() } });
  }

  db.prepare("INSERT INTO comentarios (id, autor, texto, audio_data, photon_capsule, photon_bytes, photon_mode, photon_encoding, storage_mode, word_seq, nexus_voice_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    (autor.trim() || "Anónimo"),
    texto.trim(),
    initialAudioData,
    (photonCapsule?.trim() || null) as string | null,
    Number.isFinite(photonBytes) ? photonBytes : null,
    (photonMode?.trim() || null) as string | null,
    (photonEncoding?.trim() || null) as string | null,
    safeStorageMode,
    wordSeqJson,
    nexusVoiceId,
  );

  // Disparar la población del diccionario en background. El comentario YA está
  // en la BD, así que el frontend lo ve aparecer al instante. Si el play llega
  // antes de que termine, GET /comments/:id/audio espera la promesa.
  if (safeStorageMode === "nexus-decreciente" && nexusVoiceId && nexusWordsToPopulate && nexusWordsToPopulate.length > 0) {
    startNexusPopulation(id, nexusVoiceId, nexusWordsToPopulate);
  }

  res.status(201).json({
    id,
    autor: autor.trim() || "Anónimo",
    texto: texto.trim(),
    photonCapsule: photonCapsule?.trim() || null,
    photonBytes: Number.isFinite(photonBytes) ? photonBytes : null,
    photonMode: photonMode?.trim() || null,
    photonEncoding: photonEncoding?.trim() || null,
    storageMode: safeStorageMode,
    nexusVoiceId,
    nexus: nexusStats,
  });
});

// ── DELETE /comments/:id ──────────────────────────────────────────────────────
commentsRouter.delete("/comments/:id", (req, res) => {
  db.prepare("DELETE FROM comentarios WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

export default commentsRouter;
