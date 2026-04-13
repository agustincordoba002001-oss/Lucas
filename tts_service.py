"""
Servicio TTS persistente — edge_tts + Piper + conversión de voz WORLD.
Puerto: 5000
"""
import io, asyncio, wave, warnings, os, re
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

# ── Risa humana — detección y síntesis ───────────────────────────────────────
# Detecta: jaja, jajaja, jeje, jihi, haha, JAJA, JaJaJa, jjajajaja, etc.
_LAUGH_RE = re.compile(
    r'[jJ]+[aAeEiIoO]+(?:[jJ]+[aAeEiIoO]+)*[jJ]*'        # ja/je/ji/jo variants (jaja, jeje, jiji)
    r'|(?:[hH]+[aAeEiI]+){2,}[hH]*',                      # ha/he/hi — mínimo 2 sílabas (haha, hehe)
    re.IGNORECASE,
)

def _split_laugh_segments(text: str):
    """Devuelve lista de (segmento, es_risa)."""
    result, last = [], 0
    for m in _LAUGH_RE.finditer(text):
        before = text[last:m.start()].strip()
        if before:
            result.append((before, False))
        result.append((m.group(), True))
        last = m.end()
    tail = text[last:].strip()
    if tail:
        result.append((tail, False))
    return result if result else [(text, False)]

def _laugh_count(laugh_str: str) -> int:
    """Cuántos pulsos de risa — mínimo 2, máximo 8."""
    units = re.findall(r'[jJhH]+[aAeEiIoO]+', laugh_str)
    return max(2, min(len(units), 8))

def _concat_wav_bytes(parts: list) -> bytes:
    """Concatena múltiples WAV en uno solo (mismo SR/canales)."""
    if not parts:
        return b""
    if len(parts) == 1:
        return parts[0]
    pcm = b""
    header = None
    for wb in parts:
        with wave.open(io.BytesIO(wb), "rb") as wf:
            if header is None:
                header = (wf.getnchannels(), wf.getsampwidth(), wf.getframerate())
            pcm += wf.readframes(wf.getnframes())
    out = io.BytesIO()
    with wave.open(out, "wb") as wf:
        wf.setnchannels(header[0])
        wf.setsampwidth(header[1])
        wf.setframerate(header[2])
        wf.writeframes(pcm)
    return out.getvalue()

def _gen_laugh_audio(n_ja: int, model, cfg: dict, voice_name: str):
    """
    Risa humana real con timbre de Darwin — sintetizada directamente con WORLD vocoder.

    Estrategia:
      - No usa TTS como base (eso es lo que lo hacía sonar robótico).
      - Construye f0, sp (envolvente espectral de Darwin) y ap (aperiodicidad alta = aspirado)
        frame por frame y los sintetiza con pw.synthesize.
      - Cada "ja" es un burst con: onset aspirado → vocal sonora → cola soplada.
      - El contorno de pitch baja dentro de cada burst y globalmente a lo largo de la risa.
      - La amplitud decrece levemente burst a burst (la risa se apaga).
    """
    FRAME_PERIOD = 5.0   # ms — estándar de WORLD

    feats = _load_world_features_multi(cfg["refs"], voice_name) if "refs" in cfg else _load_world_features(cfg["ref"])
    ref_f0       = feats["f0_median"]          # ~174 Hz para Darwin
    mean_log_sp  = feats["mean_log_sp"]        # (513,) — envolvente espectral
    n_sp_bins    = len(mean_log_sp)            # 513

    darwin_sp_lin = np.exp(mean_log_sp)
    darwin_sp_lin = darwin_sp_lin / (np.mean(darwin_sp_lin) + 1e-10)

    # Realce de formantes vocálicos para "a" — F1 ~800 Hz, F2 ~1200 Hz a 16kHz
    freqs_norm  = np.linspace(0, 1, n_sp_bins)
    laugh_shape = (
        1.0
        + 0.50 * np.exp(-((freqs_norm - 0.100)**2) / 0.004)   # F1
        + 0.35 * np.exp(-((freqs_norm - 0.150)**2) / 0.006)   # F2
        + 0.15 * np.exp(-((freqs_norm - 0.040)**2) / 0.003)   # sub-bajo (cuerpo)
    )
    laugh_sp = darwin_sp_lin * laugh_shape   # (513,)

    rng = np.random.default_rng()

    # Duración en frames de cada burst y pausa
    burst_ms  = rng.integers(200, 260)        # ms por burst (varía un poco)
    gap_ms    = 60                             # ms entre bursts
    burst_f   = int(burst_ms  / FRAME_PERIOD)
    gap_f     = int(gap_ms    / FRAME_PERIOD)
    total_f   = n_ja * (burst_f + gap_f) + 4  # frames totales

    f0_all = np.zeros(total_f,                 dtype=np.float64)
    sp_all = np.ones( (total_f, n_sp_bins),    dtype=np.float64) * 1e-10
    ap_all = np.ones( (total_f, n_sp_bins),    dtype=np.float64) * 0.98  # silencio = todo aperiódico

    for i in range(n_ja):
        fs = i * (burst_f + gap_f)   # frame de inicio del burst
        fe = fs + burst_f

        # ── Contorno de pitch ──────────────────────────────────────────────
        # Global: parte 18 % sobre el f0 de referencia, baja ~20 % al final
        progress  = i / max(n_ja - 1, 1)
        f0_base   = ref_f0 * (1.18 - 0.22 * progress)
        f0_base  += rng.uniform(-6, 6)    # microvariación natural

        t_loc = np.linspace(0, 1, burst_f)
        # Local: dentro del burst el pitch baja 12 % y tiene un leve vibrato
        f0_burst = f0_base * (1.0 + 0.12 * (1 - t_loc) + 0.018 * np.sin(2 * np.pi * 5.5 * t_loc))

        # ── Máscara voiced/unvoiced ────────────────────────────────────────
        onset_unvoiced  = max(2, int(burst_f * 0.08))   # aspiración al inicio
        offset_unvoiced = max(2, int(burst_f * 0.18))   # aspiración al final
        voiced_mask = np.zeros(burst_f, dtype=bool)
        voiced_mask[onset_unvoiced : burst_f - offset_unvoiced] = True

        f0_all[fs:fe] = np.where(voiced_mask, f0_burst, 0.0)

        # ── Envolvente de amplitud del burst (ataque rápido, caída exponencial) ──
        att_f = max(2, int(burst_f * 0.07))
        dec_f = burst_f - att_f
        amp_env = np.concatenate([
            np.linspace(0, 1, att_f) ** 0.5,
            np.exp(-3.0 * np.linspace(0, 1, dec_f))
        ])[:burst_f]

        amp_scale = 1.0 - 0.055 * i     # la risa se va apagando

        # ── Envolvente espectral ───────────────────────────────────────────
        sp_frame = laugh_sp * amp_scale
        sp_all[fs:fe] = amp_env[:, np.newaxis] * sp_frame[np.newaxis, :] + 1e-10

        # ── Aperiodicidad: más soplado en onset/offset, más periódico en pico ──
        # ap ≈ 0 → puramente periódico (tono puro)
        # ap ≈ 1 → puramente aperiódico (ruido)
        ap_voiced  = 0.28    # pico del burst — algo soplado (voz natural)
        ap_unvoic  = 0.92    # onset/offset — aspirado
        ap_env = np.where(voiced_mask, ap_voiced, ap_unvoic)
        # Transición suave
        ap_env = np.convolve(ap_env, np.hanning(5) / np.hanning(5).sum(), mode='same')
        ap_all[fs:fe] = ap_env[:, np.newaxis] * np.ones((1, n_sp_bins))

        # ── Pausa entre bursts — aspiración suave ─────────────────────────
        if i < n_ja - 1:
            gs = fe
            ge = gs + gap_f
            if ge <= total_f:
                # sp muy pequeño con decaimiento
                breath_env = np.exp(-6 * np.linspace(0, 1, gap_f)) * 0.04 * amp_scale
                sp_all[gs:ge] = breath_env[:, np.newaxis] * darwin_sp_lin[np.newaxis, :] + 1e-10
                ap_all[gs:ge] = 0.97   # casi todo ruido (aspiración)

    sp_all = np.clip(sp_all, 1e-10, None)
    ap_all = np.clip(ap_all, 0.0, 1.0 - 1e-6)

    y_out = pw.synthesize(f0_all, sp_all, ap_all, WORLD_SR, frame_period=FRAME_PERIOD).astype(np.float32)

    # Micro-ruido de habitación (muy sutil)
    y_out += rng.standard_normal(len(y_out)).astype(np.float32) * 0.006

    peak = float(np.max(np.abs(y_out)))
    if peak > 1e-6:
        y_out = (y_out / peak) * 0.87

    out = io.BytesIO()
    sf.write(out, y_out, WORLD_SR, format="WAV", subtype="PCM_16")
    return out.getvalue()

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

# ── Piper Patch (pitch y/o world) — con detección de risas ───────────────────
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

    # Darwin usa "refs" (multi-archivo); otras voces usan "ref"
    ref_path = cfg.get("ref")
    if ref_path and not os.path.exists(ref_path):
        return jsonify({"error": "Audio de referencia no disponible"}), 404

    model = _piper.get(cfg["base"])
    if not model:
        return jsonify({"error": f"Base Piper '{cfg['base']}' no disponible"}), 404

    mode     = cfg.get("mode", "pitch")
    segments = _split_laugh_segments(text)

    def _apply_patch(wav_bytes):
        if mode == "world":
            return _patch_world(wav_bytes, cfg, voice_name=voice)
        return _patch_pitch(wav_bytes, ref_path)

    try:
        wav_parts = []
        for seg, is_laugh in segments:
            if not seg:
                continue
            if is_laugh and mode == "world":
                # Risa humana con voz Darwin
                n_ja = _laugh_count(seg)
                laugh_wav = _gen_laugh_audio(n_ja, model, cfg, voice)
                if laugh_wav:
                    wav_parts.append(laugh_wav)
            else:
                base = _wav_from_piper(model, seg)
                if base:
                    wav_parts.append(_apply_patch(base))
    except Exception as e:
        return jsonify({"error": f"Error generando audio: {e}"}), 500

    if not wav_parts:
        return jsonify({"error": "Sin audio generado"}), 500

    final = _concat_wav_bytes(wav_parts)
    return Response(final, mimetype="audio/wav",
                    headers={"Cache-Control": "no-store"})

if __name__ == "__main__":
    print("[TTS-SERVICE] edge_tts + Piper + WORLD listos ✓", flush=True)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
