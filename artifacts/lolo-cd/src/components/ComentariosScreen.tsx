import { useState, useEffect, useRef, useCallback } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Comentario {
  id: string | number;
  autor: string;
  texto: string;
}

interface Props {
  postId: string | number;
  voiceId?: string;
  comentarios?: Comentario[];
}

export default function ComentariosScreen({ postId, voiceId = "darwin-piper-patch", comentarios: propComentarios }: Props) {
  const [comentarios, setComentarios] = useState<Comentario[]>([]);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [indiceActual, setIndiceActual] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const audioRef    = useRef<HTMLAudioElement | null>(null);
  const abortRef    = useRef(false);
  const urlsRef     = useRef<string[]>([]);

  // ── 1. Carga temporal de comentarios ────────────────────────────────────────
  useEffect(() => {
    if (propComentarios) {
      setComentarios(propComentarios);
      return;
    }
    let activo = true;
    fetch(`${BASE}/api/posts/${postId}/comments`)
      .then((r) => r.json())
      .then((data: Comentario[]) => { if (activo) setComentarios(data); })
      .catch(() => {});
    return () => { activo = false; };
  }, [postId, propComentarios]);

  // ── 4. Limpieza al salir ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      console.log("Limpiando comentarios de la memoria...");
      abortRef.current = true;
      audioRef.current?.pause();
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current = [];
      setComentarios([]);
    };
  }, []);

  // ── TTS: genera audio de un comentario usando el servidor ────────────────────
  const generarAudio = useCallback(async (texto: string): Promise<string> => {
    const res = await fetch(`${BASE}/api/tts/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: `${texto}`, voiceId }),
    });
    if (!res.ok) throw new Error(`Error TTS: ${res.status}`);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    return url;
  }, [voiceId]);

  // ── Reproducción secuencial ───────────────────────────────────────────────────
  const leerComentarios = useCallback(async () => {
    if (reproduciendo || comentarios.length === 0) return;
    abortRef.current = false;
    setReproduciendo(true);
    setError(null);

    for (let i = 0; i < comentarios.length; i++) {
      if (abortRef.current) break;
      setIndiceActual(i);
      try {
        const url = await generarAudio(comentarios[i].texto);
        if (abortRef.current) break;
        await new Promise<void>((resolve, reject) => {
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended  = () => resolve();
          audio.onerror  = () => reject(new Error("Error reproduciendo"));
          audio.play().catch(reject);
        });
      } catch (e) {
        if (!abortRef.current) setError((e as Error).message);
        break;
      }
    }

    setReproduciendo(false);
    setIndiceActual(null);
  }, [comentarios, generarAudio, reproduciendo]);

  const detener = useCallback(() => {
    abortRef.current = true;
    audioRef.current?.pause();
    setReproduciendo(false);
    setIndiceActual(null);
  }, []);

  // ── UI ────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: "#18181b", borderRadius: 16, padding: "24px", border: "1px solid #27272a" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <span style={{ color: "#a855f7", fontWeight: 700, fontSize: 13, letterSpacing: "0.8px" }}>
          COMENTARIOS {comentarios.length > 0 && `(${comentarios.length})`}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          {reproduciendo
            ? (
              <button onClick={detener} style={{
                padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer",
                background: "rgba(239,68,68,0.15)", color: "#fca5a5", fontSize: 13, fontWeight: 600,
              }}>
                ⏹ Detener
              </button>
            ) : (
              <button onClick={leerComentarios} disabled={comentarios.length === 0} style={{
                padding: "8px 16px", borderRadius: 8, border: "none",
                cursor: comentarios.length > 0 ? "pointer" : "not-allowed",
                background: comentarios.length > 0 ? "linear-gradient(135deg,#7c3aed,#c026d3)" : "#27272a",
                color: comentarios.length > 0 ? "#fff" : "#52525b",
                fontSize: 13, fontWeight: 600,
              }}>
                ▶ Reproducir Comentarios
              </button>
            )
          }
        </div>
      </div>

      {error && (
        <div style={{ background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "8px 12px", color: "#fca5a5", fontSize: 12, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {comentarios.length === 0
          ? <div style={{ color: "#3f3f46", fontSize: 13, textAlign: "center", padding: "20px 0" }}>Sin comentarios</div>
          : comentarios.map((c, i) => (
            <div key={c.id} style={{
              background: indiceActual === i ? "rgba(168,85,247,0.08)" : "#111113",
              border: `1px solid ${indiceActual === i ? "rgba(168,85,247,0.4)" : "#27272a"}`,
              borderRadius: 10, padding: "12px 14px",
              transition: "all 0.2s",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                {indiceActual === i && (
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#a855f7", boxShadow: "0 0 6px #a855f7", flexShrink: 0 }} />
                )}
                <span style={{ color: "#71717a", fontSize: 11, fontWeight: 600 }}>{c.autor}</span>
              </div>
              <div style={{ color: "#e4e4e7", fontSize: 14, lineHeight: 1.5 }}>{c.texto}</div>
            </div>
          ))
        }
      </div>
    </div>
  );
}
