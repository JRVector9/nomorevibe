# 관리자 내부 접속 설치

이 문서는 PR01의 설치 계약이다. 코드가 병합되어도 Tailscale ingress, ACL, 방화벽,
양 웹의 자격 설정과 실제 로그인이 검증되기 전에는 내부 관리자 접속이 완료된 것이 아니다.
2026-10-13 확인된 운영은 `ADMIN_LOCAL_LOGIN=0`이며 이 ingress와 비밀번호 설정은 아직 없다.

## 앱 설정

양 웹의 모든 복제본에 같은 값을 설치한다. 비밀값은 Dokploy의 비밀 설정으로 전달하고
문서·Git·명령 인자·로그에 남기지 않는다. 워커에는 새 관리자 비밀을 전달할 필요가 없다.

| 설정 | 계약 |
|---|---|
| `ADMIN_ORIGIN` | 관리자 브라우저가 여는 private HTTPS origin. 예: `https://<ADMIN_MAGICDNS_HOST>`. 공개 사이트와 달라야 하며 경로·query·자격정보가 없어야 한다. |
| `ADMIN_INGRESS_SECRET` | 무작위 32 bytes 이상 비밀. private proxy와 양 웹만 보관한다. |
| `ADMIN_USERNAME` | 한 명의 ID. 영문·숫자로 시작하고 영문·숫자·`_`·`-`로 구성된 최대120자. |
| `ADMIN_PASSWORD_HASH` | 아래 CLI의 `scrypt$131072$8$1$<salt hex>$<key hex>` 결과. 평문 비밀번호는 앱에 저장하지 않는다. |
| `AUTH_SECRET` | 기존 관리자 HMAC 키, 최소32자. 양 웹에서 같아야 한다. |
| `ADMIN_LOCAL_LOGIN` | 운영은 항상 `0`. production에서는 `1`이어도 우회하지 않는다. |
| `NEXT_PUBLIC_SITE_URL` | 기존 공개 주소를 유지한다. 관리자 origin으로 바꾸지 않는다. |

비밀번호 hash는 신뢰할 수 있는 터미널에서 생성한다. 입력은 화면과 명령 기록에 남지 않는다.
결과 hash도 자격 자료이므로 비밀 설정으로 옮긴 뒤 공개하지 않는다.

```sh
node scripts/admin-password-hash.mjs
```

비밀번호 검증 전에 기존 Postgres rate limit로 전체 웹을 합쳐15분에5번까지만 허용한다.
클라이언트가 ID/IP 헤더를 바꾸어도 버킷이 바뀌지 않는다. 로그인은 정확한 Origin과
HttpOnly nonce 쿠키에 결합한 CSRF token을 요구한다. 세션은 기존 HttpOnly/Secure/SameSite 쿠키로
12시간 유지된다. ID·hash·`AUTH_SECRET` 교체는 기존 비밀번호 세션을 모두 무효화한다.
관리자 GitHub OAuth를 추가로 사용하면 기존 allowlist와 별도 client 설정이 필요하고,
동일한 private ingress 증명을 통과해야 한다. 일반 사용자·메이커 GitHub 인증 설정과 구분한다.

## ingress 계약

앱이 확인하는 증명은 `X-NMV-Admin-Ingress-Token: <ADMIN_INGRESS_SECRET>`이다.
이 값은 브라우저가 보내지 않는다. private proxy가 검증된 내부 연결에만 덮어쓴다.
IP, Host, `X-Forwarded-For`, Tailscale identity header만으로 앱 권한을 부여하지 않는다.

1. 운영 host에서 실제 Tailscale MagicDNS host, loopback proxy port, 양 웹 upstream을 먼저
   확인한다. 아래 `<...>`는 아직 측정하지 않은 설치 값이다. 포트나 컨테이너 주소를 임의로 정하지 않는다.
2. Tailscale ACL로 지정 운영자의 device/user만 관리자 host의 HTTPS에 접근하도록 허용한다.
   `tailscale serve` 또는 같은 경계의 TLS reverse proxy를 사용하고 **Funnel을 켜지 않는다**.
   TLS 종료 뒤의 private proxy listener는 loopback 또는 ACL로 제한한 tailnet 주소에만 bind한다.
3. private proxy는 요청의 ingress header를 제거한 뒤 서버 비밀로 덮어쓰고, 고정된 웹 upstream으로만
   전달한다. `Host`와 `X-Forwarded-Host`는 관리자의 private HTTPS host로 덮어쓴다.
   임의 Host에 따라 upstream을 고르거나 `CONNECT`를 허용하지 않는다.
4. 공개 Cloudflare/Traefik ingress는 클라이언트의 `X-NMV-Admin-Ingress-Token`을 항상 제거한다.
   공개 proxy에 이 비밀을 주입하지 않는다. `/admin`, `/api/admin`, 관리자
   `/api/auth/github`, `/api/auth/password`, `/api/auth/logout`을 공개 router에서도 거절할 수 있다.
   `/api/auth/user`, `/api/auth/maker`는 일반 인증이므로 이 차단에 포함하지 않는다.
5. 앱 origin port와 private proxy port에 대한 공개/직접 접근을 방화벽과 container port binding으로 차단한다.
   공개 서비스가 필요하므로 기존 공개 router를 끄는 것이 아니라, 관리용 listener와 앱 upstream의
   직접 접근을 제한한다. 두 웹·모든 복제본에 동일한 header 제거/주입 계약을 적용한다.

Nginx 같은 private proxy에서 필요한 최소 동작은 아래와 같다. 설치된 proxy 제품의 방식으로
같은 계약을 표현한다. 비밀은 권한을 제한한 서버 설정에 주입하고, 이 예시 자체를 운영 설정으로 복사하지 않는다.

```nginx
server {
    listen 127.0.0.1:<PRIVATE_LOOPBACK_PROXY_PORT>;
    server_name <ADMIN_MAGICDNS_HOST>;
    location / {
        proxy_set_header Host <ADMIN_MAGICDNS_HOST>;
        proxy_set_header X-Forwarded-Host <ADMIN_MAGICDNS_HOST>;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-NMV-Admin-Ingress-Token <INJECT_SERVER_SECRET>;
        proxy_pass http://<MEASURED_WEB_UPSTREAM>;
    }
}
```

private browser host를 그대로 전달하면 Next16 Server Action의 Origin/Host 검사도 통과한다.
이를 해결하려고 wildcard `serverActions.allowedOrigins`를 추가하지 않는다. 앱의 댓글·GitHub
복구 action도 `ADMIN_ORIGIN`을 사용해야 한다.

## 배포 뒤 수동 확인

- 공개·직접 origin에서 관리자 페이지와 관리 API는404이어야 한다. 유효한 관리자 쿠키나
  임의의 Host/XFF/가짜 ingress header를 보내도 같아야 한다. `/en/admin` 등 언어 접두사도404이다.
- private ingress에서는 로그인 폼이 열리고, 잘못된 ID/비밀번호·Origin·CSRF는 거절한다.
  한도 초과는 로그인되지 않아야 한다. DB 조회 실패 때도 로그인되지 않아야 한다.
- 지정 ID로 로그인해 inbox와 읽기 화면을 확인한다. 실제 관리 쓰기는 별도의 검증 대상과 범위를 정한 뒤 한다.
  로그아웃은 POST로 쿠키를 지우고, 이후 관리자 화면은 로그인으로 돌아가야 한다.
- 교체한 ID/hash/서명 키에 옛 쿠키가 거절되는지 확인한다. 만료·변조 쿠키도 거절해야 한다.
- 공개 health, 일반 사용자 GitHub 로그인, 메이커 인증을 별도로 확인한다.
  내부 관리자 자격을 설치한 것만으로 일반 계정 인증의 성공을 주장하지 않는다.

검증 시각·각 ingress 경계·양 웹의 적용 범위를 기록한다. 비밀이나 cookie 원문을 증거에 넣지 않는다.
private proxy의 설치·ACL·방화벽·실제 로그인은 이 문서 작성으로 검증된 것이 아니다.
