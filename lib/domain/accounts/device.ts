/**
 * 로그인 기기 이름 — User-Agent 에서 "Mac · Chrome" 같은 짧은 이름만 뽑는다. 원문은 저장하지 않는다.
 * 이름은 DB 에 한 번 적고 네 언어 화면이 같이 쓰므로 제품 이름(영문)만 쓴다. 모르면 null(화면이 "알 수 없는 기기").
 */
const OS: [RegExp, string][] = [
  [/\biPad\b/, "iPad"],
  [/\biPhone\b|\biPod\b/, "iPhone"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "Mac"],
  [/\bLinux\b/, "Linux"],
];

// 앞의 것이 먼저다 — Edge·Opera·삼성·웨일·인앱 브라우저도 "Chrome"·"Safari" 글자를 함께 보낸다
const BROWSERS: [RegExp, string][] = [
  [/\bKAKAOTALK\b/i, "KakaoTalk"],
  [/\bNAVER\(inapp/i, "NAVER"],
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bWhale\//, "Whale"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\/|\bChrome\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, 512);
  const os = OS.find(([pattern]) => pattern.test(ua))?.[1];
  // iOS 의 앱 안 화면(WKWebView)은 Version/ 없이 Safari 엔진만 쓴다
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1]
    ?? (os === "iPhone" || os === "iPad" ? (/\bAppleWebKit\//.test(ua) ? "Safari" : undefined) : undefined);
  const label = [os, browser].filter(Boolean).join(" · ");
  return label ? label.slice(0, 40) : null;
}
