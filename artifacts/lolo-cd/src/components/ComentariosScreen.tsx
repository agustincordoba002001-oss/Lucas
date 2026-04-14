import { useState, useEffect, useRef, useCallback } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Comentario { id: string; autor: string; texto: string; ghost: boolean; }
interface PageResp   { items: Comentario[]; nextCursor: number | null; }
interface GhostStatus { total_seeds: number; ghosts_alive: number; ghosts_ram_kb: number; }

interface Props { voiceId?: string; }

export default function ComentariosScreen({ voiceId = "darwin" }: Props) {
  const [comentarios, setComentarios]     = useState<Comentario[]>([]);
  const [nextCursor, setNextCursor]       = useState<number | null>(null);
  const [cargando, setCargando]           = useState(false);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [indiceActual, setIndiceActual]   = useState<number | null>(null);
  const [materializandoIdx, setMaterializandoIdx] = useState<number | null>(null);
  const [error, setError]                 = useState<string | null>(null);
  const [nuevoAutor, setNuevoAutor]       = useState("");
  const [nuevoTexto, setNuevoTexto]       = useState("");
  const [enviando, setEnviando]           = useState(false);
  const [ghostStatus, setGhostStatus]     = useState<GhostStatus | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef(false);

  // ── Cargar frases semilla ─────────────────────────────────────────────────
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

  const cargarGhostStatus = useCallback(async () => {
    try {
      const s: GhostStatus = await fetch(`${BASE}/api/comments/ghosts/status`).then(r => r.json());
      setGhostStatus(s);
    } catch { /* ignorar */ }
  }, []);

  useEffect(() => {
    cargarPagina(null);
    cargarGhostStatus();
  }, []);

  // ── GhostSeed: materializar y reproducir ──────────────────────────────────
  const reproducirGhost = useCallback(async (c: Comentario): Promise<void> => {
    const res = await fetch(
      `${BASE}/api/comments/${c.id}/audio?voiceId=${encodeURIComponent(voiceId)}`
    );
    if (!res.ok) throw new Error(`Error ${res.status}`);

    const ghostHit = res.headers.get("x-ghost") === "HIT";

    // Si materializó (era fantasma muerto), actualizar estado local
    if (!ghostHit) {
      setComentarios(prev => prev.map(x => x.id === c.id ? { ...x, ghost: true } : x));
      cargarGhostStatus();
    }

    const ct  = res.headers.get("content-type") ?? "audio/wav";
    const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: ct }));
    const audio = new Audio(url);
    audioRef.current = audio;
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Error reproduciendo")); };
      audio.play().catch(reject);
    });
  }, [voiceId, cargarGhostStatus]);

  // ── Reproducir una sola frase ─────────────────────────────────────────────
  const reproducirUno = useCallback(async (c: Comentario, idx: number) => {
    if (reproduciendo) return;
    abortRef.current = false;
    setReproduciendo(true);
    setIndiceActual(idx);
    setMaterializandoIdx(c.ghost ? null : idx);
    setError(null);
    try {
      await reproducirGhost(c);
    } catch (e) {
      if (!abortRef.current) setError((e as Error).message);
    } finally {
      setReproduciendo(false);
      setIndiceActual(null);
      setMaterializandoIdx(null);
    }
  }, [reproducirGhost, reproduciendo]);

  // ── Leer todas en secuencia ───────────────────────────────────────────────
  const leerTodos = useCallback(async () => {
    if (reproduciendo || comentarios.length === 0) return;
    abortRef.current = false;
    setReproduciendo(true);
    setError(null);
    for (let i = 0; i < comentarios.length; i++) {
      if (abortRef.current) break;
      setIndiceActual(i);
      setMaterializandoIdx(comentarios[i].ghost ? null : i);
      try {
        await reproducirGhost(comentarios[i]);
      } catch (e) {
        if (!abortRef.current) { setError((e as Error).message); break; }
      }
      setMaterializandoIdx(null);
    }
    setReproduciendo(false);
    setIndiceActual(null);
    setMaterializandoIdx(null);
  }, [comentarios, reproducirGhost, reproduciendo]);

  const detener = useCallback(() => {
    abortRef.current = true;
    audioRef.current?.pause();
    setReproduciendo(false);
    setIndiceActual(null);
    setMaterializandoIdx(null);
  }, []);

  // ── Guardar nueva frase semilla ───────────────────────────────────────────
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
      setNuevoAutor("");
      setNuevoTexto("");
      cargarGhostStatus();
    } catch { setError("Error al guardar frase"); }
    finally { setEnviando(false); }
  };

  const eliminar = async (id: string) => {
    if (reproduciendo) detener();
    setComentarios(prev => prev.filter(c => c.id !== id));
    await fetch(`${BASE}/api/comments/${id}`, { method: "DELETE" }).catch(() => {});
    cargarGhostStatus();
  };

  return (
    <div style={{ background: "#18181b", borderRadius: 16, padding: "24px", border: "1px solid #27272a" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <span style={{ color: "#a855f7", fontWeight: 700, fontSize: 13, letterSpacing: "0.8px" }}>
            GHOSTSEED {comentarios.length > 0 && `· ${comentarios.length} frases`}
          </span>
          <div style={{ color: "#3f3f46", fontSize: 10, marginTop: 2 }}>
            texto eterno en disco · audio fantasma en RAM · se evapora solo · cero disco de audio
          </div>
        </div>
        <div>
          {reproduciendo
            ? <button onClick={detener} style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer", background: "rgba(239,68,68,0.15)", color: "#fca5a5", fontSize: 13, fontWeight: 600 }}>⏹ Detener</button>
            : <button onClick={leerTodos} disabled={comentarios.length === 0} style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: comentarios.length > 0 ? "pointer" : "not-allowed", background: comentarios.length > 0 ? "linear-gradient(135deg,#7c3aed,#c026d3)" : "#27272a", color: comentarios.length > 0 ? "#fff" : "#52525b", fontSize: 13, fontWeight: 600 }}>▶ Leer todas</button>
          }
        </div>
      </div>

      {/* Ghost status bar */}
      {ghostStatus && (
        <div style={{ background: "#111113", borderRadius: 8, padding: "8px 12px", border: "1px solid #27272a", marginBottom: 14, display: "flex", gap: 16, fontSize: 11 }}>
          <span style={{ color: "#52525b" }}>
            🌫 <span style={{ color: "#c4b5fd", fontWeight: 700 }}>{ghostStatus.ghosts_alive}</span> fantasmas vivos
          </span>
          <span style={{ color: "#52525b" }}>
            RAM: <span style={{ color: "#c4b5fd", fontWeight: 700 }}>{ghostStatus.ghosts_ram_kb} KB</span>
          </span>
          <span style={{ color: "#52525b" }}>
            Disco audio: <span style={{ color: "#86efac", fontWeight: 700 }}>0 bytes</span>
          </span>
          <span style={{ color: "#52525b" }}>
            Semillas: <span style={{ color: "#e4e4e7", fontWeight: 700 }}>{ghostStatus.total_seeds}</span>
          </span>
        </div>
      )}

      {/* Formulario */}
      <div style={{ background: "#111113", borderRadius: 12, padding: "16px", border: "1px solid #27272a", marginBottom: 16 }}>
        <div style={{ color: "#71717a", fontSize: 11, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>NUEVA FRASE SEMILLA</div>
        <input
          value={nuevoAutor} onChange={e => setNuevoAutor(e.target.value)}
          placeholder="Nombre (opcional)"
          style={{ width: "100%", background: "#18181b", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 8, fontFamily: "inherit" }}
        />
        <textarea
          value={nuevoTexto} onChange={e => setNuevoTexto(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); agregarComentario(); } }}
          placeholder="Escribí la frase... (Enter para guardar)" rows={2}
          style={{ width: "100%", background: "#18181b", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 13, outline: "none", resize: "vertical", lineHeight: 1.5, boxSizing: "border-box", marginBottom: 10, fontFamily: "inherit" }}
        />
        <button
          onClick={agregarComentario} disabled={!nuevoTexto.trim() || enviando}
          style={{ width: "100%", padding: "9px", borderRadius: 8, border: "none", cursor: nuevoTexto.trim() && !enviando ? "pointer" : "not-allowed", background: nuevoTexto.trim() && !enviando ? "rgba(168,85,247,0.15)" : "#18181b", color: nuevoTexto.trim() && !enviando ? "#d8b4fe" : "#3f3f46", fontSize: 13, fontWeight: 600, transition: "all 0.15s" }}>
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
            const isPlaying      = indiceActual === i;
            const isMaterializing = materializandoIdx === i;
            return (
              <div key={c.id} style={{ background: isPlaying ? "rgba(168,85,247,0.08)" : "#111113", border: `1px solid ${isPlaying ? "rgba(168,85,247,0.4)" : "#27272a"}`, borderRadius: 10, padding: "10px 14px", transition: "all 0.2s", display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    {isPlaying && !isMaterializing && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#a855f7", boxShadow: "0 0 6px #a855f7", flexShrink: 0 }} />}
                    <span style={{ color: "#71717a", fontSize: 11, fontWeight: 600 }}>{c.autor}</span>
                    {isMaterializing
                      ? <span style={{ fontSize: 10, color: "#fde68a", fontWeight: 700 }}>⚡ materializando fantasma...</span>
                      : c.ghost
                        ? <span style={{ fontSize: 10, color: "#c4b5fd", fontWeight: 700 }}>🌫 fantasma vivo</span>
                        : <span style={{ fontSize: 10, color: "#52525b" }}>◯ solo texto</span>
                    }
                  </div>
                  <div style={{ color: "#e4e4e7", fontSize: 14, lineHeight: 1.5 }}>{c.texto}</div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                  {!reproduciendo && (
                    <button onClick={() => reproducirUno(c, i)} title="Reproducir"
                      style={{ background: c.ghost ? "rgba(196,181,253,0.15)" : "rgba(168,85,247,0.15)", border: `1px solid ${c.ghost ? "rgba(196,181,253,0.3)" : "rgba(168,85,247,0.3)"}`, cursor: "pointer", color: c.ghost ? "#c4b5fd" : "#d8b4fe", fontSize: 11, padding: "3px 8px", borderRadius: 6 }}>
                      {c.ghost ? "🌫" : "▶"}
                    </button>
                  )}
                  <button onClick={() => eliminar(c.id)} title="Eliminar"
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
