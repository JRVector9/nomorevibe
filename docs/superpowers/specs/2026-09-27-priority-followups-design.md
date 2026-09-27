# 공개 저장소 및 검색 파이프라인 후속 설계

사용자는 2026-09-27 제안한 우선순위 1·2 → 4·5 → 3·6의 실행을 승인했다.

1. main에 관리자 포함 PR+GitHub App15368의 check 성공+최신 base 필수, force push/delete 차단. 혼자 운영하므로 다른 사람 승인 수는0. Secret scanning/push protection/Dependabot 보안 업데이트 켜기. 설정 API 결과로 검증한다.
2. maintenance의 product-search-health를15분마다 예약한다. 공개 제품을 동일 REPEATABLE READ / READ ONLY 스냅샷에서500개씩 조회하고 실제 JS canonical hash와 검색 키워드 사본을 대조한다. 정상 needs_refresh는 불일치 결함에서 제외한다. 누락·생성/검수 대기·검수 최장 대기·반복 실패/한도·최근15분 생성/검수 수를 집계한다. DB statement_timeout과 전체30초 제한, lease/budget 중단을 지킨다. 제품/프로필은 수정하지 않는다. runner의 기존 job 관측에 숫자·boolean만 저장한다. admin/status는 마지막 검증 시각과 경고를 표시하며 관측이 없거나45분 이상 오래됐으면 정상으로 보이지 않는다. 개인정보/원문/토큰을 로그에 남기지 않는다. 외부 이메일·Slack 발송은 범위 밖이다.
3. 검수 실패 invalid_output 또는 전체 timeout이 이전 회차에 기록됐으면 다음 정상 재시도에서 키워드를 중복 제거 후5개씩 순차 검수한다. 처음부터 추가 전체 호출을 하지 않고 실패 이전 backoff를 지킨다. 제품당 총60초/틱잔여예산을 공유한다. 모두 성공할 때만 합집합을 기존 저장 경로에 전달한다. 한 묶음이라도 불완전/중복/unknown/nonboolean이면 전체 실패, abort/부족한 tick 시간은 제품 실패로 세지 않는다. 같은 모델과 strict parser, 기존 hash/profile version/lease 저장 guard를 유지한다.
4. CI는 workflow_dispatch, permissions contents:read, 동일 PR/branch 실행 취소, timeout20분을 추가한다. 공식 최신 Node24 호환 checkout/setup-node 릴리스를 SHA 고정해 v4 runtime 경고를 해소한다. 서비스PG17과 현재 전체 검사 순서는 유지한다. 실제 hosted CI에서 검증한다.
5. PENDING/AGENTS의 첫 배포 전이라는 낡은 주장을 제거한다. 이전 실측과 현재 배포/복구/CI 완료를 구별하고, 백업 복구·24시간 운영 관측 등 이번에 확인하지 않은 항목은 미검증으로 남긴다.

감시와 검수는 각각 독립 PR, CI/문서는 마지막 PR로 분리한다. PR의 실제 CI 통과 후 병합하고 기존 자동 배포와 운영 health/감시 관측까지 확인한다. 사용자 search-judgments.json/untracked 자료는 커밋하지 않는다.
