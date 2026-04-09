import { useState, useRef, useEffect } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Voice { id: string; name: string; }

export default function App() {
  const [texto, setTexto] = useState("");
  const [voiceId, setVoiceId] = useState("gonzalo-co");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

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
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      setTimeout(() => audioRef.current?.play(), 100);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0f0f11", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', sans-serif", padding: "24px" }}>
      <div style={{ width: "100%", maxWidth: 560, background: "#18181b", borderRadius: 20, padding: "40px 36px", boxShadow: "0 0 60px rgba(0,0,0,0.6)" }}>

        <div style={{ marginBottom: 32, textAlign: "center" }}>
          <div style={{ fontSize: 36, fontWeight: 800, color: "#fff", letterSpacing: "-1px" }}>
            Motor <span style={{ color: "#a855f7" }}>Lolo CD</span>
          </div>
          <div style={{ marginTop: 6, color: "#71717a", fontSize: 14 }}>
            Texto a voz · Servidor hace todo · Celular solo escucha
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", color: "#a1a1aa", fontSize: 13, marginBottom: 8, fontWeight: 500 }}>VOZ</label>
          <select
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            style={{ width: "100%", background: "#27272a", color: "#fff", border: "1px solid #3f3f46", borderRadius: 10, padding: "10px 14px", fontSize: 14, outline: "none", cursor: "pointer" }}
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", color: "#a1a1aa", fontSize: 13, marginBottom: 8, fontWeight: 500 }}>
            TEXTO <span style={{ color: "#52525b" }}>({texto.length}/5000)</span>
          </label>
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="Escribí acá lo que querés que diga..."
            maxLength={5000}
            rows={6}
            style={{ width: "100%", background: "#27272a", color: "#fff", border: "1px solid #3f3f46", borderRadius: 10, padding: "12px 14px", fontSize: 15, outline: "none", resize: "vertical", lineHeight: 1.6, boxSizing: "border-box" }}
          />
        </div>

        <button
          onClick={generar}
          disabled={loading || !texto.trim()}
          style={{
            width: "100%", padding: "14px", borderRadius: 12, border: "none", cursor: loading || !texto.trim() ? "not-allowed" : "pointer",
            background: loading || !texto.trim() ? "#3f3f46" : "linear-gradient(135deg, #7c3aed, #a855f7)",
            color: "#fff", fontSize: 16, fontWeight: 700, letterSpacing: "0.3px",
            transition: "all 0.2s", opacity: loading || !texto.trim() ? 0.6 : 1,
          }}
        >
          {loading ? "Generando..." : "Generar Audio"}
        </button>

        {error && (
          <div style={{ marginTop: 16, background: "#2d1515", border: "1px solid #7f1d1d", borderRadius: 10, padding: "12px 16px", color: "#fca5a5", fontSize: 14 }}>
            {error}
          </div>
        )}

        {audioUrl && (
          <div style={{ marginTop: 20, background: "#1c1c20", borderRadius: 12, padding: "16px", border: "1px solid #3f3f46" }}>
            <div style={{ color: "#a855f7", fontSize: 13, fontWeight: 600, marginBottom: 10 }}>AUDIO GENERADO</div>
            <audio ref={audioRef} src={audioUrl} controls style={{ width: "100%", borderRadius: 8 }} />
            <a
              href={audioUrl}
              download="lolo_cd_audio.mp3"
              style={{ display: "block", marginTop: 10, textAlign: "center", color: "#71717a", fontSize: 13, textDecoration: "none" }}
            >
              Descargar MP3
            </a>
          </div>
        )}

        <div style={{ marginTop: 28, padding: "14px 16px", background: "#111113", borderRadius: 10, display: "flex", gap: 16, justifyContent: "space-around" }}>
          {[["CPU", "Servidor"], ["0%", "Celular"], ["$0", "Costo"]].map(([val, label]) => (
            <div key={label} style={{ textAlign: "center" }}>
              <div style={{ color: "#a855f7", fontWeight: 800, fontSize: 18 }}>{val}</div>
              <div style={{ color: "#52525b", fontSize: 11, marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
