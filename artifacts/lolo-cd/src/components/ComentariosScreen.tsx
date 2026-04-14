import { useState, useEffect, useRef, useCallback } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Comentario {
  id: string;
  autor: string;
  texto: string;
  photonCapsule?: string | null;
  photonBytes?: number | null;
  photonMode?: string | null;
  photonEncoding?: string | null;
}
interface PageResp   { items: Comentario[]; nextCursor: number | null; }
interface Props      { voiceId?: string; }
interface PhotonInfo { encodedText: string; estimatedBytes: number; encoding: string; mode: string; millionThirtySecondEstimateGb: number; durationSeconds: number; }

export default function ComentariosScreen({ voiceId = "darwin" }: Props) {
  const [comentarios, setComentarios]   = useState<Comentario[]>([]);
  const [nextCursor, setNextCursor]     = useState<number | null>(null);
  const [cargando, setCargando]         = useState(false);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [indiceActual, setIndiceActual] = useState<number | null>(null);
  const [materializando, setMaterializando] = useState<number | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const [nuevoAutor, setNuevoAutor]     = useState("");
  const [nuevoTexto, setNuevoTexto]     = useState("");
  const [enviando, setEnviando]         = useState(false);
  const [grabando, setGrabando]         = useState(false);
  const [procesandoPhoton, setProcesandoPhoton] = useState(false);
  const [photonInfo, setPhotonInfo]     = useState<PhotonInfo | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

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
    } catch { }
    finally { setCargando(false); }
  }, [cargando]);

  useEffect(() => { cargarPagina(null); }, []);

  const materializar = useCallback(async (c: Comentario): Promise<void> => {
    const res = await fetch(
      `${BASE}/api/comments/${c.id}/audio?voiceId=${encodeURIComponent(voiceId)}`
    );
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const ct  = res.headers.get("content-type") ?? "audio/wav";
    const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: ct }));
    const audio = new Audio(url);
    audioRef.current = audio;
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Error")); };
      audio.play().catch(reject);
    });
  }, [voiceId]);

  const reproducirUno = useCallback(async (c: Comentario, idx: number) => {
    if (reproduciendo) return;
    abortRef.current = false;
    setReproduciendo(true);
    setIndiceActual(idx);
    setMaterializando(idx);
    setError(null);
    try {
      await materializar(c);
    } catch (e) {
      if (!abortRef.current) setError((e as Error).message);
    } finally {
      setReproduciendo(false);
      setIndiceActual(null);
      setMaterializando(null);
    }
  }, [materializar, reproduciendo]);

  const leerTodos = useCallback(async () => {
    if (reproduciendo || comentarios.length === 0) return;
    abortRef.current = false;
    setReproduciendo(true);
    setError(null);
    for (let i = 0; i < comentarios.length; i++) {
      if (abortRef.current) break;
      setIndiceActual(i);
      setMaterializando(i);
      try { await materializar(comentarios[i]); }
      catch (e) { if (!abortRef.current) { setError((e as Error).message); break; } }
    }
    setReproduciendo(false);
    setIndiceActual(null);
    setMaterializando(null);
  }, [comentarios, materializar, reproduciendo]);

  const detener = useCallback(() => {
    abortRef.current = true;
    audioRef.current?.pause();
    setReproduciendo(false);
    setIndiceActual(null);
    setMaterializando(null);
  }, []);

  const limpiarGrabacion = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setGrabando(false);
  }, []);

  const procesarPhoton = useCallback(async (blob: Blob) => {
    setProcesandoPhoton(true);
    setError(null);
    try {
      const res = await fetch(`${BASE}/api/voice/magic-text?mode=photon`, {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Error Photon");
      const info = data as PhotonInfo;
      setPhotonInfo(info);
      if (!nuevoTexto.trim()) setNuevoTexto("Comentario de voz Photon");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProcesandoPhoton(false);
    }
  }, [nuevoTexto]);

  const empezarGrabacion = async () => {
    if (grabando || procesandoPhoton) return;
    setError(null);
    setPhotonInfo(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        limpiarGrabacion();
        void procesarPhoton(blob);
      };
      recorder.start();
      setGrabando(true);
    } catch {
      setError("No pude acceder al micrófono");
      limpiarGrabacion();
    }
  };

  const pararGrabacion = () => {
    if (mediaRecorderRef.current && grabando) mediaRecorderRef.current.stop();
  };

  const agregarComentario = async () => {
    const texto = nuevoTexto.trim();
    if (!texto || enviando || procesandoPhoton || grabando) return;
    setEnviando(true);
    try {
      const res  = await fetch(`${BASE}/api/comments`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          autor: nuevoAutor.trim() || "Anónimo",
          texto,
          photonCapsule: photonInfo?.encodedText,
          photonBytes: photonInfo?.estimatedBytes,
          photonMode: photonInfo?.mode,
          photonEncoding: photonInfo?.encoding,
        }),
      });
      const nuevo: Comentario = await res.json();
      setComentarios(prev => [nuevo, ...prev]);
      setNuevoAutor("");
      setNuevoTexto("");
      setPhotonInfo(null);
    } catch { setError("Error al guardar"); }
    finally { setEnviando(false); }
  };

  const eliminar = async (id: string) => {
    if (reproduciendo) detener();
    setComentarios(prev => prev.filter(c => c.id !== id));
    await fetch(`${BASE}/api/comments/${id}`, { method: "DELETE" }).catch(() => {});
  };

  const puedeGuardar = !!nuevoTexto.trim() && !!photonInfo && !enviando && !grabando && !procesandoPhoton;

  return (
    <div style={{ background: "#18181b", borderRadius: 16, padding: "24px", border: "1px solid #27272a" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <span style={{ color: "#a855f7", fontWeight: 700, fontSize: 13, letterSpacing: "0.8px" }}>
            COMENTARIOS PHOTON {comentarios.length > 0 && `· ${comentarios.length}`}
          </span>
          <div style={{ color: "#3f3f46", fontSize: 10, marginTop: 2 }}>
            solo Photon · guarda cápsula diminuta · regenera audio · cache temporal sin peso permanente
          </div>
        </div>
        <div>
          {reproduciendo
            ? <button onClick={detener} style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer", background: "rgba(239,68,68,0.15)", color: "#fca5a5", fontSize: 13, fontWeight: 600 }}>
                ⏹ Detener
              </button>
            : <button onClick={leerTodos} disabled={comentarios.length === 0}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: comentarios.length > 0 ? "pointer" : "not-allowed", background: comentarios.length > 0 ? "linear-gradient(135deg,#7c3aed,#c026d3)" : "#27272a", color: comentarios.length > 0 ? "#fff" : "#52525b", fontSize: 13, fontWeight: 600 }}>
                ▶ Leer todas
              </button>
          }
        </div>
      </div>

      <div style={{ background: "#111113", borderRadius: 12, padding: "16px", border: "1px solid #27272a", marginBottom: 16 }}>
        <div style={{ color: "#71717a", fontSize: 11, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>NUEVO COMENTARIO PHOTON</div>
        <input value={nuevoAutor} onChange={e => setNuevoAutor(e.target.value)} placeholder="Nombre (opcional)"
          style={{ width: "100%", background: "#18181b", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 8, fontFamily: "inherit" }} />
        <textarea value={nuevoTexto} onChange={e => setNuevoTexto(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); agregarComentario(); } }}
          placeholder="Escribí qué debe decir el comentario Photon... (grabá una cápsula para poder guardar)" rows={2}
          style={{ width: "100%", background: "#18181b", color: "#e4e4e7", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 13, outline: "none", resize: "vertical", lineHeight: 1.5, boxSizing: "border-box", marginBottom: 10, fontFamily: "inherit" }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          {!grabando
            ? <button onClick={empezarGrabacion} disabled={procesandoPhoton || enviando}
                style={{ padding: "9px", borderRadius: 8, border: "1px solid rgba(34,197,94,0.3)", cursor: procesandoPhoton || enviando ? "not-allowed" : "pointer", background: "rgba(34,197,94,0.12)", color: "#86efac", fontSize: 13, fontWeight: 700 }}>
                ● Grabar cápsula Photon
              </button>
            : <button onClick={pararGrabacion}
                style={{ padding: "9px", borderRadius: 8, border: "1px solid rgba(239,68,68,0.35)", cursor: "pointer", background: "rgba(239,68,68,0.12)", color: "#fca5a5", fontSize: 13, fontWeight: 700 }}>
                ■ Parar y comprimir
              </button>
          }
          <button onClick={() => setPhotonInfo(null)} disabled={!photonInfo || enviando}
            style={{ padding: "9px", borderRadius: 8, border: "1px solid #27272a", cursor: photonInfo && !enviando ? "pointer" : "not-allowed", background: "#18181b", color: photonInfo ? "#a1a1aa" : "#3f3f46", fontSize: 13, fontWeight: 600 }}>
            Limpiar cápsula
          </button>
        </div>
        {grabando && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 10 }}>Grabando audio... hablá hasta 30 segundos y tocá parar.</div>}
        {procesandoPhoton && <div style={{ color: "#d8b4fe", fontSize: 12, marginBottom: 10 }}>Comprimiendo a Photon...</div>}
        {photonInfo && (
          <div style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.25)", borderRadius: 8, padding: "9px 10px", color: "#86efac", fontSize: 12, marginBottom: 10 }}>
            Cápsula lista: {photonInfo.estimatedBytes} bytes · {photonInfo.encodedText} · 100M comentarios ≈ {((photonInfo.estimatedBytes * 100_000_000) / 1_000_000_000).toFixed(2)} GB
          </div>
        )}
        <button onClick={agregarComentario} disabled={!puedeGuardar}
          style={{ width: "100%", padding: "9px", borderRadius: 8, border: "none", cursor: puedeGuardar ? "pointer" : "not-allowed", background: puedeGuardar ? "rgba(168,85,247,0.15)" : "#18181b", color: puedeGuardar ? "#d8b4fe" : "#3f3f46", fontSize: 13, fontWeight: 600 }}>
          {enviando ? "Guardando..." : photonInfo ? "✦ Guardar comentario Photon" : "Grabá una cápsula Photon primero"}
        </button>
      </div>

      {error && (
        <div style={{ background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "8px 12px", color: "#fca5a5", fontSize: 12, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {comentarios.length === 0 && !cargando
          ? <div style={{ color: "#3f3f46", fontSize: 13, textAlign: "center", padding: "20px 0" }}>Sin comentarios — guardá uno arriba</div>
          : comentarios.map((c, i) => {
              const isPlaying      = indiceActual === i;
              const isMaterializando = materializando === i;
              const isPhoton = !!c.photonCapsule;
              return (
                <div key={c.id} style={{ background: isPlaying ? "rgba(168,85,247,0.08)" : "#111113", border: `1px solid ${isPlaying ? "rgba(168,85,247,0.4)" : "#27272a"}`, borderRadius: 10, padding: "10px 14px", transition: "all 0.2s", display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, flexWrap: "wrap" }}>
                      {isPlaying && !isMaterializando && (
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#a855f7", boxShadow: "0 0 6px #a855f7", flexShrink: 0 }} />
                      )}
                      <span style={{ color: "#71717a", fontSize: 11, fontWeight: 600 }}>{c.autor}</span>
                      {isPhoton && (
                        <span style={{ fontSize: 10, color: "#86efac", fontWeight: 800, background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.25)", borderRadius: 5, padding: "1px 6px" }}>PHOTON · {c.photonBytes ?? 27} bytes</span>
                      )}
                      {isMaterializando && (
                        <span style={{ fontSize: 10, color: "#fde68a", fontWeight: 700 }}>◈ regenerando Photon...</span>
                      )}
                    </div>
                    <div style={{ color: "#e4e4e7", fontSize: 14, lineHeight: 1.5 }}>{c.texto}</div>
                    {isPhoton && <div style={{ color: "#3f3f46", fontSize: 10, marginTop: 4, fontFamily: "monospace" }}>{c.photonCapsule}</div>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                    {!reproduciendo && (
                      <button onClick={() => reproducirUno(c, i)}
                        style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.3)", cursor: "pointer", color: "#d8b4fe", fontSize: 12, padding: "4px 9px", borderRadius: 6, fontWeight: 700 }}>
                        ▶
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
          {cargando ? "Cargando..." : "Cargar más comentarios"}
        </button>
      )}

      {cargando && comentarios.length === 0 && (
        <div style={{ color: "#3f3f46", fontSize: 13, textAlign: "center", padding: "20px 0" }}>Cargando...</div>
      )}
    </div>
  );
}
