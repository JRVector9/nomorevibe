import { isJpeg, renderHealthSchema, renderResponseSchema, renderServiceErrorSchema, SCREEN_MAX_SCREENSHOT_BYTES, SCREEN_RENDER_PROTOCOL,
  type RenderHealth } from "./protocol";

/**
 * 워커(reviewer)가 화면 서버를 부른다 — 화면 판별 잡(lib/screen-review/job.ts)이 쓴다.
 *
 * 화면 서버는 m1-studio 의 Tailscale IP 에 있다(운영 컨테이너는 MagicDNS 를 풀지 못한다 — qwen-direct-review.ts 와 같다). 그래서 사설 주소를 막는
 * safeFetch 를 쓰지 않고, 운영자가 적은 그 주소(SCREEN_RENDER_URL)만 부른다. 넘겨주기는 따르지 않는다(redirect:error).
 *
 * 실패는 셋으로 가른다:
 *  - outage: 화면 서버 탈(닿지 않음·시간 초과·401/403·5xx·약속과 다른 답·글꼴 없음) — 잡은 이 틱을 멈추고 물러난다
 *  - busy: 동시 그리기 상한(429) — 이 틱만 멈춘다(세지 않는다)
 *  - page: 그 페이지 탓(막힘·닿지 않음·4xx/5xx·시간 초과…) — 그 항목의 실패로 센다
 */

export type ScreenRenderConfig = { baseUrl: string; token: string };

/** 화면 서버 설정 — SCREEN_RENDER_URL(http(s), 계정·질의 없음)·SCREEN_RENDER_TOKEN(32자 이상). 둘 중 하나라도 없거나 틀리면 null(꺼짐) */
export function screenRenderConfig(env: Readonly<Record<string, string | undefined>> = process.env): ScreenRenderConfig | null {
  const raw = env.SCREEN_RENDER_URL?.trim();
  const token = env.SCREEN_RENDER_TOKEN?.trim() ?? "";
  if (!raw || token.length < 32) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
  return { baseUrl: raw.replace(/\/+$/, ""), token };
}

export type RenderClientResult =
  | { ok: true; finalUrl: string; status: number | null; text: string; textLength: number; jpeg: Buffer; renderMs: number;
    egress: { requests: number; bytes: number; blocked: number } }
  | { ok: false; kind: "outage" | "busy" | "page"; code: string };

/** 답 본문의 상한 — 스크린샷 3MB(base64 4MB)에 글 6천 자 */
const BODY_LIMIT = 6 * 1024 * 1024;

async function readCapped(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 4xx/5xx 의 고정 코드 — 서버가 적은 까닭(fonts_missing 등)이 있으면 그것 */
async function serviceError(response: Response): Promise<string> {
  const body = await readCapped(response, 4_096).catch(() => null);
  try {
    const parsed = renderServiceErrorSchema.safeParse(JSON.parse(body ?? ""));
    if (parsed.success) return `render_${parsed.data.error}`;
  } catch { /* 본문이 JSON 이 아니다 */ }
  return `render_http_${response.status}`;
}

/** 한 페이지를 그려 달라고 한다. 던지지 않는다 */
export async function requestRender(url: string, options: { config: ScreenRenderConfig; timeoutMs: number; signal?: AbortSignal; request?: typeof fetch }):
  Promise<RenderClientResult> {
  const deadline = AbortSignal.timeout(Math.max(1, options.timeoutMs));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await (options.request ?? fetch)(`${options.config.baseUrl}/v1/render`, {
      method: "POST", redirect: "error", signal, body: JSON.stringify({ url }),
      headers: { authorization: `Bearer ${options.config.token}`, "content-type": "application/json" },
    });
  } catch {
    if (options.signal?.aborted) return { ok: false, kind: "busy", code: "render_cancelled" };
    return { ok: false, kind: "outage", code: deadline.aborted ? "render_timeout" : "render_unreachable" };
  }
  if (response.status === 429) { await response.body?.cancel().catch(() => {}); return { ok: false, kind: "busy", code: "render_busy" }; }
  // 400 은 그 주소를 서버가 받지 않은 것(그릴 수 없는 주소) — 그 항목의 실패다
  if (response.status === 400) { await response.body?.cancel().catch(() => {}); return { ok: false, kind: "page", code: "page_unsafe_url" }; }
  if (!response.ok) return { ok: false, kind: "outage", code: await serviceError(response) };
  let body: string | null;
  try { body = await readCapped(response, BODY_LIMIT); } catch {
    return { ok: false, kind: "outage", code: deadline.aborted ? "render_timeout" : "render_unreachable" };
  }
  if (body === null) return { ok: false, kind: "outage", code: "render_invalid" };
  let parsed: ReturnType<typeof renderResponseSchema.safeParse>;
  try { parsed = renderResponseSchema.safeParse(JSON.parse(body)); } catch { return { ok: false, kind: "outage", code: "render_invalid" }; }
  if (!parsed.success || parsed.data.protocol !== SCREEN_RENDER_PROTOCOL) return { ok: false, kind: "outage", code: "render_invalid" };
  const value = parsed.data;
  if (!value.ok) return { ok: false, kind: "page", code: value.error === "http_status" && value.status ? `page_http_${value.status}` : `page_${value.error}` };
  const jpeg = Buffer.from(value.screenshot, "base64");
  if (!isJpeg(jpeg) || jpeg.length > SCREEN_MAX_SCREENSHOT_BYTES) return { ok: false, kind: "outage", code: "render_invalid" };
  return { ok: true, finalUrl: value.finalUrl, status: value.status, text: value.text, textLength: value.textLength, jpeg, renderMs: value.renderMs,
    egress: value.egress };
}

/** 화면 서버 상태 — 판·샌드박스·글꼴. 닿지 않거나 약속과 다르면 null */
export async function requestRenderHealth(options: { config: ScreenRenderConfig; timeoutMs?: number; request?: typeof fetch }): Promise<RenderHealth | null> {
  try {
    const response = await (options.request ?? fetch)(`${options.config.baseUrl}/v1/health`, { redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000), headers: { authorization: `Bearer ${options.config.token}` } });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
    const parsed = renderHealthSchema.safeParse(JSON.parse((await readCapped(response, 16_384)) ?? ""));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
