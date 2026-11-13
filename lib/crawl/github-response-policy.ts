/** Raw commit prose is accepted only in memory; cached facts retain the smaller cap. */
export const GITHUB_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const COMMIT_SEARCH_MAX_BYTES = 8 * 1024 * 1024;
export const DISCOVERY_CACHE_MAX_BYTES = GITHUB_RESPONSE_MAX_BYTES;

export function githubResponseMaxBytes(path: string): number {
  return path.split('?')[0] === '/search/commits' ? COMMIT_SEARCH_MAX_BYTES : GITHUB_RESPONSE_MAX_BYTES;
}
