import type { TodayPublications } from "@/lib/operations/dashboard";

const n = (value: number) => value.toLocaleString("ko-KR");
const clock = (iso: string) => new Date(iso).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });

/** 오늘 무엇이 올라갔나 — 24시간 수와 한국어 비율, 마지막 여섯 건 */
export function TodayFeed({ today, down }: { today: TodayPublications; down: number }) {
  const korean = today.total24h > 0 ? Math.round((today.korean24h / today.total24h) * 100) : 0;
  return (
    <section className="dash-card dash-12" aria-label="오늘 발행">
      <div className="dash-card-h">
        <h2>오늘 발행 · {n(today.total24h)}건</h2>
        <small>한국어 소개 {n(today.korean24h)} ({korean}%) · 응답 없음으로 가려진 제품 {n(down)}</small>
      </div>
      {today.latest.length === 0 ? <p className="text-[13px] text-fg-3">최근 24시간에 발행된 제품이 없습니다.</p> : (
        <div className="dash-feed">
          {today.latest.map((item) => (
            <a key={item.slug} className="dash-item" href={`/p/${item.slug}`} target="_blank" rel="noopener noreferrer">
              <div className="nm">{item.name}</div>
              <div className="tg">{item.tagline}</div>
              <div className="meta">
                {item.signal && <span className="dash-pill">{item.signal}</span>}
                <span className="dash-pill">{item.category}</span>
                {item.korean && <span className="dash-pill" data-tone="acc">한국어</span>}
                <span className="font-mono text-[13px] text-fg-3">{clock(item.createdAt)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
