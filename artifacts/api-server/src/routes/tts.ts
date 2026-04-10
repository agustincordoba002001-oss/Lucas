import { Router }                  from "express";
import { spawn, ChildProcess }    from "child_process";
import { randomUUID, createHash } from "crypto";
import { join }                   from "path";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const ttsRouter = Router();

const TTS_SERVICE   = "http://127.0.0.1:5000";
const DIEVER_REF    = "/home/runner/workspace/diever_referencia.wav";
const DAEMON_SCRIPT = "/home/runner/workspace/xtts_daemon.py";

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

// ── Frases pre-calentadas para Diever ─────────────────────────────────────────
const WARMUP_PHRASES = [
  "Bienvenidos a Motor Lolo CD.",
  "Estás escuchando Motor Lolo CD, la mejor música para tu viaje.",
  "Seguimos con más música en Motor Lolo CD.",
  "Muchas gracias por escucharnos.",
  "Y ahora sí, con todo.",
  "Eso es todo por hoy, hasta la próxima.",
  "Buenas noches a todos nuestros oyentes.",
  "Buenos días Colombia, arriba ese ánimo.",
  "Una canción especial para todos ustedes.",
  "Motor Lolo CD, siempre contigo.",
];

// ── XTTS Daemon ───────────────────────────────────────────────────────────────
let daemon: ChildProcess | null = null;
let daemonReady                 = false;
let daemonBuf                   = Buffer.alloc(0);
let warmupDone                  = false;

type QueueItem = {
  texto: string;
  refAudio: string;
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
  daemon!.stdin!.write(JSON.stringify({ texto: next.texto, ref_audio: next.refAudio }) + "\n");
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
          if (!warmupDone) {
            warmupDone = true;
            scheduleWarmup();
          }
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

function askDaemon(texto: string, refAudio: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!daemon || !daemonReady) {
      return reject(new Error("Daemon no disponible aún, intentá en unos segundos"));
    }
    requestQueue.push({ texto, refAudio, resolve, reject });
    processNextInQueue();
  });
}

function scheduleWarmup() {
  (async () => {
    console.log("[TTS] Precalentando caché Diever en background...");
    let hit = 0, miss = 0;
    for (const frase of WARMUP_PHRASES) {
      const key = cacheKey(frase, "diever");
      if (cacheGet(key)) { hit++; continue; }
      try {
        const audio = await askDaemon(frase, DIEVER_REF);
        cacheSet(key, audio);
        miss++;
        console.log(`[TTS] Warmup: "${frase.slice(0, 45)}"`);
      } catch {
        // ignorar errores de warmup
      }
    }
    console.log(`[TTS] Warmup completo — ${hit} en caché, ${miss} generados.`);
  })().catch(console.error);
}

startDaemon();

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

  // ── Diever ────────────────────────────────────────────────────────────────
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
