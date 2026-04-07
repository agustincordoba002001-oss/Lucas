# ============================================================
# CLONADOR DE VOZ - XTTS v2 (Google Colab)
# Pegá esto en una celda de Google Colab y ejecutá
# Colab gratuito tiene GPU, lo cual hace esto posible
# ============================================================

# PASO 1: Instalar dependencias
# !pip install TTS==0.22.0 transformers==4.44.2 -q

# PASO 2: Subir el archivo de voz de referencia a Colab
# En el panel izquierdo de Colab, hacé click en el ícono de carpeta,
# luego subí tu archivo MP3 de referencia (ej: diever_muñoz.mp3)

# PASO 3: Correr el código
import os
os.environ["COQUI_TOS_AGREED"] = "1"

from TTS.api import TTS
import torch

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Usando: {device}")

# Cargar modelo XTTS v2 (descarga ~1.8GB la primera vez)
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)

# ---- CONFIGURACIÓN ----
ARCHIVO_REFERENCIA = "diever_muñoz.mp3"   # <- nombre del archivo que subiste
TEXTO = "Jordi, bro. El motor Lolo C D ya está coronando. La calle sabe quién manda."
ARCHIVO_SALIDA = "voz_clonada.wav"
# -----------------------

tts.tts_to_file(
    text=TEXTO,
    speaker_wav=ARCHIVO_REFERENCIA,
    language="es",
    file_path=ARCHIVO_SALIDA
)

print(f"\nListo! Descargá el archivo '{ARCHIVO_SALIDA}' desde el panel de archivos.")

# Para descargarlo automáticamente en Colab:
# from google.colab import files
# files.download(ARCHIVO_SALIDA)
