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
import { englishWord, ENGLISH_FUNCTION_WORDS } from "./english-lexicon";

export type EnglishResultEvidence = {
  english: number; foreign: number; ambiguous: number; accented: number;
  /** Lexicon words (english-lexicon.ts, any case, regular inflections), function words included; `content` excludes them. */
  known: number; content: number;
  /** Words that are none of the above: lowercase (`unknown`) or capitalised, likely names (`names`). */
  unknown: number; names: number;
};

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
  const evidence: EnglishResultEvidence = { english: 0, foreign: 0, ambiguous: 0, accented: 0, known: 0, content: 0, unknown: 0, names: 0 };
  const known = (lower: string) => { evidence.known++; if (!ENGLISH_FUNCTION_WORDS.has(lower.replaceAll("’", "'"))) evidence.content++; };
  words.forEach((word, index) => {
    const lower = word.toLowerCase();
    if (word.length === 1) {
      if (lower === "a" || lower === "i") known(lower);
      else if (word === lower && FOREIGN.has(lower)) evidence.foreign++;
      return;
    }
    // Acronyms (API, PDF, FREE) and inner capitals (WhatsApp, minFraud) are names; a long all-caps lexicon word (SYSTEM) still counts.
    if (word === word.toUpperCase()) { if (word.length >= 5 && englishWord(lower)) known(lower); return; }
    if (/\p{Ll}\p{Lu}/u.test(word)) return;
    const plain = word === lower || (index === 0 && word.slice(1) === lower.slice(1));
    if (ENGLISH.has(lower)) { evidence.english++; known(lower); }
    else if (LOANWORDS.has(lower)) known(lower);
    else if ((plain && FOREIGN.has(lower)) || NON_ENGLISH_LETTER.test(word) || ROMANIZED_KOREAN.test(lower)) evidence.foreign++;
    else if (plain && AMBIGUOUS.has(lower)) evidence.ambiguous++;
    else if (/[^\x00-\x7f’]/u.test(word)) evidence.accented++;
    else if (englishWord(lower)) known(lower);
    else if (word !== lower) evidence.names++;
    else evidence.unknown++;
  });
  return evidence;
}

/** Rejects a translated result only on clear evidence: two foreign words that outnumber English function words. */
export function clearlyNotEnglish({ english, foreign }: EnglishResultEvidence): boolean {
  return foreign >= 2 && foreign > english;
}

/**
 * A changed result of two or more words in which lexicon words are under a third (capitalised unknown words weigh half)
 * is not shown to be English: "Kalkulator zakat", "Hesap makinesi app". Looser than the unchanged-source rule because a
 * Korean source answered in another Latin language is rare, while short English translations ("Neovim config") are common.
 */
export function lacksEnglishWords(evidence: EnglishResultEvidence): boolean {
  const others = evidence.unknown + evidence.foreign + evidence.ambiguous + evidence.accented;
  return evidence.known + others + evidence.names >= 2 && evidence.known < (evidence.known + others + evidence.names / 2) / 3;
}

/**
 * The model returned the source unchanged, so accepting it publishes the source as English for good. Requires
 * POSITIVE evidence, not just the absence of foreign words: at least two lexicon words, one of them a content word,
 * making up at least 70% of the words (capitalised unknown words, likely names, weigh half). Doubtful words
 * (foreign, ambiguous, accented) are allowed only beside three or more lexicon words: one, or one per six lexicon
 * words in longer text ("Tool for Kraków public transport").
 */
export function unchangedSourceLooksEnglish(evidence: EnglishResultEvidence): boolean {
  const { known, content, unknown, names } = evidence;
  const doubtful = evidence.foreign + evidence.ambiguous + evidence.accented;
  const allowed = known >= 3 ? Math.max(1, Math.floor(known / 6)) : 0;
  return doubtful <= allowed && known >= 2 && content >= 1
    && known >= SOURCE_NATIVE_RATIO * (known + unknown + doubtful + names / 2);
}
const SOURCE_NATIVE_RATIO = 0.7;

/**
 * Refusals and meta answers instead of a translation. Each pattern is either the whole answer (brackets, quotes and end
 * punctuation ignored) or a statement about the text/translation itself, so ordinary taglines that merely mention
 * translation ("Translate memes that can't be translated", "Okay, let's plan your week") pass. The validator skips
 * this when the source contains the same phrase.
 */
const WHOLE_ANSWER = new RegExp(String.raw`^(?:n\/?a|none|null|undefined|nil|empty|blank|unchanged|no changes?|not applicable|untranslated|`
  + String.raw`not translated|same|same as (?:the )?(?:original|source|input|above)|(?:the )?original(?: text)?|(?:there is )?nothing to translate|`
  + String.raw`no translation(?: is)? (?:needed|necessary|required|available|possible)|translation(?: is)? (?:not )?(?:needed|necessary|required|available|possible|unavailable)|`
  + String.raw`(?:(?:this|it|that)(?: text)? is )?already (?:written )?(?:in )?english|todo|tbd|i (?:do not|don'?t) know|lorem ipsum dolor sit amet.*)$`, "iu");
const META_ANSWER = new RegExp([
  // "Here is the translation: …", "As requested, here is the English version"
  String.raw`^(?:here(?:'s| is| are)|below is|the following is|as requested)\b[^.:：]{0,40}\b(?:translation|translated|english version|in english)\b`,
  String.raw`^(?:english|english translation|en)\s*[:：]`,
  // statements about the input
  String.raw`\b(?:text|input|sentence|tagline|description|content|phrase|string)\s+(?:is already|appears to be|seems to be|looks like)\s+(?:written\s+)?(?:in\s+)?(?:english|korean|japanese|chinese)\b`,
  String.raw`^(?:this|it) is (?:a |an )?(?:product |brand |proper |company |app |project )?(?:name|noun|brand|title)\b`,
  String.raw`\b(?:it|this|text|name|term)\s+(?:\S+\s+){0,2}?(?:should not|shouldn'?t|must not|need not|does not need to|doesn'?t need to|cannot|can ?not|can'?t|could not|couldn'?t)\s+be\s+translated\b`,
  String.raw`\b(?:kept|left|remains?)\s+(?:as[- ]is|unchanged|untranslated)\b`,
  String.raw`\bproper noun\b|^note\s*[:：]`,
  // first-person refusals and assistant boilerplate
  String.raw`^(?:(?:sorry|apologies|unfortunately)[,!.]?\s*)?i(?:'m| am)?\s+(?:cannot|can ?not|can'?t|could not|couldn'?t|unable to|not able to|won'?t|will not)\s+(?:translat|help|assist|provide|process|comply|understand|determine|identify|read|access|do that)`,
  String.raw`^(?:sorry|apologies|unfortunately)[,!.]?\s+(?:i|but|this|the)\b.{0,40}\b(?:translat|unable|cannot|can'?t|not able)`,
  String.raw`\bas an ai(?: language)? model\b|\bas a (?:large )?language model\b|^i(?:'m| am) an ai (?:language model|assistant|model)\b`,
  String.raw`^(?:sure|certainly|of course|okay|ok|absolutely)[,!.]?\s+(?:here\b|i(?:'ll| will| can)\b|the translation\b)`,
  String.raw`^please (?:provide|enter|send|paste|share|give)\b`,
].join("|"), "iu");
const BRACKETS = /^[\s"'“”‘’(\[{<]+|[\s"'“”‘’)\]}>.!?…。]+$/gu;

export function translationRefusal(text: string): boolean {
  const value = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return WHOLE_ANSWER.test(value.replace(BRACKETS, "")) || META_ANSWER.test(value);
}
