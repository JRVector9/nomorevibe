import { createHash } from 'node:crypto';
import { fetchCapped, type CappedFetchResult } from '@/lib/net/fetch';

export const KOREAN_DETECTOR_VERSION = 'ko-prose-v1';
export const KOREAN_README_PATHS = ['README.md', 'readme.md', 'README.ko.md', 'README-ko.md', 'README_KO.md', 'docs/ko/README.md'] as const;
export type KoreanLanguageResult = { language: 'yes' | 'no' | 'unknown'; source: string | null; contentHash: string | null; hangul: number; reason: string };
export type KoreanDocumentRequest = (url: string, options: { maxBytes: number; timeoutMs: number }) => Promise<CappedFetchResult>;

/** Count explanatory prose only. A translation link, Korean filename, code or badge is not Korean project documentation. */
export function koreanProseEvidence(text: string, description = false): { yes: boolean; hangul: number } {
  const prose = text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ').replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ').replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const hangul = [...prose.matchAll(/[가-힣]/g)].length;
  const words = [...prose.matchAll(/[가-힣]{2,}/g)].length;
  return { yes: hangul >= (description ? 12 : 20) && words >= (description ? 3 : 4), hangul };
}

/** Only fixed public raw paths are fetched. Repository content never supplies a request URL. */
export async function inspectKoreanProject(repo: string, description: string | null, options: {
  request?: KoreanDocumentRequest; deadlineAt?: number; signal?: AbortSignal;
} = {}): Promise<KoreanLanguageResult> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) throw new Error('invalid_korean_repository');
  const positive = (text: string, source: string, hangul: number): KoreanLanguageResult => ({ language: 'yes', source,
    contentHash: createHash('sha256').update(text).digest('hex'), hangul, reason: KOREAN_DETECTOR_VERSION });
  const descriptionEvidence = koreanProseEvidence(description ?? '', true);
  if (descriptionEvidence.yes) return positive(description!, 'description', descriptionEvidence.hangul);
  const request = options.request ?? ((url, limits) => fetchCapped(url, { ...limits, signal: options.signal }));
  let unknown = false, maxHangul = descriptionEvidence.hangul;
  for (const path of KOREAN_README_PATHS) {
    const remaining = options.deadlineAt === undefined ? 3000 : options.deadlineAt - Date.now();
    if (options.signal?.aborted || remaining <= 0) { unknown = true; break; }
    let result: CappedFetchResult;
    try { result = await request(`https://raw.githubusercontent.com/${repo}/HEAD/${path}`, { maxBytes: 128 * 1024, timeoutMs: Math.min(3000, remaining) }); }
    catch { unknown = true; continue; }
    if (result.ok && result.status === 200) {
      if (result.truncated) unknown = true;
      const text = result.body.toString('utf8');
      const evidence = koreanProseEvidence(text); maxHangul = Math.max(maxHangul, evidence.hangul);
      if (evidence.yes) return positive(text, path, evidence.hangul);
    } else if (!result.ok && result.reason === 'http' && result.status === 404) { /* Known absence, continue localized probes. */ }
    else { unknown = true; }
  }
  return { language: unknown ? 'unknown' : 'no', source: null, contentHash: null, hangul: maxHangul,
    reason: unknown ? 'document_unavailable' : 'korean_prose_not_found' };
}
