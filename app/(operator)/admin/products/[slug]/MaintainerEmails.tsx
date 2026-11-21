import type { MaintainerEmailAdminView } from "@/lib/domain/makers/maintainer-emails-admin";
import { formatDetailTime } from "@/lib/format/time";
import { PrototypeEmpty, PrototypePanel, PrototypeTag } from "../PrototypeParts";
import { MaintainerEmailDeny } from "./MaintainerEmailDeny";

/**
 * 제작자 커밋 이메일 — 관리자 전용 비공개(0194). 서버 부품이라 주소는 관리자 화면 HTML 에만 실린다(공개 화면은 이 부품을 쓰지 않는다).
 * 줄마다 「지우고 다시 모으지 않기」 단추가 있다 — 브라우저 부품에는 주소 대신 거부 목록 열쇠와 가린 주소만 넘긴다.
 * 메일 보내기 단추는 두지 않는다 — 발송 전에 GitHub 이용 정책·정보통신망법 검토가 따로 필요하다.
 */
export function MaintainerEmailsPanel({ slug, view }: { slug: string; view: MaintainerEmailAdminView | null }) {
  const note = "탐색(AI 제작 근거 확인) 때 최근 커밋 30개 중 저장소 주인 계정이 쓴 커밋의 주소입니다. 조직 저장소·다른 기여자·GitHub 비공개 주소·봇·AI 도구 주소는 모으지 않습니다. 외부에 공개하지 않고, 마지막 확인 뒤 1년이 지나면 지웁니다.";
  return <PrototypePanel title="제작자 이메일 (관리자 전용·비공개)" note={note}>
    {view === null ? <PrototypeEmpty>제작자 이메일을 읽지 못했습니다.</PrototypeEmpty>
      : view.repositoryKey === null ? <PrototypeEmpty>GitHub 저장소가 없는 프로젝트라 모으지 않습니다.</PrototypeEmpty>
      : view.rows.length === 0 ? <PrototypeEmpty>모은 주소가 없습니다. 개인 계정 저장소에서 주인이 쓴 커밋이 있으면 다음 AI 제작 근거 확인 때 채워집니다(조직 저장소·포크는 모으지 않습니다).</PrototypeEmpty>
      : <div className="table-scroll"><table data-admin-maintainer-emails=""><thead><tr><th>이메일</th><th>작성자 / GitHub</th><th>최근 커밋 수</th><th>처음 / 마지막 확인</th><th>관리</th></tr></thead><tbody>
        {view.rows.map(row => <tr key={row.denyKey}><td><code>{row.email}</code></td><td>{row.name ?? "이름 없음"}<p>{row.login ? `@${row.login}` : "계정 연결 없음"}</p></td><td><PrototypeTag>{row.commits}개 / 30</PrototypeTag></td><td>{formatDetailTime(row.firstSeenAt)}<p>{formatDetailTime(row.lastSeenAt)}</p></td><td><MaintainerEmailDeny slug={slug} denyKey={row.denyKey} masked={row.masked} /></td></tr>)}
      </tbody></table></div>}
  </PrototypePanel>;
}
