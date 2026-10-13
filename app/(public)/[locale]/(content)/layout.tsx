import { PublicShell } from "@/components/home/PublicShell";
import { getRequestLocale } from "@/lib/i18n/server";

/** The parallel slot stays below the HTML root; only its home page reads seasons. */
export default async function PublicContentLayout({ children, seasonfooter }: {
  children: React.ReactNode; seasonfooter: React.ReactNode;
}) {
  return <PublicShell locale={await getRequestLocale()} seasonfooter={seasonfooter}>{children}</PublicShell>;
}
