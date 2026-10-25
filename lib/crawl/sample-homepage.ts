import { safeFetch } from '@/lib/net/fetch';

/** Repository homepages are untrusted, including every redirect destination. */
export async function sampleHomepageStatus(url: string): Promise<number | null> {
  const fetched = await safeFetch(url, 'background');
  if (!fetched) return null;
  // Sampling retains only the status; release the response and origin permit immediately.
  await fetched.response.body?.cancel().catch(() => {});
  return fetched.response.status;
}
