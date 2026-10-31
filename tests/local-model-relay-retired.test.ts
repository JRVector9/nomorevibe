import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelTimeoutMs } from "@/lib/llm/model-registry";
import { createLocalModelRelay } from "@/scripts/local-model-relay/service";
import type { RelayReceiptStore } from "@/scripts/local-model-relay/store";

/**
 * 2026-10-31 · G2: the M1 relay (scripts/local-model-relay, launchd `bot.brut.nmv-llm-relay`) is retired. M1 is reached
 * directly (tailscale serve → mlx_lm.server on 127.0.0.1:8000); no web/worker path goes through the relay.
 *
 * The relay's unknown latch is deliberately left manual (one upstream timeout ⇒ 503 `upstream_indeterminate` until the
 * operator boundary release or a *verified* engine deadline): mlx-lm cannot cancel a generation and has no verified hard
 * bound, so a clock-only auto-clear would put two generations on the single-slot engine and write a false
 * "engine deadline passed" receipt. Instead these tests keep the relay out of the runtime path — if it came back, M1
 * product-translate could stall on that latch independently of the DB ledger. See docs/operations/local-model-private-ingress.md.
 */
const root = path.resolve(__dirname, "..");
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? (name === "node_modules" ? [] : files(full)) : /\.(ts|tsx|mjs|js)$/.test(name) ? [full] : [];
});
const relayImports = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']*local-model-relay\/[^"']+)["']/g)]
  .map(match => match[1]);

describe("retired M1 relay stays out of the runtime path", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("no web, worker or shared library module imports the relay server, forwarder, receipt store or config", () => {
    const runtime = [...files(path.join(root, "lib")), ...files(path.join(root, "app")),
      ...readdirSync(path.join(root, "scripts")).filter(name => name.endsWith(".ts")).map(name => path.join(root, "scripts", name))];
    const found = runtime.flatMap(file => relayImports(file).map(spec => `${path.relative(root, file)} -> ${spec}`));
    // Only the DR proof schema is shared (operator release tooling reads the committed DB release, never the relay process).
    expect(found).toEqual(["lib/operations/dr/provider-boundary-relay.ts -> @/scripts/local-model-relay/boundary-reconcile"]);
  });

  it("no image or compose service launches the relay", () => {
    for (const file of ["Dockerfile", "compose.yml"]) expect(readFileSync(path.join(root, file), "utf8")).not.toContain("local-model-relay");
  });

  it("cannot carry today's M1 product-translate client bound, so re-inserting it would cut and latch long translations", () => {
    expect(modelTimeoutMs("product-translate")).toBeGreaterThan(90_000);
    expect(() => relay({ upstreamTimeoutMs: modelTimeoutMs("product-translate") })).toThrow("relay_invalid_limit");
  });

  it("keeps its unknown latch manual without a verified engine bound — time alone never reopens it", () => {
    vi.useFakeTimers();
    const service = relay();
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(service.relayHealth()).toMatchObject({ indeterminate: true, relayReady: false, engineDeadlineMs: null, lastDeadlineRelease: null });
  });
});

function relay(over: { upstreamTimeoutMs?: number } = {}) {
  const store: RelayReceiptStore = { hasUnsettled: () => true, get: () => null, begin: () => {}, finish: () => {} };
  return createLocalModelRelay({ token: "relay-private-token-" + "a".repeat(40), upstreamToken: "upstream-private-key-" + "b".repeat(40),
    allowFrom: ["127.0.0.1"], model: "mlx-community--gemma-4-26b-a4b-it-4bit", relayRevision: "c".repeat(40), deploymentRevision: "d".repeat(40),
    store, ...over });
}
