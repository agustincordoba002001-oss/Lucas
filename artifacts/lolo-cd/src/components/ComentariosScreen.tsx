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

type PregenStatus = "pending" | "ready" | "error";

const LS_KEY = "lolo_comentarios";

function cargarDesdeLS(): Comentario[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; }
}
function guardarEnLS(cs: Comentario[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cs)); } catch {}
}

export default function ComentariosScreen({ postId, voiceId = "darwin-piper-patch", comentarios: propComentarios }: Props) {
  const [comentarios, setComentarios]     = useState<Comentario[]>(() => propComentarios ?? cargarDesdeLS());
  const [reproduciendo, setReproduciendo] = useState(false);
  const [indiceActual, setIndiceActual]   = useState<number | null>(null);
  const [error, setError]                 = useState<string | null>(null);
  const [nuevoAutor, setNuevoAutor]       = useState("");
  const [nuevoTexto, setNuevoTexto]       = useState("");

  // Pre-generación: id → { url, status }
  const pregenRef  = useRef<Map<string | number, { url: string; status: PregenStatus }>>(new Map());
  const [pregenVer, setPregenVer] = useState(0); // para forzar re-render del estado visual

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef(false);
  const urlsRef  = useRef<string[]>([]);

  // Guardar en localStorage cada vez que cambian los comentarios
  useEffect(() => {
    if (!propComentarios) guardarEnLS(comentarios);
  }, [comentarios, propComentarios]);

  // Al montar: pre-generar audio de los comentarios ya guardados
  useEffect(() => {
    comentarios.forEach((c) => pregenerar(c.id, c.texto));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Carga desde API si no vienen props y localStorage está vacío
  useEffect(() => {
    if (propComentarios) return;
    if (cargarDesdeLS().length > 0) return; // ya hay datos en LS, no pisar
    let activo = true;
    fetch(`${BASE}/api/posts/${postId}/comments`)
      .then((r) => r.json())
      .then((data: Comentario[]) => {
        if (activo) {
          setComentarios(data);
          data.forEach((c) => pregenerar(c.id, c.texto));
        }
      })
      .catch(() => {});
    return () => { activo = false; };
  }, [postId, propComentarios]);

  // Limpieza al salir — solo memoria, los textos quedan en localStorage
  useEffect(() => {
    return () => {
      console.log("Limpiando audio de la memoria (textos guardados)...");
      abortRef.current = true;
      audioRef.current?.pause();
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current = [];
      pregenRef.current.clear();
    };
  }, []);

  // Pre-genera el audio de un comentario en background
  const pregenerar = useCallback(async (id: string | number, texto: string) => {
    if (pregenRef.current.has(id)) return;
    pregenRef.current.set(id, { url: "", status: "pending" });
    setPregenVer((v) => v + 1);
    try {
      const res = await fetch(`${BASE}/api/tts/generate`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ texto, voiceId }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      pregenRef.current.set(id, { url, status: "ready" });
    } catch {
      pregenRef.current.set(id, { url: "", status: "error" });
    }
    setPregenVer((v) => v + 1);
  }, [voiceId]);

  // Cuando cambia voiceId, invalidar todo el caché y re-pregenerar
  useEffect(() => {
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
    pregenRef.current.clear();
    setPregenVer((v) => v + 1);
    comentarios.forEach((c) => pregenerar(c.id, c.texto));
  }, [voiceId]);

  // Agregar comentario y pre-generar inmediatamente
  const agregarComentario = () => {
    const texto = nuevoTexto.trim();
    if (!texto) return;
    const nuevo: Comentario = {
      id:    Date.now(),
      autor: nuevoAutor.trim() || "Anónimo",
      texto,
    };
    setComentarios((prev) => [...prev, nuevo]);
    pregenerar(nuevo.id, nuevo.texto);
    setNuevoAutor("");
    setNuevoTexto("");
  };

  // Eliminar comentario
  const eliminar = (id: string | number) => {
    if (reproduciendo) detener();
    const entry = pregenRef.current.get(id);
    if (entry?.url) URL.revokeObjectURL(entry.url);
    pregenRef.current.delete(id);
    setComentarios((prev) => prev.filter((c) => c.id !== id));
  };

  // Obtener audio: usa pre-generado si está listo, si no genera en el momento
  const obtenerAudio = useCallback(async (c: Comentario): Promise<string> => {
    const entry = pregenRef.current.get(c.id);
    if (entry?.status === "ready" && entry.url) return entry.url;

    // Fallback: generar en el momento
    const res = await fetch(`${BASE}/api/tts/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ texto: c.texto, voiceId }),
    });
    if (!res.ok) throw new Error(`Error TTS: ${res.status}`);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    pregenRef.current.set(c.id, { url, status: "ready" });
    setPregenVer((v) => v + 1);
    return url;
  }, [voiceId]);

  // Reproducción secuencial — sin espera si ya están pre-generados
  const leerComentarios = useCallback(async () => {
    if (reproduciendo || comentarios.length === 0) return;
    abortRef.current = false;
    setReproduciendo(true);
    setError(null);

    for (let i = 0; i < comentarios.length; i++) {
      if (abortRef.current) break;
      setIndiceActual(i);
      try {
        const url = await obtenerAudio(comentarios[i]);
        if (abortRef.current) break;
        await new Promise<void>((resolve, reject) => {
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error("Error reproduciendo"));
          audio.play().catch(reject);
        });
      } catch (e) {
        if (!abortRef.current) setError((e as Error).message);
        break;
      }
    }

    setReproduciendo(false);
    setIndiceActual(null);
  }, [comentarios, obtenerAudio, reproduciendo]);

  const detener = useCallback(() => {
    abortRef.current = true;
    audioRef.current?.pause();
    setReproduciendo(false);
    setIndiceActual(null);
  }, []);

  // Cuántos comentarios tienen audio listo
  const listos = comentarios.filter((c) => pregenRef.current.get(c.id)?.status === "ready").length;
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
            <span style={{
              marginLeft: 10, fontSize: 11, fontWeight: 600,
              color: todosListos ? "#86efac" : "#fde68a",
            }}>
              {todosListos
                ? "⚡ Todo listo — reproducción instantánea"
                : `⏳ Preparando ${listos}/${comentarios.length}...`}
            </span>
          )}
        </div>
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
              ▶ Reproducir
            </button>
          )
        }
      </div>

      {/* Formulario */}
      <div style={{ background: "#111113", borderRadius: 12, padding: "16px", border: "1px solid #27272a", marginBottom: 16 }}>
        <div style={{ color: "#71717a", fontSize: 11, fontWeight: 600, letterSpacing: "0.8px", marginBottom: 10 }}>
          AGREGAR COMENTARIO
        </div>
        <input
          value={nuevoAutor}
          onChange={(e) => setNuevoAutor(e.target.value)}
          placeholder="Nombre (opcional)"
          style={{
            width: "100%", background: "#18181b", color: "#e4e4e7",
            border: "1px solid #27272a", borderRadius: 8,
            padding: "8px 12px", fontSize: 13, outline: "none",
            boxSizing: "border-box", marginBottom: 8, fontFamily: "inherit",
          }}
        />
        <textarea
          value={nuevoTexto}
          onChange={(e) => setNuevoTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); agregarComentario(); } }}
          placeholder="Escribí el comentario... (Enter para agregar)"
          rows={2}
          style={{
            width: "100%", background: "#18181b", color: "#e4e4e7",
            border: "1px solid #27272a", borderRadius: 8,
            padding: "8px 12px", fontSize: 13, outline: "none",
            resize: "vertical", lineHeight: 1.5,
            boxSizing: "border-box", marginBottom: 10, fontFamily: "inherit",
          }}
        />
        <button
          onClick={agregarComentario}
          disabled={!nuevoTexto.trim()}
          style={{
            width: "100%", padding: "9px", borderRadius: 8, border: "none",
            cursor: nuevoTexto.trim() ? "pointer" : "not-allowed",
            background: nuevoTexto.trim() ? "rgba(168,85,247,0.15)" : "#18181b",
            color: nuevoTexto.trim() ? "#d8b4fe" : "#3f3f46",
            fontSize: 13, fontWeight: 600, transition: "all 0.15s",
          }}
        >
          + Agregar
        </button>
      </div>

      {error && (
        <div style={{ background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "8px 12px", color: "#fca5a5", fontSize: 12, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Lista */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {comentarios.length === 0
          ? (
            <div style={{ color: "#3f3f46", fontSize: 13, textAlign: "center", padding: "20px 0" }}>
              Sin comentarios — agregá uno arriba
            </div>
          )
          : comentarios.map((c, i) => {
            const pg = pregenRef.current.get(c.id);
            const isReady   = pg?.status === "ready";
            const isPending = !pg || pg.status === "pending";
            const isPlaying = indiceActual === i;
            return (
              <div key={c.id} style={{
                background: isPlaying ? "rgba(168,85,247,0.08)" : "#111113",
                border: `1px solid ${isPlaying ? "rgba(168,85,247,0.4)" : "#27272a"}`,
                borderRadius: 10, padding: "10px 14px",
                transition: "all 0.2s",
                display: "flex", alignItems: "flex-start", gap: 10,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    {isPlaying && (
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#a855f7", boxShadow: "0 0 6px #a855f7", flexShrink: 0 }} />
                    )}
                    <span style={{ color: "#71717a", fontSize: 11, fontWeight: 600 }}>{c.autor}</span>
                    <span style={{
                      marginLeft: "auto", fontSize: 10, fontWeight: 700,
                      color: isReady ? "#86efac" : isPending ? "#fde68a" : "#fca5a5",
                    }}>
                      {isReady ? "⚡" : isPending ? "⏳" : "✗"}
                    </span>
                  </div>
                  <div style={{ color: "#e4e4e7", fontSize: 14, lineHeight: 1.5 }}>{c.texto}</div>
                </div>
                <button
                  onClick={() => eliminar(c.id)}
                  title="Eliminar"
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: "#3f3f46", fontSize: 16, padding: "2px 4px",
                    flexShrink: 0, lineHeight: 1,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#fca5a5")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#3f3f46")}
                >
                  ×
                </button>
              </div>
            );
          })
        }
      </div>
    </div>
  );
}
