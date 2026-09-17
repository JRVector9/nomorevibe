"use client";
import Link from "next/link";
import { useState } from "react";
import { href, productBySlug, type DemoProduct } from "./data";
import { useDemo, type Feedback } from "./store";
import {
  Badge,
  ButtonLink,
  Empty,
  Icon,
  Logo,
  Notice,
  Panel,
  Tabs,
} from "./ui";
export function FeedbackCard({ feedback: f }: { feedback: Feedback }) {
  return (
    <Link className="d-feedback-card" href={href("feedback/" + f.id)}>
      <div className="d-between">
        <Badge tone={f.source === "User" ? "green" : "purple"}>
          <Icon name={f.source === "User" ? "user" : "agent"} size={13} />
          {f.source} Feedback
        </Badge>
        <span className="d-muted">{f.author}</span>
      </div>
      <h3>{f.task}</h3>
      <p>{f.body}</p>
      <div className="d-meta">
        <Badge>{f.outcome}</Badge>
        <span>
          {f.review === "pending"
            ? "심사 중"
            : f.review === "revision"
              ? "보완 요청"
              : f.source === "Agent"
                ? "실행 증거 연결"
                : "증거 검토됨"}
        </span>
        <span className="d-meta-right">
          {f.progress} <Icon size={13} />
        </span>
      </div>
    </Link>
  );
}
export function ProductDetail({ product: p }: { product: DemoProduct }) {
  const [tab, setTab] = useState("소개");
  const [source, setSource] = useState("User Feedback");
  const [copied, setCopied] = useState(false);
  const { state } = useDemo();
  const feedback = state.feedback.filter((f) => f.product === p.slug);
  return (
    <>
      <div className="d-breadcrumb">
        <Link href={href(p.type === "radar" ? "radar" : "launches")}>
          ← {p.type === "radar" ? "Radar" : "Launches"}
        </Link>
        <button
          className="d-text-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(location.href);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "링크 복사됨" : "공유"} <Icon name="external" size={15} />
        </button>
      </div>
      <section className="d-product-hero">
        <Logo product={p} large />
        <div>
          <div className="d-meta">
            <Badge tone={p.type === "launch" ? "green" : "blue"}>
              {p.type === "launch" ? "관리 권한 확인" : "Radar에서 발견"}
            </Badge>
          </div>
          <h1>{p.name}</h1>
          <p>{p.tagline}</p>
          <div className="d-meta">
            <Badge>{p.category}</Badge>
            <span>{p.maker}</span>
          </div>
        </div>
        <div className="d-detail-actions">
          <ButtonLink to={"p/" + p.slug + "/test"}>
            사용해보기 <Icon name="external" size={16} />
          </ButtonLink>
          <ButtonLink secondary to={"p/" + p.slug + "/test"}>
            피드백 남기기
          </ButtonLink>
        </div>
      </section>
      <div className="d-conditions">
        <span>
          <Icon name="check" size={16} />
          {p.condition}
        </span>
        {p.type === "launch" ? (
          <span>사용 경험과 막힌 점을 모두 환영해요.</span>
        ) : (
          <Link href={href("p/" + p.slug + "/claim")}>
            이 제품을 관리하시나요? <Icon size={14} />
          </Link>
        )}
      </div>
      <Tabs
        items={["소개", "피드백", "업데이트"]}
        value={tab}
        onChange={setTab}
        label="제품 상세 탭"
      />
      {tab === "소개" && (
        <div className="d-two-main">
          <div>
            <div className={`d-product-art ${p.tone}`}>
              <div className="d-art-window">
                <div className="d-art-toolbar">
                  <i />
                  <i />
                  <i />
                  <span>{p.name} · 제품 화면 예시</span>
                </div>
                <div className="d-art-content">
                  <Logo product={p} large />
                  <h2>
                    {p.name === "FrameIt" ? "작은 순간도, 멋지게." : p.tagline}
                  </h2>
                  <p>
                    {p.name === "FrameIt"
                      ? "내 아이디어에 어울리는 프레임을 찾아보세요."
                      : "더 적은 설정으로, 더 좋은 결과를."}
                  </p>
                  <div className="d-art-placeholder">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            </div>
            <section className="d-prose">
              <h2>아이디어에서 다음 단계로.</h2>
              <p>
                {p.tagline} {p.name}은 처음 사용하는 순간부터 필요한 일에 집중할
                수 있도록 만든 제품입니다. 지금 첫 사용 경험과 개선 의견을
                기다리고 있어요.
              </p>
              <h3>이런 분께 추천해요</h3>
              <p>
                {p.category} 작업을 더 간단하게 만들고 싶은 사용자와 자신의 작업
                방식을 개선하고 싶은 메이커.
              </p>
              <h3>사용하기 전에</h3>
              <p>{p.condition}. 개인 정보 대신 샘플 데이터를 사용해보세요.</p>
            </section>
          </div>
          <aside className="d-sidebar">
            <Panel title="메이커가 궁금한 것" icon="radar">
              <h3>{p.task}</h3>
              <ul className="d-check-list">
                <li>첫 화면에서 무엇을 할지 명확한가요?</li>
                <li>어느 단계에서 멈추거나 망설였나요?</li>
                <li>한 가지만 바꾼다면 무엇인가요?</li>
              </ul>
              <ButtonLink to={"p/" + p.slug + "/test"} secondary>
                테스트 과제 보기 <Icon size={15} />
              </ButtonLink>
            </Panel>
            <Panel title="제품 정보">
              <dl className="d-definition">
                <dt>카테고리</dt>
                <dd>{p.category}</dd>
                <dt>관리 주체</dt>
                <dd>{p.maker}</dd>
                <dt>이용 방식</dt>
                <dd>{p.condition}</dd>
                {p.repo && (
                  <>
                    <dt>발견 출처</dt>
                    <dd>{p.repo}</dd>
                  </>
                )}
                {p.license && (
                  <>
                    <dt>라이선스 예시</dt>
                    <dd>{p.license}</dd>
                  </>
                )}
              </dl>
            </Panel>
            <Link className="d-subtle-link" href={href("trust")}>
              정보 수정·신고 안내 <Icon size={14} />
            </Link>
          </aside>
        </div>
      )}
      {tab === "피드백" && (
        <>
          <div className="d-section-heading">
            <div>
              <h2>작은 관찰에서 시작되는 개선</h2>
              <p>사람의 사용 경험과 에이전트 실행 결과를 구분해서 보세요.</p>
            </div>
          </div>
          <Tabs
            items={["User Feedback", "Agent Feedback"]}
            value={source}
            onChange={setSource}
          />
          <div className="d-feedback-grid">
            {feedback
              .filter(
                (f) =>
                  f.source === (source.startsWith("User") ? "User" : "Agent"),
              )
              .map((f) => (
                <FeedbackCard key={f.id} feedback={f} />
              ))}
          </div>
          {!feedback.some(
            (f) => f.source === (source.startsWith("User") ? "User" : "Agent"),
          ) && (
            <Empty
              title="첫 피드백을 기다리고 있어요"
              action={
                <ButtonLink to={"p/" + p.slug + "/test"}>
                  제품 사용해보기
                </ButtonLink>
              }
            />
          )}
          <Notice tone="neutral">
            User는 사람이 수행한 경험, Agent는 자동 실행 결과입니다. Agent
            결과를 사용자 수나 실제 수요로 합산하지 않습니다.
          </Notice>
        </>
      )}
      {tab === "업데이트" && (
        <Panel title="피드백이 이렇게 바뀌었어요" icon="rocket">
          <div className="d-timeline">
            {p.slug === "frameit" ? (
              <>
                {state.updates.map((u) => (
                  <article key={u.id}>
                    <span className="d-timeline-dot" />
                    <Badge tone="green">수정 배포</Badge>
                    <h3>{u.version}</h3>
                    <p>{u.body}</p>
                    {u.releaseUrl && /^https?:\/\//.test(u.releaseUrl) && (
                      <a
                        href={u.releaseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        배포 링크 확인 ↗
                      </a>
                    )}
                    <span className="d-muted">
                      {u.retest
                        ? "재테스트 요청됨 · 재확인 대기"
                        : "아직 재확인되지 않았습니다"}
                    </span>
                    <Link href={href("feedback/" + u.feedbackId)}>
                      연결된 피드백 <Icon size={14} />
                    </Link>
                  </article>
                ))}
                <article>
                  <span className="d-timeline-dot" />
                  <Badge tone="green">수정 배포</Badge>
                  <h3>가로 이미지 프리셋을 추가했어요</h3>
                  <p>
                    도윤 님의 피드백을 반영해 16:9와 3:2 비율을 선택할 수
                    있습니다.
                  </p>
                  <Link href={href("feedback/f2")}>
                    연결된 피드백 <Icon size={14} />
                  </Link>
                  <small>샘플 업데이트 · 사용자 재확인 대기</small>
                </article>
              </>
            ) : (
              <Empty title="공개된 업데이트가 없어요" />
            )}
          </div>
        </Panel>
      )}
    </>
  );
}
export function FeedbackDetail({ id }: { id: string }) {
  const { state } = useDemo();
  const f = state.feedback.find((f) => f.id === id);
  if (!f)
    return (
      <Empty
        title="피드백을 찾을 수 없어요"
        body="미리보기 데이터를 초기화했거나 존재하지 않는 링크입니다."
        action={
          <ButtonLink to="dashboard" secondary>
            피드백 목록
          </ButtonLink>
        }
      />
    );
  const p = productBySlug(f.product)!;
  return (
    <>
      <div className="d-breadcrumb">
        <Link href={href("p/" + p.slug)}>← {p.name}</Link>
        <Badge tone={f.source === "User" ? "green" : "purple"}>
          {f.source} Feedback
        </Badge>
      </div>
      <div className="d-two-main">
        <Panel>
          <div className="d-author">
            <span className="d-avatar">{f.author[0]}</span>
            <div>
              <strong>{f.author}</strong>
              <p>
                {f.source === "User" ? "독립 참여" : "Platform-run · 실행 예시"}
              </p>
            </div>
          </div>
          <h1 className="d-detail-title">{f.task}</h1>
          <div className="d-meta">
            <Badge>{f.outcome}</Badge>
            <Badge>
              {f.review === "pending"
                ? "심사 중"
                : f.review === "revision"
                  ? "보완 요청"
                  : f.source === "User"
                    ? "증거 검토됨"
                    : "실행 증거 연결"}
            </Badge>
            <Badge>{f.reward ? "크레딧 보상 미션" : "자발적 참여"}</Badge>
          </div>
          <div className="d-prose">
            <h2>실제로 어떤 경험을 했나요?</h2>
            <p>{f.body}</p>
            <h2>한 가지만 바꾼다면</h2>
            <p>{f.improve}</p>
          </div>
          <Notice tone="neutral">
            증거 첨부는 메이커와 운영 검토자에게만 공개됩니다. 이 화면의 내용은
            디자인 예시입니다.
          </Notice>
          {f.reviewReason && (
            <Notice tone={f.review === "revision" ? "amber" : "green"}>
              심사 사유: {f.reviewReason}
            </Notice>
          )}
          {f.evidenceName && (
            <p className="d-muted">
              선택한 증거: {f.evidenceName} · {f.evidenceVisibility} · 서버
              업로드 없음
            </p>
          )}
          <hr />
          <h2>메이커 답변</h2>
          {f.reply ? (
            <blockquote>{f.reply}</blockquote>
          ) : (
            <p className="d-muted">
              아직 답변이 없어요. 답변이 도착하면 알림으로 알려드려요.
            </p>
          )}
        </Panel>
        <aside className="d-sidebar">
          <Panel title="개선 진행">
            <div className="d-progress-steps">
              {[
                "접수",
                "검토 중",
                "계획됨",
                "작업 중",
                "수정 배포",
                "재확인 완료",
              ].map((s) => (
                <div key={s} className={s === f.progress ? "active" : ""}>
                  <span />
                  {s}
                </div>
              ))}
            </div>
            <small>배포된 수정은 재테스트 후 별도로 확인됩니다.</small>
          </Panel>
          <ButtonLink to="dashboard" secondary>
            빌더 작업함에서 보기
          </ButtonLink>
          <ButtonLink to="appeals/demo" secondary>
            심사 이의제기
          </ButtonLink>
        </aside>
      </div>
    </>
  );
}
