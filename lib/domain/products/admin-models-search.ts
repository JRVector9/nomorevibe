import "server-only";
import { withStoredAdminStagePools } from "@/lib/llm/admin-model-pools";
import { textHash } from "@/lib/crawl/translate";
import { resolveSearchQuery as resolve, warmQueryTranslation as warm } from "./search-translation";

// Conservative optimization only. The original resolver remains authoritative about supported languages.
const mayTranslate = (query: string) => /[\p{Script=Hangul}\p{Script=Han}]/u.test(query);

/** Public request boundary. Settings failure keeps the original search and never calls an unselected model. */
export async function resolveSearchQuery(query: string | undefined, options: { waitForTranslation?: boolean } = {}) {
  if (!query || !options.waitForTranslation || !mayTranslate(query)) return resolve(query, options);
  try { return await withStoredAdminStagePools(`search:${textHash(query)}`, () => resolve(query, options)); }
  catch { return resolve(query, { waitForTranslation: false }); }
}
export async function warmQueryTranslation(query: string) {
  if (!mayTranslate(query)) return warm(query);
  try { await withStoredAdminStagePools(`search:${textHash(query)}`, () => warm(query)); }
  catch { /* Do not start a model call when its DB selection cannot be read. */ }
}
