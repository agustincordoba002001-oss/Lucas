/**
 * NEXUS INTELIGENTE v2: Motor de síntesis que aprende y entiende como persona
 * 
 * Características:
 * - Análisis semántico profundo (entonación, énfasis, contexto)
 * - Tokens prosódicos (no solo palabras, sino "microfrases" con emoción)
 * - Aprendizaje continuo (preferencias de pronunciación por contexto)
 * - Comprensión de puntuación implícita y explícita
 * - Análisis de intensidad emocional y énfasis natural
 */

export interface ProsodicMarker {
  type: "emphasis" | "pause" | "speed" | "pitch" | "volume" | "emotion";
  value: number; // 0-100
  description: string;
}

export interface SemanticToken {
  word: string;
  lemma: string; // raíz de la palabra (si es plural → sing, tiempos verbales → infinitivo)
  pos: "noun" | "verb" | "adj" | "adv" | "prep" | "conj" | "punct" | "intj"; // part of speech
  context: string; // contexto anterior (2 palabras)
  emotion: "neutral" | "excited" | "calm" | "sad" | "questioning" | "emphatic" | "surprised" | "angry";
  prosody: ProsodicMarker[];
  position: "start" | "middle" | "end" | "standalone"; // posición en frase
  isQuestion: boolean;
  emphasisLevel: number; // 0-100
}

export interface MicroPhrase {
  tokens: SemanticToken[];
  audio?: Buffer; // caché de audio
  signature: string; // hash para búsqueda rápida
  learningScore: number; // qué tan bien entendemos esta microunidad
  usageCount: number; // cuántas veces se repitió
}

export interface LearningContext {
  voiceId: string;
  wordUsageStats: Map<string, { count: number; contexts: string[] }>;
  microphraseCache: Map<string, MicroPhrase>;
  emotionPreferences: Map<string, number>; // preferencias por emoción
  lastUpdated: Date;
}

// ─── ANÁLISIS LINGÜÍSTICO ESPAÑOL ──────────────────────────────────────────

const SPANISH_LEMMAS: Record<string, string> = {
  // Sustantivos plurales
  "perros": "perro", "gatos": "gato", "casas": "casa",
  // Verbos conjugados → infinitivo
  "hablo": "hablar", "hablas": "hablar", "habla": "hablar", "hablamos": "hablar",
  "como": "comer", "comes": "comer", "comemos": "comer",
  "vivo": "vivir", "vives": "vivir", "vivimos": "vivir",
  // Formas irregulares
  "fui": "ir", "fue": "ir", "fuimos": "ir", "van": "ir", "voy": "ir",
  "tengo": "tener", "tiene": "tener", "tienen": "tener",
  "hago": "hacer", "hace": "hacer", "hacen": "hacer",
  "soy": "ser", "eres": "ser", "es": "ser", "somos": "ser", "son": "ser",
  "digo": "decir", "dice": "decir", "dicen": "decir",
};

const PART_OF_SPEECH: Record<string, "noun" | "verb" | "adj" | "adv" | "prep" | "conj" | "punct" | "intj"> = {
  // Preposiciones
  "de": "prep", "en": "prep", "a": "prep", "por": "prep", "para": "prep", "con": "prep", "sin": "prep",
  "hacia": "prep", "desde": "prep", "entre": "prep", "durante": "prep",
  // Conjunciones y conectores (NO deben generar pausas)
  "y": "conj", "o": "conj", "pero": "conj", "sino": "conj", "porque": "conj", "aunque": "conj",
  "entonces": "conj", "luego": "conj", "después": "conj", "mientras": "conj", "cuando": "conj",
  "si": "conj", "pues": "conj", "además": "conj", "sin embargo": "conj",
  // Palabras clave que necesitan énfasis
  "siempre": "adv", "nunca": "adv", "jamás": "adv", "todavía": "adv", "aún": "adv",
  // Adverbios comunes
  "no": "adv", "sí": "adv", "muy": "adv", "bien": "adv", "mal": "adv", "realmente": "adv",
  "verdaderamente": "adv", "ciertamente": "adv", "definitivamente": "adv",
  // Interjecciones
  "aja": "intj", "ajá": "intj", "mm": "intj", "eh": "intj", "uh": "intj", "wow": "intj",
};

function getLemma(word: string): string {
  const lower = word.toLowerCase();
  return SPANISH_LEMMAS[lower] || lower;
}

function getPartOfSpeech(word: string): "noun" | "verb" | "adj" | "adv" | "prep" | "conj" | "punct" | "intj" {
  const lower = word.toLowerCase();
  if (PART_OF_SPEECH[lower]) return PART_OF_SPEECH[lower];
  
  // Heurísticas simples
  if (/^[A-Z]/.test(word)) return "noun"; // Capitalized = NP
  if (word.endsWith("ción") || word.endsWith("sión")) return "noun";
  if (word.endsWith("ar") || word.endsWith("er") || word.endsWith("ir")) return "verb";
  if (word.endsWith("mente")) return "adv";
  if (word.match(/^[.!?,;:]$/)) return "punct";
  
  return "noun"; // default
}

// ─── ANÁLISIS EMOCIONAL Y ENTONACIÓN ──────────────────────────────────────

function detectEmotion(word: string, nextWord?: string, isPunctuation?: boolean): "neutral" | "excited" | "calm" | "sad" | "questioning" | "emphatic" | "surprised" | "angry" {
  const lower = word.toLowerCase();
  
  // Palabras negativas que dan énfasis
  if (["no", "nunca", "jamás", "terrible", "horrible", "malo", "peor"].includes(lower)) return "emphatic";
  
  // Palabras positivas intensas
  if (["sí", "genial", "excelente", "maravilloso", "perfecto", "amor", "feliz", "alegría", "bueno", "mejor"].includes(lower)) return "excited";
  
  // Sorpresa/asombro
  if (["wow", "oh", "guau", "increíble", "impresionante", "sorprendente"].includes(lower)) return "surprised";
  
  // Rabia/enojo
  if (["mierda", "odio", "furioso", "enojado", "maldición", "asco", "detesto"].includes(lower)) return "angry";
  
  // Preguntas (detecta estructuras interrogativas)
  if (isPunctuation && (word === "¿" || (nextWord && nextWord.startsWith("?")))) return "questioning";
  
  // Calma/serenidad
  if (["tranquilo", "suave", "lentamente", "calmado", "paciencia", "relajado", "sereno", "paz"].includes(lower)) return "calm";
  
  // Tristeza/melancolía
  if (["triste", "lloro", "dolor", "sufro", "perdí", "adiós", "desesperado", "infeliz", "llorar"].includes(lower)) return "sad";
  
  return "neutral";
}

function detectEmphasis(text: string, wordPosition: number, totalWords: number): number {
  let emphasis = 0;
  
  // Puntuación múltiple = énfasis extremo
  if (text.match(/!{2,}/)) emphasis += 50;
  if (text.match(/\?{2,}/)) emphasis += 30;
  if (text.match(/\.{2,}/)) emphasis += 20;
  
  // MAYÚSCULAS = énfasis FUERTE
  if (/[A-Z]{3,}/.test(text)) emphasis += 40;
  if (text === text.toUpperCase() && text.length > 2) emphasis += 30;
  
  // Palabras clave siempre llevan énfasis
  const KEYWORD_EMPHASIS: Record<string, number> = {
    "siempre": 40, "nunca": 40, "jamás": 40, "importante": 35, "momento": 35,
    "ahora": 30, "hoy": 30, "ayer": 25, "mañana": 25, "verdad": 45,
    "love": 50, "odio": 50, "perfecto": 40, "horrible": 40,
  };
  const lower = text.toLowerCase();
  if (KEYWORD_EMPHASIS[lower]) {
    emphasis += KEYWORD_EMPHASIS[lower];
  }
  
  // Palabras finales de frase = más énfasis (conclusión)
  if (wordPosition === totalWords - 1) emphasis += 15;
  
  // Primera palabra después de pausa (posición 0) = inicio importante
  if (wordPosition === 0) emphasis += 10;
  
  // Palabras en el medio pero antes de puntuación = énfasis moderado
  if (wordPosition === totalWords - 2) emphasis += 8;
  
  return Math.min(100, emphasis);
}

function analyzeQuestionType(text: string): boolean {
  return /[¿?]/.test(text);
}

// ─── TOKENIZACIÓN INTELIGENTE ──────────────────────────────────────────────

export function tokenizeIntelligent(text: string, voiceId: string, learningContext: LearningContext): SemanticToken[] {
  const tokens: SemanticToken[] = [];
  
  // Expandir tags expresivos primero
  let expanded = expandSmartTags(text);
  
  // Splitear manteniendo puntuación
  const words = expanded.match(/[\p{L}\p{N}''.-]+|[.!?,;:¿?¡!]/gu) || [];
  const totalWords = words.length;
  
  let prevContext = "";
  const isQuestionSentence = analyzeQuestionType(expanded);
  
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    
    const isPunctuation = /^[.!?,;:¿?¡!]$/.test(word);
    const emotion = detectEmotion(word, words[i + 1], isPunctuation);
    const emphasis = detectEmphasis(word, i, totalWords);
    const lemma = getLemma(word);
    const pos = getPartOfSpeech(word);
    const position: "start" | "middle" | "end" | "standalone" = 
      i === 0 ? "start" : i === totalWords - 1 ? "end" : "middle";
    
    // Guardar estadísticas para aprendizaje
    if (!isPunctuation) {
      const stats = learningContext.wordUsageStats.get(lemma) || { count: 0, contexts: [] };
      stats.count++;
      if (stats.contexts.length < 5) stats.contexts.push(prevContext);
      learningContext.wordUsageStats.set(lemma, stats);
    }
    
    const token: SemanticToken = {
      word: word.toLowerCase(),
      lemma,
      pos,
      context: prevContext,
      emotion,
      prosody: generateProsody(emotion, emphasis, pos, isQuestionSentence),
      position,
      isQuestion: isQuestionSentence,
      emphasisLevel: emphasis,
    };
    
    tokens.push(token);
    
    if (!isPunctuation) prevContext = word;
  }
  
  return tokens;
}

function expandSmartTags(text: string): string {
  let result = text;
  
  // Tags expresivos con prosodias
  const smartTags: Record<string, string> = {
    // Risas -> variedades prosódicas
    "risa": "ja ja ja",
    "risita": "je je je",
    "carcajada": "ja ja ja ja ja",
    "risa-fuerte": "JA JA JA",
    
    // Silencios y pausas
    "pausa": "...",
    "pausa-larga": ".....",
    
    // Temblor emocional
    "susurro": "psst",
    "asombro": "¡¡¡oh!!!",
    "miedo": "eeeek",
    "duda": "mmm",
  };
  
  for (const [tag, expansion] of Object.entries(smartTags)) {
    const regex = new RegExp(`\\[${tag}\\]`, "gi");
    result = result.replace(regex, ` ${expansion} `);
  }
  
  return result.replace(/\s+/g, " ").trim();
}

function generateProsody(emotion: string, emphasis: number, pos: string, isQuestion: boolean): ProsodicMarker[] {
  const prosody: ProsodicMarker[] = [];
  
  // ─── VELOCIDAD ADAPTATIVA ───
  let baseSpeed = 100;
  if (emotion === "excited") baseSpeed = 115;      // +15%
  else if (emotion === "angry") baseSpeed = 120;   // +20%
  else if (emotion === "calm") baseSpeed = 85;     // -15%
  else if (emotion === "questioning") baseSpeed = 95; // -5%
  else if (emotion === "sad") baseSpeed = 80;      // -20%
  
  prosody.push({ type: "speed", value: baseSpeed, description: `velocidad ${baseSpeed}%` });
  
  // ─── TONO SEGÚN EMOCIÓN Y POSICIÓN ───
  let basePitch = 100;
  if (emotion === "excited") basePitch = 115;
  else if (emotion === "surprised") basePitch = 125;
  else if (emotion === "angry") basePitch = 105;
  else if (emotion === "sad") basePitch = 70;
  else if (emotion === "calm") basePitch = 90;
  else if (emotion === "questioning") basePitch = 110; // Subida de tono al final
  
  // Palabras clave reciben +tono
  if (emphasis > 60) basePitch += 10;
  
  prosody.push({ type: "pitch", value: Math.max(50, Math.min(150, basePitch)), description: `tono ${basePitch}%` });
  
  // ─── VOLUMEN SEGÚN ÉNFASIS ───
  const volume = Math.min(130, 100 + Math.max(0, (emphasis - 30) * 0.8));
  if (volume > 100) {
    prosody.push({ type: "volume", value: volume, description: "énfasis de volumen" });
  }
  
  // ─── PAUSAS NATURALES ───
  // Pausa después de fin de frase natural
  if (pos === "end" && !isQuestion) {
    prosody.push({ type: "pause", value: 80, description: "pausa después de oración" });
  } else if (isQuestion) {
    prosody.push({ type: "pause", value: 60, description: "mini-pausa interrogativa" });
  }
  
  // Pausa después de énfasis
  if (emphasis > 70) {
    prosody.push({ type: "pause", value: 40, description: "pausa de énfasis" });
  }
  
  return prosody;
}

// ─── AGRUPACIÓN EN MICROFRASES ────────────────────────────────────────────

export function groupIntoMicroPhrases(tokens: SemanticToken[]): MicroPhrase[] {
  const microPhrases: MicroPhrase[] = [];
  let current: SemanticToken[] = [];
  
  const NON_BREAKING_CONNECTORS = new Set(["y", "o", "pero", "sino", "porque", "aunque", "entonces", "además"]);
  
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const nextToken = tokens[i + 1];
    current.push(token);
    
    // Reglas para fracturar (crear nueva microunidad):
    // 1. Punto -> siempre fractura (si tiene >= 3 palabras)
    // 2. Coma -> fractura SOLO si la siguiente palabra NO es conector (y, pero, etc)
    // 3. Después de 8-10 palabras -> fractura (máx natural de lectura corrida)
    // 4. Cambio emocional fuerte -> fractura SOLO si no es conector
    
    const isPeriod = token.word === ".";
    const isComma = token.word === ",";
    const isSemicolon = token.word === ";";
    const tooLong = current.length > 10;
    
    // Verificar si la siguiente palabra es un conector (no fracturar)
    const nextIsConnector = nextToken && NON_BREAKING_CONNECTORS.has(nextToken.word.toLowerCase());
    
    // Cambio emocional significativo (pero no si es conector)
    const emotionChange = current.length > 5 && current.length > 1 && 
      current[current.length - 1].emotion !== current[current.length - 2].emotion &&
      !isComplementaryEmotion(current[current.length - 1].emotion, current[current.length - 2].emotion) &&
      !nextIsConnector;
    
    // Determinar si fracturar
    const shouldSplit = isPeriod || isSemicolon || 
                       (isComma && !nextIsConnector && current.length >= 5) ||
                       tooLong ||
                       emotionChange;
    
    if (shouldSplit) {
      if (current.length >= 3) {  // Mínimo 3 palabras por microunidad
        microPhrases.push(createMicroPhrase(current));
        current = [];
      }
    }
  }
  
  // Microunidad final
  if (current.length >= 3) {
    microPhrases.push(createMicroPhrase(current));
  } else if (current.length > 0 && microPhrases.length > 0) {
    // Fusionar palabras huérfanas con la microunidad anterior
    const last = microPhrases[microPhrases.length - 1];
    last.tokens.push(...current);
  } else if (current.length > 0) {
    microPhrases.push(createMicroPhrase(current));
  }
  
  return microPhrases;
}

function isComplementaryEmotion(e1: string, e2: string): boolean {
  // Emociones que pueden estar juntas sin fracturar
  const compatible = new Set([
    // excited puede ir con emphatic
    "excited:emphatic",
    "emphatic:excited",
    // calm + questioning pueden ir juntas
    "calm:questioning",
    "questioning:calm",
  ]);
  return compatible.has(`${e1}:${e2}`);
}

function createMicroPhrase(tokens: SemanticToken[]): MicroPhrase {
  const signature = tokens.map(t => `${t.word}:${t.emotion}:${t.emphasisLevel}`).join("|");
  
  return {
    tokens,
    audio: undefined,
    signature: hashSignature(signature),
    learningScore: 0.5, // empezamos neutral
    usageCount: 0,
  };
}

function hashSignature(sig: string): string {
  // Simple hash (en prod usar crypto.createHash)
  let hash = 0;
  for (let i = 0; i < sig.length; i++) {
    const char = sig.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Conversión a 32-bit int
  }
  return Math.abs(hash).toString(36);
}

// ─── CACHÉ INTELIGENTE ────────────────────────────────────────────────────

export function getMicroPhraseAudio(microPhrase: MicroPhrase, cache: Map<string, MicroPhrase>): Buffer | null {
  const cached = cache.get(microPhrase.signature);
  if (cached?.audio) {
    cached.usageCount++;
    // Aumentar learning score si se reutiliza
    cached.learningScore = Math.min(1.0, cached.learningScore + 0.05);
    return cached.audio;
  }
  return null;
}

export function storeMicroPhraseAudio(microPhrase: MicroPhrase, audio: Buffer, cache: Map<string, MicroPhrase>): void {
  microPhrase.audio = audio;
  microPhrase.usageCount++;
  cache.set(microPhrase.signature, microPhrase);
}

// ─── GENERACIÓN DE PARÁMETROS TTS ─────────────────────────────────────────

export interface TTSParams {
  texto: string;
  voiceId: string;
  speed?: number; // 0.5-2.0
  pitch?: number; // 0.5-2.0
  volume?: number; // 0-100
  emotion?: string; // "neutral", "excited", "calm", "sad", "emphatic", "surprised", "angry"
  prosodyMarkups?: string; // markup opcional para el motor TTS
}

export function generateTTSParams(microPhrase: MicroPhrase): Partial<TTSParams> {
  const params: Partial<TTSParams> = {};
  
  // Calcular promedios prosódicos desde tokens
  let totalSpeed = 100, totalPitch = 100, totalVolume = 100;
  const emphasisLevels: number[] = [];
  let emotionsWeighted: Record<string, number> = {};
  
  for (const token of microPhrase.tokens) {
    emphasisLevels.push(token.emphasisLevel);
    emotionsWeighted[token.emotion] = (emotionsWeighted[token.emotion] || 0) + 1;
    
    for (const prosodyMarker of token.prosody) {
      switch (prosodyMarker.type) {
        case "speed": totalSpeed += (prosodyMarker.value - 100) * 0.15; break;
        case "pitch": totalPitch += (prosodyMarker.value - 100) * 0.15; break;
        case "volume": totalVolume = prosodyMarker.value; break;
      }
    }
  }
  
  // Emoción dominante
  const dominantEmotion = Object.entries(emotionsWeighted).sort((a, b) => b[1] - a[1])[0];
  const emotion = dominantEmotion ? dominantEmotion[0] : "neutral";
  
  // Base speeds segun emoción
  let baseSpeed = 100, basePitch = 100, baseVolume = 100;
  
  switch (emotion) {
    case "excited":
      baseSpeed = 115;
      basePitch = 120;
      baseVolume = 110;
      break;
    case "surprised":
      baseSpeed = 110;
      basePitch = 130;
      baseVolume = 105;
      break;
    case "angry":
      baseSpeed = 125;
      basePitch = 110;
      baseVolume = 120;
      break;
    case "sad":
      baseSpeed = 80;
      basePitch = 70;
      baseVolume = 85;
      break;
    case "calm":
      baseSpeed = 90;
      basePitch = 95;
      baseVolume = 95;
      break;
    case "questioning":
      baseSpeed = 100;
      basePitch = 115;
      baseVolume = 100;
      break;
    case "emphatic":
      baseSpeed = 105;
      basePitch = 105;
      baseVolume = 115;
      break;
  }
  
  // Considerar énfasis promedio para modular aún más
  const avgEmphasis = emphasisLevels.reduce((a, b) => a + b, 0) / emphasisLevels.length || 0;
  if (avgEmphasis > 50) {
    baseSpeed += 5;
    basePitch += 5;
    baseVolume += 10;
  }
  
  params.speed = (baseSpeed / 100) * (0.95 + Math.random() * 0.1);  // ±5%
  params.pitch = (basePitch / 100) * (0.95 + Math.random() * 0.1);  // ±5%
  params.volume = Math.min(130, Math.max(70, (baseVolume / 100) * 100 * (0.95 + Math.random() * 0.1)));
  params.emotion = emotion;
  
  // Markup prosódico para motores TTS avanzados
  const markups = microPhrase.tokens
    .map(t => {
      const speedMark = t.prosody.find(p => p.type === "speed");
      const pitchMark = t.prosody.find(p => p.type === "pitch");
      return `<prosody rate="${speedMark?.value || 100}%" pitch="${pitchMark?.value || 100}%">${t.word}</prosody>`;
    })
    .join(" ");
  params.prosodyMarkups = markups;
  
  return params;
}

// ─── ANÁLISIS ADAPTATIVO (APRENDIZAJE) ────────────────────────────────────

export function updateLearningContext(voiceId: string, microPhrases: MicroPhrase[], context: LearningContext): void {
  for (const phrase of microPhrases) {
    const existing = context.microphraseCache.get(phrase.signature);
    if (existing) {
      existing.usageCount++;
      existing.learningScore = Math.min(1.0, existing.learningScore + 0.02);
    } else {
      phrase.learningScore = 0.3; // Nueva microunidad = menor confianza inicial
      context.microphraseCache.set(phrase.signature, phrase);
    }
  }
  context.lastUpdated = new Date();
}

export function getLearningStats(context: LearningContext): {
  totalWordsLearned: number;
  microphrasesCached: number;
  averageLearningScore: number;
  topWords: string[];
} {
  const scores = Array.from(context.microphraseCache.values()).map(m => m.learningScore);
  const topWords = Array.from(context.wordUsageStats.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([w]) => w);
  
  return {
    totalWordsLearned: context.wordUsageStats.size,
    microphrasesCached: context.microphraseCache.size,
    averageLearningScore: scores.length > 0 ? scores.reduce((a, b) => a + b) / scores.length : 0,
    topWords,
  };
}

// ─── INICIALIZACIÓN ──────────────────────────────────────────────────────

export function createLearningContext(voiceId: string): LearningContext {
  return {
    voiceId,
    wordUsageStats: new Map(),
    microphraseCache: new Map(),
    emotionPreferences: new Map(),
    lastUpdated: new Date(),
  };
}
