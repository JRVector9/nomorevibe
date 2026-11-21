import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { resetConnectionKeyFillGateForTest, setConnectionKeyFillDepsForTest } from "@/lib/operations/ai-connection-key-fill";
import { servingContractHash, validateAdminServingContract } from "@/lib/operations/admin-serving-contracts";
import { sealSecret, servingContractKeyAad } from "@/lib/security/secret-box";
import { abcllmContract } from "../total-bound-direct-fixture";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 계약 모양 견줌(scripts/ops/contract-shape-compare.ts)은 DB 에 쓰지 않고, dry-run 은 엔진을 부르지 않는다 — 진짜 PostgreSQL(자기 DB, 끝까지 migrate)로 본다.
 * 연결 키 채우기가 일어날 상황을 일부러 만든다: 순위가 가리키는 키 없는 API 연결 + 같은 주소에 키를 저장한 abcllm 계약 + 암호 상자 키(PR #1025 리뷰의 재현).
 * 그 상태에서 실제 deps(운영 길)로 dry-run 과 --execute 를 돌리고, 모든 public 표의 쓰기 수(statement 트리거가 세는 sequence — 되돌려진 쓰기도 센다)·
 * ai_connections 판·operations_audit 줄 수가 그대로인지, 네트워크는 실행의 채팅 호출뿐인지 본다. 마지막에 같은 상황이 범위 밖에서는 정말 채우기를
 * 일으킨다는 것(시험이 헛돌지 않음)을 확인한다. 키는 모두 가짜다.
 */
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "operator" }), localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const name = `nomorevibe_test_shape_compare_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const pgAdmin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 6, prepare: false, onnotice: () => {} });
let created = false;
const M3 = "http://m3.test:8100/v1", FAKE_KEY = "test-fake-contract-key-1", MODEL = "fixture-model";
const keyFillCalls: string[] = [], chatCalls: { url: string; auth: string | null }[] = [];

beforeAll(async () => {
  await pgAdmin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(path.resolve("."), "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  // 모든 public 표의 쓰기(INSERT·UPDATE·DELETE·TRUNCATE)를 statement 마다 센다 — sequence 는 트랜잭션이 되돌려져도 오른다
  await client.unsafe(`CREATE SEQUENCE shape_compare_writes;
    CREATE FUNCTION shape_compare_count_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('shape_compare_writes'); RETURN NULL; END $$;
    DO $$ DECLARE t record; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('CREATE TRIGGER shape_compare_count AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION shape_compare_count_write()', t.tablename);
      END LOOP; END $$;`);
}, 180_000);
afterAll(async () => {
  setConnectionKeyFillDepsForTest(null); setServingContractSnapshotForTest(null);
  const { setAiTaskModelsForTest } = await import("@/lib/llm/ai-task-models-snapshot");
  setAiTaskModelsForTest(null);
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await client.end({ timeout: 3 });
  if (created) await pgAdmin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await pgAdmin.end({ timeout: 3 });
});

const writes = async () => {
  const [row] = await client<{ last_value: string; is_called: boolean }[]>`SELECT last_value::text, is_called FROM shape_compare_writes`;
  return row.is_called ? Number(row.last_value) : 0;
};
const connectionRow = async (id: string) => (await client<{ has_key: boolean; version: number; updated_by: string }[]>`
  SELECT api_key_ciphertext IS NOT NULL AS has_key, version::int, updated_by FROM ai_connections WHERE id = ${id}`)[0];
const auditCount = async () => Number((await client<{ n: string }[]>`SELECT count(*)::text AS n FROM operations_audit`)[0].n);
const reply = () => new Response(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", created: 1, model: "served-fixture",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ keywords_en: ["expense tracker"], keywords_ko: ["가계부"] }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }), { status: 200, headers: { "Content-Type": "application/json" } });

describe("contract shape compare against a real database", () => {
  it("performs zero DB writes and zero side network calls (no connection-key fill) in dry-run and execute", async () => {
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.stubEnv("DB_POOLER_MODE", "direct");
    vi.stubEnv("NMV_SECRET_BOX_KEY", randomBytes(32).toString("base64"));
    resetConnectionKeyFillGateForTest();
    setConnectionKeyFillDepsForTest({ request: (async (input: RequestInfo | URL) => { keyFillCalls.push(String(input));
      return Response.json({ data: [{ id: MODEL }] }); }) as typeof fetch });
    const globalFetch = vi.spyOn(globalThis, "fetch");

    // 순위가 가리키는 키 없는 API 연결 + 같은 주소에 키를 저장한 abcllm 계약 — 범위 밖의 순위 다시 읽기라면 키 채우기가 돈다
    const contract = validateAdminServingContract("product-search-profile", abcllmContract("product-search-profile", { model: MODEL, endpoint: `${M3}/chat/completions` }));
    if (!contract.ok) throw new Error(contract.reason);
    await client`INSERT INTO model_serving_contracts (route_id, model, contract, contract_hash, auth, api_key_ciphertext, transport, enabled, updated_by)
      VALUES ('product-search-profile', ${MODEL}, ${JSON.stringify(contract.contract)}::jsonb, ${servingContractHash(contract.contract)}, 'stored',
        ${sealSecret(FAKE_KEY, servingContractKeyAad("product-search-profile", MODEL))}, 'direct', true, 'test')`;
    const connection = randomUUID();
    await client`INSERT INTO ai_connections (id, label, kind, base_url, api_key_ciphertext, device_id, enabled, updated_by)
      VALUES (${connection}, 'm3-mlx', 'api', ${M3}, NULL, 'm3-mlx', true, 'test')`;
    await client`INSERT INTO ai_task_models (task, slot, rank, connection_id, model, updated_by) VALUES ('product-search-profile', 1, 1, ${connection}, ${MODEL}, 'test')`;
    // 표본 하나(오류 없이 키워드를 지은 공개 제품)
    const [product] = await client<{ id: number }[]>`INSERT INTO products (slug, url, name, tagline, description, category, status, search_page_text, search_readme,
        verify_token, edit_token_hash)
      VALUES ('ledger-smoke', 'https://ledger-smoke.example', 'Ledger Smoke', 'Track expenses', 'Track expenses and budgets in one place.', 'finance', 'verified',
        'A budgeting app page', '# Ledger', 'smoke-token', 'smoke-edit') RETURNING id`;
    await client`INSERT INTO product_search_profiles (product_id, keywords_en, keywords_ko, model, source_hash)
      VALUES (${product.id}, '["budget app"]'::jsonb, '["가계부"]'::jsonb, ${MODEL}, ${"0".repeat(64)})`;

    const [{ runContractShapeCompare }, { createShapeCompareDeps }] = await Promise.all([import("@/scripts/ops/contract-shape-compare"),
      import("@/lib/operations/contract-shape-compare-run")]);
    const send = (async (input: string, init: RequestInit) => { chatCalls.push({ url: String(input), auth: new Headers(init.headers).get("authorization") });
      return reply(); }) as unknown as NonNullable<NonNullable<Parameters<typeof createShapeCompareDeps>[0]>["fetch"]>;
    const floorWrites = await writes(), floorAudit = await auditCount(), before = await connectionRow(connection);
    expect(before).toMatchObject({ has_key: false, version: 1 });

    // dry-run — 순위 밖 계약(연결 키 없음)이라 --model 로 콕 집는다
    const out: string[] = [];
    expect(await runContractShapeCompare(["--route=product-search-profile", `--model=${MODEL}`], line => out.push(line), line => out.push(`ERR ${line}`),
      createShapeCompareDeps({ fetch: send }))).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("dry-run(부르지 않음)");
    expect(text).toContain(`계약 ${MODEL} @ m3.test:8100`);
    expect(text).toContain(`표본: product:${product.id}`);
    expect(text).toContain("미리 보기");
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect(await writes()).toBe(floorWrites);
    expect(await auditCount()).toBe(floorAudit);
    expect(await connectionRow(connection)).toEqual(before);
    expect(keyFillCalls).toEqual([]); expect(chatCalls).toEqual([]); expect(globalFetch).not.toHaveBeenCalled();

    // --execute — 엔진(가짜)에는 채팅 두 번만, DB 쓰기·키 채우기는 여전히 없다
    out.length = 0;
    expect(await runContractShapeCompare(["--route=product-search-profile", `--model=${MODEL}`, "--samples=1", "--execute"], line => out.push(line),
      line => out.push(`ERR ${line}`), createShapeCompareDeps({ fetch: send }))).toBe(0);
    expect(out.join("\n")).toContain("일치 1/1");
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect(chatCalls).toEqual([{ url: `${M3}/chat/completions`, auth: `Bearer ${FAKE_KEY}` }, { url: `${M3}/chat/completions`, auth: `Bearer ${FAKE_KEY}` }]);
    expect(await writes()).toBe(floorWrites);
    expect(await auditCount()).toBe(floorAudit);
    expect(await connectionRow(connection)).toEqual(before);
    expect(keyFillCalls).toEqual([]); expect(globalFetch).not.toHaveBeenCalled();
    expect(await client`SELECT 1 FROM model_capacity_requests`).toHaveLength(0);

    // 시험이 헛돌지 않음: 같은 상황에서 범위 밖의 순위 다시 읽기는 정말 키를 채운다(쓰기·감사·GET /models) — 그래서 위의 0 은 범위 덕분이다
    const { ensureAiTaskModels } = await import("@/lib/llm/ai-task-models-snapshot");
    setServingContractSnapshotForTest(null);
    resetConnectionKeyFillGateForTest();
    await ensureAiTaskModels(0);
    await vi.waitFor(async () => expect((await connectionRow(connection)).has_key).toBe(true), { timeout: 15_000, interval: 100 });
    expect(keyFillCalls).toEqual([`${M3}/models`]);
    expect(await writes()).toBeGreaterThan(floorWrites);
    expect(await auditCount()).toBe(floorAudit + 1);
  }, 120_000);
});
