import { MePlaceholder } from "@/components/me/MePlaceholder";
import { meMetadata } from "@/lib/me/metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = () => meMetadata("saved");

/** /me 기본 탭 = 저장(Q1) */
export default function MeSavedPage() {
  return <MePlaceholder />;
}
