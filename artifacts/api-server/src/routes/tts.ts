import { Router }                  from "express";
import { spawn, ChildProcess }    from "child_process";
import { randomUUID, createHash } from "crypto";
import { join }                   from "path";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync,
         readdirSync, statSync, utimesSync }                              from "fs";

const ttsRouter = Router();

const TTS_SERVICE   = "http://127.0.0.1:5000";
const DIEVER_REF    = "/home/runner/workspace/diever_referencia.wav";
const NEXUS_REF     = "/home/runner/workspace/attached_assets/NEXUS_VOZ_OFFLINE_1776028665996.onnx";
const NEXUS_CONFIG  = "/home/runner/workspace/attached_assets/NEXUS_OFFLINE.onnx_1776029964832.json";
const NEXUS_ULTRA_REF = NEXUS_REF;
const NEXUS_ULTRA_CONFIG = "/home/runner/workspace/attached_assets/NEXUS_ULTRA_FAST_1776036098561.json";
const NEXUS_PIPER_PATCH = "nexus-piper-patch";
const DAEMON_SCRIPT = "/home/runner/workspace/xtts_daemon.py";

// ── Caché LRU en disco — autolimpiante, nunca se llena ───────────────────────
const CACHE_DIR     = "/home/runner/workspace/tts_cache";
const CACHE_MAX_MB  = 400;                          // límite en MB
const CACHE_MAX_B   = CACHE_MAX_MB * 1024 * 1024;  // en bytes
mkdirSync(CACHE_DIR, { recursive: true });

function cacheKey(texto: string, voiceId: string) {
  return createHash("sha1").update(`${voiceId}::${texto}`).digest("hex");
}

function cacheGet(key: string): Buffer | null {
  const p = join(CACHE_DIR, `${key}.wav`);
  if (!existsSync(p)) return null;
  const now = new Date();
  try { utimesSync(p, now, now); } catch { /* ignorar */ }
  return readFileSync(p);
}

function cacheSet(key: string, data: Buffer) {
  writeFileSync(join(CACHE_DIR, `${key}.wav`), data);
  setImmediate(evictLRU);
}

function evictLRU() {
  try {
    const files = readdirSync(CACHE_DIR)
      .filter(f => f.endsWith(".wav"))
      .map(f => {
        const full = join(CACHE_DIR, f);
        const st   = statSync(full);
        return { full, atime: st.atimeMs, size: st.size };
      })
      .sort((a, b) => a.atime - b.atime);

    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= CACHE_MAX_B) return;

    for (const file of files) {
      if (total <= CACHE_MAX_B * 0.8) break;
      try { unlinkSync(file.full); total -= file.size; } catch { /* ignorar */ }
    }
    console.log(`[CACHE] LRU eviction: ${Math.round(total / 1024 / 1024)}MB libre`);
  } catch { /* ignorar */ }
}

function instantClonedText(texto: string) {
  const normalized = texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[¡!¿?.,\s]+$/g, "");

  if (normalized === "hola") return "Hola.";
  if (
    normalized === "hola a la velocidad de la luz" ||
    normalized === "hola a la veloxidad de la luz"
  ) {
    return "Hola a la velocidad de la luz.";
  }
  return null;
}

// ── Frases pre-calentadas para Diever ─────────────────────────────────────────
const WARMUP_PHRASES = [
  "Hola.",
  "Hola a la velocidad de la luz.",
  "Hola, ¿cómo están?",
  "Buenas.",
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
    console.log("[TTS] Precalentando caché Darwin/Diever/Nexus en background...");
    let hit = 0, miss = 0;
    const clonedWarmups = [
      ["darwin-xtts", DIEVER_REF],
      ["diever", DIEVER_REF],
      ["nexus", NEXUS_REF],
      ["nexus-ultra", NEXUS_ULTRA_REF],
    ] as const;
    for (const [voiceId, refAudio] of clonedWarmups) {
      for (const frase of WARMUP_PHRASES) {
        const key = cacheKey(frase, voiceId);
        if (cacheGet(key)) { hit++; continue; }
        try {
          const audio = await askDaemon(frase, refAudio);
          cacheSet(key, audio);
          miss++;
          console.log(`[TTS] Warmup ${voiceId}: "${frase.slice(0, 45)}"`);
        } catch {
          // ignorar errores de warmup
        }
      }
    }
    console.log(`[TTS] Warmup completo — ${hit} en caché, ${miss} generados.`);
  })().catch(console.error);
}

startDaemon();

// Frases con XTTS en generación background (evita duplicados)
const _xttsInFlight = new Set<string>();

// ── Voces ─────────────────────────────────────────────────────────────────────
const VOICES: Record<string, {
  name: string; voice?: string; pitch?: string; rate?: string;
  cloned?: boolean; piper?: string; piperPatch?: string; refAudio?: string; config?: string;
  edgeDarwin?: boolean;
}> = {
  "darwin":      { name: "Darwin ★",                      edgeDarwin: true },
  "darwin-xtts": { name: "Darwin ★ (XTTS · alta calidad)", cloned: true },
  "diever":      { name: "Diever Muñoz ★ (voz clonada)", cloned: true },
  "nexus":       { name: "Nexus Offline Juan ★ (voz subida)", cloned: true, refAudio: NEXUS_REF, config: NEXUS_CONFIG },
  "nexus-ultra": { name: "Nexus Ultra Fast ★ (caché local)", cloned: true, refAudio: NEXUS_ULTRA_REF, config: NEXUS_ULTRA_CONFIG },
  "nexus-piper-patch":  { name: "Nexus Piper Patch ★ (Piper + ADN)",        piperPatch: NEXUS_PIPER_PATCH },
  "lolo-piper-patch":   { name: "Lolo ★ (Piper + ADN voz clonada)",        piperPatch: "lolo-piper-patch"   },
  "darwin-piper-patch": { name: "Darwin ★ (Piper + ADN voz clonada)",       piperPatch: "darwin-piper-patch" },
  "claude-mx":   { name: "Claude (México) · Piper",      piper: "claude-mx"  },
  "daniela-ar":  { name: "Daniela (Argentina) · Piper",  piper: "daniela-ar" },
  "carlfm-es":   { name: "CarlFM (España) · Piper",      piper: "carlfm-es"  },
  "davefx-es":   { name: "DaveFX (España) · Piper",      piper: "davefx-es"  },
  "gonzalo-co":  { name: "Gonzalo (Colombia)", voice: "es-CO-GonzaloNeural", pitch: "-2Hz", rate: "-5%" },
  "jorge-mx":    { name: "Jorge (México)",     voice: "es-MX-JorgeNeural",   pitch: "-2Hz", rate: "-5%" },
  "alvaro-es":   { name: "Álvaro (España)",    voice: "es-ES-AlvaroNeural",  pitch: "-2Hz", rate: "-5%" },
  "tomas-ar":    { name: "Tomás (Argentina)",  voice: "es-AR-TomasNeural",   pitch: "-3Hz", rate: "-5%" },
  "mateo-uy":    { name: "Mateo (Uruguay)",    voice: "es-UY-MateoNeural",   pitch: "-2Hz", rate: "-8%" },
  "dalia-mx":    { name: "Dalia (México)",     voice: "es-MX-DaliaNeural",   pitch: "+0Hz", rate: "+0%" },
  "salome-co":   { name: "Salomé (Colombia)",  voice: "es-CO-SalomeNeural",  pitch: "+0Hz", rate: "+0%" },
  "elvira-es":   { name: "Elvira (España)",    voice: "es-ES-ElviraNeural",  pitch: "+0Hz", rate: "+0%" },
};

// ── GET /tts/xtts-status ─────────────────────────────────────────────────────
ttsRouter.get("/tts/xtts-status", (req, res) => {
  const texto = (req.query.texto as string ?? "").trim();
  if (!texto) { res.json({ ready: false }); return; }
  const key   = cacheKey(texto, "darwin-xtts");
  const ready = !!cacheGet(key);
  res.json({ ready, daemonReady });
});

// ── GET /tts/voices ───────────────────────────────────────────────────────────
ttsRouter.get("/tts/voices", (_req, res) => {
  res.json({
    voices: Object.entries(VOICES).map(([id, v]) => ({
      id, name: v.name,
      cloned:     v.cloned  ?? false,
      piper:      !!(v.piper || v.piperPatch),
      daemonReady: v.cloned ? daemonReady : undefined,
    })),
    daemonReady,
  });
});

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
      current = piece.length > MAX_CHUNK_CHARS
        ? piece.slice(0, MAX_CHUNK_CHARS)
        : piece;
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
  const hdr       = bufs[0].slice(0, 44);
  const pcmParts  = bufs.map(b => b.slice(44));
  const totalPcm  = Buffer.concat(pcmParts);
  const out       = Buffer.alloc(44 + totalPcm.length);
  hdr.copy(out, 0);
  out.writeUInt32LE(totalPcm.length + 36, 4);
  out.writeUInt32LE(totalPcm.length, 40);
  totalPcm.copy(out, 44);
  return out;
}

// ── POST /tts/generate ────────────────────────────────────────────────────────
ttsRouter.post("/tts/generate", async (req, res) => {
  const { texto, voiceId = "gonzalo-co" } = req.body as { texto?: string; voiceId?: string };

  if (!texto || typeof texto !== "string" || texto.trim().length === 0) {
    res.status(400).json({ error: "El campo 'texto' es requerido" }); return;
  }

  const voz  = VOICES[voiceId] ?? VOICES["gonzalo-co"];
  const text = texto.trim();

  // ── XTTS clonado — chunks ilimitados ──────────────────────────────────────
  if (voz.cloned) {
    const cachedText = instantClonedText(text) ?? text;
    const key    = cacheKey(cachedText, voiceId);
    const cached = cacheGet(key);
    if (cached) {
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Cache", "HIT");
      res.send(cached);
      return;
    }
    try {
      const chunks   = splitSentences(cachedText);
      const parts: Buffer[] = [];
      for (const chunk of chunks) {
        const chunkKey    = cacheKey(chunk, voiceId);
        const chunkCached = cacheGet(chunkKey);
        if (chunkCached) {
          parts.push(chunkCached);
        } else {
          const audio = await askDaemon(chunk, voz.refAudio ?? DIEVER_REF);
          cacheSet(chunkKey, audio);
          parts.push(audio);
        }
      }
      const audio = concatWavBuffers(parts);
      cacheSet(key, audio);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Cache", "MISS");
      res.send(audio);
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
    return;
  }

  if (voz.piperPatch) {
    const key = cacheKey(text, voiceId);
    const cached = cacheGet(key);
    if (cached) {
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Cache", "HIT");
      res.send(cached);
      return;
    }
    try {
      const upstream = await fetch(`${TTS_SERVICE}/piper-patch`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ texto: text, voice: voz.piperPatch }),
      });
      if (!upstream.ok) {
        const err = await upstream.json().catch(() => ({ error: "Error Piper Patch" }));
        res.status(upstream.status).json(err); return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      cacheSet(key, buf);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Cache", "MISS");
      res.send(buf);
    } catch (e) {
      res.status(503).json({ error: `Error Piper Patch: ${(e as Error).message}` });
    }
    return;
  }

  // ── Darwin inteligente: Edge rápido + upgrade XTTS en background ──────────
  if (voz.edgeDarwin) {
    const xttsKey = cacheKey(text, "darwin-xtts");   // caché de alta calidad
    const edgeKey = cacheKey(text, voiceId);          // caché de respuesta rápida

    // 1. Si ya tenemos XTTS de alta calidad, devolverlo directo
    const xttsHit = cacheGet(xttsKey);
    if (xttsHit) {
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Cache", "HIT-XTTS");
      res.send(xttsHit);
      return;
    }

    // 2. Lanzar generación XTTS en background (si el daemon está listo y no hay una en curso)
    if (daemonReady && !_xttsInFlight.has(xttsKey)) {
      _xttsInFlight.add(xttsKey);
      (async () => {
        try {
          const chunks = splitSentences(text);
          const parts: Buffer[] = [];
          for (const chunk of chunks) {
            const ck = cacheKey(chunk, "darwin-xtts");
            const cc = cacheGet(ck);
            if (cc) { parts.push(cc); continue; }
            const audio = await askDaemon(chunk, DIEVER_REF);
            cacheSet(ck, audio);
            parts.push(audio);
          }
          const xttsAudio = concatWavBuffers(parts);
          cacheSet(xttsKey, xttsAudio);
          // Actualizar también el caché rápido para que próximas respuestas sean XTTS
          cacheSet(edgeKey, xttsAudio);
          console.log(`[TTS] XTTS background listo: "${text.slice(0, 50)}"`);
        } catch (e) {
          console.error("[TTS] XTTS background error:", (e as Error).message);
        } finally {
          _xttsInFlight.delete(xttsKey);
        }
      })().catch(console.error);
    }

    // 3. Si ya hay un Edge+Darwin en caché, devolver inmediato
    const edgeHit = cacheGet(edgeKey);
    if (edgeHit) {
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Cache", "HIT");
      res.send(edgeHit);
      return;
    }

    // 4. Generar Edge+Darwin como respuesta rápida (~0.75s)
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
      const buf = Buffer.from(await upstream.arrayBuffer());
      cacheSet(edgeKey, buf);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Cache", "MISS");
      res.setHeader("X-Darwin-Upgrading", "true");
      res.send(buf);
    } catch (e) {
      res.status(503).json({ error: `Error Edge Darwin: ${(e as Error).message}` });
    }
    return;
  }

  // ── Piper TTS ─────────────────────────────────────────────────────────────
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
