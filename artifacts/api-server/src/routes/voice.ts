import { Router, raw } from "express";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const voiceRouter = Router();

const ENCODER_SCRIPT = "/workspaces/Lucas/voice_magic_text.py";
const MAX_AUDIO_BYTES = "15mb";

function extensionFromContentType(contentType: string | undefined): string {
  if (!contentType) return ".audio";
  if (contentType.includes("wav")) return ".wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return ".mp3";
  if (contentType.includes("ogg")) return ".ogg";
  if (contentType.includes("webm")) return ".webm";
  if (contentType.includes("flac")) return ".flac";
  if (contentType.includes("m4a") || contentType.includes("mp4")) return ".m4a";
  return ".audio";
}

function runMagicTextEncoder(audioPath: string, mode: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [ENCODER_SCRIPT, audioPath, mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("El encoder tardó demasiado"));
    }, 45000);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Encoder terminó con código ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("El encoder devolvió una respuesta inválida"));
      }
    });
  });
}

voiceRouter.post(
  "/voice/magic-text",
  raw({ type: ["audio/*", "application/octet-stream"], limit: MAX_AUDIO_BYTES }),
  async (req, res) => {
    const mode = typeof req.query["mode"] === "string" ? req.query["mode"] : "ultra";
    if (!["standard", "ultra", "fingerprint", "photon"].includes(mode)) {
      res.status(400).json({ error: "Modo inválido. Usá standard, ultra, fingerprint o photon" });
      return;
    }

    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      res.status(400).json({
        error: "Enviá el audio como cuerpo binario con Content-Type audio/wav, audio/mpeg o application/octet-stream",
      });
      return;
    }

    const tmpFile = join("/tmp", `magic_voice_${randomUUID()}${extensionFromContentType(req.headers["content-type"])}`);
    try {
      writeFileSync(tmpFile, audio);
      const result = await runMagicTextEncoder(tmpFile, mode);
      res.json(result);
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  },
);

export default voiceRouter;