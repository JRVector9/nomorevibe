import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getEvidenceAdminProduct } from "@/lib/domain/evidence/admin";
import { Panel } from "@/components/Panel";
import { AdminNav } from "../../AdminNav";
import { ForceRefreshForm, UpdateVisibilityForm } from "./EvidenceProductActions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "제품 근거 — NoMoreVibe", robots: { index: false } };

type Props = { params: Promise<{ slug: string }> };

function date(value: Date | null): string {
  return value?.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) ?? "—";
}

function factList(facts: Awaited<ReturnType<typeof getEvidenceAdminProduct>> extends infer View
  ? View extends { sources: Array<{ facts: infer Facts }> } ? Facts : never
  : never) {
  if (!facts) return "관측 사실 없음";
  return Object.entries(facts)
    .filter((entry): entry is [string, string | number] => entry[1] !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(" · ") || "관측 사실 없음";
}

export default async function AdminEvidenceProductPage({ params }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const { slug } = await params;
  const view = await getEvidenceAdminProduct(slug);
  if (!view) notFound();

  return (
    <main className="mx-auto max-w-[980px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">{view.product.name}</h1>
        <span className="font-mono text-[13px] text-fg-3">{view.product.slug}</span>
        <span className="text-[13px] font-semibold text-fg-2">{view.product.status}</span>
        <div className="ml-auto"><AdminNav current="/admin/products" /></div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-[13px]">
        <a href={view.product.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
          {view.product.url}
        </a>
        <a href={`/p/${view.product.slug}`} target="_blank" rel="noreferrer noopener" className="font-semibold text-fg-2 hover:text-fg">
          공개 화면
        </a>
      </div>
      <div className="mt-5"><ForceRefreshForm slug={view.product.slug} /></div>

      <div className="mt-6 flex flex-col gap-4">
        <Panel title="메이커와 관측값 충돌" note="메이커 제공값을 숨기지 않고 객관적 출처의 값과 나란히 봅니다.">
          {view.conflicts.length === 0 ? (
            <p className="text-[13px] text-fg-3">확인된 충돌이 없습니다.</p>
          ) : view.conflicts.map((conflict) => (
            <div key={conflict.field} className="rounded-[10px] border border-down/30 bg-down/5 p-3 text-[13px]">
              <strong>라이선스 충돌</strong>
              <span className="ml-3 text-fg-2">메이커 {conflict.makerValue} · 관측 {conflict.observedValue}</span>
            </div>
          ))}
        </Panel>

        <Panel title="선언 링크" note="메이커 선언과 확인된 연결 상태를 분리합니다.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-[13px]">
              <thead className="text-left text-fg-3"><tr><th className="pb-2">종류</th><th>선언</th><th>확인</th><th>관계</th><th>URL</th></tr></thead>
              <tbody>{view.links.map((link) => (
                <tr key={link.id} className="border-t border-line">
                  <td className="py-2">{link.kind}</td><td>{link.declarationSource}</td><td>{link.verificationState}</td>
                  <td>{link.relationshipState ?? "—"}</td><td className="max-w-[360px] truncate">{link.url}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Panel>

        <Panel title="외부 출처 상태" note="원문 응답 대신 정규화한 사실과 안전한 실패 코드만 표시합니다.">
          {view.sources.length === 0 ? <p className="text-[13px] text-fg-3">아직 수집한 출처가 없습니다.</p> : (
            <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-[13px]">
              <thead className="text-left text-fg-3"><tr><th className="pb-2">출처</th><th>상태</th><th>마지막 성공</th><th>마지막 실패</th><th>다음 시도</th><th>시도</th><th>오류</th></tr></thead>
              <tbody>{view.sources.map((source) => (
                <tr key={source.id} className="border-t border-line align-top">
                  <td className="py-2"><strong>{source.kind}</strong><p className="mt-1 text-fg-3">{factList(source.facts)}</p></td>
                  <td>{source.state}</td><td>{date(source.lastSuccessAt)}</td><td>{date(source.lastFailureAt)}</td>
                  <td>{date(source.nextAttemptAt)}</td><td>{source.attempts}</td><td>{source.lastErrorCode ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Panel>

        <Panel title="내부 미디어" note="외부 URL 선언과 내부 복사본 버전을 함께 봅니다.">
          <div className="grid gap-3 md:grid-cols-2">
            <div><h3 className="text-[13px] font-bold">수집 선언</h3><ul className="mt-2 space-y-2 text-[13px]">
              {view.declarations.map((item) => <li key={item.id} className="rounded-[10px] bg-bg-soft p-3">#{item.position + 1} · rev {item.revision}<br />{item.sourceUrl}</li>)}
            </ul></div>
            <div><h3 className="text-[13px] font-bold">복사본 버전</h3><ul className="mt-2 space-y-2 text-[13px]">
              {view.media.map((item) => <li key={item.id} className="rounded-[10px] bg-bg-soft p-3">v{item.version} · {item.current ? "현재" : "이전"} · {item.visible ? "표시" : "숨김"}{item.missingAt ? " · 원본 누락" : ""}<br />{item.sourceUrl}</li>)}
            </ul></div>
          </div>
        </Panel>

        <Panel title="업데이트" note="자동 감지 항목만 관리자가 숨기고 복원합니다. 메이커 항목은 메이커 API가 관리합니다.">
          <ul className="space-y-3 text-[13px]">{view.updates.map((update) => (
            <li key={update.id} className="rounded-[10px] border border-line p-3">
              <div className="flex flex-wrap gap-2"><strong>{update.title}</strong><span className="text-fg-3">{update.sourceKind} · {update.visible ? "표시" : "숨김"}</span></div>
              {update.sourceKind !== "maker" && <UpdateVisibilityForm slug={view.product.slug} updateId={update.id} visible={update.visible} />}
            </li>
          ))}</ul>
        </Panel>

        <Panel title="빌드 출처" note="표시된 근거 수준은 작성 주체와 증명 강도를 구분합니다.">
          <div className="grid gap-4 md:grid-cols-2 text-[13px]">
            <div><h3 className="font-bold">에이전트</h3><ul className="mt-2 space-y-1">{view.agents.map((agent) => <li key={agent.id}>{agent.provider} · {agent.roles.join(", ")} · {agent.evidenceLevel}</li>)}</ul></div>
            <div><h3 className="font-bold">스킬</h3><ul className="mt-2 space-y-1">{view.skills.map((skill) => <li key={skill.id}>{skill.namespace}/{skill.name} · {skill.evidenceLevel}</li>)}</ul></div>
          </div>
        </Panel>

        <Panel title="감사 기록" note="이력은 수정하거나 지우지 않고 새 행으로 추가합니다.">
          <ul className="space-y-2 text-[13px]">{view.audits.map((audit) => (
            <li key={audit.id} className="grid gap-1 rounded-[10px] bg-bg-soft p-3 sm:grid-cols-[1fr_auto]">
              <span><strong>{audit.action}</strong> · {audit.actor}{audit.reason ? ` · ${audit.reason}` : ""}</span>
              <time className="font-mono text-fg-3">{date(audit.createdAt)}</time>
            </li>
          ))}</ul>
        </Panel>
      </div>
    </main>
  );
}
