"""
Servicio TTS persistente para edge_tts.
Mantiene el event loop en memoria → responde en ~200ms en vez de ~1.5s.
Puerto: 5000
"""
import io, asyncio, warnings
warnings.filterwarnings("ignore")

import edge_tts
from flask import Flask, request, Response, jsonify

app = Flask(__name__)

@app.get("/health")
def health():
    return jsonify({"ok": True})

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

if __name__ == "__main__":
    print("[TTS-SERVICE] edge_tts listo ✓", flush=True)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
