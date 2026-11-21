import "server-only";
import { withStoredAdminStagePools } from "@/lib/llm/admin-model-pools";
import { textHash } from "@/lib/crawl/translate";
import { resolveSearchQuery as resolve, warmQueryTranslation as warm, type SearchQueryOptions, type MultilingualSearchMode } from "./search-translation";

// Conservative optimization only. The original resolver remains authoritative about supported languages.
const mayTranslate = (query: string, mode?: MultilingualSearchMode) => /[\p{Script=Hangul}\p{Script=Han}]/u.test(query)
  || (mode && mode !== "off" && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query));

/** Public request boundary. Settings failure keeps the original search and never calls an unselected model. */
export async function resolveSearchQuery(query: string | undefined, options: SearchQueryOptions = {}) {
  if (!query || !options.waitForTranslation || !mayTranslate(query, options.mode)) return resolve(query, options);
  try { return await withStoredAdminStagePools(`search:${textHash(query)}`, () => resolve(query, options)); }
  catch { return resolve(query, { ...options, waitForTranslation: false }); }
}
export async function warmQueryTranslation(query: string, options: Pick<SearchQueryOptions, "mode"> = {}) {
  if (!mayTranslate(query, options.mode)) return warm(query, options);
  try { await withStoredAdminStagePools(`search:${textHash(query)}`, () => warm(query, options)); }
  catch { /* Do not start a model call when its DB selection cannot be read. */ }
}
