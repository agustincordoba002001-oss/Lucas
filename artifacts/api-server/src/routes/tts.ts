import { Router }                  from "express";
import { spawn }                  from "child_process";
import { randomUUID, createHash } from "crypto";
import { join }                   from "path";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const ttsRouter = Router();

const TTS_SERVICE = "http://127.0.0.1:5000";
const DIEVER_REF  = "/home/runner/workspace/diever_referencia.wav";
const XTTS_SCRIPT = "/home/runner/workspace/xtts_engine.py";

// ── Caché en disco para Diever ───────────────────────────────────────────
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

// ── Voces ────────────────────────────────────────────────────────────────
const VOICES: Record<string, {
  name: string; voice?: string; pitch?: string; rate?: string; cloned?: boolean;
}> = {
  "diever":     { name: "Diever Muñoz \u2605 (voz clonada)", cloned: true },
  "gonzalo-co": { name: "Gonzalo (Colombia)", voice: "es-CO-GonzaloNeural", pitch: "-2Hz", rate: "-5%" },
  "jorge-mx":   { name: "Jorge (M\u00e9xico)",     voice: "es-MX-JorgeNeural",   pitch: "-2Hz", rate: "-5%" },
  "alvaro-es":  { name: "\u00c1lvaro (Espa\u00f1a)",    voice: "es-ES-AlvaroNeural",  pitch: "-2Hz", rate: "-5%" },
  "tomas-ar":   { name: "Tom\u00e1s (Argentina)",  voice: "es-AR-TomasNeural",   pitch: "-3Hz", rate: "-5%" },
  "mateo-uy":   { name: "Mateo (Uruguay)",    voice: "es-UY-MateoNeural",   pitch: "-2Hz", rate: "-8%" },
  "dalia-mx":   { name: "Dalia (M\u00e9xico)",     voice: "es-MX-DaliaNeural",   pitch: "+0Hz", rate: "+0%" },
  "salome-co":  { name: "Salom\u00e9 (Colombia)",  voice: "es-CO-SalomeNeural",  pitch: "+0Hz", rate: "+0%" },
  "elvira-es":  { name: "Elvira (Espa\u00f1a)",    voice: "es-ES-ElviraNeural",  pitch: "+0Hz", rate: "+0%" },
};

ttsRouter.get("/tts/voices", (_req, res) => {
  res.json({
    voices: Object.entries(VOICES).map(([id, v]) => ({
      id, name: v.name, cloned: v.cloned ?? false,
    })),
  });
});

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

  // ── Voz clonada Diever (caché + subprocess) ───────────────────────────
  if (voz.cloned) {
    const key    = cacheKey(text, voiceId);
    const cached = cacheGet(key);

    if (cached) {
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Content-Disposition", "inline; filename=audio.wav");
      res.setHeader("X-Cache", "HIT");
      res.send(cached);
      return;
    }

    const tmpFile = join("/tmp", `xtts_${randomUUID()}.wav`);
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("python3", [XTTS_SCRIPT, text, DIEVER_REF, tmpFile]);
        let stderr = "";
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.slice(-300))));
      });

      const audio = readFileSync(tmpFile);
      cacheSet(key, audio);
      if (existsSync(tmpFile)) unlinkSync(tmpFile);

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Content-Disposition", "inline; filename=audio.wav");
      res.setHeader("X-Cache", "MISS");
      res.send(audio);
    } catch {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
      res.status(500).json({ error: "Error generando voz clonada" });
    }
    return;
  }

  // ── Voces edge_tts — servicio persistente con fallback ────────────────
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
    // Fallback: spawnar Python si el servicio no está disponible
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
      res.setHeader("Content-Disposition", "inline; filename=audio.mp3");
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

// ── Precalentar caché de Diever ──────────────────────────────────────────
ttsRouter.post("/tts/precalentar", async (req, res) => {
  const { frases } = req.body as { frases?: string[] };
  if (!frases || !Array.isArray(frases)) {
    res.status(400).json({ error: "Se requiere un array 'frases'" }); return;
  }

  res.json({ mensaje: `Precalentando ${frases.length} frase(s) en background...` });

  for (const frase of frases) {
    const text = frase.trim();
    if (!text) continue;
    const key = cacheKey(text, "diever");
    if (cacheGet(key)) continue;

    const tmpFile = join("/tmp", `xtts_pre_${randomUUID()}.wav`);
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("python3", [XTTS_SCRIPT, text, DIEVER_REF, tmpFile]);
        let stderr = "";
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
      });
      const audio = readFileSync(tmpFile);
      cacheSet(key, audio);
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
      console.log(`[TTS] Precalentado: "${text.slice(0, 50)}..."`);
    } catch (e) {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
      console.error(`[TTS] Error precalentando: ${e}`);
    }
  }
});

export default ttsRouter;
