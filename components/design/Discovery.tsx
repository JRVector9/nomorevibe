"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { products, href, type DemoProduct } from "./data";
import { useDemo } from "./store";
import {
  Badge,
  ButtonLink,
  Empty,
  Icon,
  Logo,
  Notice,
  PageHeading,
  Tabs,
} from "./ui";
export function ProductRow({
  product: p,
  compact = false,
}: {
  product: DemoProduct;
  compact?: boolean;
}) {
  const { state, dispatch } = useDemo();
  const saved = state.saved.includes(p.slug);
  return (
    <article className={`d-product-row ${compact ? "compact" : ""}`}>
      <Link href={href("p/" + p.slug)} className="d-product-identity">
        <Logo product={p} />
        <div>
          <h3>{p.name}</h3>
          <p>{p.tagline}</p>
          <div className="d-meta">
            <Badge>{p.category}</Badge>
            {!compact && <span>{p.condition}</span>}
            {p.type === "radar" && <span>GitHub</span>}
          </div>
        </div>
      </Link>
      <div className="d-row-actions">
        {!compact && (
          <button
            aria-label={`${p.name} ${saved ? "저장 취소" : "저장"}`}
            aria-pressed={saved}
            className={`d-save ${saved ? "saved" : ""}`}
            onClick={() => dispatch({ type: "save", slug: p.slug })}
          >
            <Icon name="bookmark" size={19} />
          </button>
        )}
        <Link className="d-button secondary small" href={href("p/" + p.slug)}>
          {p.type === "radar" ? "보기" : "자세히"}
          <Icon size={15} />
        </Link>
      </div>
      {!compact && (
        <div className="d-row-bottom">
          {p.type === "launch" ? (
            <>
              <span>
                {p.maker} <span className="d-check">✓</span>
              </span>
              {p.needsFeedback ? (
                <Badge tone="green">피드백 모집 중</Badge>
              ) : (
                <Badge>최근 공개</Badge>
              )}
              {p.updated && <span className="d-muted">최근 개선</span>}
            </>
          ) : (
            <>
              <span>
                <Icon name="star" size={14} />
                {p.stars?.toLocaleString()}
              </span>
              <span>출처 확인 · 미리보기</span>
              {p.license && <Badge>{p.license}</Badge>}
            </>
          )}
        </div>
      )}
    </article>
  );
}
export function Home() {
  return (
    <>
      <section className="d-hero">
        <span className="d-eyebrow">REAL PRODUCTS. REAL PROGRESS.</span>
        <h1>Ship it. Get real users.</h1>
        <p>
          만든 제품을 공개하고,
          <br className="d-mobile-break" /> 써본 사람의 피드백으로 개선하세요.
        </p>
        <div className="d-hero-actions">
          <ButtonLink to="launch">
            제품 등록하기 <Icon size={17} />
          </ButtonLink>
          <ButtonLink to="launches" secondary>
            제품 둘러보기
          </ButtonLink>
        </div>
        <span className="d-hero-note">
          등록은 무료입니다. 좋은 피드백은 다음 버전의 시작입니다.
        </span>
      </section>
      <div className="d-discovery-split">
        {(["launch", "radar"] as const).map((kind) => (
          <section key={kind} className="d-discovery-panel">
            <div className="d-discovery-heading">
              <span
                className={`d-icon-surface ${kind === "radar" ? "blue" : ""}`}
              >
                <Icon name={kind === "radar" ? "radar" : "rocket"} size={30} />
              </span>
              <div>
                <h2>{kind === "radar" ? "Radar" : "Launches"}</h2>
                <p>
                  {kind === "radar"
                    ? "GitHub와 웹에서 발견한 프로젝트"
                    : "메이커가 공개하고 개선하는 제품"}
                </p>
              </div>
              <Link href={href(kind === "radar" ? "radar" : "launches")}>
                전체 보기 <Icon size={15} />
              </Link>
            </div>
            <div className="d-compact-list">
              {products
                .filter((p) => p.type === kind)
                .slice(0, 3)
                .map((p) => (
                  <ProductRow key={p.slug} product={p} compact />
                ))}
            </div>
          </section>
        ))}
      </div>
      <section className="d-feedback-waiting">
        <div className="d-section-heading">
          <div>
            <h2>
              <Icon name="feedback" /> 피드백을 기다리고 있어요
            </h2>
            <p>작은 시도가 메이커에게는 큰 도움이 됩니다.</p>
          </div>
          <Link href={href("missions")}>
            미션 보기 <Icon size={15} />
          </Link>
        </div>
        <div className="d-three">
          {products
            .filter((p) => ["planty", "notegen", "vocalclip"].includes(p.slug))
            .map((p) => (
              <Link
                key={p.slug}
                className="d-mission-mini"
                href={href("p/" + p.slug + "/test")}
              >
                <Logo product={p} />
                <div>
                  <h3>{p.name}</h3>
                  <p>{p.task}</p>
                  <span className="d-green">
                    User Feedback <Icon size={13} />
                  </span>
                </div>
              </Link>
            ))}
        </div>
      </section>
      <section className="d-contribution">
        <span className="d-icon-surface blue">
          <Icon name="user" size={30} />
        </span>
        <div>
          <h2>써보고, 나누고, 함께 개선해요.</h2>
          <p>다른 제품에 기여하고 내 제품에도 구체적인 피드백을 받아보세요.</p>
        </div>
        <ButtonLink to="credits/how-it-works" secondary>
          참여 방법 <Icon size={16} />
        </ButtonLink>
      </section>
    </>
  );
}
export function Catalog({ radar = false }: { radar?: boolean }) {
  const params = useSearchParams();
  const [filter, setFilter] = useState("전체");
  const [category, setCategory] = useState("전체 카테고리");
  const [sort, setSort] = useState("추천");
  const q = params.get("q")?.trim().toLocaleLowerCase() ?? "";
  const { state } = useDemo();
  let list = products
    .filter((p) => p.type === (radar ? "radar" : "launch"))
    .filter(
      (p) =>
        !q ||
        `${p.name} ${p.tagline} ${p.category}`.toLocaleLowerCase().includes(q),
    )
    .filter((p) => category === "전체 카테고리" || p.category === category)
    .filter((p) =>
      filter === "피드백 모집 중"
        ? p.needsFeedback
        : filter === "최근 개선"
          ? p.updated
          : filter === "저장한 제품"
            ? state.saved.includes(p.slug)
            : filter === "라이선스 확인"
              ? !!p.license
              : true,
    );
  if (sort === "이름순")
    list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "최근 업데이트")
    list = [...list].sort((a, b) => Number(b.updated) - Number(a.updated));
  if (sort === "GitHub 별")
    list = [...list].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  return (
    <>
      <PageHeading
        center
        eyebrow={radar ? "DISCOVER WHAT’S NEXT" : "MADE TO BE USED"}
        title={radar ? "Radar" : "Launches"}
        description={
          radar
            ? "아직 만나지 못한 프로젝트를 발견하세요."
            : "내게 필요한 제품을 만나고, 다음 버전에 참여하세요."
        }
      />
      {radar && (
        <Notice>
          자동 발견한 프로젝트입니다. 메이커 등록·안전성·품질이 확인된 목록은
          아닙니다.
        </Notice>
      )}
      <div className="d-filter-bar">
        <Tabs
          value={filter}
          onChange={setFilter}
          items={
            radar
              ? ["전체", "라이선스 확인", "저장한 제품"]
              : [
                  "전체",
                  "피드백 모집 중",
                  "최근 공개",
                  "최근 개선",
                  "저장한 제품",
                ]
          }
          label="제품 필터"
        />
        <div className="d-filter-selects">
          <select
            aria-label="카테고리"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {[
              "전체 카테고리",
              ...new Set(
                products
                  .filter((p) => p.type === (radar ? "radar" : "launch"))
                  .map((p) => p.category),
              ),
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select
            aria-label="정렬"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {[
              "추천",
              "최근 업데이트",
              "이름순",
              ...(radar ? ["GitHub 별"] : []),
            ].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
      </div>
      {q && (
        <p className="d-search-result">
          “{params.get("q")}” 검색 결과{" "}
          <Link href={href(radar ? "radar" : "launches")}>검색 지우기</Link>
        </p>
      )}
      <div className="d-product-list">
        {list.map((p) => (
          <ProductRow key={p.slug} product={p} />
        ))}
        {!list.length && (
          <Empty
            title="조건에 맞는 제품이 없어요"
            body="검색어나 카테고리를 바꿔보세요."
            action={
              <button
                className="d-button secondary"
                onClick={() => {
                  setFilter("전체");
                  setCategory("전체 카테고리");
                }}
              >
                필터 초기화
              </button>
            }
          />
        )}
      </div>
      <p className="d-list-count">{list.length}개 제품 · 디자인 예시</p>
      {radar && (
        <section className="d-contribution">
          <Icon name="shield" size={27} />
          <div>
            <h2>이곳에서 내 제품을 발견하셨나요?</h2>
            <p>제품 상세에서 관리 권한을 확인하고 메이커로 참여하세요.</p>
          </div>
          <ButtonLink to="trust" secondary>
            인증 알아보기 <Icon size={15} />
          </ButtonLink>
        </section>
      )}
    </>
  );
}
export function Missions() {
  return (
    <>
      <PageHeading
        eyebrow="SMALL TESTS. MEANINGFUL FEEDBACK."
        title="당신의 시도가 필요해요."
        description="관심 있는 제품을 써보고, 구체적인 경험을 나눠주세요."
        action={
          <ButtonLink to="credits/how-it-works" secondary>
            보상 기준 <Icon name="coin" size={17} />
          </ButtonLink>
        }
      />
      <Notice>
        보상이 예약된 미션은 적격 판정 후 +10C를 받습니다. 막혔던 경험도
        피드백이 됩니다.
      </Notice>
      <div className="d-mission-grid">
        {products
          .filter((p) => p.needsFeedback)
          .map((p) => (
            <Mission key={p.slug} product={p} />
          ))}
      </div>
    </>
  );
}
function Mission({ product: p }: { product: DemoProduct }) {
  const { state } = useDemo();
  const completed = state.feedback.some((f) => f.mine && f.product === p.slug);
  const own = p.slug === "frameit";
  return (
    <article className="d-panel d-mission-card">
      <div className="d-between">
        <Logo product={p} />
        <Badge tone={own ? "neutral" : "green"}>
          {own ? "내 제품" : "+10C · 심사 후"}
        </Badge>
      </div>
      <h2>{p.name}</h2>
      <h3>{p.task}</h3>
      <p>{p.condition}</p>
      <div className="d-mission-info">
        <span>
          <Icon name="clock" size={16} /> 메이커 안내 · 약 5분
        </span>
        <span>사용 과정과 결과 제출</span>
      </div>
      {own ? (
        <Notice tone="neutral">
          자기 제품은 보상 미션에 참여할 수 없습니다.
        </Notice>
      ) : (
        <ButtonLink to={completed ? "me" : "p/" + p.slug + "/test"} secondary>
          {completed
            ? "제출한 피드백 보기"
            : state.sessions.includes(p.slug)
              ? "참여 이어가기"
              : "미션 자세히 보기"}
          <Icon size={16} />
        </ButtonLink>
      )}
    </article>
  );
}
