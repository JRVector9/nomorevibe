# GPU3090 Tailscale 연결 시험 — 2026-10-25

사용자 최신 지시는 abcLLM 연결을 유지하면서 GPU3090 Tailscale `http://100.77.43.63:8090/v1`을 연결 시험하는 것이다. 내부망 `192.168.50.208`은 사용하거나 시험하지 않았다. AI2 직접 provider 전환 구현은 중단하고 미완성 초안은 비공개 증거 경로에 보존했다.

2026-10-25 23:48:07 KST, 실행 중인 운영 AI2 consumer 컨테이너에서 시험했다. 정확한 서비스는 `nomorevibe-ai2-consumer-m3-dym3m7`, instance `ai2-consumer-m3`, release `be71a75aade94858218faca0e2c012ed5dd69dc8`이다. 서비스 ID·컨테이너 Running·instance를 확인했다.

| 항목 | 실제 결과 |
|---|---|
| `/health` | HTTP200,37ms |
| `/v1/models` | HTTP200,10ms; `qwen3.8-flash-next`; max_model_len50000 |
| 요청 직전 부하 | running0,waiting0 |
| `/v1/chat/completions` | HTTP200,305ms; stop; 지정 JSON schema/marker 정상 |
| 토큰 | 입력45,출력16,합계61 |
| thinking | `chat_template_kwargs.enable_thinking=false` 전송; reasoning_tokens0,reasoning_content0자 |

이는 고정된 짧은 합성 연결 시험 1회다. 실제 제품 검수·결과 DB 저장·fallback·25k 긴 입력 시험은 아니다. 검증된 모델 문맥 상한은50000이며, 요청 입력+출력 합계25000은 그 안에 들어가지만 실제 정책/증거/출력 예약을 포함한 제한 검증은 남는다. 입력25000과 출력25000을 각각 쓰는 설정은 정책·템플릿 여유를 따로 확인해야 한다.

운영 AI2 모델 설정·capacity policy·서비스·배포 변경0. 모델 POST는 위 합성1회뿐이다. 짧은 응답이므로 이305ms를 실제 검수 지연으로 일반화하지 않는다. 로컬에서도 GET health/models/metrics200을 확인했다.

비공개 증거: `/Users/jr/.local/state/nomorevibe-reliability-20261025/gpu3090-tailscale-test-20261025T144726Z/verified-summary.safe.json`와SHA manifest. directory0700/files0600/fsync 보존.
