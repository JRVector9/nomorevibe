import type { ReactionDevice, ReactionMine, ReactionSummary } from "@/lib/domain/reactions/contract";
import type { Locale } from "@/lib/i18n/locales";
import type { ReactionSource, ReactionTag, ReactionVerdict } from "@/lib/me/contract";

/** 써봤어요 쓰기 요청 — 상세 써보기 판과 마이페이지 써봤어요 탭이 같이 쓴다. 응답 오류는 me 문구 열쇠로 바꾼다 */

export type ReactionBody = {
  verdict: ReactionVerdict; tags: ReactionTag[]; comment: string | null;
  source: ReactionSource; device: ReactionDevice; locale: Locale;
  /** 숨은 칸(봇 미끼) 값 — 사람은 비워 둔다 */
  website: string;
};
export type ReactionFailure = { ok: false; errorKey: "try.error.rate" | "try.error.changes" | "try.error.invalid" | "try.error.failed" };

/** 휴대폰 폭 — 판은 시트로, 기록은 device=phone */
export function phoneWidth(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
}

const endpoint = (slug: string) => `/api/products/${encodeURIComponent(slug)}/reactions`;
const headersFor = (csrfToken: string | null): Record<string, string> => ({ "content-type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) });

async function failure(response?: Response): Promise<ReactionFailure> {
  const code = response ? ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error : undefined;
  return {
    ok: false,
    errorKey: code === "reaction_change_limited" ? "try.error.changes" : code === "reaction_rate_limited" ? "try.error.rate"
      : code === "reaction_invalid" ? "try.error.invalid" : "try.error.failed",
  };
}

export async function putReactionRequest(slug: string, body: ReactionBody, csrfToken: string | null):
  Promise<{ ok: true; mine: ReactionMine; summary: ReactionSummary | null } | ReactionFailure> {
  try {
    const response = await fetch(endpoint(slug), { method: "PUT", cache: "no-store", headers: headersFor(csrfToken), body: JSON.stringify(body) });
    if (!response.ok) return failure(response);
    const value = await response.json() as { mine: ReactionMine; summary: ReactionSummary | null };
    return { ok: true, mine: value.mine, summary: value.summary };
  } catch {
    return failure();
  }
}

/** keepalive — 마이페이지에서 되돌리기를 기다리다 페이지를 떠나도 지우기는 간다 */
export async function deleteReactionRequest(slug: string, csrfToken: string | null, keepalive = false):
  Promise<{ ok: true; summary: ReactionSummary | null } | ReactionFailure> {
  try {
    const response = await fetch(endpoint(slug), { method: "DELETE", cache: "no-store", keepalive, headers: headersFor(csrfToken) });
    if (!response.ok) return failure(response);
    return { ok: true, summary: ((await response.json()) as { summary: ReactionSummary | null }).summary };
  } catch {
    return failure();
  }
}
