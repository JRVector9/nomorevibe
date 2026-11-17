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
 */
export const SHELL_RENDER_VERSION = "2026-11-17.1";
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
/** 그리기 실패를 몇 번까지 기다리는가 — 넘으면 수집 본문으로 심사한다(지금 동작) */
export const SHELL_RENDER_ATTEMPTS = 2;
/** 실패 뒤 다시 그릴 때까지 */
export const SHELL_RENDER_RETRY_MS = 10 * 60_000;

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
const renderedFailSchema = z.object({
  version: z.string().max(40), shell: z.string().length(32), at: z.string().max(40), ok: z.literal(false),
  code: z.string().max(80), attempts: z.number().int().min(1).max(100), retryAfter: z.number().int().nonnegative(),
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

export type ShellRenderState =
  /** 껍데기가 아니거나 그릴 주소가 없다 — 수집 본문 그대로 */
  | { kind: "not_shell" }
  /** 그린 글이 뜻있다 — 심사 입력에 쓴다 */
  | { kind: "rendered"; text: string; finalUrl: string | null; at: string }
  /** 그렸지만 그린 글도 껍데기다 — 수집 본문으로 심사(규칙대로 거절될 것) */
  | { kind: "rendered_empty" }
  /** 아직 그리지 않았거나 다시 그릴 때가 됐다 */
  | { kind: "due"; attempts: number }
  /** 그리기에 실패해 다음 시도를 기다린다 */
  | { kind: "waiting"; code: string; attempts: number; retryAfter: number }
  /** 실패 횟수를 다 썼다 — 수집 본문으로 심사(지금 동작) */
  | { kind: "unavailable"; code: string; attempts: number };

export function shellRenderState(document: DocumentLike, now = Date.now()): ShellRenderState {
  const input = shellInputOf(document);
  if (!document.productUrl || !pageTextShell(input)) return { kind: "not_shell" };
  const rendered = renderedPageOf(document);
  if (!rendered) return { kind: "due", attempts: 0 };
  if (rendered.ok) return renderedTextMeaningful(input, rendered.text)
    ? { kind: "rendered", text: rendered.text, finalUrl: rendered.finalUrl, at: rendered.at } : { kind: "rendered_empty" };
  if (rendered.attempts >= SHELL_RENDER_ATTEMPTS) return { kind: "unavailable", code: rendered.code, attempts: rendered.attempts };
  return rendered.retryAfter > now ? { kind: "waiting", code: rendered.code, attempts: rendered.attempts, retryAfter: rendered.retryAfter }
    : { kind: "due", attempts: rendered.attempts };
}

/** 심사 입력의 product.renderedPage — 그린 글을 pageText 로 쓸 때만 싣는다(없는 후보의 입력 해시는 그대로다) */
export type ReviewRenderedPage = { source: "browser_render"; note: string; crawlerPageText: string; finalUrl: string | null; renderedAt: string };

/** 심사 입력에 쓸 그린 글 — 뜻있게 그린 껍데기만. 아니면 null(수집 본문 그대로) */
export function reviewRenderedPage(document: DocumentLike): { pageText: string; renderedPage: ReviewRenderedPage } | null {
  const state = shellRenderState(document, Number.POSITIVE_INFINITY);
  if (state.kind !== "rendered") return null;
  return { pageText: state.text.slice(0, TEXT_SAMPLE_LIMIT).trim(),
    renderedPage: { source: "browser_render", note: RENDERED_PAGE_NOTE, crawlerPageText: (metaText(document.pageMeta, "textSample") ?? "").trim(),
      finalUrl: state.finalUrl, renderedAt: state.at } };
}

/** 렌더 성공 기록 */
export function renderedPageSuccess(document: DocumentLike, result: { text: string; textLength: number; finalUrl: string | null; status: number | null },
  now = Date.now()): RenderedPageMeta {
  return { version: SHELL_RENDER_VERSION, shell: shellFingerprint(document.productUrl, metaText(document.pageMeta, "textSample")),
    at: new Date(now).toISOString(), ok: true, text: result.text.slice(0, TEXT_SAMPLE_LIMIT), textLength: result.textLength,
    finalUrl: result.finalUrl ? result.finalUrl.slice(0, 2048) : null, status: result.status };
}

/** 렌더 실패 기록 — 앞선 실패 횟수에 하나를 더한다 */
export function renderedPageFailure(document: DocumentLike, code: string, now = Date.now()): RenderedPageMeta {
  const prior = renderedPageOf(document);
  const attempts = Math.min(100, (prior && !prior.ok ? prior.attempts : 0) + 1);
  return { version: SHELL_RENDER_VERSION, shell: shellFingerprint(document.productUrl, metaText(document.pageMeta, "textSample")),
    at: new Date(now).toISOString(), ok: false, code: code.slice(0, 80), attempts, retryAfter: now + SHELL_RENDER_RETRY_MS };
}
