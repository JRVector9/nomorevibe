import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/status/source-buffer-actions", () => ({ setSourceBufferAction: vi.fn() }));

import { SourceBufferCard } from "@/app/(operator)/admin/status/SourceBufferCard";
import { ModelRouteContracts } from "@/app/(operator)/admin/status/ModelRouteContracts";
import type { ModelRouteStatus } from "@/lib/operations/model-route-status";

const CSRF = { token: "f".repeat(64), expiresAt: 1 };
const decision = (value: Record<string, unknown>) => ({ value: { mode: "count", measuredAt: "2026-10-18T00:44:02.000Z", R: null, ...value },
  observedAt: "2026-10-18T00:44:02.000Z" });

describe("원본 공급 조절 칸", () => {
  it("기본(꺼짐)·판정 기록 없음을 그대로 말하고 켜기 단추를 둔다", () => {
    const html = renderToStaticMarkup(<SourceBufferCard enabled={false} observation={undefined} csrf={CSRF} />);
    expect(html).toContain("꺼짐(disabled) · 기본값");
    expect(html).toContain("기록 없음 — 켠 뒤 첫 수집 회차에 생깁니다");
    expect(html).toContain("조절 켜기…");
    expect(html).not.toContain("조절 끄기…");
  });

  it("켜져 있으면 마지막 판정(보류·이유·판·DB 시각)을 보이고 끄기 단추를 둔다", () => {
    const html = renderToStaticMarkup(<SourceBufferCard enabled
      observation={decision({ blocked: true, reason: "count_pressure", revision: 12 })} csrf={CSRF} />);
    expect(html).toContain("켜짐(enabled)");
    expect(html).toContain("새 원본 보류(blocked)");
    expect(html).toContain("후단 대기 많음(count_pressure)");
    expect(html).toContain("판(revision) 12");
    expect(html).toContain("2026-10-18 09:44:02 KST");
    expect(html).toContain("조절 끄기…");
    expect(html).not.toContain("켜져 있던 때의 기록");
  });

  it("꺼져 있는데 옛 판정이 남아 있으면 지금은 적용하지 않는다고 적는다", () => {
    const html = renderToStaticMarkup(<SourceBufferCard enabled={false}
      observation={decision({ blocked: false, reason: "ready", revision: 3 })} csrf={CSRF} />);
    expect(html).toContain("새 원본 받음 · 후단 여유(ready)");
    expect(html).toContain("켜져 있던 때의 기록");
  });

  it("판정 기록 모양이 다르면 짐작하지 않는다", () => {
    const html = renderToStaticMarkup(<SourceBufferCard enabled observation={decision({ blocked: "yes" })} csrf={CSRF} />);
    expect(html).toContain("판정 기록을 읽지 못했습니다");
  });

  it("서명 키가 없으면 보기만 한다", () => {
    const html = renderToStaticMarkup(<SourceBufferCard enabled={false} observation={undefined} csrf={null} />);
    expect(html).not.toContain("<button");
    expect(html).toContain("AUTH_SECRET");
  });
});

const STATUS: ModelRouteStatus = {
  at: "2026-10-18T00:44:02.000Z",
  routes: [
    { routeId: "crawl-agent-review", provider: "abcllm", model: "ai1-gw", status: "serving" },
    { routeId: "second-review", provider: "abcllm", model: "ai2-gw", status: "no_contract" },
    { routeId: "product-translate", provider: "abcllm", model: null, status: "unknown" },
    { routeId: "product-audit", provider: "abcllm", model: null, status: "unused" },
  ],
  stages: [
    { stage: "ai1", mode: "legacy", drainingFrom: null, epoch: 1, contract: 1, live: 0, unsettled: 0, legacyJobLive: false, consumers: 0 },
    { stage: "ai2", mode: "draining", drainingFrom: "legacy", epoch: 4, contract: 1, live: 2, unsettled: 1, legacyJobLive: true, consumers: 2 },
  ],
  batch: { mode: "draining", drainingFrom: "legacy", epoch: 2, contract: 1, policy: null, policyHash: null, liveJobs: 0, liveRoles: 0, liveItems: 0, liveSources: 0, liveAgentClaims: 0 },
  capacity: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, oldGeneration: 3 },
};

describe("모델 경로 계약 · 전환 진행 칸", () => {
  it("복제본에서 못 읽었으면 까닭과 함께 보류다 — 표나 0을 그리지 않는다", () => {
    const html = renderToStaticMarkup(<ModelRouteContracts status={{ ok: false, reason: "no_replica" }} />);
    expect(html).toContain("보류 — 복제본 설정이 없습니다");
    expect(renderToStaticMarkup(<ModelRouteContracts status={{ ok: false, reason: "error" }} />)).toContain("보류 — 읽다가 실패했습니다");
    expect(html).toContain("주 DB 로 넘기지 않습니다");
    expect(html).not.toContain("<table");
  });

  it("경로마다 계약 유무를 쉬운 말(코드)로, 단계마다 비우기 진행·소비자 생존을 보인다", () => {
    const html = renderToStaticMarkup(<ModelRouteContracts status={{ ok: true, value: STATUS }} />);
    expect(html).toContain("2026-10-18 09:44:02 KST");
    expect(html).toContain("계약 있음(serving) 1 · 계약 없음(no_contract) 1 · 모름(unknown) 1 · 지금 안 씀(unused) 1");
    expect(html).toContain("crawl-agent-review");
    expect(html).toContain("비우는 중(draining)");
    expect(html).toContain("실행 중");
    expect(html).toContain("2대");
    expect(html).toContain("없음");
    expect(html).toContain("비우기 끝, 전환을 마칠 수 있습니다");
    expect(html).toContain("옛 세대 점유 3");
    // 보기만 한다 — 전환은 운영 CLI 로만
    expect(html).not.toContain("<button");
  });

  it("작업 배치를 비우는 중에 남은 실행이 있으면 마칠 수 없다고 적는다", () => {
    const html = renderToStaticMarkup(<ModelRouteContracts status={{ ok: true, value: { ...STATUS, batch: { ...STATUS.batch, liveJobs: 2 } } }} />);
    expect(html).toContain("모두 0이 되어야 전환을 마칠 수 있습니다");
  });
});
