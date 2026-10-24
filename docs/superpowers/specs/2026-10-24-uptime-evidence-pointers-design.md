# Uptime 근거 필드 경로 계약

실제 Qwen 첫 확인 호출은 `closed/explicit_shutdown`을 반환했지만 `evidence.supports`에 상태 값인 `/state/closed`를 써서 `invalid_evidence_pointer`로 거절됐다. 원본은 비공개 평가 디렉터리에 보존한다.

승인된 수정은 uptime 출력의 근거 경로를 `/state/page_state`, `/state/finding`으로 제한하고 프롬프트에 필드 경로와 상태 값의 차이를 설명하는 것이다. 기존 의미 검증·인용 검증·기권 처리는 유지한다. 프롬프트만 수정하면 JSON Schema가 같은 오류를 계속 허용한다. 잘못된 출력을 서버에서 고치면 모델이 제시하지 않은 근거 연결을 만들어 내므로 사용하지 않는다.

공통 업무의 wire 버전은 유지한다. 허용하던 정상 uptime 출력은 그대로 유효하고, 기존 런타임에서 거절하던 경로만 앞단 Schema에서도 거절하는 호환 축소다. uptime 전용 계약 revision과 새 JSON Schema·prompt hash로 이전 실제 평가와 구분한다. 기존 큐의 source unique 키와 다른 네 업무의 버전·프롬프트는 바꾸지 않는다.

검증은 실제 실패의 비민감 구조를 고정한 RED 회귀로 시작한다. 두 정상 필드 경로와 다른 업무 경로가 계속 유효한지 검사하고, 관련 회귀·TypeScript·변경 파일 lint를 실행한다. 실제 모델 추가 호출·운영 쓰기·배포는 이 변경에 포함하지 않는다.
