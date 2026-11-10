import Link from "next/link";
import type { SocialCollectorStatus } from "@/lib/operations/flow-overview-model";
import { clock } from "../flow/PrototypeParts";
import { n, PrototypeTag } from "../products/PrototypeParts";
import "./SocialCollectorStrip.css";

/**
 * SNS 탭 맨 위의 수집기 줄 — 출처(HN·Bluesky·X·GeekNews)마다 지금 동작하는지, 마지막 성공, 주기, 상태 상세 링크.
 * 판정은 운영 홈 SNS 칸과 같은 buildSocialCollectors 이다. 읽지 못하면 정상으로 보이지 않게 미확인이라고 말한다.
 */
export function SocialCollectorStripView({ data }: { data: SocialCollectorStatus | null }) {
  if (!data) return <p className="notice" role="status">수집기 상태를 읽지 못했습니다 — 미확인은 정상이라는 뜻이 아닙니다. <Link prefetch={false} className="text-button" href="/admin/status?tab=jobs">작업 상태에서 확인 →</Link></p>;
  return <section className="social-collectors" aria-label="SNS 출처별 수집기 상태">
    <div className="social-collectors-head"><b>수집기 상태</b><span className="small muted">관측 {clock(data.measuredAt)} KST · 운영 홈 SNS 칸과 같은 판정</span><Link prefetch={false} className="text-button" href="/admin/status?tab=jobs">작업 상태 전체 →</Link></div>
    <ul>{data.collectors.map(source => <li key={source.source} data-tone={source.tone}>
      <div className="social-collector-head"><b>{source.label}</b><PrototypeTag tone={source.tone}>{source.status}</PrototypeTag></div>
      <small>{source.note}</small>
      <small>{source.statusHref ? <>마지막 수집 성공 {clock(source.lastSuccessAt)}</> : <>보관 글 {n(source.stored)}건</>} · 최근 24시간 새 글 {n(source.new24h)}건</small>
      <span className="social-collector-links">
        {source.statusHref && <Link prefetch={false} className="text-button" href={source.statusHref}>{source.source === "x" ? "X 보고 상세" : "작업 상세"} →</Link>}
        <Link prefetch={false} className="text-button" href={`/admin/content?tab=social&source=${source.source}`}>이 출처 글만</Link>
      </span>
    </li>)}</ul>
  </section>;
}

export async function SocialCollectorStrip({ read }: { read: Promise<SocialCollectorStatus | null> }) {
  return <SocialCollectorStripView data={await read} />;
}
