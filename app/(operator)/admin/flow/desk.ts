import "server-only";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlPublicationChanges, operationsAudit } from "@/lib/db/schema";
import { sharedStore } from "@/lib/cache/shared";
import { getSettings } from "@/lib/crawl/settings";
import { logger } from "@/lib/observability/logger";
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import { deviceServer, leaseHost } from "@/lib/operations/admin-models-view";
import { sharedInbox } from "@/lib/operations/inbox";
import { capacityMonitorThresholds, readModelCapacityUnknowns } from "@/lib/operations/model-capacity-unknowns";
import { modelServerHealth } from "@/lib/operations/model-servers";
import { awaySince, CHANGE_ACTIONS, deskChange, deskDevices, deskRole, type DeskAlert, type OperatorDesk } from "@/lib/operations/operator-desk-model";
import { roleOverview } from "@/lib/operations/roles";
import { sharedLoader } from "@/lib/operations/shared-cache";
import { actionLabel } from "../activity/labels";
import { assembleInbox } from "../inbox/inbox-model";
import { REASON_LABELS } from "../reasons";
import { buildActions, deriveStatus, loadActionInputs, rememberCriticalCount } from "../status/attention";
import { sortActions } from "../status/dashboard/AttentionList";

/**
 * 전체 흐름의 운영자 책상 읽기 — 이미 있는 읽기만 모은다(운영센터 조치 buildActions · 오늘 할 일 sharedInbox · 모델 장부 관측 ·
 * 장부 경보 readModelCapacityUnknowns · 역할 lease roleOverview · 작업 로그). 새로 세는 것은 작업 로그 몇 줄과 부재 중의 수 둘뿐이다.
 *
 * 칸마다 따로 실패한다(그 칸만 null — 화면은 "읽지 못함"이라고 쓰고 0 으로 보이지 않는다). 공통 부분은 웹들이 15초 나눠 쓴다.
 * 15초가 지났어도 2분 안의 값이면 기다리지 않고 그 값(관측 시각 measuredAt 이 함께 보인다)을 주며 뒤에서 다시 센다(conveyor.ts 와 같다).
 * 조치 목록은 운영센터 배지와 같은 수를 남긴다(rememberCriticalCount) — 흐름을 열어 둔 동안 배지가 한 번 더 세지 않는다.
 */
const shared = sharedLoader<Omit<OperatorDesk, "away">>({ namespace: "admin:desk:v1", ttlMs: 15_000, staleMs: 120_000, store: sharedStore });

const quiet = <T,>(event: string) => (error: unknown): T | null => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

async function readAlerts(): Promise<OperatorDesk["alerts"]> {
  const inputs = await loadActionInputs(await getSettings());
  const items = sortActions(buildActions(inputs, deriveStatus(inputs)));
  const critical = rememberCriticalCount(items);
  return {
    critical, hold: items.filter((item) => item.tone === "hold").length,
    items: items.filter((item) => item.tone !== "clear").slice(0, 8).map((item): DeskAlert => ({
      key: item.key, tone: item.tone, title: item.title, count: typeof item.count === "number" ? `${item.count.toLocaleString("ko-KR")}${item.unit === "상태" ? "" : item.unit}` : item.count,
      href: item.action?.href ?? null, actionLabel: item.action?.label ?? null })),
  };
}

async function readDecisions(): Promise<OperatorDesk["decisions"]> {
  const snapshot = await sharedInbox();
  const inbox = assembleInbox(snapshot.results, snapshot.done);
  return {
    remaining: inbox.remaining, failed: inbox.failed, done: inbox.done,
    items: inbox.sections.filter((section) => section.state === "work").map((section) => ({
      key: section.key, title: section.title, hint: section.hint, count: section.data!.count, tone: section.tone,
      href: section.href, action: section.action, oldestAt: section.data!.items[0]?.since ?? null })),
    // 「모두 보기」 서랍 — 예전 오늘 할 일 화면(InboxCard)이 그리던 것 그대로. 심사 후보의 why 는 사유 코드라 사람 말로 바꾼다
    sections: inbox.sections.map((section) => ({
      key: section.key, title: section.title, hint: section.hint, href: section.href, action: section.action, tone: section.tone,
      count: section.data?.count ?? null, note: section.data?.note ?? null,
      rows: (section.data?.items ?? []).map((item) => ({ id: item.id, name: item.name, since: item.since,
        why: section.key === "human" ? REASON_LABELS[item.why] ?? (item.why || "사유 없음") : item.why })) })),
    clear: inbox.clear.map((section) => ({ key: section.key, title: section.title, href: section.href })),
  };
}

async function readChanges(): Promise<OperatorDesk["changes"]> {
  const rows = await db.select({ id: operationsAudit.id, createdAt: operationsAudit.createdAt, actor: operationsAudit.actor, action: operationsAudit.action,
    target: operationsAudit.target, ok: operationsAudit.ok }).from(operationsAudit)
    .where(inArray(operationsAudit.action, CHANGE_ACTIONS)).orderBy(desc(operationsAudit.id)).limit(8);
  return rows.map((row) => deskChange({ ...row, createdAt: row.createdAt.toISOString() }, actionLabel));
}

type Observation = Awaited<ReturnType<typeof readAdminModelsObservation>>;

async function readEquipment(read: Promise<Observation>): Promise<OperatorDesk["equipment"]> {
  const thresholds = capacityMonitorThresholds();
  const [observation, report, servers] = await Promise.all([
    read,
    readModelCapacityUnknowns(thresholds).catch(() => null),
    modelServerHealth().catch(() => []),
  ]);
  const now = observation.observedAt ?? new Date().toISOString();
  const known = report && report.status !== "unknown" ? report : null;
  return {
    observedAt: observation.observedAt,
    devices: deskDevices(observation.groups, observation.requests, now, thresholds.dispatchStuckSeconds, (id) => deviceServer(id, []).name),
    ledger: { status: known?.status ?? "unknown", reasons: known ? [...known.alarmReasons] : [], stuckDispatched: known?.stuckDispatched ?? 0,
      reviewCount: known?.count ?? 0, oldestAgeSeconds: known?.oldestAgeSeconds ?? null, stuckThresholdSeconds: thresholds.dispatchStuckSeconds },
    servers,
  };
}

async function readWindow(read: Promise<Observation>): Promise<OperatorDesk["window"]> {
  const [observation, roles] = await Promise.all([read.catch(() => null), roleOverview()]);
  return {
    admission: observation?.mode ?? null, admissionSince: observation?.controlUpdatedAt ?? null,
    roles: roles.roles.map((role) => deskRole({ role: role.role, reason: role.reason, host: leaseHost(role.ownerInstanceId) })),
    schedulerAlarm: roles.scheduler.alarm,
  };
}

async function loadShared(): Promise<Omit<OperatorDesk, "away">> {
  // 장부 관측(주 DB, 4초 기한)은 한 번만 읽어 장비·점검 창이 같이 쓴다. 못 읽으면 error 가 찬 관측이 온다 — 0 으로 보이지 않게 아래에서 거른다
  const observation = readAdminModelsObservation({ throughput: false }).then((value) => { if (value.error) throw new Error("observation_unavailable"); return value; });
  const [alerts, decisions, changes, equipment, window] = await Promise.all([
    readAlerts().catch(quiet<OperatorDesk["alerts"]>("desk.alerts_unavailable")),
    readDecisions().catch(quiet<OperatorDesk["decisions"]>("desk.decisions_unavailable")),
    readChanges().catch(quiet<OperatorDesk["changes"]>("desk.changes_unavailable")),
    readEquipment(observation).catch(quiet<OperatorDesk["equipment"]>("desk.equipment_unavailable")),
    readWindow(observation).catch(quiet<OperatorDesk["window"]>("desk.window_unavailable")),
  ]);
  return { measuredAt: new Date().toISOString(), alerts, decisions, changes, equipment, window };
}

/** 부재 중 — 관리자마다 다르다(나눠 쓰지 않는다). SELECT 넷, 문장별 3초 상한. */
async function readAway(login: string, now: string): Promise<OperatorDesk["away"]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    const [mine] = await tx.select({ at: sql<Date | null>`max(${operationsAudit.createdAt})`.mapWith(operationsAudit.createdAt) })
      .from(operationsAudit).where(eq(operationsAudit.actor, login));
    const window = awaySince(now, mine?.at ? mine.at.toISOString() : null);
    const since = new Date(window.since);
    const [published] = await tx.select({ n: sql<number>`count(*)::int` }).from(crawlPublicationChanges)
      .where(and(gt(crawlPublicationChanges.occurredAt, since), gt(crawlPublicationChanges.delta, 0)));
    const [holds] = await tx.select({ n: sql<number>`count(*)::int` }).from(crawlCandidates)
      .where(and(eq(crawlCandidates.state, "needs_review"), gt(crawlCandidates.updatedAt, since)));
    const others = await tx.select({ id: operationsAudit.id, createdAt: operationsAudit.createdAt, actor: operationsAudit.actor, action: operationsAudit.action,
      target: operationsAudit.target, ok: operationsAudit.ok }).from(operationsAudit)
      .where(and(inArray(operationsAudit.action, CHANGE_ACTIONS), gt(operationsAudit.createdAt, since), ne(operationsAudit.actor, login)))
      .orderBy(desc(operationsAudit.id)).limit(6);
    return { ...window, myLogin: login, published: Number(published?.n ?? 0), newHolds: Number(holds?.n ?? 0),
      othersChanges: others.map((row) => deskChange({ ...row, createdAt: row.createdAt.toISOString() }, actionLabel)) };
  }, { accessMode: "read only" });
}

export async function readOperatorDesk(login: string, fresh = false): Promise<OperatorDesk> {
  const base = await readOperatorDeskShared(fresh);
  const away = await readOperatorAway(login, base.measuredAt);
  return { ...base, away };
}

/** Shared display data only; the operator-specific away query never enters this cache. */
export function readOperatorDeskShared(fresh = false): Promise<Omit<OperatorDesk, "away">> {
  return shared("desk", loadShared, fresh);
}

export function readOperatorAway(login: string, measuredAt: string): Promise<OperatorDesk["away"]> {
  return readAway(login, measuredAt).catch(quiet<OperatorDesk["away"]>("desk.away_unavailable"));
}

/** The changes tab needs audit rows and this operator's window, not the live operations fan-out. */
export async function readOperatorChanges(login: string): Promise<OperatorDesk> {
  const measuredAt = new Date().toISOString();
  const [changes, away] = await Promise.all([
    readChanges().catch(quiet<OperatorDesk["changes"]>("desk.changes_unavailable")),
    readOperatorAway(login, measuredAt),
  ]);
  return { measuredAt, alerts: null, decisions: null, equipment: null, window: null, changes, away };
}

/** Diagnostics displays role ownership/admission; inbox, alerts and personal history belong elsewhere. */
export async function readOperatorDiagnostics(): Promise<OperatorDesk> {
  const window = await readWindow(readAdminModelsObservation({ throughput: false }));
  return { measuredAt: new Date().toISOString(), alerts: null, decisions: null, equipment: null, changes: null, away: null, window };
}
