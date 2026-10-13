import type { Metadata } from "next";
import { HOME_TITLE } from "@/lib/copy/brand";
import { siteOrigin } from "@/lib/site";

export const metadata: Metadata = {
  title: HOME_TITLE,
  metadataBase: new URL(siteOrigin()),
  robots: { index: false, follow: false },
};

/** AdminShell and its authorization checks remain in the existing admin layout. */
export default function OperatorLayout({ children }: { children: React.ReactNode }) {
  return children;
}
