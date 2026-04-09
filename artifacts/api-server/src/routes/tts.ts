import { Router } from "express";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";

const ttsRouter = Router();

const VOICES: Record<string, { name: string; voice: string; pitch: string; rate: string }> = {
  "gonzalo-co": { name: "Gonzalo (Colombia)", voice: "es-CO-GonzaloNeural", pitch: "-2Hz", rate: "-5%" },
  "jorge-mx":   { name: "Jorge (México)",     voice: "es-MX-JorgeNeural",   pitch: "-2Hz", rate: "-5%" },
  "alvaro-es":  { name: "Álvaro (España)",    voice: "es-ES-AlvaroNeural",  pitch: "-2Hz", rate: "-5%" },
  "tomas-ar":   { name: "Tomás (Argentina)",  voice: "es-AR-TomasNeural",   pitch: "-3Hz", rate: "-5%" },
  "mateo-uy":   { name: "Mateo (Uruguay)",    voice: "es-UY-MateoNeural",   pitch: "-2Hz", rate: "-8%" },
  "dalia-mx":   { name: "Dalia (México)",     voice: "es-MX-DaliaNeural",   pitch: "+0Hz", rate: "+0%" },
  "salome-co":  { name: "Salomé (Colombia)",  voice: "es-CO-SalomeNeural",  pitch: "+0Hz", rate: "+0%" },
  "elvira-es":  { name: "Elvira (España)",    voice: "es-ES-ElviraNeural",  pitch: "+0Hz", rate: "+0%" },
};

ttsRouter.get("/tts/voices", (_req, res) => {
  const voices = Object.entries(VOICES).map(([id, v]) => ({ id, name: v.name }));
  res.json({ voices });
});

ttsRouter.post("/tts/generate", async (req, res) => {
  const { texto, voiceId = "gonzalo-co" } = req.body as { texto?: string; voiceId?: string };

  if (!texto || typeof texto !== "string" || texto.trim().length === 0) {
    res.status(400).json({ error: "El campo 'texto' es requerido" });
    return;
  }

  if (texto.length > 5000) {
    res.status(400).json({ error: "El texto no puede superar 5000 caracteres" });
    return;
  }

  const voz = VOICES[voiceId] ?? VOICES["gonzalo-co"];
  const tmpFile = join("/tmp", `tts_${randomUUID()}.mp3`);
  const scriptPath = join(process.cwd(), "../../tts_engine.py");

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("python3", [
        scriptPath,
        texto.trim(),
        voz.voice,
        voz.pitch,
        voz.rate,
        tmpFile,
      ]);

      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `Exit code ${code}`));
      });
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", "inline; filename=audio.mp3");
    res.sendFile(tmpFile, (err) => {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
      if (err && !res.headersSent) res.status(500).json({ error: "Error enviando audio" });
    });
  } catch (err) {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
    res.status(500).json({ error: "Error generando audio" });
  }
});

export default ttsRouter;
