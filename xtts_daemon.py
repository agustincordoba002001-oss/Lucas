"""
XTTS Daemon — carga el modelo UNA vez, acepta pedidos por stdin JSON,
devuelve audio WAV por stdout con prefijo de 4 bytes (big-endian length).

Protocolo:
  IN  (stdin):  {"texto": "...", "ref_audio": "..."}\n
  OUT (stdout): [uint32 big-endian len][WAV bytes]
  ERR (stdout): [uint32 = 0][uint32 msg-len][error msg bytes]
"""
import sys, os, json, struct, tempfile, warnings, functools
warnings.filterwarnings("ignore")
os.environ["COQUI_TOS_AGREED"] = "1"

# ── Parches necesarios para XTTS ─────────────────────────────────────────
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

# ── Cargar modelo ────────────────────────────────────────────────────────
sys.stderr.write("[XTTS-DAEMON] Cargando modelo...\n")
sys.stderr.flush()

from TTS.api import TTS
model = TTS("tts_models/multilingual/multi-dataset/xtts_v2", progress_bar=False)

sys.stderr.write("[XTTS-DAEMON] Modelo listo. Esperando pedidos...\n")
sys.stderr.flush()

# Señal: escribir b"READY\n" en stdout para que Express sepa que está listo
sys.stdout.buffer.write(b"READY\n")
sys.stdout.buffer.flush()

# ── Loop principal ───────────────────────────────────────────────────────
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue

    try:
        req      = json.loads(line)
        texto    = req.get("texto", "").strip()
        ref      = req.get("ref_audio", "")

        if not texto or not os.path.exists(ref):
            msg = b"texto y ref_audio requeridos"
            sys.stdout.buffer.write(struct.pack(">II", 0, len(msg)) + msg)
            sys.stdout.buffer.flush()
            continue

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            out = f.name

        model.tts_to_file(text=texto, speaker_wav=ref, language="es", file_path=out)

        with open(out, "rb") as f:
            audio = f.read()
        os.unlink(out)

        # Respuesta exitosa: [uint32 len][WAV bytes]
        sys.stdout.buffer.write(struct.pack(">I", len(audio)) + audio)
        sys.stdout.buffer.flush()

    except Exception as e:
        msg = str(e).encode()
        sys.stdout.buffer.write(struct.pack(">II", 0, len(msg)) + msg)
        sys.stdout.buffer.flush()
