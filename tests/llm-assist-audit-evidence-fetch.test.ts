import { promises as dns } from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ request: vi.fn(), lock: vi.fn(), facts: vi.fn(), protections: vi.fn(),
  tx: { execute: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: { transaction: (run: (tx: typeof runtime.tx) => Promise<unknown>) => run(runtime.tx) } }));
vi.mock("@/lib/net/http-transport", () => ({ nativeHttpFetch: runtime.request, legacyHttpDispatcher: vi.fn() }));
vi.mock("@/lib/domain/products/automated-action-audit-repository", async original => ({
  ...await original<typeof import("@/lib/domain/products/automated-action-audit-repository")>(),
  lockActionAuditCandidate: runtime.lock, readCurrentActionAuditFacts: runtime.facts,
  readActionAuditProtections: runtime.protections,
}));
import { collectActionAuditInput } from "@/lib/domain/llm-assist/audit-runtime";
import { candidate } from "./fixtures/automated-action-audit";

const selected = () => ({ ...candidate(), selectedAt: new Date(Date.now() - 1000).toISOString() });
const waiting = { kind: "waiting_evidence", reason: "audit_current_evidence_required" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
  runtime.lock.mockResolvedValue(true);
  runtime.facts.mockResolvedValue({ task: "uptime", requestedUrl: "https://example.com" });
  runtime.protections.mockResolvedValue({ administratorReleased: false, makerProtected: false });
  runtime.tx.execute.mockResolvedValue([{ repoUrl: null }]);
});
afterEach(() => vi.restoreAllMocks());

describe("실제 capped fetch를 통한 감사 현재 근거 수집", () => {
  it.each([404, 410])("완전한 page HTTP %i 본문을 현재 관측으로 보존한다", async status => {
    const body = "<html><body><p>This deployment no longer exists.</p></body></html>";
    runtime.request.mockResolvedValue(new Response(body, { status }));
    const collected = await collectActionAuditInput(selected());
    expect(collected.kind).toBe("ready");
    if (collected.kind !== "ready") throw new Error(collected.reason);
    expect(collected.input.sources.find(source => source.kind === "page")).toMatchObject({
      url: "https://example.com", httpStatus: status, text: "This deployment no longer exists.", completeness: "complete",
    });
    // Collection preserves an observation; it does not issue an alive/closed verdict.
    expect(collected.input.task).toBe("audit");
    expect(runtime.request).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 999])("HTTP %i 차단 본문은 완전한 감사 근거로 승격하지 않는다", async status => {
    const response = new Response("<p>Readable error body.</p>", { status: status === 999 ? 403 : status });
    if (status === 999) Object.defineProperty(response, "status", { value: status });
    const cancel = vi.spyOn(response.body!, "cancel");
    runtime.request.mockResolvedValue(response);
    expect(await collectActionAuditInput(selected())).toEqual(waiting);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("404의 브라우저 확인 페이지도 차단 근거로 유지한다", async () => {
    runtime.request.mockResolvedValue(new Response("<p>Verify you are human</p>", { status: 404 }));
    expect(await collectActionAuditInput(selected())).toEqual(waiting);
  });

  it.each(["bytes", "text"] as const)("404 본문의 %s 상한을 넘기면 complete로 만들지 않는다", async limit => {
    const body = limit === "bytes" ? "<!--" + "x".repeat(128_000) + "--><p>Tail</p>" : "<p>" + "x".repeat(32_001) + "</p>";
    runtime.request.mockResolvedValue(new Response(body, { status: 404 }));
    expect(await collectActionAuditInput(selected())).toEqual(waiting);
  });

  it("page만 오류 본문을 허용하며 repository와 README는 엄격한 기본값을 유지한다", async () => {
    runtime.tx.execute.mockResolvedValue([{ repoUrl: "https://github.com/example/tool" }]);
    runtime.request.mockImplementation(async (url: string) => new Response("<p>Missing deployment.</p>", {
      status: url === "https://example.com" ? 404 : 410,
    }));
    const collected = await collectActionAuditInput(selected());
    if (collected.kind !== "ready") throw new Error(collected.reason);
    expect(collected.input.sources.filter(source => source.kind !== "metadata").map(source => ({
      kind: source.kind, status: source.httpStatus, text: source.text, completeness: source.completeness,
    }))).toEqual([
      { kind: "page", status: 404, text: "Missing deployment.", completeness: "complete" },
      { kind: "repository", status: 410, text: "", completeness: "missing" },
      { kind: "readme", status: 410, text: "", completeness: "missing" },
    ]);
    expect(runtime.request).toHaveBeenCalledTimes(3);
  });

  it("repo·README가 잘려도 완전한 404 page 본문을 버리지 않는다", async () => {
    runtime.tx.execute.mockResolvedValue([{ repoUrl: "https://github.com/example/tool" }]);
    const text = "<p>This deployment no longer exists.</p>";
    const page = text + "<!--" + " ".repeat(206 - Buffer.byteLength(text) - 7) + "-->";
    expect(Buffer.byteLength(page)).toBe(206);
    runtime.request.mockImplementation(async (url: string) => url === "https://example.com"
      ? new Response(page, { status: 404 })
      : new Response(url.includes("raw.githubusercontent.com") ? "x".repeat(49_467) : "x".repeat(128_001)));
    const collected = await collectActionAuditInput(selected());
    if (collected.kind !== "ready") throw new Error(collected.reason);
    const [pageSource, repository, readme] = collected.input.sources;
    expect(pageSource).toMatchObject({ kind: "page", httpStatus: 404, completeness: "complete", text: "This deployment no longer exists." });
    expect(repository).toMatchObject({ kind: "repository", httpStatus: 200, completeness: "truncated" });
    expect(readme).toMatchObject({ kind: "readme", httpStatus: 200, completeness: "truncated" });
    expect(repository.text).toHaveLength(32_000);
    expect(readme.text).toHaveLength(32_000);
  });

  it("허용한 오류 본문을 읽는 중에도 호출자 abort와 기존 8초 요청 기한을 연결한다", async () => {
    const caller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    runtime.request.mockImplementation(async (_url, init: { signal: AbortSignal }) => new Response(new ReadableStream({
      start(controller) { init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true }); },
    }), { status: 404 }));
    const collected = collectActionAuditInput(selected(), { signal: caller.signal });
    await vi.waitFor(() => expect(runtime.request).toHaveBeenCalledOnce());
    expect(timeout.mock.calls.map(call => call[0])).toEqual([25_000, 8_000]);
    caller.abort();
    expect(await collected).toEqual({ kind: "waiting_evidence", reason: "audit_collection_timeout" });
  });

  it("page 오류 본문 허용 시에도 private redirect에 요청하지 않는다", async () => {
    runtime.request.mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }));
    expect(await collectActionAuditInput(selected())).toEqual(waiting);
    expect(runtime.request).toHaveBeenCalledTimes(1);
  });
});
