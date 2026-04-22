"""
Servicio TTS persistente — edge_tts + Piper + conversión de voz WORLD.
Motor Darwin: conversión de voz frame a frame por cuantización vectorial.
Puerto: 5000
"""
import io, asyncio, wave, warnings, os
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

LAUGH_REF_PATH = "/home/runner/workspace/attached_assets/descarga_(2)_(1)_1776888865266.wav"

# Perfil silábico de la risa de referencia (extraído UNA sola vez).
# Es un set de instrucciones: "en t=0.05 hay una sílaba de 0.18s, con pitch
# +2 semitonos sobre la mediana y un envelope de energía X".
# CERO audio de la fuente queda guardado — sólo timing + curvas.
_LAUGH_PROFILE = None
_LAUGH_WAV_CACHE = {}


def _extract_laugh_profile():
    """
    Detecta sílabas de la risa de referencia y extrae, para cada una:
      • start_t   — cuándo empieza (s)
      • duration  — cuánto dura  (s)
      • f0_semis  — semitonos de desviación respecto a la mediana global
      • energy    — envolvente de energía normalizada (curva)
    No guarda audio: sólo el "guion" rítmico-melódico de la risa.
    """
    global _LAUGH_PROFILE
    if _LAUGH_PROFILE is not None:
        return _LAUGH_PROFILE
    if not os.path.exists(LAUGH_REF_PATH):
        print(f"[LAUGH-DNA] ⚠ Referencia no encontrada: {LAUGH_REF_PATH}", flush=True)
        return None

    print("[LAUGH-DNA] Extrayendo perfil silábico de la risa de referencia…", flush=True)
    sr = WORLD_SR
    y, _ = librosa.load(LAUGH_REF_PATH, sr=sr, mono=True, duration=20.0)

    # Onsets silábicos — cada "ja" empieza con un ataque marcado
    onset_frames = librosa.onset.onset_detect(
        y=y, sr=sr, hop_length=256, backtrack=True, units="frames"
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=256)
    boundaries  = list(onset_times) + [len(y) / sr]

    # F0 global con WORLD (mejor que YIN para risas)
    y64 = y.astype(np.float64)
    f0, _t = pw.dio(y64, sr)
    f0      = pw.stonemask(y64, f0, _t, sr)
    voiced  = f0[f0 > 0]
    ref_med = float(np.median(voiced)) if len(voiced) else 200.0

    syllables = []
    for i in range(len(boundaries) - 1):
        t0, t1 = float(boundaries[i]), float(boundaries[i + 1])
        dur    = t1 - t0
        if dur < 0.06 or dur > 0.5:
            continue
        s0, s1 = int(t0 * sr), int(t1 * sr)
        seg    = y[s0:s1]
        if len(seg) < 200:
            continue

        # Pitch medio de esta sílaba (semitonos sobre la mediana de la risa)
        f_start = max(0, int(t0 / 0.005))
        f_end   = min(len(f0), int(t1 / 0.005))
        seg_f0  = f0[f_start:f_end]
        seg_v   = seg_f0[seg_f0 > 0]
        f0_semis = (12.0 * float(np.log2(np.median(seg_v) / ref_med))
                    if len(seg_v) and ref_med > 0 else 0.0)

        # Envolvente de energía (RMS) — la "forma" del ja (sube y cae)
        rms = librosa.feature.rms(y=seg, frame_length=256, hop_length=64)[0]
        if rms.max() > 0:
            rms = rms / rms.max()
        # Compactar a 16 puntos para evitar guardar arrays grandes
        env = np.interp(np.linspace(0, 1, 16),
                        np.linspace(0, 1, len(rms)), rms).astype(np.float32)

        syllables.append({
            "start_t":  t0,
            "duration": dur,
            "f0_semis": f0_semis,
            "energy":   env.tolist(),
        })

    _LAUGH_PROFILE = {
        "syllables":     syllables,
        "ref_f0_median": ref_med,
        "total_dur":     float(boundaries[-1]),
    }
    print(f"[LAUGH-DNA] Perfil listo ✓ — {len(syllables)} sílabas, "
          f"dur={_LAUGH_PROFILE['total_dur']:.2f}s", flush=True)
    return _LAUGH_PROFILE


def _synthesize_cloned_laugh(voice_id: str) -> bytes | None:
    """
    Construye la risa SINTETIZANDO "ja" con la voz objetivo y reshapeándolo
    según el perfil de la risa de referencia. La salida contiene 100% audio
    generado por la voz clonada — cero audio de la fuente original.

    Pipeline:
      1) Piper(voz_base) → "ja"           → audio en timbre genérico
      2) Patch(piper_patch) sobre ese ja  → audio en TIMBRE DE LA VOZ CLONADA
      3) Para cada sílaba del perfil:
           - time-stretch a la duración de la sílaba
           - pitch-shift al pitch de la sílaba
           - aplicar la envolvente de energía
      4) Concatenar con los gaps de silencio del perfil original
    """
    if voice_id in _LAUGH_WAV_CACHE:
        return _LAUGH_WAV_CACHE[voice_id]

    profile = _extract_laugh_profile()
    if not profile or not profile["syllables"]:
        return None

    cfg = _PATCHED_VOICES.get(voice_id)
    if not cfg:
        # Sólo soportamos voces piper-patch directamente. XTTS y otras pueden
        # mapear a una voz piper-patch equivalente.
        fallback = {
            "diever":      "lolo-piper-patch",   # ambas son la misma persona
            "darwin-xtts": "darwin-piper-patch",
            "nexus":       "nexus-piper-patch",
            "nexus-ultra": "nexus-piper-patch",
        }.get(voice_id)
        if not fallback:
            print(f"[LAUGH-DNA] Voz '{voice_id}' sin pipeline piper-patch", flush=True)
            return None
        cfg = _PATCHED_VOICES.get(fallback)
        if not cfg:
            return None

    base_model = _piper.get(cfg["base"])
    if not base_model:
        print(f"[LAUGH-DNA] Modelo Piper base '{cfg['base']}' no cargado", flush=True)
        return None

    # ── 1+2) Sintetizar "ja" con la voz objetivo (Piper + patch) ────────────
    base_audio = _wav_from_piper(base_model, "ja.")
    if not base_audio:
        return None
    try:
        mode = cfg.get("mode", "pitch")
        if mode == "world":
            base_audio = _patch_world(base_audio, cfg, voice_name=voice_id)
        else:
            base_audio = _patch_pitch(base_audio, cfg["ref"])
    except Exception as e:
        print(f"[LAUGH-DNA] Error patcheando ja base: {e}", flush=True)
        return None

    y_ja, sr = sf.read(io.BytesIO(base_audio), dtype="float32", always_2d=False)
    if y_ja.ndim > 1:
        y_ja = y_ja.mean(axis=1)

    # Recortar silencios de la "ja." sintetizada para tener una sílaba pura
    try:
        y_ja, _idx = librosa.effects.trim(y_ja, top_db=30)
    except Exception:
        pass
    if len(y_ja) < int(sr * 0.05):
        print(f"[LAUGH-DNA] 'ja' base muy corto para '{voice_id}'", flush=True)
        return None

    # F0 mediano de la "ja" base — sirve para calcular shifts relativos
    y_ja64 = y_ja.astype(np.float64)
    f0_ja, _t = pw.dio(y_ja64, sr)
    f0_ja      = pw.stonemask(y_ja64, f0_ja, _t, sr)
    voiced_ja  = f0_ja[f0_ja > 0]
    base_f0    = float(np.median(voiced_ja)) if len(voiced_ja) else 130.0

    # F0 mediano de la voz objetivo (transponemos la mediana de la risa a este)
    voice_f0_target = base_f0   # la "ja" ya viene patcheada al timbre destino

    # ── 3+4) Construir la risa sílaba a sílaba ──────────────────────────────
    out_chunks = []
    cursor_t = 0.0
    for syl in profile["syllables"]:
        gap = syl["start_t"] - cursor_t
        if gap > 0.005:
            out_chunks.append(np.zeros(int(gap * sr), dtype=np.float32))

        target_len = max(int(syl["duration"] * sr), int(0.04 * sr))

        # Time-stretch usando phase vocoder
        rate = max(0.4, min(3.0, len(y_ja) / float(target_len)))
        try:
            y_syl = librosa.effects.time_stretch(y=y_ja, rate=rate)
        except Exception:
            y_syl = (y_ja[:target_len] if len(y_ja) >= target_len
                     else np.pad(y_ja, (0, target_len - len(y_ja))))

        # Pitch-shift al delta semitónico de la sílaba
        n_steps = float(np.clip(syl["f0_semis"], -8.0, 8.0))
        if abs(n_steps) > 0.15:
            try:
                y_syl = librosa.effects.pitch_shift(y=y_syl, sr=sr, n_steps=n_steps)
            except Exception:
                pass

        # Ajustar al largo exacto
        if len(y_syl) > target_len:
            y_syl = y_syl[:target_len]
        elif len(y_syl) < target_len:
            y_syl = np.pad(y_syl, (0, target_len - len(y_syl)))

        # Envolvente de energía: cada "ja" arranca fuerte y cae
        env_pts = np.array(syl["energy"], dtype=np.float32)
        if len(env_pts) > 1:
            env = np.interp(np.linspace(0, 1, len(y_syl)),
                            np.linspace(0, 1, len(env_pts)),
                            env_pts).astype(np.float32)
            # Pequeño fade-in/out para evitar clicks
            fade = max(2, int(0.005 * sr))
            env[:fade]  *= np.linspace(0, 1, fade)
            env[-fade:] *= np.linspace(1, 0, fade)
            y_syl = (y_syl * env).astype(np.float32)

        out_chunks.append(y_syl)
        cursor_t = syl["start_t"] + syl["duration"]

    if not out_chunks:
        return None

    y_out = np.concatenate(out_chunks)
    peak  = float(np.max(np.abs(y_out))) if len(y_out) else 0.0
    if peak > 0:
        y_out = (y_out / peak) * 0.9

    buf = io.BytesIO()
    sf.write(buf, y_out, sr, format="WAV", subtype="PCM_16")
    wav_bytes = buf.getvalue()
    _LAUGH_WAV_CACHE[voice_id] = wav_bytes
    print(f"[LAUGH-DNA] Risa clonada (sílabas) para '{voice_id}' "
          f"({len(wav_bytes)} bytes, {len(y_out)/sr:.2f}s, sr={sr})", flush=True)
    return wav_bytes


@app.post("/laugh-clone")
def laugh_clone():
    """
    Devuelve un WAV de la voz objetivo riéndose, construido sintetizando
    "ja" con esa voz y reshapeándolo según el patrón de la risa de
    referencia. Cuerpo: {"voice": "lolo-piper-patch"}
    """
    d = request.get_json(force=True) or {}
    voice_id = (d.get("voice") or "").strip()
    if not voice_id:
        return jsonify({"error": "voice requerido"}), 400
    try:
        wav = _synthesize_cloned_laugh(voice_id)
    except Exception as e:
        return jsonify({"error": f"Error generando risa: {e}"}), 500
    if not wav:
        return jsonify({"error": f"Voz '{voice_id}' no soporta risa clonada"}), 404
    return Response(wav, mimetype="audio/wav",
                    headers={"Cache-Control": "public, max-age=86400"})


# Pre-extraer el perfil al arrancar (en segundo plano)
def _init_laugh_dna():
    try:
        _extract_laugh_profile()
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
    if not os.path.exists(cfg["ref"]):
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
            patched = _patch_pitch(audio, cfg["ref"])
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
