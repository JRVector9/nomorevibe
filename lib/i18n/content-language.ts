const ENGLISH_WORDS = new Set(["the", "with", "your", "that", "this", "from", "for", "and", "into", "you", "helps", "using", "built", "create", "is"]);
const SOFTWARE_WORDS = new Set(["tool", "tools", "software", "browser", "files", "code", "coding", "search", "notes", "manage", "build", "track", "open", "source", "app", "platform", "data", "server", "developer", "developers", "agent", "agents", "automate", "generate"]);
// Short English imperatives can be clear without an article. Require the whole
// action/object phrase so shared nouns or appended foreign prose remain uncertain.
const ENGLISH_ACTION_PHRASE = /^(?:manage|schedule|organize|track)\s+(?:(?:your|team)\s+)?(?:meetings?|tasks?|projects?|notes?|files?)[.!?]?$/i;

/** Latin letters alone do not establish English. Shared by display and readiness. */
export function hasEnglishEvidence(text: string): boolean {
  if (/[^\x00-\x7f\p{P}\p{S}\p{N}\s]/u.test(text)) return false;
  if (ENGLISH_ACTION_PHRASE.test(text.trim())) return true;
  const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
  const markers = [...words].filter((word) => ENGLISH_WORDS.has(word)).length;
  return markers >= 2 || (markers >= 1 && [...words].filter((word) => SOFTWARE_WORDS.has(word)).length >= 2);
}

export function englishLang(text: string | null | undefined): "en" | undefined {
  return text && hasEnglishEvidence(text) ? "en" : undefined;
}
