"use client";
import Link from "next/link";
import { useState } from "react";
import { href, products, productBySlug } from "./data";
import { useDemo } from "./store";
import { ProductRow } from "./Discovery";
import { FeedbackCard } from "./Product";
import {
  Badge,
  ButtonLink,
  Empty,
  Field,
  Icon,
  Notice,
  PageHeading,
  Panel,
  Tabs,
} from "./ui";
export function CreditPolicy() {
  return (
    <>
      <PageHeading
        center
        eyebrow="GIVE FEEDBACK. GET FEEDBACK."
        title="제품 등록은 무료입니다."
        description="크레딧은 내 제품의 피드백 요청에 사용합니다."
      />
      <div className="d-three d-policy-cards">
        {[
          [
            "feedback",
            "+10C",
            "적격 피드백에 기여하세요",
            "사전 예약된 User 미션에 참여하고 심사를 통과하면 적립됩니다.",
          ],
          [
            "user",
            "15C",
            "한 사람의 경험을 요청하세요",
            "원하는 과제와 대상에 맞는 적격 결과 1건을 요청합니다.",
          ],
          [
            "shield",
            "심사 후",
            "확인한 뒤 정산합니다",
            "요청 시 예약, 적격 완료 시 차감합니다. 미매칭 예약은 해제합니다.",
          ],
        ].map(([i, n, t, b]) => (
          <Panel key={n}>
            <span className="d-icon-surface blue">
              <Icon name={i} size={26} />
            </span>
            <strong className="d-policy-number">{n}</strong>
            <h2>{t}</h2>
            <p>{b}</p>
          </Panel>
        ))}
      </div>
      <section className="d-contribution">
        <Icon name="coin" size={30} />
        <div>
          <h2>두 번의 기여 → 한 번의 요청</h2>
          <p>적격 미션 2건으로 20C 적립 → 15C로 1명 요청 → 5C가 남습니다.</p>
        </div>
        <ButtonLink to="missions">
          미션 둘러보기 <Icon size={16} />
        </ButtonLink>
      </section>
      <div className="d-policy-detail">
        <h2>공정하게 기여하고 사용하는 방법</h2>
        {[
          [
            "어떤 피드백이 보상받나요?",
            "관련성·구체성·증거 일치·신규성과 이해관계를 검토합니다. 높은 별점이나 칭찬은 기준이 아닙니다. 막힘·실패 보고도 적격일 수 있습니다.",
          ],
          [
            "보상받지 않는 활동은 무엇인가요?",
            "가입·클릭·체류·자기 제품 평가·일반 댓글·Agent 결과는 자동 보상하지 않습니다. 예산이 예약된 User 미션만 대상입니다.",
          ],
          [
            "예약한 크레딧은 어떻게 되나요?",
            "3명을 요청하면 45C 예약. 2건이 적격이면 30C 차감, 테스터에게 각각 10C 지급, 차이 10C 소각. 미매칭 1건은 15C를 해제합니다.",
          ],
          [
            "현금으로 바꾸거나 구매할 수 있나요?",
            "기여 크레딧의 현금 구매·출금·양도는 없습니다. 활성 계정은 MVP에서 만료하지 않으며, 유료 캠페인은 별도 계약·장부로 처리합니다.",
          ],
          [
            "보상 판정에 이의를 제기할 수 있나요?",
            "사유와 보완 증거를 제출할 수 있습니다. 메이커가 비판적 의견이라는 이유로 보상을 막을 수 없습니다. 정정은 장부에 새 거래로 기록합니다.",
          ],
        ].map(([q, a]) => (
          <details key={q} className="d-disclosure">
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
        <p className="d-muted">
          파일럿 정책 제안 v1.0 · +10C/15C는 운영 검증 후 버전과 적용일을
          공지합니다.
        </p>
      </div>
    </>
  );
}
export function Pricing() {
  return (
    <>
      <PageHeading
        center
        title="좋은 피드백에서 시작하세요."
        description="기본 등록은 무료. 필요한 운영 지원만 선택하세요."
      />
      <div className="d-three d-pricing">
        {[
          [
            "Free",
            "무료",
            "제품을 소개하고 함께 개선하세요.",
            [
              "제품 등록·관리 권한 확인",
              "기본 피드백·업데이트",
              "기여 크레딧 미션 참여",
            ],
            "launch",
            "제품 등록하기",
          ],
          [
            "Community",
            "15C / 적격 결과",
            "커뮤니티에 구체적인 경험을 요청하세요.",
            ["대상과 과제 설정", "요청 시 예산 예약", "미매칭 예약 해제"],
            "sprints/new",
            "피드백 요청하기",
          ],
          [
            "Assisted Sprint",
            "범위별 견적",
            "모집과 품질 검토의 운영 지원.",
            [
              "타깃 테스터 모집 검토",
              "일정·품질·결과 정리",
              "미충족 시 처리 조건 협의",
            ],
            "sprints/new",
            "Sprint 살펴보기",
          ],
        ].map(([name, price, desc, features, path, cta]) => (
          <Panel
            key={String(name)}
            className={name === "Community" ? "featured" : ""}
          >
            <span className="d-eyebrow">{String(name)}</span>
            <h2>{String(price)}</h2>
            <p>{String(desc)}</p>
            <ul className="d-check-list">
              {(features as string[]).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <ButtonLink to={String(path)} secondary={name !== "Community"}>
              {String(cta)}
              <Icon size={15} />
            </ButtonLink>
          </Panel>
        ))}
      </div>
      <Notice>
        유료 상품은 파일럿 검증 단계입니다. 이미지의 $19·$49·$99 같은 가격을
        확정 판매 조건으로 사용하지 않습니다. 긍정적 평가·실제 고객 수·자연 노출
        순위는 판매하지 않습니다.
      </Notice>
      <Panel title="반복 운영을 위한 기능은 차례로">
        <p>
          Maker Pro, Team, Agent Check Pack은 반복 사용과 실행 원가를 검증한 후
          별도 조건으로 제공합니다. 현재 결제되는 구독이나 자동 갱신은 없습니다.
        </p>
        <ButtonLink to="settings/billing" secondary>
          내 청구 상태 보기
        </ButtonLink>
      </Panel>
    </>
  );
}
export function Billing() {
  return (
    <>
      <PageHeading
        title="요금 및 청구"
        description="기여 크레딧과 현금 결제를 구분해서 확인하세요."
      />
      <Panel title="현재 이용 상태">
        <div className="d-between">
          <div>
            <Badge tone="green">Free</Badge>
            <h2>무료로 제품을 공개하고 피드백을 받으세요.</h2>
            <p>활성 유료 구독·자동 갱신·등록된 결제 수단이 없습니다.</p>
          </div>
          <ButtonLink to="pricing" secondary>
            서비스 안내
          </ButtonLink>
        </div>
      </Panel>
      <Panel title="청구서 및 환급">
        <Empty
          title="청구 내역이 없어요"
          body="유료 파일럿 계약과 결제가 도입되면 이곳에서 관리합니다."
        />
      </Panel>
      <Notice tone="neutral">
        커뮤니티 포인트는 현금 청구 내역이 아닙니다.{" "}
        <Link href={href("credits")}>크레딧 내역 보기 →</Link>
      </Notice>
    </>
  );
}
export function Activity() {
  const { state } = useDemo();
  const [tab, setTab] = useState("참여한 미션");
  const mine = state.feedback.filter((f) => f.mine);
  return (
    <>
      <PageHeading
        title="나의 작은 기여들"
        description="써본 제품, 남긴 의견, 그 뒤의 변화를 모았습니다."
        action={
          <ButtonLink to="credits" secondary>
            <Icon name="coin" size={17} /> 내 크레딧
          </ButtonLink>
        }
      />
      <Tabs
        items={["참여한 미션", "내 피드백", "저장한 제품"]}
        value={tab}
        onChange={setTab}
      />
      {tab === "참여한 미션" ? (
        <Panel>
          {state.sessions.length ? (
            state.sessions.map((slug) => (
              <div key={slug} className="d-table-row">
                <div>
                  <strong>{productBySlug(slug)?.name}</strong>
                  <p>{productBySlug(slug)?.task}</p>
                </div>
                <Badge>
                  {mine.some((f) => f.product === slug) ? "제출됨" : "참여 중"}
                </Badge>
                <ButtonLink to={"tests/" + slug + "/feedback"} secondary>
                  이어서 보기
                </ButtonLink>
              </div>
            ))
          ) : (
            <Empty
              title="첫 미션에 참여해보세요"
              action={<ButtonLink to="missions">미션 찾기</ButtonLink>}
            />
          )}
        </Panel>
      ) : tab === "내 피드백" ? (
        <div className="d-feedback-grid">
          {mine.map((f) => (
            <FeedbackCard feedback={f} key={f.id} />
          ))}
          {!mine.length && <Empty title="아직 제출한 피드백이 없어요" />}
        </div>
      ) : (
        <div className="d-product-list">
          {products
            .filter((p) => state.saved.includes(p.slug))
            .map((p) => (
              <ProductRow key={p.slug} product={p} />
            ))}
          {!state.saved.length && (
            <Empty
              title="관심 있는 제품을 저장해보세요"
              action={<ButtonLink to="launches">제품 둘러보기</ButtonLink>}
            />
          )}
        </div>
      )}
    </>
  );
}
export function Notifications() {
  const { state, dispatch } = useDemo();
  return (
    <>
      <PageHeading
        title="작은 변화가 도착했어요."
        description="메이커의 답변과 업데이트, 참여한 미션의 상태를 알려드려요."
        action={
          <button
            className="d-button secondary"
            onClick={() => dispatch({ type: "read" })}
          >
            {state.readNotifications ? "모두 읽었습니다" : "모두 읽음"}
          </button>
        }
      />
      <Panel>
        {state.feedback
          .filter((f) => f.mine)
          .map((f) => (
            <Link
              className="d-notification"
              href={href("feedback/" + f.id)}
              key={f.id}
            >
              <span className="d-icon-surface green">
                <Icon name="feedback" />
              </span>
              <div>
                <h3>
                  {f.review === "qualified"
                    ? "피드백이 적격으로 확인되었어요"
                    : f.review === "revision"
                      ? "피드백에 보완이 필요해요"
                      : "피드백을 검토하고 있어요"}
                </h3>
                <p>
                  {productBySlug(f.product)?.name} ·{" "}
                  {f.reward ? "보상 미션" : "자발적 피드백"}
                </p>
              </div>
              {!state.readNotifications && <span className="d-unread" />}
            </Link>
          ))}
        {state.updates.map((u) => (
          <Link className="d-notification" href={href("p/frameit")} key={u.id}>
            <span className="d-icon-surface blue">
              <Icon name="rocket" />
            </span>
            <div>
              <h3>FrameIt {u.version} 업데이트를 저장했어요</h3>
              <p>
                {u.retest
                  ? "재확인 요청이 연결되었습니다."
                  : "수정 배포 기록을 확인하세요."}
              </p>
            </div>
          </Link>
        ))}
        <Link className="d-notification" href={href("missions")}>
          <span className="d-icon-surface blue">
            <Icon name="user" />
          </span>
          <div>
            <h3>첫 피드백을 기다리는 메이커를 만나보세요.</h3>
            <p>관심 있는 미션을 선택하고 참여해보세요.</p>
          </div>
          <Icon />
        </Link>
      </Panel>
    </>
  );
}
export function Trust() {
  return (
    <>
      <PageHeading
        center
        eyebrow="TRUST COMES FROM CLARITY"
        title="확인한 만큼만 말합니다."
        description="누가 사용했고, 어떤 근거가 있으며, 무엇이 바뀌었는지 구분합니다."
      />
      <div className="d-three">
        <Panel title="관리 권한 확인" icon="shield">
          <p>
            저장소나 도메인을 현재 관리할 수 있다는 확인입니다. 법적
            소유권·저작권·제품 품질을 보증하지 않습니다.
          </p>
        </Panel>
        <Panel title="User / Agent" icon="user">
          <p>
            사람이 수행한 경험과 에이전트 실행을 구분합니다. 사람의 AI 문장
            보조는 실제 수행 주체와 별개입니다.
          </p>
        </Panel>
        <Panel title="공정한 피드백" icon="feedback">
          <p>
            칭찬보다 구체적인 경험을 봅니다. 실패 보고도 기여이며 메이커가 보상
            적격 여부를 결정하지 않습니다.
          </p>
        </Panel>
      </div>
      <Panel title="사용 확인 수준">
        <div className="d-evidence-levels">
          {[
            ["L0", "방문·테스트 시작", "클릭만으로 사용을 확정하지 않습니다."],
            [
              "L1",
              "사용 경험 자기진술",
              "작성자가 시도한 과제와 결과를 설명합니다.",
            ],
            ["L2", "증거 검토됨", "관련 증거와 구체성을 플랫폼이 검토합니다."],
            [
              "L3",
              "제품 이벤트 확인됨",
              "해당 테스트의 서명된 제품 이벤트를 연결합니다.",
            ],
          ].map(([n, t, b]) => (
            <article key={n}>
              <Badge tone="blue">{n}</Badge>
              <h3>{t}</h3>
              <p>{b}</p>
            </article>
          ))}
        </div>
      </Panel>
      <div className="d-two-main">
        <Panel title="수정과 확인은 다른 단계입니다">
          <p>
            메이커가 수정 배포를 연결한 뒤, 사용자 또는 에이전트가 다시
            확인합니다. 이슈 종료만으로 해결됐다고 표시하지 않습니다.
          </p>
          <div className="d-flow">
            피드백 <Icon /> 수정 배포 <Icon /> 재확인
          </div>
        </Panel>
        <Panel title="신고·이의제기">
          <p>
            잘못된 정보, 권한 분쟁, 보상 심사에 대한 사유와 증거를 제출할 수
            있습니다.
          </p>
          <ButtonLink to="appeals/demo" secondary>
            검토 요청하기 <Icon size={15} />
          </ButtonLink>
        </Panel>
      </div>
    </>
  );
}
export function Appeal() {
  const [submitted, setSubmitted] = useState(false);
  return (
    <>
      <PageHeading
        title="다시 확인하겠습니다."
        description="검토가 필요한 내용과 관련 근거를 알려주세요."
      />
      <div className="d-two-main">
        <form
          className="d-panel d-form"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
          }}
        >
          <Field label="요청 유형">
            <select required>
              <option>피드백 적격·보상 심사</option>
              <option>관리 권한 분쟁</option>
              <option>제품 정보 수정·삭제</option>
              <option>위험 링크·개인정보 신고</option>
              <option>팀 초대 요청</option>
            </select>
          </Field>
          <Field label="대상 제품 또는 피드백 *">
            <input required maxLength={300} placeholder="제품명 또는 링크" />
          </Field>
          <Field label="어떤 내용을 다시 확인해야 하나요? *">
            <textarea
              required
              minLength={10}
              maxLength={3000}
              placeholder="원래 판정, 다른 의견의 이유와 추가 근거를 알려주세요."
            />
          </Field>
          <Field label="근거 링크 (선택)">
            <input type="url" placeholder="https://…" />
          </Field>
          <label className="d-check-field">
            <input required type="checkbox" /> 비밀번호·토큰·불필요한 개인정보를
            포함하지 않았습니다.
          </label>
          {submitted ? (
            <div role="status">
              <Notice tone="green">
                요청 초안을 미리보기에 접수했습니다. 실제 운영자에게 전송되지는
                않았습니다.
              </Notice>
              <div className="d-flow">
                접수 <Icon /> 검토 대기 <Icon /> 결과 안내
              </div>
            </div>
          ) : (
            <button className="d-button">
              검토 요청 미리보기 <Icon size={15} />
            </button>
          )}
        </form>
        <aside>
          <Panel title="검토 절차" icon="shield">
            <ul className="d-check-list">
              <li>원래 판정과 기준 확인</li>
              <li>추가 자료와 관계 검토</li>
              <li>사유를 포함한 결과 안내</li>
              <li>필요시 보상 장부 정정</li>
            </ul>
            <p>권한 분쟁이 있어도 다른 계정에 제품을 즉시 이전하지 않습니다.</p>
          </Panel>
        </aside>
      </div>
    </>
  );
}
export function AdminReview() {
  const { state, dispatch } = useDemo();
  const [kind, setKind] = useState("피드백 품질");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const items = state.feedback.filter((f) => f.review !== "qualified");
  const f = items[0];
  return (
    <>
      <PageHeading
        title="검토 작업함"
        description="근거를 확인하고, 일관된 기준으로 판단합니다."
      />
      <Notice tone="amber">
        운영 콘솔 디자인 미리보기입니다. 실제 운영 권한이나 데이터에 접근하지
        않습니다.
      </Notice>
      <Tabs
        value={kind}
        onChange={setKind}
        items={["피드백 품질", "Claim 신청", "보상 장부"]}
      />
      {kind === "보상 장부" ? (
        <Panel>
          {state.ledger.map((e) => (
            <div className="d-table-row" key={e.id}>
              <span>{e.label}</span>
              <code>{e.kind}</code>
              <strong>{e.amount}C</strong>
            </div>
          ))}
        </Panel>
      ) : kind === "Claim 신청" ? (
        <Panel>
          {state.claims.length ? (
            state.claims.map((s) => (
              <div className="d-table-row" key={s}>
                <strong>{productBySlug(s)?.name}</strong>
                <Badge>권한 확인 대기</Badge>
                <span>서버 검증 전 · 승인 불가</span>
              </div>
            ))
          ) : (
            <Empty
              title="새 Claim 신청이 없습니다"
              action={
                <ButtonLink to="p/agentdesk/claim" secondary>
                  신청 흐름 보기
                </ButtonLink>
              }
            />
          )}
        </Panel>
      ) : f ? (
        <div className="d-two-main">
          <Panel title="제출된 경험">
            <Badge tone={f.source === "User" ? "green" : "purple"}>
              {f.source} Feedback
            </Badge>
            <h2>{f.task}</h2>
            <p>{f.body}</p>
            <blockquote>{f.improve}</blockquote>
            <div className="d-meta">
              <Badge>{f.outcome}</Badge>
              <Badge>사용 경험 자기진술</Badge>
              <Badge>{f.reward ? "후원 미션 · +10C 대기" : "보상 없음"}</Badge>
            </div>
            <Link href={href("feedback/" + f.id)}>원문과 관계 보기 →</Link>
          </Panel>
          <form className="d-panel d-form" onSubmit={(e) => e.preventDefault()}>
            <h2>심사 기준 v1.0</h2>
            <ul className="d-check-list">
              <li>과제와 관련된 구체적인 경험</li>
              <li>증거와 주장 일치 여부</li>
              <li>자기 제품·이해관계·중복 확인</li>
              <li>개인정보·스팸 검토</li>
            </ul>
            <Field label="판정 사유 *">
              <textarea
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="칭찬 여부가 아닌 기준에 따른 사유"
              />
            </Field>
            <div className="d-form-actions">
              <button
                className="d-button secondary"
                disabled={!reason.trim()}
                onClick={() => {
                  dispatch({
                    type: "review",
                    id: f.id,
                    decision: "revision",
                    reason: reason.trim(),
                  });
                  setNotice(
                    "보완 요청을 저장했습니다. 보상은 확정되지 않았습니다.",
                  );
                  setReason("");
                }}
              >
                보완 요청
              </button>
              <button
                className="d-button"
                disabled={!reason.trim()}
                onClick={() => {
                  dispatch({
                    type: "review",
                    id: f.id,
                    decision: "qualified",
                    reason: reason.trim(),
                  });
                  setNotice("적격 판정과 해당 보상을 미리보기에 반영했습니다.");
                  setReason("");
                }}
              >
                적격 확정
              </button>
            </div>
          </form>
        </div>
      ) : (
        <Empty
          title="새 피드백을 모두 확인했어요"
          body="미션에 참여하고 피드백을 제출하면 검토 흐름을 확인할 수 있습니다."
          action={<ButtonLink to="missions">미션 둘러보기</ButtonLink>}
        />
      )}{" "}
      {notice && (
        <p role="status" className="d-green">
          {notice}
        </p>
      )}
    </>
  );
}
