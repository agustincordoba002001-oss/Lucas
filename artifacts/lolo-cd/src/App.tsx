import { useState, useRef, useEffect } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Voice { id: string; name: string; cloned: boolean; }

export default function App() {
  const [texto, setTexto]       = useState("");
  const [voiceId, setVoiceId]   = useState("gonzalo-co");
  const [voices, setVoices]     = useState<Voice[]>([]);
  const [loading, setLoading]   = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [cacheHit, setCacheHit] = useState<boolean | null>(null);
  const [calentando, setCalentando] = useState(false);
  const [frasesPre, setFrasesPre]   = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  const selectedVoice = voices.find((v) => v.id === voiceId);

  useEffect(() => {
    fetch(`${BASE}/api/tts/voices`)
      .then((r) => r.json())
      .then((d) => setVoices(d.voices ?? []))
      .catch(() => {});
  }, []);

  async function generar() {
    if (!texto.trim()) return;
    setLoading(true);
    setError(null);
    setAudioUrl(null);
    setCacheHit(null);
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
      setCacheHit(res.headers.get("x-cache") === "HIT");
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      setAudioUrl(url);
      setTimeout(() => audioRef.current?.play(), 100);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function precalentar() {
    const frases = frasesPre.split("\n").map((f) => f.trim()).filter(Boolean);
    if (!frases.length) return;
    setCalentando(true);
    try {
      await fetch(`${BASE}/api/tts/precalentar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frases }),
      });
      alert(`Precalentando ${frases.length} frase(s) en el servidor. Esperá unos minutos y luego serán instantáneas.`);
    } catch {
      alert("Error al iniciar precalentamiento");
    } finally {
      setCalentando(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0d", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', sans-serif", padding: "24px" }}>
      <div style={{ width: "100%", maxWidth: 600 }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 40, fontWeight: 900, color: "#fff", letterSpacing: "-1.5px" }}>
            Motor <span style={{ background: "linear-gradient(135deg, #7c3aed, #c026d3)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Lolo CD</span>
          </div>
          <div style={{ marginTop: 8, color: "#52525b", fontSize: 13 }}>
            IA de voz en el servidor · Celular solo escucha · Costo $0
          </div>
        </div>

        {/* Card principal */}
        <div style={{ background: "#18181b", borderRadius: 20, padding: "32px 28px", border: "1px solid #27272a" }}>

          {/* Voces */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", color: "#71717a", fontSize: 12, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>ELEGIR VOZ</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {voices.map((v) => (
                <button key={v.id} onClick={() => setVoiceId(v.id)} style={{
                  padding: "10px 12px", borderRadius: 10,
                  border:      voiceId === v.id ? "1.5px solid #a855f7" : "1.5px solid #27272a",
                  background:  voiceId === v.id ? "rgba(168,85,247,0.12)" : "#111113",
                  color:       voiceId === v.id ? "#d8b4fe" : "#71717a",
                  fontSize: 13, fontWeight: voiceId === v.id ? 600 : 400,
                  cursor: "pointer", textAlign: "left", transition: "all 0.15s",
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  {v.cloned && (
                    <span style={{ background: "linear-gradient(135deg,#7c3aed,#c026d3)", borderRadius: 4, padding: "1px 5px", fontSize: 9, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                      CLONADA
                    </span>
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</span>
                </button>
              ))}
            </div>

            {selectedVoice?.cloned && (
              <div style={{ marginTop: 10, background: "rgba(124,58,237,0.08)", border: "1px solid rgba(168,85,247,0.2)", borderRadius: 8, padding: "8px 12px", color: "#a78bfa", fontSize: 12 }}>
                Primera generación: el servidor clona la voz (~30 seg sin GPU). La misma frase generada antes: <strong>instantáneo desde caché</strong>.
              </div>
            )}
          </div>

          {/* Texto */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", color: "#71717a", fontSize: 12, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>
              TEXTO <span style={{ color: "#3f3f46", fontWeight: 400 }}>({texto.length}/5000)</span>
            </label>
            <textarea
              value={texto} onChange={(e) => setTexto(e.target.value)}
              placeholder="Escribí acá lo que querés que diga..." maxLength={5000} rows={5}
              style={{ width: "100%", background: "#111113", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 10, padding: "12px 14px", fontSize: 15, outline: "none", resize: "vertical", lineHeight: 1.6, boxSizing: "border-box", fontFamily: "inherit" }}
            />
          </div>

          {/* Botón generar */}
          <button onClick={generar} disabled={loading || !texto.trim()} style={{
            width: "100%", padding: "14px", borderRadius: 12, border: "none",
            cursor: loading || !texto.trim() ? "not-allowed" : "pointer",
            background: loading || !texto.trim() ? "#27272a" : "linear-gradient(135deg, #7c3aed, #c026d3)",
            color: loading || !texto.trim() ? "#52525b" : "#fff",
            fontSize: 15, fontWeight: 700, transition: "all 0.2s",
          }}>
            {loading
              ? selectedVoice?.cloned ? "Clonando voz en servidor... (hasta 30 seg)" : "Generando..."
              : "Generar Audio"}
          </button>

          {/* Error */}
          {error && (
            <div style={{ marginTop: 14, background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 10, padding: "10px 14px", color: "#fca5a5", fontSize: 13 }}>
              {error}
            </div>
          )}

          {/* Reproductor */}
          {audioUrl && (
            <div style={{ marginTop: 18, background: "#111113", borderRadius: 12, padding: "16px", border: "1px solid #27272a" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ color: "#a855f7", fontSize: 11, fontWeight: 700, letterSpacing: "0.8px" }}>AUDIO LISTO</span>
                {cacheHit !== null && (
                  <span style={{
                    background: cacheHit ? "rgba(34,197,94,0.15)" : "rgba(168,85,247,0.15)",
                    border: `1px solid ${cacheHit ? "rgba(34,197,94,0.3)" : "rgba(168,85,247,0.3)"}`,
                    color: cacheHit ? "#86efac" : "#d8b4fe",
                    borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 700,
                  }}>
                    {cacheHit ? "⚡ CACHÉ" : "🧠 GENERADO"}
                  </span>
                )}
              </div>
              <audio ref={audioRef} src={audioUrl} controls style={{ width: "100%", borderRadius: 6 }} />
              <a href={audioUrl} download="lolo_cd.wav" style={{ display: "block", marginTop: 8, textAlign: "center", color: "#52525b", fontSize: 12, textDecoration: "none" }}>
                Descargar audio
              </a>
            </div>
          )}
        </div>

        {/* Panel precalentamiento Diever */}
        {voiceId === "diever" && (
          <div style={{ marginTop: 16, background: "#18181b", borderRadius: 16, padding: "20px 24px", border: "1px solid rgba(168,85,247,0.2)" }}>
            <div style={{ color: "#a78bfa", fontSize: 12, fontWeight: 700, letterSpacing: "0.8px", marginBottom: 8 }}>
              ⚡ PRECALENTAR CACHÉ DE DIEVER
            </div>
            <div style={{ color: "#52525b", fontSize: 12, marginBottom: 10 }}>
              Escribí frases que vas a usar seguido (una por línea). El servidor las genera en background y la próxima vez son instantáneas.
            </div>
            <textarea
              value={frasesPre} onChange={(e) => setFrasesPre(e.target.value)}
              placeholder={"Hola, ¿cómo estás?\nBienvenidos al programa\nHasta la próxima"}
              rows={4}
              style={{ width: "100%", background: "#111113", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "10px 12px", fontSize: 13, outline: "none", resize: "vertical", boxSizing: "border-box", fontFamily: "inherit" }}
            />
            <button onClick={precalentar} disabled={calentando || !frasesPre.trim()} style={{
              marginTop: 10, width: "100%", padding: "10px", borderRadius: 10, border: "1px solid rgba(168,85,247,0.4)",
              background: "rgba(124,58,237,0.1)", color: calentando ? "#52525b" : "#a78bfa",
              fontSize: 13, fontWeight: 600, cursor: calentando ? "not-allowed" : "pointer",
            }}>
              {calentando ? "Mandando al servidor..." : "Precalentar en background"}
            </button>
          </div>
        )}

        {/* Stats */}
        <div style={{ marginTop: 16, display: "flex", gap: 10, justifyContent: "center" }}>
          {[["~0.5s", "voces edge"], ["caché", "Diever igual"], ["$0", "siempre"]].map(([val, label]) => (
            <div key={val} style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: "10px 16px", textAlign: "center", flex: 1 }}>
              <div style={{ color: "#a855f7", fontWeight: 700, fontSize: 13 }}>{val}</div>
              <div style={{ color: "#3f3f46", fontSize: 11, marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
