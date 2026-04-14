import { useState, useEffect, useRef, useCallback } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Comentario { id: string; autor: string; texto: string; sleeping: boolean; }
interface PageResp   { items: Comentario[]; nextCursor: number | null; }
interface ChamberStatus { total_seeds: number; sleeping_in_ram: number; ram_kb: number; disk_audio_kb: number; }

interface Props { voiceId?: string; }

export default function ComentariosScreen({ voiceId = "darwin" }: Props) {
  const [comentarios, setComentarios]       = useState<Comentario[]>([]);
  const [nextCursor, setNextCursor]         = useState<number | null>(null);
  const [cargando, setCargando]             = useState(false);
  const [reproduciendo, setReproduciendo]   = useState(false);
  const [indiceActual, setIndiceActual]     = useState<number | null>(null);
  const [generandoIdx, setGenerandoIdx]     = useState<number | null>(null);
  const [error, setError]                   = useState<string | null>(null);
  const [nuevoAutor, setNuevoAutor]         = useState("");
  const [nuevoTexto, setNuevoTexto]         = useState("");
  const [enviando, setEnviando]             = useState(false);
  const [chamber, setChamber]               = useState<ChamberStatus | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef(false);

  const cargarPagina = useCallback(async (cursor: number | null = null) => {
    if (cargando) return;
    setCargando(true);
    try {
      const url  = cursor
        ? `${BASE}/api/comments?limit=30&cursor=${cursor}`
        : `${BASE}/api/comments?limit=30`;
      const data: PageResp = await fetch(url).then(r => r.json());
      setComentarios(prev => cursor ? [...prev, ...data.items] : data.items);
      setNextCursor(data.nextCursor);
    } catch { /* ignorar */ }
    finally { setCargando(false); }
  }, [cargando]);

  const cargarChamber = useCallback(async () => {
    try {
      const s: ChamberStatus = await fetch(`${BASE}/api/comments/chamber/status`).then(r => r.json());
      setChamber(s);
    } catch { /* ignorar */ }
  }, []);

  useEffect(() => { cargarPagina(null); cargarChamber(); }, []);

  // ── Materializar audio desde RAM (o generar por primera vez) ──────────────
  const materializar = useCallback(async (c: Comentario): Promise<void> => {
    const res = await fetch(
      `${BASE}/api/comments/${c.id}/audio?voiceId=${encodeURIComponent(voiceId)}`
    );
    if (!res.ok) throw new Error(`Error ${res.status}`);

    const chamberState = res.headers.get("x-chamber");
    if (chamberState !== "AWAKE") {
      // Recién generado — marcar como dormido en RAM
      setComentarios(prev => prev.map(x => x.id === c.id ? { ...x, sleeping: true } : x));
      cargarChamber();
    }

    const ct  = res.headers.get("content-type") ?? "audio/wav";
    const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: ct }));
    const audio = new Audio(url);
    audioRef.current = audio;
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Error")); };
      audio.play().catch(reject);
    });
  }, [voiceId, cargarChamber]);

  const reproducirUno = useCallback(async (c: Comentario, idx: number) => {
    if (reproduciendo) return;
    abortRef.current = false;
    setReproduciendo(true);
    setIndiceActual(idx);
    setGenerandoIdx(c.sleeping ? null : idx);
    setError(null);
    try { await materializar(c); }
    catch (e) { if (!abortRef.current) setError((e as Error).message); }
    finally { setReproduciendo(false); setIndiceActual(null); setGenerandoIdx(null); }
  }, [materializar, reproduciendo]);

  const leerTodos = useCallback(async () => {
    if (reproduciendo || comentarios.length === 0) return;
    abortRef.current = false;
    setReproduciendo(true);
    setError(null);
    for (let i = 0; i < comentarios.length; i++) {
      if (abortRef.current) break;
      setIndiceActual(i);
      setGenerandoIdx(comentarios[i].sleeping ? null : i);
      try { await materializar(comentarios[i]); }
      catch (e) { if (!abortRef.current) { setError((e as Error).message); break; } }
      setGenerandoIdx(null);
    }
    setReproduciendo(false);
    setIndiceActual(null);
    setGenerandoIdx(null);
  }, [comentarios, materializar, reproduciendo]);

  const detener = useCallback(() => {
    abortRef.current = true;
    audioRef.current?.pause();
    setReproduciendo(false);
    setIndiceActual(null);
    setGenerandoIdx(null);
  }, []);

  const agregarComentario = async () => {
    const texto = nuevoTexto.trim();
    if (!texto || enviando) return;
    setEnviando(true);
    try {
      const res  = await fetch(`${BASE}/api/comments`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ autor: nuevoAutor.trim() || "Anónimo", texto }),
      });
      const nuevo: Comentario = await res.json();
      setComentarios(prev => [nuevo, ...prev]);
      setNuevoAutor(""); setNuevoTexto("");
      cargarChamber();
    } catch { setError("Error al guardar"); }
    finally { setEnviando(false); }
  };

  const eliminar = async (id: string) => {
    if (reproduciendo) detener();
    setComentarios(prev => prev.filter(c => c.id !== id));
    await fetch(`${BASE}/api/comments/${id}`, { method: "DELETE" }).catch(() => {});
    cargarChamber();
  };

  const durmiendo = comentarios.filter(c => c.sleeping).length;

  return (
    <div style={{ background: "#18181b", borderRadius: 16, padding: "24px", border: "1px solid #27272a" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <span style={{ color: "#a855f7", fontWeight: 700, fontSize: 13, letterSpacing: "0.8px" }}>
            FRASES SEMILLA {comentarios.length > 0 && `· ${comentarios.length}`}
          </span>
          {durmiendo > 0 && (
            <span style={{ marginLeft: 10, fontSize: 11, color: "#c4b5fd", fontWeight: 700 }}>
              💤 {durmiendo} dormidos en RAM
            </span>
          )}
          <div style={{ color: "#3f3f46", fontSize: 10, marginTop: 2 }}>
            texto en disco · audio duerme en RAM · materializa al instante · disco audio: 0 bytes
          </div>
        </div>
        <div>
          {reproduciendo
            ? <button onClick={detener} style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer", background: "rgba(239,68,68,0.15)", color: "#fca5a5", fontSize: 13, fontWeight: 600 }}>⏹ Detener</button>
            : <button onClick={leerTodos} disabled={comentarios.length === 0} style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: comentarios.length > 0 ? "pointer" : "not-allowed", background: comentarios.length > 0 ? "linear-gradient(135deg,#7c3aed,#c026d3)" : "#27272a", color: comentarios.length > 0 ? "#fff" : "#52525b", fontSize: 13, fontWeight: 600 }}>▶ Leer todas</button>
          }
        </div>
      </div>

      {/* Sleep Chamber status */}
      {chamber && (
        <div style={{ background: "#0d0d10", borderRadius: 8, padding: "8px 14px", border: "1px solid #1f1f23", marginBottom: 14, display: "flex", gap: 20, fontSize: 11, flexWrap: "wrap" }}>
          <span style={{ color: "#52525b" }}>💤 RAM: <span style={{ color: "#c4b5fd", fontWeight: 700 }}>{chamber.ram_kb} KB</span></span>
          <span style={{ color: "#52525b" }}>Dormidos: <span style={{ color: "#c4b5fd", fontWeight: 700 }}>{chamber.sleeping_in_ram}</span></span>
          <span style={{ color: "#52525b" }}>Semillas totales: <span style={{ color: "#e4e4e7", fontWeight: 700 }}>{chamber.total_seeds}</span></span>
          <span style={{ color: "#52525b" }}>Disco audio: <span style={{ color: "#86efac", fontWeight: 700 }}>0 bytes</span></span>
        </div>
      )}

      {/* Formulario */}
      <div style={{ background: "#111113", borderRadius: 12, padding: "16px", border: "1px solid #27272a", marginBottom: 16 }}>
        <div style={{ color: "#71717a", fontSize: 11, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>NUEVA FRASE SEMILLA</div>
        <input value={nuevoAutor} onChange={e => setNuevoAutor(e.target.value)} placeholder="Nombre (opcional)"
          style={{ width: "100%", background: "#18181b", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 8, fontFamily: "inherit" }} />
        <textarea value={nuevoTexto} onChange={e => setNuevoTexto(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); agregarComentario(); } }}
          placeholder="Escribí la frase... (Enter para guardar)" rows={2}
          style={{ width: "100%", background: "#18181b", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 13, outline: "none", resize: "vertical", lineHeight: 1.5, boxSizing: "border-box", marginBottom: 10, fontFamily: "inherit" }} />
        <button onClick={agregarComentario} disabled={!nuevoTexto.trim() || enviando}
          style={{ width: "100%", padding: "9px", borderRadius: 8, border: "none", cursor: nuevoTexto.trim() && !enviando ? "pointer" : "not-allowed", background: nuevoTexto.trim() && !enviando ? "rgba(168,85,247,0.15)" : "#18181b", color: nuevoTexto.trim() && !enviando ? "#d8b4fe" : "#3f3f46", fontSize: 13, fontWeight: 600 }}>
          {enviando ? "Guardando..." : "✦ Guardar frase semilla"}
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
            const isPlaying   = indiceActual === i;
            const isGenerando = generandoIdx === i;
            return (
              <div key={c.id} style={{ background: isPlaying ? "rgba(168,85,247,0.08)" : "#111113", border: `1px solid ${isPlaying ? "rgba(168,85,247,0.4)" : "#27272a"}`, borderRadius: 10, padding: "10px 14px", transition: "all 0.2s", display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    {isPlaying && !isGenerando && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#a855f7", boxShadow: "0 0 6px #a855f7", flexShrink: 0 }} />}
                    <span style={{ color: "#71717a", fontSize: 11, fontWeight: 600 }}>{c.autor}</span>
                    {isGenerando
                      ? <span style={{ fontSize: 10, color: "#fde68a", fontWeight: 700 }}>⚡ generando y poniendo a dormir...</span>
                      : c.sleeping
                        ? <span style={{ fontSize: 10, color: "#c4b5fd", fontWeight: 700 }}>💤 dormido en RAM · materializa al instante</span>
                        : <span style={{ fontSize: 10, color: "#52525b" }}>◯ solo texto · primer play genera el audio</span>
                    }
                  </div>
                  <div style={{ color: "#e4e4e7", fontSize: 14, lineHeight: 1.5 }}>{c.texto}</div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                  {!reproduciendo && (
                    <button onClick={() => reproducirUno(c, i)}
                      style={{ background: c.sleeping ? "rgba(196,181,253,0.15)" : "rgba(168,85,247,0.15)", border: `1px solid ${c.sleeping ? "rgba(196,181,253,0.35)" : "rgba(168,85,247,0.3)"}`, cursor: "pointer", color: c.sleeping ? "#c4b5fd" : "#d8b4fe", fontSize: 12, padding: "4px 9px", borderRadius: 6, fontWeight: 700 }}>
                      {c.sleeping ? "💤" : "▶"}
                    </button>
                  )}
                  <button onClick={() => eliminar(c.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#3f3f46", fontSize: 16, padding: "2px 4px", lineHeight: 1 }}
                    onMouseEnter={e => (e.currentTarget.style.color = "#fca5a5")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#3f3f46")}>×</button>
                </div>
              </div>
            );
          })
        }
      </div>

      {nextCursor && (
        <button onClick={() => cargarPagina(nextCursor)} disabled={cargando}
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
