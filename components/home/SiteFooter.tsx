import Link from "next/link";

export function SiteFooter({ children }: { children: React.ReactNode }) {
  return (
    <footer className="nmb-footer">
      <div className="wrap">
        {children}
        <div className="footer">
          <div>
            <span className="footer-brand">nomorevibe</span>
            Build something. Ship it.
          </div>
          <div className="footer-right">
            <Link href="/?metric=all">데이터와 집계 기준</Link>
            <Link href="/launch">프로젝트 공개</Link>
            <span>AI로 만든 제품의 마켓 데이터베이스</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
