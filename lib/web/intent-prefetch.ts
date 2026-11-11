import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import { pathLocale, stripLocale } from "@/lib/i18n/routing";

/**
 * 의도가 보인 링크만 미리 받는다 — 마우스가 머문 링크, 키보드로 고른 링크.
 *
 * 공개 화면의 링크는 2026-10-06(#283)부터 화면에 보이기만 해도 미리 받는 일을 끈다(prefetch={false}).
 * 홈 한 번에 RSC 요청 약 48개가 원 서버 비용의 약 80%였다. 그 대신 누를 때마다 왕복 한 번(한국→미국 엣지 135~140ms,
 * 엣지에 없으면 0.5~1.2초)을 기다렸다. 여기서는 누를 것 같은 링크 하나만, 간격을 두고 받는다.
 *
 * 누르는 순간(pointerdown·touchstart)에는 받지 않는다. 미리 받기는 경로 틀(`/_tree`) 왕복을 먼저 거치는데, 그 답이 오기 전에
 * 이동이 시작되면 Next 는 이동 요청을 따로 보내고, 뒤늦게 나간 미리 받기 응답을 기다리느라 이동이 오히려 늦어진다
 * (2026-11-11 실측: RTT 140ms·서버 600ms 에서 누를 때 받기 798→1160ms, 요청 1→3개). 터치는 탭 길이(약 0.1초)가
 * 그 왕복보다 짧아 늘 이 경우다.
 *
 * 이 파일은 DOM 없이 시험할 수 있는 규칙만 담는다. 화면에 거는 일은 components/IntentPrefetch.tsx 가 한다.
 */

/** 마우스가 이만큼 머물러야 미리 받는다(지나가는 포인터는 거른다) */
export const HOVER_DELAY_MS = 65;
/** 머묾·초점으로 받는 것은 이 간격에 하나 — 그리드를 쓸고 지나가도 1초에 하나를 넘지 않는다 */
export const MIN_GAP_MS = 1_000;
/** 같은 주소는 이 시간 안에 다시 받지 않는다 — next.config.ts 의 staleTimes.static(30초)과 같다 */
export const REUSE_MS = 30_000;

/**
 * 미리 받을 공개 화면: 홈·목록(/popular·/rising·/talk)·분야(/c/…)·순위(/rankings/…)·상세(/p/…)·올리기(/launch).
 * 모두 next.config.ts 가 엣지에 저장하는 화면이다. 로그인·마이페이지·피드백·상세의 GitHub 화면(엣지 저장 안 함)·
 * 게재 기준(거의 누르지 않는다)·관리자·API·파일은 받지 않는다.
 */
const INTENT_ROUTE = /^\/(?:|popular|rising|talk|launch|c\/[^/]+|rankings\/[^/]+|p\/[^/]+)\/?$/;
/**
 * q: 검색은 엣지에 저장하지 않고 응답 뒤 검색 기록을 남긴다(next.config.ts).
 * metric: 집계 기준 창은 브라우저에서만 읽는다 — 서버가 홈 전체를 다시 그릴 까닭이 없다(MethodologyDialog).
 */
const SKIP_PARAMS = ["q", "metric"];

export type IntentAnchor = {
  /** 브라우저가 푼 절대 주소(HTMLAnchorElement.href) */
  href: string;
  target: string;
  download: boolean;
};

export type IntentLocation = { origin: string; pathname: string; search: string };

/** 미리 받을 주소(경로+쿼리, # 제외). 받지 않을 링크면 null */
export function intentPrefetchPath(anchor: IntentAnchor, current: IntentLocation): string | null {
  if (anchor.download || (anchor.target !== "" && anchor.target !== "_self")) return null;
  let url: URL;
  try {
    url = new URL(anchor.href, `${current.origin}${current.pathname}${current.search}`);
  } catch {
    return null;
  }
  if (url.origin !== current.origin || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  if (url.username || url.password) return null;
  if (SKIP_PARAMS.some((name) => url.searchParams.has(name))) return null;
  // 같은 화면 안의 # 이동은 받을 것이 없다
  if (url.pathname === current.pathname && url.search === current.search) return null;
  try {
    const locale = pathLocale(url.pathname);
    // /ko/… 는 접두어 없는 주소로 308 되돌린다. 다른 언어로 가는 링크(언어 바꾸기)는 문서를 새로 불러온다
    if (locale === DEFAULT_LOCALE || (locale ?? DEFAULT_LOCALE) !== (pathLocale(current.pathname) ?? DEFAULT_LOCALE)) return null;
    if (!INTENT_ROUTE.test(stripLocale(url.pathname))) return null;
  } catch {
    return null;
  }
  return `${url.pathname}${url.search}`;
}

type Connection = { saveData?: boolean; effectiveType?: string } | null | undefined;

/** 데이터 절약 모드·2G 에서는 미리 받지 않는다 */
export function connectionAllowsPrefetch(connection: Connection): boolean {
  if (!connection) return true;
  if (connection.saveData === true) return false;
  return connection.effectiveType !== "slow-2g" && connection.effectiveType !== "2g";
}

type Timer = unknown;

export type IntentPrefetcherOptions = {
  prefetch: (path: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  hoverDelayMs?: number;
  minGapMs?: number;
  reuseMs?: number;
};

/**
 * 머묾·초점(enter)은 지연 뒤에, 앞선 것과 MIN_GAP_MS 를 두고 하나씩 받는다. 간격 때문에 미룬 것은 그때까지 포인터가
 * 그 링크에 남아 있을 때만 받는다(마지막 하나만 기억한다). 누르기·키 입력이 오면 아직 나가지 않은 것을 버리고(cancel)
 * MIN_GAP_MS 동안 쉰다 — 이동이 시작된 뒤에 나가는 미리 받기는 이동을 늦춘다. REUSE_MS 안에 받은 주소는 다시 받지 않는다.
 */
export class IntentPrefetcher {
  private readonly prefetch: (path: string) => void;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly hoverDelayMs: number;
  private readonly minGapMs: number;
  private readonly reuseMs: number;
  private readonly issued = new Map<string, number>();
  private lastIssuedAt = Number.NEGATIVE_INFINITY;
  /** 누른 뒤 MIN_GAP_MS 동안은 새로 받지 않는다 — 누른 링크 위의 작은 움직임으로 이동 중에 받지 않게 */
  private quietUntil = Number.NEGATIVE_INFINITY;
  private current: string | null = null;
  private timer: Timer | null = null;

  constructor(options: IntentPrefetcherOptions) {
    this.prefetch = options.prefetch;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.hoverDelayMs = options.hoverDelayMs ?? HOVER_DELAY_MS;
    this.minGapMs = options.minGapMs ?? MIN_GAP_MS;
    this.reuseMs = options.reuseMs ?? REUSE_MS;
  }

  /** 포인터·초점이 이 주소의 링크에 들어왔다 */
  enter(path: string): void {
    if (path === this.current) return;
    this.cancelTimer();
    this.current = path;
    if (this.recentlyIssued(path)) return;
    const now = this.now();
    const wait = Math.max(this.hoverDelayMs, this.lastIssuedAt + this.minGapMs - now, this.quietUntil - now);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.current === path) this.issue(path);
    }, wait);
  }

  /** 포인터·초점이 링크를 떠났다 — 아직 받지 않았으면 받지 않는다. path 를 주면 그 링크일 때만 */
  leave(path?: string): void {
    if (path !== undefined && path !== this.current) return;
    this.cancelTimer();
    this.current = null;
  }

  /** 누르기·키 입력 — 아직 나가지 않은 미리 받기를 버린다 */
  cancel(): void {
    this.leave();
    this.quietUntil = this.now() + this.minGapMs;
  }

  dispose(): void {
    this.leave();
    this.issued.clear();
  }

  private recentlyIssued(path: string): boolean {
    const at = this.issued.get(path);
    return at !== undefined && this.now() - at < this.reuseMs;
  }

  private issue(path: string): void {
    const now = this.now();
    this.lastIssuedAt = now;
    for (const [key, at] of this.issued) if (now - at >= this.reuseMs) this.issued.delete(key);
    this.issued.set(path, now);
    try {
      this.prefetch(path);
    } catch {
      // 미리 받기는 덤이다 — 실패해도 누르면 평소처럼 이동한다
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
