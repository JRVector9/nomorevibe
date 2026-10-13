import { PublicNotFound } from "@/components/home/PublicNotFound";
import { getRequestLocale } from "@/lib/i18n/server";

export default async function ContentNotFound() {
  return PublicNotFound({ locale: await getRequestLocale() });
}
