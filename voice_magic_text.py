import base64
import hashlib
import json
import sys

import librosa
import numpy as np


def compact_hex(coefficients: np.ndarray) -> str:
    quantized = np.clip(np.round(coefficients * 2048), -128, 127).astype(np.int8)
    return quantized.tobytes().hex()


def pack_nibbles(values: np.ndarray) -> bytes:
    clipped = np.clip(values, 0, 15).astype(np.uint8)
    if clipped.size % 2:
        clipped = np.append(clipped, 0).astype(np.uint8)
    high = clipped[0::2] << 4
    low = clipped[1::2]
    return bytes((high | low).tolist())


def lpc_coefficients(frame: np.ndarray, order: int) -> np.ndarray:
    frame = frame.astype(np.float64)
    if float(np.max(np.abs(frame))) < 1e-5:
        return np.zeros(order, dtype=np.float64)
    windowed = frame * np.hamming(frame.size)
    lpc = librosa.lpc(windowed, order=order)
    return lpc[1 : order + 1]


def encode_standard(y: np.ndarray, sr: int) -> dict:
    frame_ms = 20
    order = 10
    win_len = int((frame_ms / 1000) * sr)
    if y.size < win_len:
        y = np.pad(y, (0, win_len - y.size))
    remainder = y.size % win_len
    if remainder:
        y = np.pad(y, (0, win_len - remainder))

    frames = librosa.util.frame(y, frame_length=win_len, hop_length=win_len)
    encoded_frames = [compact_hex(lpc_coefficients(frames[:, i], order)) for i in range(frames.shape[1])]
    encoded_text = "".join(encoded_frames)
    return {
        "encodedText": encoded_text,
        "sampleRate": sr,
        "frameMs": frame_ms,
        "lpcOrder": order,
        "frameCount": len(encoded_frames),
        "durationSeconds": round(float(y.size / sr), 3),
        "encoding": "lpc-int8-hex-v1",
        "mode": "standard",
        "estimatedBytes": len(encoded_text.encode("utf-8")),
        "reconstructable": True,
    }


def encode_ultra(y: np.ndarray, sr: int) -> dict:
    frame_ms = 100
    order = 8
    win_len = int((frame_ms / 1000) * sr)
    if y.size < win_len:
        y = np.pad(y, (0, win_len - y.size))
    remainder = y.size % win_len
    if remainder:
        y = np.pad(y, (0, win_len - remainder))

    frames = librosa.util.frame(y, frame_length=win_len, hop_length=win_len)
    packed = bytearray()
    for i in range(frames.shape[1]):
        coefficients = lpc_coefficients(frames[:, i], order)
        nibbles = np.clip(np.round((coefficients + 1.6) * (15 / 3.2)), 0, 15)
        packed.extend(pack_nibbles(nibbles))

    encoded_text = base64.urlsafe_b64encode(bytes(packed)).decode("ascii").rstrip("=")
    return {
        "encodedText": encoded_text,
        "sampleRate": sr,
        "frameMs": frame_ms,
        "lpcOrder": order,
        "frameCount": int(frames.shape[1]),
        "durationSeconds": round(float(y.size / sr), 3),
        "encoding": "lpc4bit-base64url-v2",
        "mode": "ultra",
        "estimatedBytes": len(encoded_text.encode("utf-8")),
        "reconstructable": True,
    }


def encode_fingerprint(y: np.ndarray, sr: int) -> dict:
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=12)
    features = np.concatenate([np.mean(mfcc, axis=1), np.std(mfcc, axis=1)])
    quantized = np.clip(np.round((features + 80) * 2), 0, 255).astype(np.uint8)
    digest = hashlib.blake2s(quantized.tobytes(), digest_size=8).digest()
    encoded_text = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return {
        "encodedText": encoded_text,
        "sampleRate": sr,
        "frameMs": 0,
        "lpcOrder": 0,
        "frameCount": 1,
        "durationSeconds": round(float(y.size / sr), 3),
        "encoding": "voice-fingerprint-64bit-v1",
        "mode": "fingerprint",
        "estimatedBytes": len(encoded_text.encode("utf-8")),
        "reconstructable": False,
    }


def encode_photon(y: np.ndarray, sr: int) -> dict:
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=8)
    energy = librosa.feature.rms(y=y)
    zero_crossing = librosa.feature.zero_crossing_rate(y)
    summary = np.concatenate([
        np.mean(mfcc, axis=1),
        np.std(mfcc, axis=1),
        np.percentile(energy, [25, 50, 75]).ravel(),
        np.percentile(zero_crossing, [25, 50, 75]).ravel(),
    ])
    quantized = np.clip(np.round((summary + 64) * 3), 0, 255).astype(np.uint8)
    digest = hashlib.blake2s(quantized.tobytes(), digest_size=16, person=b"LOLOPHOT").digest()
    encoded_text = "LPV1-" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return {
        "encodedText": encoded_text,
        "sampleRate": sr,
        "frameMs": 0,
        "lpcOrder": 0,
        "frameCount": 1,
        "durationSeconds": round(float(y.size / sr), 3),
        "encoding": "lolo-photon-voice-capsule-v1",
        "mode": "photon",
        "estimatedBytes": len(encoded_text.encode("utf-8")),
        "reconstructable": False,
        "regenerative": True,
        "note": "Cápsula ultraliviana para identidad/receta vocal. Para volver a audio necesita texto o semilla generativa, no conserva la onda exacta.",
    }


def voice_to_magic_text(audio_path: str, mode: str = "ultra") -> dict:
    max_duration = 30.0 if mode in {"ultra", "fingerprint", "photon"} else 5.0
    target_sr = 4000 if mode == "ultra" else 8000
    y, sr = librosa.load(audio_path, sr=target_sr, mono=True, duration=max_duration)
    if y.size == 0:
        raise ValueError("El audio está vacío")

    peak = float(np.max(np.abs(y)))
    if peak > 0:
        y = y / peak

    if mode == "standard":
        result = encode_standard(y, sr)
    elif mode == "fingerprint":
        result = encode_fingerprint(y, sr)
    elif mode == "photon":
        result = encode_photon(y, sr)
    elif mode == "ultra":
        result = encode_ultra(y, sr)
    else:
        raise ValueError("Modo inválido. Usá standard, ultra, fingerprint o photon")

    result["maxDurationSeconds"] = int(max_duration)
    result["millionThirtySecondEstimateGb"] = round((result["estimatedBytes"] * 1_000_000) / 1_000_000_000, 3)
    return result


def main() -> None:
    if len(sys.argv) not in {2, 3}:
        raise SystemExit("Uso: python3 voice_magic_text.py <audio_path> [standard|ultra|fingerprint|photon]")

    mode = sys.argv[2] if len(sys.argv) == 3 else "ultra"
    result = voice_to_magic_text(sys.argv[1], mode)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
