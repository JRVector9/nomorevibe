import { MePlaceholder } from "@/components/me/MePlaceholder";
import { meMetadata } from "@/lib/me/metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = () => meMetadata("alerts");

export default function MeAlertsPage() {
  return <MePlaceholder />;
}
