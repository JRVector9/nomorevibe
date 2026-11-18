#!/usr/bin/env python3
"""deepseek 품질 표본(2026-11-18) — 결과 요약. 입력은 verify-cases.ts parse / translate-cases.ts check 의 jsonl.

usage: analyze.py <verify-results.jsonl> <translate-items.jsonl> <summary.json> <compare.html>
"""
import collections, html, json, re, statistics, sys


def pct(values, q):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    k = (len(values) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return round(values[lo] + (values[hi] - values[lo]) * (k - lo), 1)


def verify_summary(rows):
    out = {"cases": len(rows)}
    ok = [r for r in rows if r["dsRemoved"] is not None]
    out["format_ok"] = len(ok)
    out["errors"] = collections.Counter(r["error"] for r in rows if r["dsRemoved"] is None)
    out["ms_p50"] = pct([r["ms"] / 1000 for r in rows], 0.5); out["ms_p90"] = pct([r["ms"] / 1000 for r in rows], 0.9)
    toks = [(r.get("usage") or {}).get("completion_tokens") for r in rows]
    out["out_tokens_p50"] = pct(toks, 0.5); out["out_tokens_p90"] = pct(toks, 0.9)
    per = {}
    for model in sorted({r["prodModel"] for r in rows}) + ["all"]:
        group = [r for r in ok if model in ("all", r["prodModel"])]
        m = collections.Counter()
        for r in group:
            prod, ds = set(r["prodRemoved"]), set(r["dsRemoved"])
            for k in set(r["keywords"]):
                m[("remove" if k in prod else "keep", "remove" if k in ds else "keep")] += 1
        kw = sum(m.values())
        plain = [r for r in group if not r["prodRemoved"]]; flagged = [r for r in group if r["prodRemoved"]]
        def rate(rs, key):
            n = sum(len(set(r["keywords"])) for r in rs)
            return round(100 * sum(len(set(r[key])) for r in rs) / n, 2) if n else None
        per[model] = {
            "cases": len(group), "keywords": kw,
            "agree_keep": m[("keep", "keep")], "agree_remove": m[("remove", "remove")],
            "prod_remove_ds_keep": m[("remove", "keep")], "prod_keep_ds_remove": m[("keep", "remove")],
            "keyword_agreement_pct": round(100 * (m[("keep", "keep")] + m[("remove", "remove")]) / kw, 2) if kw else None,
            "prod_removed_total": m[("remove", "keep")] + m[("remove", "remove")],
            "ds_removed_total": m[("keep", "remove")] + m[("remove", "remove")],
            "ds_remove_rate_on_prod_clean_cases_pct": rate(plain, "dsRemoved"),
            "ds_remove_rate_on_prod_flagged_cases_pct": rate(flagged, "dsRemoved"),
            "prod_remove_rate_on_flagged_cases_pct": rate(flagged, "prodRemoved"),
            "cases_ds_any_removal_on_clean": sum(1 for r in plain if r["dsRemoved"]),
            "clean_cases": len(plain), "flagged_cases": len(flagged),
            "cases_exact_same_set": sum(1 for r in group if set(r["prodRemoved"]) == set(r["dsRemoved"])),
        }
    out["by_prod_model"] = per
    return out


KANA = re.compile(r"[ぁ-ゖァ-ヺ]"); HAN = re.compile(r"[㐀-䶿一-鿿]")


def translate_summary(rows):
    out = {"items": len(rows)}
    batches = {}
    for r in rows:
        batches.setdefault(r["i"], r)
    out["batches"] = len(batches)
    out["batch_format_fail"] = sum(1 for r in batches.values() if r["batchError"])
    out["batch_errors"] = collections.Counter(r["batchError"] for r in batches.values() if r["batchError"])
    out["ms_p50"] = pct([r["ms"] / 1000 for r in batches.values()], 0.5); out["ms_p90"] = pct([r["ms"] / 1000 for r in batches.values()], 0.9)
    toks = [(r.get("usage") or {}).get("completion_tokens") for r in batches.values()]
    out["out_tokens_p50"] = pct(toks, 0.5); out["out_tokens_p90"] = pct(toks, 0.9)
    out["out_tokens_mean"] = round(statistics.mean([t for t in toks if t is not None]), 1) if any(t is not None for t in toks) else None
    out["finish"] = collections.Counter(r.get("finish") for r in batches.values())
    loc = {}
    for locale in ["en", "zh-Hans", "ja"]:
        g = [r for r in rows if r["locale"] == locale]
        prod_known = [r for r in g if r["prodStatus"] in ("ready", "failed")]
        both = collections.Counter((r["prodOk"], r["ok"]) for r in prod_known)
        loc[locale] = {
            "items": len(g), "ds_pass": sum(r["ok"] for r in g),
            "ds_pass_pr986": sum(1 for r in g if r["ok986"]) if locale == "en" else None,
            "ds_reasons": collections.Counter(r["reason"] for r in g if not r["ok"]),
            "prod_items": len(prod_known), "prod_pass": sum(r["prodOk"] for r in prod_known),
            "prod_pass_pr986_or_ready": sum(1 for r in prod_known if (r["prodOk986"] if r["prodOk986"] is not None else r["prodOk"])) if locale == "en" else None,
            "prod_reasons": collections.Counter(r["prodReason"] for r in prod_known if not r["prodOk"]),
            "prod_models": collections.Counter(r["prodModel"] for r in prod_known),
            "both_pass": both[(True, True)], "prod_only_pass": both[(True, False)], "ds_only_pass": both[(False, True)], "both_fail": both[(False, False)],
            "ja_answered_chinese": sum(1 for r in g if locale == "ja" and r["output"] and not KANA.search(r["output"])
                                       and len(HAN.findall(r["output"])) >= 2) if locale == "ja" else None,
        }
    out["by_locale"] = loc
    out["ds_pass_total"] = sum(v["ds_pass"] for v in loc.values())
    return out


def main():
    vrows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
    trows = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]
    summary = {"verify": verify_summary(vrows), "translate": translate_summary(trows)}
    json.dump(summary, open(sys.argv[3], "w"), ensure_ascii=False, indent=1, default=dict)
    esc = html.escape
    parts = ["<!doctype html><meta charset=utf-8><title>deepseek 품질 표본 2026-11-18</title>",
             "<style>body{font:13px system-ui;margin:16px}table{border-collapse:collapse;margin:8px 0 24px}td,th{border:1px solid #ccc;padding:3px 6px;vertical-align:top}"
             ".bad{background:#fde2e2}.good{background:#e3f6e5}.diff{background:#fff4d6}pre{white-space:pre-wrap;margin:0}</style>",
             "<h1>deepseek-v4.1-flash-1017 품질 표본 (2026-11-18, 측정만)</h1>",
             "<h2>요약</h2><pre>" + esc(json.dumps(summary, ensure_ascii=False, indent=1, default=dict)) + "</pre>",
             "<h2>키워드 검수 — 제품별</h2><table><tr><th>#</th><th>제품</th><th>운영 모델</th><th>키워드 수</th><th>운영 지움</th><th>deepseek 지움</th><th>오류</th><th>초</th></tr>"]
    for r in vrows:
        same = r["dsRemoved"] is not None and set(r["dsRemoved"]) == set(r["prodRemoved"])
        cls = "bad" if r["dsRemoved"] is None else ("" if same else "diff")
        parts.append(f"<tr class='{cls}'><td>{r['i']}</td><td>{esc(r['slug'])}</td><td>{esc(r['prodModel'])}</td><td>{len(r['keywords'])}</td>"
                     f"<td>{esc(', '.join(r['prodRemoved']))}</td><td>{esc(', '.join(r['dsRemoved'] or []))}</td><td>{esc(str(r['error'] or ''))}</td><td>{r['ms']/1000:.1f}</td></tr>")
    parts.append("</table><h2>제품 번역 — 항목별</h2><table><tr><th>묶음</th><th>언어</th><th>이름</th><th>원문</th><th>deepseek</th><th>판정</th><th>운영 결과</th><th>운영 판정</th></tr>")
    for r in trows:
        cls = "good" if r["ok"] else "bad"
        parts.append(f"<tr class='{cls}'><td>{r['i']}.{r['index']}</td><td>{r['locale']}</td><td>{esc(r['name'])}</td><td>{esc(r['source'])}</td>"
                     f"<td>{esc(r['output'] or '')}</td><td>{'통과' if r['ok'] else esc(str(r['reason']))}{'' if r['ok986'] is None or r['locale']!='en' else (' / #986 ' + ('통과' if r['ok986'] else esc(str(r['reason986']))))}</td>"
                     f"<td>{esc((r['prodModel'] or '') + ': ' + (r['prodText'] or r['prodStatus']))}</td><td>{'통과' if r['prodOk'] else esc(str(r['prodReason']))}</td></tr>")
    parts.append("</table>")
    open(sys.argv[4], "w").write("\n".join(parts))
    print(json.dumps(summary, ensure_ascii=False, indent=1, default=dict))


if __name__ == "__main__":
    main()
