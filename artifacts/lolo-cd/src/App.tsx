import { useState, useRef, useEffect, useCallback } from "react";
import ComentariosScreen from "./components/ComentariosScreen";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Voice { id: string; name: string; cloned: boolean; piper: boolean; }
interface VoicesResp { voices: Voice[]; daemonReady: boolean; }

export default function App() {
  const [texto, setTexto]                   = useState("");
  const [voiceId, setVoiceId]               = useState("gonzalo-co");
  const [voices, setVoices]                 = useState<Voice[]>([]);
  const [daemonReady, setDaemonReady]       = useState(false);
  const [loading, setLoading]               = useState(false);
  const [audioUrl, setAudioUrl]             = useState<string | null>(null);
  const [error, setError]                   = useState<string | null>(null);
  const [cacheHit, setCacheHit]             = useState<boolean | null>(null);
  const [darwinUpgrading, setDarwinUpgrading] = useState(false);
  const [darwinUpgraded, setDarwinUpgraded]   = useState(false);
  const [magicLoading, setMagicLoading]     = useState(false);
  const [magicError, setMagicError]         = useState<string | null>(null);
  const [magicText, setMagicText]           = useState("");
  const [magicMeta, setMagicMeta]           = useState<{ frameCount: number; durationSeconds: number; encoding: string } | null>(null);
  const fileInputRef    = useRef<HTMLInputElement>(null);
  const audioRef        = useRef<HTMLAudioElement>(null);
  const upgradeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const textoRef        = useRef("");

  const selectedVoice     = voices.find((v) => v.id === voiceId);
  const isCloned          = selectedVoice?.cloned ?? false;
  const clonedVoiceLabel  = selectedVoice?.name.split("★")[0].trim() || "voz clonada";
  const normalizedText    = texto.trim().toLowerCase().normalize("NFD")
    .replace(/\p{Diacritic}/gu, "").replace(/[¡!¿?.,\s]+$/g, "");
  const isInstantDarwinPhrase =
    normalizedText === "hola" ||
    normalizedText === "hola a la velocidad de la luz" ||
    normalizedText === "hola a la veloxidad de la luz";

  useEffect(() => {
    function poll() {
      fetch(`${BASE}/api/tts/voices`)
        .then((r) => r.json())
        .then((d: VoicesResp) => { setVoices(d.voices ?? []); setDaemonReady(d.daemonReady ?? false); })
        .catch(() => {});
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  const stopUpgradePolling = useCallback(() => {
    if (upgradeTimerRef.current) {
      clearInterval(upgradeTimerRef.current);
      upgradeTimerRef.current = null;
    }
  }, []);

  const startUpgradePolling = useCallback((textoParaPoll: string, xttsPromise: Promise<Blob>) => {
    stopUpgradePolling();
    setDarwinUpgrading(true);
    setDarwinUpgraded(false);

    xttsPromise.then(async (blob) => {
      const newUrl     = URL.createObjectURL(blob);
      const wasPlaying = audioRef.current && !audioRef.current.paused;
      const wasTime    = audioRef.current?.currentTime ?? 0;

      setAudioUrl(newUrl);
      setCacheHit(null);
      setDarwinUpgrading(false);
      setDarwinUpgraded(true);

      setTimeout(() => {
        if (audioRef.current) {
          if (wasPlaying) {
            audioRef.current.currentTime = wasTime < (audioRef.current.duration || 9999) ? wasTime : 0;
            audioRef.current.play().catch(() => {});
          }
        }
      }, 80);
    }).catch(() => {
      setDarwinUpgrading(false);
    });

    void textoParaPoll;
  }, [stopUpgradePolling]);

  useEffect(() => () => stopUpgradePolling(), [stopUpgradePolling]);

  async function generar() {
    if (!texto.trim()) return;
    stopUpgradePolling();
    setLoading(true);
    setError(null);
    setAudioUrl(null);
    setCacheHit(null);
    setDarwinUpgrading(false);
    setDarwinUpgraded(false);
    textoRef.current = texto.trim();

    try {
      const res = await fetch(`${BASE}/api/tts/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto, voiceId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? "Error del servidor");
      }
      const isUpgrading = res.headers.get("x-darwin-upgrading") === "true";
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      setAudioUrl(url);
      setTimeout(() => audioRef.current?.play(), 50);

      if (isUpgrading) {
        const xttsBlob = fetch(`${BASE}/api/tts/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texto, voiceId: "darwin-xtts" }),
        }).then(r => r.ok ? r.blob() : Promise.reject(new Error("xtts error")));
        startUpgradePolling(texto.trim(), xttsBlob);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function convertirVozAMagicText(file: File | null) {
    if (!file) return;
    setMagicLoading(true);
    setMagicError(null);
    setMagicText("");
    setMagicMeta(null);

    try {
      const res = await fetch(`${BASE}/api/voice/magic-text`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "Error convirtiendo audio");
      }
      const result = data as { encodedText: string; frameCount: number; durationSeconds: number; encoding: string };
      setMagicText(result.encodedText ?? "");
      setMagicMeta({
        frameCount: result.frameCount ?? 0,
        durationSeconds: result.durationSeconds ?? 0,
        encoding: result.encoding ?? "lpc-int8-hex-v1",
      });
    } catch (e) {
      setMagicError((e as Error).message);
    } finally {
      setMagicLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const canGenerar = !loading && texto.trim().length > 0;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0d", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', sans-serif", padding: "24px" }}>
      <div style={{ width: "100%", maxWidth: 600 }}>

        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 40, fontWeight: 900, color: "#fff", letterSpacing: "-1.5px" }}>
            Motor{" "}
            <span style={{ background: "linear-gradient(135deg,#7c3aed,#c026d3)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              Lolo CD
            </span>
          </div>
          <div style={{ marginTop: 8, color: "#52525b", fontSize: 13 }}>
            IA de voz en el servidor · Celular solo escucha · Costo $0
          </div>
        </div>

        <div style={{ marginBottom: 16, background: "#18181b", borderRadius: 14, padding: "12px 18px", border: `1px solid ${daemonReady ? "rgba(34,197,94,0.25)" : "rgba(234,179,8,0.25)"}`, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: daemonReady ? "#22c55e" : "#eab308", boxShadow: daemonReady ? "0 0 6px #22c55e" : "0 0 6px #eab308" }} />
          <span style={{ fontSize: 12, color: daemonReady ? "#86efac" : "#fde68a" }}>
            {daemonReady ? `Motor ${clonedVoiceLabel} en memoria — listo para generar` : "Motor de voz clonada cargando... las frases cacheadas salen instantáneas"}
          </span>
        </div>

        <div style={{ background: "#18181b", borderRadius: 20, padding: "32px 28px", border: "1px solid #27272a" }}>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", color: "#71717a", fontSize: 12, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>ELEGIR VOZ</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {voices.map((v) => (
                <button key={v.id} onClick={() => { setVoiceId(v.id); setAudioUrl(null); stopUpgradePolling(); setDarwinUpgrading(false); setDarwinUpgraded(false); }} style={{
                  padding: "10px 12px", borderRadius: 10,
                  border:     voiceId === v.id ? "1.5px solid #a855f7" : "1.5px solid #27272a",
                  background: voiceId === v.id ? "rgba(168,85,247,0.12)" : "#111113",
                  color:      voiceId === v.id ? "#d8b4fe" : "#71717a",
                  fontSize: 13, fontWeight: voiceId === v.id ? 600 : 400,
                  cursor: "pointer", textAlign: "left", transition: "all 0.15s",
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  {v.cloned && (
                    <span style={{ background: "linear-gradient(135deg,#7c3aed,#c026d3)", borderRadius: 4, padding: "1px 5px", fontSize: 9, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                      CLONADA
                    </span>
                  )}
                  {v.piper && (
                    <span style={{ background: "linear-gradient(135deg,#0ea5e9,#6366f1)", borderRadius: 4, padding: "1px 5px", fontSize: 9, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                      PIPER
                    </span>
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", color: "#71717a", fontSize: 12, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>
              TEXTO <span style={{ color: "#3f3f46", fontWeight: 400 }}>({texto.length} caracteres)</span>
            </label>
            <textarea
              value={texto} onChange={(e) => setTexto(e.target.value)}
              placeholder="Escribí acá lo que querés que diga..." rows={5}
              style={{ width: "100%", background: "#111113", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 10, padding: "12px 14px", fontSize: 15, outline: "none", resize: "vertical", lineHeight: 1.6, boxSizing: "border-box", fontFamily: "inherit" }}
            />
          </div>

          <button onClick={generar} disabled={!canGenerar} style={{
            width: "100%", padding: "14px", borderRadius: 12, border: "none",
            cursor: canGenerar ? "pointer" : "not-allowed",
            background: canGenerar ? "linear-gradient(135deg,#7c3aed,#c026d3)" : "#27272a",
            color: canGenerar ? "#fff" : "#52525b",
            fontSize: 15, fontWeight: 700, transition: "all 0.2s",
          }}>
            {loading
              ? isCloned ? "Generando con Darwin (~1 seg)..." : "Generando..."
              : isCloned && !daemonReady && !isInstantDarwinPhrase
                ? "Probar caché Darwin"
                : "Generar Audio"}
          </button>

          {error && (
            <div style={{ marginTop: 14, background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 10, padding: "10px 14px", color: "#fca5a5", fontSize: 13 }}>
              {error}
            </div>
          )}

          {audioUrl && (
            <div style={{ marginTop: 18, background: "#111113", borderRadius: 12, padding: "16px", border: "1px solid #27272a" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ color: "#a855f7", fontSize: 11, fontWeight: 700, letterSpacing: "0.8px" }}>AUDIO LISTO</span>
                {cacheHit !== null && !darwinUpgrading && !darwinUpgraded && (
                  <span style={{
                    background: cacheHit ? "rgba(34,197,94,0.15)" : "rgba(168,85,247,0.15)",
                    border: `1px solid ${cacheHit ? "rgba(34,197,94,0.3)" : "rgba(168,85,247,0.3)"}`,
                    color: cacheHit ? "#86efac" : "#d8b4fe",
                    borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 700,
                  }}>
                    {cacheHit ? "⚡ CACHÉ — instantáneo" : "✓ GENERADO"}
                  </span>
                )}
                {darwinUpgrading && (
                  <span style={{
                    background: "rgba(234,179,8,0.12)",
                    border: "1px solid rgba(234,179,8,0.35)",
                    color: "#fde68a",
                    borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 700,
                    animation: "pulse 1.2s ease-in-out infinite",
                  }}>
                    ⬆ Mejorando a Darwin HD...
                  </span>
                )}
                {darwinUpgraded && (
                  <span style={{
                    background: "rgba(34,197,94,0.15)",
                    border: "1px solid rgba(34,197,94,0.4)",
                    color: "#86efac",
                    borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 700,
                  }}>
                    ✦ Darwin HD — voz clonada
                  </span>
                )}
              </div>
              <audio ref={audioRef} src={audioUrl} controls style={{ width: "100%", borderRadius: 6 }} />
              <a href={audioUrl} download="darwin.wav" style={{ display: "block", marginTop: 8, textAlign: "center", color: "#52525b", fontSize: 12, textDecoration: "none" }}>
                Descargar audio
              </a>
            </div>
          )}

          <div style={{ marginTop: 22, background: "#111113", borderRadius: 14, padding: "16px", border: "1px solid #27272a" }}>
            <label style={{ display: "block", color: "#71717a", fontSize: 12, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>
              VOZ A MAGIC TEXT
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              onChange={(e) => convertirVozAMagicText(e.target.files?.[0] ?? null)}
              disabled={magicLoading}
              style={{ width: "100%", color: "#a1a1aa", fontSize: 13, marginBottom: 12 }}
            />
            {magicLoading && (
              <div style={{ color: "#d8b4fe", fontSize: 13 }}>Convirtiendo la voz en texto compacto...</div>
            )}
            {magicError && (
              <div style={{ background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 10, padding: "10px 14px", color: "#fca5a5", fontSize: 13 }}>
                {magicError}
              </div>
            )}
            {magicText && (
              <div>
                <div style={{ color: "#86efac", fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
                  {magicMeta?.encoding} · {magicMeta?.frameCount} frames · {magicMeta?.durationSeconds}s · {magicText.length} caracteres
                </div>
                <textarea
                  readOnly
                  value={magicText}
                  rows={5}
                  style={{ width: "100%", background: "#0a0a0d", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 10, padding: "10px 12px", fontSize: 12, outline: "none", resize: "vertical", boxSizing: "border-box", fontFamily: "monospace" }}
                />
                <button
                  onClick={() => navigator.clipboard?.writeText(magicText).catch(() => {})}
                  style={{ marginTop: 8, width: "100%", padding: "10px", borderRadius: 10, border: "1px solid #3f3f46", background: "#18181b", color: "#d8b4fe", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
                >
                  Copiar magic text
                </button>
              </div>
            )}
          </div>
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
          {[
            ["⚡ ~0.1s", "Piper local"],
            ["~0.5s", "edge_tts"],
            ["~1s", "Darwin HD (1ª vez)"],
            ["⚡ 0s", "Darwin HD (caché)"],
          ].map(([val, label]) => (
            <div key={label} style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: "10px 16px", textAlign: "center", flex: 1 }}>
              <div style={{ color: "#a855f7", fontWeight: 700, fontSize: 13 }}>{val}</div>
              <div style={{ color: "#3f3f46", fontSize: 11, marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 24 }}>
          <ComentariosScreen voiceId={voiceId} />
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
