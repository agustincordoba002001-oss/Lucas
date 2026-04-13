"""
XTTS Daemon — carga el modelo UNA vez, acepta pedidos por stdin JSON.

Protocolo:
  IN  (stdin):  {"texto": "...", "ref_audio": "..."}\n
  OUT (stdout): [uint32 big-endian len][WAV bytes]
  ERR (stdout): [uint32 = 0][uint32 msg-len][error msg bytes]

Optimizaciones velocidad máxima:
  - Conditioning latents cacheados en memoria.
  - WAV en memoria sin disco.
  - Temperatura 0.1 (greedy, más rápido).
  - enable_text_splitting=False para frases cortas.
  - top_k reducido para decodificación rápida.
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

sys.stderr.write("[XTTS-DAEMON] Modelo listo. Pre-computando conditioning...\n")
sys.stderr.flush()

# ── Pre-cachear conditioning del audio de referencia ─────────────────────────
_cond_cache: dict = {}

def get_cond(ref_path: str):
    if ref_path not in _cond_cache:
        gpt_lat, spk_emb = xtts.get_conditioning_latents(
            audio_path=[ref_path],
            gpt_cond_len=3,
            max_ref_length=10,
            sound_norm_refs=xtts.config.sound_norm_refs,
        )
        _cond_cache[ref_path] = (gpt_lat, spk_emb)
    return _cond_cache[ref_path]

_DIEVER_REF = "/home/runner/workspace/diever_referencia.wav"
if os.path.exists(_DIEVER_REF):
    get_cond(_DIEVER_REF)

sys.stderr.write("[XTTS-DAEMON] Conditioning listo. Esperando pedidos...\n")
sys.stderr.flush()

# Señal READY
sys.stdout.buffer.write(b"READY\n")
sys.stdout.buffer.flush()

# ── Loop principal ────────────────────────────────────────────────────────────
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req    = json.loads(line)
        texto  = req.get("texto", "").strip()
        ref    = req.get("ref_audio", "")

        if not texto or not os.path.exists(ref):
            msg = b"texto y ref_audio requeridos"
            sys.stdout.buffer.write(struct.pack(">II", 0, len(msg)) + msg)
            sys.stdout.buffer.flush()
            continue

        gpt_lat, spk_emb = get_cond(ref)

        out = xtts.inference(
            texto, "es", gpt_lat, spk_emb,
            temperature=0.1,
            length_penalty=1.0,
            repetition_penalty=5.0,
            top_k=30,
            top_p=0.75,
            speed=1.0,
            enable_text_splitting=False,
        )
        wav_np = np.array(out["wav"], dtype=np.float32)

        buf = io.BytesIO()
        sf.write(buf, wav_np, SAMPLE_RATE, format="WAV", subtype="PCM_16")
        wav_bytes = buf.getvalue()

        sys.stdout.buffer.write(struct.pack(">I", len(wav_bytes)) + wav_bytes)
        sys.stdout.buffer.flush()

    except Exception as e:
        msg = str(e).encode()
        sys.stdout.buffer.write(struct.pack(">II", 0, len(msg)) + msg)
        sys.stdout.buffer.flush()
