# PR10 recorder final job-wall fixture

원 CI38861009681의 통합1은 잔여 job TTL1000ms와 recorder lock_timeout1000ms가 경합해 final job 검사 전에 lock_timeout으로 실패했다. Production을 바꾸지 않고 지정 integration case만 첫 실제 healthy 검사 뒤 같은 TX에서 exact job name/token을 만료 상태로 고정한다. 실제 recorder/run-row wait를 거쳐 production final job-wall 검사가 실제 job_lease_lost를 던지고 전체 invalidation/event/anchor가 rollback되는지 확인한다. 원 assertions·다른 모든 case·TTL90000ms·DB1초/5초·test20초/hook60초는 보존했다.

이는 원 CI 자연 만료 경합을 동일 조건으로 재현한 증거가 아니다. 직전 자연 wall 회귀는 그대로이며 observer의 모든 스케줄 지연에 대한 보장도 추가하지 않았다. Spy 설치/복원 실패에도 pending Promise·ledger·DB·blocker·profile을 정리하며 원 오류와 cleanup 오류를 함께 보존한다.

최종 source SHA256: a9828fbd8ffe01eeb77f9b7bb64a57a575f12cf14d7e948f7856c6905446fd76.

실제 범위 검사:

- 전용 loopback55557에서 원 invalid-pending control1+지정case1: 최종2PASS/31skip, tests1.01초/total1.66초/exit0. 직전 동작 수정에서도 같은2PASS였고 setup guard 보강 뒤 한 번 추가 실행했다.
- 해당 파일 ESLint와 scoped TSC는 각각 exit0. 전체 suite/build는 실행하지 않았다.
- 원 callback을 추출한 offline setup-fault driver는 spy 설치/설정 실패의 첫 source2 AssertionFAIL에서 최종3PASS로 바뀌었다. 실제 PG fault 증거와 구분한다.
- Root 직접 diff 및 A 독립 읽기 리뷰의 추가P1/P2=0.

Root 독립 readback은 final table-data90표/public9행 및 journal83이 baseline exact이고 agentfinal과 catalog도 exact임을 확인했다. 초기 대비16 relacl+DB datacl의 NULL→명시 default 표현 차이는 raw false로 보존하고 유효권한 동등을 별도로 확인했다. Sequence 현재값은 snapshot에 포함하지 않았으며 reset하지 않았다. 타연결0 확인 후 자기 container/volume만 정상 stop/exited0/OOMfalse/삭제해55557을 retired로 기록했다.

원 보고서·로그·readback: /tmp/nomorevibe-pr460-recorder-final-report-20261016.md, /tmp/nomorevibe-pr460-recorder-actual-final-proof-20261016.json, /tmp/nomorevibe-pr460-recorder-root-independent-proof-20261016.json, /tmp/nomorevibe-pr460-recorder-root-db-cleanup-20261016.json. 원 CI 실패와 새 범위 PASS를 구분하며 새 전체 CI 통과는 이 기록의 범위가 아니다.
