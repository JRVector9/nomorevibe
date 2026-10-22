import { after } from "next/server";
import { logger } from "@/lib/observability/logger";
import { isBotAgent } from "@/lib/domain/products/clicks";
import { parseMeasurementId } from "./config";
import { CONSENT_DENIED_REGIONS } from "./consent";
import { ANALYTICS_EVENT_CATALOG, isAnalyticsEventName, type AnalyticsEventName, type AnalyticsEventParams } from "./events";
import { analyticsUserId, GA_COOKIE, gaSessionCookieName, parseGaClientId, parseGaSessionId, randomClientId, requestCookies } from "./identity";
import { sanitizeParams } from "./sanitize";

/**
 * 서버가 GA4 로 보내는 "사실" 이벤트 — Measurement Protocol(2026-10-22, PR C).
 * 운영 절차·이벤트 표: docs/operations/2026-10-22-google-analytics.md
 *
 * - 브라우저 track() 은 "눌렀다"(의도), 이것은 "실제로 됐다"(사실)다. 이름은 lib/analytics/events.ts 에서 source 가 server·both 인 것만.
 * - GA_MEASUREMENT_ID 와 GA_API_SECRET 이 둘 다 있어야 보낸다. 하나라도 없으면 아무것도 하지 않는다.
 * - 응답을 보낸 뒤(after) 1.5초 상한으로 보낸다. 어떤 실패도 던지지 않는다 — 응답 상태·시간·리다이렉트는 그대로다.
 * - 동의(lib/analytics/consent.ts 와 같은 모델): GPC·DNT·유럽 경제 지역(Cloudflare 의 나라 머리글)은 보내지 않는다.
 *   브라우저가 부른 주소는 `_ga` 쿠키가 있을 때만 보낸다 — 분석을 끄면 그 쿠키를 지우고, 동의 전에는 쿠키가 없다. 쿠키 없는 신호도 보내지 않는다.
 * - IP·User-Agent 원문·쿠키 원문·이메일·토큰·주소의 질의는 싣지 않는다. 매개변수는 목록에 있는 이름과 값만, PR A 의 sanitizeParams 를 거친다.
 * - DR 쓰기 관문: GA 는 우리 DB 가 아니라 관문을 거치지 않는다. 사실 이벤트는 쓰기가 성공한 뒤에만 부르므로 fenced 웹에서는
 *   쓰기 이벤트가 나가지 않는다. /go·설치 스크립트·배지는 응답 자체가 사실이라 fence 와 상관없이 보낸다.
 */

export const MP_COLLECT_URL = "https://www.google-analytics.com/mp/collect";
/** 형식 검사용(운영자가 손으로 부른다 — 기록되지 않는다). 문서의 확인 절차가 쓴다 */
export const MP_DEBUG_COLLECT_URL = "https://www.google-analytics.com/debug/mp/collect";
export const MP_TIMEOUT_MS = 1_500;
/** 운영자 브라우저 표시 — 값 "1" 이면 traffic_type=internal(GA 데이터 필터가 뺀다). IP 를 쓰지 않는 내부 트래픽 구분 */
export const INTERNAL_TRAFFIC_COOKIE = "nmv_internal";

/**
 * 누구의 이벤트로 보낼까.
 * - browser: 브라우저만 부르는 주소(/go·로그인 콜백·써봤어요·요청·소유 확인 화면). `_ga` 가 없으면 보내지 않는다.
 * - auto: CLI 도 부르는 주소(스킬 API·설치 스크립트). `_ga` 가 있으면 잇고, 브라우저인데 없으면 보내지 않고,
 *   그 밖(curl·wget·에이전트)이면 요청마다 새 client_id — GA 에서 서로 다른 '사용자'로 잡힌다.
 * - aggregate: 사람을 잇지 않는 합계(배지). 이벤트마다 고정 client_id 하나, user_id·session 없음.
 */
export type ServerIdentity = "browser" | "auto" | "aggregate";

export type ServerEventContext = {
  request: Request;
  identity: ServerIdentity;
  /** 로그인한 사람의 내부 id — 가명 user_id 로만 바꿔 싣는다 */
  userId?: number | null;
};

export type IdSource = "ga_cookie" | "random" | "aggregate";
export type SkipReason = "disabled" | "unknown_event" | "client_event" | "invalid_params" | "gpc" | "dnt" | "region" | "no_consent" | "bot";

type ParamValue = string | number;
export type MeasurementPayload = {
  client_id: string;
  user_id?: string;
  timestamp_micros: number;
  non_personalized_ads: true;
  consent: { ad_user_data: "DENIED"; ad_personalization: "DENIED" };
  events: [{ name: AnalyticsEventName; params: Record<string, ParamValue> }];
};

export type BuiltServerEvent =
  | { ok: true; url: string; payload: MeasurementPayload; idSource: IdSource }
  | { ok: false; reason: SkipReason };

type Env = Readonly<Record<string, string | undefined>>;
export type ServerAnalyticsConfig = { measurementId: string; apiSecret: string; debug: boolean };

/** API 비밀 — 공백 없는 보이는 글자 8~128자. 꼴이 틀리면 끈다(잘못된 값으로 GA 를 두드리지 않는다) */
const API_SECRET = /^[\x21-\x7e]{8,128}$/;

export function serverAnalyticsConfig(env: Env = process.env): ServerAnalyticsConfig | null {
  const measurementId = parseMeasurementId(env.GA_MEASUREMENT_ID);
  const apiSecret = env.GA_API_SECRET?.trim();
  if (!measurementId || !apiSecret || !API_SECRET.test(apiSecret)) return null;
  return { measurementId, apiSecret, debug: env.GA_DEBUG?.trim() === "1" };
}

/** 받아 간 쪽의 갈래 — User-Agent 원문은 보내지 않는다. 크롤러·미리보기는 bot(보내지 않는다) */
export function agentClass(userAgent: string | null | undefined): "curl" | "wget" | "browser" | "other" | "bot" {
  const value = userAgent?.trim() ?? "";
  if (/^curl\//i.test(value)) return "curl";
  if (/^wget\//i.test(value)) return "wget";
  if (isBotAgent(value)) return "bot";
  if (/^Mozilla\//.test(value)) return "browser";
  return "other";
}

/** 동의 신호 — 브라우저 쪽(consent.ts)과 같은 순서. 지역은 Cloudflare 가 붙이는 나라 머리글로만 안다 */
function consentBlock(request: Request): SkipReason | null {
  const headers = request.headers;
  if (headers.get("sec-gpc")?.trim() === "1") return "gpc";
  if (headers.get("dnt")?.trim() === "1") return "dnt";
  const country = headers.get("cf-ipcountry")?.trim().toUpperCase();
  if (country && CONSENT_DENIED_REGIONS.includes(country)) return "region";
  return null;
}

/** 목록의 매개변수 꼴과 맞는가 — 모르는 이름·틀린 꼴·허용 밖 값이 하나라도 있으면 통째로 보내지 않는다(만든 쪽의 실수다) */
function matchesCatalog(name: AnalyticsEventName, params: Record<string, unknown>): boolean {
  const spec = ANALYTICS_EVENT_CATALOG[name].params as Record<string, { kind: string; optional?: true; values?: readonly string[] }>;
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(spec, key) && params[key] !== undefined) return false;
  }
  for (const [key, rule] of Object.entries(spec)) {
    const value = params[key];
    if (value === undefined) {
      if (!rule.optional) return false;
      continue;
    }
    if (typeof value !== rule.kind) return false;
    if (rule.values && !rule.values.includes(value as string)) return false;
  }
  return true;
}

/**
 * 보낼 꼴을 만든다 — 순수 함수(시험이 본다). 보내지 않을 까닭이 있으면 그 까닭을 돌려준다.
 */
export function buildServerEvent<Name extends AnalyticsEventName>(
  name: Name,
  params: AnalyticsEventParams[Name],
  context: ServerEventContext,
  options: { env?: Env; now?: number } = {},
): BuiltServerEvent {
  const env = options.env ?? process.env;
  const config = serverAnalyticsConfig(env);
  if (!config) return { ok: false, reason: "disabled" };
  if (!isAnalyticsEventName(name)) return { ok: false, reason: "unknown_event" };
  if (ANALYTICS_EVENT_CATALOG[name].source === "client") return { ok: false, reason: "client_event" };
  const raw = params as Record<string, unknown>;
  if (!matchesCatalog(name, raw)) return { ok: false, reason: "invalid_params" };

  const { request, identity } = context;
  const blocked = consentBlock(request);
  if (blocked) return { ok: false, reason: blocked };

  const now = options.now ?? Date.now();
  const cookies = requestCookies(request);
  let clientId: string;
  let idSource: IdSource;
  let sessionId: string | null = null;
  if (identity === "aggregate") {
    // 합계에도 크롤러는 넣지 않는다(GitHub 이미지 프록시 github-camo 는 README 를 본 사람 대신 오는 것이라 센다)
    if (isBotAgent(request.headers.get("user-agent"))) return { ok: false, reason: "bot" };
    clientId = `aggregate.${name}`;
    idSource = "aggregate";
  } else {
    const fromCookie = parseGaClientId(cookies.get(GA_COOKIE));
    if (fromCookie) {
      clientId = fromCookie;
      idSource = "ga_cookie";
      sessionId = parseGaSessionId(cookies.get(gaSessionCookieName(config.measurementId)));
    } else if (identity === "browser") {
      return { ok: false, reason: "no_consent" };
    } else {
      const agent = agentClass(request.headers.get("user-agent"));
      // 브라우저인데 `_ga` 가 없다 — 분석을 껐거나 동의 전이다. 쿠키 없는 신호도 보내지 않는다
      if (agent === "browser") return { ok: false, reason: "no_consent" };
      if (agent === "bot") return { ok: false, reason: "bot" };
      clientId = randomClientId(now);
      idSource = "random";
    }
  }

  const clean = sanitizeParams(raw);
  const eventParams: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(clean)) {
    if (typeof value === "string" || typeof value === "number") eventParams[key] = value;
  }
  // 목록 밖의 운반 값 — 어느 쪽 id 인지, 그 세션, 운영자 표시, DebugView
  eventParams.id_source = idSource;
  if (sessionId) {
    // 그 세션의 이벤트로 보이게 하는 값 — 참여 시간은 사실상 늘지 않는다(1ms)
    eventParams.session_id = sessionId;
    eventParams.engagement_time_msec = 1;
  }
  if (identity !== "aggregate" && cookies.get(INTERNAL_TRAFFIC_COOKIE) === "1") eventParams.traffic_type = "internal";
  if (config.debug) eventParams.debug_mode = 1;

  const userId = identity === "aggregate" ? null : analyticsUserId(context.userId, env.ANALYTICS_USER_ID_SECRET);
  const payload: MeasurementPayload = {
    client_id: clientId,
    ...(userId ? { user_id: userId } : {}),
    timestamp_micros: now * 1_000,
    non_personalized_ads: true,
    consent: { ad_user_data: "DENIED", ad_personalization: "DENIED" },
    events: [{ name, params: eventParams }],
  };
  const url = `${MP_COLLECT_URL}?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(config.apiSecret)}`;
  return { ok: true, url, payload, idSource };
}

/** 보낸다 — 1.5초 상한, 실패는 로그 한 줄. 주소에 API 비밀이 있으므로 주소는 로그에 남기지 않는다 */
async function sendMeasurement(name: AnalyticsEventName, url: string, payload: MeasurementPayload): Promise<void> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(MP_TIMEOUT_MS),
      cache: "no-store",
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) logger.warn("analytics.mp_rejected", { event: name, status: response.status });
  } catch (error) {
    logger.debug("analytics.mp_failed", { event: name, reason: error instanceof Error ? error.name : "unknown" });
  }
}

/** 응답 뒤에 — 요청 밖(시험·스크립트)에서는 after 가 던지므로 그 자리에서 띄워 보낸다(기다리지 않는다) */
function schedule(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

/**
 * 서버 이벤트 하나를 보낸다. 기다리지 않고, 던지지 않는다.
 * 응답이 결정된 뒤(쓰기가 성공한 뒤) 부른다 — 실패한 요청의 이벤트를 남기지 않게.
 */
export function trackServer<Name extends AnalyticsEventName>(name: Name, params: AnalyticsEventParams[Name], context: ServerEventContext): void {
  try {
    const built = buildServerEvent(name, params, context);
    if (!built.ok) {
      if (built.reason === "invalid_params" || built.reason === "unknown_event" || built.reason === "client_event") {
        logger.warn("analytics.server_event_refused", { event: name, reason: built.reason });
      }
      return;
    }
    schedule(() => sendMeasurement(name, built.url, built.payload));
  } catch (error) {
    logger.debug("analytics.server_event_failed", { event: name, reason: error instanceof Error ? error.name : "unknown" });
  }
}
