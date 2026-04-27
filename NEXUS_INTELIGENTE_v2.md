# NEXUS Inteligente v2 - Motor de Síntesis Que Aprende

## Introducción

El nuevo motor **NEXUS Inteligente** transforma la forma en que el sistema entiende y genera audio. No es solo un diccionario de palabras — es un **motor semántico que Lee, Comprende y Aprende como una Persona**.

### Características Revolucionarias

✅ **Análisis Lingüístico Profundo**
- Descomposición en lemas (palabras raíz)
- Etiquetado automático de partes de la oración (POS)
- Detección de entonación interrogativa/enfática

✅ **Prosodias Adaptativas**
- Velocidad variable (excitación = 120%, calma = 80%)
- Tonalidad dinámica (emoción → altitud de voz)
- Volumen automático según énfasis

✅ **Análisis Emocional**
- Detección de 6 emociones: neutral, excitada, calma, triste, cuestionadora, enfática
- Análisis de puntuación repetida (`!!!` = énfasis extremo)
- Contexto de MAYÚSCULAS

✅ **Microfrases Inteligentes**
- Agrupa palabras en unidades naturales (no solo palabras individuales)
- Cachea "microfrases" completas con su prosodias
- Entiende límites naturales de respiración

✅ **Aprendizaje Continuo**
- Cada reproducción → incrementa `learning_score`
- Palabras repetidas → preferencias de pronunciación
- Sistema predice mejores parámetros prosódicos

---

## Arquitectura

### 1. **Tokenización Inteligente**
```typescript
// Antes (legacy):
splitWords("¡Hola mundo!") → ["hola", "mundo"]

// Ahora (inteligente):
tokenizeIntelligent("¡Hola mundo!", voiceId, context)
// Retorna SemanticToken[] con:
// - word: "hola"
// - lemma: "hola"  
// - pos: "intj"
// - emotion: "excited"
// - emphasisLevel: 40 (por el !)
// - prosody: [{ type: "volume", value: 130 }, ...]
```

### 2. **Análisis Emocional**
```typescript
interface SemanticToken {
  word: string;
  lemma: string;              // raíz gramatical
  pos: POS;                   // parte de oración
  emotion: EmotionType;       // emoción detectada
  emphasisLevel: 0-100;       // intensidad
  prosody: ProsodicMarker[];  // velocidad, tonalidad, volumen
  position: "start" | "middle" | "end" | "standalone";
  isQuestion: boolean;
}
```

### 3. **Microfrases**
```typescript
interface MicroPhrase {
  tokens: SemanticToken[];
  audio?: Buffer;
  signature: string;          // hash único
  learningScore: 0-1;         // confianza (0.5 = nuevo, 1.0 = perfecto)
  usageCount: number;         // qué tan usado
}
```

Las microfrases se cachean y reutilizan. Si la misma "microunidad" aparece varias veces, la segunda ejecución es instantánea.

### 4. **Contextos de Aprendizaje**
```typescript
interface LearningContext {
  voiceId: string;
  wordUsageStats: Map<word, { count, contexts[] }>;
  microphraseCache: Map<signature, MicroPhrase>;
  emotionPreferences: Map<emotion, score>;
  lastUpdated: Date;
}
```

Cada voz tiene su propio contexto de aprendizaje independiente.

---

## Tablas de BD Nuevas

### `voice_microphrases_intelligent`
```sql
CREATE TABLE voice_microphrases_intelligent (
  voice_id        TEXT,          -- voz (ej: "darwin-xtts")
  signature       TEXT,          -- hash de la microunidad
  tokens_json     TEXT,          -- JSON con SemanticToken[]
  audio           BLOB,          -- WAV caché
  bytes           INTEGER,
  learning_score  REAL,          -- 0.5 a 1.0
  usage_count     INTEGER,       -- cuántas veces jugó
  emotion         TEXT,          -- emoción dominante
  created_at      INTEGER,
  last_used_at    INTEGER,
  PRIMARY KEY (voice_id, signature)
);
```

---

## Endpoints Nuevos

### `GET /api/voice-learning-stats?voiceId=darwin-xtts`
```json
{
  "voiceId": "darwin-xtts",
  "totalWordsLearned": 243,
  "microphrasesCached": 87,
  "averageLearningScore": 0.72,
  "topWords": ["hola", "gracias", "por", "te", "quiero"],
  "engine": "nexus-v2-intelligent"
}
```

---

## Ejemplo: Cómo Funciona

### Input
```
"¡Hola! ¿Cómo estás? Te quiero mucho."
```

### Fase 1: Tokenización
```
Token 1: word="hola",    emotion="excited"  emphasisLevel=40  prosody=[volume:130, speed:120]
Token 2: word="cómo",    emotion="question" emphasisLevel=20  prosody=[pitch:110]
Token 3: word="estás",   emotion="neutral"  emphasisLevel=0
Token 4: word="te",      emotion="neutral"  emphasisLevel=0
Token 5: word="quiero",  emotion="excited"  emphasisLevel=30  prosody=[volume:110]
Token 6: word="mucho",   emotion="excited"  emphasisLevel=20  prosody=[speed:110]
```

### Fase 2: Agrupación en Microfrases
```
MicroPhrase 1: ["hola"] 
  → Si existe en caché → devuelve audio + incrementa learning_score
  → Si no existe → genera TTS con prosodias → cachea

MicroPhrase 2: ["cómo", "estás"]
  → Detecta estructura interrogativa
  → TTS genera con tonalidad ascendente
  → Cachea con emotion="questioning", learning_score=0.3

MicroPhrase 3: ["te", "quiero", "mucho"]
  → Detecta contexto emocional
  → TTS genera con volumen aumentado
  → Cachea
```

### Fase 3: Concatenación + Aprendizaje
```
Audio Final = concat(Audio1, Audio2, Audio3)
  ↓
Guardar cada microunidad en voice_microphrases_intelligent
  ↓
Incrementar wordUsageStats para ["hola", "cómo", "estás", "te", "quiero", "mucho"]
  ↓
Siguiente vez que aparezca "¡Hola!" → caché hit = 0ms
```

---

## Almacenamiento Optimizado

### Escala para 1M Comentarios

**Scenario: Español típico**
- Palabras únicas esperadas: ~5,000
- Microfrases únicas esperadas: ~20,000 (4 palabras promedio por microunidad)

| Método | Audio Storage | Indices | Total | Compresión |
|--------|---------------|---------|-------|-----------|
| **Legacy WAV** | 1.44 MB × 1M | 0 | **1.44 TB** | 0% |
| **Base64 + SQLite** | 1.9 MB × 1M | 0 | **1.9 TB** | 0% |
| **Nexus-Decreciente (v1)** | 1.44 MB × 5K | 100 MB | **7.2 GB** | 99.5% |
| **Nexus-Inteligente (v2)** | 1.44 MB × 20K | 500 MB | **29 GB** | 98.0% |
| **+ Deduplicación semántica** | 800 KB × 20K | 500 MB | **16 GB** | 98.9% |

**Por qué v2 es mejor que v1:**
- v1 cachea `word_norm` → "te" siempre suena igual
- v2 cachea `MicroPhrase{tokens=[te,quiero,mucho], emotion=excited}` → entiende contexto
- v2 aprende preferencias → "te" en contexto emocional ≠ "te" neutro

---

## API de Uso

### Activar Nexus Inteligente en un Comentario

```bash
POST /api/comments
{
  "texto": "¡Hola! ¿Cómo estás?",
  "storageMode": "nexus-decreciente",
  "voiceId": "darwin-xtts"
}
```

### Obtener Estadísticas de Aprendizaje

```bash
GET /api/voice-learning-stats?voiceId=darwin-xtts
```

### Caché de Microfrases

- Almacenado en: `voice_microphrases_intelligent` (BD SQLite)
- En memoria: `Map<voiceId, Map<signature, MicroPhrase>>`
- TTL: Indefinido (aprende con cada uso)

---

## Mejoras Futuras

🚀 **v3: Prosodia Neuroligüística**
- Análisis de *stress* (sílabas acentuadas)
- Predicción de respiración natural
- Entonación específica por región (argentina, mexicana, española)

🚀 **v4: Deduplicación Semántica**
- "Te amo" ≈ "Te quiero" → mismo audio base + variación mínima
- Clustering por similaridad semántica (NLP embeddings)
- Ahorro: 60% adicional en almacenamiento

🚀 **v5: Aprendizaje Activo**
- Usuario valida/corrige pronunciación → motor aprende
- Reinforcement learning en tiempo real
- `learning_score` → probabilidad de reutilizar vs. regenerar

---

## Modo de Operación

### Comentario Nuevo (Nexus Inteligente)

1. **Análisis** (50ms): Tokenización + emociones + prosodias
2. **Microfrases** (0ms): Agrupación en unidades naturales
3. **Caché lookup** (< 5ms): ¿Existen algunas microfrases?
4. **TTS generación** (2-5s por microunidad nueva): Solo las no caché-adas
5. **Almacenamiento**: BD + en memoria para próximas reproducciones
6. **Aprendizaje** (< 10ms): Actualizar wordUsageStats + learning_scores

### Reproducción (Play)

1. **Caché hit** (caché estricto): Array buffer en memoria

 → devuelve 0-5ms
2. **Caché partial**: Algunas microfrases cacheadas + otras generadas: 200-500ms
3. **Caché miss**: Todas nuevas: 5-15s (primera vez)

---

## Manuales de Inicio

### Para Desarrolladores

```typescript
import {
  tokenizeIntelligent,
  groupIntoMicroPhrases,
  generateTTSParams,
  createLearningContext,
} from "./lib/intelligent-nexus";

const context = createLearningContext("darwin-xtts");
const tokens = tokenizeIntelligent("¡Hola!", "darwin-xtts", context);
const microphrases = groupIntoMicroPhrases(tokens);

for (const mp of microphrases) {
  const params = generateTTSParams(mp);
  console.log(`Microunidad: ${params.texto}`);
  console.log(`  Emoción: ${params.emotion}`);
  console.log(`  Prosodias: speed=${params.speed}, pitch=${params.pitch}`);
}
```

### Para Usuarios (Frontend)

1. Selecciona **"NEXUS DECRECIENTE"** en la UI
2. Escribe comentario normalmente
3. Sistema entiende emociones automáticamente
4. Primera reproducción: ~1-5s
5. Segunda reproducción del mismo comentario: < 100ms
6. El motor aprende con cada uso

---

## Detalles Técnicos

### Análisis de Emoción (Detección)

| Palabra | Emoción | Razón |
|---------|---------|-------|
| "¡hola!" | excited | interjección + `!` |
| "¿cómo?" | questioning | interrogativo + `?` |
| "amor" | excited | palabra semánticamente positiva |
| "triste" | sad | palabra en lista de negativos |
| "tranquilo" | calm | palabra en lista de suavidad |

### Lematización Español

```
"perros" → lemma: "perro"
"hablamos" → lemma: "hablar"
"fueron" → lemma: "ir"
"estás" → lemma: "estar"
```

Garantiza que variaciones de la misma palabra se agrupan en el caché.

### POS Tagging (Simple Heurísticas)

```
- Terminación "-ción" → NOUN
- Terminación "-ar/-er/-ir" → VERB
- Terminación "-mente" → ADV
- Palabra interjección ([ah, eh, mm]) → INTJ
- Palabra con [.!?,;:] → PUNCT
```

---

## Comparación Legacy vs. Inteligente

| Aspecto | v1 (Legacy) | v2 (Inteligente) |
|---------|-----------|-----------------|
| **Unidad de caché** | Palabra | Microunidad |
| **Emoción** | No detecta | Automática |
| **Prosodias** | No varían | Varían por contexto |
| **Aprendizaje** | No hay | Sí, continuo |
| **Storage A 1M** | 7.2 GB | 16 GB (pero mejor) |
| **Compresión** | 99.5% | 98.9% (mejor calidad) |
| **Primera reproducción** | 5-15s | 5-15s igual |
| **Segunda reproducción** | 2-5s (palabra a palabra) | 100ms (caché microunidad) |

---

## Inspiración

Este motor nació de la pregunta: **"¿Cómo entiende texto una persona?"**

1. Lee leyendo letra por letra → tokenización
2. Agrupa en palabras/frases → microfrases
3. Entiende emoción/contexto → análisis semántico
4. Recuerda patrones → aprendizaje
5. Tiempos más rápidos → caché inteligente

Nexus Inteligente replica este pipeline natural.

---

**Versión**: 2.0  
**Creado**: Abril 2026  
**Estado**: Producción
