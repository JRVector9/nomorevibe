import { LAST_CODE_UPDATE_LABEL } from "@/lib/copy/terms";
import type { ProductActivity } from "@/lib/domain/products/activity";
import { formatAgo, formatPublicDateTime } from "@/lib/format/time";

/**
 * 카드 메타 줄의 활동 — 공개 업데이트와 코드 업데이트 중 늦은 쪽 하나만 "최근 업데이트 3일 전"으로(UX-29).
 *
 * 메타는 한 줄로 고정한다. 날짜 두세 줄과 '최근 7일 업데이트 0회' 같은 빈 집계는 카드 높이를 들쭉날쭉하게 하고,
 * '지금 뜨는' 카드에 부정 신호로 읽혀 카드에서 뺐다. 어느 쪽 시각인지와 정확한 시각은 툴팁에 둔다.
 * 수집되지 않은 값은 그리지 않는다.
 */
export function ProductActivityRow({ activity, now }: { activity?: ProductActivity; now: Date | string | number }) {
  // 둘 다 toISOString() 글자라 글자 순서가 시각 순서다
  const at = [activity?.updatedAt, activity?.pushedAt].filter((value): value is string => Boolean(value)).sort().at(-1);
  if (!at) return null;
  const ago = formatAgo(at, now);
  // 브라우저 시계가 서버보다 늦으면 '3분 후'가 나온다 — 방금으로 본다
  const label = ago === "방금" || ago.endsWith("후") ? "방금 업데이트" : `최근 업데이트 ${ago}`;
  const kind = at === activity?.pushedAt ? LAST_CODE_UPDATE_LABEL : "최근 업데이트";
  // 서버가 그린 'n분 전'과 브라우저의 지금이 몇 초 어긋날 수 있다 — 그 차이로 hydration 경고를 내지 않는다
  return <time dateTime={at} title={`${kind} ${formatPublicDateTime(at, now)}`} suppressHydrationWarning>{label}</time>;
}
