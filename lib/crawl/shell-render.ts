import { createHash } from "node:crypto";
import { z } from "zod";
import { TEXT_SAMPLE_LIMIT } from "@/lib/net/normalize";
import { stubNormalize, stubTextHits, stubWords } from "./rules";

/**
 * JS 로 그리는 앱의 껍데기 본문을 실제 브라우저로 다시 읽는다(2026-11-17, 사람 요청 "프로덕트가 맞으면 최대한 살려야").
 *
 * 수집기(정적 HTML)는 클라이언트에서 그리는 앱의 본문을 제목·로딩 문구로만 읽는다. 1차·2차가 같은 정책 글의 빈 화면 규칙("본문이 비었거나
 * 제목뿐이면 README 가 뭐라 해도 거절")을 두고 갈려, 2차 갈림 보류 3,684건 중 약 670건이 이 꼴이었다. 표본 33건을 실제 Chromium 으로 그리니
 * 대부분이 동작하는 앱이었다(docs/tasks/2026-11-17-js-shell-render-review.md).
 *
 * 그래서 본문이 껍데기(pageTextShell)인 원본만, 1차 심사 직전에 화면 서버(m1-studio, lib/screen-review)로 한 번 그려 그린 뒤 글을 원본 옆
 * (page_meta.renderedPage)에 둔다. 그린 글이 뜻있으면(renderedTextMeaningful) 심사 입력의 pageText 를 그 글로 바꾸고 출처(product.renderedPage)를
 * 함께 싣는다 — 1차·2차·판가름·감사가 같은 입력을 보므로 둘이 일관된다. 정책 글은 바꾸지 않는다: 빈 화면 규칙은 "방문자가 보는 글"에 그대로
 * 걸리고, 그린 글이 곧 방문자가 보는 글이다. 그리지 못했거나(실패·시간 초과·화면 서버 없음) 그린 글도 껍데기면 지금처럼 수집 본문으로 심사한다.
 *
 * 렌더 기록은 그 껍데기(주소 + 수집 본문)의 지문(shell)에 묶인다 — 다시 수집해 본문이 그대로면 옮겨 오고(repository.ts saveFetchedDocument),
 * 본문이 바뀌면 버린다(다시 그린다).
 *
 * 2026-11-21 보완(PR #983 점검 983-B·C·E):
 *  - 기록에 남는 실패는 그 페이지 탓(화면 서버가 페이지 실패로 답한 것)뿐이다. 붐빔·화면 서버 탈·틱 끝에 줄인 시간 초과는 기록하지 않고
 *    1차가 기다린다(shell-render-document.ts — 기다림 상한이 따로 있다).
 *  - 한 바퀴(round)는 첫 실패(since)에서 시작해 페이지 실패 SHELL_RENDER_ATTEMPTS 번이면 끝난다(unavailable — 수집 본문으로 심사).
 *    끝난 바퀴는 since 에서 SHELL_RENDER_COOLDOWN_MS 가 지나면 새 바퀴로 다시 그린다(due) — 영영 잃지 않되, 후보가 1차·재심사 도구로 다시
 *    올 때만 그리고 하루 한 바퀴를 넘지 않는다.
 *  - 그린 글(성공)은 SHELL_RENDER_MAX_AGE_MS 가 지나면 1차가 쓰기 전에 다시 그린다(due). 심사 입력은 나이를 보지 않는다 — 그 지문의 마지막
 *    성공 기록을 그대로 쓴다(공개분 감사·재판정의 입력이 시계로 흔들리지 않게. 공개분의 얇은 글은 감사 화면 판별이 새로 그려 본다).
 *    입력에는 그린 시각을 싣지 않는다 — 다시 그려 글이 같으면 입력 해시도 같다.
 *  - JS 가 다른 사이트로 넘긴 화면(finalUrl 의 호스트가 제품 주소의 호스트·그 하위 도메인이 아님)의 글은 제품의 글로 쓰지 않는다(rendered_offsite).
 */
export const SHELL_RENDER_VERSION = "2026-11-21.1";
/** page_meta 안의 칸 이름 */
export const RENDERED_PAGE_KEY = "renderedPage";
/** 껍데기로 볼 본문 길이 상한(코드 포인트) — rules.ts 의 제목만 규칙(300자)과 같다 */
export const SHELL_TEXT_MAX_CHARS = 300;
/** "제목 + 로딩 문구" 꼴에서 제목·호스트·저장소 이름에 없는 낱말 상한 */
export const SHELL_TITLE_LOADING_MAX_NOVEL = 8;
/** 제목 밖 낱말이 이만큼 이하면(300자 안) 로딩 문구가 없어도 거의 빈 화면으로 본다 — 표본: "Adimat POS"·"Agroteca 🌿 ES EN" */
export const SHELL_SPARSE_MAX_NOVEL = 4;
/** 그린 글이 뜻있다고 볼 새 낱말(제목·호스트·저장소 이름에 없는 것) 하한 */
export const RENDER_MIN_NOVEL_WORDS = 5;
/** 한 바퀴에서 페이지 실패를 몇 번까지 기다리는가 — 넘으면 수집 본문으로 심사한다(지금 동작) */
export const SHELL_RENDER_ATTEMPTS = 2;
/** 페이지 실패 뒤 다시 그릴 때까지 */
export const SHELL_RENDER_RETRY_MS = 10 * 60_000;
/** 끝난 바퀴(unavailable)를 다시 그려 볼 때까지 — 바퀴의 첫 실패(since)부터 */
export const SHELL_RENDER_COOLDOWN_MS = 24 * 3600_000;
/** 그린 글의 나이 상한 — 지나면 1차가 쓰기 전에 다시 그린다 */
export const SHELL_RENDER_MAX_AGE_MS = 7 * 24 * 3600_000;

/** 모델 입력에 싣는 출처 설명 — 정책이 아니라 증거의 출처다(정책 글은 그대로) */
export const RENDERED_PAGE_NOTE = "pageText was read in a real browser after the page's JavaScript ran, because the raw HTML text "
  + "(crawlerPageText) showed only the title or a loading message. It is what a visitor sees on product.url. Judge it as the page's "
  + "visible text under the unchanged policy: the empty-page rule applies to this rendered text, not to the raw HTML.";

export type ShellKind = "empty" | "loading_only" | "javascript_shell" | "title_only" | "title_and_loading" | "sparse_text";
export type ShellInput = { repo: string; productUrl: string | null; title?: string | null; textSample?: string | null };

// 로딩 문구 — 여러 말. 끝의 말줄임표도 로딩 표시로 본다(새 낱말이 적을 때만 쓰므로 소개문 끝의 말줄임표를 집지 않는다)
const LOADING_PHRASE = new RegExp([
  "loading", "please wait", "initializing", "initialising", "starting up", "getting .{1,30} ready",
  "불러오는 ?중", "불러오고 있", "로딩", "준비하고 있", "준비 ?중", "잠시만", "펼치는 ?중",
  "読み込み", "読込中", "加载", "載入", "cargando", "chargement", "carregando", "wird geladen", "caricamento", "načítav",
].join("|"), "u");
const TRAILING_ELLIPSIS = /(?:\.\.\.|…)\s*$/u;

function knownWords(input: ShellInput): Set<string> {
  let host = "";
  try { host = input.productUrl ? new URL(input.productUrl).hostname : ""; } catch { /* 주소가 아니면 호스트 낱말 없음 */ }
  return new Set(stubWords(stubNormalize([input.title ?? "", host.replace(/\./g, " "), input.repo.split("/").at(-1) ?? ""].join(" "))));
}

/** 제목·호스트·저장소 이름에 없는 낱말 수(같은 낱말은 한 번) */
export function novelWordCount(text: string, input: ShellInput): number {
  const known = knownWords(input);
  return new Set(stubWords(stubNormalize(text)).filter(word => !known.has(word))).size;
}

/**
 * 수집 본문이 JS 앱 껍데기인가 — 브라우저로 다시 그려 볼 대상. 비었거나, 빈 화면 규칙(rules.ts stubTextHits)의 로딩만·JavaScript 안내·제목만에
 * 걸리거나, 300자 안에서 제목 + 로딩 문구뿐(새 낱말 8개 이하)이거나 제목 밖 낱말이 4개 이하면 그 꼴을 돌려준다. 로그인·출시 예정 문구는
 * 따로 보지 않는다 — 그린 글이 같은 화면이면 뜻있는 글로 치지 않아(renderedTextMeaningful) 지금처럼 심사된다.
 */
export function pageTextShell(input: ShellInput): ShellKind | null {
  const raw = input.textSample?.trim() ?? "";
  if (!raw) return "empty";
  if ([...raw].length > SHELL_TEXT_MAX_CHARS) return null;
  const hits = new Set(stubTextHits(input).map(hit => hit.id));
  for (const kind of ["loading_only", "javascript_shell", "title_only"] as const) if (hits.has(kind)) return kind;
  const text = stubNormalize(raw);
  const novel = novelWordCount(raw, input);
  if ((LOADING_PHRASE.test(text) || TRAILING_ELLIPSIS.test(raw)) && novel <= SHELL_TITLE_LOADING_MAX_NOVEL) return "title_and_loading";
  return novel <= SHELL_SPARSE_MAX_NOVEL ? "sparse_text" : null;
}

/**
 * 그린 글이 뜻있는가 — 그린 글도 껍데기(빈 화면 규칙 다섯 가지 포함)가 아니고, 제목·호스트·저장소 이름에 없는 낱말이 5개 이상이며 수집 본문보다 많다
 * (그린 화면이 로그인 화면 등으로 넘어가 글이 줄면 수집 본문을 그대로 쓴다)
 */
export function renderedTextMeaningful(input: ShellInput, rendered: string): boolean {
  const text = rendered.trim();
  // 그린 글이 빈 화면 규칙(로그인만·출시 예정 포함, rules.ts stubTextHits)에 걸리면 그려도 같은 껍데기다
  if (!text || pageTextShell({ ...input, textSample: text }) || stubTextHits({ ...input, textSample: text }).length) return false;
  const novel = novelWordCount(text, input);
  return novel >= RENDER_MIN_NOVEL_WORDS && novel > novelWordCount(input.textSample ?? "", input);
}

/** 껍데기의 지문 — 주소와 수집 본문. 렌더 기록은 이것에 묶인다 */
export function shellFingerprint(productUrl: string | null, textSample: string | null | undefined): string {
  return createHash("sha256").update(`${productUrl ?? ""}\n${textSample ?? ""}`).digest("hex").slice(0, 32);
}

const renderedOkSchema = z.object({
  version: z.string().max(40), shell: z.string().length(32), at: z.string().max(40), ok: z.literal(true),
  text: z.string().max(TEXT_SAMPLE_LIMIT), textLength: z.number().int().nonnegative(), finalUrl: z.string().max(2048).nullable(),
  status: z.number().int().nullable(),
}).strict();
/** 페이지 탓 실패만 적는다 — attempts 는 이 바퀴의 페이지 실패 수, since 는 이 바퀴의 첫 실패 시각(ms) */
const renderedFailSchema = z.object({
  version: z.string().max(40), shell: z.string().length(32), at: z.string().max(40), ok: z.literal(false),
  code: z.string().max(80), attempts: z.number().int().min(1).max(100), retryAfter: z.number().int().nonnegative(), since: z.number().int().nonnegative(),
}).strict();
export const renderedPageSchema = z.discriminatedUnion("ok", [renderedOkSchema, renderedFailSchema]);
export type RenderedPageMeta = z.infer<typeof renderedPageSchema>;

type DocumentLike = { repo: string; productUrl: string | null; pageMeta: Record<string, unknown> | null | undefined };
const metaText = (meta: Record<string, unknown> | null | undefined, key: string) => typeof meta?.[key] === "string" ? meta[key] as string : null;

export function shellInputOf(document: DocumentLike, textSample = metaText(document.pageMeta, "textSample")): ShellInput {
  return { repo: document.repo, productUrl: document.productUrl, title: metaText(document.pageMeta, "title"), textSample };
}

/** 지금 껍데기에 묶인 렌더 기록 — 다른 껍데기의 것·깨진 것은 없는 것으로 본다 */
export function renderedPageOf(document: DocumentLike): RenderedPageMeta | null {
  const parsed = renderedPageSchema.safeParse(document.pageMeta?.[RENDERED_PAGE_KEY]);
  if (!parsed.success) return null;
  return parsed.data.shell === shellFingerprint(document.productUrl, metaText(document.pageMeta, "textSample")) ? parsed.data : null;
}

const siteHost = (raw: string | null | undefined): string | null => {
  try { return raw ? new URL(raw).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") : null; } catch { return null; }
};
/**
 * 그린 화면이 제품 주소의 사이트에 머물렀는가 — 같은 호스트(www. 무시)이거나 그 하위 도메인(example.com → app.example.com)이면 머문 것이다.
 * 위 도메인(app.example.com → example.com)·다른 사이트(로그인 제공자·마켓·남의 플랫폼)로 넘어간 화면은 머물지 않은 것이다 — 공개 접미사 목록 없이
 * 보수적으로 가른다(머물지 않은 것으로 보면 지금처럼 수집 본문으로 심사할 뿐이다). finalUrl 이 없으면 넘어간 증거가 없어 머문 것으로 본다.
 */
export function renderStayedOnSite(productUrl: string | null, finalUrl: string | null): boolean {
  if (!finalUrl) return true;
  const product = siteHost(productUrl), final = siteHost(finalUrl);
  if (!product || !final) return false;
  return final === product || final.endsWith(`.${product}`);
}

export type ShellRenderState =
  /** 껍데기가 아니거나 그릴 주소가 없다 — 수집 본문 그대로 */
  | { kind: "not_shell" }
  /** 그린 글이 뜻있다 — 심사 입력에 쓴다 */
  | { kind: "rendered"; text: string; finalUrl: string | null; at: string }
  /** 그렸지만 그린 글도 껍데기다 — 수집 본문으로 심사(규칙대로 거절될 것) */
  | { kind: "rendered_empty" }
  /** 그렸지만 JS 가 다른 사이트로 넘겼다 — 그 글은 제품의 글이 아니다. 수집 본문으로 심사 */
  | { kind: "rendered_offsite"; finalUrl: string | null }
  /** 아직 그리지 않았거나 다시 그릴 때가 됐다(stale: 그린 글이 나이 상한을 넘음 · attempts: 이 바퀴의 페이지 실패 수) */
  | { kind: "due"; attempts: number; stale?: true }
  /** 페이지 실패 뒤 다음 시도를 기다린다 */
  | { kind: "waiting"; code: string; attempts: number; retryAfter: number }
  /** 이 바퀴의 페이지 실패를 다 썼다 — 수집 본문으로 심사(지금 동작). retryAt 뒤에 새 바퀴로 다시 그린다 */
  | { kind: "unavailable"; code: string; attempts: number; retryAt: number };

/** 성공 기록의 글이 쓸 만한가 — 시각과 무관하다(입력과 상태가 같은 판정을 쓴다) */
function successKind(input: ShellInput, rendered: Extract<RenderedPageMeta, { ok: true }>): "rendered" | "rendered_empty" | "rendered_offsite" {
  if (!renderedTextMeaningful(input, rendered.text)) return "rendered_empty";
  return renderStayedOnSite(input.productUrl, rendered.finalUrl) ? "rendered" : "rendered_offsite";
}

export function shellRenderState(document: DocumentLike, now = Date.now()): ShellRenderState {
  const input = shellInputOf(document);
  if (!document.productUrl || !pageTextShell(input)) return { kind: "not_shell" };
  const rendered = renderedPageOf(document);
  if (!rendered) return { kind: "due", attempts: 0 };
  if (rendered.ok) {
    // 나이를 못 읽으면(깨진 at) 낡은 것으로 본다
    if (!(now - Date.parse(rendered.at) < SHELL_RENDER_MAX_AGE_MS)) return { kind: "due", attempts: 0, stale: true };
    const kind = successKind(input, rendered);
    return kind === "rendered" ? { kind, text: rendered.text, finalUrl: rendered.finalUrl, at: rendered.at }
      : kind === "rendered_offsite" ? { kind, finalUrl: rendered.finalUrl } : { kind };
  }
  if (rendered.attempts >= SHELL_RENDER_ATTEMPTS) {
    const retryAt = rendered.since + SHELL_RENDER_COOLDOWN_MS;
    return now < retryAt ? { kind: "unavailable", code: rendered.code, attempts: rendered.attempts, retryAt } : { kind: "due", attempts: 0 };
  }
  return rendered.retryAfter > now ? { kind: "waiting", code: rendered.code, attempts: rendered.attempts, retryAfter: rendered.retryAfter }
    : { kind: "due", attempts: rendered.attempts };
}

/** 심사 입력의 product.renderedPage — 그린 글을 pageText 로 쓸 때만 싣는다(없는 후보의 입력 해시는 그대로다). 그린 시각은 싣지 않는다 */
export type ReviewRenderedPage = { source: "browser_render"; note: string; crawlerPageText: string; finalUrl: string | null };

/**
 * 심사 입력에 쓸 그린 글 — 지금 지문의 마지막 기록이 성공이고, 글이 뜻있고, 제품 사이트에 머문 것만. 아니면 null(수집 본문 그대로).
 * 나이는 보지 않는다(머리 설명 — 다시 그리기는 1차 직전의 일이다)
 */
export function reviewRenderedPage(document: DocumentLike): { pageText: string; renderedPage: ReviewRenderedPage } | null {
  const input = shellInputOf(document);
  if (!document.productUrl || !pageTextShell(input)) return null;
  const rendered = renderedPageOf(document);
  if (!rendered?.ok || successKind(input, rendered) !== "rendered") return null;
  return { pageText: rendered.text.slice(0, TEXT_SAMPLE_LIMIT).trim(),
    renderedPage: { source: "browser_render", note: RENDERED_PAGE_NOTE, crawlerPageText: (input.textSample ?? "").trim(), finalUrl: rendered.finalUrl } };
}

/** 렌더 성공 기록 */
export function renderedPageSuccess(document: DocumentLike, result: { text: string; textLength: number; finalUrl: string | null; status: number | null },
  now = Date.now()): RenderedPageMeta {
  return { version: SHELL_RENDER_VERSION, shell: shellFingerprint(document.productUrl, metaText(document.pageMeta, "textSample")),
    at: new Date(now).toISOString(), ok: true, text: result.text.slice(0, TEXT_SAMPLE_LIMIT), textLength: result.textLength,
    finalUrl: result.finalUrl ? result.finalUrl.slice(0, 2048) : null, status: result.status };
}

/**
 * 페이지 탓 렌더 실패 기록 — 이 바퀴가 열려 있으면(앞선 실패가 상한 아래) 횟수에 하나를 더하고 since 를 잇는다. 아니면(첫 실패·앞선 기록이 성공·
 * 끝난 바퀴의 쉼이 지남) 새 바퀴를 연다
 */
export function renderedPageFailure(document: DocumentLike, code: string, now = Date.now()): RenderedPageMeta {
  const prior = renderedPageOf(document);
  const open = prior && !prior.ok && prior.attempts < SHELL_RENDER_ATTEMPTS ? prior : null;
  return { version: SHELL_RENDER_VERSION, shell: shellFingerprint(document.productUrl, metaText(document.pageMeta, "textSample")),
    at: new Date(now).toISOString(), ok: false, code: code.slice(0, 80), attempts: Math.min(100, (open?.attempts ?? 0) + 1),
    retryAfter: now + SHELL_RENDER_RETRY_MS, since: open?.since ?? now };
}
