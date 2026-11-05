# 실시간 전체 흐름 · 시스템 진단 중복 감사

2026-11-05 · 검토 기준: main `d40e47bb81d48d112c48b30ddf418909a6e8d968` · 애플리케이션 변경 없음

**기능을 보존하면서 한쪽에서 빼도 되는 중복 노출은 2곳이다. 시스템 진단 메뉴 전체는 유지해야 한다.** 같은 수치를 보여준다는 이유만으로 범위·제어·원본 링크가 다른 화면을 삭제 대상으로 잡지 않았다.

## 완전히 겹치는 노출과 유지 위치

| 대상 | 현재 두 위치 | 권장 유지 위치 | 빼도 되는 부분 / 보존 조건 |
| --- | --- | --- | --- |
| 역할 카드 5개와 scheduler·모델 접수 안내 | 실시간 **역할·점검 창** / 진단 **역할 소유·워커 진행** | **실시간 역할·점검 창** | 진단의 카드 패널만 제거 가능. 두 곳이 동일한 `Workers` 함수를 사용한다. 실시간 머리의 **용량·장비 →** 링크는 진단 패널에 없으므로 유지한다. 진단 상단 역할 상태 요약도 유지한다. |
| **고급 전체 흐름·장애 대응·모든 제어** | 실시간 하단 / 진단 하단에서 불러오기 | **시스템 진단 하단** | 실시간 하단의 고급 화면 사본만 제거 가능. 진단의 기존 `advanced=1` 불러오기와 전체 `FlowBoard`·장애 대응·모델 순위·장비·기록·사람 확인 기능을 보존한다. |

역할 카드의 소유 장비·상태·scheduler·접수 상태는 같은 읽기 계층에서 온다. 탭을 연 시점이나 캐시로 관측 시각·수치가 달라질 수 있지만 기능 차이는 아니다. [동일 Workers 구현과 두 호출 위치](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/PrototypeFlow.tsx#L48), [역할 관측 읽기](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/desk.ts#L93), [진단용 읽기](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/desk.ts#L161).

고급 화면은 동일한 컴포넌트 사본이다. 다만 **진단 첫 화면은 안내와 불러오기 링크만 표시**하고, `advanced=1`일 때 전체 업무·부재 중 기록과 모델 순위를 읽어 같은 `FlowBoard`를 만든다. 진단의 얇은 기본 데이터만 넘기는 식으로 합치면 기능이 누락된다. [고급 공통 요소·두 노출 위치](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/PrototypeFlow.tsx#L83), [불러오기 분기](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/page.tsx#L102), [동일 FlowBoard 생성](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/page.tsx#L122).

## 일부 겹치지만 삭제하면 누락되는 항목

| 비교 대상 | 겹치는 정보 | 다른 기능 · 삭제 시 손실 | 판단 |
| --- | --- | --- | --- |
| 실시간 선택 단계 / 진단 **작업별 실행과 제어** | 잡 상태·최근 성공·멈춤/재개 | 실시간은 선택 단계의 맥락·실제/설정 모델·담당·대기와 연결. 진단은 등록된 전체 잡의 개별 성공/관측·제어를 나란히 제공. 사람 처리·번역·SNS 6종도 포함한다. | 둘 다 유지 |
| 실시간 **단계별 처리·관측 상세** / 고급 단계 표 | 단계·대기·모델·성공 | 실시간은 선택 기간과 공개 결과 행. 고급은 5분/1시간/24시간 동시 비교·보류·사람 확인 행. | 완전 중복 아님 |
| 실시간 **먼저 처리할 일** / 고급 할 일 | 판단할 업무 | 실시간은 판단 섹션 앞 4개 요약. 고급은 경보+판단·전체 보기·상세 서랍. | 고급 기능 보존 |
| 실시간 역할 카드 / 고급 **배포·점검 창** | 역할·접수 상태 | 고급에는 접수 변경 시각·예비 장비 가동 시 복구 절차 안내가 추가됨. | 고급 기능 보존 |
| 양 탭의 **자동 파이프라인 제어**, **모델 접수** 링크 | 같은 목적지 | 어느 탭에서든 실제 제어로 이동하는 공통 동선. 별도 중복 업무 메뉴가 아님. | 유지 |

잡 정의상 최대 17종(주 흐름·사람 처리 13 + 번역 2 + SNS 2)을 읽는다. 실시간의 선택 가능한 주 단계 제어가 직접 다루지 않는 6종은 `split-tiebreak`, `held-qwen-retry`, `product-tagline-ko`, `product-translate`, `hn-talk`, `bluesky-talk`이다. 실제 행 수는 운영 DB에 등록된 잡에 따른다. [잡 묶음 정의](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/lib/operations/flow-response.ts#L21), [읽는 잡 범위](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/page.tsx#L37), [SNS 잡 정의](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/lib/operations/flow-overview-read.ts#L12).

부분 중복의 근거: [선택 상세·실시간 표·요약](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/PrototypeFlow.tsx#L99), [고급 단계 상세](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/FlowBoard.tsx#L277), [고급 3기간 표](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/FlowBoard.tsx#L524), [고급 할 일](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/OperatorDesk.tsx#L169), [고급 점검 창](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/OperatorDesk.tsx#L245).

## 독립 기능과 최종 배치안

| 메뉴 | 유지할 내용 | 운영자가 확인하는 일 |
| --- | --- | --- |
| **실시간 전체 흐름** | 등록 프로젝트·발행 추이, 9단계 흐름·선택 단계 상세/제어, SNS 수집·사이트 발행 흐름, 먼저 처리할 일·자리 비운 사이, 단계별 처리·관측 상세, 역할·점검 창 | 지금 막힌 위치·결과·우선 개입을 한 화면에서 확인 |
| **시스템 진단** | 흐름/역할/중지/모델 접수 요약, 수집 소스별 상태, 작업별 실행과 제어, 상세 진단 링크, 고급 전체 흐름 1곳 | 소스·잡·증거를 비교하고 구체적으로 조치 |
| **할 일·변경 기록** | 개인 부재 중 변화·최근 설정과 제어·원본 감사 기록 동선 | 누가 무엇을 바꿨는지 확인 |

진단의 **수집 소스별 상태**는 GitHub·Show HN·한국어 프로젝트 각각의 상태/마지막 성공과 상세 제어 링크를 제공한다. 소스별 1시간 신규량은 현재 `— / 소스별 완료량 미집계`이므로 독립 집계가 있는 것으로 해석하지 않았다. **상세 진단**의 검색·검수·색인 반영 확인, 언어별 번역 실패, 모델 장부·실제 종료 근거 링크도 유지한다. [진단 전용 패널](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/flow/PrototypeFlow.tsx#L85).

`/admin/status`는 내비게이션 선택 표시가 시스템 진단에 묶여 있어도 **원본 공급·잡·파이프라인을 제어하는 별도 화면**이다. 진단과 이름이 비슷하다는 이유로 라우트나 메뉴 동선을 없애면 안 된다. [메뉴와 기존 화면 매핑](https://github.com/JRVector9/nomorevibe/blob/d40e47bb81d48d112c48b30ddf418909a6e8d968/app/(operator)/admin/workspace-navigation.ts#L94).

## 적용 경계

- 이번 결과는 **정리 대상과 보존 조건 보고**다. 메뉴·패널·API·DB·운영 설정은 변경하지 않았다.
- 실제 정리 시 삭제 범위는 위 2개 **사본 노출 위치**뿐이다. `FlowBoard` 구현과 진단의 full desk/모델 순위 로더를 삭제하지 않는다.
- 실시간의 KPI·할 일·부재 중 기록이 사용하는 공통 읽기는 유지한다. 고급 사본 제거만으로 모든 공통 DB 읽기를 없앨 수 없다.
- 정적 소스 대조만 수행했다. 기능 테스트·운영 측정은 실행하지 않았으며 성능 개선 수치를 주장하지 않는다.
