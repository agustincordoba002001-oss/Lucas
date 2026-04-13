"""
Servicio TTS persistente — edge_tts + Piper + conversión de voz WORLD.
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

# ── Edge → Darwin (Edge TTS + WORLD vocoder de Darwin) ───────────────────────
# Voz base Edge: hombre español latinoamericano de pitch similar a Darwin
_EDGE_DARWIN_BASE  = "es-MX-JorgeNeural"
_EDGE_DARWIN_PITCH = "+0Hz"
_EDGE_DARWIN_RATE  = "+0%"

# Config Darwin (igual que darwin-piper-patch pero sin "base" Piper)
_DARWIN_WORLD_CFG = {
    "refs": _DARWIN_REFS,
    "mode": "world",
}

def _mp3_to_wav_bytes(mp3_bytes: bytes, target_sr: int = WORLD_SR) -> bytes:
    """Convierte MP3 (bytes) a WAV PCM_16 (bytes) usando librosa."""
    y, sr = librosa.load(io.BytesIO(mp3_bytes), sr=target_sr, mono=True)
    out = io.BytesIO()
    sf.write(out, y, target_sr, format="WAV", subtype="PCM_16")
    return out.getvalue()

@app.post("/edge-darwin")
def edge_darwin():
    """Edge TTS → WORLD Darwin: velocidad de Edge, timbre de Darwin."""
    d    = request.get_json(force=True)
    text = (d.get("texto") or "").strip()
    if not text:
        return jsonify({"error": "texto requerido"}), 400

    # 1. Generar con Edge TTS (MP3)
    async def _gen():
        buf = io.BytesIO()
        async for chunk in edge_tts.Communicate(
            text, _EDGE_DARWIN_BASE,
            rate=_EDGE_DARWIN_RATE, pitch=_EDGE_DARWIN_PITCH
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

    # 2. Convertir MP3 → WAV
    try:
        wav_bytes = _mp3_to_wav_bytes(mp3_bytes)
    except Exception as e:
        return jsonify({"error": f"Conversión MP3→WAV falló: {e}"}), 500

    # 3. Aplicar WORLD vocoder con el modelo de Darwin
    try:
        patched = _patch_world(wav_bytes, _DARWIN_WORLD_CFG, voice_name="darwin-piper-patch")
    except Exception as e:
        return jsonify({"error": f"WORLD patch falló: {e}"}), 500

    return Response(patched, mimetype="audio/wav",
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

if __name__ == "__main__":
    print("[TTS-SERVICE] edge_tts + Piper + WORLD listos ✓", flush=True)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
