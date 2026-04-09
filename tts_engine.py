import sys
import asyncio
import edge_tts

async def generar(texto, voz, pitch, rate, archivo_salida):
    communicate = edge_tts.Communicate(texto, voz, pitch=pitch, rate=rate)
    await communicate.save(archivo_salida)

if __name__ == "__main__":
    texto = sys.argv[1]
    voz = sys.argv[2]
    pitch = sys.argv[3]
    rate = sys.argv[4]
    salida = sys.argv[5]
    asyncio.run(generar(texto, voz, pitch, rate, salida))
