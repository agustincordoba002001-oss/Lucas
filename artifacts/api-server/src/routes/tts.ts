import { Router }                  from "express";
import { spawn, ChildProcess }    from "child_process";
import { randomUUID, createHash } from "crypto";
import { join }                   from "path";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { Response }          from "express";

const ttsRouter = Router();

const TTS_SERVICE   = "http://127.0.0.1:5000";
const DIEVER_REF    = "/home/runner/workspace/diever_referencia.wav";
const DAEMON_SCRIPT = "/home/runner/workspace/xtts_daemon.py";
const SAMPLE_RATE   = 24000;

// ── Caché en disco ────────────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/tts_cache";
mkdirSync(CACHE_DIR, { recursive: true });

function cacheKey(texto: string, voiceId: string) {
  return createHash("sha1").update(`${voiceId}::${texto}`).digest("hex");
}
function cacheGet(key: string): Buffer | null {
  const p = join(CACHE_DIR, `${key}.wav`);
  return existsSync(p) ? readFileSync(p) : null;
}
function cacheSet(key: string, data: Buffer) {
  writeFileSync(join(CACHE_DIR, `${key}.wav`), data);
}

// ── WAV streaming header (tamaño desconocido) ─────────────────────────────────
function makeWavHeader(dataSize = 0xffffffff): Buffer {
  const channels = 1, bits = 16;
  const byteRate = SAMPLE_RATE * channels * bits / 8;
  const blockAlign = channels * bits / 8;
  const riffSize = dataSize === 0xffffffff ? 0xffffffff : 36 + dataSize;
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);          buf.writeUInt32LE(riffSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);         buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);      buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28); buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36);         buf.writeUInt32LE(dataSize, 40);
  return buf;
}

// ── XTTS Daemon ───────────────────────────────────────────────────────────────
let daemon: ChildProcess | null = null;
let daemonReady                 = false;
let daemonBuf                   = Buffer.alloc(0);

// Requests pendientes
type FullReq    = { resolve: (b: Buffer) => void; reject: (e: Error) => void };
type StreamReq  = { onChunk: (b: Buffer) => void; onEnd: () => void; onError: (e: Error) => void };
let pendingFull:   FullReq   | null = null;
let pendingStream: StreamReq | null = null;
let isStreaming = false;

function startDaemon() {
  console.log("[TTS] Iniciando daemon XTTS...");
  daemon = spawn("python3", [DAEMON_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });

  daemon.stderr!.on("data", (d: Buffer) => process.stdout.write("[XTTS] " + d.toString()));

  daemon.stdout!.on("data", (chunk: Buffer) => {
    daemonBuf = Buffer.concat([daemonBuf, chunk]);

    // Primera línea: señal READY
    if (!daemonReady) {
      const nl = daemonBuf.indexOf(0x0a);
      if (nl !== -1) {
        const msg = daemonBuf.slice(0, nl).toString().trim();
        daemonBuf = daemonBuf.slice(nl + 1);
        if (msg === "READY") { daemonReady = true; console.log("[TTS] Daemon XTTS listo ✓"); }
      }
      return;
    }

    // Protocolo binario
    while (true) {
      if (daemonBuf.length < 4) break;
      const len = daemonBuf.readUInt32BE(0);

      if (len === 0xFFFFFFFE) {
        // Fin de stream
        daemonBuf = daemonBuf.slice(4);
        isStreaming = false;
        if (pendingStream) { pendingStream.onEnd(); pendingStream = null; }

      } else if (len === 0) {
        // Error: [0][msglen][msg]
        if (daemonBuf.length < 8) break;
        const msgLen = daemonBuf.readUInt32BE(4);
        if (daemonBuf.length < 8 + msgLen) break;
        const errMsg = daemonBuf.slice(8, 8 + msgLen).toString();
        daemonBuf = daemonBuf.slice(8 + msgLen);
        isStreaming = false;
        if (pendingStream) { pendingStream.onError(new Error(errMsg)); pendingStream = null; }
        if (pendingFull)   { pendingFull.reject(new Error(errMsg));    pendingFull = null; }

      } else {
        // Datos: [len][bytes]
        if (daemonBuf.length < 4 + len) break;
        const data = Buffer.from(daemonBuf.slice(4, 4 + len));
        daemonBuf  = daemonBuf.slice(4 + len);
        if (isStreaming && pendingStream) {
          pendingStream.onChunk(data);
        } else if (!isStreaming && pendingFull) {
          pendingFull.resolve(data);
          pendingFull = null;
        }
      }
    }
  });

  daemon.on("close", (code) => {
    console.log(`[TTS] Daemon terminó (code ${code}), reiniciando en 3s...`);
    daemonReady = false; daemon = null; isStreaming = false;
    if (pendingStream) { pendingStream.onError(new Error("Daemon reiniciando")); pendingStream = null; }
    if (pendingFull)   { pendingFull.reject(new Error("Daemon reiniciando"));    pendingFull = null; }
    setTimeout(startDaemon, 3000);
  });
}

startDaemon();

// ── Ask daemon: modo completo ─────────────────────────────────────────────────
function askDaemon(texto: string, refAudio: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!daemon || !daemonReady) return reject(new Error("Daemon no disponible aún"));
    if (pendingFull || pendingStream) return reject(new Error("Daemon ocupado, intentá en unos segundos"));
    pendingFull = { resolve, reject };
    daemon!.stdin!.write(JSON.stringify({ texto, ref_audio: refAudio, stream: false }) + "\n");
  });
}

// ── Ask daemon: modo streaming ────────────────────────────────────────────────
function streamDaemon(texto: string, refAudio: string, handlers: StreamReq): void {
  if (!daemon || !daemonReady) { handlers.onError(new Error("Daemon no disponible aún")); return; }
  if (pendingFull || pendingStream) { handlers.onError(new Error("Daemon ocupado, intentá en unos segundos")); return; }
  isStreaming = true;
  pendingStream = handlers;
  daemon!.stdin!.write(JSON.stringify({ texto, ref_audio: refAudio, stream: true }) + "\n");
}

// ── Voces ─────────────────────────────────────────────────────────────────────
const VOICES: Record<string, {
  name: string; voice?: string; pitch?: string; rate?: string; cloned?: boolean;
}> = {
  "diever":     { name: "Diever Muñoz ★ (voz clonada)", cloned: true },
  "gonzalo-co": { name: "Gonzalo (Colombia)", voice: "es-CO-GonzaloNeural", pitch: "-2Hz", rate: "-5%" },
  "jorge-mx":   { name: "Jorge (México)",     voice: "es-MX-JorgeNeural",   pitch: "-2Hz", rate: "-5%" },
  "alvaro-es":  { name: "Álvaro (España)",    voice: "es-ES-AlvaroNeural",  pitch: "-2Hz", rate: "-5%" },
  "tomas-ar":   { name: "Tomás (Argentina)",  voice: "es-AR-TomasNeural",   pitch: "-3Hz", rate: "-5%" },
  "mateo-uy":   { name: "Mateo (Uruguay)",    voice: "es-UY-MateoNeural",   pitch: "-2Hz", rate: "-8%" },
  "dalia-mx":   { name: "Dalia (México)",     voice: "es-MX-DaliaNeural",   pitch: "+0Hz", rate: "+0%" },
  "salome-co":  { name: "Salomé (Colombia)",  voice: "es-CO-SalomeNeural",  pitch: "+0Hz", rate: "+0%" },
  "elvira-es":  { name: "Elvira (España)",    voice: "es-ES-ElviraNeural",  pitch: "+0Hz", rate: "+0%" },
};

// ── GET /tts/voices ───────────────────────────────────────────────────────────
ttsRouter.get("/tts/voices", (_req, res) => {
  res.json({
    voices: Object.entries(VOICES).map(([id, v]) => ({
      id, name: v.name, cloned: v.cloned ?? false,
      daemonReady: v.cloned ? daemonReady : undefined,
    })),
    daemonReady,
  });
});

// ── GET /tts/stream — streaming WAV directo para <audio src> ──────────────────
ttsRouter.get("/tts/stream", (req, res: Response) => {
  const texto   = (req.query.texto   as string | undefined) ?? "";
  const voiceId = (req.query.voiceId as string | undefined) ?? "gonzalo-co";

  if (!texto.trim()) { res.status(400).json({ error: "texto requerido" }); return; }
  if (texto.length > 5000) { res.status(400).json({ error: "Texto demasiado largo" }); return; }

  const voz = VOICES[voiceId] ?? VOICES["gonzalo-co"];
  const text = texto.trim();

  if (!voz.cloned) { res.status(400).json({ error: "Solo voces clonadas usan streaming" }); return; }

  // Verificar caché
  const key    = cacheKey(text, voiceId);
  const cached = cacheGet(key);
  if (cached) {
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("X-Cache", "HIT");
    res.send(cached);
    return;
  }

  // Streaming desde daemon
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("X-Cache", "MISS");
  res.setHeader("Cache-Control", "no-cache");

  // Escribir WAV header con tamaño desconocido
  res.write(makeWavHeader());

  const pcmParts: Buffer[] = [];

  streamDaemon(text, DIEVER_REF, {
    onChunk: (pcm) => {
      pcmParts.push(pcm);
      res.write(pcm);
    },
    onEnd: () => {
      res.end();
      // Guardar en caché como WAV completo
      const pcmData = Buffer.concat(pcmParts);
      const wav     = Buffer.concat([makeWavHeader(pcmData.length), pcmData]);
      cacheSet(key, wav);
    },
    onError: (e) => {
      console.error("[TTS] Stream error:", e.message);
      if (!res.headersSent) res.status(503).json({ error: e.message });
      else res.end();
    },
  });
});

// ── POST /tts/generate ────────────────────────────────────────────────────────
ttsRouter.post("/tts/generate", async (req, res) => {
  const { texto, voiceId = "gonzalo-co" } = req.body as { texto?: string; voiceId?: string };

  if (!texto || typeof texto !== "string" || texto.trim().length === 0) {
    res.status(400).json({ error: "El campo 'texto' es requerido" }); return;
  }
  if (texto.length > 5000) {
    res.status(400).json({ error: "El texto no puede superar 5000 caracteres" }); return;
  }

  const voz  = VOICES[voiceId] ?? VOICES["gonzalo-co"];
  const text = texto.trim();

  // ── Diever — daemon + caché ───────────────────────────────────────────────
  if (voz.cloned) {
    const key    = cacheKey(text, voiceId);
    const cached = cacheGet(key);
    if (cached) {
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Cache", "HIT");
      res.send(cached);
      return;
    }
    try {
      const audio = await askDaemon(text, DIEVER_REF);
      cacheSet(key, audio);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Cache", "MISS");
      res.send(audio);
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
    return;
  }

  // ── Edge TTS ──────────────────────────────────────────────────────────────
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
    res.setHeader("Content-Disposition", "inline; filename=audio.mp3");
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
