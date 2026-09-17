import type { Metadata } from "next";
import { DesignShell } from "@/components/design/Shell";
import "./design.css";
export const metadata: Metadata = {
  title: "NoMoreVibe — 디자인 미리보기",
  description: "사업·서비스 기획 최종안의 인터랙티브 화면. 예시 데이터입니다.",
  robots: { index: false, follow: false },
};
export default function DesignLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DesignShell>{children}</DesignShell>;
}
