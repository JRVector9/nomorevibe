import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/operations-schema";
import { DEFAULT_CONFIG, type AgentStatus } from "@/lib/operations/contracts";
import { agentToken } from "@/lib/operations/agent-client";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { ensureSchema } from "../integration/setup";

const key = "service:connect-agent:e2e-codex-reconnect";
let server: Server;
let state: AgentStatus;
let calls: Array<{ action: string; data: Record<string, unknown> }> = [];
let sequence = 0;
let rejectConnect = false;

function initial(): AgentStatus {
  return { connected: true, generation: 1, configVersion: 1, config: DEFAULT_CONFIG,
    busy: null, activity: null, connection: null, verification: null, lastAttempt: null,
    appliedAt: null, lastUsedVersion: null, configReady: true,
    accounts: { codex: { model: DEFAULT_CONFIG.primary.model, result: "access_denied", checkedAt: new Date().toISOString() } } };
}
function login() {
  state.busy = "login";
  state.connection = { id: `login-${++sequence}`, provider: "codex", state: "awaiting_approval",
    expiresAt: Date.now() + 600_000, url: "https://auth.openai.com/codex/device", code: "AAAA-BBBBB" };
}

test.beforeAll(async () => {
  ensureSchema();
  server = createServer(async (req, res) => {
    if (req.url !== "/rpc" || req.headers.authorization !== `Bearer ${agentToken("playwright-operations-agent-secret-32-characters")}`) {
      res.writeHead(401).end(); return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as typeof calls[number];
    calls.push(request);
    if (request.action === "connect") {
      if (rejectConnect) { res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "인증 요청을 처리하지 못했습니다." })); return; }
      login();
    } else if (request.action === "cancel") {
      expect(request.data.id).toBe(state.connection?.id);
      state.busy = null;
      state.connection!.state = "cancelled";
    } else if (request.action !== "status") {
      res.writeHead(400).end(); return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...state, serverNow: Date.now() }));
  });
  await new Promise<void>(resolve => server.listen(43129, "127.0.0.1", resolve));
});
test.afterAll(async () => {
  await db.delete(operationsObservations).where(eq(operationsObservations.key, key));
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
test.beforeEach(async ({ context, baseURL }) => {
  calls = []; sequence = 0; rejectConnect = false; state = initial();
  await db.insert(operationsObservations).values({ key, value: { ...state }, observedAt: new Date() })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { value: { ...state }, observedAt: new Date() } });
  await context.addCookies([{ name: SESSION_COOKIE, value: await signSession("playwright-admin", "playwright-auth-secret-with-at-least-32-characters"),
    url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
});

test("오류 칩 클릭에서만 Codex 인증을 시작하고 승인 완료를 자동 표시한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/status");
  const button = page.getByRole("button", { name: "Codex 연결 access_denied · 다시 인증", exact: true });
  await expect(button).toBeVisible();
  expect(calls).toEqual([]);
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(await button.evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(13);
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Codex 다시 인증", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("AAAA-BBBBB", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "공식 인증 페이지 열기 ↗", exact: true }))
    .toHaveAttribute("href", "https://auth.openai.com/codex/device");
  expect(calls.filter(c => c.action === "connect")).toEqual([{ action: "connect", data: { provider: "codex" } }]);
  state.connection!.state = "stored"; state.busy = null; state.generation++; state.configReady = false;
  state.accounts = { codex: { storedAt: new Date().toISOString() } };
  await expect(dialog.getByText("인증 저장 완료", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "모델 검사·적용으로 이동", exact: true })).toHaveAttribute("href", "/admin/status?tab=ai");
  expect(calls.some(c => ["probe", "test", "apply", "classify"].includes(c.action))).toBe(false);
});

test("기존 Codex 인증 대기를 이어 열고 취소·만료 뒤에는 새 인증을 요청한다", async ({ page }) => {
  login();
  await page.goto("/admin/status");
  await page.getByRole("button", { name: "Codex 연결 access_denied · 다시 인증", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Codex 다시 인증", exact: true });
  await expect(dialog.getByText("AAAA-BBBBB", { exact: true })).toBeVisible();
  expect(calls.filter(c => c.action === "connect")).toEqual([]);
  await dialog.getByRole("button", { name: "인증 취소", exact: true }).click();
  await expect(dialog.getByText("인증 취소됨", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "새 인증 시작", exact: true }).click();
  await expect.poll(() => calls.filter(c => c.action === "connect").length).toBe(1);
  state.busy = null; state.connection!.state = "expired";
  await expect(dialog.getByText("인증 시간 만료", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "새 인증 시작", exact: true }).click();
  await expect.poll(() => calls.filter(c => c.action === "connect").length).toBe(2);
});

test("진행 중인 분류와 요청 실패를 숨기지 않고 다시 시도할 수 있다", async ({ page }) => {
  state.busy = "classification";
  await page.goto("/admin/status");
  await page.getByRole("button", { name: "Codex 연결 access_denied · 다시 인증", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Codex 다시 인증", exact: true });
  await expect(dialog.getByText("다른 AI 작업이 진행 중입니다. 완료 후 다시 인증해주세요.", { exact: true })).toBeVisible();
  expect(calls.filter(c => c.action === "connect")).toEqual([]);
  state.busy = null; rejectConnect = true;
  await expect(dialog.getByRole("button", { name: "새 인증 시작", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "새 인증 시작", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("인증 요청을 처리하지 못했습니다.");
  rejectConnect = false;
  await dialog.getByRole("button", { name: "새 인증 시작", exact: true }).click();
  await expect(dialog.getByText("AAAA-BBBBB", { exact: true })).toBeVisible();
});
