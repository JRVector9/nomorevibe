import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startEgressProxy, type EgressLookup, type EgressProxy } from "@/lib/screen-review/egress-proxy";
import { blockedAddress, blockedHostname, parsePorts, renderableUrl } from "@/lib/screen-review/protocol";

/**
 * 화면 서버의 바깥 길(egress-proxy.ts) — 진짜 정책 그대로 두고 DNS(lookup)와 연결(dial)만 바꾼다. 공개 IP 93.184.216.34 를 로컬 서버로 잇고,
 * 사설로 풀리는 이름·리터럴은 연결 자체가 일어나지 않는지(dial 기록) 본다. 바깥 사이트에는 나가지 않는다.
 */
const PUBLIC = "93.184.216.34";
/** 프록시 인증 — 시험마다 무작위(저장소에 비밀 같은 글을 두지 않는다) */
const credentials = { username: "nmv", password: randomBytes(12).toString("hex") };
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const AUTH = basic(credentials.username, credentials.password);

let origin: http.Server, echo: net.Server, originPort = 0, echoPort = 0;
const dialed: string[] = [];
let lookups: string[] = [];
let answers: Record<string, string[] | (() => string[])> = {};
const proxies: EgressProxy[] = [];

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    if (req.url === "/redirect-private") { res.writeHead(302, { location: "http://10.0.0.1/admin" }); return res.end(); }
    if (req.url === "/redirect-metadata") { res.writeHead(302, { location: "http://metadata.example/latest/meta-data/" }); return res.end(); }
    if (req.url === "/big") { res.writeHead(200); return res.end(Buffer.alloc(64 * 1024, 97)); }
    res.writeHead(200, { "content-type": "text/plain", "x-host": String(req.headers.host), "x-auth": String(req.headers["proxy-authorization"] ?? "") });
    res.end(`hello ${req.url}`);
  });
  echo = net.createServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  originPort = (origin.address() as net.AddressInfo).port;
  echoPort = (echo.address() as net.AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close();
  dialed.length = 0;
  lookups = [];
  answers = {};
});

const lookup: EgressLookup = async (host) => {
  lookups.push(host);
  const value = answers[host];
  const list = typeof value === "function" ? value() : value;
  if (!list) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return list.map((address) => ({ address, family: net.isIP(address) }));
};
/** 검사를 마친 IP 로만 잇는다 — 공개 IP 의 80 은 HTTP 서버, 443 은 에코 서버. 그 밖은 실패 */
const dial = (address: string, port: number) => {
  dialed.push(`${address}:${port}`);
  if (address === PUBLIC) return net.connect({ host: "127.0.0.1", port: port === 80 ? originPort : echoPort });
  const socket = new net.Socket();
  queueMicrotask(() => socket.destroy(new Error("ECONNREFUSED")));
  return socket;
};

async function proxy(options: Parameters<typeof startEgressProxy>[0] = {}) {
  const started = await startEgressProxy({ lookup, dial, credentials, ...options });
  proxies.push(started);
  return started;
}

/** 평문 HTTP 를 프록시로(절대 주소 꼴) */
function viaProxy(target: EgressProxy, url: string, auth: string | null = AUTH): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: target.port, method: "GET", path: url,
      headers: { host: URL.canParse(url) ? new URL(url).host : "public.example", ...(auth ? { "proxy-authorization": auth } : {}) } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** CONNECT 를 날 소켓으로 — 상태 줄과(열렸으면) 에코로 돌아온 글 */
function tunnel(target: EgressProxy, authority: string, auth: string | null = AUTH): Promise<{ status: number; echoed: string | null }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: target.port });
    let buffer = "";
    let status = 0;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!status && buffer.includes("\r\n\r\n")) {
        status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1] ?? 0);
        buffer = buffer.slice(buffer.indexOf("\r\n\r\n") + 4);
        if (status === 200) socket.write("ping");
      }
      if (status === 200 && buffer.includes("ping")) { socket.destroy(); resolve({ status, echoed: "ping" }); }
    });
    socket.on("close", () => resolve({ status, echoed: null }));
    socket.on("error", () => resolve({ status, echoed: null }));
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
  });
}

describe("목적지 정책", () => {
  it("사설·루프백·링크로컬·Tailscale(100.64/10)·v4 를 품은 v6 는 막고 공개 주소는 통과시킨다", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "100.100.100.100", "100.127.255.254", "172.16.5.4", "192.168.50.241",
      "0.0.0.0", "::1", "::", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "::7f00:1", "2002:7f00:1::",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b::a00:1", "not-an-ip"]) {
      expect(blockedAddress(ip), ip).toBe(true);
    }
    for (const ip of [PUBLIC, "1.1.1.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) expect(blockedAddress(ip), ip).toBe(false);
  });

  it("이름만으로도 사설인 호스트는 막는다 — localhost·.local·.internal·한 낱말·MagicDNS(.ts.net)", () => {
    for (const host of ["localhost", "LOCALHOST.", "app.localhost", "printer.local", "metadata.google.internal", "db", "m1-studio.tail02799e.ts.net",
      "router.home.arpa", "nas.lan", ""]) expect(blockedHostname(host), host).toBe(true);
    for (const host of ["example.com", "nomorevibe.com.", "a.b.c.io"]) expect(blockedHostname(host), host).toBe(false);
  });

  it("그릴 주소는 http(s)·계정 정보 없음·허용 포트·공개 호스트만", () => {
    expect(renderableUrl("https://example.com/app")?.href).toBe("https://example.com/app");
    expect(renderableUrl("http://example.com:80/")).not.toBeNull();
    for (const raw of ["ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/", "https://example.com:8443/", "http://127.0.0.1/",
      "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://100.77.43.63:8090/v1", "https://m1-studio.tail02799e.ts.net/", "http://intranet/",
      "javascript:alert(1)", `https://example.com/${"a".repeat(2100)}`]) expect(renderableUrl(raw), raw).toBeNull();
    expect(renderableUrl("https://example.com:8443/", [443, 8443])).not.toBeNull();
    expect(parsePorts("443, 8443")).toEqual([443, 8443]);
    expect(parsePorts("abc")).toEqual([80, 443]);
    expect(parsePorts(undefined)).toEqual([80, 443]);
  });
});

describe("평문 HTTP", () => {
  it("공개로 풀리는 이름은 검사한 그 IP 로 잇고, Host 는 원래 이름·프록시 인증은 넘기지 않는다", async () => {
    answers["public.example"] = [PUBLIC];
    const target = await proxy();
    const res = await viaProxy(target, "http://public.example/page?x=1");
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello /page?x=1");
    expect(res.headers["x-host"]).toBe("public.example");
    expect(res.headers["x-auth"]).toBe("");
    expect(dialed).toEqual([`${PUBLIC}:80`]);
    expect(target.stats).toMatchObject({ requests: 1, blocked: 0 });
  });

  it("사설 IP 로 넘겨주면(302) 브라우저의 다음 요청을 막는다 — 연결은 일어나지 않는다", async () => {
    answers["public.example"] = [PUBLIC];
    answers["metadata.example"] = ["169.254.169.254"];
    const target = await proxy();
    const first = await viaProxy(target, "http://public.example/redirect-private");
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe("http://10.0.0.1/admin");
    const next = await viaProxy(target, first.headers.location!);
    expect(next.status).toBe(403);
    expect(next.headers["x-nmv-egress"]).toBe("blocked");
    const metadata = await viaProxy(target, (await viaProxy(target, "http://public.example/redirect-metadata")).headers.location!);
    expect(metadata.status).toBe(403);
    expect(dialed).toEqual([`${PUBLIC}:80`, `${PUBLIC}:80`]);
    expect(target.stats.reasons.address).toBe(2);
    expect(target.blockedHost("10.0.0.1")).toBe(true);
    expect(target.blockedHost("metadata.example")).toBe(true);
    expect(target.stats.blockedTargets).toEqual(["10.0.0.1:80 address", "metadata.example:80 address"]);
  });

  it("인증이 없거나 틀리면 407, 허용 밖 포트·풀리지 않는 이름·절대 주소가 아닌 요청은 막는다", async () => {
    answers["public.example"] = [PUBLIC];
    const target = await proxy();
    expect((await viaProxy(target, "http://public.example/", null)).status).toBe(407);
    expect((await viaProxy(target, "http://public.example/", basic(credentials.username, `${credentials.password}x`))).status).toBe(407);
    expect((await viaProxy(target, "http://public.example:8080/")).status).toBe(403);
    expect((await viaProxy(target, "http://nowhere.example/")).status).toBe(403);
    expect((await viaProxy(target, "/relative")).status).toBe(400);
    expect(target.stats.reasons).toMatchObject({ auth: 2, port: 1, dns: 1, bad_request: 1 });
    expect(dialed).toEqual([]);
  });
});

describe("CONNECT(HTTPS·WebSocket)", () => {
  it("공개 목적지는 터널을 열어 그대로 잇는다", async () => {
    answers["public.example"] = [PUBLIC];
    const target = await proxy();
    expect(await tunnel(target, "public.example:443")).toEqual({ status: 200, echoed: "ping" });
    expect(dialed).toEqual([`${PUBLIC}:443`]);
  });

  it("하위 자원이 169.254.169.254·100.64/10(Tailscale)·루프백 리터럴·풀어 쓴 v4 매핑 v6·사설 이름으로 가면 403 이고 연결하지 않는다", async () => {
    answers["tail.example"] = ["100.100.1.2"];
    answers["meta.example"] = ["169.254.169.254"];
    const target = await proxy();
    for (const authority of ["169.254.169.254:443", "tail.example:443", "meta.example:443", "127.0.0.1:443", "[::1]:443", "[::ffff:127.0.0.1]:443",
      "[0:0:0:0:0:ffff:7f00:1]:443", "localhost:443", "intranet:443", "m1-studio.tail02799e.ts.net:443", "100.77.43.63:443"]) {
      expect((await tunnel(target, authority)).status, authority).toBe(403);
    }
    expect(dialed).toEqual([]);
  });

  it("DNS 리바인딩 — 처음 공개로 풀린 이름은 그 IP 로 잇고(다시 풀지 않는다), 다음 요청에서 사설로 바뀌면 막는다", async () => {
    let calls = 0;
    answers["rebind.example"] = () => (++calls === 1 ? [PUBLIC] : ["10.0.0.5"]);
    const target = await proxy();
    expect((await tunnel(target, "rebind.example:443")).status).toBe(200);
    expect(dialed).toEqual([`${PUBLIC}:443`]);
    expect(lookups).toEqual(["rebind.example"]);
    expect((await tunnel(target, "rebind.example:443")).status).toBe(403);
    expect(lookups).toEqual(["rebind.example", "rebind.example"]);
    expect(dialed).toEqual([`${PUBLIC}:443`]);
  });

  it("공개·사설을 섞어 돌려주는 이름은 막는다", async () => {
    answers["mixed.example"] = [PUBLIC, "10.0.0.1"];
    const target = await proxy();
    expect((await tunnel(target, "mixed.example:443")).status).toBe(403);
    expect(dialed).toEqual([]);
  });

  it("허용 밖 포트·인증 없음·연결 실패", async () => {
    answers["public.example"] = [PUBLIC];
    answers["refused.example"] = ["8.8.8.8"];
    const target = await proxy();
    expect((await tunnel(target, "public.example:22")).status).toBe(403);
    expect((await tunnel(target, "public.example:443", null)).status).toBe(407);
    expect((await tunnel(target, "refused.example:443")).status).toBe(502);
  });
});

describe("그리기 하나의 상한", () => {
  it("요청 수 상한을 넘으면 막는다", async () => {
    answers["public.example"] = [PUBLIC];
    const target = await proxy({ maxRequests: 2 });
    expect((await viaProxy(target, "http://public.example/1")).status).toBe(200);
    expect((await tunnel(target, "public.example:443")).status).toBe(200);
    expect((await viaProxy(target, "http://public.example/3")).status).toBe(403);
    expect(target.stats.reasons.budget_requests).toBe(1);
  });

  it("받은 바이트 상한을 넘으면 열린 연결을 끊고, 그 뒤 요청도 막는다", async () => {
    answers["public.example"] = [PUBLIC];
    const target = await proxy({ maxBytes: 16 * 1024 });
    await viaProxy(target, "http://public.example/big").catch(() => null);
    expect(target.stats.reasons.budget_bytes).toBe(1);
    expect((await viaProxy(target, "http://public.example/again")).status).toBe(403);
  });

  it("평문 Upgrade(ws://)는 받지 않는다", async () => {
    const target = await proxy();
    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: target.port });
      socket.on("close", () => resolve(true));
      socket.on("error", () => resolve(true));
      socket.write(`GET http://public.example/ws HTTP/1.1\r\nHost: public.example\r\nProxy-Authorization: ${AUTH}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    expect(closed).toBe(true);
    expect(dialed).toEqual([]);
  });

  it("닫으면 열린 터널도 끊는다", async () => {
    answers["public.example"] = [PUBLIC];
    const target = await proxy();
    const socket = net.connect({ host: "127.0.0.1", port: target.port });
    await new Promise<void>((resolve) => {
      socket.once("data", () => resolve());
      socket.write(`CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\nProxy-Authorization: ${AUTH}\r\n\r\n`);
    });
    const closed = new Promise<boolean>((resolve) => socket.once("close", () => resolve(true)));
    await target.close();
    expect(await closed).toBe(true);
  });
});
