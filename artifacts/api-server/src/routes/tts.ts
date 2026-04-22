import { Router }               from "express";
import { spawn, ChildProcess } from "child_process";
import { randomUUID }          from "crypto";
import { join }                from "path";
import { existsSync, unlinkSync } from "fs";

const ttsRouter = Router();

const TTS_SERVICE        = "http://127.0.0.1:5000";
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

startDaemon();

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
const EXPRESSIVE_TAGS: Record<string, string> = {
  "risa":         "ja, ja, ja, ja, ja!",
  "risa-fuerte":  "JA! JA! JA! JA! JA!",
  "risita":       "je, je, je.",
  "carcajada":    "ja, ja, ja, ja, ja, ja, ja, ja!",
  "suspiro":      "aaaaah...",
  "suspiro-largo":"aaaaaaaaaah...",
  "duda":         "eeeeeh...",
  "mmm":          "mmmmm.",
  "ah":           "ah!",
  "uf":           "uuuuf.",
  "carraspeo":    "ejem, ejem.",
  "asombro":      "oooooh!",
  "tos":          "ejem, ejem, ejem.",
  "beso":         "muá!",
  "llanto":       "buuuaaa, buuuaaa...",
};

function expandExpressiveTags(text: string): string {
  let out = text.replace(/\[pausa(?:=(\d+))?\]/gi, (_m, n) => {
    const dots = Math.max(1, Math.min(8, Number(n) || 2));
    return " " + ".".repeat(dots) + " ";
  });
  out = out.replace(/\[susurro\]([\s\S]*?)\[\/susurro\]/gi, (_m, inner: string) => `... ${inner.trim().toLowerCase()} ...`);
  out = out.replace(/\[([a-záéíóúüñ-]+)\]/gi, (full, tag: string) => {
    const key = tag.toLowerCase();
    return EXPRESSIVE_TAGS[key] !== undefined ? ` ${EXPRESSIVE_TAGS[key]} ` : full;
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
ttsRouter.post("/tts/generate", async (req, res) => {
  const { texto, voiceId = "gonzalo-co" } = req.body as { texto?: string; voiceId?: string };

  if (!texto || typeof texto !== "string" || texto.trim().length === 0) {
    res.status(400).json({ error: "El campo 'texto' es requerido" }); return;
  }

  const voz  = VOICES[voiceId] ?? VOICES["gonzalo-co"];
  const text = expandExpressiveTags(texto.trim());
  if (!text) { res.status(400).json({ error: "El texto quedó vacío luego de expandir etiquetas" }); return; }

  // ── XTTS clonado — 100% en memoria ────────────────────────────────────────
  if (voz.cloned) {
    try {
      const chunks = splitSentences(text);
      const parts: Buffer[] = [];
      for (const chunk of chunks) {
        const audio = await askDaemon(chunk, voz.refAudio ?? DIEVER_REF);
        parts.push(audio);
      }
      const audio = concatWavBuffers(parts);
      res.setHeader("Content-Type", "audio/wav");
      res.send(audio);
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
    return;
  }

  // ── Piper Patch — 100% en memoria ─────────────────────────────────────────
  if (voz.piperPatch) {
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
      res.setHeader("Content-Type", "audio/wav");
      res.send(buf);
    } catch (e) {
      res.status(503).json({ error: `Error Piper Patch: ${(e as Error).message}` });
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
          res.setHeader("Content-Type", "audio/wav");
          res.setHeader("X-Cache", "HIT-XTTS");
          res.send(xttsReady);
          return;
        }
      }

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Darwin-Upgrading", xttsPromise ? "true" : "false");
      res.send(edgeBuf);

      // Mantener la promesa viva en background (sin hacer nada con el resultado)
      xttsPromise?.catch(() => {});
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
