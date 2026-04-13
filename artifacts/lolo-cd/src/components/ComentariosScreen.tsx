import { useState, useEffect, useRef, useCallback } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Comentario { id: string; autor: string; texto: string; }
type PregenStatus = "pending" | "ready" | "error";

interface Props { voiceId?: string; }

export default function ComentariosScreen({ voiceId = "darwin-piper-patch" }: Props) {
  const [comentarios, setComentarios]     = useState<Comentario[]>([]);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [indiceActual, setIndiceActual]   = useState<number | null>(null);
  const [error, setError]                 = useState<string | null>(null);
  const [nuevoAutor, setNuevoAutor]       = useState("");
  const [nuevoTexto, setNuevoTexto]       = useState("");
  const [enviando, setEnviando]           = useState(false);

  const pregenRef = useRef<Map<string, { url: string; status: PregenStatus }>>(new Map());
  const [pregenVer, setPregenVer] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef(false);
  const urlsRef  = useRef<string[]>([]);

  // ── Cargar comentarios del servidor al montar ─────────────────────────────
  useEffect(() => {
    fetch(`${BASE}/api/comments`)
      .then((r) => r.json())
      .then((data: Comentario[]) => {
        setComentarios(data);
        data.forEach((c) => pregenerar(c.id, c.texto));
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Limpiar audio al salir — cero huellas en el usuario ──────────────────
  useEffect(() => {
    return () => {
      abortRef.current = true;
      audioRef.current?.pause();
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current = [];
      pregenRef.current.clear();
    };
  }, []);

  // ── Pre-genera audio en background ───────────────────────────────────────
  const pregenerar = useCallback(async (id: string, texto: string) => {
    if (pregenRef.current.has(id)) return;
    pregenRef.current.set(id, { url: "", status: "pending" });
    setPregenVer((v) => v + 1);
    try {
      const res = await fetch(`${BASE}/api/tts/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto, voiceId }),
      });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      urlsRef.current.push(url);
      pregenRef.current.set(id, { url, status: "ready" });
    } catch {
      pregenRef.current.set(id, { url: "", status: "error" });
    }
    setPregenVer((v) => v + 1);
  }, [voiceId]);

  // Re-pregenera todo cuando cambia la voz
  useEffect(() => {
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
    pregenRef.current.clear();
    setPregenVer((v) => v + 1);
    comentarios.forEach((c) => pregenerar(c.id, c.texto));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceId]);

  // ── Agregar comentario → servidor → pre-generar ───────────────────────────
  const agregarComentario = async () => {
    const texto = nuevoTexto.trim();
    if (!texto || enviando) return;
    setEnviando(true);
    try {
      const res = await fetch(`${BASE}/api/comments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autor: nuevoAutor.trim() || "Anónimo", texto }),
      });
      const nuevo: Comentario = await res.json();
      setComentarios((prev) => [...prev, nuevo]);
      pregenerar(nuevo.id, nuevo.texto);
      setNuevoAutor(""); setNuevoTexto("");
    } catch { setError("Error al guardar comentario"); }
    finally { setEnviando(false); }
  };

  // ── Eliminar comentario → servidor ────────────────────────────────────────
  const eliminar = async (id: string) => {
    if (reproduciendo) detener();
    const entry = pregenRef.current.get(id);
    if (entry?.url) URL.revokeObjectURL(entry.url);
    pregenRef.current.delete(id);
    setComentarios((prev) => prev.filter((c) => c.id !== id));
    await fetch(`${BASE}/api/comments/${id}`, { method: "DELETE" }).catch(() => {});
  };

  // ── Obtener audio (pre-generado o en el momento) ──────────────────────────
  const obtenerAudio = useCallback(async (c: Comentario): Promise<string> => {
    const entry = pregenRef.current.get(c.id);
    if (entry?.status === "ready" && entry.url) return entry.url;
    const res = await fetch(`${BASE}/api/tts/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texto: c.texto, voiceId }),
    });
    if (!res.ok) throw new Error(`Error TTS: ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    urlsRef.current.push(url);
    pregenRef.current.set(c.id, { url, status: "ready" });
    setPregenVer((v) => v + 1);
    return url;
  }, [voiceId]);

  // ── Reproducción secuencial ───────────────────────────────────────────────
  const leerComentarios = useCallback(async () => {
    if (reproduciendo || comentarios.length === 0) return;
    abortRef.current = false;
    setReproduciendo(true); setError(null);
    for (let i = 0; i < comentarios.length; i++) {
      if (abortRef.current) break;
      setIndiceActual(i);
      try {
        const url = await obtenerAudio(comentarios[i]);
        if (abortRef.current) break;
        await new Promise<void>((resolve, reject) => {
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = resolve;
          audio.onerror = () => reject(new Error("Error reproduciendo"));
          audio.play().catch(reject);
        });
      } catch (e) { if (!abortRef.current) setError((e as Error).message); break; }
    }
    setReproduciendo(false); setIndiceActual(null);
  }, [comentarios, obtenerAudio, reproduciendo]);

  const detener = useCallback(() => {
    abortRef.current = true;
    audioRef.current?.pause();
    setReproduciendo(false); setIndiceActual(null);
  }, []);

  const listos     = comentarios.filter((c) => pregenRef.current.get(c.id)?.status === "ready").length;
  const todosListos = comentarios.length > 0 && listos === comentarios.length;

  return (
    <div style={{ background: "#18181b", borderRadius: 16, padding: "24px", border: "1px solid #27272a" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <span style={{ color: "#a855f7", fontWeight: 700, fontSize: 13, letterSpacing: "0.8px" }}>
            COMENTARIOS {comentarios.length > 0 && `(${comentarios.length})`}
          </span>
          {comentarios.length > 0 && (
            <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 600, color: todosListos ? "#86efac" : "#fde68a" }}>
              {todosListos ? "⚡ Listo — instantáneo" : `⏳ Preparando ${listos}/${comentarios.length}...`}
            </span>
          )}
        </div>
        {reproduciendo
          ? <button onClick={detener} style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer", background: "rgba(239,68,68,0.15)", color: "#fca5a5", fontSize: 13, fontWeight: 600 }}>⏹ Detener</button>
          : <button onClick={leerComentarios} disabled={comentarios.length === 0} style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: comentarios.length > 0 ? "pointer" : "not-allowed", background: comentarios.length > 0 ? "linear-gradient(135deg,#7c3aed,#c026d3)" : "#27272a", color: comentarios.length > 0 ? "#fff" : "#52525b", fontSize: 13, fontWeight: 600 }}>▶ Reproducir</button>
        }
      </div>

      {/* Formulario */}
      <div style={{ background: "#111113", borderRadius: 12, padding: "16px", border: "1px solid #27272a", marginBottom: 16 }}>
        <div style={{ color: "#71717a", fontSize: 11, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>AGREGAR COMENTARIO</div>
        <input value={nuevoAutor} onChange={(e) => setNuevoAutor(e.target.value)} placeholder="Nombre (opcional)"
          style={{ width: "100%", background: "#18181b", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 8, fontFamily: "inherit" }} />
        <textarea value={nuevoTexto} onChange={(e) => setNuevoTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); agregarComentario(); } }}
          placeholder="Escribí el comentario... (Enter para agregar)" rows={2}
          style={{ width: "100%", background: "#18181b", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 13, outline: "none", resize: "vertical", lineHeight: 1.5, boxSizing: "border-box", marginBottom: 10, fontFamily: "inherit" }} />
        <button onClick={agregarComentario} disabled={!nuevoTexto.trim() || enviando}
          style={{ width: "100%", padding: "9px", borderRadius: 8, border: "none", cursor: nuevoTexto.trim() && !enviando ? "pointer" : "not-allowed", background: nuevoTexto.trim() && !enviando ? "rgba(168,85,247,0.15)" : "#18181b", color: nuevoTexto.trim() && !enviando ? "#d8b4fe" : "#3f3f46", fontSize: 13, fontWeight: 600, transition: "all 0.15s" }}>
          {enviando ? "Guardando..." : "+ Agregar"}
        </button>
      </div>

      {error && <div style={{ background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "8px 12px", color: "#fca5a5", fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {/* Lista */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {comentarios.length === 0
          ? <div style={{ color: "#3f3f46", fontSize: 13, textAlign: "center", padding: "20px 0" }}>Sin comentarios — agregá uno arriba</div>
          : comentarios.map((c, i) => {
            const pg = pregenRef.current.get(c.id);
            const isPlaying = indiceActual === i;
            return (
              <div key={c.id} style={{ background: isPlaying ? "rgba(168,85,247,0.08)" : "#111113", border: `1px solid ${isPlaying ? "rgba(168,85,247,0.4)" : "#27272a"}`, borderRadius: 10, padding: "10px 14px", transition: "all 0.2s", display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    {isPlaying && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#a855f7", boxShadow: "0 0 6px #a855f7", flexShrink: 0 }} />}
                    <span style={{ color: "#71717a", fontSize: 11, fontWeight: 600 }}>{c.autor}</span>
                    <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: pg?.status === "ready" ? "#86efac" : pg?.status === "pending" ? "#fde68a" : "#fca5a5" }}>
                      {pg?.status === "ready" ? "⚡" : pg?.status === "pending" ? "⏳" : "✗"}
                    </span>
                  </div>
                  <div style={{ color: "#e4e4e7", fontSize: 14, lineHeight: 1.5 }}>{c.texto}</div>
                </div>
                <button onClick={() => eliminar(c.id)} title="Eliminar"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#3f3f46", fontSize: 16, padding: "2px 4px", flexShrink: 0, lineHeight: 1 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#fca5a5")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#3f3f46")}>×</button>
              </div>
            );
          })
        }
      </div>
    </div>
  );
}
