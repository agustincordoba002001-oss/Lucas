import sys
import os
import warnings
import functools

warnings.filterwarnings("ignore")
os.environ["COQUI_TOS_AGREED"] = "1"

import soundfile as sf
import numpy as np
import torch

original_torch_load = torch.load
def patched_torch_load(f, *args, **kwargs):
    kwargs.setdefault("weights_only", False)
    return original_torch_load(f, *args, **kwargs)
torch.load = patched_torch_load

import torchaudio
def patched_ta_load(path, *args, **kwargs):
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return torch.from_numpy(data.T), sr
torchaudio.load = patched_ta_load

from TTS.api import TTS

texto = sys.argv[1]
ref_audio = sys.argv[2]
salida = sys.argv[3]

tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", progress_bar=False)
tts.tts_to_file(text=texto, speaker_wav=ref_audio, language="es", file_path=salida)
