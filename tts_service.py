"""
Servicio TTS persistente — edge_tts + Piper + conversión de voz WORLD.
Motor Darwin: conversión de voz frame a frame por cuantización vectorial.
Puerto: 5000
"""
import io, asyncio, wave, warnings, os, json
warnings.filterwarnings("ignore")

import edge_tts
import librosa
import numpy as np
import soundfile as sf
import pyworld as pw
from flask import Flask, request, Response, jsonify

app = Flask(__name__)

# ── Piper — carga en memoria al arrancar ──────────────────────────────────────
_piper = {}
_PIPER_MODELS = {
    "claude-mx":   "/home/runner/workspace/piper_voices/es_MX-claude-high.onnx",
    "daniela-ar":  "/home/runner/workspace/piper_voices/es_AR-daniela-high.onnx",
    "carlfm-es":   "/home/runner/workspace/piper_voices/es_ES-carlfm-x_low.onnx",
    "davefx-es":   "/home/runner/workspace/piper_voices/es_ES-davefx-medium.onnx",
}

# mode "pitch"  → solo ajuste de tono (librosa, rápido)
# mode "world"  → conversión completa pitch + timbre (WORLD vocoder)
# "refs" acepta lista de WAVs para promediar el modelo espectral (más preciso)
_DARWIN_REFS = [
    "/home/runner/workspace/diever_2_minutos.wav",      # 128s — fuente principal
    "/home/runner/workspace/diever_referencia.wav",     # 20s
    "/home/runner/workspace/voz_clonada_diever.wav",    # 9.5s
    "/home/runner/workspace/diever_muñoz_clonado.wav",  # 5.9s
]
_PATCHED_VOICES = {
    "nexus-piper-patch": {
        "base": "davefx-es",
        "ref":  "/home/runner/workspace/attached_assets/NEXUS_VOZ_OFFLINE_1776028665996.onnx",
        "mode": "pitch",
    },
    "lolo-piper-patch": {
        "base": "davefx-es",
        "ref":  "/home/runner/workspace/attached_assets/clon_lolo_directo_(6)_1776048168673.wav",
        "mode": "pitch",
    },
    "darwin-piper-patch": {
        "base": "davefx-es",
        "refs": _DARWIN_REFS,          # modelo multi-archivo promediado
        "mode": "world",
    },
}

_pitch_cache   = {}   # medianas de pitch para modo "pitch"
_world_cache   = {}   # features WORLD precalculadas por ref_path

# ── Carga de modelos Piper ────────────────────────────────────────────────────
try:
    from piper.voice import PiperVoice
    for name, path in _PIPER_MODELS.items():
        try:
            _piper[name] = PiperVoice.load(path)
            print(f"[TTS-SERVICE] Piper '{name}' listo ✓", flush=True)
        except Exception as e:
            print(f"[TTS-SERVICE] Piper '{name}' error: {e}", flush=True)
except ImportError:
    print("[TTS-SERVICE] piper-tts no instalado, voces Piper no disponibles", flush=True)

# ── Pre-cómputo de features WORLD para cada referencia ───────────────────────
WORLD_SR = 16000

def _load_world_features_single(path: str, max_dur: float = 30.0) -> dict | None:
    """Extrae F0 y envolvente espectral de un solo archivo WAV."""
    if not os.path.exists(path):
        return None
    y, _ = librosa.load(path, sr=WORLD_SR, duration=max_dur)
    y = y.astype(np.float64)
    if len(y) < WORLD_SR * 0.5:
        return None
    f0, t = pw.dio(y, WORLD_SR)
    f0    = pw.stonemask(y, f0, t, WORLD_SR)
    sp    = pw.cheaptrick(y, f0, t, WORLD_SR)
    voiced = f0 > 0
    return {
        "f0_values":   f0[voiced].tolist(),
        "mean_log_sp": np.mean(np.log(sp + 1e-10), axis=0),
        "n_frames":    int(sp.shape[0]),
    }

def _load_world_features(ref_path: str) -> dict:
    """Versión de un solo archivo (compatible hacia atrás)."""
    if ref_path in _world_cache:
        return _world_cache[ref_path]
    print(f"[TTS-SERVICE] Analizando referencia WORLD: {ref_path}", flush=True)
    r = _load_world_features_single(ref_path)
    if r is None:
        return {"f0_median": 150.0, "mean_log_sp": np.zeros(513)}
    f0_median   = float(np.median(r["f0_values"])) if r["f0_values"] else 150.0
    feats = {"f0_median": f0_median, "mean_log_sp": r["mean_log_sp"]}
    _world_cache[ref_path] = feats
    print(f"[TTS-SERVICE] WORLD listo — f0_median={f0_median:.1f} Hz", flush=True)
    return feats

def _load_world_features_multi(paths: list, cache_key: str) -> dict:
    """
    Entrena el modelo espectral promediando múltiples archivos de referencia.
    Cuantos más archivos, más estable y representativa la envolvente espectral.
    """
    if cache_key in _world_cache:
        return _world_cache[cache_key]

    all_f0, all_log_sp, total_frames = [], [], 0
    for p in paths:
        if not os.path.exists(p):
            continue
        print(f"[TTS-SERVICE] Analizando para modelo Darwin: {os.path.basename(p)}", flush=True)
        r = _load_world_features_single(p, max_dur=60.0)
        if r is None:
            continue
        all_f0.extend(r["f0_values"])
        # Promedio ponderado por número de frames
        w = r["n_frames"]
        all_log_sp.append((r["mean_log_sp"], w))
        total_frames += w

    if not all_f0:
        feats = {"f0_median": 150.0, "mean_log_sp": np.zeros(513)}
    else:
        f0_median = float(np.median(all_f0))
        if total_frames > 0:
            mean_log_sp = sum(sp * w for sp, w in all_log_sp) / total_frames
        else:
            mean_log_sp = all_log_sp[0][0]
        feats = {"f0_median": f0_median, "mean_log_sp": mean_log_sp}
        print(f"[TTS-SERVICE] Modelo Darwin listo — f0_median={f0_median:.1f} Hz  frames_totales={total_frames}", flush=True)

    _world_cache[cache_key] = feats
    return feats

# Pre-computar todas las referencias WORLD al arrancar
for _vname, _vcfg in _PATCHED_VOICES.items():
    if _vcfg.get("mode") != "world":
        continue
    try:
        if "refs" in _vcfg:
            _load_world_features_multi(_vcfg["refs"], _vname)
        elif "ref" in _vcfg and os.path.exists(_vcfg["ref"]):
            _load_world_features(_vcfg["ref"])
    except Exception as _e:
        print(f"[TTS-SERVICE] WORLD pre-cómputo error ({_vname}): {_e}", flush=True)

# ── Helpers Piper ─────────────────────────────────────────────────────────────
def _wav_from_piper(model, text):
    chunks = list(model.synthesize(text))
    if not chunks:
        return None
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(chunks[0].sample_channels)
        wf.setsampwidth(chunks[0].sample_width)
        wf.setframerate(chunks[0].sample_rate)
        for chunk in chunks:
            wf.writeframes(chunk.audio_int16_bytes)
    return buf.getvalue()

# ── Conversión modo "pitch" (solo tono, librosa) ──────────────────────────────
def _median_pitch(path_or_audio, sr=22050, is_path=True):
    cache_key = path_or_audio if is_path else None
    if cache_key and cache_key in _pitch_cache:
        return _pitch_cache[cache_key]
    if is_path:
        y, _ = librosa.load(path_or_audio, sr=sr, duration=8.0)
    else:
        y = path_or_audio
        if len(y) > sr * 8:
            y = y[:sr * 8]
    f0    = librosa.yin(y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C7"))
    pitch = float(np.nanmedian(f0)) if f0 is not None else float("nan")
    if cache_key:
        _pitch_cache[cache_key] = pitch
    return pitch

def _patch_pitch(wav_bytes, ref_path):
    y, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    t_pitch = _median_pitch(ref_path, sr=sr, is_path=True)
    s_pitch = _median_pitch(y, sr=sr, is_path=False)
    if np.isfinite(t_pitch) and np.isfinite(s_pitch) and t_pitch > 0 and s_pitch > 0:
        steps = float(np.clip(librosa.hz_to_midi(t_pitch) - librosa.hz_to_midi(s_pitch), -8, 8))
        y = librosa.effects.pitch_shift(y=y, sr=sr, n_steps=steps)
    y = librosa.effects.preemphasis(y, coef=0.97)
    peak = float(np.max(np.abs(y))) if len(y) else 0
    if peak > 0:
        y = (y / peak) * 0.95
    out = io.BytesIO()
    sf.write(out, y, sr, format="WAV", subtype="PCM_16")
    return out.getvalue()

# ── Conversión modo "world" (pitch + timbre, WORLD vocoder) ──────────────────
def _patch_world(wav_bytes, cfg: dict, voice_name: str = ""):
    """
    Convierte pitch Y timbre (envolvente espectral) de la voz Piper
    para que suene como la referencia. Velocidad: ~100-300 ms.
    Soporta ref único o modelo multi-archivo promediado.
    """
    if "refs" in cfg:
        feats = _load_world_features_multi(cfg["refs"], voice_name)
    else:
        feats = _load_world_features(cfg["ref"])

    # Cargar audio Piper y remuestrear a WORLD_SR
    y_src, sr_src = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
    if y_src.ndim > 1:
        y_src = y_src.mean(axis=1)
    if sr_src != WORLD_SR:
        y_src = librosa.resample(y_src, orig_sr=sr_src, target_sr=WORLD_SR)
    y_src = y_src.astype(np.float64)

    # Análisis WORLD de la fuente (Piper)
    f0_src, t_src = pw.dio(y_src, WORLD_SR)
    f0_src        = pw.stonemask(y_src, f0_src, t_src, WORLD_SR)
    sp_src        = pw.cheaptrick(y_src, f0_src, t_src, WORLD_SR)
    ap_src        = pw.d4c(y_src, f0_src, t_src, WORLD_SR)

    # ── Conversión de pitch ──────────────────────────────────────────────────
    voiced = f0_src > 0
    f0_conv = f0_src.copy()
    if voiced.any():
        src_median = float(np.median(f0_src[voiced]))
        ref_median = feats["f0_median"]
        if src_median > 0 and ref_median > 0:
            scale = ref_median / src_median
            scale = float(np.clip(scale, 0.5, 2.0))   # max ±1 octava
            f0_conv[voiced] = f0_src[voiced] * scale

    # ── Transferencia de timbre (envolvente espectral) ───────────────────────
    src_mean_log_sp = np.mean(np.log(sp_src + 1e-10), axis=0)
    sp_ratio        = np.exp(feats["mean_log_sp"] - src_mean_log_sp)
    sp_conv         = np.clip(sp_src * sp_ratio[np.newaxis, :], 1e-10, None)

    # ── Síntesis WORLD ───────────────────────────────────────────────────────
    y_out = pw.synthesize(f0_conv, sp_conv, ap_src, WORLD_SR).astype(np.float32)

    # Remuestrear de vuelta al SR original de Piper
    if WORLD_SR != sr_src:
        y_out = librosa.resample(y_out, orig_sr=WORLD_SR, target_sr=sr_src)
    peak = float(np.max(np.abs(y_out))) if len(y_out) else 0
    if peak > 0:
        y_out = (y_out / peak) * 0.95

    out = io.BytesIO()
    sf.write(out, y_out, sr_src, format="WAV", subtype="PCM_16")
    return out.getvalue()

# ── Motor Darwin VQ — conversión de voz frame a frame ─────────────────────────
#
#  En lugar de aplicar una ratio espectral global (promedio),
#  este motor mapea CADA FRAME del audio fuente al frame de Darwin
#  más parecido en el espacio espectral (vecino más cercano).
#  El resultado usa el timbre exacto de Darwin, fonema a fonema.
#
#  Velocidad total ≈ Edge(~0.3s) + análisis WORLD(~0.2s) + NN(~0.05s) + síntesis(~0.1s)
# ─────────────────────────────────────────────────────────────────────────────

_MOTOR_REFS_LOG_SP = None   # (M, 513) float32 — frames de Darwin en espacio log-SP
_MOTOR_REFS_NORMS  = None   # (M,)     float32 — ||ref||² pre-calculado
_MOTOR_MEAN_AP     = None   # (513,)   float64 — aperiodicidad media de Darwin
_MOTOR_F0_LOG_MEAN = None   # float — log(f0) medio de Darwin
_MOTOR_F0_LOG_STD  = None   # float — log(f0) std de Darwin
_MOTOR_READY       = False


def _build_darwin_motor(paths: list, stride: int = 20) -> None:
    """
    Extrae frames espectrales de los archivos de referencia de Darwin
    y construye el banco de vecinos para conversión frame a frame.

    stride=20 → toma 1 frame de cada 20 (cada 100ms).
    Con ~163s de audio Darwin a 5ms/frame = 32600 frames → ~1630 frames de referencia.
    """
    global _MOTOR_REFS_LOG_SP, _MOTOR_REFS_NORMS
    global _MOTOR_MEAN_AP, _MOTOR_F0_LOG_MEAN, _MOTOR_F0_LOG_STD, _MOTOR_READY

    all_log_sp_sub, all_ap_sub, all_f0_voiced = [], [], []

    for p in paths:
        if not os.path.exists(p):
            continue
        print(f"[MOTOR-DARWIN] Analizando: {os.path.basename(p)}", flush=True)
        try:
            y, _ = librosa.load(p, sr=WORLD_SR, duration=120.0)
            y = y.astype(np.float64)
            if len(y) < WORLD_SR * 0.5:
                continue
            f0, t  = pw.dio(y, WORLD_SR)
            f0     = pw.stonemask(y, f0, t, WORLD_SR)
            sp     = pw.cheaptrick(y, f0, t, WORLD_SR)
            ap     = pw.d4c(y, f0, t, WORLD_SR)
            log_sp = np.log(sp + 1e-10).astype(np.float32)

            all_log_sp_sub.append(log_sp[::stride])
            all_ap_sub.append(ap[::stride])
            voiced_f0 = f0[f0 > 0]
            if len(voiced_f0) > 0:
                all_f0_voiced.append(voiced_f0)
        except Exception as e:
            print(f"[MOTOR-DARWIN] Error en {p}: {e}", flush=True)

    if not all_log_sp_sub:
        print("[MOTOR-DARWIN] Sin referencias — motor no disponible", flush=True)
        return

    refs = np.vstack(all_log_sp_sub).astype(np.float32)           # (M, 513)
    ap_all = np.vstack(all_ap_sub).astype(np.float64)             # (M, 513)

    all_f0_cat = np.concatenate(all_f0_voiced)
    log_f0     = np.log(np.maximum(all_f0_cat, 1.0))

    _MOTOR_REFS_LOG_SP = refs
    _MOTOR_REFS_NORMS  = np.sum(refs ** 2, axis=1)                # (M,)
    _MOTOR_MEAN_AP     = np.mean(ap_all, axis=0)                  # (513,) media Darwin
    _MOTOR_F0_LOG_MEAN = float(np.mean(log_f0))
    _MOTOR_F0_LOG_STD  = float(np.std(log_f0)) or 0.01
    _MOTOR_READY       = True

    print(
        f"[MOTOR-DARWIN] Listo ✓ — {len(refs)} frames de referencia, "
        f"f0_median≈{float(np.exp(_MOTOR_F0_LOG_MEAN)):.1f} Hz",
        flush=True,
    )


def _convert_darwin_motor(wav_bytes: bytes) -> bytes:
    """
    Motor Darwin VQ: convierte cada frame espectral del audio fuente
    al frame de Darwin más cercano. Usa la aperiodicidad media de Darwin
    (evita calcular d4c, ~200ms menos).
    """
    if not _MOTOR_READY:
        return wav_bytes

    y_src, sr_src = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
    if y_src.ndim > 1:
        y_src = y_src.mean(axis=1)

    y_up = (librosa.resample(y_src, orig_sr=sr_src, target_sr=WORLD_SR)
            if sr_src != WORLD_SR else y_src.copy())
    y_up = y_up.astype(np.float64)

    # ── Análisis WORLD fuente (sin d4c para velocidad) ────────────────────────
    f0_src, t_src = pw.dio(y_up, WORLD_SR)
    f0_src        = pw.stonemask(y_up, f0_src, t_src, WORLD_SR)
    sp_src        = pw.cheaptrick(y_up, f0_src, t_src, WORLD_SR)

    n_frames = sp_src.shape[0]

    # ── Búsqueda de vecino más cercano (frame a frame) ────────────────────────
    log_sp_src = np.log(sp_src + 1e-10).astype(np.float32)        # (N, 513)

    refs       = _MOTOR_REFS_LOG_SP                                # (M, 513)
    ref_norms  = _MOTOR_REFS_NORMS                                 # (M,)
    src_norms  = np.sum(log_sp_src ** 2, axis=1)                  # (N,)

    # dist² = ||src||² + ||ref||² - 2·src·refᵀ — cálculo vectorizado (BLAS)
    dot     = log_sp_src @ refs.T                                  # (N, M)
    dists   = src_norms[:, None] + ref_norms[None] - 2.0 * dot    # (N, M)
    nearest = np.argmin(dists, axis=1)                             # (N,)

    # SP convertido: el frame real de Darwin más parecido a cada frame fuente
    sp_conv = np.exp(refs[nearest]).astype(np.float64)             # (N, 513)

    # ── Conversión de pitch (transformación afín en log-F0) ───────────────────
    voiced  = f0_src > 0
    f0_conv = f0_src.copy()
    if voiced.any():
        log_f0_src = np.log(np.maximum(f0_src[voiced], 1.0))
        src_lmean  = float(np.mean(log_f0_src))
        src_lstd   = float(np.std(log_f0_src)) or 0.01
        # Preserva la entonación (forma) pero la traslada al rango de Darwin
        f0_conv[voiced] = np.exp(
            _MOTOR_F0_LOG_MEAN
            + _MOTOR_F0_LOG_STD * (log_f0_src - src_lmean) / src_lstd
        )
        f0_conv[voiced] = np.clip(f0_conv[voiced], 60.0, 520.0)

    # ── Aperiodicidad de Darwin (media del corpus, sin d4c al vuelo) ──────────
    ap_darwin = np.tile(_MOTOR_MEAN_AP, (n_frames, 1))             # (N, 513)

    # ── Síntesis WORLD ────────────────────────────────────────────────────────
    y_out = pw.synthesize(f0_conv, sp_conv, ap_darwin, WORLD_SR).astype(np.float32)

    if WORLD_SR != sr_src:
        y_out = librosa.resample(y_out, orig_sr=WORLD_SR, target_sr=sr_src)

    peak = float(np.max(np.abs(y_out))) if len(y_out) else 0.0
    if peak > 0:
        y_out = (y_out / peak) * 0.92

    out = io.BytesIO()
    sf.write(out, y_out, sr_src, format="WAV", subtype="PCM_16")
    return out.getvalue()


# Construir el motor al arrancar (en hilo aparte para no bloquear la API)
import threading as _threading

def _init_motor():
    try:
        _build_darwin_motor(_DARWIN_REFS, stride=20)
    except Exception as e:
        print(f"[MOTOR-DARWIN] Error al construir: {e}", flush=True)

_threading.Thread(target=_init_motor, daemon=True).start()


# ── Edge → Darwin (Motor Darwin VQ) ──────────────────────────────────────────
_EDGE_DARWIN_BASE  = "es-MX-JorgeNeural"
_EDGE_DARWIN_PITCH = "+0Hz"
_EDGE_DARWIN_RATE  = "+0%"


def _mp3_to_wav_bytes(mp3_bytes: bytes, target_sr: int = WORLD_SR) -> bytes:
    """Convierte MP3 (bytes) a WAV PCM_16 (bytes) usando librosa."""
    y, sr = librosa.load(io.BytesIO(mp3_bytes), sr=target_sr, mono=True)
    out = io.BytesIO()
    sf.write(out, y, target_sr, format="WAV", subtype="PCM_16")
    return out.getvalue()


@app.post("/edge-darwin")
def edge_darwin():
    """
    Motor Darwin VQ: Edge TTS → mapeo espectral frame a frame a la voz de Darwin.
    Usa vecino más cercano en espacio log-SP para transferencia de timbre exacta.
    """
    d    = request.get_json(force=True)
    text = (d.get("texto") or "").strip()
    if not text:
        return jsonify({"error": "texto requerido"}), 400

    # 1. Edge TTS → MP3
    async def _gen():
        buf = io.BytesIO()
        async for chunk in edge_tts.Communicate(
            text, _EDGE_DARWIN_BASE,
            rate=_EDGE_DARWIN_RATE, pitch=_EDGE_DARWIN_PITCH,
        ).stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        return buf.getvalue()

    try:
        mp3_bytes = asyncio.run(_gen())
        if not mp3_bytes:
            return jsonify({"error": "Edge TTS no generó audio"}), 500
    except Exception as e:
        return jsonify({"error": f"Edge TTS falló: {e}"}), 500

    # 2. MP3 → WAV
    try:
        wav_bytes = _mp3_to_wav_bytes(mp3_bytes)
    except Exception as e:
        return jsonify({"error": f"Conversión MP3→WAV falló: {e}"}), 500

    # 3. Motor Darwin VQ: mapeo frame a frame
    if _MOTOR_READY:
        try:
            wav_bytes = _convert_darwin_motor(wav_bytes)
        except Exception as e:
            print(f"[MOTOR-DARWIN] Conversión falló, devolviendo audio sin convertir: {e}", flush=True)
    else:
        print("[MOTOR-DARWIN] Aún inicializando, devolviendo Edge sin convertir", flush=True)

    return Response(wav_bytes, mimetype="audio/wav",
                    headers={"Cache-Control": "no-store"})

# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "piper":   list(_piper.keys()),
        "patched": list(_PATCHED_VOICES.keys()),
        "world_ready": list(_world_cache.keys()),
    })

# ── Edge TTS ──────────────────────────────────────────────────────────────────
@app.post("/edge")
def edge():
    d     = request.get_json(force=True)
    text  = (d.get("texto") or "").strip()
    voice = d.get("voice",  "es-CO-GonzaloNeural")
    pitch = d.get("pitch",  "+0Hz")
    rate  = d.get("rate",   "+0%")
    if not text:
        return jsonify({"error": "texto requerido"}), 400

    async def _gen():
        buf = io.BytesIO()
        async for chunk in edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        return buf.getvalue()

    audio = asyncio.run(_gen())
    return Response(audio, mimetype="audio/mpeg",
                    headers={"Cache-Control": "no-store"})

# ── Piper TTS ─────────────────────────────────────────────────────────────────
@app.post("/piper")
def piper():
    d     = request.get_json(force=True)
    text  = (d.get("texto") or "").strip()
    voice = d.get("voice", "claude-mx")
    if not text:
        return jsonify({"error": "texto requerido"}), 400
    model = _piper.get(voice)
    if not model:
        return jsonify({"error": f"Voz piper '{voice}' no disponible"}), 404
    audio = _wav_from_piper(model, text)
    if not audio:
        return jsonify({"error": "Sin audio generado"}), 500
    return Response(audio, mimetype="audio/wav",
                    headers={"Cache-Control": "no-store"})

# ══════════════════════════════════════════════════════════════════════════════
#  MOTOR DE RISA CLONADA  ·  "Laughter DNA Transfer"
#
#  La idea: una risa real tiene 3 capas en el dominio WORLD:
#    1) F0 (curva de pitch)     → la MELODÍA del "ja-ja-ja" (sube y baja)
#    2) Aperiodicidad (AP)      → la RESPIRACIÓN / el aire del "ha"
#    3) Envolvente espectral SP → el TIMBRE de quién se ríe (formantes)
#
#  Las dos primeras (F0 + AP) son las que hacen que algo "suene a risa".
#  La tercera es lo que identifica QUIÉN está riendo.
#
#  Lo que hacemos:
#    • Tomamos F0 + AP de la risa de referencia (la "forma" de la risa)
#    • La transponemos al rango de pitch de la voz objetivo (Lolo, Darwin…)
#    • Reemplazamos su SP media por la SP media de la voz objetivo
#      (manteniendo la variación relativa de formantes — los "ja"-"ji"-"je")
#    • Sintetizamos con WORLD → tu voz clonada riéndose con esa cadencia
#
#  Cero audio de la fuente original en la salida: sólo el "patrón rítmico-
#  melódico-respiratorio" de la risa, ejecutado por el timbre del clon.
# ══════════════════════════════════════════════════════════════════════════════

# Registro de risas de referencia. Cada una es una "huella melódica-respiratoria"
# distinta — el timbre se reemplaza siempre por el de la voz destino, así que la
# salida nunca contiene la voz original de la risa.
_LAUGH_REFS = {
    "default": "/home/runner/workspace/attached_assets/descarga_(2)_(1)_1776888865266.wav",
    "katja":   "/home/runner/workspace/attached_assets/katjasavia-female-sensual-laughter-218077_1777148503594.mp3",
}
_DEFAULT_LAUGH_REF = "default"

# Análisis WORLD COMPLETO de cada risa de referencia, cacheado por ref_id.
# F0+AP encodean "esto suena a risa". SP se reemplazará con frames reales
# de la voz destino (los formantes de la persona original nunca llegan a la salida).
_LAUGH_WORLD: dict[str, dict] = {}
# Bancos de frames espectrales por voz: {voice_id: (refs_log_sp, ref_norms, mean_ap, f0_log_mean, f0_log_std)}
_VOICE_VQ_BANK = {}
_LAUGH_WAV_CACHE = {}


def _analyze_laugh_world(ref_id: str | None = None):
    """Analiza la risa de referencia con WORLD: F0, SP, AP por frame (a 16 kHz)."""
    ref_id = ref_id or _DEFAULT_LAUGH_REF
    if ref_id in _LAUGH_WORLD:
        return _LAUGH_WORLD[ref_id]
    path = _LAUGH_REFS.get(ref_id)
    if not path or not os.path.exists(path):
        print(f"[LAUGH-DNA] ⚠ Referencia '{ref_id}' no encontrada: {path}", flush=True)
        return None
    print(f"[LAUGH-DNA] Analizando dinámica de risa '{ref_id}' (F0 + AP)…", flush=True)
    y, _ = librosa.load(path, sr=WORLD_SR, mono=True, duration=20.0)
    y64 = y.astype(np.float64)
    f0, _t = pw.dio(y64, WORLD_SR)
    f0      = pw.stonemask(y64, f0, _t, WORLD_SR)
    sp      = pw.cheaptrick(y64, f0, _t, WORLD_SR)
    ap      = pw.d4c(y64, f0, _t, WORLD_SR)
    voiced  = f0 > 0
    f0_med  = float(np.median(f0[voiced])) if voiced.any() else 200.0
    feats   = {"f0": f0, "sp": sp, "ap": ap, "f0_median": f0_med}
    _LAUGH_WORLD[ref_id] = feats
    print(f"[LAUGH-DNA] Risa '{ref_id}' analizada ✓ — {sp.shape[0]} frames, "
          f"f0_median={f0_med:.1f} Hz", flush=True)
    return feats


# Cadena rica en vocales para construir el banco de frames de cada voz.
# Cubre los formantes de a/e/i/o/u con ataques tipo "h"/"j" como en una risa.
_VQ_VOWEL_CORPUS = (
    "ja ja ja je je je ji ji ji jo jo jo ju ju ju. "
    "ha ha ha he he he hi hi hi ho ho ho. "
    "la la la le le le li li li lo lo lo. "
    "a, e, i, o, u, aaaa, eeee, iiii, oooo, uuuu."
)


_API_SERVER_URL = os.environ.get("API_SERVER_URL", "http://127.0.0.1:8080")
# Voces cuyo timbre real vive fuera del TTS service (XTTS u otro clon neuronal
# servido por el api-server). Para esas, el banco VQ se construye pidiendo
# audio REAL de esa voz al api-server, no con Piper+WORLD.
_REAL_CLONE_VOICES = {"darwin-xtts"}


def _fetch_clone_audio_from_api(voice_id: str, text: str,
                                timeout: float = 60.0) -> bytes | None:
    """Pide al api-server un WAV con el clon neuronal real de `voice_id`."""
    import urllib.request, urllib.error
    body = json.dumps({"texto": text, "voiceId": voice_id}).encode("utf-8")
    req  = urllib.request.Request(
        f"{_API_SERVER_URL}/api/tts/generate",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except Exception as e:
        print(f"[LAUGH-DNA] No pude pedir audio real de '{voice_id}' al api-server: {e}",
              flush=True)
        return None


def _build_voice_vq_bank(voice_id: str):
    """
    Construye un banco de frames espectrales REALES de la voz objetivo:
      - Para clones neuronales (XTTS): pide al api-server un WAV de la voz
        real diciendo el corpus de vocales.
      - Para voces Piper+patch: sintetiza el corpus con Piper y le aplica
        el patch (WORLD o pitch) a la voz destino.
    Cada frame del banco resultante es un frame REAL del timbre destino.
    """
    if voice_id in _VOICE_VQ_BANK:
        return _VOICE_VQ_BANK[voice_id]

    patched: bytes | None = None

    if voice_id in _REAL_CLONE_VOICES:
        print(f"[LAUGH-DNA] Pidiendo corpus VQ con clon real al api-server "
              f"para '{voice_id}'…", flush=True)
        patched = _fetch_clone_audio_from_api(voice_id, _VQ_VOWEL_CORPUS)
        if not patched:
            print(f"[LAUGH-DNA] Fallback: usaré Piper+patch para '{voice_id}'",
                  flush=True)

    if patched is None:
        cfg = _PATCHED_VOICES.get(voice_id) or _PATCHED_VOICES.get({
            "diever":      "lolo-piper-patch",
            "darwin-xtts": "darwin-piper-patch",
            "nexus":       "nexus-piper-patch",
            "nexus-ultra": "nexus-piper-patch",
        }.get(voice_id, ""))
        if not cfg:
            print(f"[LAUGH-DNA] Sin pipeline piper-patch para '{voice_id}'",
                  flush=True)
            return None

        model = _piper.get(cfg["base"])
        if not model:
            return None

        print(f"[LAUGH-DNA] Construyendo banco de frames para '{voice_id}' "
              f"(Piper+patch)…", flush=True)
        base = _wav_from_piper(model, _VQ_VOWEL_CORPUS)
        if not base:
            return None
        try:
            mode = cfg.get("mode", "pitch")
            if mode == "world":
                patched = _patch_world(base, cfg, voice_name=voice_id)
            else:
                ref_paths = cfg.get("refs") or ([cfg["ref"]] if "ref" in cfg else [])
                primary_ref = next((p for p in ref_paths if os.path.exists(p)), None)
                if not primary_ref:
                    return None
                patched = _patch_pitch(base, primary_ref)
        except Exception as e:
            print(f"[LAUGH-DNA] Error patcheando corpus VQ: {e}", flush=True)
            return None

    y, sr = sf.read(io.BytesIO(patched), dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != WORLD_SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=WORLD_SR)
    y64 = y.astype(np.float64)

    f0, _t = pw.dio(y64, WORLD_SR)
    f0      = pw.stonemask(y64, f0, _t, WORLD_SR)
    sp      = pw.cheaptrick(y64, f0, _t, WORLD_SR)
    ap      = pw.d4c(y64, f0, _t, WORLD_SR)

    voiced = f0 > 0
    if not voiced.any():
        return None

    # Sólo nos quedamos con los frames sonoros (con pitch) — son los que
    # tienen formantes vocálicos útiles. Submuestreo cada 2 frames.
    voiced_idx = np.where(voiced)[0][::2]
    log_sp = np.log(sp[voiced_idx] + 1e-10).astype(np.float32)   # (M, 513)

    bank = {
        "log_sp":    log_sp,
        "norms":     np.sum(log_sp ** 2, axis=1),                # (M,)
        "mean_ap":   np.mean(ap[voiced_idx], axis=0).astype(np.float64),
        "f0_log_mu": float(np.mean(np.log(f0[voiced]))),
        "f0_log_sd": float(np.std(np.log(f0[voiced]))) or 0.01,
        "sr_native": int(sr),
    }
    _VOICE_VQ_BANK[voice_id] = bank
    print(f"[LAUGH-DNA] Banco listo para '{voice_id}' — {len(log_sp)} frames vocálicos", flush=True)
    return bank


# ── Cache de "Darwin diciendo ja je ji jo…" analizado con WORLD ──────────────
# Clave: voice_id → dict con f0/sp/ap a 16 kHz. Esto se construye UNA vez por
# voz pidiéndole un audio real al api-server (XTTS) y guardando los frames
# WORLD para usar como timbre en cualquier risa.
_VOICE_LAUGH_FRAMES: dict[str, dict] = {}

_LAUGH_SYLLABLE_TEXT = "Ja ja ja je je ji ji jo jo, ja je ji jo."


def _build_voice_laugh_frames(voice_id: str) -> dict | None:
    """
    Pide al api-server un WAV REAL del clon (XTTS) diciendo sílabas de risa,
    lo analiza con WORLD y devuelve {f0, sp, ap, sr_native}. Cacheado por voz.
    Estos frames son la "materia prima" del timbre — todos sus formantes son
    reales de la voz objetivo.
    """
    if voice_id in _VOICE_LAUGH_FRAMES:
        return _VOICE_LAUGH_FRAMES[voice_id]

    print(f"[LAUGH-MORPH] Pidiendo sílabas de risa con XTTS real para "
          f"'{voice_id}'…", flush=True)
    wav_bytes = _fetch_clone_audio_from_api(voice_id, _LAUGH_SYLLABLE_TEXT,
                                            timeout=120.0)
    if not wav_bytes:
        print(f"[LAUGH-MORPH] No pude obtener audio real de '{voice_id}'",
              flush=True)
        return None

    y, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    sr_native = int(sr)
    if sr != WORLD_SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=WORLD_SR)
    # Recortá silencios al inicio/fin para que cada frame importe
    try:
        y, _ = librosa.effects.trim(y, top_db=35)
    except Exception:
        pass

    y64 = y.astype(np.float64)
    f0, _t = pw.dio(y64, WORLD_SR)
    f0     = pw.stonemask(y64, f0, _t, WORLD_SR)
    sp     = pw.cheaptrick(y64, f0, _t, WORLD_SR)
    ap     = pw.d4c(y64, f0, _t, WORLD_SR)
    voiced = f0 > 0
    if not voiced.any():
        print(f"[LAUGH-MORPH] Sin frames sonoros en '{voice_id}'", flush=True)
        return None

    feats = {
        "f0": f0, "sp": sp, "ap": ap,
        "f0_med": float(np.median(f0[voiced])),
        "n_frames": int(sp.shape[0]),
        "sr_native": sr_native,
    }
    _VOICE_LAUGH_FRAMES[voice_id] = feats
    print(f"[LAUGH-MORPH] '{voice_id}' → {feats['n_frames']} frames, "
          f"f0_med={feats['f0_med']:.1f} Hz ✓", flush=True)
    return feats


def _synthesize_cloned_laugh(voice_id: str, params: dict | None = None) -> bytes | None:
    """
    MOTOR v2 — morph de F0+AP de una risa humana sobre frames REALES de la voz.

    Pipeline:
      1) XTTS sintetiza al clon (Darwin/etc) diciendo "ja je ji jo…" → WORLD
      2) WORLD analiza la risa de referencia (sólo F0 + AP nos importan)
      3) Mapeamos linealmente N→M frames manteniendo los formantes del clon
      4) Reemplazamos F0 por la curva de la risa (escalada al rango del clon)
      5) Mezclamos AP hacia la risa (lo "respirado")
      6) WORLD resintetiza → la voz dice exactamente sus formantes pero
         siguiendo la melodía y el aire de la risa humana.

    Parámetros:
      • f0_shift_semis  (-6…+3)  — graves/agudos vs el medio del clon
      • f0_var_scale    (0.5…2.5) — chato vs muy expresivo
      • ap_mix          (0.0…1.0) — 1=todo aire de la risa, 0=voz limpia
      • speed           (0.7…1.4) — time-stretch final
      • jitter_semis    (0…1.5)   — vibrato humano sobre la F0
      • frames_limit    (int)     — risita corta (limita a N frames de risa)
    """
    p = params or {}
    f0_shift_semis = float(p.get("f0_shift_semis", -2.0))
    f0_var_scale   = float(p.get("f0_var_scale", 1.0))
    ap_mix         = float(np.clip(p.get("ap_mix", 0.55), 0.0, 1.0))
    speed          = float(np.clip(p.get("speed", 1.0), 0.7, 1.4))
    jitter_semis   = float(np.clip(p.get("jitter_semis", 0.0), 0.0, 1.5))
    frames_limit   = int(p.get("frames_limit", 0))
    laugh_ref      = (p.get("laugh_ref") or _DEFAULT_LAUGH_REF).strip()

    cache_key = ("v2", voice_id, laugh_ref, f0_shift_semis, f0_var_scale,
                 ap_mix, speed, jitter_semis, frames_limit)
    if cache_key in _LAUGH_WAV_CACHE:
        return _LAUGH_WAV_CACHE[cache_key]

    laugh = _analyze_laugh_world(laugh_ref)
    if laugh is None:
        return None
    voice = _build_voice_laugh_frames(voice_id)
    if voice is None:
        return None

    f0_l = laugh["f0"].copy()
    ap_l = laugh["ap"]
    if frames_limit > 0 and frames_limit < len(f0_l):
        f0_l = f0_l[:frames_limit]
        ap_l = ap_l[:frames_limit]
    M = len(f0_l)

    # ── 1) Time-map: frames del clon estirados/comprimidos a M ──────────────
    f0_d, sp_d, ap_d = voice["f0"], voice["sp"], voice["ap"]
    N = voice["n_frames"]
    src_idx = np.linspace(0, N - 1, M).astype(np.int64)
    sp_m = sp_d[src_idx].astype(np.float64)
    ap_d_m = ap_d[src_idx].astype(np.float64)

    # ── 2) F0 nuevo: curva de la risa, reescalada al rango del clon ─────────
    voiced_l = f0_l > 0
    target_med = voice["f0_med"] * (2.0 ** (f0_shift_semis / 12.0))
    f0_new = np.zeros(M, dtype=np.float64)
    if voiced_l.any():
        l_log = np.log(f0_l[voiced_l])
        l_mu  = float(np.mean(l_log))
        l_sd  = float(np.std(l_log)) or 0.01
        # Sólo escalamos los frames sonoros — los unvoiced quedan en 0
        # (WORLD genera respiración a partir del AP).
        f0_new[voiced_l] = np.exp(
            np.log(target_med) + f0_var_scale * (l_log - l_mu)
        )
        if jitter_semis > 0.01:
            rng  = np.random.default_rng(42)
            n_v  = int(np.sum(voiced_l))
            wob  = rng.standard_normal(n_v).cumsum()
            wob  = wob / (np.std(wob) + 1e-9) * jitter_semis
            f0_new[voiced_l] *= 2.0 ** (wob / 12.0)
        f0_new[voiced_l] = np.clip(f0_new[voiced_l], 55.0, 500.0)

    # ── 3) AP: mezcla la respiración del clon con la de la risa ─────────────
    ap_new = np.clip(ap_mix * ap_l.astype(np.float64) +
                     (1.0 - ap_mix) * ap_d_m, 0.0, 1.0)

    # ── 4) Síntesis WORLD con SP del clon (formantes intactos) ──────────────
    y_out = pw.synthesize(f0_new, sp_m, ap_new, WORLD_SR).astype(np.float32)

    # ── 5) Time-stretch final ───────────────────────────────────────────────
    if abs(speed - 1.0) > 0.01:
        try:
            y_out = librosa.effects.time_stretch(y=y_out, rate=speed)
        except Exception:
            pass

    # ── 6) Trim + resample al SR nativo del clon (XTTS=24k) ─────────────────
    try:
        y_out, _ = librosa.effects.trim(y_out, top_db=35)
    except Exception:
        pass
    sr_out = voice["sr_native"]
    if sr_out != WORLD_SR:
        y_out = librosa.resample(y_out, orig_sr=WORLD_SR, target_sr=sr_out)

    peak = float(np.max(np.abs(y_out))) if len(y_out) else 0.0
    if peak > 0:
        y_out = (y_out / peak) * 0.92

    buf = io.BytesIO()
    sf.write(buf, y_out, sr_out, format="WAV", subtype="PCM_16")
    wav_bytes = buf.getvalue()
    _LAUGH_WAV_CACHE[cache_key] = wav_bytes
    print(f"[LAUGH-MORPH] '{voice_id}'/{laugh_ref} shift={f0_shift_semis:+.1f} "
          f"var={f0_var_scale:.2f} ap={ap_mix:.2f} sp={speed:.2f} "
          f"jit={jitter_semis:.2f} → {len(y_out)/sr_out:.2f}s ✓", flush=True)
    return wav_bytes


@app.post("/laugh-clone")
def laugh_clone():
    """
    Devuelve un WAV de la voz objetivo riéndose, construido sintetizando
    "ja" con esa voz y reshapeándolo según el patrón de la risa de
    referencia. Cuerpo: {"voice": "lolo-piper-patch", "laughRef": "katja",
                        "params": {...opcional...}}
    """
    d = request.get_json(force=True) or {}
    voice_id = (d.get("voice") or "").strip()
    if not voice_id:
        return jsonify({"error": "voice requerido"}), 400
    params = dict(d.get("params")) if isinstance(d.get("params"), dict) else {}
    laugh_ref = (d.get("laughRef") or d.get("laugh_ref") or "").strip()
    if laugh_ref:
        if laugh_ref not in _LAUGH_REFS:
            return jsonify({"error": f"laughRef '{laugh_ref}' no registrada",
                            "available": sorted(_LAUGH_REFS.keys())}), 400
        params["laugh_ref"] = laugh_ref
    try:
        wav = _synthesize_cloned_laugh(voice_id, params)
    except Exception as e:
        return jsonify({"error": f"Error generando risa: {e}"}), 500
    if not wav:
        return jsonify({"error": f"Voz '{voice_id}' no soporta risa clonada"}), 404
    return Response(wav, mimetype="audio/wav",
                    headers={"Cache-Control": "public, max-age=86400"})


# Pre-extraer el perfil al arrancar (en segundo plano)
def _init_laugh_dna():
    try:
        _analyze_laugh_world()
    except Exception as e:
        print(f"[LAUGH-DNA] Error inicial: {e}", flush=True)

_threading.Thread(target=_init_laugh_dna, daemon=True).start()


# ── Piper Patch (pitch y/o world) ─────────────────────────────────────────────
@app.post("/piper-patch")
def piper_patch():
    d     = request.get_json(force=True)
    text  = (d.get("texto") or "").strip()
    voice = d.get("voice", "nexus-piper-patch")
    if not text:
        return jsonify({"error": "texto requerido"}), 400

    cfg = _PATCHED_VOICES.get(voice)
    if not cfg:
        return jsonify({"error": f"Parche Piper '{voice}' no disponible"}), 404

    ref_paths = cfg.get("refs") or ([cfg["ref"]] if "ref" in cfg else [])
    primary_ref = next((p for p in ref_paths if os.path.exists(p)), None)
    if not primary_ref:
        return jsonify({"error": "Audio de referencia no disponible"}), 404

    model = _piper.get(cfg["base"])
    if not model:
        return jsonify({"error": f"Base Piper '{cfg['base']}' no disponible"}), 404

    audio = _wav_from_piper(model, text)
    if not audio:
        return jsonify({"error": "Sin audio base generado"}), 500

    try:
        mode = cfg.get("mode", "pitch")
        if mode == "world":
            patched = _patch_world(audio, cfg, voice_name=voice)
        else:
            patched = _patch_pitch(audio, primary_ref)
    except Exception as e:
        return jsonify({"error": f"Error aplicando parche: {e}"}), 500

    return Response(patched, mimetype="audio/wav",
                    headers={"Cache-Control": "no-store"})

# ══════════════════════════════════════════════════════════════════════════════
#  PROSODY FINGERPRINT — sistema único
#
#  El audio tiene dos capas separables:
#    • Timbre  → quién habla (Darwin). Vive en el modelo. No ocupa espacio.
#    • Prosodia → cómo suena ESTA frase (pitch + energía). Único por frase.
#
#  Al darle play por primera vez:
#    texto → TTS completo (~650ms) → audio
#                                     ↓
#                          WORLD extrae F0 + energía
#                                     ↓
#                        comprimir (zlib) → ~300-600 bytes → BD
#
#  Siguientes reproducciones (~200ms):
#    texto → Piper rápido → WORLD análisis → SP Darwin VQ
#         + BD: F0 almacenada → interpolar → sintetizar WORLD
#
#  Storage: ~400-700 bytes/comentario como texto base64 en la BD.
#  1.000.000 comentarios ≈ 400-700 MB — bajo 1 GB.
# ══════════════════════════════════════════════════════════════════════════════

import zlib, struct, base64

_PF_STRIDE   = 4        # downmuestrea F0 de 200 Hz a 50 Hz (cada 4 frames)
_PF_F0_MIN   = 50.0     # Hz mínimo para cuantización (log)
_PF_F0_MAX   = 600.0    # Hz máximo para cuantización (log)
_PF_VERSION  = 2        # versión del formato binario


def _pf_extract(wav_bytes: bytes) -> bytes:
    """
    Extrae la huella prosódica (F0 + energía) de un WAV ya sintetizado.
    Devuelve bytes comprimidos con zlib (~300-600 bytes para 20-30 seg de voz).
    """
    y, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != WORLD_SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=WORLD_SR)
    y = y.astype(np.float64)

    # ── Análisis WORLD ────────────────────────────────────────────────────────
    f0, t = pw.dio(y, WORLD_SR)
    f0    = pw.stonemask(y, f0, t, WORLD_SR)

    # ── Energía RMS frame a frame (ventana 5 ms = WORLD frame period) ─────────
    hop   = max(1, int(WORLD_SR * 0.005))
    n_frames = len(f0)
    energy = np.array([
        float(np.sqrt(np.mean(y[i*hop : i*hop+hop]**2) + 1e-12))
        for i in range(n_frames)
    ], dtype=np.float32)

    # ── Downsampling a 50 Hz ──────────────────────────────────────────────────
    s     = _PF_STRIDE
    f0_ds = f0[::s].astype(np.float32)
    en_ds = energy[::s]
    N     = len(f0_ds)

    # ── Voicing mask como bitfield ────────────────────────────────────────────
    voiced = f0_ds > 0
    n_mask = (N + 7) // 8
    mask   = bytearray(n_mask)
    for i, v in enumerate(voiced):
        if v:
            mask[i // 8] |= (1 << (i % 8))

    # ── Cuantizar F0 a uint8 en escala log ────────────────────────────────────
    lmin, lmax = np.log(_PF_F0_MIN), np.log(_PF_F0_MAX)
    f0_q = np.zeros(N, dtype=np.uint8)
    if voiced.any():
        lf0        = np.log(np.clip(f0_ds[voiced], _PF_F0_MIN, _PF_F0_MAX))
        f0_q[voiced] = np.round((lf0 - lmin) / (lmax - lmin) * 255).astype(np.uint8)

    # ── Cuantizar energía a uint8 ─────────────────────────────────────────────
    e_max = float(np.max(en_ds)) if en_ds.max() > 0 else 1.0
    en_q  = np.round(np.clip(en_ds / e_max, 0, 1) * 255).astype(np.uint8)

    # ── Empaquetar header + datos ─────────────────────────────────────────────
    # header: version(B) + N(I) + WORLD_SR(I) + e_max(f) = 13 bytes
    header  = struct.pack(">BIIf", _PF_VERSION, N, WORLD_SR, e_max)
    payload = header + bytes(mask) + bytes(f0_q) + bytes(en_q)

    return zlib.compress(payload, level=9)


def _pf_synthesize(texto: str, fp_bytes: bytes) -> bytes:
    """
    Reconstruye audio usando la huella prosódica guardada.
    Piper (~50ms) + WORLD análisis (~150ms) + síntesis (~50ms) ≈ 250ms total.
    El timbre es Darwin (del motor). La prosodia es la huella guardada.
    """
    # ── Decodificar huella ────────────────────────────────────────────────────
    payload  = zlib.decompress(fp_bytes)
    hdr_size = struct.calcsize(">BIIf")
    version, N, sr_stored, e_max = struct.unpack_from(">BIIf", payload, 0)
    offset   = hdr_size

    n_mask    = (N + 7) // 8
    mask_data = payload[offset : offset + n_mask];  offset += n_mask
    f0_q      = np.frombuffer(payload[offset : offset + N], dtype=np.uint8).copy(); offset += N
    en_q      = np.frombuffer(payload[offset : offset + N], dtype=np.uint8).copy()

    # Reconstruir voiced mask
    voiced = np.array([(mask_data[i // 8] >> (i % 8)) & 1 for i in range(N)], dtype=bool)

    # Reconstruir F0
    lmin, lmax = np.log(_PF_F0_MIN), np.log(_PF_F0_MAX)
    f0_stored  = np.zeros(N, dtype=np.float64)
    if voiced.any():
        f0_stored[voiced] = np.exp(f0_q[voiced].astype(np.float64) / 255.0 * (lmax - lmin) + lmin)

    # Reconstruir energía
    en_stored = en_q.astype(np.float64) / 255.0 * e_max

    # ── 1. Generar audio base con Piper (rápido, ~50ms) ──────────────────────
    model = _piper.get("davefx-es")
    if model is None:
        raise RuntimeError("Modelo Piper davefx-es no disponible para síntesis prosódica")
    wav_base = _wav_from_piper(model, texto)

    # ── 2. WORLD análisis del audio Piper ────────────────────────────────────
    y_src, sr_src = sf.read(io.BytesIO(wav_base), dtype="float32", always_2d=False)
    if y_src.ndim > 1:
        y_src = y_src.mean(axis=1)
    if sr_src != WORLD_SR:
        y_src = librosa.resample(y_src, orig_sr=sr_src, target_sr=WORLD_SR)
    y_src = y_src.astype(np.float64)

    f0_src, t_src = pw.dio(y_src, WORLD_SR)
    f0_src        = pw.stonemask(y_src, f0_src, t_src, WORLD_SR)
    sp_src        = pw.cheaptrick(y_src, f0_src, t_src, WORLD_SR)
    n_src         = len(f0_src)

    # ── 3. Timbre Darwin VQ (frame a frame, igual que el motor) ──────────────
    if _MOTOR_READY:
        log_sp = np.log(sp_src + 1e-10).astype(np.float32)
        dot    = log_sp @ _MOTOR_REFS_LOG_SP.T
        dists  = (np.sum(log_sp**2, axis=1)[:, None]
                  + _MOTOR_REFS_NORMS[None]
                  - 2.0 * dot)
        sp_conv = np.exp(_MOTOR_REFS_LOG_SP[np.argmin(dists, axis=1)]).astype(np.float64)
    else:
        sp_conv = sp_src

    # ── 4. Interpolar F0 guardada (N puntos) → n_src frames ──────────────────
    x_stored  = np.linspace(0, n_src - 1, N)
    x_full    = np.arange(n_src)
    f0_interp = np.interp(x_full, x_stored, f0_stored)

    # Respetar silencios del Piper original: donde Piper no vocea → silencio
    src_voiced = f0_src > 0
    f0_final   = np.where(src_voiced, np.maximum(f0_interp, 1.0), 0.0)
    f0_final   = np.clip(f0_final, 0.0, 520.0)

    # ── 5. Aperiodicidad Darwin (media del corpus) ────────────────────────────
    ap_darwin = np.tile(_MOTOR_MEAN_AP, (n_src, 1)) if _MOTOR_READY else \
                np.full((n_src, sp_conv.shape[1]), 0.5)

    # ── 6. Síntesis WORLD ────────────────────────────────────────────────────
    y_out = pw.synthesize(f0_final, sp_conv, ap_darwin, WORLD_SR).astype(np.float32)

    # ── 7. Aplicar envolvente de energía (suavizada) ──────────────────────────
    en_interp = np.interp(x_full, x_stored, en_stored).astype(np.float32)
    hop       = max(1, int(WORLD_SR * 0.005))
    for i in range(min(n_src, len(en_interp))):
        s_i = i * hop
        e_i = min(s_i + hop, len(y_out))
        if s_i >= len(y_out):
            break
        chunk = y_out[s_i:e_i]
        cur   = float(np.sqrt(np.mean(chunk**2))) + 1e-9
        tgt   = float(en_interp[i])
        if cur > 0 and tgt > 0:
            y_out[s_i:e_i] *= float(np.clip(tgt / cur, 0.0, 4.0))

    # ── 8. Resample y normalizar ──────────────────────────────────────────────
    if WORLD_SR != sr_src:
        y_out = librosa.resample(y_out, orig_sr=WORLD_SR, target_sr=sr_src)
    peak = float(np.max(np.abs(y_out))) if len(y_out) else 0.0
    if peak > 0:
        y_out = (y_out / peak) * 0.92

    out = io.BytesIO()
    sf.write(out, y_out, sr_src, format="WAV", subtype="PCM_16")
    return out.getvalue()


# ── Endpoints de la huella prosódica ─────────────────────────────────────────

@app.post("/prosody/extract")
def prosody_extract():
    """Extrae la huella prosódica de un WAV ya generado. Devuelve ~300-600 bytes."""
    d       = request.get_json(force=True)
    wav_b64 = (d.get("wav_b64") or "").strip()
    if not wav_b64:
        return jsonify({"error": "wav_b64 requerido"}), 400
    try:
        wav_bytes = base64.b64decode(wav_b64)
        fp        = _pf_extract(wav_bytes)
        fp_b64    = base64.b64encode(fp).decode()
        print(f"[PROSODY] Huella extraída — {len(fp)} bytes comprimidos → {len(fp_b64)} chars b64", flush=True)
        return jsonify({"fingerprint_b64": fp_b64, "compressed_bytes": len(fp)})
    except Exception as e:
        print(f"[PROSODY] Error extrayendo: {e}", flush=True)
        return jsonify({"error": str(e)}), 500


@app.post("/prosody/synthesize")
def prosody_synthesize():
    """Reconstruye audio desde texto + huella prosódica. ~200-250ms."""
    d       = request.get_json(force=True)
    texto   = (d.get("texto") or "").strip()
    fp_b64  = (d.get("fingerprint_b64") or "").strip()
    if not texto or not fp_b64:
        return jsonify({"error": "texto y fingerprint_b64 requeridos"}), 400
    try:
        fp_bytes  = base64.b64decode(fp_b64)
        wav_bytes = _pf_synthesize(texto, fp_bytes)
        return Response(wav_bytes, mimetype="audio/wav",
                        headers={"Cache-Control": "no-store",
                                 "X-Prosody": "FINGERPRINT"})
    except Exception as e:
        print(f"[PROSODY] Error sintetizando: {e}", flush=True)
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("[TTS-SERVICE] edge_tts + Piper + WORLD + Prosody Fingerprint listos ✓", flush=True)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
