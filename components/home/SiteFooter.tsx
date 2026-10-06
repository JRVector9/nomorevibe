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
            <Link prefetch={false} href="/?metric=all">데이터와 집계 기준</Link>
            <Link href="/launch">프로젝트 공개</Link>
            <Link href="/launch#policy">게재 기준</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
