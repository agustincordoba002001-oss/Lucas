import json
import sys

import librosa
import numpy as np


def compact_hex(coefficients: np.ndarray) -> str:
    quantized = np.clip(np.round(coefficients * 2048), -128, 127).astype(np.int8)
    return quantized.tobytes().hex()


def voice_to_magic_text(audio_path: str) -> dict:
    y, sr = librosa.load(audio_path, sr=8000, mono=True, duration=5.0)
    if y.size == 0:
        raise ValueError("El audio está vacío")

    peak = float(np.max(np.abs(y)))
    if peak > 0:
        y = y / peak

    win_len = int(0.02 * sr)
    if y.size < win_len:
        y = np.pad(y, (0, win_len - y.size))

    remainder = y.size % win_len
    if remainder:
        y = np.pad(y, (0, win_len - remainder))

    frames = librosa.util.frame(y, frame_length=win_len, hop_length=win_len)
    encoded_frames: list[str] = []

    for i in range(frames.shape[1]):
        frame = frames[:, i].astype(np.float64)
        if float(np.max(np.abs(frame))) < 1e-5:
            coefficients = np.zeros(10, dtype=np.float64)
        else:
            windowed = frame * np.hamming(frame.size)
            lpc = librosa.lpc(windowed, order=10)
            coefficients = lpc[1:11]
        encoded_frames.append(compact_hex(coefficients))

    return {
        "encodedText": "".join(encoded_frames),
        "sampleRate": sr,
        "frameMs": 20,
        "lpcOrder": 10,
        "frameCount": len(encoded_frames),
        "durationSeconds": round(float(y.size / sr), 3),
        "encoding": "lpc-int8-hex-v1",
        "maxDurationSeconds": 5,
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Uso: python3 voice_magic_text.py <audio_path>")

    result = voice_to_magic_text(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()