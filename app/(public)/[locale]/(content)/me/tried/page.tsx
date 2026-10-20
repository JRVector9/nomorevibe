import { MePlaceholder } from "@/components/me/MePlaceholder";
import { TriedList } from "@/components/me/TriedList";
import { productReactionsEnabled } from "@/lib/domain/reactions/flags";
import { listUserReactions } from "@/lib/domain/reactions/repository";
import { meMetadata } from "@/lib/me/metadata";
import { getMeSession } from "@/lib/me/session";

export const dynamic = "force-dynamic";
export const generateMetadata = () => meMetadata("tried");

/**
 * 써봤어요 탭 — 로그인하면 계정의 평가, 아니면 이 브라우저가 평가한 제품(Q4)의 익명 평가.
 * 계정 목록은 서버에서 바로 그리고(못 읽으면 화면이 다시 읽는다), 이 브라우저 목록은 localStorage 가 있어야 하므로 화면이 읽는다.
 */
export default async function MeTriedPage() {
  if (!productReactionsEnabled()) return <MePlaceholder />;
  const session = await getMeSession();
  const initial = session ? await listUserReactions(session.user.id).catch(() => null) : null;
  return <TriedList account={session ? { csrfToken: session.csrfToken } : null} initial={initial} />;
}
