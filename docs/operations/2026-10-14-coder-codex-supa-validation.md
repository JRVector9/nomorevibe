# Coder 승인분 Codex CLI 검증 및 복구된 supa Qwen 비교 — 2026-10-14

최근 24시간 `qwen3-coder:30b` 승인 고유 후보 827개에서 무작위 100개를 뽑아, **당시와 같은 원본·같은 정책**으로 검증했다. Codex CLI `gpt-6.1-sol / xhigh`는 승인 82·거절 15·보류 3, 복구된 `[supa] Qwen3.8-27B-NVFP4`는 승인 69·거절 14·보류 2·실패 15였다.

Qwen은 Coder가 승인한 일부 명확한 제외 대상을 걸러냈지만, 빈 포트폴리오를 승인하는 판단 오류와 출력 실패가 남아 있다. **가용성 복구는 확인했으나, 이 결과만으로 Qwen의 전반적인 품질 우위를 확정할 수 없다.** 운영 모델 설정과 공개 판정은 이번 검증에서 변경하지 않았다.

## 표본과 검증 방법

- 추출 기준 시각: 2026-10-14 **10:10:55.072 KST**. 그 시점의 최근 24시간 Coder 승인분에서 후보당 최신 승인 하나를 선택했다.
- 현행 prompt/rules `2026-10-06.2`, policy hash `7711f773d38840456d85b2ab7e7765ef883bad915ce2de06dc90146817f2a233`와 일치하는 기록만 포함했다. AI1 `[MLX] gpt-oss-120b`가 먼저 승인했고, Coder가 오류 없이 승인했으며, 입력 hash·1차 세대·당시 유효기간이 일치하는 827개가 모집단이다.
- seed `2026-10-14-coder-approved-audit-v1`와 candidate ID를 결합한 SHA256 순서에서 100개를 선택했다. website 92·installable 8이며, 추출 시 100개 모두 published였다. 선택된 원승인 시각은 10/13 10:28:05.832~10/14 10:02:53.980 KST이다. 100개 모두 기본 모델 실패 뒤 생성된 fallback 승인 기록이다.
- 고정 snapshot 100개의 canonical 입력 hash를 서비스와 같은 방식으로 재계산해 저장된 hash와 전부 일치함을 확인했다. 현재 홈페이지나 README를 새로 수집하지 않았다.
- Codex에는 운영 `REVIEW_SYSTEM_PROMPT`와 case ID·snapshot만 제공했다. 기존 AI1/Coder의 판정·사유와 공개 상태는 숨겼다. 직접 CLI를 10건씩 10회 호출했고, 읽기 전용에서 고정 파일만 읽었다. 네트워크·운영 쓰기·다른 에이전트 호출은 금지했다.
- Qwen은 기존 운영 `reviewWithGateway`로 같은 snapshot을 건당 호출했다. 기존 인증 환경, concurrency 2, timeout 60초, raw context, temperature 0, 운영 출력·근거 ID 검증을 그대로 사용했다. 호출 전 운영 prompt SHA256 `29c1bd746d239afaa2f99c7318a4aea867c2a36f40a48b25571a3a53c59c8ceb`의 일치를 확인했다. 이전 모델의 판정을 전달하지 않았다.
- Qwen live 목록 복귀 확인: **10:18:24.600 KST**. 최초 100건 호출: **10:19:54.062~10:26:20.578 KST**. 별도 형식 진단 응답에서 gateway alias가 반환한 model 필드는 `Inferact/Qwen3.8-27B-NVFP4`였다. 실제 checkpoint 구성까지 검증한 것은 아니다.

## 최초 100건 결과

| 모델 / 평가 방식 | 승인 | 거절 | 보류 | 실패 | 완료 대상 |
|---|---:|---:|---:|---:|---:|
| qwen3-coder:30b / 저장된 원판정 | 100 | 0 | 0 | 0 | 100 |
| gpt-6.1-sol xhigh / 직접 Codex CLI | 82 | 15 | 3 | 0 | 100 |
| supa Qwen3.8-27B-NVFP4 / 운영 adapter 재호출 | 69 | 14 | 2 | 15 | 100 |

Coder의 100/100 승인은 표본 선정 조건이다. Coder의 성공률이나 정답률을 의미하지 않는다. Codex의 82건 재승인도 전체 정확도 82%를 의미하지 않는다.

### Codex와 Qwen 교차표

| Codex 판정 ↓ / Qwen 판정 → | 승인 | 거절 | 보류 | 실패 | 합계 |
|---|---:|---:|---:|---:|---:|
| 승인 | 65 | 3 | 1 | 13 | 82 |
| 거절 | 2 | 10 | 1 | 2 | 15 |
| 보류 | 2 | 1 | 0 | 0 | 3 |
| 합계 | 69 | 14 | 2 | 15 | 100 |

Qwen이 유효한 판정을 낸 85건 중 Codex와 같은 판정은 **75건(88.2%)**이며, 유효 판정이 서로 다른 건은 10건이다. 나머지 15건은 Qwen 실패라 비교 가능한 판정이 없다. 이는 모델 간 일치율이다.

Codex 거절 15건 중 Qwen도 거절한 것은 10건이다. Qwen은 2건을 승인하고 1건을 보류했으며, 2건은 출력 실패했다. installable 8건은 Codex가 모두 승인했지만, Qwen은 승인 5·실패 3이었다.

## Coder 승인에서 확인한 문제

root가 Codex 거절 15건의 원문과 현행 정책을 다시 대조했다. 13건은 제목만 있거나 JavaScript 안내만 있는 website 입력, 1건은 제3자 패키지 등록 페이지, 1건은 마케팅·웹 제작 대행 서비스 판매 사이트였다. **제공된 snapshot과 현행 규칙 기준으로 승인 근거가 부족하거나 명시된 제외 조건에 해당한다.** 현재 실제 브라우저에서 사이트가 동작하지 않는다는 뜻은 아니다. HTML 수집 결과가 앱 화면을 담지 못했다면 수집·렌더링 개선이 별도로 필요하다.

| ID | 저장소 | Codex | Qwen | Codex 거절·보류 근거 |
|---|---|---|---|---|
| 284546 | [Ovrksae/bl-ack-major.github.io](https://github.com/Ovrksae/bl-ack-major.github.io) | 거절 | 거절 | pageText가 포트폴리오 제목뿐이며 개인 이력이나 작품을 보여 주는 화면 내용이 없다. |
| 283167 | [gasToledo/Milantus](https://github.com/gasToledo/Milantus) | 거절 | 거절 | pageText가 제품 제목뿐이며 앱 기능이나 사용할 수 있는 화면 내용이 없다. |
| 283403 | [euangoddard/ad-nauseam](https://github.com/euangoddard/ad-nauseam) | 거절 | 실패 | 화면에는 제목과 JavaScript 필요 안내만 있어 게임이나 사용 가능한 화면이 표시되지 않았다. |
| 283538 | [damiruali014-lab/sitescout](https://github.com/damiruali014-lab/sitescout) | 거절 | 거절 | pageText가 ‘SiteScout — find businesses that need a website’라는 제목 한 줄뿐이다. |
| 284156 | [Fighter90/hyrekit_fsp](https://github.com/Fighter90/hyrekit_fsp) | 거절 | 거절 | pageText가 'HyreKit — подбор ИТ-специалистов ФСП'라는 제품 제목만 표시합니다. |
| 281236 | [NuonVannsonleng/Meh-Rean](https://github.com/NuonVannsonleng/Meh-Rean) | 거절 | 거절 | pageText가 제품명 'Meh Rean'만 표시합니다. |
| 285747 | [caueprado204-ops/Easy-study](https://github.com/caueprado204-ops/Easy-study) | 보류 | 거절 | ‘Bem-vindo ao Easy Study’와 사용자명·짧은 문구만 보여 학습 도구의 사용 화면인지 미완성 화면인지 확정하기 어렵다. |
| 284921 | [Mateeb11/portfolio-v2](https://github.com/Mateeb11/portfolio-v2) | 거절 | 승인 | pageText에는 ‘Mateeb Alharbi · AI Engineer’라는 제목만 있고 프로필 본문이 보이지 않는다. |
| 285548 | [DamienMarill/devtober](https://github.com/DamienMarill/devtober) | 거절 | 거절 | pageText가 ‘Devtober 2026’라는 제목뿐이어서 창작물이나 사용 가능한 화면이 보이지 않는다. |
| 284750 | [letya999/grill-my-resume-as-manager](https://github.com/letya999/grill-my-resume-as-manager) | 거절 | 실패 | 대상 URL은 실제 스킬의 자체 홈페이지가 아니라 skills.sh의 개별 패키지 등록 페이지다. |
| 280822 | [Matz1pan/portfolio](https://github.com/Matz1pan/portfolio) | 거절 | 거절 | 개인 이름과 경력이 있지만 고객의 마케팅·웹 제작을 대행하고 상담·견적을 받는 서비스 판매 사이트다. |
| 287114 | [projeffboy/my-pokemon-team](https://github.com/projeffboy/my-pokemon-team) | 거절 | 거절 | 제품명과 “You need to enable JavaScript to run this app.” 안내만 표시되는 앱 셸이다. |
| 284146 | [jbang2004/long-wind](https://github.com/jbang2004/long-wind) | 보류 | 승인 | 제목 외에 “天苍苍 · 野茫茫 剑”도 표시되지만, 게임 화면인지 미렌더링 화면인지 확정할 정보가 부족하다. |
| 287003 | [muuvmuuv/muuvmuuv](https://github.com/muuvmuuv/muuvmuuv) | 거절 | 승인 | pageText가 사이트 제목만 표시한다. 개인 포트폴리오라는 설명만으로는 승인할 수 없다. |
| 287734 | [GitFenix1113/mecharashi-tools](https://github.com/GitFenix1113/mecharashi-tools) | 거절 | 보류 | pageText가 사이트 제목뿐이며 자료 조회나 시뮬레이터 화면은 표시되지 않는다. |
| 281261 | [Timothymycompc/solana-pulse-ai-agent-gateway](https://github.com/Timothymycompc/solana-pulse-ai-agent-gateway) | 거절 | 거절 | pageText가 제품명과 부제 한 줄뿐이며 공개 기능이나 사용 안내 본문이 없다. |
| 283646 | [RiqueBitt/ProjectClub](https://github.com/RiqueBitt/ProjectClub) | 거절 | 거절 | pageText가 제품명 'Project Club'만 표시한다. README의 기능 설명은 제목뿐인 웹 화면을 대체할 수 없다. |
| 282323 | [bfogels/infergrade-runner](https://github.com/bfogels/infergrade-runner) | 보류 | 승인 | 모델 비교 목적과 메뉴는 보이지만 핵심 본문이 'Loading measured setups…'에 머물러 제품 소개 페이지인지 로딩 중인 앱 화면인지 확정하기 어렵다. |

### Qwen이 놓친 명확한 제외 조건

- **Mateeb / 284921:** pageText는 개인 이름·직함으로 된 제목 한 줄뿐이다. Qwen은 README의 개인 포트폴리오 설명으로 승인했다. 현행 website 정책은 프로필도 제목만 보이면 거절하며 README가 이를 대체할 수 없다고 명시한다.
- **Marvin.Digital / 287003:** pageText가 사이트 제목과 동일하다. Qwen은 포트폴리오 메타데이터·README를 근거로 승인했다. 같은 제목 전용 제외 규칙에 해당한다.
- **Milkhama / 287734:** Qwen도 제목뿐이라고 인식했지만 README와 최근 저장소 활동을 근거로 보류했다. 현행 규칙은 이 경우 거절이며, 저장소 활동은 화면 본문을 대체하지 못한다.

### 사람이 기준을 붙이거나 화면 증거를 보강할 경계 사례

| ID / 사례 | Codex | Qwen | 판단이 갈린 지점 |
|---|---|---|---|
| 282743 / Fusion | 승인 | 거절 | 플랫폼 기능·의존성 패키지 설명과 도입·개발 서비스 판매가 함께 있다. Qwen은 대행 서비스, Codex는 자체 플랫폼 소개로 보았다. |
| 281294 / Naija Votes | 승인 | 거절 | 로딩 문구와 게임 목적·키보드 조작법이 함께 있다. Codex는 랜딩 설명, Qwen은 미렌더링 셸로 보았다. |
| 281744 / Skip | 승인 | 거절 | 반응형 프로그래밍 프레임워크 소개·탐색 문구가 있으나 본문이 짧다. Codex는 프로젝트 소개, Qwen은 제목 전용 페이지로 보았다. |
| 280987 / Kopf frei | 승인 | 보류 | GTD·목록·추가 UI 문구가 짧게 보인다. 실제 앱 화면 증거가 빈약하다. |
| 285747 / Easy Study | 보류 | 거절 | 환영·사용자·목표 문구는 있으나 학습 기능의 표시를 확인하기 어렵다. |
| 284146 / Long Wind | 보류 | 승인 | 게임의 가시 텍스트가 짧다. Canvas/WebGL 화면을 텍스트 수집만으로 확인하기 어렵다. |
| 282323 / Infergrade | 보류 | 승인 | 모델 비교 소개·메뉴가 있으나 핵심 데이터가 로딩 상태다. |

이 7건에는 이번 보고에서 사람의 확정 정답을 붙이지 않았다. Codex 판정을 무조건 정답으로 취급하지 않는다.

## Qwen 출력 안정성

최초 호출 100건 중 유효 판정 85건·실패 15건이다. 응답 시간은 실패를 포함해 중앙 **3.900초**, p95(nearest rank) **7.576초**, 최대 **60.002초**였다. 이 표본의 동시 2건·단일 회차 결과로 장기 성공률이나 운영 최대 처리량을 확정하지 않는다.

| 실패 유형 | 건수 |
|---|---:|
| invalid_output / invalid_json | 12 |
| invalid_output / review_unknown_evidence | 1 |
| gateway_error | 1 |
| timeout | 1 |

최초 실패 기록을 유지한 채 JSON 오류 3건만 같은 adapter·원본으로 별도 재호출했다(10:26:33.701~10:27:44.824 KST). 286209는 승인에 성공, 283403은 다시 invalid_json, 284750은 timeout이었다. **재호출 성공을 최초 100건의 성공으로 바꿔 집계하지 않았다.**

283403의 재응답은 같은 판정 JSON을 세 번 출력하고 중간에 예상하지 않은 종료 태그를 붙였다. 현행 `parseGatewayContent`는 첫 `{`부터 마지막 `}`까지 한 JSON으로 파싱하므로 실패한다. 이 사례에서 형식 오류를 재현했으며, 최초 JSON 오류 12건이 모두 같은 원인이라는 증거는 아니다. 형식 진단 외에 파서나 모델 응답 템플릿은 수정하지 않았다.

## 후속 작업 순서

1. **supa 응답 형식 안정화:** gateway의 채팅 템플릿·중복 JSON 출력부터 확인한다. 파서 변경이 필요하면 서로 다른 여러 판정 중 하나를 임의 채택하지 않도록 검증한다. 같은 100건으로 형식 실패가 줄었는지 다시 측정한다.
2. **명확한 제외 조건 회귀 검증:** 제목 전용·JS 셸·제3자 등록 페이지·대행 서비스 사례를 현행 정책 기준의 라벨로 고정하고, AI1·Coder·Qwen을 함께 검사한다. 표본의 AI1도 전부 승인한 입력이므로 Coder만의 문제라고 한정하지 않는다.
3. **경계 입력의 증거와 기준 보강:** Canvas/WebGL·짧은 앱 UI·제품과 서비스 혼합 페이지의 렌더링 증거 또는 사람 라벨을 확보한다. 텍스트 길이만으로 정상 앱을 차단하는 규칙을 이번 결과만 보고 추가하지 않는다.
4. **양쪽 판정 표본으로 모델 선택:** 승인뿐 아니라 거절·보류 사례를 포함한 사람 라벨 집합으로 오승인·오거절·보류·출력 실패를 비교한 뒤 기본·예비 모델의 적합성을 결정한다.

위 작업은 제안이며 이번 비교에서 구현·배포하지 않았다. 기본 모델은 이미 기존 설정에 남아 있었으므로 모델 목록 복귀를 확인하기 위해 설정을 바꿀 필요가 없었다.

## 실행 증거와 사용량

CLI 버전 `0.162.1`. 직접 실행한 명령 형태:

```sh
codex exec --ignore-user-config --ephemeral \
  -m gpt-6.1-sol -c model_reasoning_effort=xhigh \
  -s read-only --skip-git-repo-check -C <blind/batch-XX> \
  --output-schema <schema.json> --json -o <batch-result.json> <고정 prompt>
```

10개 CLI 프로세스 전부 exit 0, 입력 ID 100개와 출력 ID 100개 일치, 중복·누락 0, 근거 인용의 원문 substring 검증 오류 0을 확인했다. 배열 필드 인용의 `[index]`와 `.index` 표기를 모두 해석해 검증했다. Qwen도 100개의 결과 또는 실패 기록을 남겼고 adapter가 유효 판정의 schema·근거 ID를 검사했다.

| 호출 | 입력 토큰 | 입력 중 캐시 토큰 | 출력 토큰 | 보고된 입력+출력 |
|---|---:|---:|---:|---:|
| Codex CLI 10회 / 100건 | 2,556,182 | 1,987,968 | 67,218 | 2,623,400 |
| Qwen 최초 100회 | 362,300 | 미보고 | 14,981 | 377,281 |
| Qwen 별도 형식 진단 3회 | 5,699 | 미보고 | 440 | 6,139 |

캐시 토큰은 입력 토큰에 포함되므로 합계에 다시 더하지 않는다. Codex는 도구 읽기·추가 추론을 포함한 각 `turn.completed.usage`의 누적값이다. Qwen 최초 호출은 98건, 별도 진단은 2건에서만 usage를 받았으므로 Qwen 수치는 보고된 사용량의 합이며 미보고 호출 비용까지 포함한 확정 합계가 아니다. CLI 10건 묶음·xhigh와 gateway 단건 호출의 사용량·시간을 직접 비용 또는 성능 비교로 환산하지 않는다.

원본·모델 응답·호출 receipt는 로컬 private 폴더 `/private/tmp/nomorevibe-coder-codex-validation-20261014`에 저장했다. 공유 문서에는 원시 snapshot과 인증정보를 넣지 않았다. 운영 후보·판정·발행은 쓰지 않았으며, 사용자가 중단한 소개 검수도 재개하지 않았다. 앱 코드 변경이 없어 unit·integration·build는 실행하지 않았다.

재집계 명령(새 모델 호출 없음):

```sh
python3 /private/tmp/nomorevibe-coder-codex-validation-20261014/collect.py final
python3 /private/tmp/nomorevibe-coder-codex-validation-20261014/compare.py final
```

## 해석의 한계

- Coder 승인에 조건을 건 표본이다. 전체 심사 정확도·오거절률·전체 부적합 비율을 계산할 수 없다.
- Codex와 Qwen은 입력·판정 정책은 같지만, CLI 도구 사용·묶음 처리·추론 설정·출력 schema는 다르다. 모델 자체만의 우열을 분리한 실험은 아니다.
- 판단 근거는 당시 수집된 텍스트다. 현재 사이트의 실제 기능, 브라우저 렌더링, 코드 품질, AI 제작 여부를 검증한 결과가 아니다.
- root는 거절·보류와 유효 판정 불일치 사례를 다시 확인했다. 100개 전체를 사람이 독립 라벨링한 정답 데이터는 없다.

## 전체 100개 대조표

Coder 원판정은 모든 행에서 승인이다. 링크는 해당 공개 저장소이며, 현재 상태에 대한 새 판정을 의미하지 않는다.

| ID | 저장소 | 접근 모드 | Codex | supa Qwen | Qwen 실패 상세 |
|---|---|---|---|---|---|
| 278304 | [sayands/sayands.github.io](https://github.com/sayands/sayands.github.io) | website | 승인 | 승인 |  |
| 279980 | [Shashank2577/cairn](https://github.com/Shashank2577/cairn) | website | 승인 | 실패 | invalid_output/invalid_json |
| 280195 | [mileslow702-cpu/NORTHSTAR](https://github.com/mileslow702-cpu/NORTHSTAR) | website | 승인 | 승인 |  |
| 280218 | [tian-yu200/dsh-solidworks](https://github.com/tian-yu200/dsh-solidworks) | installable | 승인 | 승인 |  |
| 280417 | [maor700/arigami](https://github.com/maor700/arigami) | website | 승인 | 승인 |  |
| 280424 | [w00ing/skills](https://github.com/w00ing/skills) | installable | 승인 | 실패 | invalid_output/invalid_json |
| 280463 | [Edge-City/agentvillage](https://github.com/Edge-City/agentvillage) | installable | 승인 | 실패 | invalid_output/invalid_json |
| 280481 | [Parzivalart3mis/macromap](https://github.com/Parzivalart3mis/macromap) | website | 승인 | 승인 |  |
| 280566 | [realjaymes/wholesome-girlies](https://github.com/realjaymes/wholesome-girlies) | website | 승인 | 실패 | gateway_error |
| 280752 | [fivetaku/pumasi](https://github.com/fivetaku/pumasi) | installable | 승인 | 승인 |  |
| 280778 | [termux-pacman/termux-packages](https://github.com/termux-pacman/termux-packages) | website | 승인 | 승인 |  |
| 280822 | [Matz1pan/portfolio](https://github.com/Matz1pan/portfolio) | website | 거절 | 거절 |  |
| 280987 | [quillmesh/head-space](https://github.com/quillmesh/head-space) | website | 승인 | 보류 |  |
| 281088 | [YASH0025/CloudLab](https://github.com/YASH0025/CloudLab) | website | 승인 | 실패 | invalid_output/invalid_json |
| 281109 | [Hqzdev/tradr](https://github.com/Hqzdev/tradr) | website | 승인 | 승인 |  |
| 281144 | [raschild6/rasch-git-page](https://github.com/raschild6/rasch-git-page) | website | 승인 | 승인 |  |
| 281189 | [CodeCooLTH/deep-web](https://github.com/CodeCooLTH/deep-web) | website | 승인 | 승인 |  |
| 281236 | [NuonVannsonleng/Meh-Rean](https://github.com/NuonVannsonleng/Meh-Rean) | website | 거절 | 거절 |  |
| 281242 | [YonderUrik/buddy-budget](https://github.com/YonderUrik/buddy-budget) | website | 승인 | 승인 |  |
| 281261 | [Timothymycompc/solana-pulse-ai-agent-gateway](https://github.com/Timothymycompc/solana-pulse-ai-agent-gateway) | website | 거절 | 거절 |  |
| 281278 | [3kh0/slick](https://github.com/3kh0/slick) | website | 승인 | 승인 |  |
| 281294 | [Muiz-code/Naija-Votes](https://github.com/Muiz-code/Naija-Votes) | website | 승인 | 거절 |  |
| 281424 | [The127/aibox](https://github.com/The127/aibox) | website | 승인 | 승인 |  |
| 281497 | [megany128/sklonuj](https://github.com/megany128/sklonuj) | website | 승인 | 승인 |  |
| 281622 | [AUL-DoX/welfare-notice-wiki-v2](https://github.com/AUL-DoX/welfare-notice-wiki-v2) | website | 승인 | 승인 |  |
| 281744 | [billf/skip](https://github.com/billf/skip) | website | 승인 | 거절 |  |
| 281824 | [enedaze-sub/taskbar-launcher](https://github.com/enedaze-sub/taskbar-launcher) | website | 승인 | 승인 |  |
| 281829 | [SudalSudal01/yeohaeng-pick](https://github.com/SudalSudal01/yeohaeng-pick) | website | 승인 | 승인 |  |
| 281873 | [40508597/rwgj_sy](https://github.com/40508597/rwgj_sy) | installable | 승인 | 승인 |  |
| 282038 | [AlexAdiaconitei/ai-vitals](https://github.com/AlexAdiaconitei/ai-vitals) | website | 승인 | 승인 |  |
| 282323 | [bfogels/infergrade-runner](https://github.com/bfogels/infergrade-runner) | website | 보류 | 승인 |  |
| 282397 | [Nirbhay71/portfolio](https://github.com/Nirbhay71/portfolio) | website | 승인 | 승인 |  |
| 282621 | [TJA0308/AlphaNexus](https://github.com/TJA0308/AlphaNexus) | website | 승인 | 승인 |  |
| 282667 | [luquitared/lofiwave](https://github.com/luquitared/lofiwave) | website | 승인 | 승인 |  |
| 282691 | [aditmag/dragonfly](https://github.com/aditmag/dragonfly) | website | 승인 | 승인 |  |
| 282707 | [Ruckus000/Ada-editor](https://github.com/Ruckus000/Ada-editor) | website | 승인 | 승인 |  |
| 282743 | [delivery-framework/fusion-website](https://github.com/delivery-framework/fusion-website) | website | 승인 | 거절 |  |
| 282765 | [nullean/heed](https://github.com/nullean/heed) | website | 승인 | 승인 |  |
| 283004 | [githubnext/rig](https://github.com/githubnext/rig) | installable | 승인 | 실패 | timeout |
| 283024 | [retransmission/retransmission](https://github.com/retransmission/retransmission) | website | 승인 | 승인 |  |
| 283167 | [gasToledo/Milantus](https://github.com/gasToledo/Milantus) | website | 거절 | 거절 |  |
| 283221 | [BixSopy/watchlist](https://github.com/BixSopy/watchlist) | website | 승인 | 승인 |  |
| 283365 | [rynlanguage/Ryn](https://github.com/rynlanguage/Ryn) | website | 승인 | 실패 | invalid_output/invalid_json |
| 283403 | [euangoddard/ad-nauseam](https://github.com/euangoddard/ad-nauseam) | website | 거절 | 실패 | invalid_output/invalid_json |
| 283406 | [boostifymedia4-glitch/kitwell.](https://github.com/boostifymedia4-glitch/kitwell.) | website | 승인 | 승인 |  |
| 283468 | [kenny9911/RoboApply](https://github.com/kenny9911/RoboApply) | website | 승인 | 승인 |  |
| 283530 | [Janzert/OpFor](https://github.com/Janzert/OpFor) | website | 승인 | 승인 |  |
| 283531 | [AdityaPrakash-26/AdityaPrakash-26.github.io](https://github.com/AdityaPrakash-26/AdityaPrakash-26.github.io) | website | 승인 | 승인 |  |
| 283538 | [damiruali014-lab/sitescout](https://github.com/damiruali014-lab/sitescout) | website | 거절 | 거절 |  |
| 283646 | [RiqueBitt/ProjectClub](https://github.com/RiqueBitt/ProjectClub) | website | 거절 | 거절 |  |
| 283728 | [priyansh1210/domain-trail](https://github.com/priyansh1210/domain-trail) | website | 승인 | 실패 | invalid_output/invalid_json |
| 283790 | [splay-sh/splay](https://github.com/splay-sh/splay) | website | 승인 | 승인 |  |
| 283796 | [wielebenwir/commonsbooking](https://github.com/wielebenwir/commonsbooking) | website | 승인 | 승인 |  |
| 283838 | [Bobowski/stario](https://github.com/Bobowski/stario) | website | 승인 | 승인 |  |
| 283870 | [BytecodeBrewer/portfolio](https://github.com/BytecodeBrewer/portfolio) | website | 승인 | 승인 |  |
| 284027 | [minori-live/heron](https://github.com/minori-live/heron) | website | 승인 | 승인 |  |
| 284118 | [p3d-project/persona-3-dual](https://github.com/p3d-project/persona-3-dual) | website | 승인 | 실패 | invalid_output/invalid_json |
| 284146 | [jbang2004/long-wind](https://github.com/jbang2004/long-wind) | website | 보류 | 승인 |  |
| 284148 | [huijeong06/writing-structure-template](https://github.com/huijeong06/writing-structure-template) | website | 승인 | 승인 |  |
| 284156 | [Fighter90/hyrekit_fsp](https://github.com/Fighter90/hyrekit_fsp) | website | 거절 | 거절 |  |
| 284201 | [zendegani/XClipper](https://github.com/zendegani/XClipper) | website | 승인 | 승인 |  |
| 284219 | [matiasjbaker-hue/matias-goalie-analytics](https://github.com/matiasjbaker-hue/matias-goalie-analytics) | website | 승인 | 승인 |  |
| 284546 | [Ovrksae/bl-ack-major.github.io](https://github.com/Ovrksae/bl-ack-major.github.io) | website | 거절 | 거절 |  |
| 284557 | [mennyg19-cmyk/MenEZmanim](https://github.com/mennyg19-cmyk/MenEZmanim) | website | 승인 | 승인 |  |
| 284613 | [withqwerty/nutmeg](https://github.com/withqwerty/nutmeg) | installable | 승인 | 승인 |  |
| 284618 | [amishra95/LuferAI](https://github.com/amishra95/LuferAI) | website | 승인 | 승인 |  |
| 284750 | [letya999/grill-my-resume-as-manager](https://github.com/letya999/grill-my-resume-as-manager) | website | 거절 | 실패 | invalid_output/invalid_json |
| 284751 | [razodin137/GLSL](https://github.com/razodin137/GLSL) | website | 승인 | 승인 |  |
| 284868 | [jefvandegraaf/edit-static](https://github.com/jefvandegraaf/edit-static) | website | 승인 | 승인 |  |
| 284921 | [Mateeb11/portfolio-v2](https://github.com/Mateeb11/portfolio-v2) | website | 거절 | 승인 |  |
| 284938 | [pfaisant/OpenWysiwyg](https://github.com/pfaisant/OpenWysiwyg) | website | 승인 | 승인 |  |
| 285004 | [Carafehq/carafe](https://github.com/Carafehq/carafe) | website | 승인 | 승인 |  |
| 285206 | [sdeutrich/-scheibenklar-landing](https://github.com/sdeutrich/-scheibenklar-landing) | website | 승인 | 승인 |  |
| 285287 | [hfrdmnk/kai](https://github.com/hfrdmnk/kai) | website | 승인 | 승인 |  |
| 285327 | [prgoda/parthgoda.com](https://github.com/prgoda/parthgoda.com) | website | 승인 | 승인 |  |
| 285434 | [woosal1337/ade](https://github.com/woosal1337/ade) | website | 승인 | 실패 | invalid_output/invalid_json |
| 285493 | [Jesse3L/tracelings](https://github.com/Jesse3L/tracelings) | website | 승인 | 승인 |  |
| 285538 | [A-sop/logans-tools](https://github.com/A-sop/logans-tools) | website | 승인 | 실패 | invalid_output/invalid_json |
| 285548 | [DamienMarill/devtober](https://github.com/DamienMarill/devtober) | website | 거절 | 거절 |  |
| 285575 | [brignano/brignano.io](https://github.com/brignano/brignano.io) | website | 승인 | 승인 |  |
| 285704 | [leoalaplage/finscope](https://github.com/leoalaplage/finscope) | website | 승인 | 승인 |  |
| 285741 | [aarush-bajaj/OpClave](https://github.com/aarush-bajaj/OpClave) | website | 승인 | 승인 |  |
| 285747 | [caueprado204-ops/Easy-study](https://github.com/caueprado204-ops/Easy-study) | website | 보류 | 거절 |  |
| 285894 | [DirectorLink/DirectorLink-Hikvision](https://github.com/DirectorLink/DirectorLink-Hikvision) | website | 승인 | 승인 |  |
| 285996 | [picazuid-pilot/face-anonymizer](https://github.com/picazuid-pilot/face-anonymizer) | website | 승인 | 실패 | invalid_output/review_unknown_evidence |
| 286209 | [CaiusPelish/ATC-Software](https://github.com/CaiusPelish/ATC-Software) | website | 승인 | 실패 | invalid_output/invalid_json |
| 286745 | [ryanmette/miniature_palette_studio](https://github.com/ryanmette/miniature_palette_studio) | website | 승인 | 승인 |  |
| 286792 | [Jaywrkr/WHITEDOT](https://github.com/Jaywrkr/WHITEDOT) | website | 승인 | 승인 |  |
| 286842 | [dogfood-lab/testing-os](https://github.com/dogfood-lab/testing-os) | website | 승인 | 승인 |  |
| 286965 | [natxmans/ghost-terminal](https://github.com/natxmans/ghost-terminal) | website | 승인 | 승인 |  |
| 287003 | [muuvmuuv/muuvmuuv](https://github.com/muuvmuuv/muuvmuuv) | website | 거절 | 승인 |  |
| 287111 | [vivekanandproject/oohworks](https://github.com/vivekanandproject/oohworks) | website | 승인 | 승인 |  |
| 287114 | [projeffboy/my-pokemon-team](https://github.com/projeffboy/my-pokemon-team) | website | 거절 | 거절 |  |
| 287126 | [jasas1/Joseon](https://github.com/jasas1/Joseon) | website | 승인 | 승인 |  |
| 287279 | [Jkeroromk/Lock](https://github.com/Jkeroromk/Lock) | website | 승인 | 승인 |  |
| 287387 | [SachinBallari/3D-Portfolio](https://github.com/SachinBallari/3D-Portfolio) | website | 승인 | 승인 |  |
| 287598 | [tobyj19/DNAEsports](https://github.com/tobyj19/DNAEsports) | website | 승인 | 승인 |  |
| 287670 | [Alchemist-Jo/html-report](https://github.com/Alchemist-Jo/html-report) | installable | 승인 | 승인 |  |
| 287688 | [skoolkid/pyskool](https://github.com/skoolkid/pyskool) | website | 승인 | 승인 |  |
| 287734 | [GitFenix1113/mecharashi-tools](https://github.com/GitFenix1113/mecharashi-tools) | website | 거절 | 보류 |  |
