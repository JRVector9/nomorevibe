import Link from "next/link";
import { BRAND } from "@/lib/copy/brand";
import { FOOTER_SLOGAN } from "@/lib/copy/terms";
import "./chrome.css";

export function SiteFooter({ children }: { children: React.ReactNode }) {
  return (
    <footer className="nmb-footer">
      <div className="wrap">
        {children}
        <div className="footer">
          <div>
            <span className="footer-brand">{BRAND}</span>
            {FOOTER_SLOGAN}
          </div>
          <div className="footer-right">
            <Link prefetch={false} href="/?metric=all">데이터와 집계 기준</Link>
            <Link href="/launch">프로젝트 공개</Link>
            <Link prefetch={false} href="/policy#listing">게재 기준</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
