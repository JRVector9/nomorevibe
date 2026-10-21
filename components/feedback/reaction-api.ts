import type { ReactionDevice, ReactionMine, ReactionSummary } from "@/lib/domain/reactions/contract";
import type { Locale } from "@/lib/i18n/locales";
import type { ReactionSource, ReactionTag, ReactionVerdict } from "@/lib/me/contract";

/** 써봤어요 쓰기 요청 — 상세 써보기 판과 마이페이지 써봤어요 탭이 같이 쓴다. 응답 오류는 me 문구 열쇠로 바꾼다 */

/** tags·comment 를 빼면 서버가 남겨 둔 값을 그대로 둔다 — 판의 평가 단추는 평가만 보낸다 */
export type ReactionBody = {
  verdict: ReactionVerdict; tags?: ReactionTag[]; comment?: string | null;
  source: ReactionSource; device: ReactionDevice; locale: Locale;
  /** 숨은 칸(봇 미끼) 값 — 사람은 비워 둔다 */
  website: string;
};
export type ReactionFailure = { ok: false; errorKey: "try.error.rate" | "try.error.changes" | "try.error.invalid" | "try.error.failed" };
/** 판 상태 — signedIn 은 이 요청이 로그인 세션으로 읽혔는지, csrfToken 은 그 세션의 쓰기 값 */
export type ReactionPanelState = { mine: ReactionMine | null; summary: ReactionSummary | null; csrfToken: string | null; signedIn: boolean };
/** 쓰기 결과 — csrfToken 은 실제로 받아진 값(다시 받아 왔으면 새 값), signedIn 은 그 쓰기가 계정 행에 갔는지 */
type Written = { csrfToken: string | null; signedIn: boolean };

/** 휴대폰 폭 — 판은 시트로, 기록은 device=phone */
export function phoneWidth(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
}

const endpoint = (slug: string) => `/api/products/${encodeURIComponent(slug)}/reactions`;
const headersFor = (csrfToken: string | null): Record<string, string> => ({ "content-type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) });
const errorOf = async (response: Response) => ((await response.clone().json().catch(() => null)) as { error?: unknown } | null)?.error;

async function failure(response?: Response): Promise<ReactionFailure> {
  const code = response ? await errorOf(response) : undefined;
  return {
    ok: false,
    errorKey: code === "reaction_change_limited" ? "try.error.changes" : code === "reaction_rate_limited" ? "try.error.rate"
      : code === "reaction_invalid" ? "try.error.invalid" : "try.error.failed",
  };
}

/**
 * 판 읽기 — 꺼져 있으면 "hidden", 못 읽으면 null. null 은 「평가 없음」이 아니라 「모름」이다(그 값으로 쓰면 남긴 것을 덮는다).
 * reacted=false 면 이 브라우저가 이 제품을 평가한 기억이 없다 — 로그인하지 않았으면 서버가 내 평가를 찾지 않는다.
 */
export async function readReactionPanel(slug: string, reacted: boolean | null, signal?: AbortSignal): Promise<ReactionPanelState | "hidden" | null> {
  try {
    const response = await fetch(reacted === false ? `${endpoint(slug)}?reacted=0` : endpoint(slug), { cache: "no-store", signal });
    if (response.status === 404) return "hidden";
    if (!response.ok) return null;
    const value = await response.json() as ReactionPanelState;
    return { mine: value.mine, summary: value.summary, csrfToken: value.csrfToken, signedIn: Boolean(value.signedIn) };
  } catch {
    return null;
  }
}

/**
 * 보낸다. 익명 쓰기는 이 브라우저 쿠키(nmv_visitor)가 있어야 받는다 — 쿠키는 GET 이 준다. 쿠키가 지워졌으면(400 visitor_required)
 * GET 으로 한 번 받아 오고 한 번만 다시 보낸다. refreshCsrf 면, 판을 연 뒤에 로그인해 CSRF 값이 맞지 않을 때(403 invalid_csrf)
 * GET 으로 지금 세션의 값을 받아 한 번만 다시 보낸다 — 마이페이지는 그 화면의 계정으로만 쓰므로 다시 받지 않는다.
 */
async function send(slug: string, csrfToken: string | null, refreshCsrf: boolean, request: (csrfToken: string | null) => Promise<Response>):
  Promise<{ response: Response; csrfToken: string | null }> {
  let token = csrfToken;
  let response = await request(token);
  if (response.status === 400 && await errorOf(response) === "visitor_required") {
    const issued = await fetch(`${endpoint(slug)}?reacted=0`, { cache: "no-store" });
    if (issued.ok) response = await request(token);
  }
  if (refreshCsrf && response.status === 403 && await errorOf(response) === "invalid_csrf") {
    const fresh = await readReactionPanel(slug, false);
    if (fresh && fresh !== "hidden" && fresh.csrfToken && fresh.csrfToken !== token) {
      token = fresh.csrfToken;
      response = await request(token);
    }
  }
  return { response, csrfToken: token };
}

export async function putReactionRequest(slug: string, body: ReactionBody, csrfToken: string | null, options: { refreshCsrf?: boolean } = {}):
  Promise<({ ok: true; mine: ReactionMine; summary: ReactionSummary | null } & Written) | ReactionFailure> {
  try {
    const sent = await send(slug, csrfToken, Boolean(options.refreshCsrf), (token) => fetch(endpoint(slug), {
      method: "PUT", cache: "no-store", headers: headersFor(token), body: JSON.stringify(body),
    }));
    if (!sent.response.ok) return failure(sent.response);
    const value = await sent.response.json() as { mine: ReactionMine; summary: ReactionSummary | null; signedIn?: boolean };
    return { ok: true, mine: value.mine, summary: value.summary, csrfToken: sent.csrfToken, signedIn: Boolean(value.signedIn) };
  } catch {
    return failure();
  }
}

/** keepalive — 마이페이지에서 되돌리기를 기다리다 페이지를 떠나도 지우기는 간다 */
export async function deleteReactionRequest(slug: string, csrfToken: string | null, options: { keepalive?: boolean; refreshCsrf?: boolean } = {}):
  Promise<({ ok: true; summary: ReactionSummary | null } & Written) | ReactionFailure> {
  try {
    const sent = await send(slug, csrfToken, Boolean(options.refreshCsrf), (token) => fetch(endpoint(slug), {
      method: "DELETE", cache: "no-store", keepalive: Boolean(options.keepalive), headers: headersFor(token),
    }));
    if (!sent.response.ok) return failure(sent.response);
    const value = await sent.response.json() as { summary: ReactionSummary | null; signedIn?: boolean };
    return { ok: true, summary: value.summary, csrfToken: sent.csrfToken, signedIn: Boolean(value.signedIn) };
  } catch {
    return failure();
  }
}
