# PR03b — AI1 writer와 입력 경로 결합

사용자의 병렬 개발 지시에 따라 root가 API·파일 소유권·전체 검증을 관리한다. PR03a source b3cfeea 기반의 별도 worktree에서 진행하고, PR436의 실제 merged main254a5bb를 merge75f6a83으로 통합했다. 기본 legacy/epoch1/계약0 및 신규 consumer 비활성은 유지한다.

## 범위와 소유권

| 담당 | 단독 편집 범위 | 격리 DB |
| --- | --- | --- |
| AI1 | agent-review-repository.ts, jobs/agent-review.ts, 신규 agent-review-ownership.ts, agent-review-job unit | 55475 미사용 |
| B5/기존 회귀 담당 | handler-profile.ts 및 배정된 기존 integration8파일/새 receipt fixture. 공유 controller는 root만 편집 | 자체55476 |
| 독립 검증 | 신규 integration/agent-review-item-ownership.test.ts 및 optional 신규 agent-review-item-fixtures.ts | 자체55474 |
| root | 공유 stage/runner/B5 접점, 상세 계획·handoff·Git, 직접/교차 리뷰 및 전체 검사 | 필요 시55477 |

모든 담당은 gpt-6.1-sol/xhigh다. 같은 파일과 DB를 두 담당이 쓰지 않는다. 독립 담당이 먼저 기존 실제 handler의 behavioral RED를 실행한다. import/fixture 오류는 행동 실패로 세지 않는다. source 행동 수정은 그 보고 뒤 시작한다.

## 고정 결정

- 실제 candidate/document/settings/evidence와 attempt를 읽어 binding을 확인한다. plain caller boolean·token/ID 조합만으로 권한을 주지 않는다.
- legacy는 실제 crawl-agent-review job과 stage epoch, item은 실제 ai1 binding/owner/boot/token/epoch를 필수로 요구한다. optional unowned fallback은 없다.
- receipt origin은 fresh/direct_reuse/semantic_reuse를 구분한다. 과거 성공의 token/outcome/usage/completedAt은 바꾸지 않으며 semantic copy는 새 running attempt와 현 token을 쓴다.
- stage SHARE(fetch→ai1→ai2)→기존 domain→attempt→item→catalog jobs 순서다. currentReviewInput의 숨은 조기 job SHARE를 분리한다. 최종 outbox 대기 뒤 wall expiry를 다시 확인한다. HTTP/model 동안 transaction은 없다.
- README HTTP는 기존 claim보다 앞선다. tick 진입과 항목 preflight가 items/draining/foreign owner를 확인해야 하며 source 변경 후 actual input으로 claim한다. 이것만으로 실제 legacy 외부 호출 drain 인증이 완료됐다고 주장하지 않는다.
- stale input/admin/settings는 늦은 결과 적용을 거절하되 건강한 외부 호출의 item을 조기 해제하지 않는다. 실제 호출 정산 뒤 원래 owner의 cleanup/release를 원자 수행한다.
- 재사용/rules/observe/human/error/cancelled를 품질 완료로 세지 않는다. 기존 publication 승인·독립 AI2 gate는 보존한다.
- 기존 runner는 done=false도 processedVersion을 확정한다. entry mode skip이 producer 요청을 그대로 보존한다는 주장은 하지 않는다. runner admission 변경은 root가 별도 실제 회귀와 범위를 결정한다.
- B5는 현재 job-token 인증이다. item UUID를 job token처럼 넣어 인증하지 않는다. 필요한 stage 조회의 최소 profile 권한과 실제 item 인증 확장은 분리한다. 명시 확장 없는 item은 certified 성능에서 제외한다.
- runtime contract 버전을 올리지 않고 새 consumer를 켜지 않는다. legacy 외부 호출 종료의 durable 증거, PR01 실모델 baseline, PR05 공통 호출 슬롯은 별도 남긴다.

## 실행 순서

- [x] 독립 actual mode/foreign-owner behavioral RED 및 정상 control 확인.
- [x] root가 담당 계약을 검토해 exact API·공유 파일 소유권 확정.
- [x] AI1 source와 독립 테스트, 공유 controller의 파일 분리 병렬 구현.
- [x] 새/과거 attempt binding·재사용·실패/취소·stale·expiry·원자 outbox 회귀.
- [x] 기존 AI1·publication·B5 legacy 회귀 보존, 최소 profile 변경의 실제 권한 검사.
- [x] 소유권 반환 뒤 root 직접 리뷰·교차 리뷰·통합. 테스트를 실행한 결과만 기록.
- [ ] 전체 unit/DB·type/lint/i18n/Python/build/bundle·최신 base CI·독립 PR 납품.

소스 동결·소유권 반환과 직접/교차 리뷰를 마쳤다. root 전체 unit2,853·최종 전체 DB1,856/기존TODO1 및 type/lint/i18n/Python23/build/bundle PASS다. 최종 실제 결과는 별도 검증 문서와 delivery/handoff에 기록한다. 원격 필수 CI·납품은 남아 있으며 운영 적용·item B5 인증·2배 처리량은 미검증이다.
