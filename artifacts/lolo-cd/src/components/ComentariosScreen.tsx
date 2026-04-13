import { useState, useEffect, useRef, useCallback } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Comentario { id: string; autor: string; texto: string; }
interface PageResp   { items: Comentario[]; nextCursor: number | null; }

interface Props { voiceId?: string; }

export default function ComentariosScreen({ voiceId = "darwin-piper-patch" }: Props) {
  const [comentarios, setComentarios]     = useState<Comentario[]>([]);
  const [nextCursor, setNextCursor]       = useState<number | null>(null);
  const [cargando, setCargando]           = useState(false);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [indiceActual, setIndiceActual]   = useState<number | null>(null);
  const [generandoIdx, setGenerandoIdx]   = useState<number | null>(null);
  const [error, setError]                 = useState<string | null>(null);
  const [nuevoAutor, setNuevoAutor]       = useState("");
  const [nuevoTexto, setNuevoTexto]       = useState("");
  const [enviando, setEnviando]           = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef(false);

  // ── Cargar página de comentarios ──────────────────────────────────────────
  const cargarPagina = useCallback(async (cursor: number | null = null) => {
    if (cargando) return;
    setCargando(true);
    try {
      const url = cursor
        ? `${BASE}/api/comments?limit=30&cursor=${cursor}`
        : `${BASE}/api/comments?limit=30`;
      const r    = await fetch(url);
      const data: PageResp = await r.json();
      setComentarios(prev => cursor ? [...prev, ...data.items] : data.items);
      setNextCursor(data.nextCursor);
    } catch { /* ignorar */ }
    finally { setCargando(false); }
  }, [cargando]);

  useEffect(() => { cargarPagina(null); }, []);

  // ── Generar audio bajo demanda (0 bytes en disco) ─────────────────────────
  const generarAudio = useCallback(async (texto: string): Promise<HTMLAudioElement> => {
    const res = await fetch(`${BASE}/api/tts/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto, voiceId }),
    });
    if (!res.ok) throw new Error(`Error TTS: ${res.status}`);
    const url   = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    return audio;
  }, [voiceId]);

  // ── Reproducir un comentario individual ───────────────────────────────────
  const reproducirUno = useCallback(async (c: Comentario, idx: number) => {
    if (reproduciendo) return;
    abortRef.current = false;
    setReproduciendo(true);
    setIndiceActual(idx);
    setGenerandoIdx(idx);
    setError(null);
    try {
      const audio = await generarAudio(c.texto);
      if (abortRef.current) { URL.revokeObjectURL(audio.src); return; }
      audioRef.current = audio;
      setGenerandoIdx(null);
      await new Promise<void>((res, rej) => {
        audio.onended = res;
        audio.onerror = () => rej(new Error("Error reproduciendo"));
        audio.play().catch(rej);
      });
    } catch (e) { if (!abortRef.current) setError((e as Error).message); }
    finally { setReproduciendo(false); setIndiceActual(null); setGenerandoIdx(null); }
  }, [generarAudio, reproduciendo]);

  // ── Reproducción secuencial de todos ─────────────────────────────────────
  const leerTodos = useCallback(async () => {
    if (reproduciendo || comentarios.length === 0) return;
    abortRef.current = false;
    setReproduciendo(true);
    setError(null);
    for (let i = 0; i < comentarios.length; i++) {
      if (abortRef.current) break;
      setIndiceActual(i);
      setGenerandoIdx(i);
      try {
        const audio = await generarAudio(comentarios[i].texto);
        if (abortRef.current) { URL.revokeObjectURL(audio.src); break; }
        audioRef.current = audio;
        setGenerandoIdx(null);
        await new Promise<void>((res, rej) => {
          audio.onended = res;
          audio.onerror = () => rej(new Error("Error reproduciendo"));
          audio.play().catch(rej);
        });
      } catch (e) { if (!abortRef.current) { setError((e as Error).message); break; } }
    }
    setReproduciendo(false);
    setIndiceActual(null);
    setGenerandoIdx(null);
  }, [comentarios, generarAudio, reproduciendo]);

  const detener = useCallback(() => {
    abortRef.current = true;
    audioRef.current?.pause();
    setReproduciendo(false);
    setIndiceActual(null);
    setGenerandoIdx(null);
  }, []);

  // ── Agregar comentario ────────────────────────────────────────────────────
  const agregarComentario = async () => {
    const texto = nuevoTexto.trim();
    if (!texto || enviando) return;
    setEnviando(true);
    try {
      const res = await fetch(`${BASE}/api/comments`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ autor: nuevoAutor.trim() || "Anónimo", texto }),
      });
      const nuevo: Comentario = await res.json();
      setComentarios(prev => [nuevo, ...prev]);
      setNuevoAutor("");
      setNuevoTexto("");
    } catch { setError("Error al guardar comentario"); }
    finally { setEnviando(false); }
  };

  // ── Eliminar comentario ───────────────────────────────────────────────────
  const eliminar = async (id: string) => {
    if (reproduciendo) detener();
    setComentarios(prev => prev.filter(c => c.id !== id));
    await fetch(`${BASE}/api/comments/${id}`, { method: "DELETE" }).catch(() => {});
  };

  return (
    <div style={{ background: "#18181b", borderRadius: 16, padding: "24px", border: "1px solid #27272a" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <span style={{ color: "#a855f7", fontWeight: 700, fontSize: 13, letterSpacing: "0.8px" }}>
            FRASES SEMILLA {comentarios.length > 0 && `(${comentarios.length})`}
          </span>
          <div style={{ color: "#3f3f46", fontSize: 10, marginTop: 2 }}>
            texto guardado para siempre · audio generado al instante · 0 bytes en disco
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {reproduciendo
            ? <button onClick={detener} style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer", background: "rgba(239,68,68,0.15)", color: "#fca5a5", fontSize: 13, fontWeight: 600 }}>⏹ Detener</button>
            : <button onClick={leerTodos} disabled={comentarios.length === 0} style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: comentarios.length > 0 ? "pointer" : "not-allowed", background: comentarios.length > 0 ? "linear-gradient(135deg,#7c3aed,#c026d3)" : "#27272a", color: comentarios.length > 0 ? "#fff" : "#52525b", fontSize: 13, fontWeight: 600 }}>▶ Leer todas</button>
          }
        </div>
      </div>

      {/* Formulario */}
      <div style={{ background: "#111113", borderRadius: 12, padding: "16px", border: "1px solid #27272a", marginBottom: 16 }}>
        <div style={{ color: "#71717a", fontSize: 11, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>NUEVA FRASE SEMILLA</div>
        <input
          value={nuevoAutor} onChange={(e) => setNuevoAutor(e.target.value)}
          placeholder="Nombre (opcional)"
          style={{ width: "100%", background: "#18181b", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 8, fontFamily: "inherit" }}
        />
        <textarea
          value={nuevoTexto} onChange={(e) => setNuevoTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); agregarComentario(); } }}
          placeholder="Escribí la frase... (Enter para guardar)" rows={2}
          style={{ width: "100%", background: "#18181b", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 13, outline: "none", resize: "vertical", lineHeight: 1.5, boxSizing: "border-box", marginBottom: 10, fontFamily: "inherit" }}
        />
        <button
          onClick={agregarComentario} disabled={!nuevoTexto.trim() || enviando}
          style={{ width: "100%", padding: "9px", borderRadius: 8, border: "none", cursor: nuevoTexto.trim() && !enviando ? "pointer" : "not-allowed", background: nuevoTexto.trim() && !enviando ? "rgba(168,85,247,0.15)" : "#18181b", color: nuevoTexto.trim() && !enviando ? "#d8b4fe" : "#3f3f46", fontSize: 13, fontWeight: 600, transition: "all 0.15s" }}>
          {enviando ? "Guardando semilla..." : "✦ Guardar frase semilla"}
        </button>
      </div>

      {error && (
        <div style={{ background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "8px 12px", color: "#fca5a5", fontSize: 12, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Lista */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {comentarios.length === 0 && !cargando
          ? <div style={{ color: "#3f3f46", fontSize: 13, textAlign: "center", padding: "20px 0" }}>Sin frases — guardá una arriba</div>
          : comentarios.map((c, i) => {
            const isPlaying    = indiceActual === i;
            const isGenerating = generandoIdx === i;
            return (
              <div key={c.id} style={{ background: isPlaying ? "rgba(168,85,247,0.08)" : "#111113", border: `1px solid ${isPlaying ? "rgba(168,85,247,0.4)" : "#27272a"}`, borderRadius: 10, padding: "10px 14px", transition: "all 0.2s", display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    {isPlaying && !isGenerating && (
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#a855f7", boxShadow: "0 0 6px #a855f7", flexShrink: 0 }} />
                    )}
                    <span style={{ color: "#71717a", fontSize: 11, fontWeight: 600 }}>{c.autor}</span>
                    {isGenerating && (
                      <span style={{ fontSize: 10, color: "#fde68a", fontWeight: 700, animation: "pulse 1s infinite" }}>⏳ generando...</span>
                    )}
                  </div>
                  <div style={{ color: "#e4e4e7", fontSize: 14, lineHeight: 1.5 }}>{c.texto}</div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                  {!reproduciendo && (
                    <button
                      onClick={() => reproducirUno(c, i)}
                      title="Reproducir esta frase"
                      style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.3)", cursor: "pointer", color: "#d8b4fe", fontSize: 12, padding: "3px 8px", borderRadius: 6, lineHeight: 1 }}>
                      ▶
                    </button>
                  )}
                  <button
                    onClick={() => eliminar(c.id)} title="Eliminar"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#3f3f46", fontSize: 16, padding: "2px 4px", lineHeight: 1 }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#fca5a5")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "#3f3f46")}>×</button>
                </div>
              </div>
            );
          })
        }
      </div>

      {/* Cargar más */}
      {nextCursor && (
        <button
          onClick={() => cargarPagina(nextCursor)} disabled={cargando}
          style={{ marginTop: 12, width: "100%", padding: "10px", borderRadius: 8, border: "1px solid #27272a", background: "#111113", color: "#71717a", fontSize: 13, cursor: cargando ? "not-allowed" : "pointer" }}>
          {cargando ? "Cargando..." : "Cargar más frases"}
        </button>
      )}

      {cargando && comentarios.length === 0 && (
        <div style={{ color: "#3f3f46", fontSize: 13, textAlign: "center", padding: "20px 0" }}>Cargando...</div>
      )}
    </div>
  );
}
