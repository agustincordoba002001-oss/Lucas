import asyncio
import edge_tts

VOZ_DIEVER = "es-CO-GonzaloNeural"

async def motor_lolo_cd(texto):
    nombre_archivo = "lolo_cd_voz.mp3"
    communicate = edge_tts.Communicate(texto, VOZ_DIEVER, pitch="-5Hz", rate="+0%")
    print(f"Generando voz de Diever para: {texto}")
    await communicate.save(nombre_archivo)
    print(f"Listo! Archivo guardado: '{nombre_archivo}'")

if __name__ == "__main__":
    mensaje = "Jordi, bro. El motor Lolo C D ya está coronando en Replit. La calle sabe quién manda."
    asyncio.run(motor_lolo_cd(mensaje))
