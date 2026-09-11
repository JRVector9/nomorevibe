import type { CrawlDocument } from "@/lib/db/schema";
import { getDocument, setReadmeSample } from "@/lib/crawl/repository";
import { fetchReadmeSample } from "@/lib/crawl/readme";

/**
 * 심사에 넘길 원본. README 는 처음 심사할 때 한 번 받아 원본 옆에 둔다("" = 없음).
 * 잠깐의 실패면 이번엔 없이 간다 — 다음 심사에서 다시 받는다. 1차·2차 심사가 같이 쓴다.
 */
export async function loadReviewDocument(repo: string): Promise<CrawlDocument | undefined> {
  const document = await getDocument(repo);
  if (!document || typeof document.pageMeta?.readmeSample === "string") return document;
  const readme = await fetchReadmeSample(repo);
  if (typeof readme !== "string") return document;
  await setReadmeSample(repo, readme);
  return { ...document, pageMeta: { ...(document.pageMeta ?? {}), readmeSample: readme } };
}
