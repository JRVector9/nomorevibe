import type { ReviewInput, ReviewOutcome } from "./agent-review-contract";
import { gatewayModel, reviewWithGateway, REVIEW_GATEWAY_TIMEOUT_MS } from "./agent-review-gateway";

/**
 * gpu3090 의 Qwen 을 게이트웨이(abcllm)를 거치지 않고 바로 부르는 심사(2026-10-21) — 감사 거절의 두 번째 의견과 공개분 2차의 사람 확인
 * 거르기가 같이 쓴다. 감사 #4 의 0.95 이상·주인 없는 거절 50건을 사람 판단과 견주니 이 모델·이 글(v2)이 46건(92%)을 맞혔다
 * (grok 일괄 대조 compare-run.mts 의 qwen-direct-v2 와 같은 요청).
 *
 * 요청은 게이트웨이 심사와 한 길이다(reviewWithGateway — 같은 정책 글·같은 증거 감싸기·같은 json_schema·같은 검증). 다른 것은 셋:
 *  - 부르는 곳: AUDIT_SECOND_OPINION_URL(기본 http://100.77.43.63:8090/v1). 운영 컨테이너는 MagicDNS 를 풀지 못해 Tailscale IP 로 적는다
 *    (M3 DeepSeek 과 같다 — deepseek-review-policy.ts). 다른 곳으로 넘어가지 않는다.
 *  - 키: vLLM 에 키가 없다. AUDIT_SECOND_OPINION_API_KEY 가 있을 때만 Bearer 를 보낸다.
 *  - 정책 글 뒤의 한 줄(GATEWAY_SYSTEM_SUFFIX)을 v2 덧붙임(QWEN_V2_ADDENDUM)으로 바꿔 끼운다. 정책 글(2026-10-06.2)은 한 바이트도 그대로다.
 * 덧붙임은 표본을 보기 전에 쓴 글이라 고치면 측정이 무너진다 — 바꾸려면 새 판(QWEN_V2_PROMPT_VERSION)으로 다시 재고 올린다.
 */
export const QWEN_DIRECT_DEFAULT_URL = "http://100.77.43.63:8090/v1";
export const QWEN_DIRECT_DEFAULT_MODEL = "qwen3.8-flash-next";
/** 덧붙임의 판 — 의견 행에 함께 적어, 판이 바뀌면 다시 묻는다 */
export const QWEN_V2_PROMPT_VERSION = "2026-10-21.v2";
/** 자동 의견의 출처(product_audit_second_opinions.source) — grok 일괄(grok-cli-batch)과 가른다 */
export const QWEN_V2_AUTO_SOURCE = "qwen-v2-auto";

/**
 * v2 덧붙임 — compare/prompt-v2.txt 의 덧붙임 그대로(줄 바꿈으로 시작, 2,734바이트). sha256 은 QWEN_V2_ADDENDUM_SHA256 이고 시험이 지킨다.
 * 정책을 바꾸지 않고, 모델이 가장 자주 틀린 경우에 정책을 어떻게 적용하는지 다시 적었다(문서 도구로 만든 프로젝트 홈·SaaS 첫 화면·
 * 카탈로그·빈 화면·사내 도구·페이지 먼저·확신).
 */
export const QWEN_V2_ADDENDUM = `
SECOND-OPINION NOTES (they apply the policy above and do not change it). Give an independent judgment of product.url under that policy. These notes restate how the policy applies to the cases reviewers most often get wrong:
1. Project homes built with documentation tools. A page generated with MkDocs, Docusaurus, VitePress, Sphinx, pkgdown or mdBook, or hosted on GitHub Pages, is still the project's home when it introduces the maker's own library, tool or app: what it is, why or when to use it, and how to install, start or call it. Approve it. Reject only when the page itself is reference or manual text (an API reference page, one chapter of a guide, a changelog) rather than an introduction.
2. SaaS and product landing pages. When the page describes a real software product and its main action is to sign up, start a trial, see pricing, request a demo of the product, download it or open the app, approve it even if nothing is usable without logging in. Marketing copy is not by itself a reason to reject when the product is described and reachable from the page. This differs from a business that sells services performed by people (agency, consultancy, clinic, travel or event business) or a shop selling goods, which the policy rejects.
3. Catalogs and directories. Approve a catalog or directory only when it is the maker's own product and searching, filtering, sorting, ranking or curated browsing by category is its function; a plain list of links is not. Reject a page about one item on someone else's platform, even when that item is real software: a store listing (Chrome Web Store, App Store, Google Play), a host application's community catalog (such as the Obsidian community catalog), a package registry page (npm, NuGet, PyPI and similar) or a marketplace listing.
4. Empty or near-empty pages. Reject when pageText is empty, only the name or title, only CSS or JavaScript source, a loading or "enable JavaScript" shell, an error page, or a placeholder, coming-soon or waitlist page, whatever the README or description says.
5. Internal-only tools. Reject when the page is a private board, admin console or sign-in screen for one organisation's own staff, with no public description of what the product offers and no way for the public to sign up.
6. Page first. Decide from what pageText shows. Use the README and description only to understand what the software is; they must not override what the page shows.
7. Confidence. Report calibrated confidence: your real probability that the decision is correct under the policy. Use needs_review only when the page evidence genuinely conflicts or cannot be classified, not to avoid deciding.
Return one JSON object with decision, reason, evidenceIds, confidence.`;
export const QWEN_V2_ADDENDUM_SHA256 = "a0228a0227c7c7e3a611dda2d60037ee2ddc4250e7017bb3da6541687f9074ac";

export type QwenDirectConfig = { baseUrl: string; model: string; apiKey: string | null };

/**
 * 부를 곳 — 환경변수가 없으면 기본값. 부를 때마다 읽는다(시험·배포가 바꿀 수 있게). 주소는 http(s) 만, 계정 정보가 든 주소는 받지 않는다.
 * 고칠 수 없는 값이면 null — 부르는 쪽은 qwen_not_configured 로 받는다
 */
export function qwenDirectConfig(env: Readonly<Record<string, string | undefined>> = process.env): QwenDirectConfig | null {
  const raw = env.AUDIT_SECOND_OPINION_URL?.trim() || QWEN_DIRECT_DEFAULT_URL;
  const model = gatewayModel(env.AUDIT_SECOND_OPINION_MODEL?.trim() || QWEN_DIRECT_DEFAULT_MODEL);
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!model || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
  return { baseUrl: raw.replace(/\/+$/, ""), model, apiKey: env.AUDIT_SECOND_OPINION_API_KEY?.trim() || null };
}

/**
 * 실패의 고정 코드 — 모델·원본 글은 싣지 않는다.
 *  qwen_timeout: 제한 시간 · qwen_cancelled: 부른 쪽이 멈춤 · qwen_unreachable: 닿지 않음(연결 거절·DNS·끊김)
 *  qwen_http_<status>: 2xx 가 아닌 답 · qwen_invalid_json: 봉투·JSON·스키마·근거 검증 실패(잘린 답 포함, detail 에 까닭)
 *  qwen_input_too_large: 입력이 상한을 넘음 · qwen_not_configured: 주소·모델이 잘못됨
 */
export type QwenDirectErrorCode = "qwen_timeout" | "qwen_cancelled" | "qwen_unreachable" | `qwen_http_${number}` | "qwen_invalid_json"
  | "qwen_input_too_large" | "qwen_not_configured";

export class QwenDirectError extends Error {
  readonly code: QwenDirectErrorCode;
  readonly detail: string | null;
  readonly status: number | null;
  constructor(code: QwenDirectErrorCode, options: { detail?: string | null; status?: number | null } = {}) {
    super(code);
    this.name = "QwenDirectError";
    this.code = code;
    this.detail = options.detail ?? null;
    this.status = options.status ?? null;
  }
}

/**
 * 부르는 곳이 탈 난 실패인가 — 이 틱의 나머지 호출을 멈추고 물러난다. 아니면(형식 오류·입력 초과·400 대의 요청 거절)
 * 그 항목만의 실패라 다음 항목으로 넘어간다. 404(모델 없음)·401/403(키)·429(붐빔)·5xx 는 부르는 곳의 탈이다
 */
export function qwenEndpointFailure(code: QwenDirectErrorCode): boolean {
  if (code === "qwen_invalid_json" || code === "qwen_input_too_large" || code === "qwen_cancelled") return false;
  const status = /^qwen_http_(\d+)$/.exec(code);
  return !status || ![400, 413, 422].includes(Number(status[1]));
}

export type QwenDirectReview = { outcome: ReviewOutcome; model: string; promptVersion: string; latencyMs: number };

/**
 * 한 입력을 v2 글로 묻는다 — 성공이면 검증한 판단(validateReviewOutcome)을, 아니면 QwenDirectError 를 던진다.
 * 제한 시간 기본 60초(게이트웨이 심사와 같다 — 실측 2.2~4.7초). 바깥 신호가 오면 끊고 qwen_cancelled.
 * DB 트랜잭션 안에서 부르지 않는다.
 */
export async function reviewWithQwenDirect(input: ReviewInput, opts: {
  timeoutMs?: number; signal?: AbortSignal;
  /** 시험의 가짜 서버 */
  request?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
} = {}): Promise<QwenDirectReview> {
  const config = qwenDirectConfig(opts.env);
  if (!config) throw new QwenDirectError("qwen_not_configured");
  // 답의 HTTP 상태 — reviewWithGateway 는 상태를 갈래(auth·rate_limited…)로만 돌려준다
  const seen: { status: number | null } = { status: null };
  const request = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await (opts.request ?? fetch)(url, { ...init, redirect: "error" });
    seen.status = response.status;
    return response;
  }) as typeof fetch;
  const startedAt = Date.now();
  const result = await reviewWithGateway(input, { model: config.model, timeoutMs: opts.timeoutMs ?? REVIEW_GATEWAY_TIMEOUT_MS,
    signal: opts.signal, request, endpoint: { baseUrl: config.baseUrl, apiKey: config.apiKey }, systemSuffix: QWEN_V2_ADDENDUM });
  const latencyMs = Date.now() - startedAt;
  if (result.ok) return { outcome: result.outcome, model: config.model, promptVersion: QWEN_V2_PROMPT_VERSION, latencyMs };
  const httpStatus = seen.status;
  if (httpStatus !== null && (httpStatus < 200 || httpStatus > 299)) throw new QwenDirectError(`qwen_http_${httpStatus}`, { status: httpStatus });
  switch (result.error) {
    case "timeout": throw new QwenDirectError("qwen_timeout");
    case "cancelled": throw new QwenDirectError("qwen_cancelled");
    case "input_too_large": throw new QwenDirectError("qwen_input_too_large");
    case "not_configured": throw new QwenDirectError("qwen_not_configured");
    case "invalid_output": case "output_too_large":
      throw new QwenDirectError("qwen_invalid_json", { detail: result.detail ?? result.error, status: httpStatus });
    // 연결 거절·끊김(답을 받기 전이거나 본문을 읽다가)
    default: throw new QwenDirectError("qwen_unreachable", { detail: result.error, status: httpStatus });
  }
}
