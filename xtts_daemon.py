"""
XTTS Daemon — carga el modelo UNA vez, acepta pedidos por stdin JSON.

Modos:
  stream=false (default): devuelve WAV completo → [uint32 len][WAV bytes] | [0][msglen][msg]
  stream=true           : devuelve chunks PCM   → N×[uint32 len][PCM int16] + [0xFFFFFFFE] fin | [0][msglen][msg]

Sample rate de salida: 24000 Hz, mono, int16.
"""
import sys, os, json, struct, io, warnings, functools
warnings.filterwarnings("ignore")
os.environ["COQUI_TOS_AGREED"] = "1"

import soundfile as sf
import numpy as np
import torch
import torchaudio

_orig_load = torch.load
@functools.wraps(_orig_load)
def _ptl(f, *a, **kw):
    kw.setdefault("weights_only", False)
    return _orig_load(f, *a, **kw)
torch.load = _ptl

def _pta(path, *a, **kw):
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return torch.from_numpy(data.T), sr
torchaudio.load = _pta

sys.stderr.write("[XTTS-DAEMON] Cargando modelo...\n")
sys.stderr.flush()

from TTS.api import TTS
_tts_api = TTS("tts_models/multilingual/multi-dataset/xtts_v2", progress_bar=False)
xtts = _tts_api.synthesizer.tts_model
SAMPLE_RATE = 24000

sys.stderr.write("[XTTS-DAEMON] Modelo listo. Esperando pedidos...\n")
sys.stderr.flush()

# ── Pre-cachear conditioning del audio de referencia ─────────────────────────
_cond_cache: dict = {}

def get_cond(ref_path: str):
    if ref_path not in _cond_cache:
        sys.stderr.write(f"[XTTS-DAEMON] Computando conditioning para {ref_path}...\n")
        sys.stderr.flush()
        gpt_lat, spk_emb = xtts.get_conditioning_latents(
            audio_path=[ref_path],
            gpt_cond_len=xtts.config.gpt_cond_len,
            max_ref_length=xtts.config.max_ref_len,
            sound_norm_refs=xtts.config.sound_norm_refs,
        )
        _cond_cache[ref_path] = (gpt_lat, spk_emb)
        sys.stderr.write("[XTTS-DAEMON] Conditioning listo y cacheado.\n")
        sys.stderr.flush()
    return _cond_cache[ref_path]

# Pre-calentar con la referencia de Diever si existe
_DIEVER_REF = "/home/runner/workspace/diever_referencia.wav"
if os.path.exists(_DIEVER_REF):
    get_cond(_DIEVER_REF)

# Señal READY
sys.stdout.buffer.write(b"READY\n")
sys.stdout.buffer.flush()

# ── Helpers ───────────────────────────────────────────────────────────────────
def send_error(msg: str):
    b = msg.encode()
    sys.stdout.buffer.write(struct.pack(">II", 0, len(b)) + b)
    sys.stdout.buffer.flush()

def float_to_pcm16(tensor) -> bytes:
    arr = tensor.squeeze().cpu().numpy()
    arr = np.clip(arr, -1.0, 1.0)
    return (arr * 32767).astype(np.int16).tobytes()

def make_wav_header(data_size: int = 0xFFFFFFFF) -> bytes:
    channels, bits = 1, 16
    byte_rate = SAMPLE_RATE * channels * bits // 8
    block_align = channels * bits // 8
    riff_size = 36 + data_size if data_size != 0xFFFFFFFF else 0xFFFFFFFF
    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", riff_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<IHHIIHH", 16, 1, channels, SAMPLE_RATE, byte_rate, block_align, bits))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    return buf.getvalue()

# ── Loop principal ────────────────────────────────────────────────────────────
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req     = json.loads(line)
        texto   = req.get("texto", "").strip()
        ref     = req.get("ref_audio", "")
        stream  = req.get("stream", False)

        if not texto or not os.path.exists(ref):
            send_error("texto y ref_audio requeridos")
            continue

        gpt_lat, spk_emb = get_cond(ref)

        if stream:
            # ── Modo streaming: chunks PCM ────────────────────────────────
            chunks = xtts.inference_stream(
                texto, "es", gpt_lat, spk_emb,
                stream_chunk_size=20,
                temperature=0.7,
                enable_text_splitting=True,
            )
            for chunk in chunks:
                pcm = float_to_pcm16(chunk)
                sys.stdout.buffer.write(struct.pack(">I", len(pcm)) + pcm)
                sys.stdout.buffer.flush()
            # Fin de stream
            sys.stdout.buffer.write(struct.pack(">I", 0xFFFFFFFE))
            sys.stdout.buffer.flush()

        else:
            # ── Modo completo: WAV ────────────────────────────────────────
            chunks = xtts.inference_stream(
                texto, "es", gpt_lat, spk_emb,
                stream_chunk_size=20,
                temperature=0.7,
                enable_text_splitting=True,
            )
            pcm_parts = [float_to_pcm16(c) for c in chunks]
            pcm_data  = b"".join(pcm_parts)
            wav        = make_wav_header(len(pcm_data)) + pcm_data
            sys.stdout.buffer.write(struct.pack(">I", len(wav)) + wav)
            sys.stdout.buffer.flush()

    except Exception as e:
        send_error(str(e))
