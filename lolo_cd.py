import asyncio
import edge_tts

VOZ_LOLO = "es-MX-JorgeNeural"

async def generar_voz_lolo(texto):
    archivo = "lolo_cd_output.mp3"
    communicate = edge_tts.Communicate(texto, VOZ_LOLO)
    await communicate.save(archivo)
    print(f"Audio generado: {archivo}")

if __name__ == "__main__":
    texto_prueba = "Jordi, bro. Estamos en Replit. El motor Lolo C D está fuera de la zona de errores. ¡A darle!"
    asyncio.run(generar_voz_lolo(texto_prueba))
