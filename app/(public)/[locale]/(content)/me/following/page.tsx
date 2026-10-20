import { FollowingList } from "@/components/me/FollowingList";
import { MeLoginRequired } from "@/components/me/MeLoginRequired";
import { listFollows } from "@/lib/me/follows";
import { meMetadata } from "@/lib/me/metadata";
import { getMeSession } from "@/lib/me/session";

export const dynamic = "force-dynamic";
export const generateMetadata = () => meMetadata("following");

/** 팔로 탭 — 로그인해야 보인다. 목록은 서버에서 한 번 읽고, 풀기·다시 팔로는 화면에서 */
export default async function MeFollowingPage() {
  const session = await getMeSession();
  if (!session) return <MeLoginRequired tab="following" />;
  return <FollowingList initial={await listFollows(session.user.id)} />;
}
