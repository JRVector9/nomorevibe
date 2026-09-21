import { expect, it, vi } from "vitest";
import { previewLaya } from "@/lib/crawl/laya-preview";

const subject = { repo: "acme/image-cli", stars: 800, accessMode: "installable" as const,
  name: "ImageCLI", description: "Compress PNG files", readme: "npm install -g image-cli; image-cli input.png", pageText: "" };
const env = { LAYA_URL: "http://127.0.0.1:8010", LAYA_API_KEY: "test-secret-do-not-log" };
const envelope = (yes = .95, choice = "yes") => ({ model: "laya-rl-agent", answers: { software: {
  type: "choice", choice, probabilities: { yes, no: 1 - yes }, confidence: .7,
} }, routing: { model: "english" }, usage: { input_tokens: 120, output_tokens: 0 } });
const response = (body: unknown = envelope(), status = 200) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

it("returns a non-authoritative hint and sends just one software question", async () => {
  const request = response();
  const result = await previewLaya(subject, { env, request });
  expect(result).toMatchObject({ kind: "hint", prefetch: true, softwareProbability: .95, authority: "none" });
  expect(result).not.toHaveProperty("decision");
  const [url, init] = request.mock.calls[0];
  expect(url).toBe("http://127.0.0.1:8010/v1/systemone");
  expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
  const payload = JSON.parse(String(init?.body));
  expect(payload.model).toBe("auto");
  expect(Object.keys(payload.questions)).toEqual(["software"]);
  expect(payload.questions.software.type).toBe("choice");
  expect(Object.keys(payload.questions.software.criteria)).toEqual(["yes", "no"]);
});

it.each([
  { ...subject, stars: 499 }, { ...subject, stars: NaN }, { ...subject, stars: 500.5 },
  { ...subject, accessMode: "website" as const },
])("does not call LAYA outside the installable >=500 scope", async input => {
  const request = response();
  expect(await previewLaya(input, { env, request })).toMatchObject({ kind: "skipped", reason: "outside_scope" });
  expect(request).not.toHaveBeenCalled();
});

it("does not call LAYA without explicit configuration", async () => {
  const request = response();
  expect(await previewLaya(subject, { env: {}, request })).toMatchObject({ kind: "skipped", reason: "not_configured" });
  expect(request).not.toHaveBeenCalled();
});

it.each(["https://user:secret@example.test", "https://example.test?key=secret", "https://example.test/path", "file:///tmp/key", "https://example.test/#x"])("rejects unsafe endpoint shape: %s", async url => {
  const request = response();
  expect(await previewLaya(subject, { env: { ...env, LAYA_URL: url }, request })).toMatchObject({ kind: "skipped", reason: "invalid_config" });
  expect(request).not.toHaveBeenCalled();
});

it("bounds the hint excerpt without changing the full review input", async () => {
  const input = Object.freeze({ ...subject, description: "설명".repeat(3000), readme: "원문".repeat(12000) });
  const before = JSON.stringify(input);
  const request = response();
  expect(await previewLaya(input, { env, request })).toMatchObject({ kind: "hint", truncated: true });
  const payload = JSON.parse(String(request.mock.calls[0][1]?.body));
  expect(JSON.stringify(payload.state).length).toBeLessThan(2500);
  expect(JSON.stringify(input)).toBe(before);
});

it.each([[.8, "yes"], [.05, "no"]])("low/negative signal only disables speculation", async (p, choice) => {
  expect(await previewLaya(subject, { env, request: response(envelope(Number(p), String(choice))) }))
    .toMatchObject({ kind: "hint", prefetch: false, authority: "none" });
});

it.each([
  {}, { answers: {} }, envelope(1.2), envelope(.95, "no"),
  { ...envelope(), answers: { software: { type: "choice", choice: "yes", probabilities: { yes: .95, no: .95 } } } },
])("rejects malformed or inconsistent output", async body => {
  expect(await previewLaya(subject, { env, request: response(body) })).toMatchObject({ kind: "unavailable", reason: "invalid_response" });
});

it.each([[401, "auth"], [403, "auth"], [429, "rate_limited"], [502, "http_error"], [302, "http_error"]])("sanitizes HTTP %i without retries", async (status, reason) => {
  const request = response({ error: env.LAYA_API_KEY }, Number(status));
  const result = await previewLaya(subject, { env, request });
  expect(result).toMatchObject({ kind: "unavailable", reason });
  expect(JSON.stringify(result)).not.toContain(env.LAYA_API_KEY);
  expect(request).toHaveBeenCalledTimes(1);
});

it("rejects a response larger than the cap", async () => {
  const request = response({ junk: "x".repeat(40_000) });
  expect(await previewLaya(subject, { env, request })).toMatchObject({ kind: "unavailable", reason: "invalid_response" });
});

it("times out the response body as well as headers", async () => {
  const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"answers":'));
  } })));
  const start = performance.now();
  expect(await previewLaya(subject, { env, request, timeoutMs: 15 })).toMatchObject({ kind: "unavailable", reason: "timeout" });
  expect(performance.now() - start).toBeLessThan(500);
});

it("honors cancellation and never leaks a thrown transport error", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = response();
  expect(await previewLaya(subject, { env, request, signal: controller.signal })).toMatchObject({ kind: "unavailable", reason: "cancelled" });
  expect(request).not.toHaveBeenCalled();
  expect(await previewLaya(subject, { env, request: async () => { throw new Error(env.LAYA_API_KEY); } }))
    .toMatchObject({ kind: "unavailable", reason: "transport" });
});
