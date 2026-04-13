"""
Servicio TTS persistente — edge_tts + Piper.
Mantiene los modelos en memoria para respuesta rápida.
Puerto: 5000
"""
import io, asyncio, wave, warnings, os
warnings.filterwarnings("ignore")

import edge_tts
import librosa
import numpy as np
import soundfile as sf
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
_PATCHED_VOICES = {
    "nexus-piper-patch": {
        "base": "davefx-es",
        "ref": "/home/runner/workspace/attached_assets/NEXUS_VOZ_OFFLINE_1776028665996.onnx",
    },
    "lolo-piper-patch": {
        "base": "davefx-es",
        "ref": "/home/runner/workspace/attached_assets/clon_lolo_directo_(6)_1776048168673.wav",
    },
}
_pitch_cache = {}

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

def _median_pitch(path_or_audio, sr=22050, is_path=True):
    cache_key = path_or_audio if is_path else None
    if cache_key and cache_key in _pitch_cache:
        return _pitch_cache[cache_key]

    if is_path:
        y, _ = librosa.load(path_or_audio, sr=sr, duration=8.0)
    else:
        y = path_or_audio
        max_samples = int(sr * 8.0)
        if len(y) > max_samples:
            y = y[:max_samples]

    f0 = librosa.yin(
        y,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
    )
    pitch = float(np.nanmedian(f0)) if f0 is not None else float("nan")
    if cache_key:
        _pitch_cache[cache_key] = pitch
    return pitch

def _patch_piper_audio(wav_bytes, ref_path):
    y_piper, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
    if y_piper.ndim > 1:
        y_piper = y_piper.mean(axis=1)

    target_pitch = _median_pitch(ref_path, sr=sr, is_path=True)
    source_pitch = _median_pitch(y_piper, sr=sr, is_path=False)

    if np.isfinite(target_pitch) and np.isfinite(source_pitch) and target_pitch > 0 and source_pitch > 0:
        steps = librosa.hz_to_midi(target_pitch) - librosa.hz_to_midi(source_pitch)
        steps = float(np.clip(steps, -8, 8))
        y_piper = librosa.effects.pitch_shift(y=y_piper, sr=sr, n_steps=steps)

    y_final = librosa.effects.preemphasis(y_piper, coef=0.97)
    peak = float(np.max(np.abs(y_final))) if len(y_final) else 0
    if peak > 0:
        y_final = (y_final / peak) * 0.95

    out = io.BytesIO()
    sf.write(out, y_final, sr, format="WAV", subtype="PCM_16")
    return out.getvalue()

# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return jsonify({"ok": True, "piper": list(_piper.keys()), "patched": list(_PATCHED_VOICES.keys())})

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
        patched = _patch_piper_audio(audio, cfg["ref"])
    except Exception as e:
        return jsonify({"error": f"Error aplicando parche: {e}"}), 500

    return Response(patched, mimetype="audio/wav",
                    headers={"Cache-Control": "no-store"})

if __name__ == "__main__":
    print("[TTS-SERVICE] edge_tts + Piper listos ✓", flush=True)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
