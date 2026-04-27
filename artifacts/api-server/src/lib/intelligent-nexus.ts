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
  emotion: "neutral" | "excited" | "calm" | "sad" | "questioning" | "emphatic";
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
  // Conjunciones
  "y": "conj", "o": "conj", "pero": "conj", "sino": "conj", "porque": "conj", "aunque": "conj",
  // Adverbios comunes
  "no": "adv", "sí": "adv", "muy": "adv", "bien": "adv", "mal": "adv", "siempre": "adv",
  // Interjecciones
  "aja": "intj", "ajá": "intj", "mm": "intj", "eh": "intj", "uh": "intj",
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

function detectEmotion(word: string, nextWord?: string, isPunctuation?: boolean): "neutral" | "excited" | "calm" | "sad" | "questioning" | "emphatic" {
  const lower = word.toLowerCase();
  
  // Palabras negativas
  if (["no", "nunca", "jamás", "terrible", "horrible", "malo"].includes(lower)) return "emphatic";
  
  // Palabras positivas
  if (["sí", "genial", "excelente", "maravilloso", "perfecto", "amor"].includes(lower)) return "excited";
  
  // Preguntas
  if (isPunctuation && (word === "¿" || nextWord?.startsWith("?"))) return "questioning";
  
  // Suavidad/calma
  if (["tranquilo", "suave", "lentamente", "calmado", "paciencia"].includes(lower)) return "calm";
  
  // Tristeza
  if (["triste", "lloro", "dolor", "sufro", "perdí", "adiós"].includes(lower)) return "sad";
  
  return "neutral";
}

function detectEmphasis(text: string, wordPosition: number, totalWords: number): number {
  let emphasis = 0;
  
  // Puntuación múltiple = énfasis extremo
  if (text.match(/!{2,}/)) emphasis += 40;
  if (text.match(/\?{2,}/)) emphasis += 20;
  
  // MAYÚSCULAS = énfasis
  if (/[A-Z]{3,}/.test(text)) emphasis += 30;
  
  // Palabras finales de frase = más énfasis
  if (wordPosition === totalWords - 1) emphasis += 10;
  
  // Palabras iniciales (después de pausa) = énfasis moderado
  if (wordPosition === 0) emphasis += 5;
  
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
  
  // Velocidad según emoción
  if (emotion === "excited") {
    prosody.push({ type: "speed", value: 120, description: "más rápido" });
  } else if (emotion === "calm") {
    prosody.push({ type: "speed", value: 80, description: "más lento" });
  } else if (emotion === "questioning") {
    prosody.push({ type: "speed", value: 90, description: "entonación interrogativa" });
  }
  
  // Tono según emoción
  if (emotion === "excited") {
    prosody.push({ type: "pitch", value: 120, description: "tono más agudo" });
  } else if (emotion === "sad") {
    prosody.push({ type: "pitch", value: 70, description: "tono más grave" });
  }
  
  // Volumen según énfasis
  if (emphasis > 50) {
    prosody.push({ type: "volume", value: 100 + Math.min(30, emphasis), description: "más fuerte" });
  }
  
  // Pausa después de fin de frase
  if (pos === "end" && !isQuestion) {
    prosody.push({ type: "pause", value: 100, description: "pausa natural" });
  }
  
  return prosody;
}

// ─── AGRUPACIÓN EN MICROFRASES ────────────────────────────────────────────

export function groupIntoMicroPhrases(tokens: SemanticToken[]): MicroPhrase[] {
  const microPhrases: MicroPhrase[] = [];
  let current: SemanticToken[] = [];
  
  for (const token of tokens) {
    current.push(token);
    
    // Fracturamos en:
    // 1. Punto/coma = nueva microunidad
    // 2. Después de 4-6 palabras = nueva microunidad
    // 3. Cambio emocional significativo = nueva microunidad
    
    const isPunctuation = token.pos === "punct";
    const tooLong = current.length > 6;
    const emotionChange = current.length > 1 && 
      current[current.length - 1].emotion !== current[current.length - 2].emotion;
    
    if (isPunctuation || tooLong || emotionChange) {
      if (current.length > 0) {
        microPhrases.push(createMicroPhrase(current));
        current = [];
      }
    }
  }
  
  // Microunidad final
  if (current.length > 0) {
    microPhrases.push(createMicroPhrase(current));
  }
  
  return microPhrases;
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
  emotion?: string; // "neutral", "excited", "calm", "sad", "emphatic"
  prosodyMarkups?: string; // markup opcional para el motor TTS
}

export function generateTTSParams(microPhrase: MicroPhrase): Partial<TTSParams> {
  const params: Partial<TTSParams> = {};
  
  // Calcular promedios prosódicos
  let totalSpeed = 100, totalPitch = 100, totalVolume = 100;
  let emotionsWeighted: Record<string, number> = {};
  
  for (const token of microPhrase.tokens) {
    for (const prosodyMarker of token.prosody) {
      switch (prosodyMarker.type) {
        case "speed": totalSpeed += (prosodyMarker.value - 100) * 0.1; break;
        case "pitch": totalPitch += (prosodyMarker.value - 100) * 0.1; break;
        case "volume": totalVolume = prosodyMarker.value; break;
      }
    }
    emotionsWeighted[token.emotion] = (emotionsWeighted[token.emotion] || 0) + 1;
  }
  
  params.speed = totalSpeed / 100;
  params.pitch = totalPitch / 100;
  params.volume = Math.min(100, totalVolume);
  
  // Emoción dominante
  const dominantEmotion = Object.entries(emotionsWeighted).sort((a, b) => b[1] - a[1])[0];
  if (dominantEmotion) params.emotion = dominantEmotion[0];
  
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
