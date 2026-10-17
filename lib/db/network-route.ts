/**
 * 운영 DB·Valkey 의 새 연결을 어느 길로 여나 — URL 의 주소부터, TCP 연결이 안 될 때만 *_FALLBACK_HOST 로(2026-10-17).
 *
 * 2026-10-17 V9-Primary·Replica 의 Tailscale 노드 키가 만료돼 Tailscale 주소만 아는 웹·워커가 5시간 DB 에 못 붙었다.
 * M3·mini 는 DB 서버와 같은 내부망(LAN)에도 있어 다른 길이 있다. 이 모듈은 "새 TCP 연결을 어디로 여나"만 고른다.
 * - 넘어가는 것은 TCP 연결 자체가 실패(거절·도달 불가·1초 안에 안 열림)했을 때뿐이다. 그때는 PostgreSQL/RESP 바이트를 하나도
 *   보내지 않았으므로 어떤 쿼리·쓰기도 두 번 나갈 수 없다. 연결된 뒤의 쿼리 오류·인증 거절·끊김은 넘기지 않는다(드라이버 원래 동작).
 * - 새 연결마다 URL 의 주소부터 다시 해 본다 — 원래 길이 돌아오면 다음 새 연결부터 그 길로(열려 있는 연결은 수명까지 그대로).
 * - *_FALLBACK_HOST 가 없으면(Oracle·로컬·CI) 이 모듈은 아무것도 하지 않는다 — 드라이버 옵션도 지금과 같다.
 * - 관측(/api/health, 워커 관측)에는 경로 이름(lan/tailscale/other)만 낸다. 주소·비밀은 내지 않는다.
 *
 * postgres.js 의 여러 host URL(`a:1,b:2`)은 쓰지 않는다 — 3.4.9 는 연결 자리마다 host 를 돌려 쓰고(성공한 뒤에도 다음 연결은
 * 다음 host), connect_timeout 이 나면 다음 host 로 넘어가지 않으며, 모두 거절되면 시간 제한 없이 다시 시도한다.
 */
import net from "node:net";
import { logger } from "../observability/logger";

export type Endpoint = Readonly<{ host: string; port: number }>;
export type NetworkRoute = "lan" | "tailscale" | "other";
export type RouteName = "primary" | "read" | "valkey";

/** 먼저 주소로 TCP 연결이 열리기를 기다리는 시간 — 실측 LAN·Tailscale 연결은 컨테이너에서 3ms 안쪽(2026-10-17) */
export const PREFERRED_CONNECT_MS = 1_000;
const LOG_EVERY_MS = 60_000;
const HOST_PORT = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):(\d{1,5})$/;

/** "host:port" 하나(IPv4·이름). 여러 개·IPv6·경로·URL 은 받지 않는다 — 틀리면 시작할 때 멈춘다(값은 오류에 넣지 않는다) */
export function parseFallbackHost(name: string, value: string): Endpoint {
  const match = HOST_PORT.exec(value.trim());
  const port = match ? Number(match[2]) : Number.NaN;
  if (!match || port < 1 || port > 65_535) throw new Error(`Invalid ${name}: expected host:port`);
  return { host: match[1], port };
}

/** 빈 값은 설정하지 않은 것 — Dokploy 에 `KEY=` 만 남아 있어도 지금과 같게 */
export function fallbackHostEnv(key: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  return env[key]?.trim() || undefined;
}

function urlEndpoint(name: string, url: string, raw: string): Endpoint {
  let host = "";
  try { host = new URL(url).host; } catch { /* 아래 고정 오류 — URL(비밀 포함)은 내지 않는다 */ }
  if (!raw || raw !== host) throw new Error(`Invalid ${name}: fallback needs one host:port`);
  try { return parseFallbackHost(name, raw); } catch { throw new Error(`Invalid ${name}: fallback needs one host:port`); }
}

/** postgres.js 3.4.9 가 읽는 host(첫 @ 뒤, 디코딩)와 WHATWG host 가 같은 명시 포트 하나일 때만 */
export function postgresUrlEndpoint(name: string, url: string): Endpoint {
  const authority = url.slice(url.indexOf("://") + 3).split(/[?/]/)[0];
  let raw = "";
  try { raw = decodeURIComponent(authority.slice(authority.indexOf("@") + 1)); } catch { /* 고정 오류 */ }
  return urlEndpoint(name, url, raw);
}

/** VALKEY_URL 의 주소만 바꾼 둘째 URL — 계정·비밀번호·DB 번호는 그대로 */
export function valkeyFallbackUrl(url: string, fallbackHost: string): string {
  let parsed: URL | null = null;
  try { parsed = new URL(url); } catch { /* 고정 오류 */ }
  urlEndpoint("VALKEY_URL", url, parsed?.port ? parsed.host : "");
  const fallback = parseFallbackHost("VALKEY_FALLBACK_HOST", fallbackHost);
  parsed!.hostname = fallback.host;
  parsed!.port = String(fallback.port);
  return parsed!.toString();
}

/** 주소 대역으로만 가린다: 100.64.0.0/10 = Tailscale, RFC1918 = LAN, 그 밖(이름·loopback 등) = other */
export function networkRoute(host: string): NetworkRoute {
  if (!net.isIPv4(host)) return "other";
  const [a, b] = host.split(".").map(Number);
  if (a === 100 && b >= 64 && b <= 127) return "tailscale";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
  return "other";
}

const registry = globalThis as typeof globalThis & { nomorevibeNetworkRoutes?: Map<RouteName, () => NetworkRoute | null> };
export function registerRoute(name: RouteName, current: () => NetworkRoute | null): void {
  (registry.nomorevibeNetworkRoutes ??= new Map()).set(name, current);
}
/** 대신 주소를 설정한 연결만 — 아직 TCP 연결을 연 적이 없으면 null */
export function networkRoutes(): Partial<Record<RouteName, NetworkRoute | null>> {
  return Object.fromEntries([...(registry.nomorevibeNetworkRoutes ?? [])].map(([name, current]) => [name, current()]));
}
/** 관측 값에 펼쳐 넣는 모양 — 설정한 연결이 없으면 빈 객체라 관측 값이 지금과 같다 */
export function networkRoutesField(): { networkRoutes?: ReturnType<typeof networkRoutes> } {
  const routes = networkRoutes();
  return Object.keys(routes).length ? { networkRoutes: routes } : {};
}

export function rateLimitedWarn(warn: (event: string, fields: Record<string, unknown>) => void = logger.warn, now = Date.now) {
  let loggedAt = -Infinity;
  return (event: string, fields: Record<string, unknown>) => {
    if (now() - loggedAt < LOG_EVERY_MS) return;
    loggedAt = now();
    warn(event, fields);
  };
}

type Connect = (endpoint: Endpoint) => net.Socket;
const tcpConnect: Connect = ({ host, port }) => net.connect({ host, port });
type TaggedSocket = net.Socket & { host: string; port: number };
// postgres.js 는 자기가 만든 소켓에 host/port 를 붙여 연결 오류 문구에 쓴다 — 같은 모양으로
const tag = (socket: net.Socket, endpoint: Endpoint) => Object.assign(socket, { host: endpoint.host, port: endpoint.port }) as TaggedSocket;

/**
 * postgres.js `socket` 옵션용 연결 함수. 돌려준 Promise 가 거절되면 postgres.js 3.4.9 는 그 연결 자리를 connecting 에 영영 남긴다
 * (풀이 줄어든다) — 그래서 절대 거절하지 않는다. 먼저 주소가 안 되면 대신 주소로 "여는 중인" 소켓을 그대로 돌려주고, 그 실패·시간
 * 초과는 드라이버의 원래 처리(connect_timeout, error/close → 연결 자리 반납)가 맡는다. 먼저 주소가 열리면 감시를 떼고 돌려준다.
 */
export function fallbackSocket(preferred: Endpoint, fallback: Endpoint, connected: (route: NetworkRoute, fellBack: boolean) => void,
  connect: Connect = tcpConnect, attemptMs = PREFERRED_CONNECT_MS): () => Promise<TaggedSocket> {
  return () => new Promise(resolve => {
    const first = connect(preferred);
    let settled = false;
    const settle = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      first.removeListener("connect", onConnect);
      first.removeListener("error", onError);
      if (opened) {
        connected(networkRoute(preferred.host), false);
        return resolve(tag(first, preferred));
      }
      first.on("error", () => {}); // 버린 소켓에서 늦게 오는 오류가 프로세스를 죽이지 않게
      first.destroy();
      const second = connect(fallback);
      second.once("connect", () => connected(networkRoute(fallback.host), true));
      resolve(tag(second, fallback));
    };
    const onConnect = () => settle(true);
    const onError = () => settle(false);
    const timer = setTimeout(() => settle(false), attemptMs);
    first.once("connect", onConnect);
    first.once("error", onError);
  });
}

/** DATABASE_URL·READ_DATABASE_URL 의 주소 다음에 대신 주소 — 마지막으로 연 경로를 관측에 올리고, 넘어간 것은 1분에 한 번 남긴다 */
export function postgresFallbackSocket(name: "primary" | "read", url: string, fallbackHost: string) {
  const prefix = name === "primary" ? "DATABASE" : "READ_DATABASE";
  const fallback = parseFallbackHost(`${prefix}_FALLBACK_HOST`, fallbackHost);
  const preferred = postgresUrlEndpoint(`${prefix}_URL`, url);
  let current: NetworkRoute | null = null;
  registerRoute(name, () => current);
  const warn = rateLimitedWarn();
  return fallbackSocket(preferred, fallback, (route, fellBack) => {
    current = route;
    if (fellBack) warn("db.connection_fallback", { pool: name, route, preferred: networkRoute(preferred.host) });
  });
}
