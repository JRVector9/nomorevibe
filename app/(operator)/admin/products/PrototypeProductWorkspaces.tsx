import Link from "next/link";
import { createHmac } from "node:crypto";
import { authSecret } from "@/lib/auth/admin";
import { productAuditOverview, listHeldFindings } from "@/lib/crawl/product-audit";
import { productTranslationAdminQueue, productTranslationAdminSummary } from "@/lib/domain/products/translation-admin";
import { formatDetailTime } from "@/lib/format/time";
import { PageStamp } from "../components/PageStamp";
import { TranslationRetryForm } from "../translations/TranslationRetryForm";
import { PrototypeEmpty, PrototypePanel, PrototypeStat, PrototypeTag, n } from "./PrototypeParts";

export async function PrototypeQualityWorkspace() {
  const [overview, held] = await Promise.all([productAuditOverview().catch(() => null), listHeldFindings({ limit: 25, offset: 0 }).catch(() => null)]);
  return <main><PageStamp /><div className="page-heading"><div className="heading-actions"><Link className="button small" href="/admin/products/recheck">규칙 재검수</Link><Link className="button small" href="/admin/audit?tab=audit">AI 감사·정책 관리</Link></div></div>
    <div className="grid four mb"><PrototypeStat label="감사 진행" value={overview ? overview.campaign ? ({running:"진행 중",done:"완료",completed:"완료",cancelled:"중단됨"})[overview.campaign.status] ?? "상태 확인" : "진행 없음" : "—"} note="현재 감사 원본 기준" /><PrototypeStat label="보류 프로젝트" value={n(overview?.held)} note="현재 공개 목록 보류" tone="warn" /><PrototypeStat label="공개분 2차" value="별도 큐" note="후보 심사와 독립" /><PrototypeStat label="검사 종류" value="4종" note="AI 감사·2차·규칙·생존" /></div>
    <PrototypePanel title="품질 확인이 필요한 프로젝트" actions={<Link className="text-button" href="/admin/audit?view=held">전체 보류 큐 →</Link>} note="현재 공개 목록에서 보류된 프로젝트를 원본 상태와 함께 확인합니다.">
      {held === null ? <PrototypeEmpty>품질 큐를 읽지 못했습니다.</PrototypeEmpty> : <div className="table-scroll"><table style={{ minWidth: 780 }}><thead><tr><th>프로젝트</th><th>검사 종류</th><th>원본 상태</th><th>다음 행동</th></tr></thead><tbody>{held.map(row => <tr key={row.slug}><td><Link className="name" href={`/admin/products/${row.slug}?section=quality`}>{row.name}</Link></td><td>AI 감사 보류</td><td><PrototypeTag tone="amber">사람 확인</PrototypeTag></td><td><Link className="button small" href={`/admin/audit?view=held&q=${encodeURIComponent(row.slug)}`}>근거 비교·결정</Link></td></tr>)}</tbody></table>{held.length === 0 && <PrototypeEmpty>현재 보류된 프로젝트가 없습니다.</PrototypeEmpty>}</div>}
    </PrototypePanel><div className="grid two mt"><PrototypePanel title="공개분 추가 확인"><p className="small muted">공개된 프로젝트에 대한 두 번째 의견과 유지 기한을 확인합니다.</p><div className="decision-bar"><Link className="button" href="/admin/review?second=published">공개분 2차 확인</Link><Link className="button" href="/admin/audit?tab=audit">감사 정책·의견·이력</Link></div></PrototypePanel><PrototypePanel title="생존·저장소 확인"><p className="small muted">응답 없음과 저장소 소실은 서로 다른 실제 관측입니다.</p><div className="decision-bar"><Link className="button" href="/admin/products?filter=응답%20없음">생존 확인</Link><Link className="button" href="/admin/products?filter=저장소%20사라짐">저장소 확인</Link></div></PrototypePanel></div>
  </main>;
}

export async function PrototypeTranslationsWorkspace({ admin, query }: { admin: { login: string; exp: number }; query: string }) {
  const [summary, queue] = await Promise.all([productTranslationAdminSummary().catch(() => null), productTranslationAdminQueue({ state: "failed", q: query, limit: 20 }).catch(() => null)]);
  const secret = authSecret();
  const csrfToken = secret ? createHmac("sha256", secret).update(`product-translation-admin:${admin.login}:${admin.exp}`).digest("hex") : null;
  const totals = summary?.reduce((all, row) => ({ pending: all.pending + row.pending, ready: all.ready + row.ready, failed: all.failed + row.failed, held: all.held + row.held }), { pending: 0, ready: 0, failed: 0, held: 0 });
  return <main><PageStamp /><div className="page-heading"><div className="heading-actions"><Link className="button small" href="/admin/translations">언어·원문별 전체 관리</Link></div></div>
    <div className="grid four mb"><PrototypeStat label="처리 대기" value={n(totals?.pending)} note="언어·항목별 수요 기록" /><PrototypeStat label="번역 저장됨" value={n(totals?.ready)} note="실제 공개에는 원문 일치 필요" tone="good" /><PrototypeStat label="실패" value={n(totals?.failed)} note="소진·재시도 대기 포함" tone="warn" /><PrototypeStat label="현재 보류" value={n(totals?.held)} note="현재 공개·소개 조건 기준" /></div>
    <PrototypePanel title="언어별 후처리 상태" note="프로젝트 수가 아닌 언어·항목별 작업 수입니다.">{summary === null ? <PrototypeEmpty>번역 집계를 읽지 못했습니다.</PrototypeEmpty> : <div className="table-scroll"><table><thead><tr><th>언어 / 항목</th><th>대기</th><th>저장됨</th><th>실패</th><th>최근 저장</th></tr></thead><tbody>{summary.map(row => <tr key={`${row.locale}-${row.field}`}><td>{row.locale} · {row.field === "tagline" ? "한 줄 소개" : "설명"}</td><td>{n(row.pending)}</td><td>{n(row.ready)}</td><td>{n(row.failed)}</td><td>{formatDetailTime(row.lastSavedAt)}</td></tr>)}</tbody></table></div>}</PrototypePanel>
    <div className="mt"><PrototypePanel title="실패 작업과 다음 행동">{queue === null ? <PrototypeEmpty>실패 목록을 읽지 못했습니다.</PrototypeEmpty> : queue.items.length === 0 ? <PrototypeEmpty>현재 조건의 실패 기록이 없습니다.</PrototypeEmpty> : <div className="table-scroll"><table style={{ minWidth: 850 }}><thead><tr><th>프로젝트 / 언어</th><th>원본·실패</th><th>실행 모델</th><th>다음 행동</th></tr></thead><tbody>{queue.items.map(row => <tr key={`${row.productId}-${row.locale}-${row.field}`}><td><Link className="name" href={`/admin/products/${row.slug}?section=intro`}>{row.name}</Link><p>{row.locale} · {row.field}</p></td><td><PrototypeTag tone="red">{row.errorCode ?? "실패"}</PrototypeTag><p>{row.sourceMatches ? "현재 원문과 일치" : "원문 변경됨"} · {formatDetailTime(row.updatedAt)}</p></td><td>{row.model || "미확인"}</td><td>{csrfToken && row.recovery ? <TranslationRetryForm csrfToken={csrfToken} expiresAt={admin.exp} item={row} accepted="현재 원문의 번역 재요청을 접수했습니다. 실제 완료는 작업 상태에서 확인하세요." /> : <span className="small muted">{csrfToken ? "현재 재요청 불가 · 원본 관리에서 사유 확인" : "인증 확인 필요"}</span>}</td></tr>)}</tbody></table></div>}</PrototypePanel></div>
  </main>;
}
