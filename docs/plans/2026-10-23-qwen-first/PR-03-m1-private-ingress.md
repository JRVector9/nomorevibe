# PR-03 M1 모델의 인증된 사설 호출 경로를 준비한다

상태: **설계 완료 · 구현 전** · 제안 브랜치: `feat/qwen-first-m1-private-ingress` · 설계 기준: `c37ae82f`

선행 PR: [PR-02](PR-02-direct-capacity.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

## 문제와 결과

M1 oMLX는 loopback:8000이고 이번 bench는 SSH 내부 실행이었다. renderer HTTP8791은 모델 프록시가 아니므로 기존 운영 경로를 그대로 쓸 수 있다고 단정할 수 없다.

기존에 검증된 사설 gateway/tunnel이 있으면 재사용한다. 없으면 oMLX loopback을 유지하는 단일 인증 사설 forwarder 설치물·worker 설정을 준비한다. 실제 설치·활성화는 최종 승인 rollout 단계다.

## 수정 범위

- M1 사설 모델 ingress가 없으면 고정 upstream127.0.0.1:8000, Tailscale 전용 바인딩·인증·허용 출처·필수 경로만 제공하는 별도 forwarder를 설계한다. 공개 바인딩이나 임의 URL 프록시는 제외한다.
- 이번 PR에서 oMLX 외부 bind·모델·서버 설정을 바꾸지 않고 설치물을 검토 가능하게 만든다. API 키를 로그·응답·저장소에 남기지 않는다.
- mini 예비 reviewer에서 확인한 값은 render=M1, 모델 환경변수 없음→GPU 기본값이다. M3 주 reviewer 환경은 미확인이다. 실제 M1 추론으로 구성된 작업끼리만 전역1슬롯을 공유한다.
- 모델/finish_reason/usage/오류를 원문대로 전달한다. relay가 stop을 합성하거나 HTTP timeout을 원격 종료 증거로 만들지 않는다.
- 기존 Qwen HTTP adapter는 재사용하되 SSH bench 스크립트를 생산 transport로 복사하지 않는다.
- GPU core 개발·검증·릴리스의 필수 선행 조건이 아니다. M1이 준비되지 않으면 해당 backend만 비활성이고 GPU가 같은 지원 작업 큐를 처리한다.

## 포함하지 않는 변경

- 없음.

## 파일과 데이터 변경

기존 파일:

- [lib/screen-review/vision-review.ts](../../../lib/screen-review/vision-review.ts)
- [lib/crawl/qwen-direct-review.ts](../../../lib/crawl/qwen-direct-review.ts)
- [docs/operations/production-multi-instance.env.example](../../../docs/operations/production-multi-instance.env.example)
- [scripts/ops/screen-render.sh](../../../scripts/ops/screen-render.sh)

신규 제안 파일:

- `scripts/local-model-relay/server.ts` (신규 제안 경로, 구현 시 확정)
- `scripts/ops/local-model-relay.sh` (신규 제안 경로, 구현 시 확정)
- `docs/operations/local-model-private-ingress.md` (신규 제안 경로, 구현 시 확정)
- `tests/local-model-relay.test.ts` (신규 제안 경로, 구현 시 확정)

Migration: 없음 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- 잘못된 인증·출처·경로·임의 대상·초대형 body를 거절하고 두 요청이 와도 upstream 생성은 하나인지 확인한다.
- 반쪽 응답·독자 취소 때 terminal을 합성하지 않고 비밀값이 노출되지 않는지 검사한다.
- 최종 승인 후 M3 주·mini 실제 컨테이너에서 models/health와 제한 canary를 검증한다. 이 설계 단계에서 수행했다고 쓰지 않는다.

완료 조건:

- 설치물·접근 경계·종료 의미와 rollback이 검토 가능하다. 실제 환경 검증 전에는 M1 readiness=false이고 새 M1 route는 활성화하지 않는다.
- GPU 긴급 경로를 막지 않는다는 뜻이며 최종 M1 상시 활용 목표에서는 필수다. M1 사설 경로·실제 컨테이너 접근·단일 물리 슬롯·큐 공동 처리 검증 전에는 전체 분산 도입 완료로 표시하지 않는다.

## 적용 전 확인

- 없음.

## 중단과 되돌림

- M1 새 admission 중단→기존 호출 drain→추가 forwarder/worker route 해제. renderer와 oMLX loopback은 별도이며 GPU 경로는 영향받지 않는다.

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.
