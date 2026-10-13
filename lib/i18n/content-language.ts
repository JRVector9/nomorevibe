/** Original bodies remain unchanged; only strong Latin-script evidence is labelled. */
export function englishLang(text: string | null | undefined): "en" | undefined {
  if (!text || /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return undefined;
  const letters = text.match(/\p{L}/gu) ?? [];
  const latin = letters.filter((letter) => /[A-Za-z]/.test(letter)).length;
  return letters.length >= 3 && latin / letters.length >= 0.9 ? "en" : undefined;
}
