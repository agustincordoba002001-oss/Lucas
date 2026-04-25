import { Router }               from "express";
import { spawn, ChildProcess } from "child_process";
import { randomUUID, createHash } from "crypto";
import { join }                from "path";
import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, utimesSync } from "fs";

const ttsRouter = Router();

const TTS_SERVICE        = process.env["TTS_SERVICE_URL"] ?? "http://127.0.0.1:5001";
const DIEVER_REF         = "/home/runner/workspace/diever_referencia.wav";
const NEXUS_REF          = "/home/runner/workspace/attached_assets/NEXUS_VOZ_OFFLINE_1776028665996.onnx";
const NEXUS_CONFIG       = "/home/runner/workspace/attached_assets/NEXUS_OFFLINE.onnx_1776029964832.json";
const NEXUS_ULTRA_REF    = NEXUS_REF;
const NEXUS_ULTRA_CONFIG = "/home/runner/workspace/attached_assets/NEXUS_ULTRA_FAST_1776036098561.json";
const NEXUS_PIPER_PATCH  = "nexus-piper-patch";
const DAEMON_SCRIPT      = "/home/runner/workspace/xtts_daemon.py";

// ── XTTS Daemon ───────────────────────────────────────────────────────────────
let daemon: ChildProcess | null = null;
let daemonReady                 = false;
let daemonBuf                   = Buffer.alloc(0);

type QueueItem = {
  texto: string;
  refAudio: string;
  extra?: Record<string, unknown>;
  resolve: (b: Buffer) => void;
  reject:  (e: Error)  => void;
};

const requestQueue: QueueItem[] = [];
let activePendingReq: { resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;

function processNextInQueue() {
  if (activePendingReq || !daemonReady || !daemon) return;
  const next = requestQueue.shift();
  if (!next) return;
  activePendingReq = { resolve: next.resolve, reject: next.reject };
  const payload: Record<string, unknown> = { texto: next.texto, ref_audio: next.refAudio, ...(next.extra || {}) };
  daemon!.stdin!.write(JSON.stringify(payload) + "\n");
}

function startDaemon() {
  console.log("[TTS] Iniciando daemon XTTS...");
  daemon = spawn("python3", [DAEMON_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });

  daemon.stderr!.on("data", (d: Buffer) => process.stdout.write("[XTTS] " + d.toString()));

  daemon.stdout!.on("data", (chunk: Buffer) => {
    daemonBuf = Buffer.concat([daemonBuf, chunk]);

    if (!daemonReady) {
      const nl = daemonBuf.indexOf(0x0a);
      if (nl !== -1) {
        const msg = daemonBuf.slice(0, nl).toString().trim();
        daemonBuf = daemonBuf.slice(nl + 1);
        if (msg === "READY") {
          daemonReady = true;
          console.log("[TTS] Daemon XTTS listo ✓");
          processNextInQueue();
        }
      }
      return;
    }

    while (true) {
      if (daemonBuf.length < 4) break;
      const len = daemonBuf.readUInt32BE(0);
      if (len === 0) {
        if (daemonBuf.length < 8) break;
        const msgLen = daemonBuf.readUInt32BE(4);
        if (daemonBuf.length < 8 + msgLen) break;
        const errMsg = daemonBuf.slice(8, 8 + msgLen).toString();
        daemonBuf = daemonBuf.slice(8 + msgLen);
        if (activePendingReq) { activePendingReq.reject(new Error(errMsg)); activePendingReq = null; }
      } else {
        if (daemonBuf.length < 4 + len) break;
        const audio = Buffer.from(daemonBuf.slice(4, 4 + len));
        daemonBuf = daemonBuf.slice(4 + len);
        if (activePendingReq) { activePendingReq.resolve(audio); activePendingReq = null; }
      }
      processNextInQueue();
    }
  });

  daemon.on("close", (code) => {
    console.log(`[TTS] Daemon terminó (code ${code}), reiniciando en 3s...`);
    daemonReady = false; daemon = null;
    if (activePendingReq) {
      activePendingReq.reject(new Error("Daemon reiniciando"));
      activePendingReq = null;
    }
    for (const item of requestQueue.splice(0)) {
      item.reject(new Error("Daemon reiniciando"));
    }
    setTimeout(startDaemon, 3000);
  });
}

function askDaemon(texto: string, refAudio: string, extra?: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!daemon || !daemonReady) {
      return reject(new Error("Daemon no disponible aún, intentá en unos segundos"));
    }
    requestQueue.push({ texto, refAudio, extra, resolve, reject });
    processNextInQueue();
  });
}

ttsRouter.post("/tts/clone-laugh", async (req, res) => {
  const {
    texto, ref_audio_gpt, ref_audio_spk,
    temperature = 0.7, top_k = 50, top_p = 0.85, repetition_penalty = 2.0,
    speed = 1.0, gpt_cond_len = 6, max_ref_length = 30,
  } = (req.body || {}) as Record<string, unknown>;
  if (typeof texto !== "string" || !texto.trim()) {
    res.status(400).json({ error: "texto requerido" }); return;
  }
  if (typeof ref_audio_gpt !== "string" || typeof ref_audio_spk !== "string") {
    res.status(400).json({ error: "ref_audio_gpt y ref_audio_spk requeridos" }); return;
  }
  try {
    const wav = await askDaemon(texto, "", {
      ref_audio_gpt, ref_audio_spk,
      temperature, top_k, top_p, repetition_penalty, speed,
      gpt_cond_len, max_ref_length,
    });
    res.setHeader("Content-Type", "audio/wav");
    res.send(wav);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// El daemon XTTS depende del paquete Coqui `TTS` (~varios GB) que no se instala
// por defecto para no consumir disco/créditos. Solo se arranca si está habilitado
// explícitamente con XTTS_DAEMON_ENABLED=1.
if (process.env["XTTS_DAEMON_ENABLED"] === "1") {
  startDaemon();
} else {
  console.log("[TTS] Daemon XTTS deshabilitado (define XTTS_DAEMON_ENABLED=1 para activarlo).");
}

// ── Voces ─────────────────────────────────────────────────────────────────────
const VOICES: Record<string, {
  name: string; voice?: string; pitch?: string; rate?: string;
  cloned?: boolean; piper?: string; piperPatch?: string; refAudio?: string; config?: string;
  edgeDarwin?: boolean;
}> = {
  "darwin":             { name: "Darwin ★",                               edgeDarwin: true },
  "darwin-xtts":        { name: "Darwin ★ (XTTS · alta calidad)",         cloned: true },
  "diever":             { name: "Diever Muñoz ★ (voz clonada)",           cloned: true },
  "nexus":              { name: "Nexus Offline Juan ★ (voz subida)",      cloned: true, refAudio: NEXUS_REF, config: NEXUS_CONFIG },
  "nexus-ultra":        { name: "Nexus Ultra Fast ★ (caché local)",       cloned: true, refAudio: NEXUS_ULTRA_REF, config: NEXUS_ULTRA_CONFIG },
  "nexus-piper-patch":  { name: "Nexus Piper Patch ★ (Piper + ADN)",      piperPatch: NEXUS_PIPER_PATCH },
  "lolo-piper-patch":   { name: "Lolo ★ (Piper + ADN voz clonada)",       piperPatch: "lolo-piper-patch" },
  "darwin-piper-patch": { name: "Darwin ★ (Piper + ADN voz clonada)",     piperPatch: "darwin-piper-patch" },
  "claude-mx":          { name: "Claude (México) · Piper",                piper: "claude-mx" },
  "daniela-ar":         { name: "Daniela (Argentina) · Piper",            piper: "daniela-ar" },
  "carlfm-es":          { name: "CarlFM (España) · Piper",                piper: "carlfm-es" },
  "davefx-es":          { name: "DaveFX (España) · Piper",                piper: "davefx-es" },
  "gonzalo-co":         { name: "Gonzalo (Colombia)", voice: "es-CO-GonzaloNeural", pitch: "-2Hz", rate: "-5%" },
  "jorge-mx":           { name: "Jorge (México)",     voice: "es-MX-JorgeNeural",   pitch: "-2Hz", rate: "-5%" },
  "alvaro-es":          { name: "Álvaro (España)",    voice: "es-ES-AlvaroNeural",  pitch: "-2Hz", rate: "-5%" },
  "tomas-ar":           { name: "Tomás (Argentina)",  voice: "es-AR-TomasNeural",   pitch: "-3Hz", rate: "-5%" },
  "mateo-uy":           { name: "Mateo (Uruguay)",    voice: "es-UY-MateoNeural",   pitch: "-2Hz", rate: "-8%" },
  "dalia-mx":           { name: "Dalia (México)",     voice: "es-MX-DaliaNeural",   pitch: "+0Hz", rate: "+0%" },
  "salome-co":          { name: "Salomé (Colombia)",  voice: "es-CO-SalomeNeural",  pitch: "+0Hz", rate: "+0%" },
  "elvira-es":          { name: "Elvira (España)",    voice: "es-ES-ElviraNeural",  pitch: "+0Hz", rate: "+0%" },
};

// ── GET /tts/voices ───────────────────────────────────────────────────────────
ttsRouter.get("/tts/voices", (_req, res) => {
  res.json({
    voices: Object.entries(VOICES).map(([id, v]) => ({
      id, name: v.name,
      cloned:      v.cloned ?? false,
      piper:       !!(v.piper || v.piperPatch),
      daemonReady: v.cloned ? daemonReady : undefined,
    })),
    daemonReady,
  });
});

// ── Etiquetas expresivas tipo Bark ────────────────────────────────────────────
//
//  El usuario escribe [risa], [suspiro], etc. y el motor las traduce a
//  vocalizaciones que el clonador XTTS puede pronunciar manteniendo el timbre.
//
const EXPRESSIVE_TAGS: Record<string, string[]> = {
  "risa": [
    "jajajaja",
    "ajajajaja",
    "jajajajaja",
    "jejejeje",
    "jajajajajaja",
  ],
  "risa-fuerte": [
    "JAJAJAJAJA",
    "AJAJAJAJAJA",
    "JAJAJAJAJAJA",
  ],
  "risita": [
    "jejeje",
    "jijijiji",
    "jejejeje",
  ],
  "carcajada": [
    "jajajajajajajaja",
    "ajajajajajajaja",
    "jajajajajajaja jajaja",
    "jejejejejeje jajajaja",
  ],
  "suspiro": [
    "aaaaah...",
    "aaay...",
    "uuuuh, ah...",
    "aaah, aah...",
  ],
  "suspiro-largo": [
    "aaaaaaaaaah...",
    "uuuuuuuuuf, aaaaah...",
    "aaaaaay, aaaaah...",
  ],
  "duda": [
    "eeeeeh...",
    "eeem...",
    "eh, este...",
    "eeeh, mmm...",
  ],
  "mmm": ["mmmmm.", "hmmm.", "mmm, mmm."],
  "ah":  ["ah!", "ah, ah!", "aaah!"],
  "uf":  ["uuuuf.", "uf, uf.", "uuuuuf!"],
  "carraspeo": ["ejem, ejem.", "ejem!", "ejem, ejem, ejem."],
  "asombro":   ["oooooh!", "oh, oh, oh!", "uooooh!"],
  "tos":       ["ejem! ejem!", "ejem, ejem, ejem!", "ejem, ¡ejem!"],
  "beso":      ["muá!", "muá, muá!", "mmmuá!"],
  "llanto":    ["buuuaaa, buuuaaa...", "uaaaa, uaaaa...", "buuu, buuu, aaa..."],
};

function pickVariation(tag: string): string | undefined {
  const variants = EXPRESSIVE_TAGS[tag];
  if (!variants || variants.length === 0) return undefined;
  return variants[Math.floor(Math.random() * variants.length)];
}

// ── Motor de risa clonada ─────────────────────────────────────────────────────
//
//  Cuando el texto contiene [risa], [risa-fuerte], [risita] o [carcajada]
//  pedimos a tts_service /laugh-clone que sintetice la risa CON LA VOZ
//  OBJETIVO. El servicio Python aplica "Laughter DNA Transfer": toma la
//  forma F0+aperiodicidad de una risa de referencia y la ejecuta con el
//  timbre del clon. El resultado se cachea por voz_id.
//
const LAUGH_CACHE: Record<string, Buffer> = {};

async function getClonedLaugh(voiceId: string): Promise<Buffer | null> {
  if (LAUGH_CACHE[voiceId]) return LAUGH_CACHE[voiceId];
  try {
    const upstream = await fetch(`${TTS_SERVICE}/laugh-clone`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ voice: voiceId }),
    });
    if (!upstream.ok) {
      console.warn(`[TTS] /laugh-clone para '${voiceId}' devolvió ${upstream.status}`);
      return null;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    LAUGH_CACHE[voiceId] = buf;
    console.log(`[TTS] Risa clonada cacheada para '${voiceId}' (${buf.length} bytes)`);
    return buf;
  } catch (e) {
    console.warn(`[TTS] Error pidiendo risa clonada: ${(e as Error).message}`);
    return null;
  }
}

type WavFmt = { sampleRate: number; channels: number; bitsPerSample: number; dataOffset: number };

function parseWavHeader(buf: Buffer): WavFmt | null {
  if (buf.length < 44 || buf.slice(0, 4).toString() !== "RIFF" || buf.slice(8, 12).toString() !== "WAVE") return null;
  let off = 12;
  let fmt: WavFmt | null = null;
  while (off + 8 <= buf.length) {
    const id   = buf.slice(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      fmt = {
        channels:       buf.readUInt16LE(off + 10),
        sampleRate:     buf.readUInt32LE(off + 12),
        bitsPerSample:  buf.readUInt16LE(off + 22),
        dataOffset:     0,
      };
    } else if (id === "data") {
      if (fmt) fmt.dataOffset = off + 8;
      return fmt;
    }
    off += 8 + size + (size % 2);
  }
  return fmt;
}

// Re-muestrea un WAV PCM_16 mono a otro sample rate (interpolación lineal,
// suficientemente buena para empalmar la risa con la voz).
function resampleWavToRate(wav: Buffer, targetRate: number): Buffer | null {
  const fmt = parseWavHeader(wav);
  if (!fmt || fmt.bitsPerSample !== 16 || fmt.channels !== 1) return null;
  if (fmt.sampleRate === targetRate) return wav;

  const pcm = wav.slice(fmt.dataOffset);
  const inSamples = pcm.length / 2;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  const ratio = fmt.sampleRate / targetRate;
  const outSamples = Math.floor(inSamples / ratio);
  const outPcm = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const src = i * ratio;
    const i0  = Math.floor(src);
    const i1  = Math.min(i0 + 1, inSamples - 1);
    const frac = src - i0;
    const s0 = view.getInt16(i0 * 2, true);
    const s1 = view.getInt16(i1 * 2, true);
    const v  = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)));
    outPcm.writeInt16LE(v, i * 2);
  }
  // Re-empaqueta como WAV con header del nuevo SR
  const byteRate   = targetRate * 2;
  const blockAlign = 2;
  const out = Buffer.alloc(44 + outPcm.length);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + outPcm.length, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(targetRate, 24);
  out.writeUInt32LE(byteRate, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(outPcm.length, 40);
  outPcm.copy(out, 44);
  return out;
}

// Segmentos: trozos de texto intercalados con marcas de risa
type Seg = { kind: "text"; value: string } | { kind: "laugh" };

function splitLaughSegments(text: string): Seg[] {
  const segs: Seg[] = [];
  const re = /\[(risa|risa-fuerte|risita|carcajada)\]/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index).trim();
    if (before) segs.push({ kind: "text", value: before });
    segs.push({ kind: "laugh" });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) segs.push({ kind: "text", value: tail });
  return segs;
}

function hasLaughTag(text: string): boolean {
  return /\[(risa|risa-fuerte|risita|carcajada)\]/i.test(text);
}

// Concatena buffers WAV potencialmente de distinto sample rate, re-muestreando
// las risas al formato del primer chunk de TTS para que pegue limpio.
function concatWavWithLaughs(parts: Buffer[]): Buffer {
  if (parts.length === 0) throw new Error("Sin buffers WAV");
  // Tomamos el formato del primer buffer "real" como referencia
  const refFmt = parseWavHeader(parts[0]);
  if (!refFmt) return concatWavBuffers(parts);

  const pcmParts: Buffer[] = [];
  for (const p of parts) {
    const fmt = parseWavHeader(p);
    if (!fmt) continue;
    pcmParts.push(p.slice(fmt.dataOffset));
  }
  const totalPcm = Buffer.concat(pcmParts);
  const byteRate   = refFmt.sampleRate * refFmt.channels * (refFmt.bitsPerSample / 8);
  const blockAlign = refFmt.channels * (refFmt.bitsPerSample / 8);
  const out = Buffer.alloc(44 + totalPcm.length);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + totalPcm.length, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(refFmt.channels, 22);
  out.writeUInt32LE(refFmt.sampleRate, 24);
  out.writeUInt32LE(byteRate, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(refFmt.bitsPerSample, 34);
  out.write("data", 36);
  out.writeUInt32LE(totalPcm.length, 40);
  totalPcm.copy(out, 44);
  return out;
}

function expandExpressiveTags(text: string): string {
  let out = text.replace(/\[pausa(?:=(\d+))?\]/gi, (_m, n) => {
    const dots = Math.max(1, Math.min(8, Number(n) || 2));
    return " " + ".".repeat(dots) + " ";
  });
  out = out.replace(/\[susurro\]([\s\S]*?)\[\/susurro\]/gi, (_m, inner: string) => `... ${inner.trim().toLowerCase()} ...`);
  out = out.replace(/\[([a-záéíóúüñ-]+)\]/gi, (full, tag: string) => {
    const v = pickVariation(tag.toLowerCase());
    return v !== undefined ? ` ${v} ` : full;
  });
  return out.replace(/\s+/g, " ").trim();
}

// ── Helpers para texto ilimitado ──────────────────────────────────────────────
const MAX_CHUNK_CHARS = 250;

function splitSentences(text: string): string[] {
  const raw = text.split(/(?<=[.!?;:])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const piece of raw) {
    const candidate = current ? `${current} ${piece}` : piece;
    if (candidate.length > MAX_CHUNK_CHARS) {
      if (current) chunks.push(current.trim());
      current = piece.length > MAX_CHUNK_CHARS ? piece.slice(0, MAX_CHUNK_CHARS) : piece;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function concatWavBuffers(bufs: Buffer[]): Buffer {
  if (bufs.length === 0) throw new Error("Sin buffers WAV");
  if (bufs.length === 1) return bufs[0];
  const hdr      = bufs[0].slice(0, 44);
  const pcmParts = bufs.map(b => b.slice(44));
  const totalPcm = Buffer.concat(pcmParts);
  const out      = Buffer.alloc(44 + totalPcm.length);
  hdr.copy(out, 0);
  out.writeUInt32LE(totalPcm.length + 36, 4);
  out.writeUInt32LE(totalPcm.length, 40);
  totalPcm.copy(out, 44);
  return out;
}

// ── POST /tts/generate ────────────────────────────────────────────────────────
// ── Cache de resultados PERSISTENTE en disco + dedupe de pedidos en vuelo ──
// Hace que pedir 2 veces el mismo audio sea instantáneo (incluso después de
// reiniciar el server) y que clicks dobles no encolen al daemon XTTS.
//
// Layout:  /home/runner/workspace/.tts_cache/<sha1(voiceId::texto)>.wav
const TTS_CACHE_DIR    = "/home/runner/workspace/.tts_cache";
const TTS_INFLIGHT     = new Map<string, Promise<Buffer>>();
const TTS_CACHE_LIMIT  = 500;   // archivos máx en disco

try { mkdirSync(TTS_CACHE_DIR, { recursive: true }); } catch {}

function ttsCacheKey(voiceId: string, texto: string): string {
  return `${voiceId}::${texto.trim()}`;
}

function ttsCacheFile(key: string): string {
  const h = createHash("sha1").update(key).digest("hex");
  return join(TTS_CACHE_DIR, `${h}.wav`);
}

function ttsCacheGet(key: string): Buffer | null {
  const f = ttsCacheFile(key);
  if (!existsSync(f)) return null;
  try {
    const buf = readFileSync(f);
    // Bump LRU: actualizá mtime para que no sea elegible para podar
    const now = new Date();
    try { utimesSync(f, now, now); } catch {}
    return buf;
  } catch { return null; }
}

function ttsCacheSet(key: string, buf: Buffer): void {
  const f = ttsCacheFile(key);
  try {
    writeFileSync(f, buf);
    pruneCacheIfNeeded();
  } catch (e) {
    console.error("[tts-cache] no se pudo escribir", f, (e as Error).message);
  }
}

function pruneCacheIfNeeded(): void {
  try {
    const files = readdirSync(TTS_CACHE_DIR)
      .filter(n => n.endsWith(".wav"))
      .map(n => {
        const p = join(TTS_CACHE_DIR, n);
        return { p, mtime: statSync(p).mtimeMs };
      });
    if (files.length <= TTS_CACHE_LIMIT) return;
    files.sort((a, b) => a.mtime - b.mtime); // más viejos primero
    const toDelete = files.length - TTS_CACHE_LIMIT;
    for (let i = 0; i < toDelete; i++) {
      try { unlinkSync(files[i].p); } catch {}
    }
  } catch {}
}

ttsRouter.post("/tts/generate", async (req, res) => {
  const { texto, voiceId = "gonzalo-co" } = req.body as { texto?: string; voiceId?: string };

  if (!texto || typeof texto !== "string" || texto.trim().length === 0) {
    res.status(400).json({ error: "El campo 'texto' es requerido" }); return;
  }

  const voz = VOICES[voiceId] ?? VOICES["gonzalo-co"];

  // 1) Cache hit instantáneo
  const cacheKey = ttsCacheKey(voiceId, texto);
  const cached = ttsCacheGet(cacheKey);
  if (cached) {
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("X-TTS-Cache", "HIT");
    res.send(cached);
    return;
  }
  // 2) Mismo pedido ya en curso → compartí la promesa (evita encolar el daemon)
  const inflight = TTS_INFLIGHT.get(cacheKey);
  if (inflight) {
    try {
      const audio = await inflight;
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-TTS-Cache", "JOINED");
      res.send(audio);
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
    return;
  }

  // Primero separamos por etiquetas de RISA real (sample del propio Lolo).
  // Cada segmento de texto se expande luego con el resto de etiquetas
  // expresivas ([suspiro], [duda], etc).
  const rawSegs = splitLaughSegments(texto.trim());
  const segs: Seg[] = rawSegs
    .map(s => s.kind === "text" ? { kind: "text" as const, value: expandExpressiveTags(s.value) } : s)
    .filter(s => s.kind === "laugh" || (s.kind === "text" && s.value.length > 0));

  if (segs.length === 0) { res.status(400).json({ error: "El texto quedó vacío luego de expandir etiquetas" }); return; }

  // Para los motores que NO inyectan risa real (Edge / Piper plano), usamos
  // la expansión clásica sobre el texto completo.
  const text = expandExpressiveTags(texto.trim());

  // Helper: genera audio de los segmentos. La risa la pide a tts_service
  // /laugh-clone (sintetizada con la voz objetivo, no audio de la fuente).
  // El sample rate de la risa se ajusta al de la voz para que pegue limpio.
  async function buildWavWithLaughs(genText: (chunk: string) => Promise<Buffer>): Promise<Buffer> {
    const parts: Buffer[] = [];
    let firstFmt: WavFmt | null = null;

    // Pedir la risa clonada en paralelo mientras se genera el TTS
    const laughPromise: Promise<Buffer | null> = segs.some(s => s.kind === "laugh")
      ? getClonedLaugh(voiceId)
      : Promise.resolve(null);

    for (const s of segs) {
      if (s.kind === "text") {
        const chunks = splitSentences(s.value);
        for (const c of chunks) {
          const audio = await genText(c);
          if (!firstFmt) firstFmt = parseWavHeader(audio);
          parts.push(audio);
        }
      } else {
        const laugh = await laughPromise;
        if (!laugh) continue;
        const targetRate = firstFmt?.sampleRate ?? 22050;
        const adapted = resampleWavToRate(laugh, targetRate) ?? laugh;
        parts.push(adapted);
      }
    }
    return concatWavWithLaughs(parts);
  }

  // ── XTTS clonado — 100% en memoria ────────────────────────────────────────
  if (voz.cloned) {
    const work = (async () =>
      buildWavWithLaughs(chunk => askDaemon(chunk, voz.refAudio ?? DIEVER_REF)))();
    TTS_INFLIGHT.set(cacheKey, work);
    try {
      const audio = await work;
      ttsCacheSet(cacheKey, audio);
      res.setHeader("Content-Type", "audio/wav");
      res.send(audio);
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    } finally {
      TTS_INFLIGHT.delete(cacheKey);
    }
    return;
  }

  // ── Piper Patch — 100% en memoria ─────────────────────────────────────────
  if (voz.piperPatch) {
    const work = (async () => buildWavWithLaughs(async (chunk) => {
      const upstream = await fetch(`${TTS_SERVICE}/piper-patch`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ texto: chunk, voice: voz.piperPatch }),
      });
      if (!upstream.ok) {
        const err = await upstream.json().catch(() => ({ error: "Error Piper Patch" })) as { error?: string };
        throw new Error(err.error || "Error Piper Patch");
      }
      return Buffer.from(await upstream.arrayBuffer());
    }))();
    TTS_INFLIGHT.set(cacheKey, work);
    try {
      const audio = await work;
      ttsCacheSet(cacheKey, audio);
      res.setHeader("Content-Type", "audio/wav");
      res.send(audio);
    } catch (e) {
      res.status(503).json({ error: `Error Piper Patch: ${(e as Error).message}` });
    } finally {
      TTS_INFLIGHT.delete(cacheKey);
    }
    return;
  }

  // ── Darwin: Edge rápido directo + upgrade XTTS en background (en memoria) ─
  if (voz.edgeDarwin) {
    // Lanzar XTTS en background sin disco
    let xttsPromise: Promise<Buffer> | null = null;
    if (daemonReady) {
      xttsPromise = (async () => {
        const chunks = splitSentences(text);
        const parts: Buffer[] = [];
        for (const chunk of chunks) {
          const audio = await askDaemon(chunk, DIEVER_REF);
          parts.push(audio);
        }
        return concatWavBuffers(parts);
      })();
    }

    try {
      const upstream = await fetch(`${TTS_SERVICE}/edge-darwin`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ texto: text }),
      });
      if (!upstream.ok) {
        const err = await upstream.json().catch(() => ({ error: "Error Edge Darwin" }));
        res.status(upstream.status).json(err); return;
      }
      const edgeBuf = Buffer.from(await upstream.arrayBuffer());

      // Si XTTS terminó antes que Edge (raro pero posible), devolver XTTS directo
      if (xttsPromise) {
        const xttsReady = await Promise.race([
          xttsPromise.then(b => b).catch(() => null),
          new Promise<null>(r => setTimeout(() => r(null), 0)),
        ]);
        if (xttsReady) {
          ttsCacheSet(cacheKey, xttsReady);
          res.setHeader("Content-Type", "audio/wav");
          res.setHeader("X-Cache", "HIT-XTTS");
          res.send(xttsReady);
          return;
        }
      }

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Darwin-Upgrading", xttsPromise ? "true" : "false");
      res.send(edgeBuf);

      // Cuando termine XTTS, guardalo en cache para que la próxima sea instantánea
      xttsPromise?.then((xttsBuf) => {
        if (xttsBuf) ttsCacheSet(cacheKey, xttsBuf);
      }).catch(() => {});
    } catch (e) {
      res.status(503).json({ error: `Error Edge Darwin: ${(e as Error).message}` });
    }
    return;
  }

  // ── Piper TTS — 100% en memoria ───────────────────────────────────────────
  if (voz.piper) {
    try {
      const upstream = await fetch(`${TTS_SERVICE}/piper`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ texto: text, voice: voz.piper }),
      });
      if (!upstream.ok) {
        const err = await upstream.json().catch(() => ({ error: "Error Piper" }));
        res.status(upstream.status).json(err); return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", "audio/wav");
      res.send(buf);
    } catch (e) {
      res.status(503).json({ error: `Error Piper: ${(e as Error).message}` });
    }
    return;
  }

  // ── Edge TTS — 100% en memoria ────────────────────────────────────────────
  try {
    const upstream = await fetch(`${TTS_SERVICE}/edge`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: text, voice: voz.voice, pitch: voz.pitch, rate: voz.rate }),
    });
    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({ error: "Error TTS" }));
      res.status(upstream.status).json(err); return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buf);
  } catch {
    const tmpFile = join("/tmp", `edge_${randomUUID()}.mp3`);
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("python3", [
          "/home/runner/workspace/tts_engine.py",
          text, voz.voice!, voz.pitch!, voz.rate!, tmpFile,
        ]);
        let stderr = "";
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
      });
      res.setHeader("Content-Type", "audio/mpeg");
      res.sendFile(tmpFile, (err) => {
        if (existsSync(tmpFile)) unlinkSync(tmpFile);
        if (err && !res.headersSent) res.status(500).json({ error: "Error enviando audio" });
      });
    } catch {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
      res.status(500).json({ error: "Error generando audio" });
    }
  }
});

export default ttsRouter;
