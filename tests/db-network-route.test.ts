import { EventEmitter } from "node:events";
import type net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fallbackHostEnv, fallbackSocket, networkRoute, networkRoutes, networkRoutesField, parseFallbackHost,
  postgresUrlEndpoint, registerRoute, valkeyFallbackUrl,
} from "@/lib/db/network-route";

/**
 * 운영 DB·Valkey 연결 경로(2026-10-17 Tailscale 키 만료 장애 뒤): URL 의 주소부터, TCP 연결이 안 될 때만 *_FALLBACK_HOST 로.
 * 넘어가는 판단은 프로토콜 바이트를 보내기 전에만 한다 — 쿼리는 어떤 경우에도 두 번 나가지 않는다.
 */
class FakeSocket extends EventEmitter {
  destroyed = false;
  constructor(readonly endpoint: { host: string; port: number }) { super(); }
  destroy() { this.destroyed = true; return this; }
}

function connector() {
  const sockets: FakeSocket[] = [];
  const connect = vi.fn((endpoint: { host: string; port: number }) => {
    const socket = new FakeSocket(endpoint);
    sockets.push(socket);
    return socket as unknown as net.Socket;
  });
  return { sockets, connect };
}

const LAN = { host: "192.168.50.18", port: 6432 };
const TAILSCALE = { host: "100.99.209.55", port: 6432 };

afterEach(() => {
  (globalThis as { nomorevibeNetworkRoutes?: unknown }).nomorevibeNetworkRoutes = undefined;
  vi.useRealTimers();
});

describe("host:port 설정", () => {
  it("IPv4·이름과 포트 하나만 받는다", () => {
    expect(parseFallbackHost("DATABASE_FALLBACK_HOST", "100.99.209.55:6432")).toEqual(TAILSCALE);
    expect(parseFallbackHost("X", " db-primary.lan:5432 ")).toEqual({ host: "db-primary.lan", port: 5432 });
    for (const value of ["100.99.209.55", "100.99.209.55:0", "100.99.209.55:65536", "a:1,b:2", "[::1]:5432",
      "postgres://u:p@h:1/db", "/tmp/.s.PGSQL.5432", "h:1/x", ""]) {
      expect(() => parseFallbackHost("DATABASE_FALLBACK_HOST", value)).toThrow("Invalid DATABASE_FALLBACK_HOST: expected host:port");
    }
  });

  it("빈 값은 설정하지 않은 것으로 본다", () => {
    expect(fallbackHostEnv("DATABASE_FALLBACK_HOST", {})).toBeUndefined();
    expect(fallbackHostEnv("DATABASE_FALLBACK_HOST", { DATABASE_FALLBACK_HOST: "  " })).toBeUndefined();
    expect(fallbackHostEnv("DATABASE_FALLBACK_HOST", { DATABASE_FALLBACK_HOST: " 1.2.3.4:5 " })).toBe("1.2.3.4:5");
  });

  it("postgres URL 은 드라이버가 읽는 host 하나와 명시 포트만 — 여러 host·경로·포트 없음은 거절하고 비밀을 내지 않는다", () => {
    expect(postgresUrlEndpoint("DATABASE_URL", "postgres://u:s3cret@192.168.50.18:6432/nomorevibe")).toEqual(LAN);
    for (const url of ["postgres://u:s3cret@192.168.50.18,100.99.209.55:6432/nomorevibe",
      "postgres://u:s3cret@a%2cb:6432/nomorevibe", "postgres://u:s3cret@192.168.50.18/nomorevibe",
      "postgres://u:s3cret@evil@192.168.50.18:6432/nomorevibe", "not a url"]) {
      let message = "";
      try { postgresUrlEndpoint("DATABASE_URL", url); } catch (error) { message = (error as Error).message; }
      expect(message).toBe("Invalid DATABASE_URL: fallback needs one host:port");
    }
  });

  it("Valkey URL 은 주소만 바꾸고 계정·비밀번호·DB 번호는 그대로 둔다", () => {
    expect(valkeyFallbackUrl("redis://nmv:p%40ss@100.99.209.55:6380/0", "192.168.50.18:6380"))
      .toBe("redis://nmv:p%40ss@192.168.50.18:6380/0");
    expect(() => valkeyFallbackUrl("redis://nmv:pw@100.99.209.55/0", "192.168.50.18:6380"))
      .toThrow("Invalid VALKEY_URL: fallback needs one host:port");
    expect(() => valkeyFallbackUrl("redis://nmv:pw@100.99.209.55:6380", "192.168.50.18"))
      .toThrow("Invalid VALKEY_FALLBACK_HOST: expected host:port");
  });

  it("경로 이름은 주소 대역으로만 가린다", () => {
    expect(networkRoute("100.99.209.55")).toBe("tailscale");
    expect(networkRoute("100.64.0.1")).toBe("tailscale");
    expect(networkRoute("100.128.0.1")).toBe("other");
    expect(networkRoute("192.168.50.18")).toBe("lan");
    expect(networkRoute("10.0.0.5")).toBe("lan");
    expect(networkRoute("172.20.1.1")).toBe("lan");
    expect(networkRoute("172.32.1.1")).toBe("other");
    expect(networkRoute("127.0.0.1")).toBe("other");
    expect(networkRoute("db.internal")).toBe("other");
  });
});

describe("새 연결의 경로 고르기", () => {
  it("먼저 주소가 열리면 그 소켓을 그대로 주고 대신 주소는 건드리지 않는다", async () => {
    const { sockets, connect } = connector();
    const connected = vi.fn();
    const open = fallbackSocket(LAN, TAILSCALE, connected, connect, 1_000);
    const pending = open();
    sockets[0].emit("connect");
    const socket = await pending as unknown as FakeSocket & { host: string; port: number };
    expect(socket).toBe(sockets[0]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connected).toHaveBeenCalledWith("lan", false);
    // 드라이버가 자기 error/close 처리를 붙인다 — 우리 쪽 감시는 남기지 않는다
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("connect")).toBe(0);
    expect([socket.host, socket.port]).toEqual([LAN.host, LAN.port]);
  });

  it("먼저 주소가 거절되면 대신 주소로 여는 중인 소켓을 주고, 실제로 열렸을 때만 경로를 남긴다", async () => {
    const { sockets, connect } = connector();
    const connected = vi.fn();
    const pending = fallbackSocket(LAN, TAILSCALE, connected, connect, 1_000)();
    sockets[0].emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    const socket = await pending as unknown as FakeSocket & { host: string };
    expect(sockets[0].destroyed).toBe(true);
    expect(socket).toBe(sockets[1]);
    expect(socket.endpoint).toEqual(TAILSCALE);
    expect(socket.host).toBe(TAILSCALE.host);
    expect(connected).not.toHaveBeenCalled();
    socket.emit("connect");
    expect(connected).toHaveBeenCalledWith("tailscale", true);
    // 버려진 소켓에서 늦게 온 오류가 프로세스를 죽이지 않는다
    expect(() => sockets[0].emit("error", new Error("late"))).not.toThrow();
  });

  it("먼저 주소가 응답이 없으면 정한 시간 뒤 대신 주소로 넘어간다", async () => {
    vi.useFakeTimers();
    const { sockets, connect } = connector();
    const pending = fallbackSocket(LAN, TAILSCALE, vi.fn(), connect, 1_000)();
    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(sockets[1]);
    expect(sockets[0].destroyed).toBe(true);
  });

  it("둘 다 안 돼도 거절하지 않는다 — 대신 주소의 실패는 드라이버의 error/close 가 처리한다", async () => {
    const { sockets, connect } = connector();
    const pending = fallbackSocket(LAN, TAILSCALE, vi.fn(), connect, 1_000)();
    sockets[0].emit("error", new Error("refused"));
    const socket = await pending as unknown as FakeSocket;
    const driverError = vi.fn();
    socket.on("error", driverError);
    socket.emit("error", new Error("refused too"));
    expect(driverError).toHaveBeenCalledTimes(1);
  });

  it("새 연결마다 먼저 주소부터 다시 해 본다(원래 길 복귀)", async () => {
    const { sockets, connect } = connector();
    const open = fallbackSocket(LAN, TAILSCALE, vi.fn(), connect, 1_000);
    const first = open();
    sockets[0].emit("error", new Error("down"));
    await first;
    const second = open();
    expect(sockets[2].endpoint).toEqual(LAN);
    sockets[2].emit("connect");
    expect(await second).toBe(sockets[2]);
  });
});

describe("경로 관측", () => {
  it("대신 주소를 설정한 연결만 이름과 경로를 낸다", () => {
    expect(networkRoutes()).toEqual({});
    expect(networkRoutesField()).toEqual({});
    let route: "lan" | "tailscale" | null = null;
    registerRoute("primary", () => route);
    expect(networkRoutes()).toEqual({ primary: null });
    route = "tailscale";
    expect(networkRoutesField()).toEqual({ networkRoutes: { primary: "tailscale" } });
  });
});
