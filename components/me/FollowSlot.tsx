import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { repositoryOperator } from "@/lib/domain/products/github-owner";
import { publicRead } from "@/lib/domain/products/public-reads";
import { getTranslator } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/locales";
import { getRequestLocale } from "@/lib/i18n/server";
import type { FollowTarget } from "@/lib/me/contract";
import { makerKey, makerKeyOf } from "@/lib/me/follow-keys";
import { FollowButton, type FollowVariant } from "./FollowButton";
import { followLabels } from "./follow-labels";

/** 서버 화면에 다는 팔로 단추 하나. 로그인 기능이 꺼져 있으면 그리지 않는다 */
export async function FollowSlot({ target, targetKey, name, variant }: { target: FollowTarget; targetKey: string; name: string; variant?: FollowVariant }) {
  if (!publicUserAuthEnabled()) return null;
  const locale: Locale = await getRequestLocale();
  const t = await getTranslator(locale, "me");
  const aria = target === "product" ? t("follow.product", { name }) : target === "maker" ? t("follow.maker", { login: name }) : t("follow.category", { category: name });
  return <FollowButton target={target} targetKey={targetKey} labels={followLabels(t, target, aria)} variant={variant} />;
}

/**
 * 상세 머리 GitHub 주인 옆의 메이커 팔로. 머리는 사실 수집이 본 지금 주인을 보이지만, 팔로 열쇠(서버의 팔로 확인·새 프로젝트 알림)는
 * 등록한 주소와 하루 저장소 확인이 적은 지금 이름(repo_renamed_to)으로 정한다(makerKeyOf). 저장소를 옮긴 직후 둘이 다르면
 * 그 단추는 서버가 받지 않으므로(follow_not_found) 둘이 같아질 때까지 그리지 않는다
 */
async function MakerFollowSlot({ productId, repoUrl, login }: { productId: number; repoUrl: string | null; login: string }) {
  const [row] = await publicRead("detail", ["maker-follow", productId], () =>
    db.select({ repoUrl: products.repoUrl, repoRenamedTo: products.repoRenamedTo }).from(products).where(eq(products.id, productId)));
  const key = makerKeyOf(row?.repoUrl ?? repoUrl, row?.repoRenamedTo ?? null);
  if (!key || key !== makerKey(login)) return null;
  return <FollowSlot target="maker" targetKey={key} name={login} variant="inline" />;
}

/** 상세 머리의 두 자리 — 단추 줄의 프로젝트 팔로, 메타 줄 GitHub 주인 옆의 메이커 팔로. 주인은 머리가 보여 주는 계정과 같다 */
export function productFollowSlots(product: { id: number; name: string; repoUrl: string | null }, repositoryUrl: string | null) {
  if (!publicUserAuthEnabled()) return undefined;
  const owner = repositoryOperator(product.repoUrl, repositoryUrl)?.owner ?? null;
  return {
    project: <FollowSlot target="product" targetKey={String(product.id)} name={product.name} />,
    maker: owner && makerKey(owner.login) ? <MakerFollowSlot productId={product.id} repoUrl={product.repoUrl} login={owner.login} /> : null,
  };
}
