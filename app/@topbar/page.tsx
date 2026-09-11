import { PulseStrip } from "@/components/home/PulseStrip";
import { getHomePulse } from "@/lib/domain/products/home-pulse";

type SearchValue = string | string[] | undefined;

/**
 * 메인 메뉴 위 한 줄.
 *
 * 병렬 라우트 슬롯이라 메인에서만 채운다 — catch-all/default 짝이 다른 페이지를 비운다.
 * 집계는 본문 보드와 같은 1분 캐시를 함께 써서 쿼리는 한 번이다. 집계가 실패하면 줄을 내지
 * 않는다 — 본문이 같은 실패를 기록한다.
 */
export default async function PulseStripSlot({ searchParams }: { searchParams: Promise<Record<string, SearchValue>> }) {
  const [params, pulse] = await Promise.all([searchParams, getHomePulse().catch(() => null)]);
  if (!pulse) return null;

  // 지금 보던 목록(정렬·필터)을 그대로 두고 기준 창만 연다
  const hrefFor = (metric: string) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (key !== "metric" && first !== undefined) next.set(key, first);
    }
    next.set("metric", metric);
    return `/?${next.toString()}`;
  };

  return <PulseStrip pulse={pulse} hrefFor={hrefFor} />;
}
