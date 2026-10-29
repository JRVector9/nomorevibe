import "server-only";
import { withStoredAdminStagePools } from "@/lib/llm/admin-model-pools";
import { textHash } from "@/lib/crawl/translate";
import { resolveSearchQuery as resolve, warmQueryTranslation as warm, searchQuerySourceLocale } from "./search-translation";

/** Public request boundary. Settings failure keeps the original search and never calls an unselected model. */
export async function resolveSearchQuery(query: string | undefined, options: { waitForTranslation?: boolean } = {}) {
  if (!query || !searchQuerySourceLocale(query)) return resolve(query, options);
  try { return await withStoredAdminStagePools(`search:${textHash(query)}`, () => resolve(query, options)); }
  catch { return resolve(query, { waitForTranslation: false }); }
}
export async function warmQueryTranslation(query: string) {
  if (!searchQuerySourceLocale(query)) return;
  try { await withStoredAdminStagePools(`search:${textHash(query)}`, () => warm(query)); }
  catch { /* Do not start a model call when its DB selection cannot be read. */ }
}
