/**
 * English *result* evidence for product translations whose requested locale is "en".
 *
 * Not a language detector. Display `lang`, source readiness and demand keep the conservative shared
 * `hasEnglishEvidence` (lib/i18n/content-language.ts). These word counts only refine what the
 * translation validator already knows: the model was asked for English and produced Latin-only prose.
 *
 * Words are NFKC letter runs (apostrophes kept, so "we've" is one word). All-caps tokens are acronyms
 * and never count. Word lists are matched only when the word is lowercase or sentence-initial, so
 * capitalised names such as "Las Vegas" or "Das Keyboard" stay neutral.
 *  - english: occurrences of common English function words.
 *  - foreign: occurrences of (1) frequent words of other Latin-script languages that are not English
 *    words; (2) words containing letters that English prose does not use (ñ ß ğ ş ı ř ů ł ő …);
 *    (3) romanised-Korean particle endings (-reul, -neun, -hago …).
 *  - ambiguous: short function words shared by English names/idioms and other languages (de, la, el …).
 *  - accented: other words with diacritics (é ü á …), except common English loanwords.
 */
export type EnglishResultEvidence = { english: number; foreign: number; ambiguous: number; accented: number };

const ENGLISH = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "with", "and", "or", "by", "from", "into", "your", "you",
  "that", "this", "these", "is", "are", "be", "it", "its", "as", "at", "can", "will", "all", "any", "more", "new", "via", "own",
  "helps", "help", "using", "use", "built", "create", "which", "without", "about", "over", "based", "lets", "make", "makes",
  "allows", "just", "not", "my", "our", "we", "how", "what", "when", "than"]);

// Each entry is common in short software or student-project blurbs of its language and is not itself an English word.
const FOREIGN = new Set([
  // es
  "los", "las", "del", "para", "una", "unos", "unas", "por", "que", "tus", "sus", "y", "con", "más", "también", "herramienta",
  "aplicación", "gestión", "gestor", "gestiona", "proyecto", "proyectos", "archivos", "usuario", "usuarios", "sencillo", "sencilla",
  "fácil", "puedes", "página", "sistema", "materia", "curso", "práctica", "ejercicios", "tienda", "juego", "trabajo",
  // pt
  "uma", "não", "você", "seu", "sua", "seus", "suas", "ferramenta", "aplicativo", "projeto", "projetos", "arquivos", "gerenciar",
  "aula", "exercícios", "loja", "jogo",
  // fr
  "les", "des", "avec", "une", "dans", "votre", "vos", "vous", "nous", "outil", "fichiers", "données", "projet", "projets", "très",
  "permet", "facilement", "cours", "jeu", "gestionnaire",
  // de
  "der", "das", "und", "mit", "für", "ist", "ein", "eine", "einen", "einem", "sie", "ihre", "zu", "von", "auf", "nicht", "oder",
  "sich", "werden", "wird", "werkzeug", "verwalten", "einfach", "daten", "dateien", "projekt", "projekte",
  // it
  "il", "gli", "della", "delle", "degli", "che", "di", "strumento", "gestione", "progetto", "progetti", "semplice", "corso", "esercizi",
  // nl
  "het", "een", "voor", "zijn", "naar", "maken", "eenvoudig", "beheren", "bestanden",
  // id / ms
  "dan", "untuk", "yang", "dengan", "dari", "itu", "adalah", "bisa", "dapat", "anda", "kami", "aplikasi", "sistem", "berbasis",
  "membuat", "mengelola", "sederhana", "pengelolaan", "informasi", "menggunakan", "sebuah", "tugas", "akhir", "kuliah", "belajar",
  "latihan", "kumpulan", "catatan", "sekolah", "penjualan", "pembelajaran", "pemrograman", "toko",
  // tr
  "ve", "için", "bir", "ile", "olan", "kolay", "uygulama", "uygulaması", "basit", "yönetim", "sistemi", "proje", "projesi",
  // cs / sk / pl
  "je", "aplikace", "nástroj", "jednoduchý", "jednoduchá", "který", "která", "které", "pomocí", "správa", "dla", "oraz",
  "narzędzie", "aplikacja",
]);
// Shared with English names, idioms or code words ("de facto", "El Capitan", "en route", "roll a die"): doubt, not evidence.
const AMBIGUOUS = new Set(["de", "la", "le", "el", "en", "et", "du", "da", "al", "lo", "die", "pour", "aux", "dos"]);
// Letters of other Latin alphabets that English prose (including common loanwords) does not use.
const NON_ENGLISH_LETTER = /[ñãõßğşșţțăıěščřžůłąęśźżńőűøåæœçđơưẠ-ỹ]/iu;
const ROMANIZED_KOREAN = /^\p{L}{2,}(?:reul|eul|neun|hago|haneun|hamnida|seumnida|imnida|eseo|haeyo|ieyo|deul)$/u;
const LOANWORDS = new Set(["café", "cafés", "résumé", "résumés", "resumé", "naïve", "cliché", "clichés", "déjà", "fiancé",
  "fiancée", "protégé", "pokémon", "pokédex", "über", "piñata", "jalapeño", "façade"]);

export function englishResultEvidence(prose: string): EnglishResultEvidence {
  const words = prose.normalize("NFKC").match(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu) ?? [];
  const evidence: EnglishResultEvidence = { english: 0, foreign: 0, ambiguous: 0, accented: 0 };
  words.forEach((word, index) => {
    if (word.length >= 2 && word === word.toUpperCase()) return;
    const lower = word.toLowerCase();
    const plain = word === lower || (index === 0 && word.slice(1) === lower.slice(1));
    if (ENGLISH.has(lower)) evidence.english++;
    else if (LOANWORDS.has(lower)) return;
    else if ((plain && FOREIGN.has(lower)) || NON_ENGLISH_LETTER.test(word) || ROMANIZED_KOREAN.test(lower)) evidence.foreign++;
    else if (plain && AMBIGUOUS.has(lower)) evidence.ambiguous++;
    else if (/[^\x00-\x7f’]/u.test(word)) evidence.accented++;
  });
  return evidence;
}

/** Rejects a translated result only on clear evidence: two foreign words that outnumber English function words. */
export function clearlyNotEnglish({ english, foreign }: EnglishResultEvidence): boolean {
  return foreign >= 2 && foreign > english;
}

/**
 * The model returned the source unchanged, so accepting it publishes the source as English for good. Stricter than
 * clearlyNotEnglish: accept only when no word is doubtful (foreign, ambiguous or accented), or one doubtful word sits
 * among at least two English function words ("A client for Málaga bus times").
 */
export function unchangedSourceLooksEnglish({ english, foreign, ambiguous, accented }: EnglishResultEvidence): boolean {
  const doubtful = foreign + ambiguous + accented;
  return doubtful === 0 || (doubtful === 1 && english >= 2);
}

/**
 * Refusals and meta answers instead of a translation. The validator skips this when the source itself contains the
 * same phrase (an English source about "untranslatable" words may be echoed).
 */
export const TRANSLATION_REFUSAL = new RegExp([
  String.raw`\b(?:cannot|can ?not|can'?t|can’t|unable to|not able to|won'?t|will not)\s+(?:be\s+)?translat`,
  String.raw`\buntranslatable\b`,
  String.raw`\bno translation (?:is )?(?:needed|necessary|required|available|possible)\b`,
  String.raw`\b(?:text|input|sentence|tagline|description|content|it|this) (?:is|appears to be|seems to be) already (?:written )?(?:in )?english\b`,
  String.raw`^already (?:in )?english\b`,
  String.raw`\bas an ai(?: language)? model\b|\bas a (?:large )?language model\b|\bi am an ai\b`,
  String.raw`^(?:sorry|apologies|unfortunately)[,!.]`,
  String.raw`^(?:sure|certainly|of course|okay)[,!]`,
  String.raw`^(?:n\/?a|none|null|undefined|nothing to translate)[.!]?$`,
].join("|"), "iu");
