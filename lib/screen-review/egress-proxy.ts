import http from "node:http";
import net from "node:net";
import { promises as dns } from "node:dns";
import { timingSafeEqual } from "node:crypto";
import { blockedAddress, blockedHostname, SCREEN_DEFAULT_PORTS, type EgressSummary } from "./protocol";

/**
 * 화면 서버의 바깥 길 — 브라우저가 내는 모든 요청(첫 문서·넘겨주기·하위 자원·fetch·WebSocket)이 이 프록시 하나로만 나간다
 * (renderer.ts 가 Chromium 을 --proxy-server 로 여기에 묶고, 직접 DNS 를 막고, 루프백 우회도 끈다).
 *
 * 요청마다: 포트가 허용 목록(기본 80·443)인가 → 이름으로 막는 호스트인가(blockedHostname) → DNS 로 푼 주소 가운데 하나라도 사설·금지
 * (blockedAddress — lib/net/ssrf.ts isPrivateIp 그대로, 100.64/10·169.254/16 포함)면 막는다 → 검사한 바로 그 IP 로 연결한다.
 * 이름을 다시 풀지 않으므로 검사와 연결 사이에 레코드를 바꾸는 DNS 리바인딩이 통하지 않고, 같은 이름의 다음 요청은 다시 풀어 다시 본다.
 * ALLOW_PRIVATE_URLS 는 보지 않는다 — 이 길은 개발 환경에서도 사설망으로 열리지 않는다.
 *
 * 한 프록시가 그리기 하나다(브라우저도 그리기마다 새로 띄운다) — 요청 수·받은 바이트 상한이 그 그리기 전체에 걸린다. 넘으면 열린 연결을 모두 끊는다.
 * 막은 요청은 CONNECT 면 403, 평문 HTTP 면 403 과 x-nmv-egress: blocked 머리로 답한다(그린 쪽이 막힌 첫 문서를 판정하지 않게).
 */

export type EgressBlockReason = "port" | "host" | "address" | "dns" | "budget_requests" | "budget_bytes" | "bad_request" | "auth" | "connect";
export type EgressLookup = (host: string) => Promise<readonly { address: string; family: number }[]>;
/** 검사를 마친 IP·포트로 연결한다 — 시험은 공개 IP 를 로컬 서버로 바꿔 잇는다(정책은 진짜 그대로) */
export type EgressDial = (address: string, port: number, family: number) => net.Socket;

export type EgressProxyOptions = {
  lookup?: EgressLookup;
  dial?: EgressDial;
  ports?: readonly number[];
  /** 이 그리기에서 받을 요청(CONNECT·평문 HTTP)의 상한 */
  maxRequests?: number;
  /** 이 그리기에서 받을 바이트(바깥 → 브라우저)의 상한 */
  maxBytes?: number;
  connectTimeoutMs?: number;
  dnsTimeoutMs?: number;
  /** 쉬는 연결을 끊는 시간 */
  idleTimeoutMs?: number;
  /** 있으면 Proxy-Authorization(Basic) 이 맞아야 받는다 — 같은 호스트의 다른 프로세스가 이 길을 쓰지 못하게 */
  credentials?: { username: string; password: string };
};

export type EgressStats = EgressSummary & {
  reasons: Partial<Record<EgressBlockReason, number>>;
  /** 막은 목적지(호스트:포트 까닭) — 처음 20개. 경로·질의는 남기지 않는다 */
  blockedTargets: string[];
};

export type EgressProxy = { port: number; url: string; stats: EgressStats; blockedHost(host: string): boolean; close(): Promise<void> };

export const EGRESS_DEFAULTS = { maxRequests: 400, maxBytes: 40 * 1024 * 1024, connectTimeoutMs: 10_000, dnsTimeoutMs: 5_000, idleTimeoutMs: 20_000 };

/** 홉 사이에서 버리는 머리 — 프록시 인증·연결 관리 */
const HOP_HEADERS = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade",
  "proxy-authenticate"]);

const defaultLookup: EgressLookup = (host) => dns.lookup(host, { all: true, verbatim: true });
const defaultDial: EgressDial = (address, port, family) => net.connect({ host: address, port, family });

/** CONNECT 의 목적지 "host:port"·"[v6]:port" */
function parseAuthority(value: string | undefined): { host: string; port: number } | null {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]/\s]+):(\d{1,5})$/.exec(value ?? "");
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = match[1].startsWith("[") ? match[1].slice(1, -1) : match[1];
  return { host: host.toLowerCase().replace(/\.$/, ""), port };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("dns_timeout")), ms); })])
    .finally(() => clearTimeout(timer));
}

export async function startEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const lookup = options.lookup ?? defaultLookup;
  const dial = options.dial ?? defaultDial;
  const ports = options.ports ?? SCREEN_DEFAULT_PORTS;
  const maxRequests = options.maxRequests ?? EGRESS_DEFAULTS.maxRequests;
  const maxBytes = options.maxBytes ?? EGRESS_DEFAULTS.maxBytes;
  const connectTimeoutMs = options.connectTimeoutMs ?? EGRESS_DEFAULTS.connectTimeoutMs;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? EGRESS_DEFAULTS.dnsTimeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs ?? EGRESS_DEFAULTS.idleTimeoutMs;
  const expectedAuth = options.credentials
    ? `Basic ${Buffer.from(`${options.credentials.username}:${options.credentials.password}`).toString("base64")}` : null;
  const stats: EgressStats = { requests: 0, bytes: 0, blocked: 0, reasons: {}, blockedTargets: [] };
  const blockedHosts = new Set<string>();
  const sockets = new Set<net.Socket>();
  let closed = false;
  let overBudget = false;

  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const block = (reason: EgressBlockReason, target: string | null, host: string | null) => {
    // 인증 요구(407)는 막음이 아니다 — 브라우저는 첫 요청에 늘 한 번 받고 비밀을 실어 다시 보낸다
    if (reason !== "auth") stats.blocked += 1;
    stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
    if (host) blockedHosts.add(host);
    if (target && stats.blockedTargets.length < 20) stats.blockedTargets.push(`${target} ${reason}`);
  };
  const destroyAll = () => { for (const socket of sockets) socket.destroy(); };
  /** 받은 바이트를 센다 — 상한을 넘으면 열린 연결을 모두 끊는다 */
  const countBytes = (size: number) => {
    stats.bytes += size;
    if (stats.bytes > maxBytes && !overBudget) {
      overBudget = true;
      block("budget_bytes", null, null);
      destroyAll();
    }
  };

  /** 목적지를 가른다 — 통과면 연결할 IP */
  const decide = async (host: string, port: number): Promise<{ ok: true; address: string; family: number } | { ok: false; reason: EgressBlockReason }> => {
    stats.requests += 1;
    if (overBudget) return { ok: false, reason: "budget_bytes" };
    if (stats.requests > maxRequests) return { ok: false, reason: "budget_requests" };
    if (!ports.includes(port)) return { ok: false, reason: "port" };
    const family = net.isIP(host);
    if (!family && blockedHostname(host)) return { ok: false, reason: "host" };
    let answers: readonly { address: string; family: number }[];
    if (family) answers = [{ address: host, family }];
    else {
      try { answers = await withTimeout(lookup(host), dnsTimeoutMs); } catch { return { ok: false, reason: "dns" }; }
    }
    // 하나라도 사설이면 막는다(lib/net/ssrf.ts assertPublicUrl 과 같은 규칙) — 공개 주소와 사설 주소를 섞어 돌려주는 이름을 믿지 않는다
    if (!answers.length || answers.some((answer) => blockedAddress(answer.address))) return { ok: false, reason: "address" };
    return { ok: true, address: answers[0].address, family: answers[0].family === 6 ? 6 : 4 };
  };

  const authorized = (req: http.IncomingMessage) => {
    if (!expectedAuth) return true;
    const header = req.headers["proxy-authorization"];
    return typeof header === "string" && safeEqual(header, expectedAuth);
  };

  const server = http.createServer();
  server.on("connection", (socket: net.Socket) => {
    track(socket);
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
  });

  // HTTPS·WSS — 터널. TLS 는 브라우저와 목적지 사이 그대로다(이 길은 내용을 보지 않는다)
  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const deny = (status: number, reason: EgressBlockReason, target: string | null, host: string | null) => {
      block(reason, target, host);
      const extra = status === 407 ? 'Proxy-Authenticate: Basic realm="nmv-egress"\r\n' : "";
      client.end(`HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : status === 400 ? "Bad Request" : "Forbidden"}\r\n${extra}`
        + "X-Nmv-Egress: blocked\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    if (closed) return void client.destroy();
    if (!authorized(req)) return deny(407, "auth", null, null);
    const authority = parseAuthority(req.url);
    if (!authority) return deny(400, "bad_request", null, null);
    const target = `${authority.host}:${authority.port}`;
    void decide(authority.host, authority.port).then((decision) => {
      if (!decision.ok) return deny(403, decision.reason, target, authority.host);
      if (closed || client.destroyed) return;
      const upstream = track(dial(decision.address, authority.port, decision.family));
      let connected = false;
      upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error("connect_timeout")));
      upstream.once("connect", () => {
        connected = true;
        upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.on("data", (chunk: Buffer) => countBytes(chunk.length));
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once("error", () => {
        if (!connected && !client.destroyed && !client.writableEnded) return deny(502, "connect", target, null);
        client.destroy();
      });
      client.once("error", () => upstream.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
    });
  });

  // 평문 HTTP — 절대 주소 꼴(GET http://host/path)만 받는다
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const deny = (status: number, reason: EgressBlockReason, target: string | null, host: string | null) => {
      block(reason, target, host);
      if (res.headersSent) return void res.destroy();
      res.writeHead(status, { "x-nmv-egress": "blocked", "content-type": "text/plain; charset=utf-8", connection: "close",
        ...(status === 407 ? { "proxy-authenticate": 'Basic realm="nmv-egress"' } : {}) });
      res.end("blocked by egress policy");
    };
    if (!authorized(req)) return deny(407, "auth", null, null);
    let url: URL;
    try { url = new URL(req.url ?? ""); } catch { return deny(400, "bad_request", null, null); }
    if (url.protocol !== "http:" || url.username || url.password) return deny(400, "bad_request", null, null);
    const host = (url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname).toLowerCase().replace(/\.$/, "");
    const port = url.port ? Number(url.port) : 80;
    const target = `${host}:${port}`;
    void decide(host, port).then((decision) => {
      if (!decision.ok) return deny(403, decision.reason, target, host);
      if (closed) return void res.destroy();
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) if (!HOP_HEADERS.has(name) && value !== undefined) headers[name] = value;
      headers.host = url.host;
      // agent 를 주지 않는다 — agent:false 면 Node 가 createConnection 을 버리고 새 Agent 로 host 에 다시 잇는다. host 도 검사한 IP 로 적어
      // 어느 길로 이어도 이름을 다시 풀지 않게 한다
      const upstream = http.request({ host: decision.address, port, family: decision.family, method: req.method, path: `${url.pathname}${url.search}`,
        headers, setHost: false, timeout: connectTimeoutMs, createConnection: () => track(dial(decision.address, port, decision.family)) });
      upstream.on("response", (answer) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(answer.headers)) if (!HOP_HEADERS.has(name) && value !== undefined) out[name] = value;
        res.writeHead(answer.statusCode ?? 502, out);
        answer.on("data", (chunk: Buffer) => countBytes(chunk.length));
        answer.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy(new Error("upstream_timeout")));
      upstream.on("error", () => (res.headersSent ? res.destroy() : deny(502, "connect", target, null)));
      req.pipe(upstream);
      res.once("close", () => upstream.destroy());
    });
  });

  // 평문 Upgrade(ws://)는 받지 않는다 — Chromium 은 WebSocket 도 CONNECT 로 연다
  server.on("upgrade", (_req: http.IncomingMessage, socket: net.Socket) => {
    block("bad_request", null, null);
    socket.destroy();
  });
  server.on("clientError", (_error, socket: net.Socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, url: `http://127.0.0.1:${port}`, stats,
    blockedHost: (host) => blockedHosts.has(host.toLowerCase().replace(/\.$/, "")),
    close: async () => {
      if (closed) return;
      closed = true;
      destroyAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 화면 서버가 워커에 돌려주는 요약 — 막은 목적지 이름은 싣지 않는다 */
export function egressSummary(stats: EgressStats): EgressSummary {
  return { requests: stats.requests, bytes: stats.bytes, blocked: stats.blocked };
}
